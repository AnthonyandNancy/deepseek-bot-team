// Upgrading a local group: the four-state transaction, against a real Hub.
//
// This file is gate item 3 and gate item 4 seen from the plugin's side, plus acceptance case T10.
// The Hub's own suite already proves the server half (`upgrade-no-history.test.js`,
// `upgrade-idempotent.test.js`); what only this test can prove is the *local* half of the gate's
// wording:
//
//   * "the upgrade request body has only a name, a notice and member ids, no log or body" — the
//     request is built here, so the assertion is made on what actually goes over the wire;
//   * "after the upgrade, the group has 0 events on the Hub side" — counted on the real Hub;
//   * "one workgroup, one local link" — the local record is this machine's, and a retried upgrade
//     must leave exactly one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { UPGRADE_STATES } from '../src/workgroup/host/upgrade.js'
import { fakeContext } from './fake-ctx.js'

const PASSWORD = 'correct horse battery staple'

const withHub = async (t) => {
  // The Hub package lives beside this plugin (BotCode/hub), two levels above ds-bot.
  const { createHub } = await import('../../../hub/src/server.js')
  const { createMemoryLogger } = await import('../../../hub/src/log.js')
  const dataDir = mkdtempSync(join(tmpdir(), 'ds-bot-upgrade-hub-'))
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

  // Every request that reached the Hub, whether the test made it or the plugin did. The plugin's
  // own client calls `fetch`, so intercepting it is the only way to assert on what actually went
  // over the wire rather than on what the code believes it sent.
  const sent = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith(baseUrl)) {
      sent.push({ method: options.method ?? 'GET', path: String(url).slice(baseUrl.length), body: options.body === undefined ? undefined : JSON.parse(options.body) })
    }
    return realFetch(url, options)
  }
  t.after(() => { globalThis.fetch = realFetch })
  const request = async (method, path, { body, token } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let json
    try { json = text.length === 0 ? undefined : JSON.parse(text) } catch { json = text }
    return { status: response.status, body: json }
  }
  return {
    hub: Object.assign(hub, {
      baseUrl,
      post: (path, body, options) => request('POST', path, { body, ...options }),
      get: (path, options) => request('GET', path, options),
      sent,
    }),
    baseUrl,
    sent,
  }
}

// A team with one local group already in it, so the upgrade has something real to upgrade: a group
// whose log already holds lines, written the way the ORIGINAL domain writes them.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {
    r1: {
      id: 'r1', name: '凭证汇总', named: true, members: ['a', 'b'], admin: 'a', mode: 'admin',
      notice: '每周整理一次', seq: 2,
      log: [
        { seq: 1, who: 'User', memberId: null, text: '今天把上个月的发票整理一下' },
        { seq: 2, who: 'Chief', memberId: 'a', text: '发票在 finance 文件夹里，已经核对完 12 张' },
      ],
    },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

// A runtime with a Workgroup domain and a local group already in it, signed in to the Hub.
//
// The team is seeded on disk BEFORE the runtime is created, so the local group the upgrade acts on
// is the original domain's own record in the original domain's own file — the case a real user has.
async function withDomain(t, { baseUrl, phone = '+8613800138000' }) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-upgrade-home-'))
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
    await rt.workgroup?.bridge?.stop?.()
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  const wg = rt.workgroup
  await wg.hub.authenticate({ baseUrl, phone, password: PASSWORD, mode: 'login' })
  return { rt, wg, ctx, home }
}

// A local group with a real log, so "the history was not uploaded" is a claim about something that
// existed. Written through the ORIGINAL domain's own state, which is what an upgrade of a real
// local group deals with.
async function localGroupWithHistory(rt) {
  await rt.load?.()
  const room = rt.roomOf('r1')
  assert.ok(room !== undefined, 'the fixture team has a local group')
  assert.equal(room.log.length, 2)
  return room
}

// The Hub's own count for a group, asked over HTTP so the number is not read from the same process
// that might have written it.
const hubEventCount = async (hub, workgroupId, token) => {
  const pulled = await hub.get(`/v1/workgroups/${workgroupId}/events`, { token })
  return pulled.body.events.length
}

