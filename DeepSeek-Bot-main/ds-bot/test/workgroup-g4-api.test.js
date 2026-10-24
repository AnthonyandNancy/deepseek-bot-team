// The G4 host endpoints, driven through the plugin's own channel.
//
// `channel.js` is the only door the Workgroup client has, so an endpoint that answers wrongly is a
// feature that does not work however correct the bridge is. This file exercises the G4 additions
// over the real route against a real Hub: creating a Hub group, the room view the pane draws,
// sending, members, invites, attachments, publishing endpoints, and an archived group's read-only
// state.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const PASSWORD = 'correct horse battery staple'

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
      id: 'r1', name: '本地群', named: true, members: ['a', 'b'], admin: 'a', mode: 'admin',
      notice: '', log: [], seq: 0,
    },
  },
  // The store's own shape. `exchanges` must be a list and `capabilities` must exist: a missing key
  // is not defaulted when the file is read, and `state.exchanges.slice` then throws at the first
  // turn.
  agents: {}, capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, works: {}, questions: {},
  views: {}, prefs: {}, switching: {}, revision: 0,
}

const withHub = async (t) => {
  const { createHub } = await import('../../../hub/src/server.js')
  const { createMemoryLogger } = await import('../../../hub/src/log.js')
  const dataDir = mkdtempSync(join(tmpdir(), 'ds-bot-g4api-hub-'))
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
  const post = async (path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    let parsed
    try { parsed = text.length === 0 ? undefined : JSON.parse(text) } catch { parsed = text }
    return { status: response.status, body: parsed }
  }
  // Attached to the Hub object so a test reads like the Hub's own suite; the Hub has no `post`.
  return { hub: Object.assign(hub, { post, baseUrl }), baseUrl }
}

async function withDomain(t, { baseUrl }) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-g4api-home-'))
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
  await wg.hub.authenticate({ baseUrl, phone: '+8613800138000', password: PASSWORD, mode: 'login' })
  // The channel's own entry point, exactly as the client calls it.
  const call = (endpoint, payload) => wg.apiHandle(endpoint, payload)
  return { rt, wg, ctx, call, home }
}

// A second runtime over the same home directory: a restart. The access token lives in memory only,
// so this is the only way to see what the plugin does with nothing but the record on disk — which is
// the state the reported failure happened in.
async function reopenDomain(t, home) {
  const ctx = fakeContext()
  const workspaces = new Map()
  Object.assign(ctx, {
    llm: { listProviders: () => [] },
    sessions: { flush: async () => {} },
    // `adoptHubGroups` makes a local room for a group it finds, and that goes through the workspace
    // registry. Without it here the adoption threw and its own `catch` swallowed the error, so a
    // restart looked like it had done work it had not — a test that passed while the bug was live.
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
  })
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await rt.workgroup?.bridge?.stop?.()
    await ctx.dispose()
  })
  const wg = rt.workgroup
  await wg.load()
  return { rt, wg, call: (endpoint, payload) => wg.apiHandle(endpoint, payload) }
}

// Waits for the socket's asynchronous handshake, which has no other observable edge.
const settled = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms))

test('the channel creates a Hub group and the local room that opens it', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { wg, call } = await withDomain(t, { baseUrl })

  const created = await call('bridge-create-group', { name: '会议记录' })
  assert.equal(created.ok, true, JSON.stringify(created))
  const workgroupId = created.value.workgroupId
  // A local room now represents it, so the chat pane has something to open.
  assert.ok(wg.roomOfHubGroup(workgroupId) !== undefined)
  assert.equal(wg.roomOfHubGroup(workgroupId).name, '会议记录')
})

test('the room view reports the Hub facts the pane draws', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { wg, call } = await withDomain(t, { baseUrl })

  // A local group is not a workgroup, so this endpoint does not answer for it — the original
  // channel does, and `room` must not pretend otherwise.
  const local = await call('room', { id: 'r1' })
  assert.equal(local.ok, false)
  assert.equal(local.error.code, 'bot/not-found')

  // A group created on the Hub: the block the pane draws its member list and Hub line from.
  const created = await call('bridge-create-group', { name: '会议记录' })
  const roomId = wg.roomOfHubGroup(created.value.workgroupId).id
  const room = await call('room', { id: roomId })
  assert.equal(room.value.hub.workgroupId, created.value.workgroupId)
  assert.equal(typeof room.value.hub.connected, 'boolean')
  assert.equal(room.value.hub.pending, 0)
  assert.equal(room.value.archived, false, 'a Hub group is live, not archived')
  // Every log line carries the Hub fields, so the pane can tell a relayed line from a local one.
  assert.deepEqual(Object.keys(room.value.log).length, 0)
})

test('sending goes to the Hub first and refuses a room that is not on the Hub', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { wg, call } = await withDomain(t, { baseUrl })
  const created = await call('bridge-create-group', { name: '会议记录' })
  const workgroupId = created.value.workgroupId

  await wg.bridge.start()
  await settled()
  const sent = await call('send-hub', { workgroupId, text: '今天先对一下进度' })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  assert.equal(typeof sent.value.eventId, 'string')

  // The Hub really has it: the assertion is against the Hub's own log, not the local copy.
  const events = await wg.hub.events({ workgroupId })
  assert.equal(events.events.length, 1)
  assert.equal(events.events[0].payload.text, '今天先对一下进度')

  // A room that is not on the Hub is refused rather than given a Hub group of its own.
  const refused = await call('send-hub', { workgroupId: 'wg_missing', text: 'x' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'bot/not-found')
})

test('members and invites come from the Hub, and an invite names a person', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  await hub.post('/v1/auth/register', { phone: '+8613900139000', password: PASSWORD })
  const { call } = await withDomain(t, { baseUrl })
  const created = await call('bridge-create-group', { name: '会议记录' })
  const workgroupId = created.value.workgroupId

  const members = await call('group-members', { workgroupId })
  assert.equal(members.ok, true, JSON.stringify(members))
  assert.equal(members.value.members.length, 1, 'the owner is the only member so far')
  assert.equal(members.value.members[0].role, 'owner')

  const invited = await call('invite-member', { workgroupId, phone: '+8613900139000' })
  assert.equal(invited.ok, true, JSON.stringify(invited))
  assert.equal(invited.value.inviteePhoneMasked, '+86****9000')
  // Nothing about the invitee beyond the masked number comes back.
  assert.equal(JSON.stringify(invited.value).includes('13900139000'), false)

  // A phone that is not an account is refused with the Hub's own code, not a crash.
  const unknown = await call('invite-member', { workgroupId, phone: '+8611111111111' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'workgroup/invitee-unknown')

  const list = await call('group-invites')
  assert.equal(list.ok, true)
  assert.equal(list.value.groups.length, 1)
  assert.equal(list.value.groups[0].workgroupId, workgroupId)
})

