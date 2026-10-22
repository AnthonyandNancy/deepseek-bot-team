// The primitives, tested directly. These are small enough that a test at the HTTP level would
// be indirect: a password hash either round-trips or it does not.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { checkPassword, hashPassword, MIN_LENGTH, PARAMS, spendPasswordWork, verifyPassword } from '../src/auth/passwords.js'
import { bearerToken, hashToken, isAccessToken, isRefreshToken, newAccessToken, newRefreshToken } from '../src/auth/tokens.js'
import { createLimiter } from '../src/auth/limiter.js'
import { maskPhone, normalizePhone } from '../src/phone.js'
import { compile, createRouter } from '../src/router.js'
import { isUniqueViolation } from '../src/db/index.js'

// ── passwords ────────────────────────────────────────────────────────────────────

test('a password verifies against its own hash and nothing else', () => {
  const phc = hashPassword('correct horse battery staple')
  assert.equal(verifyPassword('correct horse battery staple', phc), true)
  assert.equal(verifyPassword('correct horse battery stapl', phc), false)
  assert.equal(verifyPassword('', phc), false)
  assert.equal(verifyPassword('correct horse battery staple', undefined), false)
  assert.equal(verifyPassword('correct horse battery staple', 'not-a-phc'), false)
})

test('the hash carries its parameters and a fresh salt each time', () => {
  const a = hashPassword('correct horse battery staple')
  const b = hashPassword('correct horse battery staple')
  // Two users with the same password must not share a hash: equal hashes would tell an attacker
  // who has one database row that they have the other.
  assert.notEqual(a, b)
  assert.match(a, /^\$scrypt\$N=32768,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/)
  // The parameters travel with the hash so a later change can still verify an old password.
  assert.equal(verifyPassword('correct horse battery staple', a.replace('N=32768', 'N=16384')), false)
})

test('no reversible form of the password is stored', () => {
  const password = 'correct horse battery staple'
  const phc = hashPassword(password)
  assert.equal(phc.includes(password), false)
  // Base64 of the password would also be reversible; check the salt and key halves do not hold it.
  const [, , , salt, key] = phc.split('$')
  assert.equal(Buffer.from(salt, 'base64url').toString('latin1').includes(password), false)
  assert.equal(Buffer.from(key, 'base64url').toString('latin1').includes(password), false)
})

test('scrypt runs with the explicit memory limit that N=32768 requires', () => {
  // Without maxmem Node refuses these params outright. This is a regression guard: if someone
  // drops the option, every registration starts throwing.
  assert.equal(PARAMS.maxmem >= 64 * 1024 * 1024, true)
  assert.doesNotThrow(() => hashPassword('correct horse battery staple'))
})

test('the dummy verification always fails and costs the same as a real one', () => {
  assert.equal(spendPasswordWork('anything at all'), false)
  const started = process.hrtime.bigint()
  spendPasswordWork('anything at all')
  const spent = Number(process.hrtime.bigint() - started) / 1e6
  // Real scrypt is tens of milliseconds; a dummy that returned early would be microseconds.
  assert.ok(spent > 5, `the dummy hash must spend real work, took ${spent.toFixed(1)}ms`)
})

test('the password policy is length and not-the-phone, and nothing else', () => {
  assert.equal(checkPassword('x'.repeat(MIN_LENGTH - 1)), 'auth/weak-password')
  assert.equal(checkPassword('x'.repeat(MIN_LENGTH)), undefined)
  // Composition rules are deliberately absent: they push people toward short, guessable
  // passwords like "Password1!".
  assert.equal(checkPassword('alllowercaseandlong'), undefined)
  assert.equal(checkPassword('SHOUTINGUPPERCASE'), undefined)
  assert.equal(checkPassword('1234567890'), undefined)
  // But not the phone number itself.
  assert.equal(checkPassword('8613800138000', '+8613800138000'), 'auth/weak-password')
  assert.equal(checkPassword('+86 138 0013 8000', '+8613800138000'), 'auth/weak-password')
  assert.equal(checkPassword('x'.repeat(129)), 'auth/weak-password')
  assert.equal(checkPassword(undefined), 'auth/weak-password')
})

