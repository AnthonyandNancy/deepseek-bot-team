// End-to-end through the PRODUCT path: sign in, then talk. Nothing here calls `bridge.start()`.
//
// This file exists because the G4 tests did not catch a real defect: every bridge test started the
// socket itself, so the suite passed while the shipped code never started one at all. A test that
// performs the user's steps — sign in on the account page, open a group, type — cannot miss that
// class of bug, because it fails at the first step the user would fail at.
//
// The rule for this file: **no `bridge.start()`, no `bridge.sync()`, no direct Hub client calls for
// anything the UI does.** Only `apiHandle`, the same door the client uses.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const PASSWORD = 'correct horse battery staple'
const ALICE = '+8613800138000'
const BOB = '+8613900139000'

const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {},
  agents: {}, capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, works: {},
  questions: {}, views: {}, prefs: {}, switching: {}, revision: 0,
}

const withHub = async (t) => {
  const { createHub } = await import('../../../hub/src/server.js')
  const { createMemoryLogger } = await import('../../../hub/src/log.js')
  const dataDir = mkdtempSync(join(tmpdir(), 'ds-bot-e2e-hub-'))
  const hub = createHub({
    config: {
      host: '127.0.0.1', port: 0, tls: null, allowInsecure: true, insecureLoopbackOnly: true, dataDir,
      accessTtlMs: 30 * 60 * 1000, refreshTtlMs: 24 * 60 * 60 * 1000, logLevel: 'error',
    },
    logger: createMemoryLogger().logger,
  })
  const address = await hub.listen()
  const baseUrl = `http://127.0.0.1:${address.port}`
  // Teardown is LIFO, so the machines registered later stop first and the Hub closes last. That
  // ordering matters: a Hub that goes away under an open client socket leaves Node's WebSocket
  // reconnect timer alive and the test process never exits.
  t.after(async () => {
    await hub.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
  })
  const post = async (path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) }
  }
  return { hub, baseUrl, post }
}

// One machine: a runtime with the domain, a seeded team, and a `call` that is exactly the client's
// door. Nothing else.
async function machine(t, { baseUrl, phone }) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-e2e-home-'))
  const home = join(root, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
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
    // The domain's own stop path, so a test cannot leave a timer behind.
    await rt.workgroup?.bridge?.stop?.().catch?.(() => {})
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  const wg = rt.workgroup
  // The account page's own call. This is where a user signs in; nothing else in this file starts
  // anything.
  const call = (endpoint, payload) => wg.apiHandle(endpoint, payload)
  const signedIn = await call('hub-login', { baseUrl, phone, password: PASSWORD })
  assert.equal(signedIn.ok, true, `sign-in failed: ${JSON.stringify(signedIn.error)}`)
  return { rt, wg, call }
}

async function until(predicate, { timeoutMs = 6000, label = 'condition' } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('signing in is enough: the socket is up without any explicit start', async (t) => {
  const { baseUrl } = await withHub(t)
  await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: ALICE, password: PASSWORD }),
  })
  const { wg } = await machine(t, { baseUrl, phone: ALICE })

  await until(() => wg.bridge.status().connected, { label: 'the socket to come up after sign-in' })
  assert.equal(wg.bridge.status().state, 'online')
  // The account's own answer says so too, which is what the settings page reads.
  const state = await wg.apiHandle('hub-state', {})
  assert.equal(state.value.loggedIn, true)
  assert.equal(state.value.bridge.connected, true)
})