test('an attachment is sent as bytes, and neither the row nor the request names a path', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { wg, call } = await withDomain(t, { baseUrl })
  const created = await call('bridge-create-group', { name: '会议记录' })
  const workgroupId = created.value.workgroupId
  await wg.bridge.start()
  await settled()

  const body = Buffer.from('a,b\n1,2\n').toString('base64')
  const sent = await call('send-attachment', { workgroupId, name: 'table.csv', mime: 'text/csv', data: body })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  assert.equal(sent.value.name, 'table.csv')
  assert.equal(sent.value.size, 8)

  // The bytes round-trip through the Hub's ticket.
  const ticket = await call('attachment-ticket', { attachmentId: sent.value.attachmentId })
  assert.equal(ticket.ok, true)
  const bytes = await wg.hub.downloadAttachment({ attachmentId: sent.value.attachmentId, ticket: ticket.value.ticket })
  assert.equal(bytes.toString(), 'a,b\n1,2\n')

  // And the stored row holds no path: the storage key is the Hub's own.
  const row = hub.db.prepare('SELECT * FROM attachments WHERE id = ?').get(sent.value.attachmentId)
  assert.equal(JSON.stringify(row).includes('C:'), false)
  assert.match(row.storage_key, /^att_[0-9a-f]+\.csv$/)
})

test('an upgraded group reports itself archived while staying readable', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { wg, call } = await withDomain(t, { baseUrl })

  const upgraded = await call('upgrade-room', { localRoomId: 'r1' })
  assert.equal(upgraded.ok, true, JSON.stringify(upgraded))

  const status = await call('upgrade-status', { localRoomId: 'r1' })
  assert.equal(status.ok, true)
  assert.equal(status.value.state, 'ACTIVE')

  // The archived state is what the composer reads, and it is a fact about the LOCAL group: the
  // local domain still holds it, and the upgrade records that it was archived.
  assert.equal(wg.upgrade.isArchived('r1'), true)
  assert.equal(wg.upgrade.statusOf('r1').state, 'ACTIVE')
  // The workgroup room the upgrade created is a different room, and it is not archived.
  const hubRoom = wg.roomOfHubGroup(upgraded.value.workgroupId)
  assert.ok(hubRoom !== undefined)
  assert.notEqual(hubRoom.id, 'r1')
  const view = await call('room', { id: hubRoom.id })
  assert.equal(view.value.archived, false)
})

test('a read-only host refuses the G4 writes and answers the G4 reads', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { rt, call } = await withDomain(t, { baseUrl })
  const created = await call('bridge-create-group', { name: '会议记录' })
  const workgroupId = created.value.workgroupId

  // The original channel's rule, applied to the new endpoints: a read-only host answers reads only.
  rt.readOnly = () => 'This host is read-only.'
  t.after(() => { delete rt.readOnly })
  const read = await call('group-members', { workgroupId })
  assert.equal(read.ok, true, 'a read is still answered')
  const write = await call('invite-member', { workgroupId, phone: '+8613900139000' })
  assert.equal(write.ok, false)
  assert.equal(write.error.code, 'bot/read-only')
})

test('publishing Bot endpoints is refused while signed out', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-g4api-home-'))
  const ctx = fakeContext()
  Object.assign(ctx, { llm: { listProviders: () => [] }, sessions: { flush: async () => {} } })
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const answer = await rt.workgroup.apiHandle('publish-endpoints', {})
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'bot/not-signed-in')
})

// ── 工作群的 Hub 身份（plan §8.1）─────────────────────────────────────────────────
// 方案 §8.1：「新建工作群：登录 Hub 后可直接创建……工作群拥有 Hub workgroupId」。
// G4 曾允许未登录也建一个「工作群」，产出的东西既没有 Hub 身份也不是本地群，用户无法分辨——
// 正是「建完群找不到邀请同事的地方」的起点。这里钉住新的口径。

test('a workgroup cannot be created while signed out: it would have no Hub identity', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-g4api-home-'))
  const ctx = fakeContext()
  Object.assign(ctx, { llm: { listProviders: () => [] }, sessions: { flush: async () => {} } })
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const wg = rt.workgroup
  await wg.load()
  const before = Object.keys(wg.state.workgroups).length

  const refused = await wg.apiHandle('create-room', { name: '会议记录', members: [] })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.equal(refused.error.code, 'hub/not-signed-in')
  // Nothing was written: a refusal that still stores a group would be worse than a silent one.
  await wg.load()
  assert.equal(Object.keys(wg.state.workgroups).length, before, 'a refused create must not leave a group behind')
})

test('a workgroup created while signed in carries its Hub identity', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { call } = await withDomain(t, { baseUrl })

  const created = await call('create-room', { name: '会议记录', members: [] })
  assert.equal(created.ok, true, JSON.stringify(created))
  // The whole point of the rule: a group created here is a group on the Hub, which is what makes
  // inviting somebody possible at all.
  assert.equal(typeof created.value.hub?.workgroupId, 'string')
  assert.equal(created.value.hub.workgroupId.length > 0, true)
})

test('a workgroup created without a name still gets one', async (t) => {
  // The composer sends no name unless the person types one, and the ORIGINAL derives "You, Chief, …"
  // from the members (src/host/roster.js `autoRoomName`). The workgroup copy kept that derivation
  // locally but sent `undefined` to the Hub, which answered `The group name must be text.` — the
  // create failed outright, so the reported "回到起点" was accurate: no group at all.
  //
  // Every existing test named the group, which is exactly why none of them saw it.
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { call, wg } = await withDomain(t, { baseUrl })

  // No `name` key at all, the way the composer sends it when the field is left empty.
  const created = await call('create-room', { members: [] })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(typeof created.value.hub?.workgroupId, 'string')

  // The local room and the Hub group must not disagree about the name: the Hub row is what a
  // colleague sees, and an empty one there would read as "Untitled" on their screen. The Hub answers
  // with the group spread at the top level, not wrapped in a `workgroup` key.
  const remote = await wg.hub.workgroup(created.value.hub.workgroupId)
  assert.equal(typeof remote.name, 'string', JSON.stringify(remote).slice(0, 300))
  assert.notEqual(remote.name.trim(), '', 'the Hub group must carry a real name')
  assert.equal(created.value.name, remote.name, 'both sides must use the same name')
})

