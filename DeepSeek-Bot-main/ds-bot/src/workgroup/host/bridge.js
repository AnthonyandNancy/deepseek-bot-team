// The Hub bridge: one WSS connection, one outbox, one inbox.
//
// `src/workgroup/index.js` left `wg.bridge` as a placeholder ("filled in G3+") and G3 filled it
// with the HTTP client alone. This module is what that placeholder was for. Everything the
// workgroup domain does *across devices* goes through here:
//
//   * the group's log is the Hub's event log, pulled by `seq` cursor and pushed live;
//   * a message typed on this machine is appended to the Hub first, then delivered locally, so a
//     message that "sent" is a message the Hub has;
//   * a message from another machine arrives as an event and is posted into the group's own chat
//     the same way a local member's line is, so the UI does not need a second code path.
//
// Four properties, each of which the gates measure (docs/workgroup/gate notes):
//
//   1. **Nothing runs while signed out.** `start()` on a signed-out machine does nothing at all,
//      so a Bot team with no Hub is exactly the G3 team.
//   2. **At-least-once, deduplicated.** Every event has an `eventId` minted here for outgoing
//      messages; incoming events are filtered by a persistent set of ids this machine has already
//      applied. A redelivery therefore cannot post the same line twice.
//   3. **Order by seq, not by arrival.** A live event may arrive before a replayed one; the inbox
//      applies anything higher than its cursor and asks for the gap.
//   4. **Send is idempotent.** The outbox keeps a message until the Hub acknowledges its
//      `eventId`; a reconnect resends the same id, which the Hub deduplicates (see
//      hub/src/events/service.js).
//
// The bridge never signs anything: `hub.socketAuth()` returns a `sign` closure over the stored
// private key, so this module cannot read the key even if it wanted to.
import { randomUUID } from 'node:crypto'

// The transport is the runtime's own `WebSocket`, not a package.
//
// This plugin's only dependency is `esbuild` (a build tool); everything else it needs, DSH
// provides. A browser `WebSocket` cannot set an `Authorization` header, which is exactly why the
// Hub accepts the token as the *first frame* instead: one code path that works in Electron, in
// DSH Web and under Node's own `WebSocket`. The Hub checks that frame with the same rules it
// checks a header with (hub/src/ws.js), so nothing is weakened by the extra route.
const defaultSocket = () => {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new BridgeError('This runtime has no WebSocket, so the Hub connection is unavailable.', { code: 'bridge/no-websocket' })
  }
  return globalThis.WebSocket
}

// How long to wait before the first reconnect, doubling up to the cap. Exponential rather than
// fixed so a Hub that is down does not receive a reconnect per second from every device.
export const RECONNECT_MIN_MS = 1000
export const RECONNECT_MAX_MS = 30_000
// A socket that has been silent this long is treated as dead even if no close frame arrived —
// the usual shape of a laptop sleeping or a NAT entry expiring.
export const LIVENESS_MS = 90_000
// How many event ids this machine remembers for dedup. A group's log is trimmed to
// WG_LOG_MAX locally, so remembering an order of magnitude more than that is enough to cover
// every redelivery a reconnect can produce.
export const SEEN_LIMIT = 2000

const newEventId = () => `evt_${randomUUID().replace(/-/g, '')}`

// A refusal or a lost connection, carrying the Hub's own code so a caller can decide whether to
// retry. `retryable` is what the outbox reads.
export class BridgeError extends Error {
  constructor(message, { code = 'bridge/error', retryable = true } = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.retryable = retryable
  }
}

