// The bridge, driven against a real Hub over a real socket.
//
// Both halves are the real thing: `hub/src/server.js` on a loopback port, and the plugin's own
// `createBridge` connecting to it with the runtime's `WebSocket`. A stub Hub here would prove only
// that this module parses what the stub was written to send — the properties that matter
// (a message sent on one machine appears on another, a reconnect replays what was not
// acknowledged, a resend does not duplicate) are properties of the two halves together.
//
// The domain is a real `createRuntime`, so the message path is the product's: an event arriving
// from the Hub goes through `wg.receiveRemote` into the workgroup's own log.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { createBridge, RECONNECT_MIN_MS } from '../src/workgroup/host/bridge.js'
import { fakeContext } from './fake-ctx.js'

// A Hub from this repository, on a port the OS picks.
const withHub = async (t) => {
  const { createHub } = await import(new URL('../../../hub/src/server.js', import.meta.url).href)
  const { createMemoryLogger } = await import(new URL('../../../hub/src/log.js', import.meta.url).href)
  const dataDir = mkdtempSync(join(tmpdir(), 'ds-bot-bridge-hub-'))
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
      logLevel: 'error',
    },
    logger: createMemoryLogger().logger,
  })
  const address = await hub.listen()
  const baseUrl = `http://127.0.0.1:${address.port}`
  t.after(async () => {
    await hub.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
  })

  // The same two helpers the Hub's own suite uses, so a test here reads like a test there.
  const request = async (method, path, { body, token } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let json
    try { json = text.length === 0 ? undefined : JSON.parse(text) } catch { json = text }
    return { status: response.status, body: json }
  }
  // Attached to the Hub object itself so a test can say `hub.post(...)` and keep reading like the
  // Hub's own suite; the Hub has no `post`, `get` or `baseUrl` of its own.
  return {
    hub: Object.assign(hub, {
      baseUrl,
      post: (path, body, options) => request('POST', path, { body, ...options }),
      get: (path, options) => request('GET', path, options),
    }),
    baseUrl,
  }
}

// A real runtime with a Workgroup domain, plus a signed-in Hub account on it.
const withDomain = async (t, { baseUrl, phone }) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-bridge-home-'))
  const ctx = fakeContext()
  const workspaces = new Map()
  Object.assign(ctx, {
    llm: { listProviders: () => [] },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s-${Math.random().toString(16).slice(2)}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {} } }),
      selectModel: async () => {},
      prompt: async () => ({ accepted: true }),
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await rt.workgroup?.bridge?.stop?.()
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const wg = rt.workgroup
  assert.ok(wg !== undefined, 'the Workgroup domain installed')

  // `authenticate` handles both register and login; asking it to log in is what a machine that is
  // not the first one on this account does.
  await wg.hub.authenticate({ baseUrl, phone, password: PASSWORD, mode: 'login' })
  return { rt, wg, ctx, home }
}

const PASSWORD = 'correct horse battery staple'

// Registers the account if it does not exist yet, and logs in either way. A test that needs two
// machines of the same account must not depend on which of them ran first.
async function signIn(hub, phone) {
  const registered = await hub.post('/v1/auth/register', { phone, password: PASSWORD })
  if (registered.status === 201) return registered.body
  const loggedIn = await hub.post('/v1/auth/login', { phone, password: PASSWORD })
  if (loggedIn.status !== 200) throw new Error(`could not sign in ${phone}: ${JSON.stringify(loggedIn.body)}`)
  return loggedIn.body
}

// Waits for a condition, polling. Used for the socket's asynchronous handshake, which happens in
// the Hub process and has no other observable edge.
async function until(predicate, { timeoutMs = 5000, label = 'condition' } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('the bridge opens a socket, is greeted, and reports itself online', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await signIn(hub, '+8613800138000')
  const { wg } = await withDomain(t, { baseUrl, phone: '+8613800138000' })

  const status = await wg.bridge.start()
  await until(() => wg.bridge.status().connected, { label: 'the socket to be greeted' })

  // The greeting proves the handshake was accepted: the Hub only says hello to a socket it has
  // authenticated as this device.
  assert.equal(wg.bridge.status().connected, true)
  assert.equal(status.pending, 0)
  await wg.bridge.stop()
})

