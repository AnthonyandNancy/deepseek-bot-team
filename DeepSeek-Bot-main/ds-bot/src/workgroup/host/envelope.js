// The task envelope, on the plugin side (plan §9.2).
//
// This is a deliberate COPY of `hub/src/tasks/envelope.js`'s canonicalisation, not a shared import:
// the plugin and the Hub are separate packages with separate dependency trees, and the plugin must
// not reach into the Hub's source to sign its own requests. `test/workgroup-task-envelope.test.js`
// compares the two implementations byte for byte over a table of shapes, so a change on one side
// that the other does not follow fails there rather than as an unexplained "bad signature" on a
// machine in front of a person.
//
// What the Hub checks, and therefore what this must produce exactly:
//   * canonical JSON — keys sorted, `undefined` dropped, numbers in JSON form;
//   * the signed document covers v, eventId, type, workgroupId, taskId, sender, target, createdAt,
//     expiresAt and the payload HASH (not the payload);
//   * the signature is Ed25519 over those bytes, base64.
import { createHash } from 'node:crypto'

export const PROTOCOL_VERSION = 1

// The same window the Hub enforces. Duplicated so a client can refuse to send a request it knows
// will be stale rather than discovering it from an error frame.
export const MAX_ENVELOPE_SKEW_MS = 5 * 60 * 1000
export const MAX_ENVELOPE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('ds-bot: a canonical envelope cannot hold a non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  throw new Error(`ds-bot: a canonical envelope cannot hold a ${typeof value}`)
}

export const payloadHash = payload => createHash('sha256').update(canonicalJson(payload ?? {}), 'utf8').digest('hex')

export function signedFields(envelope) {
  return {
    v: envelope.v ?? PROTOCOL_VERSION,
    eventId: envelope.eventId,
    type: envelope.type,
    workgroupId: envelope.workgroupId,
    taskId: envelope.taskId,
    sender: {
      userId: envelope.sender?.userId,
      deviceId: envelope.sender?.deviceId,
      botEndpointId: envelope.sender?.botEndpointId,
    },
    target: {
      userId: envelope.target?.userId,
      botEndpointId: envelope.target?.botEndpointId,
    },
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
    // Computed from the payload as it is NOW, never read from the envelope's own field. Using the
    // declared hash would make the signature cover a claim rather than the content: an attacker could
    // sign `{title:'harmless'}`, then swap `payload` and leave the signed hash alone, and the
    // signature would still verify. The declared field is kept only so a client can state what it
    // meant, and `checkEnvelope` refuses an envelope whose two disagree.
    payloadHash: payloadHash(envelope.payload),
  }
}

export const signingBytes = envelope => Buffer.from(canonicalJson(signedFields(envelope)), 'utf8')

// Builds a complete `task.request` envelope, signing it with the device's own key.
//
// `signBytes` is a closure the Hub client hands out (`wg.hub.taskSigner()`), so this module never
// sees the private key: the same rule the socket handshake follows (docs/g3/PLAN.md §8.3).
export function buildTaskRequest({ taskId, workgroupId, sender, target, payload, signBytes, now = Date.now(), ttlMs = 24 * 60 * 60 * 1000 }) {
  const at = now
  const envelope = {
    v: PROTOCOL_VERSION,
    eventId: `evt_${taskId}`,
    type: 'task.request',
    workgroupId,
    taskId,
    sender: { userId: sender.userId, deviceId: sender.deviceId, ...(sender.botEndpointId === undefined ? {} : { botEndpointId: sender.botEndpointId }) },
    target: { userId: target.userId, ...(target.botEndpointId === undefined ? {} : { botEndpointId: target.botEndpointId }) },
    createdAt: new Date(at).toISOString(),
    expiresAt: new Date(at + Math.min(ttlMs, MAX_ENVELOPE_LIFETIME_MS)).toISOString(),
    payload: payload ?? {},
  }
  envelope.payloadHash = payloadHash(envelope.payload)
  envelope.signature = signBytes(signingBytes(envelope))
  return envelope
}
