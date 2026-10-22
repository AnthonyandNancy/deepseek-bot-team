// The audit trail. Separate from the access log because the two have different lifetimes
// and different readers: this one is a durable record of who did what, kept in the database,
// and it must never hold a secret even though it deliberately holds actor identities.
import { auditId } from './auth/tokens.js'

export const ACTIONS = {
  register: 'auth.register',
  login: 'auth.login',
  loginFailed: 'auth.login-failed',
  refresh: 'auth.refresh',
  logout: 'auth.logout',
  deviceRegistered: 'device.register',
  deviceRevoked: 'device.revoke',
  rateLimited: 'auth.rate-limited',
  // Password recovery. Kept distinct from `login` because "I changed my password and did not use
  // the login form" and "someone recovered my account" are the two questions an operator asks.
  recoveryCodeCreated: 'auth.recovery-code-created',
  passwordRecovered: 'auth.password-recovered',
  passwordChanged: 'auth.password-changed',
  passwordResetByOperator: 'auth.password-reset-operator',
}

export function createAudit(db, now = () => new Date().toISOString()) {
  const insert = db.prepare('INSERT INTO audit_events (id, actor_id, device_id, action, target_id, result, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  return {
    record({ actorId = null, deviceId = null, action, targetId = null, result }) {
      insert.run(auditId(), actorId, deviceId, action, targetId, result, now())
    },
    list({ actorId, limit = 50 } = {}) {
      if (actorId === undefined) {
        return db.prepare('SELECT * FROM audit_events ORDER BY at DESC LIMIT ?').all(limit)
      }
      return db.prepare('SELECT * FROM audit_events WHERE actor_id = ? ORDER BY at DESC LIMIT ?').all(actorId, limit)
    },
  }
}
