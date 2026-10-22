// Shared test support: build a Hub the way the process does, on a port of the OS's choosing,
// over plaintext loopback (the one mode the config allows without a certificate), and drive
// it with real HTTP requests.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/server.js'
import { createMemoryLogger } from '../src/log.js'

// A config as loadConfig would produce it, with the test's own data directory and port 0.
export function testConfig(overrides = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    tls: null,
    allowInsecure: true,
    insecureLoopbackOnly: true,
    dataDir: mkdtempSync(join(tmpdir(), 'hub-test-')),
    accessTtlMs: 30 * 60 * 1000,
    refreshTtlMs: 30 * 24 * 60 * 60 * 1000,
    logLevel: 'info',
    ...overrides,
  }
}

export async function startHub(overrides = {}) {
  const config = testConfig(overrides)
  const { lines, logger } = createMemoryLogger()
  // A clock the test can move. Expiry is then a fact rather than a race: sleeping for a TTL
  // would make a slow machine fail a test that nothing is wrong with.
  const clock = { offset: 0, now: () => Date.now() + clock.offset, advanceBy(ms) { clock.offset += ms } }
  const hub = createHub({ config, logger, now: clock.now })
  const address = await hub.listen()
  const base = `${address.scheme}://127.0.0.1:${address.port}`

  const request = async (method, path, { body, token, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let json
    try { json = text.length === 0 ? undefined : JSON.parse(text) } catch { json = text }
    return { status: response.status, body: json, headers: response.headers }
  }

  return {
    hub,
    config,
    base,
    logs: lines,
    clock,
    request,
    post: (path, body, options) => request('POST', path, { body, ...options }),
    get: (path, options) => request('GET', path, options),
    async close() {
      await hub.close()
      rmSync(config.dataDir, { recursive: true, force: true })
    },
  }
}

// A password that passes the policy, and two phone numbers that do not collide.
export const PASSWORD = 'correct horse battery staple'
export const PHONE_A = '+8613800138000'
export const PHONE_B = '+8613900139000'

// ── device support ────────────────────────────────────────────────────────────────
// Shared by every test that needs a registered device, so the signing bytes live in one place
// and a protocol change cannot leave one test asserting against the old shape.
import { generateKeyPairSync, sign } from 'node:crypto'

export const newKeyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), privateKey }
}

export const signChallenge = (keys, challengeId, nonce) =>
  sign(null, Buffer.from(`${challengeId}.${nonce}`), keys.privateKey).toString('base64')

// Registers a device the way a real client does: ask for a challenge, sign it, send it back.
export async function registerDevice(hub, token, { name = 'Test device', platform = 'test', keys = newKeyPair() } = {}) {
  const challenge = await hub.post('/v1/devices/challenge', { publicKey: keys.publicKey }, { token })
  if (challenge.status !== 200) throw new Error(`challenge failed: ${challenge.status} ${JSON.stringify(challenge.body)}`)
  const registered = await hub.post('/v1/devices/register', {
    challengeId: challenge.body.challengeId,
    signature: signChallenge(keys, challenge.body.challengeId, challenge.body.nonce),
    name,
    platform,
  }, { token })
  if (registered.status !== 200) throw new Error(`register failed: ${registered.status} ${JSON.stringify(registered.body)}`)
  return { ...registered.body, keys, challenge: challenge.body }
}
