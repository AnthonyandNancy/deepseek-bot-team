// Gate item 3: password authentication refuses the wrong thing, and refuses it in a way that
// cannot be used to enumerate accounts.
//
// The three claims that are easy to get wrong and therefore each get their own test:
//   * an unknown phone and a wrong password are indistinguishable;
//   * they take the same time (an early return would answer in microseconds);
//   * repeated failure is rate-limited rather than unbounded.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PASSWORD, PHONE_A, startHub } from './helpers.js'

test('the correct password signs in', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())

  const created = await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })
  const login = await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })
  assert.equal(login.status, 200)
  assert.equal(login.body.hubUserId, created.body.hubUserId)
  assert.match(login.body.accessToken, /^dsb_at_/)
  assert.match(login.body.refreshToken, /^dsb_rt_/)
})

test('a wrong password and an unknown phone answer identically', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })

  const wrongPassword = await hub.post('/v1/auth/login', { phone: PHONE_A, password: 'not the right password' })
  const unknownPhone = await hub.post('/v1/auth/login', { phone: '+8613700137000', password: PASSWORD })

  assert.equal(wrongPassword.status, 401)
  assert.equal(unknownPhone.status, 401)
  // Every field must match: a different code, message, or shape is an account oracle.
  assert.deepEqual(wrongPassword.body, unknownPhone.body)
  assert.equal(wrongPassword.body.error.code, 'auth/invalid-credentials')
})

test('an unknown phone spends the same password work as a known one', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })

  // A generous floor: scrypt with N=32768 takes tens of milliseconds, while an early return
  // would be well under a millisecond. The assertion is "not obviously faster", which is what
  // removes the timing oracle, not a precise duration.
  const time = async (phone) => {
    const started = process.hrtime.bigint()
    await hub.post('/v1/auth/login', { phone, password: 'wrong password here' })
    return Number(process.hrtime.bigint() - started) / 1e6
  }
  await time(PHONE_A) // warm up JIT and statement caches
  const known = await time(PHONE_A)
  const unknown = await time('+8613700137000')

  assert.ok(known > 10, `a known phone should spend scrypt time, took ${known.toFixed(1)}ms`)
  assert.ok(unknown > 10, `an unknown phone must not return before hashing, took ${unknown.toFixed(1)}ms`)
  // Within a factor of four in either direction. Loose enough not to flake on a busy machine,
  // tight enough that a missing dummy hash (≈0 ms vs ≈50 ms) fails.
  const ratio = known / unknown
  assert.ok(ratio > 0.25 && ratio < 4, `timing should be comparable: known ${known.toFixed(1)}ms vs unknown ${unknown.toFixed(1)}ms`)
})

test('repeated failures are rate-limited per phone number', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })

  let refused = 0
  let limited
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await hub.post('/v1/auth/login', { phone: PHONE_A, password: 'wrong password here' })
    if (response.status === 429) { limited = response; break }
    if (response.status === 401) refused += 1
  }
  assert.ok(limited !== undefined, 'a sustained guessing run must eventually be refused with 429')
  assert.equal(limited.body.error.code, 'auth/rate-limited')
  assert.ok(refused >= 5, `expected several plain refusals before the limit, saw ${refused}`)
  // The header says when to come back; a client that ignores it will keep being refused.
  assert.match(limited.headers.get('retry-after') ?? '', /^\d+$/)
})

test('a successful login does not spend a rate-limit slot', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })

  // A limit that counted successes would lock out a person who simply signs in often.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })
    assert.equal(response.status, 200, `login ${attempt + 1} should succeed`)
  }
})

test('an invalid token is not accepted as a session', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())

  for (const token of ['dsb_at_nonsense', '', 'Bearer x', undefined]) {
    const response = await hub.get('/v1/auth/me', { token })
    assert.equal(response.status, 401)
  }
})