test('a colleague can be invited by Hub user id as well as by phone', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const invited = await hub.post('/v1/auth/register', { phone: '+8613900139000', password: PASSWORD })
  const { call } = await withDomain(t, { baseUrl })
  const created = await call('create-room', { name: '会议记录', members: [] })
  const workgroupId = created.value.hub.workgroupId

  // By user id: the case the route could not do before, because it only forwarded a phone number.
  const byId = await call('invite-member', { workgroupId, hubUserId: invited.body.hubUserId })
  assert.equal(byId.ok, true, JSON.stringify(byId))
  assert.equal(byId.value.status, 'pending')

  // By phone still works, and is refused for the same person twice.
  const again = await call('invite-member', { workgroupId, phone: '+8613900139000' })
  assert.equal(again.ok, false)
  assert.equal(again.error.code, 'workgroup/already-invited')

  // Neither: refused with a sentence that names both accepted forms.
  const neither = await call('invite-member', { workgroupId })
  assert.equal(neither.ok, false)
  assert.equal(neither.error.code, 'bot/invalid')
  assert.match(neither.error.message, /phone number or a Hub user id/)

  // An unknown id is the Hub's own refusal, passed through rather than swallowed.
  const unknown = await call('invite-member', { workgroupId, hubUserId: 'usr_nobody' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'workgroup/invitee-unknown')
})

test('a session the Hub has forgotten is reported as a sign-out, not as an unreachable Hub', async (t) => {
  // What a wiped or replaced Hub database looks like from this machine: the stored refresh token is
  // still well-formed and the address still answers, but the session it names does not exist. The
  // person saw「The refresh token is not valid.」on create, which names neither the cause nor the fix,
  // and the first version of the fix turned it into「Could not reach the Hub」— worse, because the Hub
  // was reachable the whole time.
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { wg, home } = await withDomain(t, { baseUrl })

  // Replace the stored token with one this Hub never issued: the exact shape left behind by a Hub
  // whose `hub/.data` was lost. Re-saving the record is not a cheat — it is the state on disk, and
  // the account is still "signed in" as far as anything local can tell.
  const stored = await wg.hubStore.load()
  await wg.hubStore.save({ ...stored, refreshToken: 'dsb_rt_neverIssuedByThisHub' })

  // A restart is what makes the failure visible: the access token lives in memory only, so a fresh
  // process has nothing but the stored record. Testing it in the process that still holds a live
  // token would have passed while the real bug — the one the user hit — was still there.
  await wg.bridge.stop()
  const restarted = await reopenDomain(t, home)
  const refused = await restarted.call('create-room', { name: '会议记录', members: [] })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.equal(refused.error.code, 'hub/signed-out')
  assert.match(refused.error.message, /sign in/i)
  // "Unreachable" would send the person to check a Hub that is running.
  assert.equal(/Could not reach the Hub/.test(refused.error.message), false)

  // And the account page must stop claiming to be signed in, or the next attempt repeats the same
  // doomed exchange with nothing on screen to explain it.
  const state = await restarted.call('hub-state')
  assert.equal(state.value.loggedIn, false)
  assert.equal(await wg.hubStore.load(), undefined, 'the refused record is gone, so the form can be shown')
})

test('signing out really signs out, and signing in again works', async (t) => {
  // Reported from the app: pressing「退出登录」left the page showing an account, so the sign-in form
  // never came back and there was no way to sign in again. The cause was not the UI — it re-read the
  // state correctly — but `store.clear()`: it removed the record with `modifyRecord`, which the
  // Harness provider treats as "leave it alone". The account therefore stayed on disk, `restore()`
  // kept answering with it, and the page had nothing else to believe.
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { wg, call } = await withDomain(t, { baseUrl })

  const before = await call('hub-state')
  assert.equal(before.value.loggedIn, true)

  const out = await call('hub-logout')
  assert.equal(out.ok, true, JSON.stringify(out))

  // The page asks this immediately after signing out; it must not still see an account.
  const after = await call('hub-state')
  assert.equal(after.value.loggedIn, false)
  assert.equal(await wg.hubStore.load(), undefined, 'the record must be gone from the store, not just from memory')

  // And the form must actually work: signing in again succeeds rather than being refused because a
  // record is already there.
  const back = await call('hub-login', { baseUrl, phone: '+8613800138000', password: PASSWORD })
  assert.equal(back.ok, true, JSON.stringify(back))
  assert.equal((await call('hub-state')).value.loggedIn, true)
})


// ── 本机 Bot 必须真的回答（用户：「建工作群 → 有问候 → 你说话 → 有回复」）─────────────
//
// 这一节测的是产品路径，不是边界。它之所以必须存在：此前 13 个 round 测试全部用
// `twoMembers()` 手搓 `kind: 'localBot'` 的成员，而**生产代码从来不会写入那个 kind**。
// 真实路径是：本机 Bot → 发布成 Hub endpoint（`ep_…`）→ 建群 → Hub 用 endpoint id 回答成员表
//   → `applyRoster` 写入本地。在这一整条链上，`kind` 是 `remoteBot` / `user`，
// 于是 `sessionFor()` 对每个成员都返回 undefined，round 把所有人交给 `deliverRemote()` 发回 Hub：
// 自己的 Bot 在自己的机器上不干活，群既没有问候也没有回复。
//
// 所以本文件用真 Hub、真 `create-room`、真成员，断言「谁能回答」这件事从数据上就是对的。

// 一个能回答的成员：`kind` 必须是 localBot，且 `botId` 指回本机存在的 Bot。
const answerable = room => (room.members ?? []).filter(member => member.kind === 'localBot')

