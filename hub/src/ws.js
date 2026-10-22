// The WSS endpoint. G3 needs exactly one behaviour from it: a revoked device stops being
// connected, at once. Everything G4 will do with this socket (event fan-out, cursors,
// delivery acks) is deliberately absent.
//
// The handshake carries proof, not just a bearer token: the client signs
//   `<deviceId>.<timestamp>.<nonce>`
// with its Ed25519 private key. The signature is bound to one device for a narrow window and
// cannot be replayed, so a stolen access token alone cannot open a socket as a device whose
// key it does not hold.
import { verify as verifySignature } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { bearerToken } from './auth/tokens.js'

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

export function createWsService({ server, auth, devices, logger, now = () => Date.now() }) {
  const wss = new WebSocketServer({ server, path: '/v1/ws' })
  // deviceId → Set<WebSocket>: one device may hold several connections (two windows), and a
  // revoke must close all of them.
  const connections = new Map()
  // Nonces seen inside the accept window, with the time they expire.
  const seenNonces = new Map()

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

  wss.on('connection', (ws, req) => {
    const params = new URL(req.url ?? '/', 'wss://hub.invalid').searchParams
    const deviceId = params.get('deviceId') ?? ''
    const timestamp = params.get('ts') ?? ''
    const nonce = params.get('nonce') ?? ''
    const signature = params.get('sig') ?? ''

    let session
    try {
      session = auth.sessionOf(bearerToken(req.headers.authorization))
    } catch {
      ws.close(CLOSE_BAD_AUTH, 'unauthenticated')
      return
    }

    // Order matters: the device must belong to this session's user before its signature is
    // worth checking, and the timestamp before the nonce so a stale handshake cannot fill
    // the nonce table.
    const device = devices.liveDeviceOf(session.user_id, deviceId)
    if (device === undefined) {
      ws.close(CLOSE_BAD_AUTH, 'unknown device')
      return
    }
    const sentAt = Number(timestamp)
    if (!Number.isFinite(sentAt) || Math.abs(now() - sentAt) > MAX_SKEW_MS) {
      ws.close(CLOSE_STALE, 'stale handshake')
      return
    }
    if (!remember(nonce, now())) {
      ws.close(CLOSE_STALE, 'replayed nonce')
      return
    }
    if (!verifyHandshake(device.public_key, deviceId, timestamp, nonce, signature)) {
      ws.close(CLOSE_BAD_AUTH, 'bad signature')
      return
    }

    attach(deviceId, ws)
    devices.touchDevice(deviceId)
    logger.info('ws.connected', { deviceId, userId: session.user_id })
    ws.send(JSON.stringify({ v: 1, type: 'hello', deviceId, userId: session.user_id }))

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
      // G3 has no message semantics. Saying so is better than silently dropping the frame,
      // which a G4 client would read as a delivery failure.
      let type
      try { type = JSON.parse(String(data))?.type } catch { type = undefined }
      ws.send(JSON.stringify({ v: 1, type: 'error', code: 'unsupported', detail: `message type "${type ?? 'unknown'}" is not part of the G3 protocol` }))
    })

    ws.on('close', () => {
      clearInterval(heartbeat)
      detach(deviceId, ws)
      logger.info('ws.disconnected', { deviceId })
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

    close() {
      return new Promise((resolve) => {
        for (const set of connections.values()) for (const ws of set) ws.terminate()
        connections.clear()
        wss.close(() => resolve())
      })
    },
  }
}
