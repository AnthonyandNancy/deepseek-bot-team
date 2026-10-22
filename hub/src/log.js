// Access log. Two rules, both enforced here rather than trusted to callers:
//
//   1. Request bodies are never logged. Login and registration carry the password and the
//      phone number, and a body is also the one field that can hold any future secret.
//   2. Values are redacted by field name, not by guessing at shapes. A regex that tries to
//      recognise a token also has to be right about a password; a key list only has to be
//      right about the keys the Hub itself writes.
//
// Phone numbers are the exception to "never log": a masked form is logged so an operator
// can follow one account, because the full value is what makes the log a liability.
import { maskPhone } from './phone.js'

// Any key whose value must not reach a log, whatever it holds.
const SECRET_KEYS = new Set([
  'password', 'newPassword', 'confirmPassword', 'passwordPhc', 'passwordHash', 'password_hash',
  'token', 'accessToken', 'refreshToken', 'access_token', 'refresh_token', 'accessHash', 'refreshHash',
  'authorization', 'cookie', 'set-cookie',
  'privateKey', 'private_key', 'publicKeyPem', 'signature', 'nonce', 'challengeNonce',
])

// A phone under any of the names the Hub or its callers might use.
const PHONE_KEYS = new Set(['phone', 'phoneE164', 'phone_e164', 'phoneNumber'])

export const REDACTED = '[redacted]'

// One value, by the key it arrived under. Unknown keys pass through: `code`, `status`,
// `durationMs` and the rest are what make the log useful.
export function redactValue(key, value) {
  const lower = String(key).toLowerCase()
  if (SECRET_KEYS.has(key) || SECRET_KEYS.has(lower)) return REDACTED
  if (PHONE_KEYS.has(key) || PHONE_KEYS.has(lower)) return typeof value === 'string' ? maskPhone(value) : REDACTED
  if (value instanceof Error) return { name: value.name, code: value.code, message: redactText(value.message) }
  if (Array.isArray(value)) return value.map(item => redactValue(key, item))
  if (value !== null && typeof value === 'object') return redactFields(value)
  return value
}

export function redactFields(fields) {
  const out = {}
  for (const [key, value] of Object.entries(fields ?? {})) out[key] = redactValue(key, value)
  return out
}

// Free text — an error message, a close reason — can carry a phone or a token that was
// quoted into it. This catches the two shapes that actually occur: an E.164 number and a
// `dsb_`-prefixed token (the only tokens this Hub mints).
export function redactText(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/\+\d{8,15}\b/g, match => maskPhone(match))
    .replace(/\bdsb_(?:at|rt)_[A-Za-z0-9_-]{8,}/g, REDACTED)
}

export function createLogger({ stream = process.stdout, now = () => new Date().toISOString() } = {}) {
  const write = (level, event, fields) => {
    const line = JSON.stringify({ at: now(), level, event, ...redactFields(fields) })
    stream.write(`${line}\n`)
  }
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  }
}

// A logger that keeps lines in an array. Tests assert on what a real run would have
// written, without parsing stdout or depending on where it was redirected.
export function createMemoryLogger() {
  const lines = []
  const stream = { write: (text) => { lines.push(text); return true } }
  return { lines, logger: createLogger({ stream }) }
}
