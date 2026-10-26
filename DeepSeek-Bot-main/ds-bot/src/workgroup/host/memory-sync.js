// G6R transport adapter. The original memory engine in src/host/memory.js is the only memory
// implementation: this module turns a write it already made into one Hub event, and feeds a remote
// event back into that engine's own write path. It owns no entries, format or permissions.
import { randomUUID } from 'node:crypto'

export function install(wg) {
  const { rt } = wg

  // Per Hub group, what this machine has sent and applied. It is diagnostic and survives a reload;
  // idempotency itself lives in the original engine's applied.json, because an event may arrive
  // before a workgroup state save.
  const entryOf = (workgroupId) => {
    wg.state.memorySync ??= {}
    wg.state.memorySync[workgroupId] ??= { lastSentAt: 0, lastAppliedAt: 0, applied: 0 }
    return wg.state.memorySync[workgroupId]
  }

  async function onMemoryWritten(change) {
    // Only a group's memory crosses machines, and only when this local room is the Hub group. A
    // private or team entry has no workgroup, and a local group has no hubWorkgroupId.
    if (change?.scope?.kind !== 'group') return
    const room = wg.workgroupOf(change.scope.roomId)
    if (room?.hubWorkgroupId === undefined) return
    if (wg.bridge?.status?.().connected !== true) return
    const hubWorkgroupId = room.hubWorkgroupId
    // The actor id is this machine's local Bot id; the Hub group knows the Bot by its endpoint. Keep
    // both: the endpoint is the identity the other machine can resolve, the name is what the journal
    // shows. A user/panel write has no Bot endpoint.
    const actorId = change.actor?.id
    const botEndpointId = actorId === undefined || actorId === 'user'
      ? undefined
      : Object.entries(wg.bridge?.endpointBots?.() ?? wg.state?.endpointBots ?? {})
        .find(([, localBotId]) => String(localBotId) === String(actorId))?.[0]
    const payload = {
      roomKey: hubWorkgroupId,
      op: change.op,
      topic: change.file?.topic ?? null,
      before: change.before ?? null,
      after: change.after ?? null,
      actor: change.actor === undefined
        ? { id: 'user', name: 'user' }
        : { id: change.actor.id, name: change.actor.name },
      at: new Date().toISOString(),
    }
    try {
      await wg.bridge.sendEvent({
        workgroupId: hubWorkgroupId,
        frameType: 'memory.change',
        payload,
        eventId: `mev_${randomUUID().replace(/-/g, '')}`,
        ...(botEndpointId === undefined ? {} : { botEndpointId }),
      })
      entryOf(hubWorkgroupId).lastSentAt = Date.now()
      await wg.save({ workgroupId: hubWorkgroupId, kind: 'memory' })
    } catch (error) {
      // Observation and transport are best effort. The original write already succeeded and must not
      // be reported as failed because the Hub is unreachable.
      rt.warn?.('ds-bot: group memory change for %s not sent: %s', hubWorkgroupId, error?.message ?? error)
    }
  }

  async function onMemoryEvent({ workgroupId, event }) {
    if (event?.type !== 'memory.change') return
    const body = event.payload ?? {}
    // The Hub id in the payload must agree with the event's group; a mismatched frame cannot address
    // another local room.
    if (body.roomKey !== workgroupId) return
    const room = wg.roomOfHubGroup?.(workgroupId)
    if (room === undefined) return
    // The other machine's local Bot id means nothing here. The Hub recorded the endpoint that wrote,
    // and the local roster already maps that endpoint to the member this engine can check. When it
    // cannot be resolved, nobody here can prove the writer was a member, so the change is dropped
    // rather than applied under a guessed identity.
    const endpointId = event.sender?.botEndpointId
    // A Bot writes through its endpoint. A person using the memory panel has no endpoint, and the
    // Hub's authenticated sender is the only identity to resolve. Both resolve to a member of THIS
    // machine's room, which is what `applyRemoteMemoryChange` checks and what its journal records.
    const member = endpointId !== undefined
      ? (room.members ?? []).find(entry => entry.endpointId === endpointId)
      : (room.members ?? []).find(entry => entry.kind === 'user' && entry.hubUserId === event.sender?.userId)
    if (member === undefined) return
    const result = await rt.applyRemoteMemoryChange({
      eventId: event.eventId,
      roomId: room.id,
      op: body.op,
      topic: body.topic,
      before: body.before,
      after: body.after,
      actor: { id: member.id, name: body.actor?.name ?? member.name },
    })
    // A duplicate was already applied. Not a member, or an entry that changed under the sender, is
    // an expected refusal: the socket keeps going, and the local engine remains authoritative.
    if (result.changed) {
      const record = entryOf(workgroupId)
      record.applied += 1
      record.lastAppliedAt = Date.now()
      await wg.save({ workgroupId, kind: 'memory' })
    }
  }

  wg.onMemoryWritten = onMemoryWritten
  wg.onMemoryEvent = onMemoryEvent
  wg.memorySyncState = entryOf
}
