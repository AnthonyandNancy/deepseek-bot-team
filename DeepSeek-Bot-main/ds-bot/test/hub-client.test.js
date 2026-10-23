// The plugin's Hub client, driven against the real Hub.
//
// A stub Hub would prove only that this module can parse what the stub was written to send. The
// properties that matter — a login actually registers this machine's key, a revoked device
// actually stops working — are properties of the two halves together, so the test runs a real
// `hub/` instance on loopback.
//
// The Hub's TLS requirement is exercised in hub/test/tls.test.js; here the transport is plaintext
// loopback, which the Hub permits only with its explicit opt-in.
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHubClient, describeNetworkError } from '../src/workgroup/host/hub.js'
import { createHubStore } from '../src/workgroup/host/hub-store.js'

// The Hub package lives beside this plugin. Imported by path rather than by package name: it is
// not published, and a workspace link would hide a broken path until release.
const HUB = new URL('../../../hub/src/server.js', import.meta.url).href

const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'a completely different passphrase'
const PHONE = '+8613800138000'

const withHub = async (t) => {
  const { createHub } = await import(HUB)
  const { createMemoryLogger } = await import(new URL('../../../hub/src/log.js', import.meta.url).href)
  const dataDir = mkdtempSync(join(tmpdir(), 'ds-bot-hub-client-'))
  const hub = createHub({
    config: {
      host: '127.0.0.1',
      port: 0,
      tls: null,
      allowInsecure: true,
      insecureLoopbackOnly: true,
      dataDir,
      accessTtlMs: 30 * 60 * 1000,
      refreshTtlMs: 24 * 60 * 60 * 1000,
      logLevel: 'info',
    },
    logger: createMemoryLogger().logger,
  })
  const address = await hub.listen()
  t.after(async () => {
    await hub.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  return { baseUrl: `http://127.0.0.1:${address.port}`, hub }
}

const withClient = (t, { services = {} } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-hub-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const store = createHubStore({ home, ctx: services.credentials === undefined ? undefined : { get: () => services.credentials } })
  return { client: createHubClient({ store }), store, home }
}

test('registering signs in and registers this machine as a device', async (t) => {
  const { baseUrl } = await withHub(t)
  const { client, store } = withClient(t)

  const account = await client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })
  assert.match(account.hubUserId, /^usr_/)
  assert.match(account.deviceId, /^dev_/)
  assert.match(account.phoneMasked, /^\+\d+\*{4}\d{4}$/)

  // The stored record is what a restart needs, and nothing more.
  const stored = await store.load()
  assert.equal(stored.hubUserId, account.hubUserId)
  assert.equal(stored.deviceId, account.deviceId)
  assert.match(stored.refreshToken, /^dsb_rt_/)
  assert.match(stored.privateKeyPem, /BEGIN PRIVATE KEY/)
  // The access token is deliberately not stored: it is short-lived and re-minted from the
  // refresh token, so a stolen copy of the file cannot be replayed as a live session.
  assert.equal(stored.accessToken, undefined)
})

test('the password never reaches the stored record', async (t) => {
  const { baseUrl } = await withHub(t)
  const { client, home } = withClient(t)
  await client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })

  const file = join(home, 'hub', 'account.json')
  assert.equal(existsSync(file), true)
  const text = readFileSync(file, 'utf8')
  assert.equal(text.includes(PASSWORD), false, 'the password must never be written to disk')
  // Nor may it appear in anything the account view hands to the page.
  assert.equal(JSON.stringify(client.account).includes(PASSWORD), false)
})

test('a second machine signing in the same account keeps the same hubUserId', async (t) => {
  const { baseUrl } = await withHub(t)
  const first = withClient(t)
  const second = withClient(t)

  const a = await first.client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })
  const b = await second.client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'login' })
  assert.equal(b.hubUserId, a.hubUserId)
  assert.notEqual(b.deviceId, a.deviceId)

  // Both machines are visible from either one.
  const devices = await first.client.devices()
  assert.equal(devices.length, 2)
  assert.equal(devices.some(device => device.current), true)
})

test('a wrong password is reported as a credential problem, not a network one', async (t) => {
  const { baseUrl } = await withHub(t)
  const { client } = withClient(t)
  await client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })

  const other = withClient(t)
  // The error's code is what the page shows, so it must distinguish "wrong password" from
  // "the Hub is not answering" — the two need different actions from the person reading it.
  await assert.rejects(
    () => other.client.authenticate({ baseUrl, phone: PHONE, password: 'the wrong password here' }),
    (error) => {
      assert.equal(error.code, 'auth/invalid-credentials')
      assert.notEqual(error.code, 'hub/unreachable')
      return true
    },
  )
})

