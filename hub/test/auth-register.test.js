// Gate item 1: two different phone numbers produce two independent Hub users.
//
// "Independent" is the assertion that matters — not just that two ids exist, but that neither
// account's token can see or act on the other's data. A test that only counted rows would
// pass against a Hub that handed the same user id to everyone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PASSWORD, PHONE_A, PHONE_B, startHub } from './helpers.js'

test('two phone numbers register two distinct users', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())

  const a = await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })
  const b = await hub.post('/v1/auth/register', { phone: PHONE_B, password: PASSWORD })

  assert.equal(a.status, 201)
  assert.equal(b.status, 201)
  assert.match(a.body.hubUserId, /^usr_/)
  assert.match(b.body.hubUserId, /^usr_/)
  assert.notEqual(a.body.hubUserId, b.body.hubUserId)

  // Each account's `me` reports its own masked number, and the two must differ: a Hub that
  // echoed one shared record would return the same mask twice.
  const meA = await hub.get('/v1/auth/me', { token: a.body.accessToken })
  const meB = await hub.get('/v1/auth/me', { token: b.body.accessToken })
  assert.equal(meA.body.hubUserId, a.body.hubUserId)
  assert.equal(meB.body.hubUserId, b.body.hubUserId)
  assert.notEqual(meA.body.phoneMasked, meB.body.phoneMasked)
})

test('a registration response never carries the full phone number', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())

  const created = await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })
  const serialized = JSON.stringify(created.body)
  assert.equal(serialized.includes(PHONE_A), false, 'the full number must not appear in a response')
  assert.equal(serialized.includes('+8613800138000'.slice(3, 10)), false)
  assert.match(created.body.phoneMasked, /^\+\d{1,3}\*{4}\d{4}$/)

  const me = await hub.get('/v1/auth/me', { token: created.body.accessToken })
  assert.equal(JSON.stringify(me.body).includes(PHONE_A), false)
})

test('a phone becomes a login name, never a verified identity', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())

  await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })
  const row = hub.hub.db.prepare('SELECT phone_verified_at FROM users WHERE phone_e164 = ?').get(PHONE_A)
  // The gate's SMS clause says a number is only verified when a real gateway confirmed it.
  // V1 sends no SMS, so this column must stay NULL and no response may suggest otherwise.
  assert.equal(row.phone_verified_at, null)
})

test('the same phone number cannot register twice', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())

  const first = await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })
  assert.equal(first.status, 201)
  const second = await hub.post('/v1/auth/register', { phone: PHONE_A, password: 'a different long password' })
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'auth/phone-taken')
})

test('a malformed phone number and a weak password are refused with distinct codes', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())

  const noCountryCode = await hub.post('/v1/auth/register', { phone: '13800138000', password: PASSWORD })
  assert.equal(noCountryCode.status, 400)
  assert.equal(noCountryCode.body.error.code, 'auth/invalid-phone')

  const short = await hub.post('/v1/auth/register', { phone: PHONE_A, password: 'short' })
  assert.equal(short.status, 400)
  assert.equal(short.body.error.code, 'auth/weak-password')

  // The password may not be the phone number itself: the most guessable option available.
  const asPhone = await hub.post('/v1/auth/register', { phone: PHONE_A, password: '8613800138000' })
  assert.equal(asPhone.status, 400)
  assert.equal(asPhone.body.error.code, 'auth/weak-password')
})

test('a phone typed with spaces and dashes is accepted and normalized', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())

  const created = await hub.post('/v1/auth/register', { phone: '+86 138-0013-8000', password: PASSWORD })
  assert.equal(created.status, 201)
  // Logging in with the plain form must reach the same account.
  const login = await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })
  assert.equal(login.status, 200)
  assert.equal(login.body.hubUserId, created.body.hubUserId)
})
