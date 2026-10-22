// Gate item 3, second half: no secret reaches a log.
//
// The test drives a full lifecycle — register, log in, register a device, refresh, log out —
// and then searches everything the Hub wrote. Redaction that is only asserted on a hand-made
// log line would not catch a handler that logged the whole request body.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PASSWORD, PHONE_A, registerDevice, startHub } from './helpers.js'
import { createLogger, createMemoryLogger, redactFields, redactText, REDACTED } from '../src/log.js'

test('a real session leaves no password, token, or full phone number in the log', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())

  const created = (await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })).body
  await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })
  const device = await registerDevice(hub, created.accessToken)
  const refreshed = (await hub.post('/v1/auth/refresh', { refreshToken: created.refreshToken })).body
  await hub.post('/v1/auth/logout', undefined, { token: refreshed.accessToken })

  const all = hub.logs.join('')
  assert.ok(all.length > 0, 'the Hub should have logged something')

  // The password, in the clear.
  assert.equal(all.includes(PASSWORD), false, 'the password must never be logged')
  // Every token that existed during the run.
  for (const token of [created.accessToken, created.refreshToken, refreshed.accessToken, refreshed.refreshToken]) {
    assert.equal(all.includes(token), false, 'a token must never be logged')
  }
  // The private half of the device key never even reaches the Hub; the public half is not a
  // secret, but the signature is single-use proof and has no business in a log either.
  assert.equal(all.includes(device.keys.publicKey), false, 'the public key should not be logged')
  // The phone number, in full.
  assert.equal(all.includes(PHONE_A), false, 'the full phone number must never be logged')
  assert.equal(all.includes('13800138000'), false, 'nor its national form')
})

test('the audit trail keeps a masked phone, and the access log keeps none at all', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })
  await hub.post('/v1/auth/login', { phone: PHONE_A, password: 'the wrong password' })

  // Two different records, two different jobs. The access log answers "what did the service
  // do" and deliberately carries no identity at all: the phone is in the request body, and
  // bodies are never logged.
  assert.equal(hub.logs.join('').includes('8000'), false, 'the access log holds no phone, masked or not')

  // The audit trail answers "who did what", so it needs enough of the number to follow one
  // account without itself becoming the list of everyone's numbers.
  const events = hub.hub.audit.list()
  const target = events.find(event => event.target_id !== null)
  assert.ok(target !== undefined, 'a failed login should be audited')
  assert.equal(target.target_id, '+86****8000')
  assert.equal(JSON.stringify(events).includes(PHONE_A), false)
})

test('every secret-shaped key is replaced, whatever its case', () => {
  const redacted = redactFields({
    password: 'hunter2',
    accessToken: 'dsb_at_abc',
    refresh_token: 'dsb_rt_abc',
    Authorization: 'Bearer x',
    privateKey: 'PEM',
    signature: 'sig',
    phone: '+8613800138000',
    // Keys that are not secret stay readable: a log of only [redacted] is worthless.
    status: 200,
    durationMs: 12,
  })
  assert.equal(redacted.password, REDACTED)
  assert.equal(redacted.accessToken, REDACTED)
  assert.equal(redacted.refresh_token, REDACTED)
  assert.equal(redacted.Authorization, REDACTED)
  assert.equal(redacted.privateKey, REDACTED)
  assert.equal(redacted.signature, REDACTED)
  assert.equal(redacted.phone, '+86****8000')
  assert.equal(redacted.status, 200)
  assert.equal(redacted.durationMs, 12)
})

test('a secret quoted into free text is redacted too', () => {
  // An error message is the realistic leak: "failed for token dsb_rt_..." reads as harmless
  // and is a working credential.
  const text = redactText('auth failed for +8613800138000 using dsb_rt_abcdefghijklmnop')
  assert.equal(text.includes('13800138000'), false)
  assert.equal(text.includes('dsb_rt_abcdefghijklmnop'), false)
  assert.ok(text.includes('+86****8000'))
  assert.ok(text.includes(REDACTED))
})

test('the logger writes one JSON object per line', () => {
  const { lines, logger } = createMemoryLogger()
  logger.info('http.request', { method: 'GET', status: 200 })
  logger.warn('auth.denied', { phone: '+8613800138000' })

  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  assert.equal(first.event, 'http.request')
  assert.equal(first.level, 'info')
  assert.equal(first.status, 200)
  assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/)
  // A line is one object: a newline inside a value would split it into two unparseable halves.
  assert.equal(lines.join('').split('\n').filter(Boolean).length, 2)
})

test('an error object is logged without its stack or its secret message', () => {
  const { lines, logger } = createMemoryLogger()
  const error = Object.assign(new Error('login failed for +8613800138000'), { code: 'auth/invalid-credentials' })
  logger.error('http.unhandled', { error })

  const logged = JSON.parse(lines[0])
  assert.equal(logged.error.code, 'auth/invalid-credentials')
  assert.equal(JSON.stringify(logged).includes('13800138000'), false)
})

test('a custom stream is the only place lines go', () => {
  // The Hub must never write to stdout implicitly: in the Desktop it would land in the app's
  // own log and from there anywhere.
  const written = []
  const logger = createLogger({ stream: { write: (text) => { written.push(text); return true } } })
  logger.info('hub.ready', { url: 'http://127.0.0.1:7788' })
  assert.equal(written.length, 1)
})