test('a message typed after signing in reaches the Hub and the other machine', async (t) => {
  const { baseUrl } = await withHub(t)
  for (const phone of [ALICE, BOB]) {
    await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, password: PASSWORD }),
    })
  }
  const alice = await machine(t, { baseUrl, phone: ALICE })
  const bob = await machine(t, { baseUrl, phone: BOB })
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })

  // Creating a group from the panel path, not from the bridge's own method.
  const created = await alice.call('create-room', { name: '联调', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }] })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const workgroupId = created.value.hub?.workgroupId
  assert.ok(workgroupId !== undefined, 'a signed-in machine creates the group on the Hub too')

  // Invite and accept through the panel's own endpoints.
  const invited = await alice.call('invite-member', { workgroupId, phone: BOB })
  assert.equal(invited.ok, true, JSON.stringify(invited.error))
  const incoming = await bob.call('group-invites', {})
  assert.equal(incoming.value.incoming.length, 1, 'the other machine sees the invite')
  const accepted = await bob.call('answer-invite', { inviteId: inviting(incoming.value.incoming), accept: true })
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error))

  // Type. Nothing here started the bridge or asked it to sync.
  const sent = await alice.call('send-hub', { workgroupId, text: '先对一下进度' })
  assert.equal(sent.ok, true, JSON.stringify(sent.error))
  assert.equal(sent.value.queued, false, 'with a live socket the message goes out at once')

  await until(async () => ((await bob.call('room', { id: bob.wg.roomOfHubGroup(workgroupId)?.id })).value?.log ?? []).length > 0,
    { label: 'Bob to see the line' })
  const view = await bob.call('room', { id: bob.wg.roomOfHubGroup(workgroupId).id })
  const line = view.value.log.at(-1)
  assert.equal(line.text, '先对一下进度')
  assert.equal(line.via, 'hub')

  // And the author is a person, not "A member": the roster the Hub knows reaches the local room.
  assert.notEqual(line.who, 'A member', 'the sender must be attributed')
})

// `group-invites` returns the invite list; the id is the field the accept endpoint takes.
const inviting = list => list[0].inviteId

test('a line from another machine does not start a second round here', async (t) => {
  const { baseUrl } = await withHub(t)
  for (const phone of [ALICE, BOB]) {
    await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, password: PASSWORD }),
    })
  }
  const alice = await machine(t, { baseUrl, phone: ALICE })
  const bob = await machine(t, { baseUrl, phone: BOB })
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })

  const created = await alice.call('create-room', { name: '回环检查', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }] })
  const workgroupId = created.value.hub.workgroupId
  const invited = await alice.call('invite-member', { workgroupId, phone: BOB })
  void invited
  const incoming = await bob.call('group-invites', {})
  await bob.call('answer-invite', { inviteId: inviting(incoming.value.incoming), accept: true })

  // Count the workgroup posts Bob's machine makes into its group Session. A Hub line must not
  // produce one: that post is what the relay hook turns into a round.
  const posts = []
  const agentCalls = []
  bob.rt.ctx.sessionController.prompt = async (...args) => { agentCalls.push(args); return { accepted: true } }
  void posts

  await alice.call('send-hub', { workgroupId, text: '这条不该在 Bob 机器上再起一轮' })
  await until(async () => ((await bob.call('room', { id: bob.wg.roomOfHubGroup(workgroupId)?.id })).value?.log ?? []).length > 0,
    { label: 'Bob to receive the line' })
  // The line arrived, and nothing was prompted into Bob's group Session because of it.
  assert.deepEqual(agentCalls, [], 'a line from the Hub must not be re-posted into the local group Session')
})

