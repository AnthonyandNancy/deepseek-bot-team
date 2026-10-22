// Password recovery, all three layers.
//
// This exists because there is no SMS and no email: without a recovery path an account is simply
// unrecoverable, and once G4 stores real workgroup history that means losing it. Each layer is
// tested for what it must do AND for what it must refuse, because a recovery path is the most
// attractive thing in the system to attack.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PASSWORD, PHONE_A, registerDevice, startHub } from './helpers.js'
import { generateRecoveryCode, isValidRecoveryCodeShape, normalizeRecoveryCode, RECOVERY_ALPHABET } from '../src/auth/recovery-codes.js'

const NEW_PASSWORD = 'a completely different passphrase'

const signUp = async (hub, phone = PHONE_A) => (await hub.post('/v1/auth/register', { phone, password: PASSWORD })).body

const makeCode = async (hub, token) => (await hub.post('/v1/auth/recovery-code', undefined, { token })).body

// ── the code itself ─────────────────────────────────────────────────────────────

test('a recovery code is 16 characters from an unambiguous alphabet, in four groups', () => {
  // Built from the exported alphabet rather than a literal character class: the first version of
  // this test hard-coded RFC 4648 base32 and silently stopped matching when the alphabet changed to
  // drop the ambiguous characters.
  assert.equal(RECOVERY_ALPHABET.length, 32, 'one byte must map to one symbol without modulo bias')
  const code = generateRecoveryCode()
  assert.match(code, new RegExp(`^[${RECOVERY_ALPHABET}]{4}(-${RECOVERY_ALPHABET ? `[${RECOVERY_ALPHABET}]` : ''}{4}){3}$`))
  assert.equal(isValidRecoveryCodeShape(code), true)
  // The four characters that make a hand-copied code fail are absent.
  assert.equal(/[01OI]/.test(code), false, `ambiguous character in ${code}`)
})

test('every way a person types a code normalizes to the same value', () => {
  const canonical = normalizeRecoveryCode('abcd-efgh-jkmn-pqrs')
  assert.equal(canonical, 'ABCDEFGHJKMNPQRS')
  // Spaces, no hyphens, lowercase, mixed separators — all the same code.
  for (const typed of ['abcd efgh jkmn pqrs', 'ABCDEFGHJKMNPQRS', 'AbCd-EfGh-JkMn-PqRs', ' abcd--efgh jkmn_pqrs '.replace('_', '-')]) {
    assert.equal(normalizeRecoveryCode(typed), canonical, typed)
  }
})

test('two codes are never the same', () => {
  const seen = new Set()
  for (let at = 0; at < 200; at += 1) seen.add(generateRecoveryCode())
  assert.equal(seen.size, 200)
})

// ── layer 1: change the password while signed in ────────────────────────────────

test('a signed-in user can change their password with the current one', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)

  const changed = await hub.post('/v1/auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, { token: created.accessToken })
  assert.equal(changed.status, 200)
  assert.match(changed.body.accessToken, /^dsb_at_/)

  // The new password works and the old one does not.
  assert.equal((await hub.post('/v1/auth/login', { phone: PHONE_A, password: NEW_PASSWORD })).status, 200)
  assert.equal((await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).status, 401)
})

test('changing the password ends every other session', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  await signUp(hub)
  const other = (await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).body
  const changing = (await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).body

  // The point of a password change: whoever had access before must not keep it.
  const changed = await hub.post('/v1/auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, { token: changing.accessToken })
  assert.equal(changed.status, 200)
  assert.equal((await hub.get('/v1/auth/me', { token: other.accessToken })).status, 401)
  assert.equal((await hub.post('/v1/auth/refresh', { refreshToken: other.refreshToken })).status, 401)
  // The person who changed it keeps working, with the fresh token they were given.
  assert.equal((await hub.get('/v1/auth/me', { token: changed.body.accessToken })).status, 200)
})

test('changing the password requires the current one', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)

  // A session left open on an unlocked machine must not be enough to take the account over.
  const response = await hub.post('/v1/auth/password', { currentPassword: 'not the current password', newPassword: NEW_PASSWORD }, { token: created.accessToken })
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'auth/wrong-password')
  // And nothing changed.
  assert.equal((await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).status, 200)
})