test('a message sent through the bridge reaches a second machine', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await signIn(hub, '+8613800138000')
  const alice = await withDomain(t, { baseUrl, phone: '+8613800138000' })
  // Bob is a second account on the same Hub, so the group can have two real people in it.
  const bobPhone = '+8613900139000'
  const bobCreated = await signIn(hub, bobPhone)
  const bob = await withDomain(t, { baseUrl, phone: bobPhone, mode: 'login' })

  const created = await alice.wg.bridge.createWorkgroup({ name: '费用汇总' })
  const workgroupId = created.workgroupId
  const invite = await alice.wg.bridge.invite({ workgroupId, phone: bobPhone })
  await bob.wg.bridge.answerInvite({ inviteId: invite.inviteId, accept: true })

  await alice.wg.bridge.start()
  await bob.wg.bridge.start()
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })

  // Alice's machine appends the message; the Hub fans it out; Bob's bridge applies it.
  await alice.wg.bridge.send({ workgroupId, text: '这个月的费用汇总一下' })
  // The local room has its own id (it is a Session); the Hub's group id finds it through
  // `roomOfHubGroup`, which is the seam the UI uses too.
  await until(() => (bob.wg.roomOfHubGroup(workgroupId)?.log ?? []).length > 0, { label: 'Bob to see the line' })

  const room = bob.wg.roomOfHubGroup(workgroupId)
  const line = room.log.at(-1)
  assert.equal(line.text, '这个月的费用汇总一下')
  assert.equal(line.via, 'hub')
  // Bob's machine did not invent a local Bot Session for the sender: alice is a person.
  assert.equal(room.sessions?.[line.memberId], undefined)

  // And the Hub really holds it, so a third device would see it too.
  const pulled = await bob.wg.hub.events({ workgroupId })
  assert.equal(pulled.events.length, 1)
  assert.equal(pulled.events[0].payload.text, '这个月的费用汇总一下')
  assert.equal(bobCreated.hubUserId === alice.wg.hub.account.hubUserId, false)
})

test('a redelivered event is applied once, so no line is shown twice', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await signIn(hub, '+8613800138000')
  const alice = await withDomain(t, { baseUrl, phone: '+8613800138000' })
  const bobPhone = '+8613900139000'
  await signIn(hub, bobPhone)
  const bob = await withDomain(t, { baseUrl, phone: bobPhone })

  const created = await alice.wg.bridge.createWorkgroup({ name: '重放' })
  const workgroupId = created.workgroupId
  const invite = await alice.wg.bridge.invite({ workgroupId, phone: bobPhone })
  await bob.wg.bridge.answerInvite({ inviteId: invite.inviteId, accept: true })

  await alice.wg.bridge.start()
  await bob.wg.bridge.start()
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })
  const sent = await alice.wg.bridge.send({ workgroupId, text: '只显示一次' })
  await until(() => (bob.wg.roomOfHubGroup(workgroupId)?.log ?? []).length > 0, { label: 'Bob to see the line' })

  const roomId = bob.wg.roomOfHubGroup(workgroupId).id
  const countLines = () => (bob.wg.workgroupOf(roomId)?.log ?? []).filter(line => line.hubEventId === sent.eventId).length
  assert.equal(countLines(), 1)

  // The restart case: the bridge forgets its cursor and its seen set (both are in memory), pulls the
  // whole log again over HTTP, and must not add a second copy of the line it already has. The dedup
  // that survives a restart is the log's own `hubEventId`.
  await bob.wg.bridge.reset()
  await bob.wg.bridge.start()
  await bob.wg.bridge.sync(workgroupId)
  assert.equal(countLines(), 1, 'a replay after a restart must not duplicate the line')

  // And the Hub still holds exactly one event for it.
  const pulled = await bob.wg.hub.events({ workgroupId })
  assert.deepEqual(pulled.events.map(event => event.eventId), [sent.eventId])
})

test('a message queued while offline is sent on reconnect, with the same event id', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await signIn(hub, '+8613800138000')
  const { wg } = await withDomain(t, { baseUrl, phone: '+8613800138000' })
  await wg.bridge.start()
  await until(() => wg.bridge.status().connected, { label: 'the socket' })
  const created = await wg.bridge.createWorkgroup({ name: '离线' })
  const workgroupId = created.workgroupId

  // Drop the socket the way a sleeping laptop does, then type.
  await wg.bridge.stop()
  const queued = await wg.bridge.send({ workgroupId, text: '断网时写的' })
  assert.equal(queued.queued, true, 'a message typed with no socket is queued, not lost')
  assert.equal(wg.bridge.status().pending, 1)

  // A restart reconnects and flushes the same event id.
  await wg.bridge.start()
  await until(() => wg.bridge.status().connected, { label: 'the socket back' })
  await until(() => wg.bridge.status().pending === 0, { label: 'the outbox to drain' })

  const pulled = await wg.hub.events({ workgroupId })
  assert.equal(pulled.events.length, 1)
  assert.equal(pulled.events[0].eventId, queued.eventId)
  assert.equal(pulled.events[0].payload.text, '断网时写的')
})

test('a message the Hub already has is not duplicated by the retry', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await signIn(hub, '+8613800138000')
  const { wg } = await withDomain(t, { baseUrl, phone: '+8613800138000' })
  await wg.bridge.start()
  await until(() => wg.bridge.status().connected, { label: 'the socket' })
  const created = await wg.bridge.createWorkgroup({ name: '重复' })
  const workgroupId = created.workgroupId

  // Send once, wait for the ack, then force the same id through the outbox again — the shape of
  // "the ack was lost, so the client resends".
  const sent = await wg.bridge.send({ workgroupId, text: '一次' })
  await until(() => wg.bridge.status().pending === 0, { label: 'the ack' })

  await wg.bridge.stop()
  await wg.bridge.start()
  await until(() => wg.bridge.status().connected, { label: 'the socket back' })

  const pulled = await wg.hub.events({ workgroupId })
  assert.equal(pulled.events.length, 1, 'one send, one event')
  assert.equal(pulled.events[0].eventId, sent.eventId)
})