test('a workgroup built from this machine\'s Bots has members that can answer HERE', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { call, wg } = await withDomain(t, { baseUrl })

  // The composer offers this team's Bots; `create-room` publishes them as endpoints and puts them in
  // the group. These are the members the user actually picked.
  const created = await call('create-room', {
    name: '例会',
    members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'b', name: 'Writer', kind: 'localBot' }],
  })
  assert.equal(created.ok, true, JSON.stringify(created))

  const room = wg.workgroupOf(created.value.id)
  assert.ok(room !== undefined, 'the group exists locally')

  // THE ASSERTION THE PRODUCT NEEDED: a Bot of this team reaches the round as a LOCAL member.
  // It arrives from the Hub as an endpoint id, so this can only pass if `publishBotEndpoints`
  // recorded the endpoint→Bot mapping and `applyRoster` consulted it.
  const local = answerable(room)
  assert.equal(local.length, 2, `both of this machine's Bots must answer here, got ${JSON.stringify(room.members)}`)
  assert.deepEqual(local.map(member => member.botId).sort(), ['a', 'b'], 'each resolves back to its own Bot')
  // A member that IS one of this machine's Bots carries the BOT's id, exactly as an original group's
  // member does: every original component reaches a member through `roster.byId[id]`, and the admin
  // tag is `room.admin === member.id`. Keyed by the Hub's `ep_…`, `byId` answered with a copy of the
  // Bot whose own `id` was the Bot's, so that comparison never held and every admin tag disappeared.
  assert.deepEqual(local.map(member => member.id).sort(), ['a', 'b'], 'a local member is keyed by its Bot id')
  for (const member of local) {
    // The Hub's own id still has to be reachable, because that is what an endpoint is addressed by.
    assert.match(String(member.endpointId), /^ep_/, 'the Hub endpoint id is kept on endpointId')
    assert.equal(member.kind, 'localBot')
  }

  // And the admin is one of them, because `mode: 'admin'` calls nobody else. The Hub's owner is a
  // PERSON (`usr_…`); left as admin, every round had no answerer at all.
  assert.ok(local.some(member => member.id === room.adminId),
    `the admin must be a Bot that answers here, got ${room.adminId}`)
  // AND THE ADMIN IS THE MAIN BOT, as in an original group (`defaultAdmin`,
  // `src/host/roster.js:332`: `members.find(rt.isMain)`). Picking `answerable[0]` instead took
  // whichever member the Hub lists first — `memberships ORDER BY joined_at` — so an ordinary Bot
  // that joined before the Main Bot held the role, and on screen the admin tag sat on a Bot the
  // user never chose. `TEAM` makes `a` the Main Bot.
  assert.equal(room.adminId, 'a', 'the Main Bot leads, not whoever the Hub lists first')
})

// A member's Session and read cursor are keyed by its member id, and that id changed for this
// machine's own Bots (Hub `ep_…` → the Bot's own id). A room written before the change must not
// leave an owned Session nothing points at, nor make the member start over.
test('a member id that changed keeps its group Session and read cursor', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { call, wg } = await withDomain(t, { baseUrl })
  const created = await call('create-room', {
    name: '例会', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'b', name: 'Writer', kind: 'localBot' }],
  })
  const room = wg.workgroupOf(created.value.id)
  const chief = room.members.find(member => member.botId === 'a')

  // Stand in for a room written by the version that keyed local members by the Hub's endpoint id.
  const oldId = `ep_${'0'.repeat(32)}`
  room.sessions[oldId] = 'session-made-under-the-old-id'
  room.seen[oldId] = 7
  room.members = room.members.map(member => (member === chief ? { ...member, id: oldId } : member))
  await wg.save()

  // The roster arrives again — as it does on every change and every restart — and the member is
  // recognised as this machine's Bot, so its id becomes the Bot's own.
  await wg.syncRoster({ hubWorkgroupId: room.hubWorkgroupId })
  const after = wg.workgroupOf(room.id)
  const moved = after.members.find(member => member.botId === 'a')
  assert.equal(moved.id, 'a')
  assert.equal(after.sessions.a, 'session-made-under-the-old-id', 'the Session follows the member')
  assert.equal(after.seen.a, 7, 'so does the read cursor')
  assert.equal(after.sessions[oldId], undefined, 'and nothing is left under the old key')
  assert.equal(after.seen[oldId], undefined)
})

// A group file written before the permission fix carries `permission: null`, which every reader
// misreads. Loading it must heal rather than make the user toggle the switch off and on again.
test('a group file that stored permission: null is read back as "no shared preset"', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { call, wg, home } = await withDomain(t, { baseUrl })
  const created = await call('create-room', {
    name: '例会', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'b', name: 'Writer', kind: 'localBot' }],
  })
  const id = created.value.id
  // Exactly what the earlier version wrote on every create.
  wg.workgroupOf(id).permission = null
  await wg.save()

  // A restart, reading only what is on disk: the same thing the desktop app does.
  const again = await reopenDomain(t, home)
  const room = again.wg.workgroupOf(id)
  assert.equal('permission' in room, false,
    `a stored null must read back as "no shared preset", got ${JSON.stringify(room.permission)}`)
})

// The user's report: 「群主应该是我，管理员是管家 bot」. Both halves, in the room the product builds.
test('the Main Bot leads; the person who made the group stays the owner and is never the admin', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { call, wg } = await withDomain(t, { baseUrl })

  // Deliberately picked with the NON-Main Bot first, which is what a composer list can do and what
  // the previous rule keyed on.
  const created = await call('create-room', {
    name: '例会',
    members: [{ id: 'b', name: 'Writer', kind: 'localBot' }, { id: 'a', name: 'Chief', kind: 'localBot' }],
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  const room = wg.workgroupOf(created.value.id)

  // 管理员是管家 Bot: the Main Bot (`a`, "Chief"), even though `b` was listed first.
  assert.equal(room.adminId, 'a', `the Main Bot must lead, got ${room.adminId}`)

  // 群主是我: the Hub still records this account as the group's owner, and it is a member.
  const person = room.members.find(member => member.role === 'owner')
  assert.ok(person !== undefined, `the owner must be a member, got ${JSON.stringify(room.members)}`)
  assert.equal(person.kind, 'user', 'the owner is a person, not a Bot')
  assert.notEqual(room.adminId, person.id, 'a person never answers, so a person is never the admin')
})

test('a new workgroup does not claim a shared permission it has not set', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { call, wg } = await withDomain(t, { baseUrl })
  const created = await call('create-room', {
    name: '例会', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'b', name: 'Writer', kind: 'localBot' }],
  })
  const room = wg.workgroupOf(created.value.id)

  // The original writes this key only when the user turns 「全员统一」 on; every reader tests
  // `!== undefined` (`GroupPermission` computes `shared` that way, and `PermissionPicker` takes
  // `saved`). A `null` therefore drew the toggle as ON while highlighting none of the three
  // presets — the reported 「权限不知道选中哪个」.
  assert.equal('permission' in room, false, `a new group sets no preset, got ${JSON.stringify(room.permission)}`)
})