test('a new password must differ and must pass the policy', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)

  const same = await hub.post('/v1/auth/password', { currentPassword: PASSWORD, newPassword: PASSWORD }, { token: created.accessToken })
  assert.equal(same.status, 400)
  assert.equal(same.body.error.code, 'auth/same-password')

  const weak = await hub.post('/v1/auth/password', { currentPassword: PASSWORD, newPassword: 'short' }, { token: created.accessToken })
  assert.equal(weak.status, 400)
  assert.equal(weak.body.error.code, 'auth/weak-password')
})

// ── layer 2: recover with a code while signed out ───────────────────────────────

test('a recovery code is shown once and only its digest is stored', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)

  // `makeCode` already unwraps the body, so this is the first and only time the code is visible.
  const made = await makeCode(hub, created.accessToken)
  assert.equal(isValidRecoveryCodeShape(made.code), true)

  // Asking again returns a *different* code — the Hub cannot re-display the first one, because it
  // kept only a digest.
  const second = await makeCode(hub, created.accessToken)
  assert.notEqual(second.code, made.code)
  const code = made.code

  // The database must not hold the code itself: a leaked table would otherwise be a list of
  // working credentials.
  const row = hub.hub.db.prepare('SELECT code_hash FROM recovery_codes').get()
  assert.match(row.code_hash, /^\$scrypt\$/)
  assert.equal(row.code_hash.includes(normalizeRecoveryCode(code)), false)
})

test('an unused code is reported without revealing it', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)

  const before = await hub.get('/v1/auth/recovery-code', { token: created.accessToken })
  assert.equal(before.body.hasCode, false)

  await makeCode(hub, created.accessToken)
  const after = await hub.get('/v1/auth/recovery-code', { token: created.accessToken })
  assert.equal(after.body.hasCode, true)
  assert.equal(after.body.count, 1)
  assert.equal(JSON.stringify(after.body).includes('code'), false, 'the state must not carry a code')
})

test('a recovery code recovers the account and returns a working session', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)
  const { code } = await makeCode(hub, created.accessToken)

  // Signed out on a new machine: no session, no device, just the code.
  const recovered = await hub.post('/v1/auth/recover', { phone: PHONE_A, code, password: NEW_PASSWORD })
  assert.equal(recovered.status, 200)
  assert.equal(recovered.body.hubUserId, created.hubUserId)
  assert.match(recovered.body.accessToken, /^dsb_at_/)

  // The returned session works, and the new password logs in.
  assert.equal((await hub.get('/v1/auth/me', { token: recovered.body.accessToken })).status, 200)
  assert.equal((await hub.post('/v1/auth/login', { phone: PHONE_A, password: NEW_PASSWORD })).status, 200)
  // The old password is dead.
  assert.equal((await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).status, 401)
})

test('a recovery ends every session and revokes every device', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)
  const device = await registerDevice(hub, created.accessToken)
  const { code } = await makeCode(hub, created.accessToken)

  await hub.post('/v1/auth/recover', { phone: PHONE_A, code, password: NEW_PASSWORD })

  // A recovery is exactly the situation where the old holders must lose access.
  assert.equal((await hub.get('/v1/auth/me', { token: created.accessToken })).status, 401)
  const devices = hub.hub.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(device.deviceId)
  assert.notEqual(devices.revoked_at, null)
})

test('a recovery code works exactly once', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)
  const { code } = await makeCode(hub, created.accessToken)

  assert.equal((await hub.post('/v1/auth/recover', { phone: PHONE_A, code, password: NEW_PASSWORD })).status, 200)
  const again = await hub.post('/v1/auth/recover', { phone: PHONE_A, code, password: 'yet another passphrase' })
  assert.equal(again.status, 401)
  assert.equal(again.body.error.code, 'auth/invalid-recovery-code')
})

test('a wrong code and an unknown phone answer identically', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)
  await makeCode(hub, created.accessToken)

  const wrongCode = await hub.post('/v1/auth/recover', { phone: PHONE_A, code: 'AAAA-BBBB-CCCC-DDDD', password: NEW_PASSWORD })
  const unknownPhone = await hub.post('/v1/auth/recover', { phone: '+8613700137000', code: 'AAAA-BBBB-CCCC-DDDD', password: NEW_PASSWORD })

  assert.equal(wrongCode.status, 401)
  assert.equal(unknownPhone.status, 401)
  // Same body: a different answer would tell an attacker which phone numbers exist.
  assert.deepEqual(wrongCode.body, unknownPhone.body)
})