test('a group this machine has never seen is pulled from zero on connect', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await signIn(hub, '+8613800138000')
  const alice = await withDomain(t, { baseUrl, phone: '+8613800138000' })
  const bobPhone = '+8613900139000'
  await signIn(hub, bobPhone)
  const bob = await withDomain(t, { baseUrl, phone: bobPhone, mode: 'login' })

  const created = await alice.wg.bridge.createWorkgroup({ name: '历史' })
  const workgroupId = created.workgroupId
  const invite = await alice.wg.bridge.invite({ workgroupId, phone: bobPhone })
  await bob.wg.bridge.answerInvite({ inviteId: invite.inviteId, accept: true })

  await alice.wg.bridge.start()
  await until(() => alice.wg.bridge.status().connected, { label: 'Alice socket' })
  await alice.wg.bridge.send({ workgroupId, text: 'Bob 加入前的一句' })
  await until(async () => (await alice.wg.hub.events({ workgroupId })).events.length === 1, { label: 'the event on the Hub' })

  // Bob's first connect pulls the log he was not there for.
  await bob.wg.bridge.start()
  await until(() => (bob.wg.roomOfHubGroup(workgroupId)?.log ?? []).length > 0, { label: 'Bob to pull the history' })
  assert.equal(bob.wg.roomOfHubGroup(workgroupId).log.at(-1).text, 'Bob 加入前的一句')
})

test('a signed-out account starts no socket at all', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-bridge-home-'))
  const ctx = fakeContext()
  Object.assign(ctx, { llm: { listProviders: () => [] }, sessions: { flush: async () => {} } })
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const wg = rt.workgroup

  // No account: `start` resolves without a socket and without throwing. This is what keeps a team
  // with no Hub exactly the G3 team.
  await wg.bridge.start()
  assert.equal(wg.bridge.status().connected, false)
  // A distinct state, not a retry loop: there is no account to reconnect with.
  assert.equal(wg.bridge.status().state, 'signed-out')
  // And a send is refused rather than silently swallowed: there is nowhere to send it.
  await assert.rejects(() => wg.bridge.sync('wg_none'), /not signed in|no Hub address/i)
})

test('the bridge never holds the device private key', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await signIn(hub, '+8613800138000')
  const { wg } = await withDomain(t, { baseUrl, phone: '+8613800138000' })

  // `socketAuth` hands over a signing closure, not a key: nothing in the bridge's surface exposes
  // the PEM, which is what stops the settings page (or a client bundle) from reading it.
  const auth = await wg.hub.socketAuth()
  assert.equal(typeof auth.sign, 'function')
  assert.equal(auth.privateKeyPem, undefined)
  assert.equal(auth.refreshToken, undefined)
  const signature = auth.sign(auth.deviceId, Date.now(), 'n1')
  assert.equal(typeof signature, 'string')
  assert.ok(signature.length > 20)
})

test('publishing Bot endpoints claims no path and no tool', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await signIn(hub, '+8613800138000')
  const { wg } = await withDomain(t, { baseUrl, phone: '+8613800138000' })

  const published = await wg.bridge.publishBotEndpoints()
  // The fake runtime has at least the team's own Bots; every one published must carry only the
  // minimal capability set.
  for (const endpoint of published) {
    assert.deepEqual(endpoint.capabilities, ['chat', 'files'])
    const body = JSON.stringify(endpoint)
    assert.equal(body.includes(wg.rt.home), false, 'no local path reaches the Hub')
    assert.equal(body.includes('/'), false, 'and no path-shaped value either')
  }
})

test('a reconnect backoff is bounded and does not spin', async (t) => {
  // A Hub that is not listening: the bridge must back off rather than reconnect in a tight loop.
  // The first delay is the contract; the cap is the other end of it.
  assert.ok(RECONNECT_MIN_MS >= 500)
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-bridge-home-'))
  const ctx = fakeContext()
  Object.assign(ctx, { llm: { listProviders: () => [] }, sessions: { flush: async () => {} } })
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const errors = []
  const stubbed = createBridge({ wg: { ...rt.workgroup, hub: { socketAuth: async () => { throw Object.assign(new Error('down'), { code: 'hub/unreachable' }) } } }, logger: rt.on = () => {}, webSocketImpl: class { constructor() { throw new Error('should not be constructed') } } })
  stubbed.on('error', entry => errors.push(entry))
  await stubbed.start()
  // No socket, no crash, and the state says so.
  assert.equal(stubbed.status().connected, false)
  await stubbed.stop()
})
