// The WSS endpoint: the handshake, the fan-out, the receipts.
//
// G3 built the handshake and one behaviour — a revoked device stops being connected at once. G4
// adds the message protocol on top of that same authenticated socket, so a socket is always "one
// device of one user" and never has to be told who is speaking.
//
// The protocol, v1 (plan §9.2/§9.3, restricted to what G4 needs):
//
//   Hub → client   hello          { userId, deviceId, workgroups }
//                  event          { workgroupId, event }                 (fan-out)
//                  sync.batch     { workgroupId, events, lastSeq, hasMore, afterSeq }
//                  ack.ok         { workgroupId, seq | throughSeq }
//                  read.ok        { workgroupId, lastReadSeq }
//                  read.updated   { workgroupId, lastReadSeq }           (my other devices)
//                  heartbeat      { at }
//                  error          { code, detail }
//
//   client → Hub   subscribe      { workgroupIds }        (empty = all my groups)
//                  chat.message   { workgroupId, eventId, payload:{ text, attachments } }
//                  event.ack      { workgroupId, eventIds }   (or one `eventId`)
//                  sync.request   { workgroupId, afterSeq }
//                  read.updated   { workgroupId, seq }
//                  task.request   { envelope }  (plan §9.2 envelope, signed by the device)
//                  task.report    { taskId, next, version? }  (the owner's own device only)
//                  task.progress  { taskId, note?, percent? }
//                  lease.acquire / lease.release / lease.check  (plan §9.5 fencing)
//                  heartbeat      {}
//
// Three rules make the reliability claims real rather than decorative:
//
//   1. The sender is the connection. A frame carrying `sender`/`senderId` is not read; the Hub
//      fills the sender from the authenticated session and device (plan §9.2).
//   2. Fan-out writes `deliveries` per target device and only then sends. A target whose socket
//      is gone is not recorded as delivered, so its next `sync.request` — or its next connect —
//      replays the event.
//   3. `event.ack` is a statement about the client's own storage, and `unackedFor` is what the
//      Hub replays. A repeated ack is harmless (the row keeps its first timestamp), and an ack
//      for a seq the device pulled over HTTP is still recorded.
import { verify as verifySignature } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { bearerToken } from './auth/tokens.js'
import { HubError } from './errors.js'

export const CLOSE_REVOKED = 4401
export const CLOSE_BAD_AUTH = 4402
export const CLOSE_UNSUPPORTED = 4403
export const CLOSE_STALE = 4404

// How far a handshake timestamp may be from the Hub's clock, and how long a nonce is
// remembered. The nonce window outlasts the timestamp window, so a replay is refused by the
// timestamp check even after its nonce has been forgotten.
export const MAX_SKEW_MS = 120 * 1000
const NONCE_TTL_MS = MAX_SKEW_MS * 2
const HEARTBEAT_MS = 30 * 1000

// One frame may not exceed this. A `chat.message` with base64 attachments would be larger, which
// is why attachments travel over HTTP and the event only names their ids.
export const MAX_FRAME_BYTES = 64 * 1024

// How long a socket may exist before it authenticates. Short enough that an idle unauthenticated
// connection is not a resource, long enough for one round trip after `open`.
export const AUTH_WINDOW_MS = 10 * 1000

export const handshakePayload = (deviceId, timestamp, nonce) => Buffer.from(`${deviceId}.${timestamp}.${nonce}`)

// The one place a handshake signature is checked, exported so the test signs with the same
// bytes the Hub verifies instead of asserting against a second implementation.
export function verifyHandshake(publicKeyPem, deviceId, timestamp, nonce, signatureB64) {
  try {
    return verifySignature(null, handshakePayload(deviceId, timestamp, nonce), publicKeyPem, Buffer.from(String(signatureB64), 'base64'))
  } catch {
    return false
  }
}

const frame = value => JSON.stringify({ v: 1, ...value })