test('a malformed code is refused as invalid, not as a server error', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)
  await makeCode(hub, created.accessToken)

  for (const code of ['', 'too-short', 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', undefined]) {
    const response = await hub.post('/v1/auth/recover', { phone: PHONE_A, code, password: NEW_PASSWORD })
    assert.equal(response.status, 401, String(code))
    assert.equal(response.body.error.code, 'auth/invalid-recovery-code')
  }
})

test('a weak new password is refused before the code is spent', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)
  const { code } = await makeCode(hub, created.accessToken)

  // Otherwise a person who mistyped a short password would lose their only recovery code.
  const rejected = await hub.post('/v1/auth/recover', { phone: PHONE_A, code, password: 'short' })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.error.code, 'auth/weak-password')

  // The same code still works with an acceptable password.
  assert.equal((await hub.post('/v1/auth/recover', { phone: PHONE_A, code, password: NEW_PASSWORD })).status, 200)
})

test('recovery attempts are rate-limited', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  await signUp(hub)

  let limited
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await hub.post('/v1/auth/recover', { phone: PHONE_A, code: 'AAAA-BBBB-CCCC-DDDD', password: NEW_PASSWORD })
    if (response.status === 429) { limited = response; break }
  }
  assert.ok(limited !== undefined, 'a grinding run must eventually be refused')
  assert.equal(limited.body.error.code, 'auth/rate-limited')
})

// ── layer 3: the operator command ───────────────────────────────────────────────

test('the operator can reset a password, ending every session', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)

  // Called directly, because it is not an endpoint: reaching it requires the database file.
  const result = hub.hub.recovery.resetByOperator({ phone: PHONE_A, password: NEW_PASSWORD })
  assert.equal(result.hubUserId, created.hubUserId)

  assert.equal((await hub.get('/v1/auth/me', { token: created.accessToken })).status, 401)
  assert.equal((await hub.post('/v1/auth/login', { phone: PHONE_A, password: NEW_PASSWORD })).status, 200)
  assert.equal((await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).status, 401)
})

test('the operator command refuses an unknown account and a weak password', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  await signUp(hub)

  assert.throws(() => hub.hub.recovery.resetByOperator({ phone: '+8613700137000', password: NEW_PASSWORD }), /No account/)
  assert.throws(() => hub.hub.recovery.resetByOperator({ phone: PHONE_A, password: 'short' }), /at least 10/)
  assert.throws(() => hub.hub.recovery.resetByOperator({ phone: '13800138000', password: NEW_PASSWORD }), /international form/)
})

test('the operator summary shows no secret', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)
  await makeCode(hub, created.accessToken)

  const summary = hub.hub.recovery.describeByOperator({ phone: PHONE_A })
  assert.equal(summary.hubUserId, created.hubUserId)
  assert.equal(summary.recoveryCodes, 1)
  const serialized = JSON.stringify(summary)
  assert.equal(serialized.includes(PHONE_A), false)
  assert.equal(serialized.includes('$scrypt$'), false)
})

// ── the audit trail ─────────────────────────────────────────────────────────────

test('every password change is audited, and no audit row holds a secret', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)
  const { code } = await makeCode(hub, created.accessToken)
  await hub.post('/v1/auth/recover', { phone: PHONE_A, code, password: NEW_PASSWORD })

  const actions = hub.hub.audit.list().map(event => event.action)
  // "Someone recovered my account" is unanswerable without these rows.
  assert.ok(actions.includes('auth.recovery-code-created'))
  assert.ok(actions.includes('auth.password-recovered'))

  const all = JSON.stringify(hub.hub.audit.list())
  assert.equal(all.includes(code), false, 'the code must never reach the audit trail')
  assert.equal(all.includes(NEW_PASSWORD), false)
  assert.equal(all.includes(PASSWORD), false)
  assert.equal(all.includes(PHONE_A), false)
})
