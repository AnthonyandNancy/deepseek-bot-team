// Recovery codes: the only way back into an account when there is no SMS and no email.
//
// The design constraint that shapes everything here: a recovery code is a *permanent* credential
// that a person may write on paper and keep for years. So:
//
//   * it is shown exactly once, at generation, and never again — the Hub cannot re-display it
//     because it stores only a digest;
//   * it is hashed with scrypt, like a password, not with the fast digest used for session
//     tokens: a leaked `recovery_codes` table would otherwise be a list of working codes;
//   * it is single-use, and a successful use spends it in the same transaction that changes the
//     password;
//   * using one ends every session and revokes every device, because a recovery is exactly the
//     situation where the old holders must be evicted.
//
// Format: 4 groups of 4 characters, `XXXX-XXXX-XXXX-XXXX`, from an alphabet with the four
// characters that make a hand-copied code fail removed: `I`, `O`, `0`, `1`.
//
// Note this is NOT RFC 4648 base32, whose `A-Z2-7` alphabet *includes* I and O — a first version of
// this file claimed otherwise and was wrong. Dropping I and O from the letters (24 left) and using
// digits 2–9 (8 left) gives exactly 32 symbols, so one random byte still maps to one character with
// no modulo bias.
//
// The hyphens are cosmetic and are stripped before hashing, so a user who types or omits them gets
// the same result.
import { randomBytes } from 'node:crypto'
import { hashPassword, verifyPassword } from './passwords.js'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const BYTES = 20
const GROUPS = 4
const GROUP_SIZE = 4

export const RECOVERY_CODE_LENGTH = GROUPS * GROUP_SIZE
// Every symbol a code may contain, so a shape check and the generator cannot drift apart.
export const RECOVERY_ALPHABET = ALPHABET

// Uniform base32 without modulo bias: 32 divides 256 evenly, so masking the low 5 bits of each
// random byte is unbiased.
export function generateRecoveryCode() {
  const raw = randomBytes(BYTES)
  let code = ''
  for (const byte of raw) code += ALPHABET[byte & 31]
  // Grouped for a human to copy; the canonical form used for hashing has no hyphens.
  return Array.from({ length: GROUPS }, (_, at) => code.slice(at * GROUP_SIZE, (at + 1) * GROUP_SIZE)).join('-')
}

// The form that is hashed and compared: uppercase, no separators, no spaces. Every way a person
// might reasonably type a code collapses to this, so `abcd-efgh-...` and `ABCD EFGH ...` both work.
export function normalizeRecoveryCode(input) {
  return String(input ?? '').toUpperCase().replace(/[\s-]/g, '')
}

export const isValidRecoveryCodeShape = input => new RegExp(`^[${ALPHABET}]{16}$`).test(normalizeRecoveryCode(input))

export const hashRecoveryCode = code => hashPassword(normalizeRecoveryCode(code))

export const verifyRecoveryCode = (code, phc) => {
  if (!isValidRecoveryCodeShape(code)) return false
  return verifyPassword(normalizeRecoveryCode(code), phc)
}