test('the person who created the group is a member, but never the one called to answer', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { call, wg } = await withDomain(t, { baseUrl })
  const created = await call('create-room', { name: '例会', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }] })
  const room = wg.workgroupOf(created.value.id)

  // The Hub lists the creator as an owner member. That is right — they are in the group — but a
  // person is not a turn this machine can run, and handing one to `deliverRemote` posts
  // "you were called" up to the Hub where nobody is listening.
  const person = room.members.find(member => member.role === 'owner')
  assert.ok(person !== undefined, 'the creator is a member')
  assert.notEqual(person.kind, 'localBot', 'a person never becomes a local turn')

  // THE ADMIN RULE ITSELF. The Hub marks whoever made the group as `role: 'owner'`, and the original
  // code took that as the admin verbatim. In `mode: 'admin'` the admin is the ONLY member a round
  // calls, so the group had exactly one candidate — a human this machine cannot run a turn for.
  // That is the second half of "no greeting, no reply". The admin must answer HERE.
  assert.notEqual(room.adminId, person.id, 'a person can never lead a round this machine runs')
  assert.ok(answerable(room).some(member => member.id === room.adminId),
    `the admin must be one of this team's Bots, got ${room.adminId}`)
  // Still exactly the picked Bot: leading the group must not invent or drop a member.
  assert.equal(answerable(room).length, 1)
})

