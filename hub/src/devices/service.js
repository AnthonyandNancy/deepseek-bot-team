// Devices: a key pair per machine, the Hub keeping only the public half.
//
// The flow proves possession without ever transmitting the private key:
//   1. `challenge` — the client sends its public key and gets a nonce back.
//   2. `register`  — the client signs `challengeId.nonce` and sends the signature.
// The Hub verifies the signature against the key in the same request, so a registration
// cannot claim a key it holds no private half of.
//
// A revoked device cannot come back with the same key: re-registering it is refused, and it
// must generate a new pair. That is what makes revocation mean something for a key that may
// already have leaked.
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { forbidden, notFound, unauthorized, badRequest } from '../errors.js'
import { ACTIONS } from '../audit.js'
import { deviceId as newDeviceId, hashToken } from '../auth/tokens.js'

export const CHALLENGE_TTL_MS = 5 * 60 * 1000

const signedPayload = (challengeId, nonce) => Buffer.from(`${challengeId}.${nonce}`)

// Whether a text is a usable Ed25519 SPKI public key. Anything else is refused before it
// reaches the verify call, so a malformed key cannot turn into an unhandled throw.
export function isEd25519PublicKey(pem) {
  try {
    const key = createPublicKey(pem)
    return key.asymmetricKeyType === 'ed25519'
  } catch {
    return false
  }
}

export function verifyDeviceSignature(publicKeyPem, challengeId, nonce, signatureB64) {
  try {
    return verifySignature(null, signedPayload(challengeId, nonce), publicKeyPem, Buffer.from(String(signatureB64), 'base64'))
  } catch {
    return false
  }
}

export function createDeviceService({ db, audit, auth, now = () => Date.now(), onRevoked = () => {} }) {
  const iso = () => new Date(now()).toISOString()

  // Challenges live in memory: a challenge is worthless after a restart, and a client that
  // loses one simply asks for another. Persisting them would mean writing to the database
  // on an unauthenticated endpoint.
  const challenges = new Map()

  const byId = db.prepare('SELECT * FROM devices WHERE id = ?')
  const byKey = db.prepare('SELECT * FROM devices WHERE user_id = ? AND public_key = ?')
  const devicesOf = db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at ASC')
  const insert = db.prepare(`INSERT INTO devices (id, user_id, public_key, name, platform, created_at, last_seen_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`)
  const markRevoked = db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?')
  const touch = db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
  const bindSession = db.prepare('UPDATE auth_sessions SET device_id = ? WHERE access_hash = ?')

  const pruneChallenges = () => {
    const at = now()
    for (const [id, entry] of challenges) if (entry.expiresAt <= at) challenges.delete(id)
  }

  const publicDevice = (device, currentDeviceId) => ({
    deviceId: device.id,
    name: device.name,
    platform: device.platform,
    createdAt: device.created_at,
    lastSeenAt: device.last_seen_at,
    revokedAt: device.revoked_at,
    current: device.id === currentDeviceId,
  })

  return {
    // ── POST /v1/devices/challenge ────────────────────────────────────────────────────
    async challenge({ accessToken, publicKey }) {
      const session = auth.sessionOf(accessToken)
      if (!isEd25519PublicKey(publicKey)) throw badRequest('device/invalid-key', 'A device key must be an Ed25519 public key in SPKI PEM form.')

      const existing = byKey.get(session.user_id, publicKey)
      if (existing?.revoked_at != null) throw forbidden('device/key-revoked', 'This device key was revoked. Generate a new key pair.')

      pruneChallenges()
      const id = `chl_${Math.random().toString(36).slice(2)}${now().toString(36)}`
      const nonce = `${now().toString(36)}.${Math.random().toString(36).slice(2)}`
      challenges.set(id, { userId: session.user_id, publicKey, nonce, expiresAt: now() + CHALLENGE_TTL_MS })
      return { challengeId: id, nonce, expiresAt: new Date(now() + CHALLENGE_TTL_MS).toISOString() }
    },

    // ── POST /v1/devices/register ─────────────────────────────────────────────────────
    async register({ accessToken, challengeId, signature, name, platform }) {
      const session = auth.sessionOf(accessToken)
      const challenge = challenges.get(challengeId)
      // A challenge is single-use: deleted before the signature is even checked, so a
      // captured signature cannot be replayed.
      if (challenge !== undefined) challenges.delete(challengeId)
      if (challenge === undefined || challenge.expiresAt <= now() || challenge.userId !== session.user_id) {
        throw unauthorized('device/challenge-invalid', 'That device challenge is missing, expired, or was already used.')
      }
      if (!verifyDeviceSignature(challenge.publicKey, challengeId, challenge.nonce, signature)) {
        throw forbidden('device/bad-signature', 'The device signature did not verify.')
      }

      const label = typeof name === 'string' && name.trim().length > 0 ? name.trim().slice(0, 80) : 'This device'
      const existing = byKey.get(session.user_id, challenge.publicKey)
      if (existing?.revoked_at != null) throw forbidden('device/key-revoked', 'This device key was revoked. Generate a new key pair.')

      // Re-registering a known key is idempotent: the same machine coming back must not
      // accumulate device rows, and a reinstall keeps its identity.
      const id = existing?.id ?? newDeviceId()
      if (existing === undefined) insert.run(id, session.user_id, challenge.publicKey, label, platform ?? null, iso())
      // Binding the session to its device is what later lets a revoke disconnect *these*
      // connections rather than all of the user's.
      // The column holds the token's digest, not the token: binding by the raw value would
      // silently match no row and leave the session unattached to any device.
      bindSession.run(id, hashToken(accessToken))

      audit.record({ actorId: session.user_id, deviceId: id, action: ACTIONS.deviceRegistered, result: 'ok' })
      return { deviceId: id, name: label, platform: platform ?? null, createdAt: existing?.created_at ?? iso() }
    },

    // ── GET /v1/devices ──────────────────────────────────────────────────────────────
    async list({ accessToken }) {
      const session = auth.sessionOf(accessToken)
      return { devices: devicesOf.all(session.user_id).map(device => publicDevice(device, session.device_id)) }
    },

    // ── POST /v1/devices/:id/revoke ──────────────────────────────────────────────────
    async revoke({ accessToken, deviceId }) {
      const session = auth.sessionOf(accessToken)
      const device = byId.get(deviceId)
      // A device belonging to someone else is reported as missing rather than as forbidden:
      // "forbidden" would confirm that the id exists.
      if (device === undefined || device.user_id !== session.user_id) throw notFound('device/not-found', 'No such device.')

      if (device.revoked_at === null) {
        markRevoked.run(iso(), device.id)
        audit.record({ actorId: session.user_id, deviceId: device.id, action: ACTIONS.deviceRevoked, result: 'ok' })
        // Sessions bound to this device end with it: a revoked device must not keep a
        // working refresh token. The WSS connections are closed by the caller's hook.
        db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(iso(), device.id)
      }
      onRevoked(device.id)
      return { deviceId: device.id, revokedAt: device.revoked_at ?? iso() }
    },

    // Used by the WSS handshake: is this device this user's, and is it still live?
    liveDeviceOf(userId, deviceId) {
      const device = byId.get(deviceId)
      if (device === undefined || device.user_id !== userId || device.revoked_at !== null) return undefined
      return device
    },

    touchDevice(deviceId) {
      touch.run(iso(), deviceId)
    },

    challenges,
  }
}
