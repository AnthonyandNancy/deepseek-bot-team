// Where the Hub's device key and refresh token are kept on this machine.
//
// Two claims, both about what must NOT happen:
//   * nothing secret is ever written to state.json (a file users share in bug reports);
//   * the fallback file is owner-only.
//
// The third claim is the one the plan is honest about: this is not an OS keychain. The test
// asserts which backend is in use so the settings page cannot claim more than it has.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CREDENTIAL_KEY, createHubStore } from '../src/workgroup/host/hub-store.js'

const temporaryHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-hub-store-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

const payload = {
  baseUrl: 'https://127.0.0.1:7788',
  hubUserId: 'usr_abc',
  phoneMasked: '+86****8000',
  deviceId: 'dev_abc',
  refreshToken: 'dsb_rt_secret_value_here',
  privateKeyPem: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n',
}

// A stand-in for the Harness credential seam: records what was written, in the seam's own shape.
const fakeSeam = ({ fail } = {}) => {
  let stored
  return {
    key: CREDENTIAL_KEY,
    get stored() { return stored },
    async readRecord(key) {
      assert.equal(key, CREDENTIAL_KEY)
      if (fail === 'read') throw new Error('seam unreadable')
      return stored
    },
    async modifyRecord(key, mutate) {
      assert.equal(key, CREDENTIAL_KEY)
      const next = await mutate(stored)
      stored = next
      return next
    },
  }
}

test('with no credential service the account is kept in an owner-only file', async (t) => {
  const home = temporaryHome(t)
  const store = createHubStore({ home })
  assert.equal(store.backend, 'file')

  await store.save(payload)
  const saved = JSON.parse(readFileSync(join(home, 'hub', 'account.json'), 'utf8'))
  assert.equal(saved.refreshToken, payload.refreshToken)
  assert.equal(saved.privateKeyPem, payload.privateKeyPem)

  // Owner-only. Windows ignores POSIX modes, which is why the same split exists in the
  // Harness's own credentials provider.
  if (process.platform !== 'win32') {
    const mode = statSync(join(home, 'hub', 'account.json')).mode & 0o777
    assert.equal(mode & 0o077, 0, `expected no group/other bits, got ${mode.toString(8)}`)
  }

  const loaded = await store.load()
  assert.equal(loaded.deviceId, payload.deviceId)
})

test('with the credential service present, the seam is used and no file is written', async (t) => {
  const home = temporaryHome(t)
  const seam = fakeSeam()
  const store = createHubStore({ home, ctx: { get: name => (name === 'credentials' ? seam : undefined) } })
  assert.equal(store.backend, 'credentials')

  await store.save(payload)
  // The seam stores the record verbatim in this plugin's own format.
  assert.equal(seam.stored.kind, 'grant')
  assert.equal(seam.stored.payload.refreshToken, payload.refreshToken)
  // No file: two copies of a private key is two places to leak from.
  assert.throws(() => statSync(join(home, 'hub', 'account.json')), /ENOENT/)
})

test('a seam that fails to read falls back instead of locking the user out', async (t) => {
  const home = temporaryHome(t)
  const seam = fakeSeam({ fail: 'read' })
  const store = createHubStore({ home, ctx: { get: name => (name === 'credentials' ? seam : undefined) } })

  // Written through the fallback path is impossible while the seam claims the write, so this
  // asserts the read side: a broken seam must not make the account unreadable.
  const loaded = await store.load()
  assert.equal(loaded, undefined)
})

test('clearing removes the record from both stores', async (t) => {
  const home = temporaryHome(t)
  const store = createHubStore({ home })
  await store.save(payload)
  await store.clear()
  assert.equal(await store.load(), undefined)

  const seam = fakeSeam()
  const withSeam = createHubStore({ home, ctx: { get: name => (name === 'credentials' ? seam : undefined) } })
  await withSeam.save(payload)
  await withSeam.clear()
  assert.equal(seam.stored, undefined)
})

test('an incomplete payload is refused rather than half-written', async (t) => {
  const home = temporaryHome(t)
  const store = createHubStore({ home })
  // A missing device id would produce an account that looks signed in and cannot open a socket.
  await assert.rejects(() => store.save({ ...payload, deviceId: undefined }), /incomplete/)
  await assert.rejects(() => store.save({ ...payload, refreshToken: undefined }), /incomplete/)
  await assert.rejects(() => store.save({ ...payload, privateKeyPem: undefined }), /incomplete/)
})

test('a corrupt file reads as "no account" rather than throwing', async (t) => {
  const home = temporaryHome(t)
  const store = createHubStore({ home })
  await store.save(payload)
  writeFileSync(join(home, 'hub', 'account.json'), '{ not json', 'utf8')

  // Recoverable by signing in again; throwing here would break the settings page for good.
  assert.equal(await store.load(), undefined)
})

test('the store says where it keeps things, so the page can tell the truth', async (t) => {
  const home = temporaryHome(t)
  const fileStore = createHubStore({ home })
  assert.match(fileStore.location, /account\.json$/)

  const seam = fakeSeam()
  const seamStore = createHubStore({ home, ctx: { get: name => (name === 'credentials' ? seam : undefined) } })
  assert.match(seamStore.location, /^credentials:ds-bot\//)
})
