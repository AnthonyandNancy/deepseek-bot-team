// Registration, login, refresh, logout, and "who am I".
//
// Two refusals are shaped here and nowhere else:
//
//   * register: a duplicate phone gets a distinct 409. The alternative — pretending to
//     succeed — would leave a person unable to log in and with no way to learn why, and
//     the endpoint is rate-limited and audited, so enumeration is expensive rather than
//     impossible. This is a deliberate, recorded choice (docs/g3/PLAN.md §3.1).
//   * login: every failure — unknown phone, wrong password, suspended account — returns one
//     code, one message, and one status, and spends the scrypt time either way. Nothing in
//     the response distinguishes the cases.
import { isUniqueViolation } from '../db/index.js'
import { badRequest, conflict, tooMany, unauthorized } from '../errors.js'
import { maskPhone, normalizePhone } from '../phone.js'
import { ACTIONS } from '../audit.js'
import { checkPassword, hashPassword, passwordPolicy, spendPasswordWork, verifyPassword, VERSION as PASSWORD_VERSION } from './passwords.js'
import { hashToken, newAccessToken, newRefreshToken, sessionId, userId } from './tokens.js'

const INVALID_CREDENTIALS = 'auth/invalid-credentials'
const INVALID_CREDENTIALS_MESSAGE = 'The phone number or password is not correct.'

