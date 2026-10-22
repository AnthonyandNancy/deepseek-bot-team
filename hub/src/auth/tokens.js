// Tokens: opaque random strings, stored only as a SHA-256 digest.
//
// Not JWT, on purpose. The gate requires that revoking a device disconnects it immediately,
// and that logging out ends the session now. A signed self-contained token cannot be
// withdrawn without keeping a revocation list — which is the session table this Hub already
// needs, so the signature would buy nothing and cost a second source of truth.
import { createHash, randomBytes, randomUUID } from 'node:crypto'

export const ACCESS_PREFIX = 'dsb_at_'
export const REFRESH_PREFIX = 'dsb_rt_'
const TOKEN_BYTES = 32

const mint = prefix => prefix + randomBytes(TOKEN_BYTES).toString('base64url')

export const newAccessToken = () => mint(ACCESS_PREFIX)
export const newRefreshToken = () => mint(REFRESH_PREFIX)

// 256 bits of randomness cannot be brute-forced, so a fast digest is the right tool: a
// password-style slow hash would make every authenticated request cost 50 ms for no gain.
export const hashToken = token => createHash('sha256').update(String(token)).digest('hex')

export const isAccessToken = value => typeof value === 'string' && value.startsWith(ACCESS_PREFIX)
export const isRefreshToken = value => typeof value === 'string' && value.startsWith(REFRESH_PREFIX)

export const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '')}`

export const userId = () => newId('usr')
export const sessionId = () => newId('ses')
export const deviceId = () => newId('dev')
export const auditId = () => newId('aud')

// Reads a bearer header. Returns undefined for anything that is not exactly one bearer
// token, so a malformed header is treated as "not signed in" rather than as a token.
export function bearerToken(header) {
  if (typeof header !== 'string') return undefined
  // `\s+` rather than one space, and the capture is trimmed: a header pasted through a proxy
  // can arrive with extra whitespace, and a token with a leading space matches no digest.
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match === null ? undefined : match[1]
}
