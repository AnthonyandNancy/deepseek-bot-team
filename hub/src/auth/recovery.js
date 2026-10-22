// Password recovery: three layers, because each one alone has a blind spot.
//
//   1. `change`        — signed in. The ordinary case: you still have a session, so you are you.
//   2. `recoverWithCode` — signed out, holding a recovery code. The case that matters when the
//                          machine is gone (stolen, re-installed, disk died).
//   3. `resetByOperator` — the user holds nothing. Runs from the Hub command line against the
//                          database file, which means it requires filesystem access to the Hub's
//                          own data — the same trust level as editing the database by hand.
//
// What every layer has in common: a successful change ends every other session and revokes every
// device. That is the point of a recovery — whoever had access before must not keep it. The one
// doing the recovery gets a fresh session back, so a recovery on a new machine is useful.
//
// What no layer does: reveal whether an account exists. A recovery attempt on an unknown phone
// spends the same work as a real one and answers the same way, exactly like login.
import { badRequest, forbidden, tooMany, unauthorized } from '../errors.js'
import { maskPhone, normalizePhone } from '../phone.js'
import { checkPassword, hashPassword, passwordPolicy, spendPasswordWork, verifyPassword, VERSION as PASSWORD_VERSION } from './passwords.js'
import { generateRecoveryCode, hashRecoveryCode, verifyRecoveryCode } from './recovery-codes.js'
import { hashToken, newAccessToken, newRefreshToken, newId, sessionId } from './tokens.js'

const INVALID_RECOVERY = 'auth/invalid-recovery-code'
const INVALID_RECOVERY_MESSAGE = 'That recovery code is not valid, or it was already used.'

