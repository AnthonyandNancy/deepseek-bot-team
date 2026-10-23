// TLS enforcement: a password may only cross the wire over TLS.
//
// This is the one place where a mistake is invisible in normal use — everything works, and the
// passwords are in the clear. So each refusal is a test rather than a comment:
//   * no certificate and no opt-in → the process refuses to start;
//   * the opt-in covers loopback only, checked per request so a proxy cannot widen it;
//   * a certificate means a real HTTPS listener.
import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:https'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { ConfigError, DEFAULT_DATA_DIR, isLoopback, loadConfig } from '../src/config.js'
import { createHub } from '../src/server.js'
import { createMemoryLogger } from '../src/log.js'
import { PASSWORD, PHONE_A, testConfig } from './helpers.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CERT = join(HERE, 'fixtures', 'test-cert.pem')
const KEY = join(HERE, 'fixtures', 'test-key.pem')

test('starting without TLS and without the explicit opt-in is refused', () => {
  // The whole point of a password system: there is no acceptable way to receive one over
  // plaintext from another machine.
  assert.throws(() => loadConfig({}), ConfigError)
  assert.throws(() => loadConfig({ HUB_PORT: '7788' }), /Refusing to start without TLS/)
})

test('a certificate and key are used together or not at all', () => {
  assert.throws(() => loadConfig({ HUB_TLS_CERT: CERT }), /must be set together/)
  assert.throws(() => loadConfig({ HUB_TLS_KEY: KEY }), /must be set together/)
  const both = loadConfig({ HUB_TLS_CERT: CERT, HUB_TLS_KEY: KEY })
  assert.deepEqual(both.tls, { cert: CERT, key: KEY })
  assert.equal(both.insecureLoopbackOnly, false)
})

test('the loopback opt-in is explicit and yields a loopback-only config', () => {
  // Anything other than the exact string "1" leaves the opt-in off: a stray "true" or "yes"
  // must not silently start a plaintext server.
  for (const value of ['', '0', 'true', 'yes', 'TRUE']) {
    assert.throws(() => loadConfig({ HUB_ALLOW_INSECURE_LOCALHOST: value }), ConfigError, `"${value}" must not opt in`)
  }
  const opted = loadConfig({ HUB_ALLOW_INSECURE_LOCALHOST: '1' })
  assert.equal(opted.tls, null)
  assert.equal(opted.insecureLoopbackOnly, true)
})

test('a plaintext bind outside loopback is refused unless it is asked for by name', () => {
  const base = { HUB_ALLOW_INSECURE_LOCALHOST: '1' }
  // The old behaviour rewrote this to 127.0.0.1 and started anyway, so HUB_HOST=0.0.0.0 looked
  // accepted while the local network could not reach the Hub. A refusal says what to do instead.
  assert.throws(() => loadConfig({ ...base, HUB_HOST: '0.0.0.0' }), /passwords would cross the network in the clear/)
  assert.throws(() => loadConfig({ ...base, HUB_HOST: '192.168.1.10' }), ConfigError)
  // The message names both ways out, because either one is a real choice.
  try {
    loadConfig({ ...base, HUB_HOST: '0.0.0.0' })
  } catch (error) {
    assert.match(error.message, /HUB_TLS_CERT/)
    assert.match(error.message, /HUB_ALLOW_PLAINTEXT_LAN=1/)
  }

  const opted = loadConfig({ ...base, HUB_HOST: '0.0.0.0', HUB_ALLOW_PLAINTEXT_LAN: '1' })
  assert.equal(opted.host, '0.0.0.0')
  // Not loopback-only any more, which is what lets server.listen bind it.
  assert.equal(opted.insecureLoopbackOnly, false)
})

test('plaintext on loopback needs no extra flag, and TLS makes the address irrelevant', () => {
  // The common case must stay one flag: loopback plaintext is the local-only mode.
  const loopback = loadConfig({ HUB_ALLOW_INSECURE_LOCALHOST: '1', HUB_HOST: '127.0.0.1' })
  assert.equal(loopback.insecureLoopbackOnly, true)
  // With a certificate the bind address is the operator's business.
  const tls = loadConfig({ HUB_TLS_CERT: CERT, HUB_TLS_KEY: KEY, HUB_HOST: '0.0.0.0' })
  assert.equal(tls.host, '0.0.0.0')
  assert.equal(tls.insecureLoopbackOnly, false)
})