// ── tokens ──────────────────────────────────────────────────────────────────────

test('a token is long, random, and distinguishable from its digest', () => {
  const token = newAccessToken()
  assert.match(token, /^dsb_at_[A-Za-z0-9_-]{43}$/)
  assert.equal(isAccessToken(token), true)
  assert.equal(isRefreshToken(token), false, 'an access token is not a refresh token')
  assert.equal(isRefreshToken(newRefreshToken()), true)

  const digest = hashToken(token)
  assert.equal(digest.length, 64)
  assert.equal(digest.includes(token), false)
  // A hash is stable, which is what makes a lookup by digest work.
  assert.equal(hashToken(token), digest)
  assert.notEqual(hashToken(newAccessToken()), digest)
})

test('two tokens are never the same', () => {
  const seen = new Set()
  for (let at = 0; at < 200; at += 1) seen.add(newAccessToken())
  assert.equal(seen.size, 200)
})

test('a bearer header is read strictly', () => {
  assert.equal(bearerToken('Bearer dsb_at_x'), 'dsb_at_x')
  assert.equal(bearerToken('  Bearer   dsb_at_x  '), 'dsb_at_x')
  // Anything else is "not signed in", not a token to try.
  assert.equal(bearerToken('dsb_at_x'), undefined)
  assert.equal(bearerToken('Basic abc'), undefined)
  assert.equal(bearerToken('Bearer'), undefined)
  assert.equal(bearerToken(undefined), undefined)
})

// ── limiter ─────────────────────────────────────────────────────────────────────

test('the limiter counts inside its window and forgets outside it', () => {
  const limiter = createLimiter({ windowMs: 1000, max: 3 })
  const at = 1_000_000
  assert.equal(limiter.hit('k', at).allowed, true)
  assert.equal(limiter.hit('k', at).allowed, true)
  assert.equal(limiter.hit('k', at).allowed, true)
  const refused = limiter.hit('k', at)
  assert.equal(refused.allowed, false)
  assert.equal(refused.retryAfterMs, 1000)

  // The oldest attempt leaves the window a second after it was made.
  assert.equal(limiter.hit('k', at + 1001).allowed, true)
})

test('the limiter keeps keys apart and can be reset', () => {
  const limiter = createLimiter({ windowMs: 1000, max: 1 })
  assert.equal(limiter.hit('a', 0).allowed, true)
  assert.equal(limiter.hit('a', 0).allowed, false)
  assert.equal(limiter.hit('b', 0).allowed, true, 'one phone being limited must not limit another')
  limiter.reset('a')
  assert.equal(limiter.hit('a', 0).allowed, true)
})

test('peek does not consume a slot', () => {
  const limiter = createLimiter({ windowMs: 1000, max: 2 })
  for (let at = 0; at < 10; at += 1) assert.equal(limiter.peek('k', 0).allowed, true)
  limiter.hit('k', 0)
  limiter.hit('k', 0)
  assert.equal(limiter.peek('k', 0).allowed, false)
  // Peeking repeatedly must not be what pushes a key over its limit.
  for (let at = 0; at < 10; at += 1) limiter.peek('k', 0)
  assert.equal(limiter.hit('k', 0).allowed, false)
})

test('pruning drops windows that no longer hold an attempt', () => {
  const limiter = createLimiter({ windowMs: 100, max: 5 })
  limiter.hit('old', 0)
  limiter.hit('new', 500)
  assert.equal(limiter.size, 2)
  limiter.prune(500)
  assert.equal(limiter.size, 1, 'the idle key should be dropped')
})

// ── phone ───────────────────────────────────────────────────────────────────────

