// Read/unread across two machines, and per-member presence.
//
// Both are listed in the G4 scope (§2 "已读/未读游标", §7 "成员/邀请/在线状态") and both were
// missing from the product path even after the Hub held the tables: no caller ever wrote a cursor,
// and presence did not exist at all. These tests start from the UI's own door (`apiHandle`) so they
// fail the way a user would.
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
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 } },
  rooms: {},
  agents: {}, capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, works: {},
  questions: {}, views: {}, prefs: {}, switching: {}, revision: 0,
}

const withHub = async (t) => {
  const { createHub } = await import('../../../hub/src/server.js')
  const { createMemoryLogger } = await import('../../../hub/src/log.js')
  const dataDir = mkdtempSync(join(tmpdir(), 'ds-bot-read-hub-'))
  const hub = createHub({
    config: {
      host: '127.0.0.1', port: 0, tls: null, allowInsecure: true, insecureLoopbackOnly: true, dataDir,
      accessTtlMs: 30 * 60 * 1000, refreshTtlMs: 24 * 60 * 60 * 1000, logLevel: 'error',
    },
    logger: createMemoryLogger().logger,
  })
  const address = await hub.listen()
  const baseUrl = `http://127.0.0.1:${address.port}`
  t.after(async () => {
    await hub.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
  })
  for (const phone of [ALICE, BOB]) {
    await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, password: PASSWORD }),
    })
  }
  return { hub, baseUrl }
}

async function machine(t, { baseUrl, phone }) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-read-home-'))
  const home = join(root, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [] },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async () => ({ agent: { session: { id: 's1' }, followup: () => {} } }),
      selectModel: async () => {},
      prompt: async () => ({ accepted: true }),
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await rt.workgroup?.bridge?.stop?.().catch?.(() => {})
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  const wg = rt.workgroup
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

// One group with both people in it, created and joined through the panel's own endpoints.
async function sharedGroup(alice, bob) {
  const created = await alice.call('create-room', { name: '联调', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }] })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const workgroupId = created.value.hub.workgroupId
  await alice.call('invite-member', { workgroupId, phone: BOB })
  const inbox = await bob.call('group-invites', {})
  await bob.call('answer-invite', { inviteId: inbox.value.incoming[0].inviteId, accept: true })
  // Accepting creates Bob's local room for the group. It is created by the bridge's own sync, so it
  // is awaited here rather than assumed: every test below needs the room id.
  await until(() => bob.wg.roomOfHubGroup(workgroupId) !== undefined, { label: "Bob's room for the joined group" })
  return workgroupId
}

test('opening a group clears its unread count, and the Hub records the cursor', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE })
  const bob = await machine(t, { baseUrl, phone: BOB })
  const workgroupId = await sharedGroup(alice, bob)
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })

  // Two messages arrive on Bob's machine while he is not looking at the group.
  await alice.call('send-hub', { workgroupId, text: '一' })
  await alice.call('send-hub', { workgroupId, text: '二' })
  const bobRoomId = bob.wg.roomOfHubGroup(workgroupId).id
  await until(async () => (await bob.call('room', { id: bobRoomId })).value.log.length >= 2, { label: 'Bob to receive both' })

  const unreadBefore = await bob.call('room', { id: bobRoomId })
  assert.equal(unreadBefore.value.lastReadSeq, 0, 'nothing read yet')
  assert.equal(unreadBefore.value.unread, 2, 'two unread')

  // Opening the group is reading it: this is the call the pane makes.
  const marked = await bob.call('mark-read', { workgroupId, seq: unreadBefore.value.hub.cursor })
  assert.equal(marked.ok, true, JSON.stringify(marked.error))
  assert.equal(marked.value.lastReadSeq, 2)

  const unreadAfter = await bob.call('room', { id: bobRoomId })
  assert.equal(unreadAfter.value.unread, 0, 'the badge is cleared')

  // The Hub holds it, which is what makes the count survive a restart and reach Bob's other devices.
  await until(() => hub.db.prepare('SELECT count(*) AS c FROM read_cursors').get().c >= 1, { label: 'the Hub to record the cursor' })
  const row = hub.db.prepare('SELECT last_read_seq FROM read_cursors WHERE workgroup_id = ? AND user_id = ?')
    .get(workgroupId, bob.wg.hub.account.hubUserId)
  assert.ok(row !== undefined, 'the cursor is stored per person')
  assert.equal(row.last_read_seq, 2)
})

test('a read cursor never moves backwards', async (t) => {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE })
  const bob = await machine(t, { baseUrl, phone: BOB })
  const workgroupId = await sharedGroup(alice, bob)
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })
  await alice.call('send-hub', { workgroupId, text: '一' })
  await alice.call('send-hub', { workgroupId, text: '二' })
  const bobRoomId = bob.wg.roomOfHubGroup(workgroupId).id
  await until(async () => (await bob.call('room', { id: bobRoomId })).value.log.length >= 2, { label: 'Bob to receive both' })

  await bob.call('mark-read', { workgroupId, seq: 2 })
  const backwards = await bob.call('mark-read', { workgroupId, seq: 1 })
  assert.equal(backwards.value.lastReadSeq, 2, 'a lower seq does not undo a read')
  const view = await bob.call('room', { id: bobRoomId })
  assert.equal(view.value.unread, 0)
})

test('reading on one machine does not clear the count on another person\'s', async (t) => {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE })
  const bob = await machine(t, { baseUrl, phone: BOB })
  const workgroupId = await sharedGroup(alice, bob)
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })
  await until(() => alice.wg.roomOfHubGroup(workgroupId) !== undefined, { label: "Alice's room" })
  await alice.call('send-hub', { workgroupId, text: '一' })
  await until(async () => (await alice.call('room', { id: alice.wg.roomOfHubGroup(workgroupId).id })).value.log.length >= 1,
    { label: 'Alice to see her own line' })

  // Bob reads; Alice has read nothing, so her own count is untouched.
  await bob.call('mark-read', { workgroupId, seq: 1 })
  const aliceView = await alice.call('room', { id: alice.wg.roomOfHubGroup(workgroupId).id })
  assert.equal(aliceView.value.lastReadSeq, 0, 'a cursor is per person')
})

test('the Hub reports per-member presence, and it follows the socket', async (t) => {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE })
  const bob = await machine(t, { baseUrl, phone: BOB })
  const workgroupId = await sharedGroup(alice, bob)

  const bothOnline = async () => {
    const detail = await alice.wg.hub.workgroup(workgroupId)
    return (detail.members ?? []).filter(member => member.online === true).length
  }
  await until(async () => (await bothOnline()) === 2, { label: 'both people online' })

  // Bob's machine goes away; the Hub's next answer says so, without any stored presence column.
  await bob.wg.bridge.stop()
  await until(async () => (await bothOnline()) === 1, { label: 'Bob to show as offline' })

  const detail = await alice.wg.hub.workgroup(workgroupId)
  const bot = detail.members.find(member => member.memberType === 'botEndpoint')
  assert.equal(bot.online, undefined, 'a Bot endpoint has no socket of its own, so it claims nothing')
})