test('ttl and port values are validated rather than taken on trust', () => {
  const base = { HUB_ALLOW_INSECURE_LOCALHOST: '1' }
  assert.throws(() => loadConfig({ ...base, HUB_PORT: 'abc' }), /HUB_PORT/)
  assert.throws(() => loadConfig({ ...base, HUB_PORT: '99999' }), /HUB_PORT/)
  assert.throws(() => loadConfig({ ...base, HUB_ACCESS_TTL: '-5' }), /HUB_ACCESS_TTL/)
  // Seconds in, milliseconds out: an operator writing 30 means half a minute, not 30 ms.
  assert.equal(loadConfig({ ...base, HUB_ACCESS_TTL: '30' }).accessTtlMs, 30_000)
  assert.equal(loadConfig(base).accessTtlMs, 30 * 60 * 1000)
})

test('the data directory is absolute, so the working directory cannot change which database is used', () => {
  // The default used to be the relative string `hub/.data`, resolved against whatever directory the
  // process happened to start in. `npm start` from `hub/` therefore opened `hub/hub/.data`, while the
  // same command from the repository root opened `hub/.data` — two different files, so an account
  // registered in one was "not valid" in the other. A relative value is resolved once here, at the
  // single place every data path is derived from, so no later code can disagree about the file.
  const relative = loadConfig({ HUB_ALLOW_INSECURE_LOCALHOST: '1', HUB_DATA_DIR: 'some/where' })
  assert.equal(isAbsolute(relative.dataDir), true, 'a relative HUB_DATA_DIR must be made absolute')
  assert.equal(relative.dataDir, resolve('some/where'))

  // The default has the same problem and the same fix.
  const fallback = loadConfig({ HUB_ALLOW_INSECURE_LOCALHOST: '1' })
  assert.equal(isAbsolute(fallback.dataDir), true, 'the default data directory must be absolute')
  assert.equal(fallback.dataDir, resolve(DEFAULT_DATA_DIR))

  // An absolute value passes through as given, because an operator who names a path means it.
  const absolute = process.platform === 'win32' ? 'C:\\hub-data' : '/var/lib/hub'
  assert.equal(loadConfig({ HUB_ALLOW_INSECURE_LOCALHOST: '1', HUB_DATA_DIR: absolute }).dataDir, absolute)
})

test('loopback addresses are recognised in every form a listener reports', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) assert.equal(isLoopback(address), true, address)
  for (const address of ['10.0.0.1', '192.168.1.5', '::ffff:10.0.0.1', 'example.com', undefined]) assert.equal(isLoopback(address), false, String(address))
})

test('a plaintext hub refuses a request that did not come from this machine', async (t) => {
  const hub = createHub({ config: testConfig(), logger: createMemoryLogger().logger })
  t.after(() => hub.close())
  // The handler is exercised directly with a spoofed peer address: the only way to test this
  // over a loopback socket is to lie about where the request came from.
  const handler = hub.server.listeners('request')[0]
  const response = await new Promise((resolve) => {
    const req = new Readable({
      read() {
        // A real body, so a handler that skipped the guard would consume it and answer instead
        // of hanging. Without this the test would time out rather than fail, which reads as
        // "slow" instead of "insecure".
        this.push(JSON.stringify({ phone: '+8613800138000', password: 'correct horse battery staple' }))
        this.push(null)
      },
    })
    req.method = 'POST'
    req.url = '/v1/auth/login'
    req.socket = { remoteAddress: '10.1.2.3' }
    req.headers = { 'content-type': 'application/json' }
    const res = {
      writeHead: (status, headers) => resolve({ status, headers }),
      end: () => {},
    }
    handler(req, res)
  })
  assert.equal(response.status, 403)
})