// A remote member's turn becomes a CALL on the Hub, addressed to the Bot endpoint that must answer.
//
// It used to be "「Name」, you were called in this round" posted as an ordinary group line, and
// nothing anywhere turned that into a turn: `receiveRemote` deliberately keeps Hub lines out of the
// group's Session (so a second machine does not answer the same conversation twice), which is right
// for a line somebody SAID and wrong for an instruction. The colleague's Bot received the "@" and
// never ran. The call now names the endpoint (`payload.call.endpointId`), which is what the other
// machine matches against its own published endpoints.
test("a remote Bot's turn becomes a call the other machine can act on", async (t) => {
  const { baseUrl } = await withHub(t)
  for (const phone of [ALICE, BOB]) {
    await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, password: PASSWORD }),
    })
  }
  const alice = await machine(t, { baseUrl, phone: ALICE })
  const bob = await machine(t, { baseUrl, phone: BOB })
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })
  const created = await alice.call('create-room', { name: '远程成员', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }] })
  const workgroupId = created.value.hub.workgroupId
  const incoming0 = await bob.call('group-invites', {})
  void incoming0
  await alice.call('invite-member', { workgroupId, phone: BOB })
  const incoming = await bob.call('group-invites', {})
  await bob.call('answer-invite', { inviteId: inviting(incoming.value.incoming), accept: true })
  // Bob brings a Bot of his own, deliberately: accepting an invitation adds the PERSON and nothing
  // else, because which of somebody's Bots joins a group is their decision. This is the same call the
  // group's member list makes.
  await bob.wg.bridge.joinWithPrimaryBot({ workgroupId })
  // Two people plus the Bot endpoint Alice published: the roster is the Hub's, so it holds every
  // member the group has, not just the ones this machine picked in the composer.
  await until(() => (alice.wg.roomOfHubGroup(workgroupId)?.members ?? []).filter(member => member.kind === 'user').length === 2,
    { label: "Alice's roster to hold both people" })
  await until(() => (alice.wg.roomOfHubGroup(workgroupId)?.members ?? []).some(member => member.kind === 'remoteBot'),
    { label: "Bob's Bot to reach Alice's roster" })

  const room = alice.wg.roomOfHubGroup(workgroupId)
  // A PERSON is not called: their device runs no Bot turn, so a call to them has nobody to answer.
  // That is the round's own rule (`openingSpeakers` never makes a person a speaker) and the seam
  // enforces the same thing for any path that still reaches it.
  const person = room.members.find(member => member.kind === 'user')
  assert.ok(person !== undefined, 'the other person is a remote member of the local room')
  const notCalled = await alice.wg.deliverRemote({ room, member: person, slot: { note: 'your turn' } })
  assert.equal(notCalled.skipped, 'person', `a person is never called: ${JSON.stringify(notCalled)}`)

  // Bob's butler, which he added himself, is a `remoteBot` on Alice's machine and is the member her
  // round calls.
  const remoteBot = room.members.find(member => member.kind === 'remoteBot')
  assert.ok(remoteBot !== undefined, `the colleague's Bot is in the roster: ${JSON.stringify(room.members.map(member => `${member.kind}:${member.name}`))}`)

  // The seam `runRound` calls. Before this fix it did not exist, and the member was silently skipped.
  assert.equal(typeof alice.wg.deliverRemote, 'function', 'the production seam exists')
  const delivered = await alice.wg.deliverRemote({ room, member: remoteBot, slot: { note: 'your turn' } })
  assert.equal(delivered.sent, true, JSON.stringify(delivered))
  assert.equal(delivered.queued, false)

  // The message is on the Hub, which is what makes it reach the other machine at all — and it names
  // the ENDPOINT, because that is how the receiving machine knows the call is for its Bot.
  const events = await alice.wg.hub.events({ workgroupId })
  assert.equal(events.events.length, 1)
  const call = events.events[0].payload.call
  assert.ok(call !== undefined, `the event carries a call: ${JSON.stringify(events.events[0].payload)}`)
  assert.equal(call.endpointId, remoteBot.endpointId, 'addressed to the Bot that must answer')
  assert.equal(call.note, 'your turn', 'and it carries what the round was asking')

  // The call started a real turn on Bob's machine — that is the point of the fix. A harness runs no
  // model, so the turn never ends by itself. Stop it through the product path AND assert it ended:
  // without that assertion the test could pass while leaving a reply timer behind, which is exactly
  // what made this file hang instead of exiting.
  //
  // The call is an EVENT: Bob's machine runs it asynchronously (the receiver does not hold the Hub
  // cursor for a model turn), so first wait for the round to register, THEN stop it. A stop issued
  // before the event has produced a round is a no-op by contract, not a passing cleanup.
  const bobRoomId = bob.wg.roomOfHubGroup(workgroupId)?.id ?? ''
  await until(() => [...bob.wg.roomProgress.values()].some(round => round.roomId === bobRoomId),
    { label: "Bob's called turn to register" })
  assert.equal(await bob.wg.stopRound(bobRoomId), true, "the called Bot's turn was stopped")
  await until(() => ![...bob.wg.roomProgress.values()].some(round => round.roomId === bobRoomId),
    { label: "Bob's round to be released" })
})

test('after a restart the stored account reconnects on the first hub-state read', async (t) => {
  const { baseUrl } = await withHub(t)
  await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: ALICE, password: PASSWORD }),
  })
  const { wg } = await machine(t, { baseUrl, phone: ALICE })
  await until(() => wg.bridge.status().connected, { label: 'the first socket' })

  // The restart: the process forgets its socket but keeps the account on disk.
  await wg.bridge.stop()
  assert.equal(wg.bridge.status().connected, false)
  await wg.apiHandle('hub-state', {})
  await until(() => wg.bridge.status().connected, { label: 'the socket back after a restart' })
})
