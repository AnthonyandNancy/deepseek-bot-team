// The event envelope from plan §9.2, and the signature that makes it worth anything.
//
// The handshake signature proves "this device holds the private key" — it covers `deviceId.ts.nonce`
// and NOTHING about a task. So a `task.request` needs its own signature over the request, or the
// only thing the Hub would know is that some authenticated device sent some payload.
//
// §9.2 is explicit about what must be covered: "规范化序列化的关键字段、payload hash、目标、有效期、
// 协议版本", and that "签名、挑战/nonce、防重放窗口和签名失败策略须经 contract tests 证明，不可仅检查
// `signature` 字符串存在". So:
//
//   * the signed bytes are a canonical JSON document — keys sorted, no insignificant whitespace,
//     `undefined` omitted, numbers in their JSON form — so two implementations (this one and the
//     plugin's) produce byte-identical input for the same request;
//   * `payloadHash` is folded in, so changing one character of the payload invalidates the
//     signature without needing to canonicalise the payload itself;
//   * `target`, `expiresAt` and `v` are folded in, so neither the recipient nor the lifetime can be
//     edited by a relay;
//   * the *sender* is folded in too, and the Hub separately insists it equals the authenticated
//     connection — a signature over somebody else's id is not enough to be that somebody.
//
// The plugin has a copy of `canonicalJson` (ds-bot/src/workgroup/host/envelope.js) because the two
// are separate packages with separate dependency trees. A contract test in ds-bot compares the two
// implementations byte for byte, so they cannot drift.
import { createHash, verify as verifySignature } from 'node:crypto'

// How old an envelope may be, and how long a task request may live at most. The window is the
// anti-replay budget: outside it a re-sent envelope is refused on its own timestamps, before any
// table is consulted.
export const MAX_ENVELOPE_SKEW_MS = 5 * 60 * 1000
export const MAX_ENVELOPE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

export const PROTOCOL_VERSION = 1

// Deterministic JSON. Anything that cannot be represented (a function, `undefined`, a BigInt) is a
// caller bug, not something to silently encode differently on the two sides.
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('ds-hub: a canonical envelope cannot hold a non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  throw new Error(`ds-hub: a canonical envelope cannot hold a ${typeof value}`)
}

// The hash of a payload, exactly as the plan asks for it: the signature covers this, not the payload.
export const payloadHash = payload => createHash('sha256').update(canonicalJson(payload ?? {}), 'utf8').digest('hex')

// The fields a signature covers. Named as a function so the plugin signs the same list rather than a
// second, nearly-identical one.
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

// The exact bytes that are signed and verified.
export const signingBytes = envelope => Buffer.from(canonicalJson(signedFields(envelope)), 'utf8')

// One place that answers "is this signature valid for this envelope", exported so a test signs with
// the same function the Hub verifies instead of asserting against a second implementation.
export function verifyEnvelope(publicKeyPem, envelope, signatureB64) {
  try {
    return verifySignature(null, signingBytes(envelope), publicKeyPem, Buffer.from(String(signatureB64), 'base64'))
  } catch {
    return false
  }
}

// Everything about an envelope that is true regardless of who signed it. Returns the reason as a
// code so the caller can say which rule refused it — "signature invalid" and "expired" are very
// different problems for the person looking at the screen.
export function checkEnvelope({ envelope, now }) {
  if (envelope === null || typeof envelope !== 'object') return { ok: false, code: 'task/invalid-envelope', detail: 'A task request needs an envelope.' }
  if ((envelope.v ?? PROTOCOL_VERSION) !== PROTOCOL_VERSION) {
    return { ok: false, code: 'task/unsupported-version', detail: `This Hub speaks envelope version ${PROTOCOL_VERSION}.` }
  }
  if (envelope.type !== 'task.request') return { ok: false, code: 'task/invalid-envelope', detail: `"${String(envelope.type)}" is not a task request.` }
  for (const field of ['eventId', 'workgroupId', 'taskId']) {
    if (typeof envelope[field] !== 'string' || envelope[field] === '') {
      return { ok: false, code: 'task/invalid-envelope', detail: `A task request needs a ${field}.` }
    }
  }
  if (typeof envelope.sender?.userId !== 'string' || typeof envelope.sender?.deviceId !== 'string') {
    return { ok: false, code: 'task/invalid-envelope', detail: 'A task request needs a sender userId and deviceId.' }
  }
  if (typeof envelope.target?.userId !== 'string') {
    return { ok: false, code: 'task/invalid-envelope', detail: 'A task request needs a target userId.' }
  }
  const created = Date.parse(String(envelope.createdAt ?? ''))
  const expires = Date.parse(String(envelope.expiresAt ?? ''))
  if (!Number.isFinite(created) || !Number.isFinite(expires)) {
    return { ok: false, code: 'task/invalid-envelope', detail: 'A task request needs a createdAt and an expiresAt.' }
  }
  if (created - now > MAX_ENVELOPE_SKEW_MS) {
    return { ok: false, code: 'task/envelope-from-future', detail: 'That request is dated in the future.' }
  }
  if (now - created > MAX_ENVELOPE_SKEW_MS) {
    // The replay window, stated as what it is: an envelope this old is refused on its own timestamp,
    // so a captured request cannot be re-sent next week even with an unused id.
    return { ok: false, code: 'task/envelope-stale', detail: 'That request is too old to accept; ask again.' }
  }
  if (expires <= now) return { ok: false, code: 'task/envelope-expired', detail: 'That request has already expired.' }
  if (expires - created > MAX_ENVELOPE_LIFETIME_MS) {
    return { ok: false, code: 'task/invalid-envelope', detail: 'A task request may not live longer than a week.' }
  }
  if (envelope.payloadHash !== undefined && envelope.payloadHash !== payloadHash(envelope.payload)) {
    return { ok: false, code: 'task/payload-hash-mismatch', detail: 'The payload does not match the hash that was signed.' }
  }
  return { ok: true }
}