export function createBridge({ wg, logger, now = () => Date.now(), webSocketImpl } = {}) {
  // Per-group state. `cursor` is the highest seq applied to the local log; `seen` is the ids
  // already applied; `outbox` is what the Hub has not acknowledged.
  //
  // All of it is in memory for G4 and rebuilt from the Hub on connect: the Hub is the authority
  // for the log, so a restart that forgets its cursor simply pulls from 0 and re-applies nothing
  // (the log is idempotent by `eventId`).
  const groups = new Map()
  let socket
  let auth
  let attempts = 0
  let reconnectTimer
  let livenessTimer
  let stopped = true
  // Set when there is no stored account to connect with. A retry loop would be pointless, and the
  // account page must be able to say "sign in" rather than "reconnecting forever".
  let signedOut = false
  // The Hub answered, and its answer was that this session no longer exists. `signedOut` also covers
  // "there was never an account" and "the user just signed out", and neither of those is news; this
  // one is, because a person who believed they were signed in needs to be told to sign in again
  // rather than told the Hub is unreachable.
  let sessionRefused = false
  let connecting
  // Resolves when the Hub has greeted this socket (or refuses it), so `start()` answers with a fact
  // rather than with "a WebSocket object now exists". Without it, `hub-login` reported
  // `connected: false` a moment before the socket really was connected.
  let greeted
  let settleGreet
  // Subscribers: the client view and the chat pane both want to know when a group changed.
  const listeners = new Set()
  // Event id → the promise that the local log shows it. Only for the frame handlers, so an
  // `await` on `apply` is honest about when the line is actually there.
  const pending = new Map()

  const emit = (name, payload) => {
    for (const listener of listeners) {
      try { listener(name, payload) } catch (error) { logger?.warn?.('ds-bot: bridge listener failed: %s', error?.message ?? error) }
    }
  }

  const stateOf = (workgroupId) => {
    let entry = groups.get(workgroupId)
    if (entry === undefined) {
      entry = { workgroupId, cursor: 0, seen: new Set(), outbox: [], lastEventAt: undefined, readSeq: 0 }
      groups.set(workgroupId, entry)
    }
    return entry
  }

  const connected = () => socket !== undefined && socket.readyState === 1

  // The local room for a Hub group, created the first time this machine needs it. Used on every path
  // that can learn about a group it did not create: a join, a first event, a post from elsewhere.
  const ensureRoom = async (workgroupId) => {
    const known = wg.roomOfHubGroup?.(workgroupId)
    if (known !== undefined) return known
    const answer = await wg.hub.workgroup(workgroupId).catch(() => undefined)
    return wg.ensureLinkedGroup?.({
      hubWorkgroupId: workgroupId,
      name: answer?.name,
      notice: answer?.notice ?? '',
    })
  }

  // ── outbox ──────────────────────────────────────────────────────────────────────
  // A message leaves the outbox only on the Hub's own ack for its `eventId`. A reconnect resends
  // every entry with the same id, which is what makes "sent twice, stored once" true rather than
  // hoped for.
  // The frame for one outbox entry. `send` (a chat message) and `sendEvent` (a task request) share
  // this, and the frame type comes from the entry: G4 hard-coded `chat.message` here, which meant a
  // task request would have been sent as a chat line.
  const frameOf = (workgroupId, pending) => {
    const type = pending.frameType ?? 'chat.message'
    // A task request is an envelope the Hub verifies against this device's key. It is built and
    // signed by the caller (`tasks.js`), because only that module knows what it is asking for — and
    // rebuilding it here would sign a different `createdAt` than the one the fields describe.
    if (type === 'task.request') {
      return { v: 1, type, workgroupId, eventId: pending.envelope.eventId, envelope: pending.envelope }
    }
    return {
      v: 1,
      type,
      workgroupId,
      eventId: pending.eventId,
      payload: pending.payload,
      ...(pending.botEndpointId === undefined ? {} : { botEndpointId: pending.botEndpointId }),
    }
  }

  const flush = (workgroupId) => {
    if (!connected()) return 0
    const entry = stateOf(workgroupId)
    let sent = 0
    for (const pending of entry.outbox) {
      socket.send(JSON.stringify(frameOf(workgroupId, pending)))
      sent += 1
    }
    return sent
  }

  // ── inbox ───────────────────────────────────────────────────────────────────────
  // Applying an event is idempotent by `eventId`, and ordered by `seq`. An event that arrives with
  // a seq beyond `cursor + 1` means something was missed: the local log applies it anyway (so the
  // user sees the newest line) and a gap pull fills in the rest, which is exactly the behaviour a
  // chat needs — never silently reordering, never waiting forever for one lost frame.
  const apply = async (workgroupId, event) => {
    const entry = stateOf(workgroupId)
    if (entry.seen.has(event.eventId)) return false
    if (entry.seen.size >= SEEN_LIMIT) {
      // Bounded memory: drop the oldest quarter. A redelivery older than this would be a Hub
      // replaying from before the local log's own trim, which cannot add a visible line anyway.
      const drop = Math.floor(SEEN_LIMIT / 4)
      let index = 0
      for (const id of entry.seen) {
        entry.seen.delete(id)
        index += 1
        if (index >= drop) break
      }
    }
    entry.seen.add(event.eventId)
    entry.cursor = Math.max(entry.cursor, event.seq)
    entry.lastEventAt = event.createdAt ?? new Date(now()).toISOString()

    // The local domain puts the line into the workgroup's own chat. This is the same call the
    // local round uses for a member's line, so a message from another machine and a message from
    // a local Bot look identical in the log and in the UI.
    //
    // A failure here is reported and swallowed: a line the local log refused must not stop the
    // cursor from advancing, or the same event would be retried forever.
    if (event.type === 'chat.message') {
      // The room may not exist on this machine yet: an invite accepted elsewhere, or a group this
      // account joined on another device. Creating it here is what makes the first message of such
      // a group visible instead of silently dropped.
      const shown = Promise.resolve()
        .then(() => wg.receiveRemote?.({ workgroupId, event }))
        .then((applied) => {
          if (applied === true) return undefined
          return Promise.resolve(wg.ensureLinkedGroup?.({ hubWorkgroupId: workgroupId }))
            .then(() => wg.syncRoster?.({ hubWorkgroupId: workgroupId }))
            .then(() => wg.receiveRemote?.({ workgroupId, event }))
        })
        .catch(error => logger?.warn?.('ds-bot: workgroup event %s not shown: %s', event.eventId, error?.message ?? error))
      // Remembered so a caller that awaits `apply` sees the line in the log; the socket path does
      // not await, but a test and the attachment path do.
      pending.set(event.eventId, shown)
      void shown.finally(() => pending.delete(event.eventId))
    }
    // A task-related event also reaches the task runner: the approval card a request becomes, and
    // the grant a decision produces. It is NOT a chat line, so it never becomes one.
    if (typeof event.type === 'string' && (event.type.startsWith('task.') || event.type.startsWith('approval.') || event.type.startsWith('artifact.'))) {
      void Promise.resolve(wg.onTaskEvent?.({ workgroupId, event }))
        .catch(error => logger?.warn?.('ds-bot: task event %s not applied: %s', event.eventId, error?.message ?? error))
    }
    emit('event', { workgroupId, event })
    // Told to the Hub so a reconnect does not replay what is already on screen. Best effort: a
    // failed ack only costs one redundant replay, which the dedup above absorbs.
    if (connected()) socket.send(JSON.stringify({ v: 1, type: 'event.ack', workgroupId, eventIds: [event.eventId] }))
    return true
  }

  const applyBatch = async (workgroupId, events) => {
    let applied = 0
    for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
      if (await apply(workgroupId, event)) applied += 1
    }
    return applied
  }

  // ── frames ──────────────────────────────────────────────────────────────────────
  const onFrame = (workgroupIdHint, frame) => {
    switch (frame.type) {
      case 'hello': {
        // The greeting is the proof the handshake was accepted.
        settleGreet?.(true)
        settleGreet = undefined
        // Every group the account is in gets a sync request from its own cursor. A group this
        // machine has never seen starts at 0 and pulls the Hub's log, which is what makes a fresh
        // install show the conversation it is joining.
        for (const workgroupId of frame.workgroups ?? []) {
          const entry = stateOf(workgroupId)
          socket.send(JSON.stringify({ v: 1, type: 'sync.request', workgroupId, afterSeq: entry.cursor }))
          flush(workgroupId)
          // The roster first, then the log: the first line of a group can come from somebody this
          // machine has never seen, and without the roster that line can only be "A member". Best
          // effort — a Hub that refuses the roster call must not stop the messages.
          void Promise.resolve(wg.syncRoster?.({ hubWorkgroupId: workgroupId }))
            .catch(error => logger?.warn?.('ds-bot: roster of %s not read: %s', workgroupId, error?.message ?? error))
        }
        emit('connected', { userId: frame.userId, deviceId: frame.deviceId, workgroups: frame.workgroups ?? [] })
        return
      }
      case 'event': {
        // A live event. Applied only if it is newer than the cursor; a gap is filled by the
        // sync below, which is triggered by the seq arithmetic rather than by a timer.
        const entry = stateOf(frame.workgroupId)
        const expected = entry.cursor + 1
        void apply(frame.workgroupId, frame.event)
        if (frame.event.seq > expected) {
          socket.send(JSON.stringify({ v: 1, type: 'sync.request', workgroupId: frame.workgroupId, afterSeq: entry.cursor }))
        }
        return
      }
      case 'sync.batch': {
        void applyBatch(frame.workgroupId, frame.events ?? [])
        // `hasMore` means the Hub capped the page. Ask again from where this batch ended rather
        // than waiting for the next event to reveal the rest.
        if (frame.hasMore === true) {
          socket.send(JSON.stringify({ v: 1, type: 'sync.request', workgroupId: frame.workgroupId, afterSeq: frame.nextAfterSeq ?? stateOf(frame.workgroupId).cursor }))
        }
        return
      }
      case 'ack.ok': {
        // The Hub has the message. That is the only thing that removes an entry from the outbox,
        // and it is also the moment this machine learns the `seq` the Hub gave it.
        if (typeof frame.eventId === 'string') {
          const workgroupId = frame.workgroupId ?? workgroupIdHint
          const entry = stateOf(workgroupId)
          const sent = entry.outbox.find(pending => pending.eventId === frame.eventId)
          entry.outbox = entry.outbox.filter(pending => pending.eventId !== frame.eventId)
          // The Hub does NOT echo an event back to the device that sent it (that would draw every
          // message twice), so the sender's own line has to be applied here or the author never sees
          // what they wrote. `apply` deduplicates by `eventId`, so a replay of the same event — from
          // a sync after a restart, say — still lands once.
          if (sent !== undefined && Number.isFinite(frame.seq) && frame.duplicate !== true) {
            void apply(workgroupId, {
              eventId: frame.eventId,
              workgroupId,
              seq: frame.seq,
              type: 'chat.message',
              sender: { userId: auth?.hubUserId, deviceId: auth?.deviceId },
              payload: sent.payload,
              createdAt: new Date(now()).toISOString(),
            })
          }
          emit('ack', { workgroupId, eventId: frame.eventId, seq: frame.seq, duplicate: frame.duplicate === true })
        }
        return
      }
      case 'read.updated':
      case 'read.ok': {
        // The Hub's own answer wins: it is the authority for the cursor, and this is also how a
        // read made on another of this person's devices reaches this one.
        if (frame.workgroupId !== undefined && Number.isFinite(frame.lastReadSeq)) {
          const entry = stateOf(frame.workgroupId)
          entry.readSeq = Math.max(entry.readSeq, frame.lastReadSeq)
        }
        emit('read', { workgroupId: frame.workgroupId, lastReadSeq: frame.lastReadSeq })
        return
      }
      case 'subscribed': {
        emit('subscribed', { workgroupIds: frame.workgroupIds ?? [] })
        return
      }
      case 'member.changed': {
        // Not a log line and not a `seq`: just "the roster moved". Re-reading it is cheap and it is
        // what makes a newly joined member's next message attributable.
        const workgroupId = frame.workgroupId
        if (workgroupId !== undefined) {
          void Promise.resolve(wg.syncRoster?.({ hubWorkgroupId: workgroupId }))
            .catch(error => logger?.warn?.('ds-bot: roster of %s not refreshed: %s', workgroupId, error?.message ?? error))
        }
        emit('membership', { workgroupId, kind: frame.kind })
        return
      }
      case 'error': {
        // A refused frame is reported, not retried: the Hub refused it for a reason that a retry
        // would repeat. The one exception is a whole-socket failure, which arrives as a close.
        logger?.warn?.('ds-bot: the Hub refused a frame: %s %s', frame.code, frame.detail ?? '')
        emit('refused', { code: frame.code, detail: frame.detail })
        return
      }
      case 'task.ok': {
        // The Hub has the request (or already had it). Either way the outbox entry can go: its job
        // was to get the task to the Hub once, and a `duplicate` answer proves it is there.
        const workgroupId = frame.workgroupId ?? workgroupIdHint
        if (workgroupId !== undefined && typeof frame.taskId === 'string') {
          const entry = stateOf(workgroupId)
          entry.outbox = entry.outbox.filter(pending => pending.envelope?.taskId !== frame.taskId)
        }
        emit('task', { kind: 'accepted', taskId: frame.taskId, state: frame.state, duplicate: frame.duplicate === true })
        return
      }
      case 'task.reported': {
        // This machine's own report was accepted. `version` is the Hub's, so a stale local record can
        // tell it lost rather than assuming it is current.
        emit('task', { kind: 'reported', taskId: frame.taskId, state: frame.state, version: frame.version })
        return
      }
      case 'lease.ok':
      case 'lease.released': {
        emit('lease', { kind: frame.type === 'lease.ok' ? 'ok' : 'released', lease: frame.lease, workgroupId: frame.workgroupId })
        return
      }
      case 'heartbeat':
        return
      default:
        return
    }
  }

  const scheduleReconnect = () => {
    if (stopped) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempts)
    attempts += 1
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => { void connect() }, delay)
    // A timer must not keep the process alive on its own.
    reconnectTimer.unref?.()
  }

  const connect = async () => {
    if (stopped || connected() || connecting !== undefined) return connecting
    connecting = (async () => {
      try {
        auth ??= await wg.hub.socketAuth()
        const timestamp = now()
        const nonce = randomUUID()
        const signature = auth.sign(auth.deviceId, timestamp, nonce)
        const base = auth.baseUrl.replace(/^http/, 'ws')
        // `auth=frame` declares that the token follows in the first frame rather than in a
        // header, which a standard `WebSocket` cannot set. The token is never put in the URL: a
        // query string is the first thing a proxy or a log records.
        const url = `${base}/v1/ws?deviceId=${encodeURIComponent(auth.deviceId)}&ts=${timestamp}`
          + `&nonce=${encodeURIComponent(nonce)}&sig=${encodeURIComponent(signature)}&auth=frame`
        const Socket = webSocketImpl ?? defaultSocket()
        // The token travels in the first frame, because a standard `WebSocket` cannot set an
        // `Authorization` header. The Hub refuses everything else until that frame arrives.
        const ws = new Socket(url)
        socket = ws
        greeted = new Promise((resolve) => { settleGreet = resolve })
        ws.addEventListener('open', () => {
          attempts = 0
          try { ws.send(JSON.stringify({ v: 1, type: 'auth', accessToken: auth.accessToken })) } catch { /* close follows */ }
          emit('open', {})
        })
        ws.addEventListener('message', (data) => {
          let frame
          try { frame = JSON.parse(String(data?.data ?? data)) } catch { return }
          if (socket !== ws && frame?.type !== 'hello') return
          onFrame(undefined, frame)
        })
        ws.addEventListener('close', (event) => {
          if (socket === ws) socket = undefined
          clearInterval(livenessTimer)
          // A socket that closed before it was greeted settles the wait as "not connected", so a
          // caller never hangs on a refusal.
          settleGreet?.(false)
          settleGreet = undefined
          emit('closed', { code: event?.code, reason: String(event?.reason ?? '') })
          // 4401 (revoked) and 4402 (bad auth) are decisions, not failures: retrying would loop.
          // The account page shows the device as revoked instead.
          if (event?.code !== 4401 && event?.code !== 4402) scheduleReconnect()
        })
        ws.addEventListener('error', (error) => {
          emit('error', { message: String(error?.message ?? error?.error?.message ?? 'socket error') })
        })
        // The Hub pings; a standard `WebSocket` answers with a pong on its own. This timer is the
        // client's guard against a socket that is open but dead — a laptop that slept, a NAT entry
        // that expired — where no close event ever arrives.
        let lastFrameAt = now()
        livenessTimer = setInterval(() => {
          if (!connected()) return
          if (now() - lastFrameAt > LIVENESS_MS) {
            try { ws.close() } catch { /* already gone */ }
            return
          }
          emit('tick', {})
        }, Math.floor(LIVENESS_MS / 3))
        const noteFrame = () => { lastFrameAt = now() }
        ws.addEventListener('message', noteFrame)
      } catch (error) {
        socket = undefined
        // No stored account is not a failure to retry: the user has not signed in. A session the Hub
        // refused is the same conclusion from a different cause — the record was just deleted, so
        // reconnecting would only repeat a doomed handshake. The reason is kept for `status()`, so a
        // caller can say "sign in again" instead of blaming the Hub.
        if (error?.code === 'hub/signed-out') { attempts = 0; signedOut = true; sessionRefused = true; stopped = true; return }
        if (error?.code === 'hub/not-signed-in') { attempts = 0; signedOut = true; stopped = true; return }
        emit('error', { message: String(error?.message ?? error) })
        scheduleReconnect()
      } finally {
        connecting = undefined
      }
    })()
    await connecting
    // Wait for the greeting, but not forever: a Hub that accepts the TCP connection and then says
    // nothing must not make a sign-in hang. The timeout is short because this is one round trip.
    if (greeted !== undefined) {
      await Promise.race([
        greeted,
        new Promise((resolve) => { const timer = setTimeout(() => resolve(false), 5000); timer.unref?.() }),
      ])
      greeted = undefined
    }
    return undefined
  }

  const bridge = {
    // ── lifecycle ──────────────────────────────────────────────────────────────────
    // Idempotent, and safe to call from anywhere that knows there is an account: signing in, the
    // panel mounting, the account page's "connect" button, and the host's own install path.
    //
    // A second call while a socket exists does nothing at all. A second call while one is being
    // opened joins that attempt rather than starting another. Only a call after `stop()` really
    // reconnects — which is why `auth` is kept across restarts of the same account: the handshake
    // signature is minted per connection, so caching it across a reconnect would send a stale one.
    async start() {
      stopped = false
      signedOut = false
      sessionRefused = false
      // A cached `auth` from before a stop is still the same account, and `socketAuth()` re-mints
      // the access token; keeping it avoids a Hub round trip on every reconnect. It is dropped on
      // `reset()` (sign-out), where the account itself changed.
      if (auth === undefined) {
        await connect()
      } else if (!connected() && connecting === undefined) {
        // A token that has expired since the last socket is re-minted by `socketAuth()` inside
        // `connect()`, so the cache is cleared first: a refresh happens exactly once per connect.
        auth = undefined
        await connect()
      }
      // Never throws while there is no account: a team with no Hub has to behave exactly like the G3
      // team, and that rule is pinned by a test. What it must not do is hide a session the Hub
      // refused, because then a caller reports a Hub problem when the session is what is gone —
      // `bridge.status().refused` carries that reason for anyone who can act on it.
      return bridge.status()
    },

    // Closes the socket and stops reconnecting. The outbox is kept: signing back in should not
    // throw away a message the user typed while the Hub was down.
    async stop() {
      stopped = true
      clearTimeout(reconnectTimer)
      clearInterval(livenessTimer)
      const ws = socket
      socket = undefined
      if (ws !== undefined) {
        try { ws.close() } catch { /* already closed */ }
      }
      emit('closed', { code: 1000, reason: 'stopped' })
      return true
    },

    // Called after a sign-out, where the outbox *is* discarded: those messages belong to the
    // account that just left, and sending them as the next account would be a leak.
    async reset() {
      await bridge.stop()
      groups.clear()
      auth = undefined
      attempts = 0
      signedOut = true
      return true
    },

    status() {
      return {
        connected: connected(),
        // What the page shows. "signed-out" is distinct from "offline": one means there is no
        // account to connect with (nothing to retry), the other means the Hub is not answering.
        state: signedOut
          ? 'signed-out'
          : connected() ? 'online' : stopped ? 'offline' : 'connecting',
        // True only when the Hub itself refused the stored session. The account page and the
        // workgroup create path read this to say "sign in again" rather than "the Hub is down".
        refused: sessionRefused,
        pending: [...groups.values()].reduce((total, entry) => total + entry.outbox.length, 0),
        groups: [...groups.values()].map(entry => ({ workgroupId: entry.workgroupId, cursor: entry.cursor, pending: entry.outbox.length })),
      }
    },

    // ── groups ────────────────────────────────────────────────────────────────────
    // Creates the group on the Hub. The caller supplies `upgradeId` for an upgrade; the Hub's
    // answer says whether this call created it, which is what makes a retried upgrade harmless.
    async createWorkgroup({ name, notice, upgradeId, endpointIds }) {
      const created = await wg.hub.createWorkgroup({ name, notice, upgradeId, endpointIds })
      stateOf(created.workgroupId)
      // The local room that represents this Hub group on this machine. Created once per Hub group
      // and reused on every later call, so a retried upgrade does not produce a second room.
      await wg.ensureLinkedGroup({
        hubWorkgroupId: created.workgroupId,
        name: created.workgroup?.name ?? name,
        notice: created.workgroup?.notice ?? notice ?? '',
      })
      // A brand new group has no log; the sync below is what a second machine would do.
      if (connected()) socket.send(JSON.stringify({ v: 1, type: 'sync.request', workgroupId: created.workgroupId, afterSeq: 0 }))
      return created
    },

    // Brings one group's cursor up to date over HTTP, so a group opened while the socket is down
    // still shows its messages. The socket path is preferred for live updates; this is the
    // recovery path and the "just opened the panel" path.
    async sync(workgroupId) {
      const entry = stateOf(workgroupId)
      let cursor = entry.cursor
      let lastSeq = cursor
      for (let round = 0; round < 50; round += 1) {
        const page = await wg.hub.events({ workgroupId, afterSeq: cursor })
        await applyBatch(workgroupId, page.events ?? [])
        cursor = page.nextAfterSeq ?? cursor
        lastSeq = page.lastSeq ?? lastSeq
        if (page.hasMore !== true) break
      }
      return { workgroupId, cursor: entry.cursor, lastSeq }
    },

    // Sends a message. The Hub gets it first: a message that reaches the local log but not the Hub
    // would be invisible to everyone else, which is worse than a send that fails visibly.
    async send({ workgroupId, text, attachments, botEndpointId }) {
      const payload = { text, ...(attachments === undefined ? {} : { attachments }) }
      if (text.trim() === '' && (attachments ?? []).length === 0) throw new BridgeError('Nothing to send', { code: 'bridge/empty', retryable: false })
      const entry = stateOf(workgroupId)
      const pending = { eventId: newEventId(), payload, queuedAt: now(), ...(botEndpointId === undefined ? {} : { botEndpointId }) }
      entry.outbox.push(pending)
      if (!connected()) {
        // Queued. The reconnect flushes it with the same event id, so the Hub stores one copy.
        emit('queued', { workgroupId, eventId: pending.eventId })
        // A socket that is merely down still deserves an attempt to come back.
        scheduleReconnect()
        return { queued: true, eventId: pending.eventId }
      }
      flush(workgroupId)
      return { queued: false, eventId: pending.eventId }
    },

    // Sends a frame that is not a chat message through the same outbox.
    //
    // This exists because the reliability G4 built is exactly what G5 needs: a task request has to
    // reach the Hub while the socket is down, must not be lost when it is, and must not become two
    // requests when the ack is lost. Keeping `send()` chat-only means the composer cannot
    // accidentally fire a task by typing, and this path carries the envelope the Hub verifies.
    //
    // Returns once the frame is on the wire (or queued). The Hub's answer arrives as a
    // `task.ok`/`error` frame through `on(...)`; this call does not wait for it, because the whole
    // point of the outbox is that the answer may arrive after a restart.
    async sendEvent({ workgroupId, frameType, payload, envelope, eventId }) {
      const entry = stateOf(workgroupId)
      const id = eventId ?? envelope?.eventId ?? newEventId()
      const pending = {
        eventId: id,
        frameType,
        payload,
        ...(envelope === undefined ? {} : { envelope }),
        queuedAt: now(),
      }
      entry.outbox.push(pending)
      if (!connected()) {
        emit('queued', { workgroupId, eventId: id, frameType })
        scheduleReconnect()
        return { queued: true, eventId: id }
      }
      flush(workgroupId)
      return { queued: false, eventId: id }
    },

    // The HTTP path for an attachment message: the bytes go up over HTTPS (they are too large for
    // a frame) and the Hub appends the event itself.
    async sendAttachment({ workgroupId, name, mime, data }) {
      const uploaded = await wg.hub.uploadAttachment({ workgroupId, name, mime, data })
      // The Hub has already fanned the event out; applying it here too means the sending machine
      // sees its own line without waiting for a replay.
      if (uploaded.event !== undefined) await apply(workgroupId, uploaded.event)
      return uploaded
    },

    async downloadAttachment({ attachmentId }) {
      const ticket = await wg.hub.attachmentTicket({ attachmentId })
      return wg.hub.downloadAttachment({ attachmentId, ticket: ticket.ticket })
    },

    async markRead({ workgroupId, seq }) {
      const entry = stateOf(workgroupId)
      // Forward only, and remembered locally so the pane can draw the badge without asking again.
      // The Hub enforces the same rule (`MAX(...)` in the cursor upsert), so the two cannot disagree
      // about which direction "read" moves.
      const target = Math.max(entry.readSeq, Number.isFinite(seq) ? Math.floor(seq) : 0)
      entry.readSeq = target
      if (connected()) {
        socket.send(JSON.stringify({ v: 1, type: 'read.updated', workgroupId, seq: target }))
        return { workgroupId, lastReadSeq: target }
      }
      const answer = await wg.hub.markRead({ workgroupId, seq: target })
      entry.readSeq = Math.max(target, answer?.lastReadSeq ?? 0)
      return { workgroupId, lastReadSeq: entry.readSeq }
    },

    // What this machine last told the Hub it had read. Zero until something is read.
    readCursor(workgroupId) {
      return groups.get(workgroupId)?.readSeq ?? 0
    },

    // ── the coordinator lease (plan §9.5) ──────────────────────────────────────
    // One scheduler per group. A round asks for the lease before it starts and names its epoch when it
    // reports; the Hub refuses a report from a round that ran under an older epoch.
    //
    // Over the socket rather than HTTP: a round commits while it runs, and asking the Hub over a fresh
    // HTTP connection at that moment would be both slower and a second failure mode.
    async acquireLease({ workgroupId, leaseMs }) {
      if (!connected()) throw new BridgeError('The Hub is not connected, so no lease can be taken.', { code: 'bridge/offline' })
      // The answer arrives as a `lease.ok` or an `error` frame through `on`, the same way every other
      // server push is observed. The promise settles on whichever comes first, so a refusal surfaces
      // as a refusal rather than a timeout.
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off()
          reject(new BridgeError('The Hub did not answer the lease request.', { code: 'bridge/timeout' }))
        }, 5000)
        timer.unref?.()
        const off = bridge.on((name, payload) => {
          if (name === 'lease' && payload?.kind === 'ok') {
            clearTimeout(timer)
            off()
            resolve({ lease: payload.lease })
          }
        })
        const refusal = bridge.on((name, payload) => {
          if (name === 'refused') {
            clearTimeout(timer)
            refusal()
            off()
            reject(new BridgeError(payload?.detail ?? 'The Hub refused the lease.', { code: payload?.code ?? 'bridge/refused', retryable: false }))
          }
        })
        try {
          socket.send(JSON.stringify({ v: 1, type: 'lease.acquire', workgroupId, ...(leaseMs === undefined ? {} : { leaseMs }) }))
        } catch (error) {
          clearTimeout(timer)
          off()
          refusal()
          reject(error)
        }
      })
    },

    async releaseLease({ workgroupId }) {
      if (!connected()) return { released: false, offline: true }
      socket.send(JSON.stringify({ v: 1, type: 'lease.release', workgroupId }))
      return { released: true, workgroupId }
    },

    // Re-subscribes to a narrower set of groups. The chat pane calls this when it opens one group
    // so a busy account does not receive every group's traffic.
    async subscribe(workgroupIds) {
      if (!connected()) return { workgroupIds: [] }
      socket.send(JSON.stringify({ v: 1, type: 'subscribe', workgroupIds }))
      return { workgroupIds }
    },

    // ── membership ────────────────────────────────────────────────────────────────
    async invite({ workgroupId, phone, hubUserId }) {
      return wg.hub.invite({ workgroupId, phone, hubUserId })
    },
    async invites() {
      return wg.hub.invites()
    },
    async answerInvite({ inviteId, accept }) {
      const answer = await wg.hub.answerInvite({ inviteId, accept })
      // Accepting a group means this machine now wants its room, its roster and its log — in that
      // order, because `sync` needs somewhere to put the lines and the roster is what names their
      // authors.
      if (accept && answer.workgroupId !== undefined) {
        stateOf(answer.workgroupId)
        await ensureRoom(answer.workgroupId)
        await wg.syncRoster?.({ hubWorkgroupId: answer.workgroupId }).catch(() => {})
        await bridge.sync(answer.workgroupId)
      }
      return answer
    },
    async workgroups() {
      return wg.hub.workgroups()
    },
    async workgroup(workgroupId) {
      return wg.hub.workgroup(workgroupId)
    },

    // ── bot endpoints ─────────────────────────────────────────────────────────────
    // Publishing is idempotent on the Hub (per owner + device + local Bot), so calling this on
    // every start is the correct way to refresh a capability list.
    async publishBotEndpoints() {
      const bots = wg.rt.state?.bots ?? {}
      const published = []
      for (const bot of Object.values(bots)) {
        if (bot?.id === undefined) continue
        try {
          const result = await wg.hub.publishBotEndpoint({
            localBotId: String(bot.id),
            name: String(bot.name ?? bot.id),
            // The minimal set: this Bot can chat, and it can receive files. Nothing here claims a
            // tool, a folder or a capability the plugin cannot honour.
            capabilities: ['chat', 'files'],
          })
          published.push(result.endpoint)
        } catch (error) {
          // One Bot failing to publish must not stop the others, and must not stop a chat.
          logger?.warn?.('ds-bot: Bot %s not published to the Hub: %s', bot.id, error?.message ?? error)
        }
      }
      return published
    },

    // ── a remote member's turn ───────────────────────────────────────────────────
    // `groups.js` hands a remote member's turn here instead of creating a local Session (plan §8.3:
    // a remote person never becomes a local Session). This is the production definition of that
    // seam — it was missing, and the round silently skipped such members.
    //
    // What it does: turn the member's slot into a line on the Hub, addressed to the group. It is a
    // `chat.message` like any other, so the other machine receives it through the same fan-out and
    // the same ordering, which is what keeps two machines' logs identical.
    //
    // What it does NOT do: run anything on this machine, wait for an answer, or pretend the member
    // replied. A workgroup message is another person's turn; the model work that answers it belongs
    // to their device (and, for real cross-user delegation, to G5).
    async deliverRemote({ room, member, slot }) {
      if (room === undefined || member === undefined) return { skipped: 'no-member' }
      const hubWorkgroupId = room.hubWorkgroupId
      // A group that is not on the Hub has no remote members: `kind !== 'localBot'` can only exist
      // in a Hub group's roster. Saying so beats a silent no-op.
      if (hubWorkgroupId === undefined) return { skipped: 'not-on-hub' }

      // What the round would have said to a local member: the round's note and the new lines since
      // the member last spoke. `roomPrompt` needs a Session-shaped member and would read fields this
      // record does not have, so this builds the same two pieces from what the record does carry.
      const note = slot?.note === undefined ? undefined : String(slot.note)
      const text = note === undefined || note === ''
        ? `${member.name}, you were called in this round of "${room.name}".`
        : `[${member.name}] ${note}`
      try {
        const result = await bridge.send({ workgroupId: hubWorkgroupId, text })
        return { sent: true, eventId: result.eventId, queued: result.queued === true, memberId: member.id }
      } catch (error) {
        // Reported to the round as a failure so the user sees "could not reach that member" instead
        // of silence, which is what the missing seam produced.
        return { error }
      }
    },

    // ── observation ──────────────────────────────────────────────────────────────
    // The chat pane subscribes here instead of polling. Returns an unsubscribe function.
    on(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    // Test/diagnostic view of one group's bridge state.
    groupState(workgroupId) {
      const entry = groups.get(workgroupId)
      return entry === undefined ? undefined : { cursor: entry.cursor, seen: entry.seen.size, pending: entry.outbox.length }
    },
  }

  return bridge
}

// One install, into the domain this runtime already has. Replaces the placeholder the G1 build left
// (`index.js`: `bridge: null` — "filled in G3+"), which G3 filled with the bare HTTP client because
// there was nothing to bridge yet.
//
// Nothing is started here: no timer, no socket, no file read. `start()` is called by the account
// page when it knows there is an account, so a team with no Hub pays nothing at startup.
export function install(wg) {
  wg.bridge = createBridge({ wg, logger: wg.rt })
  // `groups.js` reaches a remote member's turn through `wg.deliverRemote`; the method lives on the
  // bridge because sending it is the bridge's job. Aliased here rather than called across modules so
  // the round has one name to look up, exactly as `wg.deliver` works for local members.
  wg.deliverRemote = args => wg.bridge.deliverRemote(args)
  // A sign-out must not leave a socket open under the old account, and the messages queued under
  // it must not be sent as the next one.
  wg.onHubSignedOut ??= async () => { await wg.bridge.reset() }
}