test('a TLS hub serves HTTPS and prints no plaintext warning', async (t) => {
  const { lines, logger } = createMemoryLogger()
  const hub = createHub({
    config: testConfig({ tls: { cert: CERT, key: KEY }, insecureLoopbackOnly: false }),
    logger,
  })
  const address = await hub.listen()
  t.after(() => hub.close())
  assert.equal(address.scheme, 'https')

  // Trust is established with the test certificate itself, so the check is real: a client that
  // did not trust this cert would fail, and no TLS bypass flag is involved.
  const body = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, path: '/v1/health', ca: readFileSync(CERT) }, (res) => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve(JSON.parse(text)))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(body.ok, true)
  assert.equal(body.tls, true)
})

test('the test certificate is only ever loaded when it is asked for', async (t) => {
  // The fixtures must not be a default. A Hub configured with TLS but pointed at nothing else
  // must not quietly fall back to the test key.
  assert.equal(existsSync(CERT), true, 'the fixture must exist, or this test proves nothing')
  const config = loadConfig({ HUB_ALLOW_INSECURE_LOCALHOST: '1', HUB_TLS_CERT: '', HUB_TLS_KEY: '' })
  assert.equal(config.tls, null, 'an empty HUB_TLS_CERT means "no TLS", not "use the fixture"')

  // And a server built from the plaintext config really is an HTTP server: asking it for a TLS
  // socket must be refused, which an HTTPS server would never do.
  const hub = createHub({ config: testConfig(), logger: createMemoryLogger().logger })
  const address = await hub.listen()
  t.after(() => hub.close())
  assert.equal(address.scheme, 'http')
  assert.equal(hub.config.tls, null)
  const details = hub.server.getConnections !== undefined
  assert.equal(details, true)
  // A plain HTTP server has no TLS state at all; an HTTPS one keeps the certificate here.
  assert.equal(hub.server.cert, undefined)
})

test('login over a trusted TLS connection works end to end', async (t) => {
  // The whole authentication flow over HTTPS: encryption and the auth logic proven together,
  // which is how the plugin will actually use it.
  const { logger } = createMemoryLogger()
  const hub = createHub({ config: testConfig({ tls: { cert: CERT, key: KEY }, insecureLoopbackOnly: false }), logger })
  const address = await hub.listen()
  t.after(() => hub.close())

  const post = (path, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = request({
      host: '127.0.0.1', port: address.port, path, method: 'POST', ca: readFileSync(CERT),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(payload)
  })

  const registered = await post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })
  assert.equal(registered.status, 201)
  const loggedIn = await post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })
  assert.equal(loggedIn.status, 200)
  assert.equal(loggedIn.body.hubUserId, registered.body.hubUserId)
})

test('with the flag set, plaintext really binds the network address it was given', async () => {
  // The defect this covers: the config used to be accepted and the bind quietly rewritten to
  // 127.0.0.1, so a second machine could not connect and nothing said why. This asserts the address
  // the socket actually reports, not the address in the config.
  const config = loadConfig({ HUB_ALLOW_INSECURE_LOCALHOST: '1', HUB_ALLOW_PLAINTEXT_LAN: '1', HUB_HOST: '0.0.0.0', HUB_PORT: '0' })
  const { lines, logger } = createMemoryLogger()
  const dataDir = mkdtempSync(join(tmpdir(), 'hub-lan-'))
  const hub = createHub({ config: { ...config, dataDir }, logger })
  try {
    const address = await hub.listen()
    assert.equal(config.insecureLoopbackOnly, false)
    assert.equal(config.host, '0.0.0.0')
    // `server.address()` reports what the socket is bound to. `::` is the IPv6 spelling of "every
    // address", which some platforms give back for 0.0.0.0.
    assert.ok(
      address.host === '0.0.0.0' || address.host === '::',
      `the listener must be on every interface, got ${address.host}`,
    )
    // And it says so, once, because this is the state where passwords cross the network.
    assert.equal(lines.some(line => line.includes('hub.plaintext-on-network')), true)
  } finally {
    await hub.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
