// Upgrading a local group to a workgroup: the four-state transaction of plan §8.2.
//
//   PREPARING ──▶ HUB_CREATED ──▶ LOCAL_LINKED ──▶ ACTIVE
//
// Each state exists because a crash between any two steps must be recoverable, and each one is
// reached by a write that is safe to repeat:
//
//   * PREPARING — the intent is recorded locally, with a random `upgradeId`, before anything
//     leaves the machine. Nothing has been created anywhere, so a retry is a first attempt.
//   * HUB_CREATED — the Hub answered with a group id. That call carries the same `upgradeId`, so a
//     retry either creates the group or finds the one the previous attempt made. This is the state
//     gate item 4 measures: N retries, one group.
//   * LOCAL_LINKED — the local room record now names the Hub group. Reached only after the local
//     write succeeded, so the mapping and the group cannot disagree.
//   * ACTIVE — the local group is archived as read-only history and the workgroup is the entry the
//     user uses from then on. The old group is never deleted and its log is never sent anywhere.
//
// What is deliberately NOT in the upgrade request: the group's log, its messages, any transcript,
// the members' private memories, any tool permission, and any path. The body is
// `{ name, notice, upgradeId, endpointIds }` — settings only. The Hub refuses anything else by
// name (hub/src/workgroups/service.js), so a mistake here cannot turn into an upload, and gate
// item 3 measures both halves: the request body has no history, and the Hub group has no events.
import { randomUUID } from 'node:crypto'

// The states, in the order a successful upgrade passes through them.
export const UPGRADE_STATES = ['PREPARING', 'HUB_CREATED', 'LOCAL_LINKED', 'ACTIVE']
// The states after which there is nothing left to do. A retry on one of these is a no-op.
export const UPGRADE_DONE = new Set(['LOCAL_LINKED', 'ACTIVE'])

// How long a PREPARING record may sit before a retry is allowed to start over. It only matters when
// a process died between writing the intent and calling the Hub: the record then names a group that
// was never created, and the same `upgradeId` is what makes starting over safe.
export const PREPARING_TTL_MS = 10 * 60 * 1000

const newUpgradeId = () => `up_${randomUUID().replace(/-/g, '')}`

// What a person is shown when an upgrade stopped halfway. Each state has one sentence, because the
// difference matters: one can be retried, the other is done.
export const UPGRADE_HINTS = {
  PREPARING: 'The upgrade was started but never reached the Hub. Retrying is safe.',
  HUB_CREATED: 'The group exists on the Hub but this machine has not linked it yet. Retrying is safe.',
  LOCAL_LINKED: 'The group is linked. The local group is now archived history.',
  ACTIVE: 'The upgrade is complete.',
}