export function createWsService({ server, auth, devices, logger, workgroups, events, tasks, leases, now = () => Date.now() }) {
  const wss = new WebSocketServer({ server, path: '/v1/ws', maxPayload: MAX_FRAME_BYTES })
  // deviceId → Set<WebSocket>: one device may hold several connections (two windows), and a
  // revoke must close all of them.
  const connections = new Map()
  // Nonces seen inside the accept window, with the time they expire.
  const seenNonces = new Map()
  // Per-socket state: who it is and which groups it follows. Kept beside the socket rather than on
  // it so a detached socket cannot keep a stale reference alive.
  const state = new WeakMap()

  const remember = (nonce, at) => {
    for (const [key, expiresAt] of seenNonces) if (expiresAt <= at) seenNonces.delete(key)
    if (seenNonces.has(nonce)) return false
    seenNonces.set(nonce, at + NONCE_TTL_MS)
    return true
  }

  const attach = (deviceId, ws) => {
    const set = connections.get(deviceId) ?? new Set()
    set.add(ws)
    connections.set(deviceId, set)
  }

  const detach = (deviceId, ws) => {
    const set = connections.get(deviceId)
    if (set === undefined) return
    set.delete(ws)
    if (set.size === 0) connections.delete(deviceId)
  }

  const send = (ws, value) => {
    if (ws.readyState !== ws.OPEN) return false
    try {
      ws.send(frame(value))
      return true
    } catch {
      return false
    }
  }

  // ── fan-out ─────────────────────────────────────────────────────────────────────
  // Every live socket of every current member, except the sender's own device: a client already
  // has what it sent, and echoing it would make the sender render its own message twice.
  //
  // Membership is read *now* from the database, not from whatever the socket subscribed to at
  // handshake time, so someone who left a minute ago stops receiving.
  const fanOut = (workgroupId, event, { exceptDeviceId } = {}) => {
    const memberIds = new Set(workgroups.memberUserIds(workgroupId))
    let delivered = 0
    for (const [deviceId, sockets] of connections) {
      if (deviceId === exceptDeviceId) continue
      const followers = [...sockets].filter((ws) => {
        const info = state.get(ws)
        if (info === undefined) return false
        if (!memberIds.has(info.userId)) return false
        return info.groupIds === undefined || info.groupIds.has(workgroupId)
      })
      if (followers.length === 0) continue
      // The receipt is written before the frame goes out: a crash between the two would lose a
      // receipt for an event the client never got, which its cursor replay recovers anyway.
      events.markDelivered({ eventId: event.eventId, deviceId })
      for (const ws of followers) send(ws, { type: 'event', workgroupId, event })
      delivered += 1
    }
    return delivered
  }

  // ── frame handlers ──────────────────────────────────────────────────────────────
  // Each reports a refusal with an `error` frame. A refusal never closes the socket: one bad frame
  // from one client is not a reason to end a session, and the client's reconnect path is expensive.
  const refuse = (ws, code, detail) => send(ws, { type: 'error', code, detail })

  const requireGroup = (ws, info, workgroupId) => {
    const id = String(workgroupId ?? '')
    if (id === '') {
      refuse(ws, 'frame/invalid', 'A workgroup id is required.')
      return undefined
    }
    // Not a member → same refusal as "no such group", so the socket cannot be used to probe ids.
    if (!workgroups.isMember(id, info.userId)) {
      refuse(ws, 'workgroup/not-found', 'No such workgroup.')
      return undefined
    }
    return id
  }

  const handlers = {
    subscribe(ws, info, message) {
      const ids = Array.isArray(message.workgroupIds) ? message.workgroupIds.map(String) : undefined
      if (ids === undefined) {
        // No list means "everything I am in", resolved fresh on each fan-out.
        info.groupIds = undefined
        return send(ws, { type: 'subscribed', workgroupIds: workgroups.groupIdsOf(info.userId) })
      }
      // Only groups the user is in may be subscribed to; an unknown id is dropped rather than
      // refused, because a client's group list can be one event behind the Hub's.
      info.groupIds = new Set(ids.filter(id => workgroups.isMember(id, info.userId)))
      return send(ws, { type: 'subscribed', workgroupIds: [...info.groupIds] })
    },

    'chat.message'(ws, info, message) {
      const workgroupId = requireGroup(ws, info, message.workgroupId)
      if (workgroupId === undefined) return undefined
      try {
        // The sender is the connection. `message.sender` is ignored even if present.
        const { event, duplicate } = events.append({
          workgroupId,
          eventId: message.eventId,
          type: 'chat.message',
          sender: { userId: info.userId, deviceId: info.deviceId, botEndpointId: message.botEndpointId },
          payload: message.payload,
        })
        send(ws, { type: 'ack.ok', workgroupId, eventId: event.eventId, seq: event.seq, duplicate })
        // A duplicate is not fanned out again: the first append already did that, and a second
        // push would show the same message twice to everyone still connected.
        if (!duplicate) fanOut(workgroupId, event, { exceptDeviceId: info.deviceId })
        return undefined
      } catch (error) {
        if (error instanceof HubError) return refuse(ws, error.code, error.message)
        throw error
      }
    },

    'group.continue'(ws, info, message) {
      const workgroupId = requireGroup(ws, info, message.workgroupId)
      if (workgroupId === undefined) return undefined
      try {
        const { event, duplicate } = events.append({
          workgroupId,
          eventId: message.eventId,
          type: 'group.continue',
          sender: { userId: info.userId, deviceId: info.deviceId, botEndpointId: message.botEndpointId },
          payload: message.payload,
        })
        send(ws, { type: 'ack.ok', workgroupId, eventId: event.eventId, seq: event.seq, duplicate })
        if (!duplicate) fanOut(workgroupId, event, { exceptDeviceId: info.deviceId })
        return undefined
      } catch (error) {
        if (error instanceof HubError) return refuse(ws, error.code, error.message)
        throw error
      }
    },

    'memory.change'(ws, info, message) {
      const workgroupId = requireGroup(ws, info, message.workgroupId)
      if (workgroupId === undefined) return undefined
      try {
        const { event, duplicate } = events.append({
          workgroupId,
          eventId: message.eventId,
          type: 'memory.change',
          sender: { userId: info.userId, deviceId: info.deviceId, botEndpointId: message.botEndpointId },
          payload: message.payload,
        })
        send(ws, { type: 'ack.ok', workgroupId, eventId: event.eventId, seq: event.seq, duplicate })
        if (!duplicate) fanOut(workgroupId, event, { exceptDeviceId: info.deviceId })
        return undefined
      } catch (error) {
        if (error instanceof HubError) return refuse(ws, error.code, error.message)
        throw error
      }
    },

    'event.ack'(ws, info, message) {
      const workgroupId = requireGroup(ws, info, message.workgroupId)
      if (workgroupId === undefined) return undefined
      const ids = Array.isArray(message.eventIds) ? message.eventIds.map(String)
        : typeof message.eventId === 'string' ? [message.eventId] : []
      if (ids.length === 0) return refuse(ws, 'frame/invalid', 'An ack needs eventId or eventIds.')
      let through = 0
      for (const eventId of ids) {
        try {
          const acked = events.ack({ eventId, deviceId: info.deviceId })
          through = Math.max(through, acked.seq)
        } catch (error) {
          // One unknown id must not discard the acks that came with it: the client's list is
          // authoritative about what it stored, and the Hub's own rows may have been swept.
          if (!(error instanceof HubError)) throw error
        }
      }
      return send(ws, { type: 'ack.ok', workgroupId, throughSeq: through, acked: ids.length })
    },

    'sync.request'(ws, info, message) {
      const workgroupId = requireGroup(ws, info, message.workgroupId)
      if (workgroupId === undefined) return undefined
      try {
        const afterSeq = Number(message.afterSeq ?? 0)
        const batch = events.pull({ workgroupId, afterSeq, limit: message.limit })
        // The device has now been handed these, and it will ack them. Recording the delivery here
        // is what makes a Hub restart between send and ack replay them rather than drop them.
        for (const event of batch.events) events.markDelivered({ eventId: event.eventId, deviceId: info.deviceId })
        return send(ws, { type: 'sync.batch', workgroupId, ...batch })
      } catch (error) {
        if (error instanceof HubError) return refuse(ws, error.code, error.message)
        throw error
      }
    },

    'read.updated'(ws, info, message) {
      const workgroupId = requireGroup(ws, info, message.workgroupId)
      if (workgroupId === undefined) return undefined
      try {
        const result = events.markRead({ workgroupId, userId: info.userId, seq: Number(message.seq ?? 0) })
        // A read cursor is per person, so it is echoed to that person's *other* devices only:
        // they should show the same unread count, and no one else should learn it.
        for (const [deviceId, sockets] of connections) {
          if (deviceId === info.deviceId) continue
          for (const other of sockets) {
            const otherInfo = state.get(other)
            if (otherInfo?.userId !== info.userId) continue
            send(other, { type: 'read.updated', workgroupId, lastReadSeq: result.lastReadSeq })
          }
        }
        return send(ws, { type: 'read.ok', workgroupId, lastReadSeq: result.lastReadSeq })
      } catch (error) {
        if (error instanceof HubError) return refuse(ws, error.code, error.message)
        throw error
      }
    },

    // ── tasks (plan §9.2, §9.3, §10) ─────────────────────────────────────────────
    // A task is REQUESTED over the socket and DECIDED over HTTP. That asymmetry is the plan's own
    // shape (§13.1 lists only `decision` and `revoke`), and it is the right one: a request has to
    // reach B while B is offline, which is exactly what G4's outbox + `deliveries` + cursor replay
    // already does, while a decision is a deliberate act by a person at a device.
    //
    // The signature is checked HERE because this is the only place that holds both the envelope and
    // the authenticated connection. Three separate facts are required, and each fails on its own:
    //   1. the envelope is signed by the device's own key (§9.2: not "a signature field exists");
    //   2. the signed sender IS the connection (§9.3: the Hub overwrites/validates the sender);
    //   3. the envelope is fresh and unreplayed (the timestamp window in tasks/envelope.js).
    'task.request'(ws, info, message) {
      const envelope = message.envelope ?? message
      const envelopeSender = envelope?.sender
      // The sender in a frame is a claim. A signature over somebody else's id proves the signer
      // wanted to be somebody else, which is precisely what must not work.
      if (envelopeSender?.userId !== info.userId || envelopeSender?.deviceId !== info.deviceId) {
        return refuse(ws, 'task/sender-mismatch', 'The sender in that request is not the connection that sent it.')
      }
      const device = devices.liveDeviceOf(info.userId, info.deviceId)
      if (device === undefined) return refuse(ws, 'task/no-device', 'This device is not registered any more.')
      if (typeof envelope.signature !== 'string' || envelope.signature === '') {
        return refuse(ws, 'task/unsigned', 'A task request must be signed by the sending device.')
      }
      if (tasks.verifyEnvelopeFor({ envelope, publicKeyPem: device.public_key }) !== true) {
        return refuse(ws, 'task/bad-signature', 'That request is not signed by this device, or something in it was changed.')
      }
      try {
        const result = tasks.request({ envelope, isMember: workgroups.isMember })
        // One answer, whatever happened. An outbox resend (the Hub already has this task) gets the
        // same frame with `duplicate: true`, which is how the plugin knows to clear the queue entry
        // without treating the retry as a second request.
        return send(ws, {
          type: 'task.ok',
          workgroupId: envelope.workgroupId,
          taskId: result.task.taskId,
          state: result.task.state,
          version: result.task.version,
          duplicate: result.duplicate === true,
        })
      } catch (error) {
        if (error instanceof HubError) return refuse(ws, error.code, error.message)
        throw error
      }
    },

    // The executing device reports its own task's next state. The owner only: the state is what the
    // requester reads, and letting the requester write it would make the timeline a claim.
    // A report's fields live under `payload`, because the plugin sends every non-chat frame through
    // one outbox whose shape is `{ type, workgroupId, eventId, payload }`. Reading them from the frame
    // top level as well keeps a hand-written frame working, and keeps the one shape the plugin writes
    // from being a special case here.
    'task.report'(ws, info, message) {
      const body = message.payload !== null && typeof message.payload === 'object' ? message.payload : message
      const taskId = String(body.taskId ?? '')
      if (taskId === '') return refuse(ws, 'frame/invalid', 'A task report needs a taskId.')
      try {
        const result = tasks.report({ userId: info.userId, deviceId: info.deviceId, taskId, next: String(body.next ?? ''), body })
        return send(ws, { type: 'task.reported', taskId: result.task.taskId, state: result.task.state, version: result.task.version })
      } catch (error) {
        if (error instanceof HubError) return refuse(ws, error.code, error.message)
        throw error
      }
    },

    'task.progress'(ws, info, message) {
      const body = message.payload !== null && typeof message.payload === 'object' ? message.payload : message
      const taskId = String(body.taskId ?? '')
      if (taskId === '') return refuse(ws, 'frame/invalid', 'A progress report needs a taskId.')
      try {
        tasks.progress({ userId: info.userId, deviceId: info.deviceId, taskId, body })
        return undefined
      } catch (error) {
        if (error instanceof HubError) return refuse(ws, error.code, error.message)
        throw error
      }
    },

    // ── the coordinator lease (plan §9.5) ──────────────────────────────────────────────
    // Over the socket because a round commits while it runs, and a round that had to open an HTTP
    // connection to be fenced would be fenced late.
    'lease.acquire'(ws, info, message) {
      const workgroupId = requireGroup(ws, info, message.workgroupId)
      if (workgroupId === undefined) return undefined
      try {
        const result = leases.acquire({
          userId: info.userId, deviceId: info.deviceId, workgroupId,
          leaseMs: message.leaseMs === undefined ? undefined : Number(message.leaseMs),
        })
        return send(ws, { type: 'lease.ok', ...result })
      } catch (error) {
        if (error instanceof HubError) return refuse(ws, error.code, error.message)
        throw error
      }
    },

    'lease.release'(ws, info, message) {
      const workgroupId = requireGroup(ws, info, message.workgroupId)
      if (workgroupId === undefined) return undefined
      try {
        const result = leases.release({ userId: info.userId, deviceId: info.deviceId, workgroupId })
        return send(ws, { type: 'lease.released', ...result })
      } catch (error) {
        if (error instanceof HubError) return refuse(ws, error.code, error.message)
        throw error
      }
    },

    // A round asks "may I still commit?" before it commits. The answer is the fence.
    'lease.check'(ws, info, message) {
      const workgroupId = requireGroup(ws, info, message.workgroupId)
      if (workgroupId === undefined) return undefined
      const result = leases.checkFence({
        userId: info.userId, deviceId: info.deviceId, workgroupId,
        epoch: message.epoch === undefined ? undefined : Number(message.epoch),
      })
      if (result.ok !== true) return refuse(ws, result.code, result.detail)
      return send(ws, { type: 'lease.ok', ...result })
    },

    heartbeat(ws) {
      return send(ws, { type: 'heartbeat', at: new Date(now()).toISOString() })
    },
  }

  // Completes a handshake for a token: session → device → clock → nonce → signature, in that
  // order, then the greeting. Returns true when the socket is now authenticated.
  const authenticate = (ws, params, accessToken) => {
    const deviceId = params.get('deviceId') ?? ''
    const timestamp = params.get('ts') ?? ''
    const nonce = params.get('nonce') ?? ''
    const signature = params.get('sig') ?? ''

    let session
    try {
      session = auth.sessionOf(accessToken)
    } catch {
      ws.close(CLOSE_BAD_AUTH, 'unauthenticated')
      return false
    }

    // Order matters: the device must belong to this session's user before its signature is
    // worth checking, and the timestamp before the nonce so a stale handshake cannot fill
    // the nonce table.
    const device = devices.liveDeviceOf(session.user_id, deviceId)
    if (device === undefined) {
      ws.close(CLOSE_BAD_AUTH, 'unknown device')
      return false
    }
    const sentAt = Number(timestamp)
    if (!Number.isFinite(sentAt) || Math.abs(now() - sentAt) > MAX_SKEW_MS) {
      ws.close(CLOSE_STALE, 'stale handshake')
      return false
    }
    if (!remember(nonce, now())) {
      ws.close(CLOSE_STALE, 'replayed nonce')
      return false
    }
    if (!verifyHandshake(device.public_key, deviceId, timestamp, nonce, signature)) {
      ws.close(CLOSE_BAD_AUTH, 'bad signature')
      return false
    }

    attach(deviceId, ws)
    devices.touchDevice(deviceId)
    // The socket's identity is fixed at handshake time and read from the database, never from a
    // frame. `groupIds` starts undefined, meaning "all groups I am in".
    state.set(ws, { userId: session.user_id, deviceId, groupIds: undefined })
    clearTimeout(pendingAuth(ws))

    logger.info('ws.connected', { deviceId, userId: session.user_id })
    send(ws, {
      v: 1,
      type: 'hello',
      deviceId,
      userId: session.user_id,
      workgroups: workgroups.groupIdsOf(session.user_id),
    })
    return true
  }

  // The greeting timer for a socket that arrived without an Authorization header.
  const pendingTimers = new WeakMap()
  const pendingAuth = ws => pendingTimers.get(ws)
  const armAuthTimeout = (ws) => {
    const timer = setTimeout(() => {
      if (state.get(ws) === undefined) ws.close(CLOSE_BAD_AUTH, 'handshake timed out')
    }, AUTH_WINDOW_MS)
    timer.unref?.()
    pendingTimers.set(ws, timer)
  }

  wss.on('connection', (ws, req) => {
    const params = new URL(req.url ?? '/', 'wss://hub.invalid').searchParams

    // The bearer token arrives either as an `Authorization` header (any client that can set
    // headers) or as the first frame, `{type:'auth', accessToken}`. The second form exists
    // because a browser `WebSocket` cannot set headers, and the plugin must not depend on a
    // Node-specific socket library to talk to its own Hub — a dependency it does not otherwise
    // have. Both paths run the identical checks below; only the token's route differs.
    const headerToken = bearerToken(req.headers.authorization)
    // The two styles are distinguishable, and the distinction is the client's to declare:
    //   * `Authorization: Bearer …` — a client that can set headers;
    //   * `?auth=frame` — a client that cannot (a browser `WebSocket`), which then must send
    //     `{type:'auth', accessToken}` as its first frame.
    // A handshake with neither is a client bug and is refused at once, so a wrong token never
    // leaves a socket open waiting for a frame that will not come.
    const wantsFrameAuth = params.get('auth') === 'frame'
    if (headerToken !== undefined) {
      authenticate(ws, params, headerToken)
    } else if (wantsFrameAuth) {
      armAuthTimeout(ws)
    } else {
      ws.close(CLOSE_BAD_AUTH, 'unauthenticated')
    }

    // Heartbeat: a connection whose peer stopped answering is closed rather than kept
    // forever, so a revoke is not the only thing that ever removes an entry.
    let alive = true
    ws.on('pong', () => { alive = true })
    const heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); return }
      alive = false
      ws.ping()
    }, HEARTBEAT_MS)

    ws.on('message', (data) => {
      const info = state.get(ws)
      if (info === undefined) {
        // Only one frame is legal before the handshake completes: the auth frame.
        let frame
        try { frame = JSON.parse(String(data)) } catch { frame = undefined }
        if (frame?.type === 'auth' && typeof frame.accessToken === 'string') {
          authenticate(ws, params, frame.accessToken)
          return
        }
        ws.close(CLOSE_BAD_AUTH, 'unauthenticated')
        return
      }
      let message
      try {
        message = JSON.parse(String(data))
      } catch {
        refuse(ws, 'frame/not-json', 'A frame must be JSON.')
        return
      }
      if (message === null || typeof message !== 'object' || typeof message.type !== 'string') {
        refuse(ws, 'frame/invalid', 'A frame needs a "type".')
        return
      }
      const handler = handlers[message.type]
      if (handler === undefined) {
        // An unknown type is answered rather than dropped: silence would be indistinguishable
        // from a delivery failure to the client.
        refuse(ws, 'frame/unsupported', `"${message.type}" is not part of the v1 protocol.`)
        return
      }
      try {
        handler(ws, info, message)
      } catch (error) {
        logger.error('ws.frame-failed', { type: message.type, error })
        refuse(ws, 'hub/internal', 'The Hub failed to handle that frame.')
      }
    })

    ws.on('close', () => {
      clearInterval(heartbeat)
      clearTimeout(pendingAuth(ws))
      // A socket that never authenticated has no device to detach; it also never joined
      // `connections`, so there is nothing to remove.
      const closed = state.get(ws)
      if (closed !== undefined) {
        detach(closed.deviceId, ws)
        logger.info('ws.disconnected', { deviceId: closed.deviceId })
      }
    })
  })

  return {
    wss,
    connections,

    // Called when a device is revoked. Closing with a code the client can act on lets the
    // plugin say "this device was signed out" instead of "connection lost".
    closeDevice(deviceId) {
      const set = connections.get(deviceId)
      if (set === undefined) return 0
      let closed = 0
      for (const ws of [...set]) {
        ws.close(CLOSE_REVOKED, 'device revoked')
        closed += 1
      }
      connections.delete(deviceId)
      return closed
    },

    // A membership changed. This is a notification, not a group event: it takes no `seq`, is not
    // written to the log, and carries no message. It exists so a machine that is already connected
    // re-reads the roster at once instead of at its next reconnect.
    notifyMembership(payload) {
      const { workgroupId } = payload
      if (workgroupId === undefined) return 0
      const memberIds = new Set(workgroups.memberUserIds(workgroupId))
      let told = 0
      for (const sockets of connections.values()) {
        for (const ws of sockets) {
          const info = state.get(ws)
          // The person who just joined is included: their own other devices should learn it too.
          if (info === undefined || !memberIds.has(info.userId)) continue
          if (info.groupIds !== undefined && !info.groupIds.has(workgroupId)) continue
          send(ws, { type: 'member.changed', workgroupId, ...payload })
          told += 1
        }
      }
      return told
    },

    // Used by the HTTP attachment route: an attachment message must reach the group's sockets the
    // same way a typed one does, so the fan-out lives here and the route calls it.
    broadcast(workgroupId, event, options) {
      return fanOut(workgroupId, event, options)
    },

    // Which of these users currently hold a socket. Membership rows carry no presence column on
    // purpose: presence is a property of connections, and copying it into the database would need a
    // writer for every connect and disconnect to stay true.
    onlineUsers(userIds) {
      const wanted = new Set(userIds ?? [])
      const online = new Set()
      for (const sockets of connections.values()) {
        for (const ws of sockets) {
          const info = state.get(ws)
          if (info !== undefined && wanted.has(info.userId)) online.add(info.userId)
        }
      }
      return online
    },

    // How many live sockets a user has. A test asserts a disconnect really removed them.
    socketCount(userId) {
      let count = 0
      for (const sockets of connections.values()) {
        for (const ws of sockets) if (state.get(ws)?.userId === userId) count += 1
      }
      return count
    },

    close() {
      return new Promise((resolve) => {
        for (const set of connections.values()) for (const ws of set) ws.terminate()
        connections.clear()
        wss.close(() => resolve())
      })
    },
  }
}