test('an upgrade passes through all four states and leaves one workgroup and one link', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { rt, wg } = await withDomain(t, { baseUrl })
  const local = await localGroupWithHistory(rt)

  const seen = []
  const record = new Proxy({}, {})
  void record
  // The states are recorded as they are written, by watching the link record.
  const originalSave = wg.save
  wg.save = async () => { seen.push(wg.linkOf(local.id)?.status); return originalSave() }
  t.after(() => { wg.save = originalSave })

  const result = await wg.upgrade.run({ localRoomId: local.id, preview: { name: '凭证汇总' } })

  assert.equal(result.state, 'ACTIVE')
  assert.equal(result.created, true, 'the first attempt is the one that creates the group')
  // Every state appears, in order, and each exactly once — the transaction really is four steps and
  // not one write that happens to end in ACTIVE.
  const states = seen.filter((state, index) => state !== undefined && state !== seen[index - 1])
  assert.deepEqual(states, UPGRADE_STATES)

  // One Hub group, one local link.
  assert.equal(hub.db.prepare('SELECT count(*) AS c FROM workgroups').get().c, 1)
  assert.equal(Object.keys(wg.state.links).length, 1)
  assert.equal(Object.keys(wg.state.links)[0], local.id)
  const link = wg.linkOf(local.id)
  assert.equal(link.status, 'ACTIVE')
  assert.equal(link.workgroupId, result.workgroupId)
  // The local room record for the Hub group exists, so the chat pane can open it.
  assert.ok(wg.roomOfHubGroup(result.workgroupId) !== undefined)
})

test('the upgrade request carries settings only — no log, no message, no path', async (t) => {
  const { hub, baseUrl, sent } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { rt, wg } = await withDomain(t, { baseUrl })
  const local = await localGroupWithHistory(rt)

  await wg.upgrade.run({ localRoomId: local.id, preview: { name: '凭证汇总', notice: '每周整理一次' } })

  const upgradeRequest = sent.find(entry => entry.path === '/v1/workgroups' && entry.body?.upgradeId !== undefined)
  assert.ok(upgradeRequest !== undefined, 'the upgrade called POST /v1/workgroups')

  // The whole body, exactly: four keys are allowed and three are used.
  assert.deepEqual(Object.keys(upgradeRequest.body).sort(), ['name', 'notice', 'upgradeId'])
  assert.equal(upgradeRequest.body.name, '凭证汇总')
  assert.equal(upgradeRequest.body.notice, '每周整理一次')

  // None of the local history, and nothing that names a place on this machine.
  const wire = JSON.stringify(upgradeRequest.body)
  assert.equal(wire.includes('发票'), false, 'no message text left the machine')
  assert.equal(wire.includes('finance'), false, 'no local file name left the machine')
  assert.equal(wire.includes(local.id), false, 'no local room id left the machine')
  assert.equal(wire.includes('log'), false)
  assert.equal(wire.includes('messages'), false)

  // And the local group's own log is untouched: the history is still here, unshared.
  assert.equal(local.log.length, 2)
  assert.equal(local.log.some(line => String(line.text).includes('finance')), true, 'the local log still holds what it always held')
})

test('the Hub side of an upgraded group starts with zero events', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  const registered = await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { rt, wg } = await withDomain(t, { baseUrl })
  const local = await localGroupWithHistory(rt)

  const result = await wg.upgrade.run({ localRoomId: local.id, preview: { name: '凭证汇总' } })

  // The gate's number, measured over HTTP against the real Hub.
  assert.equal(await hubEventCount(hub, result.workgroupId, registered.body.accessToken), 0, 'no history was uploaded')
  assert.equal(hub.db.prepare('SELECT last_seq FROM workgroups WHERE id = ?').get(result.workgroupId).last_seq, 0)
})

test('retrying an upgrade ten times makes one group and one link', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { rt, wg } = await withDomain(t, { baseUrl })
  const local = await localGroupWithHistory(rt)

  const results = []
  for (let attempt = 0; attempt < 10; attempt += 1) {
    results.push(await wg.upgrade.run({ localRoomId: local.id, preview: { name: '凭证汇总' } }))
  }

  assert.equal(hub.db.prepare('SELECT count(*) AS c FROM workgroups').get().c, 1, 'ten retries, one Hub group')
  assert.equal(Object.keys(wg.state.links).length, 1, 'and one local link')
  // Every retry answers with the same group; only the first says it created it.
  assert.equal(new Set(results.map(result => result.workgroupId)).size, 1)
  assert.equal(results.filter(result => result.created === true).length, 1)
  assert.equal(results.filter(result => result.alreadyUpgraded === true).length, 9)
})

test('concurrent upgrades of one local group still make one group', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { rt, wg } = await withDomain(t, { baseUrl })
  const local = await localGroupWithHistory(rt)

  // Three dialogs, one click each: the local pre-check sees no link for all three.
  const results = await Promise.all([
    wg.upgrade.run({ localRoomId: local.id, preview: { name: '凭证汇总' } }),
    wg.upgrade.run({ localRoomId: local.id, preview: { name: '凭证汇总' } }),
    wg.upgrade.run({ localRoomId: local.id, preview: { name: '凭证汇总' } }),
  ])
  assert.equal(hub.db.prepare('SELECT count(*) AS c FROM workgroups').get().c, 1)
  assert.equal(Object.keys(wg.state.links).length, 1)
  assert.equal(new Set(results.map(result => result.workgroupId)).size, 1)
})