// 「你说话 → 有回复」端到端，走真实产品路径。
//
// 前面两个测试断言的是“成员在数据上能回答”。这一条断言的是那个事实真的走完了整条链：
// 真实 `send` 端点 → `postToSession` → 群 Session 的 prompt → `llm/stream` 的 relay →
// `workgroup_relay` 工具 → `sessionFor` 取到**本机 Bot 的 Session** → 成员回答进群日志。
//
// 这就是用户报的那条路径。它之前一次都没跑通过：`sessionFor` 对每个成员都退给 Hub，
// 于是 group 永远等不到任何人，日志里只有用户自己那一行。
test('what the user types in a workgroup is answered by this machine\'s own Bot', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { call, wg, rt, ctx } = await withDomain(t, { baseUrl })

  const created = await call('create-room', { name: '例会', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }] })
  assert.equal(created.ok, true, JSON.stringify(created))
  const roomId = created.value.id
  // Let the create-time kickoff settle; this test is about the user's own message.
  await new Promise(resolve => setTimeout(resolve, 60))
  wg.roomInbox.delete(roomId)

  const sent = await call('send', { roomId, text: '这周先做登录' })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  const room = wg.workgroupOf(roomId)

  // `send` prompts the group's own Session with an ordinary user message, exactly as the original
  // group composer does; the round IS that Session's relay. A test harness does not run a Session,
  // so the `user/message` the prompt would emit is played back here — the same way the original
  // domain's round tests do it.
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  await emit(roomId, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这周先做登录' }] } })
  assert.deepEqual((wg.roomInbox.get(roomId) ?? []).map(item => item.text), ['这周先做登录'],
    'the message was queued for the round, not dropped')

  // The round is the relay tool's job: the group's own Session calls `workgroup_relay`, which the
  // `llm/stream` hook synthesizes. A harness runs no model, so the tool is called directly — the
  // same shortcut the original domain's round tests take.
  const relay = ctx.registeredTools.get('workgroup_relay')
  wg.registerSessionOwner('relay-user-message', { kind: 'workgroup', workgroupId: roomId })
  const running = relay.execute({}, { agent: { id: 'relay-user-message' }, callId: 'c-user', signal: new AbortController().signal })

  const deadline = Date.now() + 20_000
  let memberSession
  while (memberSession === undefined) {
    memberSession = [...wg.roomWaiters.values()].find(entry => entry.memberId === room.members[0].id)?.sessionId
    if (Date.now() > deadline) throw new Error(`no local Session was opened for ${room.members[0].name}`)
    if (memberSession === undefined) await new Promise(resolve => setImmediate(resolve))
  }

  // The member's turn, played back the way DSH delivers it.
  await emit(memberSession, { type: 'turn/start', data: { turn: 1 } })
  await emit(memberSession, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的，我先拆接口。' }] } } })
  await emit(memberSession, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  const answered = Date.now() + 20_000
  while (!room.log.some(line => line.text === '好的，我先拆接口。')) {
    if (Date.now() > answered) {
      throw new Error(`the Bot's reply never reached the group; log=${JSON.stringify(room.log.map(line => line.text))}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await running

  // It is the Bot's line, not the user's, and it is attributed to that member.
  const line = room.log.find(entry => entry.text === '好的，我先拆接口。')
  assert.equal(line.who, 'Chief', 'the reply is the Bot\'s, under the name the group shows')
  assert.equal(line.memberId, room.members[0].id, 'and attributed to the member that answered')
  assert.equal(rt.botOf('a') !== undefined, true, 'the member really is this machine\'s Bot')
})

// A PERSON in the group is never called to answer.
//
// The original's `openingSpeakers` returns "everyone" when nobody is named, and in a LOCAL group
// that was safe: every member was a Bot this machine runs. A workgroup's roster also contains real
// people, and a person handed to the round becomes `deliverRemote` — "you were called" posted up to
// the Hub, where nobody is listening. The round then waits on a device that will never answer.
//
// Admin mode hides this (it calls the admin alone), so it only shows up in `everyone` mode or with
// `@all` — which is exactly when a person is most likely to be in the room.
test('a person in the group is a member but is never called to answer', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { call, wg } = await withDomain(t, { baseUrl })
  const created = await call('create-room', {
    name: '例会',
    members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'b', name: 'Writer', kind: 'localBot' }],
  })
  const room = wg.workgroupOf(created.value.id)
  const person = room.members.find(member => member.role === 'owner')
  assert.ok(person !== undefined, 'the creator is a member')

  // The person stays in the group: they are a real participant, and the member list shows them.
  assert.ok(room.members.some(member => member.id === person.id))

  // Asking everyone is the case that used to call the person too.
  room.mode = 'everyone'
  const speakers = wg.openingSpeakers(room, { text: '大家看看' })
  assert.equal(speakers.some(member => member.id === person.id), false, 'a person is never a speaker')
  assert.equal(speakers.length, 2, 'both Bots answer')

  // `@all` is the same list, and naming the person explicitly does not make them a speaker either.
  const all = wg.openingSpeakers(room, { text: '@all 大家看看' })
  assert.equal(all.some(member => member.id === person.id), false)
  const named = wg.openingSpeakers(room, { text: `@${person.name} 你看下` })
  assert.equal(named.some(member => member.id === person.id), false, 'naming a person does not call them')

  // A named BOT is still called, so the filter does not break ordinary @mentions.
  const toBot = wg.openingSpeakers(room, { text: '@Chief 你看下' })
  assert.deepEqual(toBot.map(member => member.name), ['Chief'])
})

// ── 邀请同事后，同事能打开群并读到消息（用户第 2 项，G4 范围）───────────────────────
//
// 方案 §8.1/§8.2 与 T08：邀请是 G4 的交付内容（`g4/NEXT-INSTRUCTION.md:42,46,48`）。这条测的是
// **被邀请的一端**：接受邀请 → 本地出现这个群 → 能读到一个本机没有创建的群的消息。
//
// 这一段的关键不是 Hub 的 fan-out（T08 已证），而是「另一台机器接受邀请后，本地有没有一个能打开的群，
// 以及群里的消息读不读得到」。机器 A 建群说话，机器 B 受邀加入后必须能看到 A 那一行。
test('a colleague who accepts an invite gets the group locally and can read its messages', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const guest = await hub.post('/v1/auth/register', { phone: '+8613900139000', password: PASSWORD })
  assert.equal(guest.status < 300, true, JSON.stringify(guest))

  // Machine A: the owner's DSH_HOME.
  const ownerHome = mkdtempSync(join(tmpdir(), 'ds-bot-owner-'))
  const guestHome = mkdtempSync(join(tmpdir(), 'ds-bot-guest-'))
  t.after(() => {
    rmSync(ownerHome, { recursive: true, force: true, maxRetries: 5 })
    rmSync(guestHome, { recursive: true, force: true, maxRetries: 5 })
  })
  const open = async (home, phone) => {
    const ctx = fakeContext()
    Object.assign(ctx, {
      llm: { listProviders: () => [] },
      workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: `w${path}`, path }), archiveSession: async () => {} },
      sessionController: {
        create: async () => ({ sessionId: `s-${Math.random().toString(16).slice(2)}` }),
        resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {} } }),
        selectModel: async () => {}, prompt: async () => ({ accepted: true }), page: async () => ({ events: [] }),
      },
      sessionTitle: { rename: async () => {} },
      sessions: { flush: async () => {} },
    })
    writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
    const rt = createRuntime(ctx, { home })
    t.after(async () => { await rt.workgroup?.bridge?.stop?.(); await ctx.dispose() })
    await rt.workgroup.hub.authenticate({ baseUrl, phone, password: PASSWORD, mode: 'login' })
    return rt.workgroup
  }

  const a = await open(ownerHome, '+8613800138000')
  const created = await a.apiHandle('create-room', { name: '例会', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }] })
  assert.equal(created.ok, true, JSON.stringify(created))
  const workgroupId = created.value.hub.workgroupId

  // A says something, so there is a message for B to read.
  const replied = await a.apiHandle('send-hub', { workgroupId, text: '这周先做登录' })
  assert.equal(replied.ok, true, JSON.stringify(replied))

  const invited = await a.apiHandle('invite-member', { workgroupId, hubUserId: guest.body.hubUserId })
  assert.equal(invited.ok, true, JSON.stringify(invited))

  // Machine B: a different DSH_HOME, a different database, the same Hub.
  const b = await open(guestHome, '+8613900139000')
  const inbox = await b.apiHandle('group-invites', {})
  assert.equal(inbox.ok, true, JSON.stringify(inbox))
  const invite = (inbox.value.incoming ?? []).find(entry => entry.workgroupId === workgroupId)
  assert.ok(invite !== undefined, `the invitation must reach B, got ${JSON.stringify(inbox.value)}`)

  const accepted = await b.apiHandle('answer-invite', { inviteId: invite.inviteId, accept: true })
  assert.equal(accepted.ok, true, JSON.stringify(accepted))

  // THE POINT: B has a room it can open, and it is the same group. Without this a colleague could
  // accept an invitation and still have nothing to click.
  await b.load()
  const room = b.roomOfHubGroup(workgroupId)
  assert.ok(room !== undefined, 'accepting the invitation creates the local room on B')

  // And B can read the message A sent. The Hub is the record; this is the pull a second machine
  // does when it opens a group.
  await b.bridge.sync(workgroupId)
  const view = await b.apiHandle('room', { id: room.id })
  assert.equal(view.ok, true, JSON.stringify(view))
  assert.ok((view.value.log ?? []).some(line => line.text === '这周先做登录'),
    `B must read A's message, got ${JSON.stringify((view.value.log ?? []).map(line => line.text))}`)
})

// 同一账号的第二台机器，打开就能看到自己在 Hub 上的群并读到消息。
//
// 这是「邀请后能查看消息」真正容易断的地方。本机只会在两种时机认识一个群：收到该群的事件
// （`bridge.js` `ensureRoom`），或在本进程里接受邀请。两者都只发生一次。于是同一账号换一台机器
// （或重装后）打开，本地没有这个群的任何记录——Hub 上明明在群里，列表里却什么都没有，
// 没得点，更读不到消息。
//
// `state` 现在会把 Hub 上已有的群对齐成本地房间，连成员表和消息一起拉下来。
test('the same account on a second machine sees the groups it is already in, with their history', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })

  const boot = async (home) => {
    const ctx = fakeContext()
    Object.assign(ctx, {
      llm: { listProviders: () => [] },
      workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: `w${path}`, path }), archiveSession: async () => {} },
      sessionController: {
        create: async () => ({ sessionId: `s-${Math.random().toString(16).slice(2)}` }),
        resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {} } }),
        selectModel: async () => {}, prompt: async () => ({ accepted: true }), page: async () => ({ events: [] }),
      },
      sessionTitle: { rename: async () => {} },
      sessions: { flush: async () => {} },
    })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
    const rt = createRuntime(ctx, { home })
    t.after(async () => { await rt.workgroup?.bridge?.stop?.(); await ctx.dispose() })
    await rt.workgroup.hub.authenticate({ baseUrl, phone: '+8613800138000', password: PASSWORD, mode: 'login' })
    return rt.workgroup
  }

  // Machine 1: this account makes the group and says something in it.
  const one = await boot(mkdtempSync(join(tmpdir(), 'ds-bot-m1-')))
  const created = await one.apiHandle('create-room', { name: '例会', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }] })
  const workgroupId = created.value.hub.workgroupId
  await one.apiHandle('send-hub', { workgroupId, text: '这周先做登录' })
  await one.bridge.stop()

  // Machine 2: the same account, a different DSH_HOME. Nothing local mentions this group, and no
  // event for it has ever arrived here.
  const two = await boot(mkdtempSync(join(tmpdir(), 'ds-bot-m2-')))
  const state = await two.apiHandle('state', {})
  assert.equal(state.ok, true, JSON.stringify(state))
  const adopted = (state.value.rooms ?? []).find(room => room.hubWorkgroupId === workgroupId)
  assert.ok(adopted !== undefined,
    `a group this account is in on the Hub must appear here too, got ${JSON.stringify((state.value.rooms ?? []).map(room => room.hubWorkgroupId))}`)

  // It is a real room, not a placeholder: the same name, the Hub's members, and the history.
  assert.equal(adopted.name, '例会', 'the Hub owns the name')
  const view = await two.apiHandle('room', { id: adopted.id })
  assert.equal(view.ok, true, JSON.stringify(view))
  assert.ok((view.value.members ?? []).length >= 1, 'the roster came with it')
  assert.ok((view.value.log ?? []).some(line => line.text === '这周先做登录'),
    `the history is readable, got ${JSON.stringify((view.value.log ?? []).map(line => line.text))}`)

  // Adopting is idempotent: a second read must not create a second room for the same Hub group.
  const again = await two.apiHandle('state', {})
  const matches = (again.value.rooms ?? []).filter(room => room.hubWorkgroupId === workgroupId)
  assert.equal(matches.length, 1, 'one Hub group, one local room')
})