export function createAuthService({ db, audit, limiters, config, now = () => Date.now() }) {
  const iso = () => new Date(now()).toISOString()

  const byPhone = db.prepare('SELECT * FROM users WHERE phone_e164 = ?')
  const byId = db.prepare('SELECT * FROM users WHERE id = ?')
  const insertUser = db.prepare(`INSERT INTO users (id, phone_e164, phone_verified_at, password_phc, password_version, status, created_at)
    VALUES (?, ?, NULL, ?, ?, 'active', ?)`)
  const insertSession = db.prepare(`INSERT INTO auth_sessions
    (id, user_id, device_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`)
  const byAccess = db.prepare('SELECT * FROM auth_sessions WHERE access_hash = ?')
  const byRefresh = db.prepare('SELECT * FROM auth_sessions WHERE refresh_hash = ?')
  const rotate = db.prepare('UPDATE auth_sessions SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ?, last_used_at = ? WHERE id = ?')
  const revoke = db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?')
  const touch = db.prepare('UPDATE auth_sessions SET last_used_at = ? WHERE id = ?')
  const devicesOf = db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at ASC')

  // `phone_verified_at` is written as NULL and never updated: no SMS is sent in V1, so the
  // account has no verified number and nothing may claim otherwise.
  const publicUser = user => ({
    hubUserId: user.id,
    phoneMasked: maskPhone(user.phone_e164),
    createdAt: user.created_at,
  })

  const issueSession = (user) => {
    const accessToken = newAccessToken()
    const refreshToken = newRefreshToken()
    const at = now()
    insertSession.run(
      sessionId(), user.id, hashToken(accessToken), new Date(at + config.accessTtlMs).toISOString(),
      hashToken(refreshToken), new Date(at + config.refreshTtlMs).toISOString(), new Date(at).toISOString(),
    )
    return {
      ...publicUser(user),
      accessToken,
      accessExpiresAt: new Date(at + config.accessTtlMs).toISOString(),
      refreshToken,
      refreshExpiresAt: new Date(at + config.refreshTtlMs).toISOString(),
    }
  }

  const rateCheck = (limiter, key) => {
    const verdict = limiter.peek(key)
    if (!verdict.allowed) throw tooMany(verdict.retryAfterMs)
  }

  // Resolves an access token to its session row, or throws. Used by every authenticated
  // endpoint and by the WSS handshake, so the "is this token still good" rule exists once.
  const sessionOf = (accessToken) => {
    const session = typeof accessToken === 'string' ? byAccess.get(hashToken(accessToken)) : undefined
    if (session === undefined) throw unauthorized(INVALID_CREDENTIALS, 'The access token is not valid.')
    if (session.revoked_at !== null) throw unauthorized('auth/session-revoked', 'This session was signed out.')
    if (Date.parse(session.access_expires_at) <= now()) throw unauthorized('auth/expired', 'The access token has expired.')
    touch.run(new Date(now()).toISOString(), session.id)
    return session
  }

  return {
    sessionOf,

    // ── POST /v1/auth/register ────────────────────────────────────────────────────────
    async register({ phone, password, ip }) {
      rateCheck(limiters.registerByIp, ip)

      const normalized = normalizePhone(phone)
      if (normalized === undefined) {
        audit.record({ action: ACTIONS.register, result: 'invalid-phone' })
        throw badRequest('auth/invalid-phone', 'A phone number must be in international form, for example +8613800138000.')
      }
      if (checkPassword(password, normalized) !== undefined) {
        audit.record({ action: ACTIONS.register, result: 'weak-password' })
        throw badRequest('auth/weak-password', passwordPolicy.message)
      }
      if (byPhone.get(normalized) !== undefined) {
        limiters.registerByIp.hit(ip)
        audit.record({ action: ACTIONS.register, targetId: maskPhone(normalized), result: 'duplicate' })
        throw conflict('auth/phone-taken', 'That phone number is already registered.')
      }

      const id = userId()
      try {
        insertUser.run(id, normalized, hashPassword(password), PASSWORD_VERSION, iso())
      } catch (error) {
        // Two registrations racing on the same number: the UNIQUE index decides, and the
        // loser gets the same 409 as the checked path above rather than a 500.
        if (!isUniqueViolation(error)) throw error
        limiters.registerByIp.hit(ip)
        audit.record({ action: ACTIONS.register, targetId: maskPhone(normalized), result: 'duplicate' })
        throw conflict('auth/phone-taken', 'That phone number is already registered.')
      }

      limiters.registerByIp.hit(ip)
      const user = byId.get(id)
      audit.record({ actorId: id, action: ACTIONS.register, result: 'ok' })
      return issueSession(user)
    },

    // ── POST /v1/auth/login ───────────────────────────────────────────────────────────
    async login({ phone, password, ip }) {
      const phoneKey = String(phone ?? '').trim()
      rateCheck(limiters.loginByIp, ip)
      rateCheck(limiters.loginByPhone, phoneKey)

      const normalized = normalizePhone(phone)
      const user = normalized === undefined ? undefined : byPhone.get(normalized)

      // The dummy verification is what keeps the two failure paths the same length: without
      // it, an unknown number would answer in microseconds and a known one in ~50 ms.
      let ok = false
      if (user === undefined) spendPasswordWork(String(password ?? ''))
      else ok = verifyPassword(String(password ?? ''), user.password_phc)

      if (!ok || user.status !== 'active') {
        // A suspended account fails here on purpose: "your account is suspended" would tell
        // an attacker the password was right.
        limiters.loginByIp.hit(ip)
        limiters.loginByPhone.hit(phoneKey)
        audit.record({ actorId: user?.id ?? null, action: ACTIONS.login, targetId: maskPhone(normalized ?? phone), result: 'denied' })
        throw unauthorized(INVALID_CREDENTIALS, INVALID_CREDENTIALS_MESSAGE)
      }

      limiters.loginByIp.reset(ip)
      limiters.loginByPhone.reset(phoneKey)
      audit.record({ actorId: user.id, action: ACTIONS.login, result: 'ok' })
      return issueSession(user)
    },

    // ── POST /v1/auth/refresh ─────────────────────────────────────────────────────────
    async refresh({ refreshToken }) {
      const session = typeof refreshToken === 'string' ? byRefresh.get(hashToken(refreshToken)) : undefined
      if (session === undefined) throw unauthorized(INVALID_CREDENTIALS, 'The refresh token is not valid.')
      if (session.revoked_at !== null) throw unauthorized('auth/session-revoked', 'This session was signed out.')
      if (Date.parse(session.refresh_expires_at) <= now()) throw unauthorized('auth/expired', 'The refresh token has expired.')

      const user = byId.get(session.user_id)
      if (user === undefined || user.status !== 'active') throw unauthorized(INVALID_CREDENTIALS, INVALID_CREDENTIALS_MESSAGE)

      // Rotation: both halves are replaced in the same statement, so the presented refresh
      // token is spent the moment this returns. Replaying it finds no row.
      const accessToken = newAccessToken()
      const nextRefresh = newRefreshToken()
      const at = now()
      rotate.run(
        hashToken(accessToken), new Date(at + config.accessTtlMs).toISOString(),
        hashToken(nextRefresh), new Date(at + config.refreshTtlMs).toISOString(),
        new Date(at).toISOString(), session.id,
      )
      audit.record({ actorId: user.id, deviceId: session.device_id, action: ACTIONS.refresh, result: 'ok' })
      return {
        accessToken,
        accessExpiresAt: new Date(at + config.accessTtlMs).toISOString(),
        refreshToken: nextRefresh,
        refreshExpiresAt: new Date(at + config.refreshTtlMs).toISOString(),
      }
    },

    // ── POST /v1/auth/logout ──────────────────────────────────────────────────────────
    async logout({ accessToken }) {
      const session = sessionOf(accessToken)
      revoke.run(new Date(now()).toISOString(), session.id)
      audit.record({ actorId: session.user_id, deviceId: session.device_id, action: ACTIONS.logout, result: 'ok' })
      return { ok: true }
    },

    // ── GET /v1/auth/me ───────────────────────────────────────────────────────────────
    async me({ accessToken }) {
      const session = sessionOf(accessToken)
      const user = byId.get(session.user_id)
      const devices = devicesOf.all(user.id).map(device => ({
        deviceId: device.id,
        name: device.name,
        platform: device.platform,
        createdAt: device.created_at,
        lastSeenAt: device.last_seen_at,
        revokedAt: device.revoked_at,
        current: device.id === session.device_id,
      }))
      return {
        ...publicUser(user),
        session: {
          id: session.id,
          deviceId: session.device_id,
          accessExpiresAt: session.access_expires_at,
          refreshExpiresAt: session.refresh_expires_at,
        },
        devices,
      }
    },
  }
}