test('the original group is archived as history, not deleted and not emptied', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { rt, wg } = await withDomain(t, { baseUrl })
  const local = await localGroupWithHistory(rt)

  const result = await wg.upgrade.run({ localRoomId: local.id, preview: { name: '凭证汇总' } })

  // Still a local group, still with its log, still openable.
  const still = rt.roomOf(local.id)
  assert.ok(still !== undefined, 'the local group is not deleted')
  assert.equal(still.log.length, 2, 'and its history is intact')
  // Marked as archived, which is what the sidebar and the composer read.
  assert.equal(wg.upgrade.isArchived(local.id), true)
  assert.equal(wg.upgrade.statusOf(local.id).state, 'ACTIVE')
  // The workgroup is a different room with its own (empty) log.
  const linked = wg.roomOfHubGroup(result.workgroupId)
  assert.notEqual(linked.id, local.id)
  assert.equal(linked.log.length, 0)
})

test('a failure leaves the link where it stopped and a retry continues', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { rt, wg } = await withDomain(t, { baseUrl })
  const local = await localGroupWithHistory(rt)

  // The Hub refuses the create: the transaction must stop in PREPARING and keep the key.
  const realCreate = wg.bridge.createWorkgroup
  wg.bridge.createWorkgroup = async () => { throw Object.assign(new Error('the Hub said no'), { code: 'hub/http-500' }) }
  await assert.rejects(() => wg.upgrade.run({ localRoomId: local.id }), /the Hub said no/)
  const stopped = wg.upgrade.statusOf(local.id)
  assert.equal(stopped.state, 'PREPARING')
  assert.equal(stopped.hint.includes('Retrying is safe'), true)
  assert.equal(hub.db.prepare('SELECT count(*) AS c FROM workgroups').get().c, 0)

  // The retry uses the same key and succeeds; the group is created once.
  wg.bridge.createWorkgroup = realCreate
  const retried = await wg.upgrade.run({ localRoomId: local.id, preview: { name: '凭证汇总' } })
  assert.equal(retried.state, 'ACTIVE')
  assert.equal(retried.created, true)
  assert.equal(hub.db.prepare('SELECT count(*) AS c FROM workgroups').get().c, 1)
  assert.equal(wg.linkOf(local.id).status, 'ACTIVE')
})

test('a failure after the Hub created the group does not make a second one', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { rt, wg } = await withDomain(t, { baseUrl })
  const local = await localGroupWithHistory(rt)

  // The Hub creates the group, then the local write fails: the worst case for a retry, because the
  // group exists and the link does not yet know it is linked.
  //
  // The failing call is the SECOND one: `bridge.createWorkgroup` already links the local room for a
  // group it just made, and the upgrade links it again to be sure (an idempotent lookup). Making the
  // second call fail is exactly the window where the group exists but the link says otherwise.
  const realEnsure = wg.ensureLinkedGroup
  let calls = 0
  wg.ensureLinkedGroup = async (...args) => {
    calls += 1
    if (calls === 2) throw new Error('the local state file was busy')
    return realEnsure(...args)
  }
  await assert.rejects(() => wg.upgrade.run({ localRoomId: local.id, preview: { name: '凭证汇总' } }), /state file was busy/)
  // The link stopped at HUB_CREATED, which is exactly the state that says "the group exists".
  assert.equal(wg.upgrade.statusOf(local.id).state, 'HUB_CREATED')
  assert.equal(hub.db.prepare('SELECT count(*) AS c FROM workgroups').get().c, 1)

  wg.ensureLinkedGroup = realEnsure
  const retried = await wg.upgrade.run({ localRoomId: local.id })
  assert.equal(retried.state, 'ACTIVE')
  // The retry found the group the first attempt created: one group, and the retry did not create it.
  assert.equal(retried.created, false)
  assert.equal(hub.db.prepare('SELECT count(*) AS c FROM workgroups').get().c, 1)
})

test('upgrading a group that does not exist is refused without touching the Hub', async (t) => {
  const { hub, baseUrl, sent } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { wg } = await withDomain(t, { baseUrl })

  await assert.rejects(() => wg.upgrade.run({ localRoomId: 'room_does_not_exist' }), /Unknown local group/)
  assert.equal(sent.some(entry => entry.path === '/v1/workgroups'), false)
  assert.equal(wg.upgrade.statusOf('room_does_not_exist').linked, false)
})

test('a group never upgraded reports that plainly', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { rt, wg } = await withDomain(t, { baseUrl })
  const local = await localGroupWithHistory(rt)

  assert.deepEqual(wg.upgrade.statusOf(local.id), { linked: false })
  assert.equal(wg.upgrade.isArchived(local.id), false)
})
