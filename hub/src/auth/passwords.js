// Passwords: scrypt, one PHC-style string per user, no reversible form anywhere.
//
// `maxmem` is passed explicitly and is not optional. Node's default limit rejects N=32768
// outright (`ERR_CRYPTO_INVALID_SCRYPT_PARAMS`), which would make the first registration
// throw instead of the password being stored — measured, not assumed.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
export const KEY_BYTES = 32
export const SALT_BYTES = 16
export const VERSION = 1

export const MIN_LENGTH = 10
export const MAX_BYTES = 128

const b64 = buffer => buffer.toString('base64url')
const unb64 = text => Buffer.from(text, 'base64url')

// PHC-style: `$scrypt$N=32768,r=8,p=1$<salt>$<key>`. The parameters travel with the hash,
// so a later parameter change can verify old passwords and upgrade them on next login
// without a migration.
export function hashPassword(password, params = PARAMS) {
  const salt = randomBytes(SALT_BYTES)
  const key = scryptSync(password, salt, KEY_BYTES, params)
  return `$scrypt$N=${params.N},r=${params.r},p=${params.p}$${b64(salt)}$${b64(key)}`
}

function parsePhc(phc) {
  const parts = String(phc ?? '').split('$')
  // ['', 'scrypt', 'N=..,r=..,p=..', salt, key]
  if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'scrypt') return undefined
  const params = {}
  for (const pair of parts[2].split(',')) {
    const [name, value] = pair.split('=')
    const number = Number(value)
    if (!Number.isInteger(number) || number <= 0) return undefined
    params[name] = number
  }
  if (params.N === undefined || params.r === undefined || params.p === undefined) return undefined
  return { params, salt: unb64(parts[3]), key: unb64(parts[4]) }
}

// Constant-time in the only sense that matters here: equal-length compare via
// timingSafeEqual, and a length mismatch still spends the time of a real comparison so the
// response cannot be classified by duration.
export function verifyPassword(password, phc) {
  const parsed = parsePhc(phc)
  if (parsed === undefined) return false
  const candidate = scryptSync(password, parsed.salt, parsed.key.length, { ...parsed.params, maxmem: PARAMS.maxmem })
  if (candidate.length !== parsed.key.length) return false
  return timingSafeEqual(candidate, parsed.key)
}

// A hash of a fixed password, used when no user matches. Without it, "no such phone" would
// return before spending the scrypt time that "wrong password" spends — a free account
// oracle. Computed once at import so it costs nothing per request.
const DUMMY_PHC = hashPassword('workgroup-ai-hub dummy password')

// Runs the same work a real verification does, and always fails.
export const spendPasswordWork = (password) => verifyPassword(password, DUMMY_PHC)

// Policy: long beats complicated. A composition rule ("one digit, one symbol") pushes people
// toward `Password1!`, which is shorter and more guessable than a long phrase, so the only
// requirements are length and not being the phone number.
export function checkPassword(password, phone) {
  if (typeof password !== 'string') return 'auth/weak-password'
  if (password.length < MIN_LENGTH) return 'auth/weak-password'
  if (Buffer.byteLength(password, 'utf8') > MAX_BYTES) return 'auth/weak-password'
  if (phone !== undefined && password.replace(/[^\d]/g, '') === String(phone).replace(/[^\d]/g, '')) return 'auth/weak-password'
  return undefined
}

export const passwordPolicy = {
  minLength: MIN_LENGTH,
  maxBytes: MAX_BYTES,
  message: `A password must be at least ${MIN_LENGTH} characters and not just the phone number.`,
}