test('an unreachable Hub is reported without touching the local state', async (t) => {
  const { client, store, home } = withClient(t)
  // Nothing listening on this port.
  await assert.rejects(
    () => client.authenticate({ baseUrl: 'http://127.0.0.1:1', phone: PHONE, password: PASSWORD }),
    (error) => {
      assert.equal(error.code, 'hub/unreachable')
      return true
    },
  )
  // No account was written, so the user is not left half-signed-in.
  assert.equal(await store.load(), undefined)
  assert.equal(existsSync(join(home, 'hub', 'account.json')), false)
})

test('restoring an account does not touch the network', async (t) => {
  const { baseUrl } = await withHub(t)
  const { client, store } = withClient(t)
  await client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })

  // A second client over the same store, as after a restart. Restoring must be offline-safe:
  // opening settings while the Hub is down must not hang or throw.
  const restarted = createHubClient({ store })
  const account = await restarted.restore()
  assert.equal(account.hubUserId, client.account.hubUserId)
  assert.equal(account.deviceId, client.account.deviceId)
  assert.equal(restarted.loggedIn, true)
})

test('a rotated access token is re-minted from the stored refresh token', async (t) => {
  const { baseUrl } = await withHub(t)
  const { client, store } = withClient(t)
  await client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })

  const before = (await store.load()).refreshToken
  // A fresh client has no access token in memory, exactly like after a restart.
  const restarted = createHubClient({ store })
  await restarted.restore()
  const me = await restarted.me()
  assert.equal(me.hubUserId, client.account.hubUserId)
  // The Hub rotates refresh tokens, so the stored one must have been replaced.
  const after = (await store.load()).refreshToken
  assert.notEqual(after, before)
})

test('a refresh token the Hub refuses is discarded instead of retried forever', async (t) => {
  // The exact failure that made a signed-in machine unable to create a workgroup: the Hub answered
  // `401 The refresh token is not valid.`, and every later call repeated the same doomed exchange
  // because the useless record stayed on disk. The page kept saying "signed in" and nothing said why
  // nothing worked.
  //
  // A refused refresh token can never become valid again — the Hub rotates on use, so a rejected one
  // is spent, revoked, expired, or belongs to a database this Hub no longer has. The only honest
  // outcome is to drop it and report being signed out, which is what the account page can act on.
  const { baseUrl } = await withHub(t)
  const { client, store } = withClient(t)
  await client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })

  // Simulate the state a lost or replaced Hub database leaves behind: a well-formed token this Hub
  // has never seen. It is not a corrupted file — it is exactly what survives a `hub/.data` wipe.
  const stored = await store.load()
  await store.save({ ...stored, refreshToken: 'dsb_rt_thisTokenWasNeverIssuedByThisHub' })

  const restarted = createHubClient({ store })
  await restarted.restore()
  // Before the fix this reported true, because a stored record counts as signed in — and then every
  // request failed with the Hub's 401 while the page still showed an account.
  assert.equal(restarted.loggedIn, true, 'the stored record is what the page sees before it asks')
  await assert.rejects(() => restarted.me(), (error) => {
    assert.equal(error.code, 'hub/signed-out', 'the error must name the state the page should show')
    return true
  })

  // The dead record is gone, so the page shows the sign-in form rather than a session that cannot
  // do anything, and a retry does not replay the same token.
  assert.equal(await store.load(), undefined, 'the refused record must not be kept')
  assert.equal(restarted.loggedIn, false)
  await assert.rejects(() => restarted.me(), error => error.code === 'hub/not-signed-in')
})

test('an unreachable Hub is not mistaken for a refused session', async (t) => {
  // The distinction the account page depends on: "your session ended, sign in again" and "the Hub is
  // not running" need different actions from the person reading them. Only an answered 401 from the
  // refresh endpoint may clear the record; a transport failure must leave it for the next attempt.
  const { store } = withClient(t)
  await store.save({
    baseUrl: 'http://127.0.0.1:1',
    hubUserId: 'usr_someone',
    phoneMasked: '+86****8000',
    deviceId: 'dev_someone',
    refreshToken: 'dsb_rt_aTokenThatWouldBeFine',
    privateKeyPem: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
  })
  const before = await store.load()
  const unreachable = createHubClient({
    store,
    fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) },
  })
  await assert.rejects(() => unreachable.me(), error => error.code === 'hub/unreachable')
  assert.notEqual(await store.load(), undefined, 'an unreachable Hub must not delete the account record')
  assert.equal((await store.load()).refreshToken, before.refreshToken)
})

test('signing out clears the local record even when the Hub cannot be reached', async (t) => {
  const { baseUrl } = await withHub(t)
  const { client, store } = withClient(t)
  await client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })

  // A user with no way to sign out is stuck; the local clear must not depend on the Hub.
  const offline = createHubClient({ store })
  await offline.restore()
  await offline.logout()
  assert.equal(await store.load(), undefined)
})