export function createUpgrade({ wg, logger }) {
  const { rt } = wg

  // The link record. `wg.state.links` already exists for this (G1 wrote `{workgroupId, upgradeId,
  // status}` there); G4 adds the two fields the four states need and keeps writing the same row, so
  // a state file written by an earlier build is still readable.
  const linkOf = localRoomId => wg.linkOf(localRoomId)

  const record = (localRoomId, patch) => {
    const current = wg.state.links[localRoomId] ?? {}
    wg.state.links[localRoomId] = { ...current, ...patch }
    return wg.state.links[localRoomId]
  }

  // The room a link points at, if this machine still has it.
  const roomOf = workgroupId => wg.roomOfHubGroup?.(workgroupId)

  const upstream = async () => {
    if (wg.bridge === undefined || wg.bridge === null) {
      throw Object.assign(new Error('The Hub bridge is not available, so a workgroup cannot be created.'), { code: 'upgrade/no-bridge' })
    }
    return wg.bridge
  }

  const upgrade = {
    states: UPGRADE_STATES,

    linkOf,

    // What the panel shows for a local group: whether it was ever upgraded, and how far that got.
    statusOf(localRoomId) {
      const link = linkOf(localRoomId)
      if (link === undefined) return { linked: false }
      return {
        linked: true,
        workgroupId: link.workgroupId,
        upgradeId: link.upgradeId,
        state: link.status,
        hint: UPGRADE_HINTS[link.status] ?? '',
        // The Hub group is gone but the link is not: the local group is still usable history, and
        // saying so is better than showing a workgroup that cannot be opened.
        broken: link.workgroupId !== undefined && roomOf(link.workgroupId) === undefined,
      }
    },

    // ── the transaction ───────────────────────────────────────────────────────────
    // Idempotent end to end: called again with the same local room it picks up wherever the previous
    // attempt stopped, and it reuses the link's own `upgradeId` so the Hub never sees a second key.
    //
    // `preview` is what the confirmation dialog shows and what the request is built from: a name, a
    // notice and the Bot endpoints to publish. It is deliberately not the local member list — a
    // local group's members are Bots on THIS machine, and a workgroup's member list lives on the Hub.
    async run({ localRoomId, preview = {} }) {
      await wg.load()
      const local = rt.roomOf?.(localRoomId)
      if (local === undefined) {
        throw Object.assign(new Error('Unknown local group'), { code: 'upgrade/not-found' })
      }

      let link = linkOf(localRoomId)
      // Finished already: answer with where it got to rather than creating anything.
      if (link !== undefined && UPGRADE_DONE.has(link.status)) {
        return { workgroupId: link.workgroupId, state: link.status, created: false, alreadyUpgraded: true }
      }

      // A record left in PREPARING by a dead process is restarted with the same key. The key is what
      // makes that safe, so it is never regenerated once written.
      const stale = link?.status === 'PREPARING' && (Date.now() - (link.createdAt ?? 0)) > PREPARING_TTL_MS
      if (link === undefined || stale) {
        link = record(localRoomId, {
          workgroupId: link?.workgroupId,
          upgradeId: link?.upgradeId ?? newUpgradeId(),
          status: 'PREPARING',
          createdAt: link?.createdAt ?? Date.now(),
          hubUserId: wg.hub?.account?.hubUserId,
        })
        await wg.save()
      }

      // ── PREPARING → HUB_CREATED ───────────────────────────────────────────────────
      // Only the fields a group's settings need. `localRoomId` is NOT sent: the Hub has no business
      // learning a local identifier, and the upgrade key is random precisely so it says nothing.
      const bridge = await upstream()
      const created = await bridge.createWorkgroup({
        name: typeof preview.name === 'string' && preview.name.trim() !== '' ? preview.name.trim() : local.name,
        notice: typeof preview.notice === 'string' ? preview.notice : (local.notice ?? ''),
        upgradeId: link.upgradeId,
        endpointIds: Array.isArray(preview.endpointIds) ? preview.endpointIds : undefined,
      })
      link = record(localRoomId, {
        workgroupId: created.workgroupId,
        status: 'HUB_CREATED',
        hubCreatedAt: Date.now(),
      })
      await wg.save()

      // ── HUB_CREATED → LOCAL_LINKED ────────────────────────────────────────────────
      // The local room that represents the Hub group. Its name and notice come from the Hub's answer,
      // so both machines show the same title.
      const room = await wg.ensureLinkedGroup({
        hubWorkgroupId: created.workgroupId,
        name: created.workgroup?.name ?? local.name,
        notice: created.workgroup?.notice ?? local.notice ?? '',
      })
      link = record(localRoomId, {
        status: 'LOCAL_LINKED',
        roomId: room.id,
        linkedAt: Date.now(),
        // Which local group this came from, by name only: the local id stays here, and the name is a
        // display snapshot so renaming the local group later never rewrites the workgroup.
        localName: local.name,
      })
      await wg.save()

      // ── LOCAL_LINKED → ACTIVE ─────────────────────────────────────────────────────
      // The original group becomes read-only history. It is NOT deleted, its log files are NOT
      // touched, and nothing is uploaded: the only thing that changes is a marker this domain and the
      // client read, plus the archived Session.
      await upgrade.archiveLocalGroup(localRoomId)
      link = record(localRoomId, { status: 'ACTIVE', activatedAt: Date.now() })
      await wg.save()

      return {
        workgroupId: created.workgroupId,
        roomId: room.id,
        state: 'ACTIVE',
        // Whether THIS call created the Hub group. A retry answers `false`, which is the fact gate
        // item 4 asserts.
        created: created.created === true,
      }
    },

    // ── the archive ───────────────────────────────────────────────────────────────
    // Marks the local group as archived and archives its Session, so the sidebar can show it as
    // history and the shell cannot resume it by accident. The room record itself stays in
    // `state.rooms`: deleting it would be destroying the history the plan says to keep.
    //
    // `rt.archivedRooms` is this domain's own set — the local domain's `state.rooms` records are not
    // rewritten, because `src/host/groups.js` and the store it writes are byte-for-byte the
    // original's and must stay that way.
    async archiveLocalGroup(localRoomId) {
      wg.archivedRooms ??= new Set()
      wg.archivedRooms.add(localRoomId)
      const target = rt.roomOf?.(localRoomId)
      if (target !== undefined) {
        // The local group's own Session is archived the same way a deleted group's is: the state
        // record survives, the Session stops being resumable, and nothing is copied anywhere.
        await rt.ctx?.workspaceRegistry?.archiveSession?.(localRoomId, { stopActivity: true })
          ?.catch?.(error => logger?.warn?.('ds-bot: local group %s not archived: %s', target.name, error?.message ?? error))
      }
      await wg.save()
      return true
    },

    // Whether a local group was archived by an upgrade, so the client can show it as history
    // instead of offering to send into it.
    isArchived(localRoomId) {
      return wg.archivedRooms?.has?.(localRoomId) === true || linkOf(localRoomId)?.status === 'ACTIVE'
    },

    // ── failure handling ──────────────────────────────────────────────────────────
    // A failure does not roll the Hub group back by itself: the group may already have been seen by
    // someone else. What it does is keep the link where it stopped, so a retry continues instead of
    // starting again — and the hint says which state it is in.
    async fail(localRoomId, error) {
      const link = linkOf(localRoomId)
      if (link === undefined) return undefined
      record(localRoomId, { lastError: String(error?.message ?? error).slice(0, 500), lastErrorAt: Date.now() })
      await wg.save()
      return upgrade.statusOf(localRoomId)
    },
  }

  return upgrade
}

// Installed into the domain. The runtime mutates `wg`, so the upgrade API is reachable from the
// channel (`upgrade-room`), the panel (status) and the tests without a second export path.
export function install(wg) {
  wg.upgrade = createUpgrade({ wg, logger: wg.rt })
  wg.archivedRooms ??= new Set()
}
