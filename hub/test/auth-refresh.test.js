// Refresh rotation and logout.
//
// The property that matters: a token, once spent or signed out, stops working *immediately*.
// Not "expires later" — a revoked device and a logged-out session have to be dead on the very
// next request, because that is what "设备撤销即时断线" rests on.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PASSWORD, PHONE_A, startHub } from './helpers.js'

const signUp = async (hub) => (await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })).body

test('refresh rotates both tokens and spends the old refresh token', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)

  const refreshed = await hub.post('/v1/auth/refresh', { refreshToken: created.refreshToken })
  assert.equal(refreshed.status, 200)
  assert.notEqual(refreshed.body.refreshToken, created.refreshToken)
  assert.notEqual(refreshed.body.accessToken, created.accessToken)

  // Both halves of the old pair are gone: the old refresh token finds no row, and the old
  // access token's row has been rewritten with the new hash.
  const replay = await hub.post('/v1/auth/refresh', { refreshToken: created.refreshToken })
  assert.equal(replay.status, 401)
  const oldAccess = await hub.get('/v1/auth/me', { token: created.accessToken })
  assert.equal(oldAccess.status, 401)

  const newAccess = await hub.get('/v1/auth/me', { token: refreshed.body.accessToken })
  assert.equal(newAccess.status, 200)
  assert.equal(newAccess.body.hubUserId, created.hubUserId)
})

test('a rotated refresh token works exactly once', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)

  const first = await hub.post('/v1/auth/refresh', { refreshToken: created.refreshToken })
  const second = await hub.post('/v1/auth/refresh', { refreshToken: first.body.refreshToken })
  assert.equal(second.status, 200)
  // Presenting the middle token again is a replay, not a second session.
  const third = await hub.post('/v1/auth/refresh', { refreshToken: first.body.refreshToken })
  assert.equal(third.status, 401)
})

test('logout ends the session at once', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)

  const before = await hub.get('/v1/auth/me', { token: created.accessToken })
  assert.equal(before.status, 200)

  const out = await hub.post('/v1/auth/logout', undefined, { token: created.accessToken })
  assert.equal(out.status, 204)

  const after = await hub.get('/v1/auth/me', { token: created.accessToken })
  assert.equal(after.status, 401)
  assert.equal(after.body.error.code, 'auth/session-revoked')

  // The refresh token dies with the session: logging out must not leave a way back in.
  const refresh = await hub.post('/v1/auth/refresh', { refreshToken: created.refreshToken })
  assert.equal(refresh.status, 401)
})

test('an expired access token is refused while its refresh token still works', async (t) => {
  // Short access lifetime, long refresh lifetime: the pair the two-token design exists for.
  // The clock is moved rather than slept on, so the expiry is exact and the test cannot race.
  const hub = await startHub({ accessTtlMs: 1000, refreshTtlMs: 60 * 60 * 1000 })
  t.after(() => hub.close())
  await signUp(hub)
  const login = (await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).body
  hub.clock.advanceBy(2000)

  const expired = await hub.get('/v1/auth/me', { token: login.accessToken })
  assert.equal(expired.status, 401)
  assert.equal(expired.body.error.code, 'auth/expired')

  const refreshed = await hub.post('/v1/auth/refresh', { refreshToken: login.refreshToken })
  assert.equal(refreshed.status, 200)
  const ok = await hub.get('/v1/auth/me', { token: refreshed.body.accessToken })
  assert.equal(ok.status, 200)
})

test('an expired refresh token cannot be exchanged', async (t) => {
  const hub = await startHub({ refreshTtlMs: 1000 })
  t.after(() => hub.close())
  const created = await signUp(hub)
  hub.clock.advanceBy(2000)

  const response = await hub.post('/v1/auth/refresh', { refreshToken: created.refreshToken })
  assert.equal(response.status, 401)
  assert.equal(response.body.error.code, 'auth/expired')
})

test('a well-formed but unknown refresh token is refused', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  for (const token of ['dsb_rt_neverissued', '', 'nonsense', undefined]) {
    const response = await hub.post('/v1/auth/refresh', { refreshToken: token })
    assert.equal(response.status, 401)
  }
})

test('logging out on one session leaves another session working', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  await signUp(hub)
  const second = (await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).body
  const third = (await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).body

  await hub.post('/v1/auth/logout', undefined, { token: second.accessToken })
  assert.equal((await hub.get('/v1/auth/me', { token: second.accessToken })).status, 401)
  assert.equal((await hub.get('/v1/auth/me', { token: third.accessToken })).status, 200)
})