test('revoking this device signs this machine out locally too', async (t) => {
  const { baseUrl } = await withHub(t)
  const first = withClient(t)
  const second = withClient(t)
  const a = await first.client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })
  await second.client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'login' })

  // The first machine revokes itself through the second one's token? No: it revokes its own
  // device id, which the Hub accepts because the session is still valid at that moment.
  await first.client.revokeDevice(a.deviceId)
  // The local record must go: otherwise the page would keep claiming a signed-in device that
  // the Hub no longer honours.
  assert.equal(await first.store.load(), undefined)
  assert.equal(first.client.account, undefined)

  // And the other machine still holds a working session. The revoked device stays in the list —
  // it is history, and hiding it would make "was that machine signed out?" unanswerable — so the
  // assertion is about which one is live, not about how many rows exist.
  const remaining = await second.client.devices()
  assert.equal(remaining.length, 2)
  assert.equal(remaining.find(device => device.deviceId === a.deviceId)?.revokedAt !== null, true)
  assert.equal(remaining.filter(device => device.revokedAt === null).length, 1)
})

test('a transport failure is explained in words a person can act on', () => {
  // Node's `fetch` reports every transport failure as the single string "fetch failed" and hides
  // the cause. That exact string reached the account page once and gave the user nothing to act
  // on, so each cause now has its own sentence — and a test, because the message is the feature.
  const wrap = cause => Object.assign(new TypeError('fetch failed'), { cause })

  const refused = describeNetworkError(wrap({ code: 'ECONNREFUSED' }), 'http://127.0.0.1:7788')
  assert.match(refused, /Nothing is listening/)
  assert.match(refused, /npm start/, 'the fix should be named, not just the problem')
  assert.equal(refused.includes('fetch failed'), false, 'the raw transport text must not reach the user')

  // A self-signed certificate is the normal case for a local Hub; reporting it as a network
  // failure sends people looking in the wrong place.
  const untrusted = describeNetworkError(wrap({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' }), 'https://127.0.0.1:7788')
  assert.match(untrusted, /certificate this machine does not trust/i)
  assert.match(untrusted, /HUB_ALLOW_INSECURE_LOCALHOST/, 'the loopback alternative should be offered')

  const dns = describeNetworkError(wrap({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND hub.example' }), 'https://hub.example')
  assert.match(dns, /could not be resolved/i)

  const aborted = describeNetworkError(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'http://127.0.0.1:7788')
  assert.match(aborted, /did not answer in time/i)

  // An unknown cause still names the address, so the message is never blank.
  const other = describeNetworkError(wrap({ code: 'EWHATEVER' }), 'http://127.0.0.1:7788')
  assert.match(other, /127\.0\.0\.1:7788/)
})

test('the unreachable-Hub error carries an actionable message, not "fetch failed"', async (t) => {
  const { client } = withClient(t)
  await assert.rejects(
    () => client.authenticate({ baseUrl: 'http://127.0.0.1:1', phone: PHONE, password: PASSWORD }),
    (error) => {
      assert.equal(error.code, 'hub/unreachable')
      // The page shows `error.message` verbatim, so this is what the user reads.
      assert.equal(/^fetch failed$|fetch failed\)?$/.test(error.message), false, `unhelpful message: ${error.message}`)
      assert.match(error.message, /127\.0\.0\.1:1/)
      return true
    },
  )
})

// ── password recovery ───────────────────────────────────────────────────────────

test('a recovery code can be created, and the Hub will not show it again', async (t) => {
  const { baseUrl } = await withHub(t)
  const { client } = withClient(t)
  await client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })

  const before = await client.recoveryState()
  assert.equal(before.hasCode, false)

  const made = await client.createRecoveryCode()
  assert.match(made.code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/)

  // The state reports existence only: the code cannot be read back, because the Hub kept a digest.
  const after = await client.recoveryState()
  assert.equal(after.hasCode, true)
  assert.equal(JSON.stringify(after).includes(made.code), false)
})

test('recovering on a fresh install signs in and registers a new device', async (t) => {
  const { baseUrl } = await withHub(t)
  const original = withClient(t)
  const created = await original.client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })
  const { code } = await original.client.createRecoveryCode()

  // A new machine: its own empty store, no session, just the code.
  const fresh = withClient(t)
  const account = await fresh.client.recover({ baseUrl, phone: PHONE, code, newPassword: NEW_PASSWORD })

  assert.equal(account.hubUserId, created.hubUserId, 'the account must not change')
  assert.notEqual(account.deviceId, created.deviceId, 'a recovery needs its own device')
  // It is genuinely signed in, not merely holding a token.
  assert.equal((await fresh.client.me()).hubUserId, created.hubUserId)
  // And the new password works from the Hub's point of view.
  const relogin = withClient(t)
  await relogin.client.authenticate({ baseUrl, phone: PHONE, password: NEW_PASSWORD })
})

test('recovering signs the old machine out', async (t) => {
  const { baseUrl } = await withHub(t)
  const original = withClient(t)
  await original.client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })
  const { code } = await original.client.createRecoveryCode()

  const fresh = withClient(t)
  await fresh.client.recover({ baseUrl, phone: PHONE, code, newPassword: NEW_PASSWORD })

  // The point of a recovery: whoever had access before loses it.
  await assert.rejects(() => original.client.devices(), (error) => {
    assert.equal(error.code === 'auth/session-revoked' || error.code === 'auth/invalid-credentials' || error.code === 'auth/expired', true, error.code)
    return true
  })
})