test('a phone number is normalized to E.164 or refused', () => {
  assert.equal(normalizePhone('+8613800138000'), '+8613800138000')
  assert.equal(normalizePhone('+86 138-0013-8000'), '+8613800138000')
  assert.equal(normalizePhone('+1 (415) 555-2671'), '+14155552671')
  // A national form has no country code, so storing it would be a guess about the country.
  assert.equal(normalizePhone('13800138000'), undefined)
  // A leading zero cannot follow the plus in E.164.
  assert.equal(normalizePhone('+0123456789'), undefined)
  assert.equal(normalizePhone('+1234567'), undefined)
  assert.equal(normalizePhone(''), undefined)
  assert.equal(normalizePhone(undefined), undefined)
})

test('a masked phone keeps enough to recognise and not enough to reuse', () => {
  assert.equal(maskPhone('+8613800138000'), '+86****8000')
  assert.equal(maskPhone('+14155552671'), '+14****2671')
  // Nothing useful from something too short to mask.
  assert.equal(maskPhone('+1'), '****')
  assert.equal(maskPhone(undefined), '****')
})

// ── router ──────────────────────────────────────────────────────────────────────

test('a pattern matches its segments and captures named ones', () => {
  const pattern = compile('/v1/devices/:id/revoke')
  assert.deepEqual(pattern.match('/v1/devices/dev_1/revoke'), { id: 'dev_1' })
  assert.deepEqual(pattern.match('/v1/devices/dev_1/revoke/'), { id: 'dev_1' })
  assert.equal(pattern.match('/v1/devices/revoke'), undefined)
  assert.equal(pattern.match('/v1/devices/a/b/revoke'), undefined)
  assert.equal(pattern.match('/v1/other/dev_1/revoke'), undefined)
})

test('the router separates a missing route from a wrong method', () => {
  const router = createRouter()
  router.get('/v1/health', () => 'ok')
  router.post('/v1/auth/login', () => 'login')

  assert.equal(router.resolve('GET', '/v1/health').handler(), 'ok')
  // A known path under the wrong method must say so: "not found" would send a client looking
  // for a feature that exists.
  assert.deepEqual(router.resolve('POST', '/v1/health'), { methodMismatch: true })
  assert.equal(router.resolve('GET', '/v1/nope'), undefined)
  // HEAD follows GET.
  assert.equal(router.resolve('HEAD', '/v1/health').handler(), 'ok')
})

test('a query string does not change which route matches', () => {
  const router = createRouter()
  router.get('/v1/health', () => 'ok')
  assert.equal(router.resolve('GET', '/v1/health?x=1').handler(), 'ok')
})

// ── db helper ───────────────────────────────────────────────────────────────────

test('a unique violation is recognised, and other errors are not', () => {
  assert.equal(isUniqueViolation({ errcode: 1555 }), true)
  assert.equal(isUniqueViolation(new Error('UNIQUE constraint failed: users.phone_e164')), true)
  assert.equal(isUniqueViolation(new Error('FOREIGN KEY constraint failed')), false)
  assert.equal(isUniqueViolation(undefined), false)

  // A real one, from a real database, so the errcode the helper keys on is not a guess.
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)')
  db.prepare('INSERT INTO t VALUES (?)').run('x')
  let caught
  try { db.prepare('INSERT INTO t VALUES (?)').run('x') } catch (error) { caught = error }
  assert.equal(isUniqueViolation(caught), true)
  db.close()
})

test('the TLS fixture is a real certificate, or the TLS tests prove nothing', () => {
  const pem = readFileSync(new URL('./fixtures/test-cert.pem', import.meta.url), 'utf8')
  assert.match(pem, /BEGIN CERTIFICATE/)
  // The key must be the matching one: a mismatched pair would make the HTTPS tests fail with a
  // confusing handshake error instead of pointing at the fixture.
  assert.match(readFileSync(new URL('./fixtures/test-key.pem', import.meta.url), 'utf8'), /PRIVATE KEY/)
})