export function createRecoveryService({ db, audit, limiters, config, now = () => Date.now() }) {
  const iso = () => new Date(now()).toISOString()

  const byPhone = db.prepare('SELECT * FROM users WHERE phone_e164 = ?')
  const byId = db.prepare('SELECT * FROM users WHERE id = ?')
  const codesOf = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC')
  const insertCode = db.prepare('INSERT INTO recovery_codes (id, user_id, code_hash, created_at, used_at) VALUES (?, ?, ?, ?, NULL)')
  const spendCode = db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?')
  const setPassword = db.prepare('UPDATE users SET password_phc = ?, password_version = ? WHERE id = ?')
  const editUser = db.prepare('UPDATE users SET password_phc = ?, password_version = ? WHERE phone_e164 = ?')
  // Recovery ends every existing session outright rather than merely revoking it, so nothing can
  // be resumed from a token that was valid before the password changed.
  const killSessions = db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
  const killDevices = db.prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
  const insertReset = db.prepare('INSERT INTO password_resets (id, user_id, method, at) VALUES (?, ?, ?, ?)')
  const insertSession = db.prepare(`INSERT INTO auth_sessions
    (id, user_id, device_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`)

  // A new session for whoever just changed the password, so they are not thrown out of the page
  // they are standing on.
  const issueSession = (user) => {
    const accessToken = newAccessToken()
    const refreshToken = newRefreshToken()
    const at = now()
    insertSession.run(
      sessionId(), user.id, hashToken(accessToken), new Date(at + config.accessTtlMs).toISOString(),
      hashToken(refreshToken), new Date(at + config.refreshTtlMs).toISOString(), new Date(at).toISOString(),
    )
    return {
      accessToken,
      accessExpiresAt: new Date(at + config.accessTtlMs).toISOString(),
      refreshToken,
      refreshExpiresAt: new Date(at + config.refreshTtlMs).toISOString(),
    }
  }

  // Ending every session and device, then issuing one fresh session, in a single transaction. A
  // partial version would either leave an old session alive after a password change — the exact
  // thing a recovery exists to prevent — or lock the user out of the page they are standing on.
  //
  // `method` is recorded in `password_resets` for the two *reset* paths, whose table has a CHECK
  // limiting it to those. A signed-in password change is not a reset: it appears in
  // `audit_events` and needs no second record.
  const evictAndIssue = (user, method) => {
    db.exec('BEGIN')
    try {
      killSessions.run(iso(), user.id)
      killDevices.run(iso(), user.id)
      if (method !== undefined) insertReset.run(newId('rst'), user.id, method, iso())
      const session = issueSession(user)
      db.exec('COMMIT')
      return session
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  return {
    // ── layer 2: recover with a code, signed out ──────────────────────────────────────────────
    // Returns a fresh session, because the machine doing the recovery is usually a new one.
    async recoverWithCode({ phone, code, password, ip }) {
      const phoneKey = String(phone ?? '').trim()
      for (const limiter of [limiters.recoverByIp, limiters.recoverByPhone]) {
        const verdict = limiter.peek(limiter === limiters.recoverByIp ? ip : phoneKey)
        if (!verdict.allowed) throw tooMany(verdict.retryAfterMs)
      }

      const normalized = normalizePhone(phone)
      const user = normalized === undefined ? undefined : byPhone.get(normalized)
      const policyFailure = checkPassword(password, normalized ?? '')
      if (policyFailure !== undefined) throw badRequest('auth/weak-password', passwordPolicy.message)

      // The code is checked against this user's live codes. An unknown phone has no codes, so the
      // dummy verification below is what keeps the timing identical — otherwise "no such account"
      // would answer instantly and become an oracle.
      let matched
      if (user === undefined) {
        spendPasswordWork(code)
      } else {
        for (const row of codesOf.all(user.id)) {
          if (verifyRecoveryCode(code, row.code_hash)) { matched = row; break }
        }
      }

      if (user === undefined || matched === undefined || user.status !== 'active') {
        limiters.recoverByIp.hit(ip)
        limiters.recoverByPhone.hit(phoneKey)
        audit.record({ actorId: user?.id ?? null, action: 'auth.password-recovered', targetId: maskPhone(normalized ?? phone), result: 'denied' })
        throw unauthorized(INVALID_RECOVERY, INVALID_RECOVERY_MESSAGE)
      }

      // Single use: the code is spent before the password changes, in the same transaction that
      // does the change, so a crash between the two cannot leave a working code behind.
      db.exec('BEGIN')
      try {
        spendCode.run(iso(), matched.id)
        setPassword.run(hashPassword(password), PASSWORD_VERSION, user.id)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }

      const session = evictAndIssue(user, 'recovery-code')
      limiters.recoverByIp.reset(ip)
      limiters.recoverByPhone.reset(phoneKey)
      audit.record({ actorId: user.id, action: 'auth.password-recovered', result: 'ok' })
      return { hubUserId: user.id, phoneMasked: maskPhone(user.phone_e164), ...session }
    },

    // ── layer 1: change the password while signed in ──────────────────────────────────────────
    // Requires the current password: a session left open on an unlocked machine must not be enough
    // to take the account over.
    async changePassword({ accessToken, currentPassword, newPassword, sessionOf }) {
      const session = sessionOf(accessToken)
      const user = byId.get(session.user_id)
      if (user === undefined) throw unauthorized()
      if (!verifyPassword(String(currentPassword ?? ''), user.password_phc)) {
        audit.record({ actorId: user.id, action: 'auth.password-changed', result: 'denied' })
        throw forbidden('auth/wrong-password', 'The current password is not correct.')
      }
      if (checkPassword(newPassword, user.phone_e164) !== undefined) throw badRequest('auth/weak-password', passwordPolicy.message)
      if (verifyPassword(String(newPassword ?? ''), user.password_phc)) {
        throw badRequest('auth/same-password', 'The new password is the same as the current one.')
      }

      setPassword.run(hashPassword(newPassword), PASSWORD_VERSION, user.id)
      const next = evictAndIssue(user)
      audit.record({ actorId: user.id, action: 'auth.password-changed', result: 'ok' })
      return next
    },

    // ── layer 3: operator reset, from the Hub command line ────────────────────────────────────
    // Not an HTTP endpoint, on purpose: it requires the phone number *and* filesystem access to the
    // Hub's database, which is the same authority as editing the database directly. Exposing it
    // over HTTP would be a back door with a shorter password.
    resetByOperator({ phone, password }) {
      const normalized = normalizePhone(phone)
      if (normalized === undefined) throw badRequest('auth/invalid-phone', 'A phone number must be in international form, for example +8613800138000.')
      const user = byPhone.get(normalized)
      if (user === undefined) throw badRequest('auth/no-such-account', `No account for ${normalized}.`)
      if (checkPassword(password, normalized) !== undefined) throw badRequest('auth/weak-password', passwordPolicy.message)

      setPassword.run(hashPassword(password), PASSWORD_VERSION, user.id)
      killSessions.run(iso(), user.id)
      killDevices.run(iso(), user.id)
      insertReset.run(newId('rst'), user.id, 'operator', iso())
      audit.record({ actorId: user.id, action: 'auth.password-reset-operator', result: 'ok' })
      return { hubUserId: user.id, phoneMasked: maskPhone(user.phone_e164) }
    },

    // ── creating a code (signed in) ───────────────────────────────────────────────────────────
    // Shown once. The Hub keeps only the digest, so it cannot be displayed again — and the page
    // says so, because a user who assumes it can be looked up later will lose it.
    async createRecoveryCode({ accessToken, sessionOf }) {
      const session = sessionOf(accessToken)
      const user = byId.get(session.user_id)
      if (user === undefined) throw unauthorized()
      const code = generateRecoveryCode()
      insertCode.run(newId('rcv'), user.id, hashRecoveryCode(code), iso())
      audit.record({ actorId: user.id, action: 'auth.recovery-code-created', result: 'ok' })
      return { code, createdAt: iso() }
    },

    // Whether the account has an unused code, so the page can say "you have one" or warn that it
    // does not — without ever revealing the code itself.
    async recoveryState({ accessToken, sessionOf }) {
      const session = sessionOf(accessToken)
      const codes = codesOf.all(session.user_id)
      return { hasCode: codes.length > 0, count: codes.length, createdAt: codes[0]?.created_at }
    },

    // For the operator command: a summary, without printing anything secret.
    describeByOperator({ phone }) {
      const normalized = normalizePhone(phone)
      const user = normalized === undefined ? undefined : byPhone.get(normalized)
      if (user === undefined) return undefined
      const codes = codesOf.all(user.id)
      return {
        hubUserId: user.id,
        phoneMasked: maskPhone(user.phone_e164),
        status: user.status,
        recoveryCodes: codes.length,
        passwordVersion: user.password_version,
      }
    },
  }
}