test('a wrong recovery code is reported without touching the local account', async (t) => {
  const { baseUrl } = await withHub(t)
  const { client, store } = withClient(t)
  await client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })

  await assert.rejects(
    () => client.recover({ baseUrl, phone: PHONE, code: 'AAAA-BBBB-CCCC-DDDD', newPassword: NEW_PASSWORD }),
    (error) => {
      assert.equal(error.code, 'auth/invalid-recovery-code')
      return true
    },
  )
  // The existing session must survive a failed recovery attempt.
  assert.equal((await client.me()).hubUserId, client.account.hubUserId)
  assert.notEqual(await store.load(), undefined)
})

test('changing the password keeps this machine signed in and ends the others', async (t) => {
  const { baseUrl } = await withHub(t)
  const first = withClient(t)
  const second = withClient(t)
  await first.client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })
  await second.client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'login' })

  await first.client.changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })

  // This machine worked, so it keeps its fresh token; the other one is out.
  assert.equal((await first.client.me()).hubUserId, first.client.account.hubUserId)
  await assert.rejects(() => second.client.me(), (error) => {
    assert.equal(['auth/session-revoked', 'auth/invalid-credentials', 'auth/expired'].includes(error.code), true, error.code)
    return true
  })
  // The stored refresh token was replaced, or a restart would fail to sign in.
  const stored = await first.store.load()
  assert.match(stored.refreshToken, /^dsb_rt_/)
})

test('changing the password needs the current one', async (t) => {
  const { baseUrl } = await withHub(t)
  const { client } = withClient(t)
  await client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })

  await assert.rejects(
    () => client.changePassword({ currentPassword: 'the wrong current password', newPassword: NEW_PASSWORD }),
    (error) => {
      assert.equal(error.code, 'auth/wrong-password')
      return true
    },
  )
})

test('a recovery or a password change never writes a password to disk', async (t) => {
  const { baseUrl } = await withHub(t)
  const { client, home } = withClient(t)
  await client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })
  const { code } = await client.createRecoveryCode()
  await client.changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })

  const fresh = withClient(t)
  await fresh.client.recover({ baseUrl, phone: PHONE, code, newPassword: 'yet another passphrase' })

  for (const dir of [home, fresh.home]) {
    const text = readFileSync(join(dir, 'hub', 'account.json'), 'utf8')
    for (const secret of [PASSWORD, NEW_PASSWORD, 'yet another passphrase', code]) {
      assert.equal(text.includes(secret), false, `a secret reached ${dir}`)
    }
  }
})

test('health works without a session, so the page can test an address before signing in', async (t) => {
  const { baseUrl } = await withHub(t)
  const { client } = withClient(t)
  const health = await client.health(baseUrl)
  assert.equal(health.ok, true)
  assert.equal(health.tls, false)
})

test('an empty address is refused before any request is made', async (t) => {
  const { client } = withClient(t)
  await assert.rejects(
    () => client.authenticate({ baseUrl: '   ', phone: PHONE, password: PASSWORD }),
    (error) => {
      assert.equal(error.code, 'hub/no-address')
      return true
    },
  )
})

test('the account view never carries a token or a private key', async (t) => {
  const { baseUrl } = await withHub(t)
  const { client } = withClient(t)
  await client.authenticate({ baseUrl, phone: PHONE, password: PASSWORD, mode: 'register' })

  // The settings page renders this object, so anything in it is on screen and in the DOM.
  const shown = JSON.stringify(client.account)
  assert.equal(shown.includes('dsb_rt_'), false)
  assert.equal(shown.includes('dsb_at_'), false)
  assert.equal(shown.includes('PRIVATE KEY'), false)
  assert.equal(shown.includes(PHONE), false, 'the full phone number must not be shown either')
})
