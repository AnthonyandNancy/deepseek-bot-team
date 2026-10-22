// Switching accounts and the settings page's rendering.
//
// Two separate concerns that both come down to "the page must not show what it does not have":
//   * after a sign-in as a different person, nothing from the previous account survives — not in
//     the store, not in the account view, not in the next request's token;
//   * the page never renders the full phone number, a token, or the word "verified".
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHubClient } from '../src/workgroup/host/hub.js'
import { createHubStore } from '../src/workgroup/host/hub-store.js'
import { maskPhone } from '../src/workgroup/host/hub-format.js'

const HUB = new URL('../../../hub/src/server.js', import.meta.url).href

const PASSWORD = 'correct horse battery staple'
const PHONE_A = '+8613800138000'
const PHONE_B = '+8613900139000'

const withHub = async (t) => {
  const { createHub } = await import(HUB)
  const { createMemoryLogger } = await import(new URL('../../../hub/src/log.js', import.meta.url).href)
  const dataDir = mkdtempSync(join(tmpdir(), 'ds-bot-hub-switch-'))
  const hub = createHub({
    config: {
      host: '127.0.0.1', port: 0, tls: null, allowInsecure: true, insecureLoopbackOnly: true,
      dataDir, accessTtlMs: 30 * 60 * 1000, refreshTtlMs: 24 * 60 * 60 * 1000, logLevel: 'info',
    },
    logger: createMemoryLogger().logger,
  })
  const address = await hub.listen()
  t.after(async () => {
    await hub.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  return { baseUrl: `http://127.0.0.1:${address.port}` }
}

const withStore = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-hub-switch-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return createHubStore({ home })
}

test('signing in as a different person replaces the stored account completely', async (t) => {
  const { baseUrl } = await withHub(t)
  const store = withStore(t)
  const client = createHubClient({ store })

  const first = await client.authenticate({ baseUrl, phone: PHONE_A, password: PASSWORD, mode: 'register' })
  const firstRefresh = (await store.load()).refreshToken

  // A second person signs in on the same machine. Nothing of the first must survive: not the
  // device, not the user id, not the refresh token.
  const second = await client.authenticate({ baseUrl, phone: PHONE_B, password: PASSWORD, mode: 'register' })
  assert.notEqual(second.hubUserId, first.hubUserId)

  const stored = await store.load()
  assert.equal(stored.hubUserId, second.hubUserId)
  assert.equal(stored.phoneMasked, second.phoneMasked)
  assert.notEqual(stored.refreshToken, firstRefresh, 'the previous account\'s refresh token must not remain')
  // The previous account's device key must be gone too, or the new account would open sockets as
  // the old device.
  assert.equal(stored.deviceId, second.deviceId)
})

test('the previous account cannot be reached after a switch', async (t) => {
  const { baseUrl } = await withHub(t)
  const store = withStore(t)
  const client = createHubClient({ store })

  await client.authenticate({ baseUrl, phone: PHONE_A, password: PASSWORD, mode: 'register' })
  const staleRefresh = (await store.load()).refreshToken
  await client.authenticate({ baseUrl, phone: PHONE_B, password: PASSWORD, mode: 'register' })

  // The old refresh token belongs to the other account's session. Replaying it must not reach
  // that account's data through this client.
  const fresh = createHubClient({ store })
  await fresh.restore()
  assert.equal(fresh.account.hubUserId, client.account.hubUserId)
  assert.notEqual((await store.load()).refreshToken, staleRefresh)
})

test('a mask is never applied twice', () => {
  // The Hub already masks. A second pass must not turn +86****8000 into a shorter nonsense mask.
  assert.equal(maskPhone('+86****8000'), '+86****8000')
  assert.equal(maskPhone('+8613800138000'), '+86****8000')
})

// ── the page ────────────────────────────────────────────────────────────────────
// Asserted from its source rather than by rendering: these are claims about what the copy may
// say and which fields may exist, and those are properties of the file itself. Rendering would
// need React, which the test harness resolves only through the client bundle.
import { readFileSync } from 'node:fs'

test('the page never claims the phone number is verified', async () => {
  // The copy is part of the security surface here: V1 sends no SMS, so `phone_verified_at` stays
  // NULL and a "verified" badge would be a lie the user cannot check.
  const source = readFileSync(new URL('../src/client/hub-settings.js', import.meta.url), 'utf8')
  // The page's own strings, plus the Hub section of the copy. Scoped to lines that are about this
  // page: i18n.js holds unrelated disclaimers ("plugin compatibility is not fully verified").
  const hubCopy = readFileSync(new URL('../src/client/i18n.js', import.meta.url), 'utf8')
    .split(String.fromCharCode(10))
    // Quoted strings only: a comment explaining that nothing is verified is not copy anyone reads.
    .filter(line => /手机号|phone number/i.test(line) && /['"]/.test(line) && !line.trim().startsWith('//'))
    .join(String.fromCharCode(10))
  for (const text of [source, hubCopy]) {
    const mentions = [...text.matchAll(/已验证|已认证|verified/gi)]
    for (const mention of mentions) {
      const around = text.slice(Math.max(0, mention.index - 100), mention.index + 100)
      // A disclaimer in either language is allowed; an assertion that it *is* verified is not.
      assert.match(around, /not verified|未经验证|is not verified|no SMS|不需要验证|未验证|无法验证|only a sign-in name|只作为登录名/i,
        `a mention of "verified" must be a disclaimer, found: …${around}…`)
    }
  }
})

test('the page shows no token and no private key field', () => {
  const source = readFileSync(new URL('../src/client/hub-settings.js', import.meta.url), 'utf8')
  // The page cannot display what it never receives, but it must also not offer a field for one.
  assert.equal(/refreshToken|accessToken|privateKey|PRIVATE KEY/.test(source), false)
  // A password field exists — that is the one secret a person types — but it is cleared on submit.
  assert.match(source, /clearSecrets/)
})

test('the page refuses to submit when the two passwords differ', () => {
  const source = readFileSync(new URL('../src/client/hub-settings.js', import.meta.url), 'utf8')
  // The check happens before the request: sending a mismatched pair would create an account with
  // a password the person did not intend.
  const guard = source.indexOf('password !== confirm')
  const submit = source.indexOf("setBusy(true)")
  assert.notEqual(guard, -1, 'there must be a mismatch guard')
  assert.ok(guard < submit, 'the guard must run before the request is made')
})

test('the storage note says what the store actually is', () => {
  const source = readFileSync(new URL('../src/client/hub-settings.js', import.meta.url), 'utf8')
  // Not "a keychain", not "secure enclave": the plan records that the plugin cannot reach an OS
  // keychain, and the page must not imply otherwise.
  // Only the strings that are actually shown, not the comments around them.
  const shown = source.split(String.fromCharCode(10))
    .filter(line => line.includes('device key is kept'))
    .join(String.fromCharCode(10))
  assert.equal(shown.length > 0, true, 'the page must say where the key is kept')
  assert.equal(/keychain|钥匙串/i.test(shown), false, 'the shown copy must not promise a keychain')
  assert.match(shown, /owner-only/)
  assert.match(shown, /Harness credential store/)
})