// 建群后必须有人开口：问候由「成员表就绪」触发，而不是建房间那一刻。
//
// 这是用户报的「没有原版群聊的初始化和介绍」。`createWorkgroup` 确实会立刻问候，但那只适用于
// 「建的时候成员已经在里面」的情形。走 Hub 建群不是：`ensureLinkedGroup` 建房间时刻意**不带成员**
// （成员归 Hub 所有），于是 `adminId` 是 null，`greetWorkgroup` 直接 return。之后再没有人叫过它——
// 成员表是后来才到的——所以登录状态下建的工作群打开就是一张白纸，没有问候也没有介绍，
// 而同名的本地群却正常。
//
// 修复点就是「成员表第一次就绪」这个时刻：那是 Hub 群第一次真的有人可以说话。
test('a workgroup created on the Hub opens with a greeting, once its roster arrives', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { call, wg, ctx } = await withDomain(t, { baseUrl })

  const followups = []
  // The group's own Session is prompted with the kickoff; that is what "the group speaks first".
  ctx.sessionController.resolveAgent = async sessionId => ({
    agent: {
      session: { id: sessionId },
      followup: message => followups.push({ sessionId, message }),
    },
  })

  const created = await call('create-room', { name: '例会', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }] })
  assert.equal(created.ok, true, JSON.stringify(created))

  // The roster arrives with the Hub's answer, and that is the moment the group can speak.
  const deadline = Date.now() + 20_000
  while (!followups.some(entry => entry.message.source?.role === 'kickoff')) {
    if (Date.now() > deadline) {
      throw new Error(`the group never greeted; followups=${JSON.stringify(followups.map(entry => entry.message.source?.role))}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const kickoff = followups.find(entry => entry.message.source?.role === 'kickoff')
  assert.equal(kickoff.sessionId, created.value.id, 'into the group\'s own Session')

  // And only ONCE: the roster is re-applied on every membership change, and a group that greeted
  // again on each one would post a fresh "what is this group for?" every time somebody joined.
  const room = wg.workgroupOf(created.value.id)
  assert.equal(room.greeted, true, 'the group is marked as greeted')
  const before = followups.filter(entry => entry.message.source?.role === 'kickoff').length
  await wg.syncRoster({ hubWorkgroupId: room.hubWorkgroupId })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(followups.filter(entry => entry.message.source?.role === 'kickoff').length, before,
    're-applying the roster must not greet again')
})

// 收件箱的 CURD 顶点：邀请在对方的收件箱里出现，接受后群就在他的列表里。
//
// 这条断言的是「收件箱这个入口背后真的有东西」——否则侧栏多一个按钮，点开永远是空的。
test('an invitation reaches the invitee\'s inbox and joining puts the group in their list', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const guest = await hub.post('/v1/auth/register', { phone: '+8613900139000', password: PASSWORD })

  const boot = async (phone) => {
    const home = mkdtempSync(join(tmpdir(), 'ds-bot-inbox-'))
    const ctx = fakeContext()
    Object.assign(ctx, {
      llm: { listProviders: () => [] },
      workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: `w${path}`, path }), archiveSession: async () => {} },
      sessionController: {
        create: async () => ({ sessionId: `s-${Math.random().toString(16).slice(2)}` }),
        resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {} } }),
        selectModel: async () => {}, prompt: async () => ({ accepted: true }), page: async () => ({ events: [] }),
      },
      sessionTitle: { rename: async () => {} },
      sessions: { flush: async () => {} },
    })
    writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
    const rt = createRuntime(ctx, { home })
    t.after(async () => { await rt.workgroup?.bridge?.stop?.(); await ctx.dispose() })
    await rt.workgroup.hub.authenticate({ baseUrl, phone, password: PASSWORD, mode: 'login' })
    return rt.workgroup
  }

  const a = await boot('+8613800138000')
  const created = await a.apiHandle('create-room', { name: '例会', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }] })
  const workgroupId = created.value.hub.workgroupId
  const invited = await a.apiHandle('invite-member', { workgroupId, hubUserId: guest.body.hubUserId })
  assert.equal(invited.ok, true, JSON.stringify(invited))

  // THE INBOX, as the button reads it: one pending invitation, naming the group and the inviter.
  const b = await boot('+8613900139000')
  const inbox = await b.apiHandle('group-invites', {})
  assert.equal(inbox.ok, true, JSON.stringify(inbox))
  const rows = inbox.value.incoming ?? []
  assert.equal(rows.length, 1, `the inbox shows the invitation, got ${JSON.stringify(rows)}`)
  assert.equal(rows[0].groupName, '例会', 'the row names the group')
  assert.equal(rows[0].inviteId, invited.value.inviteId)
  assert.ok(rows[0].invitedByPhoneMasked !== undefined, 'and who asked')

  // It is NOT in the list yet — an unanswered invitation is not a group.
  const before = await b.apiHandle('state', {})
  assert.equal((before.value.rooms ?? []).some(room => room.hubWorkgroupId === workgroupId), false,
    'an unanswered invitation must not appear as a joined group')

  // Answering it is what puts the group in the list.
  const joined = await b.apiHandle('answer-invite', { inviteId: rows[0].inviteId, accept: true })
  assert.equal(joined.ok, true, JSON.stringify(joined))
  const after = await b.apiHandle('state', {})
  assert.ok((after.value.rooms ?? []).some(room => room.hubWorkgroupId === workgroupId),
    'after joining, the group is in the list')

  // And the inbox is empty afterwards: an answered invitation is not still pending.
  const emptied = await b.apiHandle('group-invites', {})
  assert.equal((emptied.value.incoming ?? []).length, 0, 'a joined invitation leaves the inbox')
})

test('declining an invitation takes it out of the inbox and adds no group', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const guest = await hub.post('/v1/auth/register', { phone: '+8613900139000', password: PASSWORD })

  const boot = async (phone) => {
    const home = mkdtempSync(join(tmpdir(), 'ds-bot-decline-'))
    const ctx = fakeContext()
    Object.assign(ctx, {
      llm: { listProviders: () => [] },
      workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: `w${path}`, path }), archiveSession: async () => {} },
      sessionController: {
        create: async () => ({ sessionId: `s-${Math.random().toString(16).slice(2)}` }),
        resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {} } }),
        selectModel: async () => {}, prompt: async () => ({ accepted: true }), page: async () => ({ events: [] }),
      },
      sessionTitle: { rename: async () => {} },
      sessions: { flush: async () => {} },
    })
    writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
    const rt = createRuntime(ctx, { home })
    t.after(async () => { await rt.workgroup?.bridge?.stop?.(); await ctx.dispose() })
    await rt.workgroup.hub.authenticate({ baseUrl, phone, password: PASSWORD, mode: 'login' })
    return rt.workgroup
  }

  const a = await boot('+8613800138000')
  const created = await a.apiHandle('create-room', { name: '例会', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }] })
  const workgroupId = created.value.hub.workgroupId
  await a.apiHandle('invite-member', { workgroupId, hubUserId: guest.body.hubUserId })

  const b = await boot('+8613900139000')
  const inbox = await b.apiHandle('group-invites', {})
  const invite = (inbox.value.incoming ?? [])[0]

  const declined = await b.apiHandle('answer-invite', { inviteId: invite.inviteId, accept: false })
  assert.equal(declined.ok, true, JSON.stringify(declined))

  const emptied = await b.apiHandle('group-invites', {})
  assert.equal((emptied.value.incoming ?? []).length, 0, 'the declined invitation leaves the inbox')
  const state = await b.apiHandle('state', {})
  assert.equal((state.value.rooms ?? []).some(room => room.hubWorkgroupId === workgroupId), false,
    'and the group is not added')
})

// The user's report: 「删除工作群，采取本应用后又出现了，反而本地群不会」.
//
// Deleting a workgroup removed the LOCAL record and told the Hub nothing. The next start then ran
// `adoptHubGroups`, which lists the account's groups on the Hub and makes a local room for every one
// without a room — so the group the person had just deleted came back, every time. A local group
// never did, because it exists only here: there is nothing left to re-adopt it from.
test('a deleted workgroup stays deleted after a restart', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { call, wg, home } = await withDomain(t, { baseUrl })
  const created = await call('create-room', {
    name: '例会', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'b', name: 'Writer', kind: 'localBot' }],
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  const workgroupId = wg.workgroupOf(created.value.id).hubWorkgroupId
  assert.ok(typeof workgroupId === 'string' && workgroupId !== '', 'the group lives on the Hub')

  const deleted = await call('delete-room', { id: created.value.id })
  assert.equal(deleted.ok, true, JSON.stringify(deleted))
  assert.equal(wg.roomOfHubGroup(workgroupId), undefined, 'the local room is gone')

  // A restart, reading only the disk — the exact step the person takes.
  await wg.bridge.stop()
  const restarted = await reopenDomain(t, home)
  const state = await restarted.call('state', {})
  const back = (state.value.rooms ?? []).filter(room => room.hubWorkgroupId === workgroupId)
  assert.deepEqual(back, [], `a deleted workgroup must not come back, got ${JSON.stringify(back.map(room => room.name))}`)
  assert.equal(restarted.wg.roomOfHubGroup(workgroupId), undefined)
})

// The other half: the same restart must still ADOPT a group this machine has never opened, or the
// fix above would have been "stop adopting", which breaks the colleague's second machine.
test('a restart still adopts a group that was never deleted', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await hub.post('/v1/auth/register', { phone: '+8613800138000', password: PASSWORD })
  const { call, wg, home } = await withDomain(t, { baseUrl })
  const created = await call('create-room', {
    name: '例会', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'b', name: 'Writer', kind: 'localBot' }],
  })
  const workgroupId = wg.workgroupOf(created.value.id).hubWorkgroupId

  await wg.bridge.stop()
  const restarted = await reopenDomain(t, home)
  const state = await restarted.call('state', {})
  const adopted = (state.value.rooms ?? []).filter(room => room.hubWorkgroupId === workgroupId)
  assert.equal(adopted.length, 1, 'a group that still exists must still be found on restart')
})
