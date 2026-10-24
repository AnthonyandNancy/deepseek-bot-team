// Who is in a workgroup, and what a colleague's copy of it contains.
//
// Three reports from the user, all of them about the same seam — the Hub's roster and the local
// room disagreeing about membership:
//
//   1. 「邀请同事进工作群且同事同意加入后，至少需要同事+他的管家 bot 一起进入」
//      Accepting an invitation inserted the person only (`member_type='user'`). Their Bot was never
//      added, so a colleague arrived in the group with nothing that could answer on their side.
//
//   2. 「群历史消息包括现有实时消息没显示在同事的同个工作群里」
//      Not a pull problem. `appendLine` had fourteen callers and not one of them sent anything to
//      the Hub, so a group whose conversation is mostly Bots had a Hub log containing only what
//      people typed. A colleague pulled an almost empty group because there was nothing to pull.
//
//   3. 「先建群后邀请新的 bot 进群，管家 bot 无法调用和对话这个新的 bot」
//      The composer sends `{ add: [id] }`, and `updateWorkgroup` stored a bare `{ id, name }`. Every
//      `kind` test in the domain then read that member as somebody else's — no local Session, so
//      the round posted "you were named" at the Hub and nothing came back.
//
// The rule for this file is the same as `workgroup-e2e.test.js`: only `apiHandle`, the door the
// client uses. No `bridge.start()`, no `wg.openWork`, no hand-built fixtures that bypass the product.
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

// Two machines, each with a Main Bot — `mainBotIds[0]` is what the plugin calls the team's 管家,
// and it is the one that must travel with its owner.
const TEAM = (main, second) => ({
  version: 1,
  mainBotIds: [main.id],
  workspaceId: 'w1',
  bots: { [main.id]: { ...main, sessionId: main.id, createdAt: 1 }, [second.id]: { ...second, sessionId: second.id, createdAt: 2 } },
  rooms: {},
  agents: {}, capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, works: {},
  questions: {}, views: {}, prefs: {}, switching: {}, revision: 0,
})

const ALICE_TEAM = TEAM(
  { id: 'a', name: 'Chief', role: 'Boss' },
  { id: 'a2', name: 'Researcher', role: 'Research' },
)
const BOB_TEAM = TEAM(
  { id: 'b', name: 'BobChief', role: 'Boss' },
  { id: 'b2', name: 'BobWriter', role: 'Write' },
)

async function withHub(t) {
  const { createHub } = await import('../../../hub/src/server.js')
  const { createMemoryLogger } = await import('../../../hub/src/log.js')
  const dataDir = mkdtempSync(join(tmpdir(), 'ds-bot-wg-member-hub-'))
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

// One signed-in machine. `team` is the state file its Bots live in; everything else is the same
// stub the other end-to-end workgroup tests use.
async function machine(t, { baseUrl, phone, team }) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-wg-member-home-'))
  const home = join(root, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  // DSH'S PERMISSION CATALOG, which a real Harness always provides.
  //
  // The group's shared preset (`room.permission`) is validated against it — `rt.cleanRoomPermission`
  // calls `service.resolve(name)` — so without it the host refuses every permission change with
  // "Permissions are not available in this DeepSeek Harness". That is correct behaviour for a Harness
  // with no presets; the stub is here so this file can test the sync, not the absence.
  const presetOf = new Map()
  const PRESETS = ['read-only', 'workspace-write', 'danger-full-access']
  const permissionPresets = {
    catalog: () => ({ options: PRESETS.map(value => ({ value, name: value })), defaultPreset: 'workspace-write' }),
    resolve: (name) => { if (!PRESETS.includes(name)) throw new Error(`permission: unknown preset "${name}"`) },
    set: (session, name) => { presetOf.set(session?.id, name) },
  }
  const ctx = fakeContext({ services: { permissionPresets } })
  const workspaces = new Map()
  const followups = []
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
      resolveAgent: async sessionId => ({
        agent: {
          session: { id: sessionId },
          followup: (message) => { followups.push({ sessionId, message }) },
          cancel: () => {},
        },
      }),
      selectModel: async () => {},
      prompt: async ({ sessionId, content, source }) => { followups.push({ sessionId, message: { content, source } }); return { accepted: true } },
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  // What was delivered into each Session, so a test can replay it through the real listener without
  // reaching into a private field. `registeredTools` and `listeners` come from `fakeContext`.
  ctx.followups = followups
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
  return { rt, wg, call, followups, presetOf }
}

async function until(predicate, { timeoutMs = 8000, label = 'condition' } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

// Alice makes a group with her Chief Bot and invites Bob. Bob accepts through the panel's own
// endpoint. Returns both machines and the Hub's id for the group.
async function invitedPair(t) {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE, team: ALICE_TEAM })
  const bob = await machine(t, { baseUrl, phone: BOB, team: BOB_TEAM })
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })

  const created = await alice.call('create-room', { name: '联调', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'a2', name: 'Researcher', kind: 'localBot' }] })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const workgroupId = created.value.hub?.workgroupId
  assert.ok(workgroupId !== undefined, 'a signed-in machine creates the group on the Hub too')

  const invited = await alice.call('invite-member', { workgroupId, phone: BOB })
  assert.equal(invited.ok, true, JSON.stringify(invited.error))
  const incoming = await bob.call('group-invites', {})
  assert.equal(incoming.value.incoming.length, 1, 'Bob sees the invitation')
  const accepted = await bob.call('answer-invite', { inviteId: incoming.value.incoming[0].inviteId, accept: true })
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error))
  // BOB BRINGS HIS OWN BOT, ON PURPOSE.
  //
  // Accepting an invitation used to add the colleague's butler automatically. The user has ruled that
  // out (「去掉强制要求携带管家 bot 入群的限制，每个 bot 的权限由群设置」), so a join now adds the
  // person and nothing else, and bringing a Bot is a separate, explicit act — the same call the
  // group's member list makes. Everything below needs Bob's Bot present, so this helper does what a
  // person would: it puts `mainBotIds[0]` in.
  const joined = await bob.wg.bridge.joinWithPrimaryBot({ workgroupId })
  assert.equal(joined.length, 1, `Bob's butler joined through the product path: ${JSON.stringify(joined)}`)
  return { baseUrl, alice, bob, workgroupId }
}

// 1. Accepting an invitation adds the PERSON; their Bot is added by them, deliberately.
test('accepting an invitation adds the colleague, and their Bot is added explicitly', async (t) => {
  const { alice, workgroupId } = await invitedPair(t)
  const roster = await alice.call('group-members', { workgroupId })
  assert.equal(roster.ok, true, JSON.stringify(roster.error))
  const members = roster.value.members ?? []
  const names = members.map(member => member.name)

  // The person.
  assert.ok(members.some(member => member.memberType === 'user'), `Bob is a member: ${JSON.stringify(names)}`)
  // AND the one Bot `invitedPair` added explicitly. Accepting adds NO Bot by itself — that is the
  // user's rule — so this asserts the explicit add lands in the roster the other machine reads.
  assert.ok(members.some(member => member.memberType === 'botEndpoint' && member.name === 'BobChief'),
    `Bob's Main Bot is in the group: ${JSON.stringify(members.map(member => `${member.memberType}:${member.name}`))}`)
  // Only the one that was added, not the whole team: plan §7.4 — a join is one Bot, not a stampede.
  assert.equal(members.some(member => member.name === 'BobWriter'), false,
    'the rest of Bob\'s team stays out of the group')
})

// (kept as a local probe; not tracked by this repository)
//
// The invited machine creates its local room only when the invitation is accepted. That room starts
// with no members (the Hub owns the roster), so it cannot greet at creation; its first roster is the
// first moment somebody can answer. Nothing asked it to greet then, so a colleague joined into an
// empty group: the reported 「邀请同事加入后，没有跟原群聊一样初始化由管理员接待」. The fix routes the
// first roster of EVERY room — created or joined — through the same one-shot kickoff.
test('accepting an invitation initialises the joined room with an admin kickoff', async (t) => {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE, team: ALICE_TEAM })
  const bob = await machine(t, { baseUrl, phone: BOB, team: BOB_TEAM })
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })

  const created = await alice.call('create-room', { name: '入群', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'a2', name: 'Researcher', kind: 'localBot' }] })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const workgroupId = created.value.hub.workgroupId
  const invited = await alice.call('invite-member', { workgroupId, phone: BOB })
  assert.equal(invited.ok, true, JSON.stringify(invited.error))
  const incoming = await bob.call('group-invites', {})
  const accepted = await bob.call('answer-invite', { inviteId: incoming.value.incoming[0].inviteId, accept: true })
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error))

  // A room that was never greeted before this action is the precondition; otherwise the assertion
  // below could be satisfied by the group creator's path rather than the invitee's.
  const room = bob.wg.roomOfHubGroup(workgroupId)
  assert.ok(room !== undefined, "the invitee's machine has the room")
  // The room is created by the accept and its first roster arranges the greeting; this test only
  // requires that the greeting is delivered on the JOINED room, not on the creator's copy.
  // The room's own Session is where a kickoff goes. Wait for the product path rather than reading a
  // private flag: the relay is what turns this message into the admin's opening round.
  await until(() => (bob.rt.ctx.followups ?? []).some(entry => entry.sessionId === room.id
    && entry.message?.source?.role === 'kickoff'), { label: "the invitee's group to greet" })
  assert.equal(bob.wg.workgroupOf(room.id).greeted, true, 'and it greets only once')
})

// 1b. JOINING AN ALREADY CONNECTED MACHINE BEGINS THE LIVE PULL.
//
// `hello` asks for the log of every group the account was in at handshake time. Accepting an
// invitation happens LATER on the same socket, so that list does not contain the new group. The
// roster refresh alone left the invitee with a room and no cursor: the Hub had the messages, this
// machine had none, and only a reconnect caught up. The membership notification now opens the pull.
test('a group joined on a live socket starts receiving its messages at once', async (t) => {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE, team: ALICE_TEAM })
  const bob = await machine(t, { baseUrl, phone: BOB, team: BOB_TEAM })
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })
  const created = await alice.call('create-room', { name: '实时入群', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'a2', name: 'Researcher', kind: 'localBot' }] })
  const workgroupId = created.value.hub.workgroupId
  await alice.call('invite-member', { workgroupId, phone: BOB })
  const incoming = await bob.call('group-invites', {})
  const invite = incoming.value.incoming[0]

  // A message exists BEFORE the invitee accepts. The accept path pulls the log as it creates the
  // room; what this test isolates is whether the live socket keeps that group synchronised AFTER
  // the accept, without a reconnect or a manual `syncRoster`.
  const before = '接受邀请前已经发出的消息'
  await alice.call('send-hub', { workgroupId, text: before })
  const accepted = await bob.call('answer-invite', { inviteId: invite.inviteId, accept: true })
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error))
  await until(() => (bob.wg.roomOfHubGroup(workgroupId)?.log ?? []).some(entry => entry.text === before),
    { label: 'the invitee to pull history at accept time' })

  const line = '入群之后马上发的第一条'
  const sent = await alice.call('send-hub', { workgroupId, text: line })
  assert.equal(sent.ok, true, JSON.stringify(sent.error))
  await until(() => (bob.wg.roomOfHubGroup(workgroupId)?.log ?? []).some(entry => entry.text === line),
    { label: 'the invitee to receive the first live message without a reconnect' })
})

// 2. What the bots say reaches the colleague's copy of the group.
test('a Bot answering in the group reaches the other machine', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)

  // Alice's group runs a round in which Chief answers. This is the product's own order: the user's
  // message goes into the group's Session, the group's relay tool opens the round, the round calls
  // Chief's Session, and Chief's answer becomes a line (`postInRound`).
  const room = () => alice.wg.roomOfHubGroup(workgroupId)
  assert.ok(room() !== undefined, 'Alice has the room')
  const ctx = alice.rt.ctx
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const relay = () => ctx.registeredTools.get('workgroup_relay').execute(
    {},
    { agent: { id: room().id }, callId: 'call-relay', signal: new AbortController().signal },
  )
  // The user types. `postToSession` is what the composer's `send` route calls.
  await alice.wg.postToSession(room(), '@Chief 查一下这个方向')
  // The relay the group's own turn runs.
  const running = relay()
  // THE ROUND IS ASKED TO SPEAK: `waiters` hold the member turn it is waiting on. Waiting for the
  // waiter is waiting for the product to have actually started that turn, rather than sleeping.
  const memberSession = await (async () => {
    const deadline = Date.now() + 8000
    for (;;) {
      const waiter = [...alice.wg.roomWaiters.values()].find(entry => entry.memberId === 'a')
      if (waiter !== undefined) return waiter.sessionId
      if (Date.now() > deadline) throw new Error('the round never asked Chief to speak')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  })()
  const reply = '我先查一下这个方向的公开资料。'
  await emit(memberSession, { type: 'turn/start', data: { turn: 1 } })
  await emit(memberSession, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } })
  await emit(memberSession, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await running

  // Bob's machine gets it. Waiting on the Hub's log rather than on a timer: `send` resolves once the
  // socket has the frame, and Bob's `receiveRemote` is what puts it in his room.
  const bobRoom = () => bob.wg.roomOfHubGroup(workgroupId)
  await until(() => (bobRoom()?.log ?? []).some(line => line.text === reply), {
    label: 'Bob to see the Bot\'s answer',
  })
  const seen = (bobRoom().log).find(line => line.text === reply)
  assert.equal(seen.via, 'hub', 'it arrived over the Hub, not from a local round')
  // Attributed to the BOT, not to the person whose machine ran it. On Bob's machine Alice's Chief is
  // a remote Bot, so its member id is the endpoint — but the NAME is the Bot's, which is what makes
  // the line readable and @-able instead of showing the colleague's phone number.
  assert.equal(seen.who, 'Chief', `the line names the Bot that said it: ${JSON.stringify(seen)}`)
  const chiefMember = (bobRoom().members ?? []).find(member => member.name === 'Chief')
  assert.equal(seen.memberId, chiefMember?.id, 'and it points at that member, so @Chief reaches it')
  assert.equal(chiefMember?.kind, 'remoteBot', 'on this machine Chief is another team\'s Bot, not a local one')
})

// 3. A Bot added after the group exists can be talked to.
test('a Bot added to an existing group is a local member the round can call', async (t) => {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE, team: ALICE_TEAM })
  await until(() => alice.wg.bridge.status().connected, { label: 'a socket' })

  const created = await alice.call('create-room', { name: '后加', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'a2', name: 'Researcher', kind: 'localBot' }] })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const roomId = created.value.id
  assert.ok(roomId !== undefined, JSON.stringify(created.value))

  // A third Bot on this machine, then added through the same call the settings form makes.
  const added = await alice.rt.createBot({ name: 'Analyst', role: 'Analysis' })
  assert.ok(added?.id !== undefined, 'a Bot was created to add')
  const patched = await alice.call('update-room', { id: roomId, add: [added.id] })
  assert.equal(patched.ok, true, JSON.stringify(patched.error))

  // A roster read after the add, which is what every membership change triggers. This is the read
  // that has to pick up the new member's `membershipId`; before, `applyRoster` compared only
  // id/name/kind, decided nothing had changed, and returned early with the field still missing.
  await alice.wg.syncRoster({ hubWorkgroupId: alice.wg.workgroupOf(roomId).hubWorkgroupId })
  await alice.wg.load()
  const room = alice.wg.workgroupOf(roomId)
  const member = (room.members ?? []).find(other => other.id === added.id)
  assert.ok(member !== undefined, 'the Bot is a member')
  // THE FIX. Without `kind` the round treats it as somebody on another device: `sessionFor` returns
  // `undefined` and the turn becomes a Hub post that nobody answers.
  assert.equal(member.kind, 'localBot', `a Bot of this team answers here: ${JSON.stringify(member)}`)
  assert.equal(member.name, 'Analyst')
  // AND IT MUST BE REMOVABLE LATER. `membershipId` is what the Hub is asked to remove a member by;
  // `applyRoster` used to compare only id/name/kind and return early, so a Bot added in this session
  // kept a record with no `membershipId` and 「移除成员」 had no id to send.
  assert.ok(member.membershipId !== undefined,
    `the added Bot has a membership id, so it can be removed again: ${JSON.stringify(member)}`)
})

// 4. The roster the Hub owns must not delete a local Bot the user just added.
test('a roster refresh keeps a Bot that the Hub accepted', async (t) => {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE, team: ALICE_TEAM })
  await until(() => alice.wg.bridge.status().connected, { label: 'a socket' })

  const created = await alice.call('create-room', { name: '刷新', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'a2', name: 'Researcher', kind: 'localBot' }] })
  const workgroupId = created.value.hub?.workgroupId
  assert.ok(workgroupId !== undefined)
  const roomId = created.value.id

  // Re-read the roster from the Hub, the way every membership change does.
  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })
  await alice.wg.load()
  const after = alice.wg.workgroupOf(roomId)
  const bots = (after.members ?? []).filter(member => member.kind === 'localBot')
  const ids = bots.map(member => member.id)
  assert.deepEqual(ids.sort(), ['a', 'a2'], `the group keeps its own Bots: ${JSON.stringify(after.members)}`)
  assert.equal(bots.every(member => member.botId !== undefined), true,
    'and they are still local members, not strangers')
  // The owner's own row comes back from the Hub and stays a person, never a local Bot.
  assert.equal((after.members ?? []).some(member => member.kind === 'user'), true, 'the owner is listed too')
})

// 5. A Bot removed from a Hub group is removed there too.
//
// The mirror of test 4, and the reason it has to exist: `applyRoster` replaces `room.members` from the
// Hub on every membership change. A row deleted only on this machine therefore comes straight back on
// the next roster read — 「移除成员，过一会又回来了」.
test('a Bot removed from the group is removed on the Hub too', async (t) => {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE, team: ALICE_TEAM })
  await until(() => alice.wg.bridge.status().connected, { label: 'a socket' })

  const created = await alice.call('create-room', { name: '移除', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'a2', name: 'Researcher', kind: 'localBot' }] })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const workgroupId = created.value.hub?.workgroupId
  const roomId = created.value.id
  assert.ok(workgroupId !== undefined)

  // The settings form's own call.
  const removed = await alice.call('update-room', { id: roomId, remove: ['a2'] })
  assert.equal(removed.ok, true, JSON.stringify(removed.error))

  // WHAT THE USER SEES NOW.
  await alice.wg.load()
  assert.equal((alice.wg.workgroupOf(roomId).members ?? []).some(member => member.id === 'a2'), false,
    'the member row is gone')

  // AND STILL AFTER THE HUB IS ASKED AGAIN. This is the half the bug was about: without the Hub call
  // the next roster read brought Researcher straight back.
  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })
  await alice.wg.load()
  const after = alice.wg.workgroupOf(roomId)
  assert.equal((after.members ?? []).some(member => member.id === 'a2'), false,
    `the removed Bot did not come back: ${JSON.stringify((after.members ?? []).map(member => member.name))}`)
  assert.ok((after.members ?? []).some(member => member.id === 'a'), 'the other Bot stayed')
})

// 6. The whole-list form of the same edit (`{ members: [...] }`) removes on the Hub as well. Both
// shapes reach `updateWorkgroup` — the settings form uses `remove`, and this one is the original's.
test('replacing the member list removes the missing Bot on the Hub too', async (t) => {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE, team: ALICE_TEAM })
  await until(() => alice.wg.bridge.status().connected, { label: 'a socket' })

  // THREE Bots, so the whole-list form can drop one and still leave the two a group chat needs
  // (`checkMembers` is the original's own rule and stays).
  const created = await alice.call('create-room', { name: '整表', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'a2', name: 'Researcher', kind: 'localBot' }] })
  const workgroupId = created.value.hub?.workgroupId
  const roomId = created.value.id
  assert.ok(workgroupId !== undefined)
  const third = await alice.rt.createBot({ name: 'Analyst', role: 'Analysis' })
  const withThird = await alice.call('update-room', { id: roomId, add: [third.id] })
  assert.equal(withThird.ok, true, JSON.stringify(withThird.error))

  const replaced = await alice.call('update-room', { id: roomId, members: ['a', 'a2'] })
  assert.equal(replaced.ok, true, JSON.stringify(replaced.error))
  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })
  await alice.wg.load()
  const after = alice.wg.workgroupOf(roomId)
  assert.equal((after.members ?? []).some(member => member.id === third.id), false,
    'the Bot left out of the list is gone on the Hub too')
  assert.equal((after.members ?? []).some(member => member.id === 'a2'), true, 'the listed Bots stay')
})

// 7. THE ROUND ITSELF: what a person types into a Hub group must be answered by the group's Bots.
//
// This is the half the earlier fixes did not reach. `send-hub` puts the message on the Hub and stops
// there — the Hub is the record — and `receiveRemote` deliberately keeps Hub lines OUT of the group's
// own Session so a second machine does not answer the same conversation. Both are right on their own
// and together they meant that a message typed into a workgroup started NO round at all: no Bot was
// ever called, so a Bot added to the group later could never reply (and neither could one that was
// there from the start — the original local group works because it has no Hub in the middle).
test('a message typed into a Hub group starts a round the Bots answer', async (t) => {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE, team: ALICE_TEAM })
  await until(() => alice.wg.bridge.status().connected, { label: 'a socket' })

  const created = await alice.call('create-room', { name: '回合', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'a2', name: 'Researcher', kind: 'localBot' }] })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const workgroupId = created.value.hub?.workgroupId
  const roomId = created.value.id
  assert.ok(workgroupId !== undefined)

  // A third Bot, added AFTER the group exists — the report's exact case.
  const third = await alice.rt.createBot({ name: 'Analyst', role: 'Analysis' })
  const added = await alice.call('update-room', { id: roomId, add: [third.id] })
  assert.equal(added.ok, true, JSON.stringify(added.error))

  // The composer's own call for a Hub group.
  const sent = await alice.call('send-hub', { workgroupId, text: '@Analyst 看一下这个方向' })
  assert.equal(sent.ok, true, JSON.stringify(sent.error))

  // THE FIX. The line must reach the group's own Session, because that is what starts a round:
  // `postToSession` is the call the local composer makes, and the relay hook turns its message into
  // work. Before, a Hub group's composer went to the Hub and nowhere else, so no round ever started
  // and no Bot was ever asked — which is why a Bot added later could not answer.
  //
  // What was written into the group's Session is read back through the runtime rather than through a
  // private field: this test's stubs do not emit `session/event` for a delivery, and the product
  // order is the group Session's message first, then the relay.
  // `postToSession` asks the runtime for the group's Session (`rt.resolveAgent(room.id)`); in the real
  // DSH that id IS the room id (`createWorkgroup` makes the room a Session), and this test's stub
  // answers with a generated one. What matters here is that the line was handed to the group's own
  // Conversation at all — before the fix nothing was.
  // The line comes back through the Hub's ack, so wait for it rather than reading the moment the send
  // returns: `send-hub` resolves when the frame is on the wire, and the ack arrives after.
  const findPosted = () => (alice.rt.ctx.followups ?? []).filter(entry => entry.message?.source?.kind === 'user'
    && String(entry.message?.content?.[0]?.text ?? '').includes('@Analyst'))
  const waitPosted = async () => {
    const deadline = Date.now() + 8000
    for (;;) {
      if (findPosted().length > 0) return true
      if (Date.now() > deadline) return false
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const posted = await waitPosted() ? findPosted() : []
  assert.equal(posted.length > 0, true,
    "the typed line must be posted into the group's own Session, which is what starts a round")

  // AND THE ROUND ANSWERS IT. Replaying that message through the real listener is the product's own
  // order: the group Session receives it, the listener queues it, the relay opens the round.
  const emit = async (sessionId, event) => {
    for (const listener of alice.rt.ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  await emit(roomId, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '@Analyst 看一下这个方向' }] },
  })
  // The round is aborted as soon as the point is proved: this test is about the round STARTING and
  // naming the right member, and waiting for a stub turn to finish would only test the stub's timing
  // (the reply path is covered by the tests above).
  const controller = new AbortController()
  const relayed = alice.rt.ctx.registeredTools.get('workgroup_relay').execute(
    {},
    { agent: { id: roomId }, callId: 'call-relay', signal: controller.signal },
  )
  const called = async () => {
    const deadline = Date.now() + 8000
    for (;;) {
      if ([...alice.wg.roomWaiters.values()].some(waiter => waiter.memberId === third.id)) return true
      if (Date.now() > deadline) return false
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const started = await called()
  controller.abort()
  await relayed.catch(() => {})
  assert.equal(started, true,
    'the addressee must be given a turn: no round means no Bot ever answers')
})

// 7b. A PLAIN MESSAGE FROM THE INVITEE GOES TO THE ADMIN, NOT TO THE INVITEE'S OWN BOT.
//
// This is the user's exact sentence: 「同事如果没有点名 @ 其他同事的 bot，跟原群聊一样由管理员接待」.
// The composer path is already proven above; what matters here is WHICH speaker the round picks
// after an invitation. Bob is a member with his own Bot in the group, and Alice's Main Bot is the
// lead. A plain message must not be answered merely because Bob also has a local Bot; the admin on
// Alice's machine has to be called over the Hub.
test('a plain message from the invitee is delivered to the group admin', async (t) => {
  const { bob, workgroupId } = await invitedPair(t)
  const bobRoom = () => bob.wg.roomOfHubGroup(workgroupId)
  await until(() => bobRoom()?.members?.some(member => member.kind === 'remoteBot'),
    { label: "Bob's copy to hold Alice's admin as a remote Bot" })
  const room = bobRoom()
  const admin = (room.members ?? []).find(member => member.id === room.adminId)
  assert.ok(admin !== undefined, 'Bob resolves the shared admin')
  assert.equal(admin.kind, 'remoteBot', "the admin is Alice's Bot, not a Bot on Bob's machine")

  // Selection: no @mention, admin mode -> exactly the admin.
  assert.deepEqual(bob.wg.openingSpeakers(room, { text: '这版方案什么时候能看？' }).map(member => member.id),
    [room.adminId], 'a plain message selects the admin alone')

  // And the round sends it as a CALL to the admin's endpoint. A local fallback would pick Bob's own
  // Bot and the admin would never hear the message.
  const calls = []
  const deliver = bob.wg.deliverRemote
  bob.wg.deliverRemote = async args => {
    calls.push({ name: args.member.name, endpointId: args.member.endpointId, note: args.slot?.note, exchangeId: args.slot?.exchangeId })
    return { sent: true, eventId: 'evt_plain_admin' }
  }
  t.after(() => { bob.wg.deliverRemote = deliver })

  bob.wg.roomInbox.set(room.id, [{ text: '这版方案什么时候能看？', who: 'User' }])
  bob.wg.registerSessionOwner('relay-plain-admin', { kind: 'workgroup', workgroupId: room.id })
  const controller = new AbortController()
  const relayed = bob.rt.ctx.registeredTools.get('workgroup_relay').execute(
    {}, { agent: { id: 'relay-plain-admin' }, callId: 'call-plain-admin', signal: controller.signal },
  )
  await until(() => calls.length > 0, { label: "the admin's call" })
  // The round now waits for the called member's answer under the exchange it sent, exactly as a
  // local slot waits for its member's turn. This stub does not run a Hub; deliver the answer the
  // way `receiveRemote` would, then let the round finish rather than aborting it mid-wait.
  const round = [...bob.wg.roomProgress.values()].find(entry => entry.roomId === room.id)
  const waiter = round?.remoteWaiters?.get(calls[0].exchangeId)
  assert.ok(waiter !== undefined, 'the caller waits for the remote exchange before moving on')
  waiter.resolve({ text: '看过了，没问题' })
  await relayed.catch(() => {})
  assert.equal(calls[0].endpointId, admin.endpointId, 'the call names the admin endpoint')
})

// 7c. A REMOTE MEMBER'S ORDINARY ANSWER DOES NOT CALL THE ADMIN; ITS @MENTION DOES.
//
// The copied `openingSpeakers` has the original's rule: a member's post calls only the members it
// NAMES (`opener.member`), while a person's plain message goes to the admin in `admin` mode. The
// receive path has to preserve WHICH of those two it is carrying across the Hub. Without the flag a
// colleague's Bot answer was read as the user speaking, so every no-@ reply called the admin again.
test("a remote member's post keeps the original member-vs-user speaker rule", async (t) => {
  const { bob, workgroupId } = await invitedPair(t)
  const room = bob.wg.roomOfHubGroup(workgroupId)
  assert.ok(room !== undefined, 'Bob has the room')
  const adminId = room.adminId
  assert.ok(adminId !== undefined && adminId !== null, 'the group has an admin')

  const plain = bob.wg.openingSpeakers(room, { member: true, botId: 'ep_somebody', text: '我这边做完了' })
  assert.deepEqual(plain.map(member => member.id), [],
    "a member answer with no @ calls nobody, exactly as a local group member's answer does")

  const named = bob.wg.openingSpeakers(room, { member: true, botId: 'ep_somebody', text: '@Chief 你看一下' })
  assert.deepEqual(named.map(member => member.id), [adminId],
    'naming the admin in a member answer calls exactly the admin')
})

// 8. A CALL REACHES THE COLLEAGUE'S BOT, AND ITS ANSWER COMES BACK.
//
// The round on Alice's machine cannot run a turn for Bob's Bot: `sessionFor` returns `undefined` for
// a `remoteBot` and the slot goes to `wg.deliverRemote`. That used to post
// "「BobChief」, you were called in this round" as an ordinary group line, and NOTHING turned it into
// a turn on Bob's machine — `receiveRemote` deliberately keeps Hub lines out of the group's Session
// so a second machine does not answer the same conversation twice, which is right for a line
// somebody said and wrong for an instruction. Bob's butler therefore received the "@" and never ran.
//
// This test is the whole cross-user path, both halves:
//   Alice's round names Bob's Bot  ->  a call on the Hub  ->  Bob's machine runs that Bot's turn
//   ->  the reply is posted and mirrored  ->  Alice's copy of the group shows it.
//
// It goes through `apiHandle` and the real round, and it drives Bob's turn by replaying the
// `session/event`s DSH would emit, which is what the other round tests in this suite do.
test('a Bot on the colleague\'s machine is called and its answer comes back', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)

  // Bob's Chief is in the group as a remote Bot on Alice's machine, which is the member her round
  // has to call. Asserted rather than assumed: the rest of the test means nothing if it is missing.
  const aliceRoom = () => alice.wg.roomOfHubGroup(workgroupId)
  const bobChief = () => (aliceRoom()?.members ?? []).find(member => member.name === 'BobChief')
  await until(() => bobChief() !== undefined, { label: 'Bob\'s butler on Alice\'s roster' })
  assert.equal(bobChief().kind, 'remoteBot', 'Alice cannot run a turn for it')

  // THE FIRST HALF: Alice's round calls it. `send-hub` is the composer's own route, and the round is
  // the relay the group's Session runs.
  const sent = await alice.call('send-hub', { workgroupId, text: '@BobChief 你们那边接口定了吗？' })
  assert.equal(sent.ok, true, JSON.stringify(sent.error))
  // THE ROUND ITSELF DELIVERS THE CALL — no hand-made `deliverRemote`, because the claim is that the
  // product's own round reaches the colleague. `@BobChief` is the only name in the message, so the
  // opening speakers are exactly that one member, and it is a remote Bot on this machine.
  // The line reaches Alice's group Session from the Hub's ack (`receiveRemote` with `mine`), and the
  // `user/message` that prompt emits is what queues it for the round. A harness runs no Session, so
  // that event is played back here — the same shortcut the other round tests in this suite take.
  const aliceEmit = async (sessionId, event) => {
    for (const listener of alice.rt.ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  await until(() => (alice.rt.ctx.followups ?? []).some(entry => String(entry.message?.content?.[0]?.text ?? '').includes('@BobChief')),
    { label: 'the typed line to reach the group Session' })
  await aliceEmit(aliceRoom().id, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '@BobChief 你们那边接口定了吗？' }] },
  })
  assert.deepEqual((alice.wg.roomInbox.get(aliceRoom().id) ?? []).map(item => item.text), ['@BobChief 你们那边接口定了吗？'],
    'the message is queued for the round, so the round knows what to answer')

  const controller = new AbortController()
  const relayed = alice.rt.ctx.registeredTools.get('workgroup_relay').execute(
    {},
    { agent: { id: aliceRoom().id }, callId: 'call-cross-user', signal: controller.signal },
  )
  // Registered on the test rather than written after the last assertion: a failing assertion throws,
  // and a relay left pending would keep the whole file's run alive until `WG_REPLY_TIMEOUT_MS`.
  t.after(async () => {
    controller.abort()
    await relayed.catch(() => {})
  })
  // THE SECOND HALF: Bob's machine runs that Bot's turn. Waiting on the turn rather than on a timer:
  // the Hub is the transport and this is the moment the product has actually started the work.
  const bobRoom = () => bob.wg.roomOfHubGroup(workgroupId)
  await until(() => bobRoom() !== undefined, { label: 'Bob has the room' })
  const waiter = async () => {
    const deadline = Date.now() + 10_000
    for (;;) {
      const found = [...bob.wg.roomWaiters.values()].find(entry => entry.roomId === bobRoom()?.id)
      if (found !== undefined) return found
      if (Date.now() > deadline) return undefined
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const started = await waiter()
  assert.ok(started !== undefined,
    'Bob\'s machine must run a turn for the Bot that was called: a call that is never turned into a turn is the bug')

  // The answer, played back the way DSH delivers a member's turn.
  const emit = async (sessionId, event) => {
    for (const listener of bob.rt.ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const answer = '@Chief 定了，我们这边周四给第一版。'
  await emit(started.sessionId, { type: 'turn/start', data: { turn: 1 } })
  await emit(started.sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: answer }] } } })
  await emit(started.sessionId, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  // AND IT COMES BACK. The reply is a group line on Bob's machine, mirrored to the Hub, and Alice
  // draws it from her own event stream.
  await until(() => (bobRoom()?.log ?? []).some(line => line.text === answer), { label: 'Bob\'s group to hold the answer' })
  await until(() => (aliceRoom()?.log ?? []).some(line => line.text === answer), {
    label: 'Alice to receive the colleague\'s Bot answer',
  })
  const seen = (aliceRoom().log).find(line => line.text === answer)
  assert.equal(seen.via, 'hub', 'it arrived over the Hub')
  assert.equal(seen.who, 'BobChief', `the line names the Bot that answered, not the colleague: ${JSON.stringify(seen)}`)

  // AND THE HAND-OFF CONTINUES IN THE SAME ROUND. In the original group the current speaker's
  // @mention adds the next speaker to the SAME round. Bob's Bot answered on Bob's machine; Alice
  // receives that answer under the exchange her round is waiting on, and the round itself must add
  // Chief as the next slot. Opening a second relay here would reset the speaking order, which is the
  // drift the user described between a workgroup and the original group.
  const aliceChief = () => [...alice.wg.roomWaiters.values()].find(entry => entry.roomId === aliceRoom().id && entry.memberId === 'a')
  await until(() => aliceChief() !== undefined, { label: "Alice's Chief to be called inside the original round" })
  const next = aliceChief()
  await aliceEmit(next.sessionId, { type: 'turn/start', data: { turn: 1 } })
  await aliceEmit(next.sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到，我们按周四排。' }] } } })
  await aliceEmit(next.sessionId, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await until(() => (aliceRoom().log ?? []).some(line => line.text === '收到，我们按周四排。'),
    { label: 'the next local speaker to answer' })
  // The original round is the one that produced both answers; no second relay was started.
  await relayed.catch(() => {})
  assert.equal((alice.wg.roomProgress.size), 0, 'the original round finished after its local continuation')
  // The remote Bot line is a member contribution, not a person typing. It may become the opener of
  // the hand-off round, but its authorship must survive: if it were read as the USER, `botId` would
  // be lost and the @Name in it would no longer be attributed to the Bot that wrote it.
  assert.equal((alice.wg.roomInbox.get(aliceRoom().id) ?? []).some(item => item.botId === undefined), false,
    'a Bot answer from the Hub is not queued as an unidentified user message')
})

// 9. NOBODY PUTS A BOT INTO A GROUP ON THE MEMBER'S BEHALF.
//
// This used to be a repair: a colleague who was in a group with none of their Bots had the team's
// butler added automatically, on every connect. The user has ruled the whole idea out — 「去掉强制
// 要求携带管家 bot 入群的限制，每个 bot 的权限由群设置」 — because it decides FOR a person which of
// their Bots joins a group.
//
// So the test is the inverse of the old one: a group with none of Bob's Bots STAYS that way after a
// reconnect and after the old repair button. What a person does instead is add the Bot they want,
// which is the next test.
test('a colleague is never given a Bot automatically, even with none of their own in the group', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)

  // The state the old repair existed for: the person is a member, their Bot is not.
  const roster = await alice.call('group-members', { workgroupId })
  assert.equal(roster.ok, true, JSON.stringify(roster.error))
  const bobBot = roster.value.members.find(member => member.memberType === 'botEndpoint' && member.name === 'BobChief')
  assert.ok(bobBot !== undefined, "the explicit add put Bob's butler in")
  // Bob removes his own Bot, through his own machine — the Hub requires a self-removal to be his.
  const removed = await bob.wg.hub.leaveMember({ workgroupId, membershipId: bobBot.membershipId })
  assert.ok(removed !== undefined, 'the Bot left the group')
  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })

  // THE OLD REPAIR PATH, WHICH MUST NOW CHANGE NOTHING.
  const resynced = await bob.call('resync-members', { workgroupId })
  assert.equal(resynced.ok, true, JSON.stringify(resynced.error))
  assert.deepEqual(resynced.value.added, [],
    "a Bot is no longer put back automatically; adding one is the person's decision")
  const again = await alice.call('group-members', { workgroupId })
  assert.equal((again.value.members ?? []).some(member => member.name === 'BobChief'), false,
    `the group still holds none of Bob's Bots: ${JSON.stringify((again.value.members ?? []).map(member => member.name))}`)

  // AND THE PERSON CAN STILL PUT ONE IN, which is the whole point of removing the automatic path:
  // the ability did not go away, only the decision being taken for them.
  const added = await bob.wg.bridge.joinWithPrimaryBot({ workgroupId })
  assert.equal(added.length, 1, `Bob adds his butler himself: ${JSON.stringify(added)}`)
  const third = await alice.call('group-members', { workgroupId })
  assert.ok((third.value.members ?? []).some(member => member.name === 'BobChief'),
    'and the Hub roster has it, which is what every machine reads')
})

// 10. A BOT CARRIES ITS OWNER, SO THE ROSTER CAN SAY WHOSE IT IS.
//
// Two colleagues may each have a Bot called "Chief"; without the owner the member list is a list of
// names with no way to tell whose is whose — 「需要在每个 bot 增加标识，区分每个 bot 的归属」.
// `ownerIsYou` is computed on the Hub from the authenticated connection, never sent by the client.
test('each Bot in the roster names its owner, and only the owner is told "yours"', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)

  const fromBob = await bob.call('group-members', { workgroupId })
  assert.equal(fromBob.ok, true, JSON.stringify(fromBob.error))
  const bobSees = (fromBob.value.members ?? []).find(member => member.name === 'BobChief')
  assert.ok(bobSees !== undefined, `Bob sees his own Bot: ${JSON.stringify((fromBob.value.members ?? []).map(m => m.name))}`)
  assert.equal(bobSees.ownerIsYou, true, 'Bob is told this Bot is his')
  assert.equal(typeof bobSees.ownerUserId, 'string', 'and the owner account is named')

  const fromAlice = await alice.call('group-members', { workgroupId })
  assert.equal(fromAlice.ok, true, JSON.stringify(fromAlice.error))
  const aliceSees = (fromAlice.value.members ?? []).find(member => member.name === 'BobChief')
  assert.ok(aliceSees !== undefined, 'Alice sees the same Bot')
  assert.equal(aliceSees.ownerIsYou, false, "Alice is told it is a colleague's Bot")
  assert.equal(aliceSees.ownerUserId, bobSees.ownerUserId, 'both machines name the same owner')

  // AND THE RECORD THIS DOMAIN KEEPS CARRIES IT, which is what the roster row and the member list
  // actually read. The Hub's fields above are the input; `mine` is the one the UI branches on.
  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })
  const remoteOnAlice = (alice.wg.roomOfHubGroup(workgroupId)?.members ?? []).find(member => member.name === 'BobChief')
  assert.ok(remoteOnAlice !== undefined, "Alice's roster holds Bob's Bot")
  assert.equal(remoteOnAlice.mine, undefined, "and does NOT claim it is Alice's own")
  assert.equal(typeof remoteOnAlice.ownerUserId, 'string', 'but it does name whose it is')

  await bob.wg.syncRoster({ hubWorkgroupId: workgroupId })
  const ownOnBob = (bob.wg.roomOfHubGroup(workgroupId)?.members ?? []).find(member => member.name === 'BobChief')
  assert.ok(ownOnBob !== undefined, "Bob's roster holds it too")
  assert.equal(ownOnBob.mine, true, 'and on his machine it is marked as his')
})

// 10b. THE SAME BOT LOOKS THE SAME ON EVERY MACHINE.
//
// `lookOf()` derives a character and a colour from the id it is given, and a roster arrives with Hub
// ids (`ep_…`), so the colleague's Bot wore a different shape and a different colour on this machine
// than on its owner's — 「每个 bot 的头像是不能变的，现在是变了」. The appearance now travels with the
// published endpoint and is restored onto the member record.
test('a remote Bot keeps the appearance its owner published', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })
  const remote = (alice.wg.roomOfHubGroup(workgroupId)?.members ?? []).find(member => member.name === 'BobChief')
  assert.ok(remote !== undefined, "Alice has Bob's Bot as a member")
  assert.equal(remote.kind, 'remoteBot', "it is somebody else's Bot")
  assert.ok(remote.avatar !== undefined || remote.color !== undefined,
    `the published appearance reached the member record: ${JSON.stringify(remote)}`)
  // The expectation is taken from the Bot's OWN LOADED RECORD on its owner's machine, which is what
  // Bob's screen draws — not from the fixture literal: the runtime fills in a default colour when it
  // loads a team (`roster.js` `buildBot`), so a fixture without one is not the record anybody sees.
  const { lookOf } = await import('../src/client/characters.js')
  const own = lookOf(bob.rt.state.bots.b)
  const remoteLook = lookOf(remote)
  assert.equal(remoteLook.color, own.color, "the colour is the owner's, not one derived from the Hub id")
  assert.equal(remoteLook.shape, own.shape, 'and so is the character')
})


// 11. THE BUTLER IS ANSWERED BY NAME, SO THE SETTINGS PAGE CAN SAY WHICH BOT IT IS.
test('the member list says which of this person\'s Bots is the butler', async (t) => {
  const { bob, workgroupId } = await invitedPair(t)
  const roster = await bob.call('group-members', { workgroupId })
  assert.equal(roster.ok, true, JSON.stringify(roster.error))
  // `mainBotIds[0]` of Bob's team — the Bot a team is created with, and the one that travels with him.
  assert.equal(roster.value.butler?.botId, 'b', `the butler is mainBotIds[0]: ${JSON.stringify(roster.value.butler)}`)
  assert.equal(roster.value.butler?.name, 'BobChief')
  assert.ok(roster.value.butler?.endpointId !== undefined,
    'and it is published, which is what lets it be added to a group at all')
})

// 12. A RENAME AND A NOTICE REACH THE HUB, SO THEY DO NOT REVERT.
//
// A workgroup's title and notice live on the Hub and `ensureLinkedGroup` copies them onto every
// machine — that is how two people see the same title. The copy was one-way: a rename changed this
// machine's record, the Hub kept the old value, and the next roster read put the old one back. The
// user's report is 「设置改了又变回去」.
test('a rename and a new notice reach the Hub instead of reverting', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  const room = alice.wg.roomOfHubGroup(workgroupId)
  assert.ok(room !== undefined, 'Alice has the room')

  // The settings form's own call.
  const renamed = await alice.call('update-room', { id: room.id, name: '联调二期' })
  assert.equal(renamed.ok, true, JSON.stringify(renamed.error))
  const afterRename = await alice.wg.hub.workgroup(workgroupId)
  assert.equal(afterRename.name, '联调二期', `the first save reached the Hub: ${JSON.stringify(afterRename)}`)
  const noticed = await alice.call('update-room', { id: room.id, notice: '每周一同步进度' })
  assert.equal(noticed.ok, true, JSON.stringify(noticed.error))

  // ON THE HUB, which is what the other machine copies. Read through the Hub's own client rather
  // than from this machine's record, because the record is the thing that was already right.
  const onHub = await alice.wg.hub.workgroup(workgroupId)
  assert.equal(onHub.name, '联调二期', `the Hub holds the new name: ${JSON.stringify(onHub.name)}`)
  assert.equal(onHub.notice, '每周一同步进度', `and the new notice: ${JSON.stringify(onHub.notice)}`)

  // AND IT DOES NOT REVERT. Reading the roster is the step that used to put the old title back; the
  // Hub's value is now the new one, so the local record keeps it.
  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })
  await alice.wg.load()
  assert.equal(alice.wg.workgroupOf(room.id).name, '联调二期', 'the name survives a roster read')
  assert.equal(alice.wg.workgroupOf(room.id).notice, '每周一同步进度', 'and so does the notice')

  // Bob's machine, which never made the change, shows it too — that is what "shared setting" means.
  await bob.wg.ensureLinkedGroup({ hubWorkgroupId: workgroupId, name: onHub.name, notice: onHub.notice })
  await bob.wg.load()
  const bobRoom = bob.wg.roomOfHubGroup(workgroupId)
  assert.equal(bobRoom?.name, '联调二期', 'the colleague sees the new title')
  assert.equal(bobRoom?.notice, '每周一同步进度', 'and the new notice')
})

// 13. THE HUB REFUSES THE SETTINGS IT DOES NOT STORE, IN WORDS A CLIENT CAN ACT ON.
//
// `admin` and the working folder stay local: each machine runs its own Bots in its own folders, and a
// shared folder would be a path the Hub must never learn. The settings route keeps a closed
// allow-list, so a client learns on the first call. `replyMode` and `permission` are NOT refused any
// more — both have a column and their own tests.
test('the Hub refuses a setting it does not store, and a non-admin cannot rename a group', async (t) => {
  const { baseUrl, alice, bob, workgroupId } = await invitedPair(t)

  // THE ALLOW-LIST, at the door it protects: the client only ever offers `name` and `notice`, so a
  // stray field can only be sent straight at the Hub. This is the same route a future client will
  // call, so the refusal has to be the Hub's own.
  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: ALICE, password: PASSWORD }),
  })
  const token = (await login.json()).accessToken
  const sent = await fetch(`${baseUrl}/v1/workgroups/${workgroupId}/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'x', workDir: String.raw`C:\\Users\\alice\\work` }),
  })
  assert.equal(sent.status, 400, 'a working folder is not a Hub setting')
  assert.match(await sent.text(), /workDir/, 'and the refusal names the field')

  // Bob is a plain member: renaming the group for everyone is not his to do.
  const notAllowed = await bob.wg.hub.updateGroupSettings({ workgroupId, name: 'Bob 的群' })
    .then(() => undefined)
    .catch(error => error)
  assert.ok(notAllowed !== undefined, 'a member may not rename the group')
  const stillThere = await alice.wg.hub.workgroup(workgroupId)
  assert.equal(stillThere.name, '联调', `and the name did not change: ${stillThere.name}`)
})

// 14. WHO ANSWERS A PLAIN MESSAGE IS ONE ANSWER FOR THE WHOLE GROUP.
//
// The original keeps this on the room (`mode: 'admin' | 'everyone'`) and reads it in
// `openingSpeakers`: admin mode asks the admin alone, everyone asks all of them. A workgroup copies
// that round verbatim — what it did NOT copy was the value travelling, so it lived only in each
// machine's own state file. Two machines then answered the same message with different members.
//
// That is what the user described as 「同事如果没有点名 @ 其他同事的 bot，跟原群聊一样由管理员接待」:
// the admin接待 rule was right, and the setting that turns it on never left the machine that set it.
test('the reply mode is the same on both machines after one of them changes it', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)

  // The default is the original's own default.
  const initial = await bob.wg.hub.workgroup(workgroupId)
  assert.equal(initial.replyMode, 'admin', 'a new group asks its admin first, as a local group does')

  // Alice changes it through the product path: the settings form sends `mode`, and `updateWorkgroup`
  // pushes it to the Hub as `replyMode`.
  const changed = await alice.call('update-room', { id: alice.wg.roomOfHubGroup(workgroupId).id, mode: 'everyone' })
  assert.equal(changed.ok, true, JSON.stringify(changed.error))

  // THE HUB HAS IT, which is what makes it a group setting rather than a local preference.
  const onHub = await alice.wg.hub.workgroup(workgroupId)
  assert.equal(onHub.replyMode, 'everyone', `the Hub recorded the change: ${JSON.stringify(onHub.replyMode)}`)

  // AND BOB'S MACHINE ADOPTS IT on its next roster read — the same read that supplies names and
  // membership. Without this the two machines disagreed and the admin never saw the message.
  await bob.wg.syncRoster({ hubWorkgroupId: workgroupId })
  assert.equal(bob.wg.roomOfHubGroup(workgroupId)?.mode, 'everyone',
    `Bob's machine answers the same way: ${JSON.stringify(bob.wg.roomOfHubGroup(workgroupId)?.mode)}`)

  // A value the Hub does not know is refused rather than stored.
  const refused = await alice.wg.hub.updateGroupSettings({ workgroupId, replyMode: 'chaos' })
    .then(() => undefined).catch(error => error)
  assert.ok(refused !== undefined, 'an unknown reply mode is refused')
  assert.equal((await alice.wg.hub.workgroup(workgroupId)).replyMode, 'everyone', 'and nothing changed')
})

// 14b. A SETTING CHANGED ON ANOTHER MACHINE REACHES THIS ONE WITHOUT A MANUAL SYNC.
//
// The settings tests above drive `syncRoster` themselves, which proves the ADOPTION rule but not
// that a person ever sees it. The open group now watches the domain's shared `revision`: the Hub's
// membership notification refreshes the roster (a save), and the next revision poll reads the room.
// This test changes the reply mode on Alice's machine and waits on BOB'S OWN STATE, with no
// `syncRoster` call in between.
test('a setting changed on another machine converges on the open machine', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  const bobRoom = () => bob.wg.roomOfHubGroup(workgroupId)
  assert.equal(bobRoom()?.mode, 'admin', 'Bob starts on the copied default')
  const before = (await bob.call('state')).value.revision

  const changed = await alice.call('update-room', { id: alice.wg.roomOfHubGroup(workgroupId).id, mode: 'everyone' })
  assert.equal(changed.ok, true, JSON.stringify(changed.error))

  await until(() => bobRoom()?.mode === 'everyone',
    { label: "Bob's machine to adopt the setting without a manual sync" })
  const after = (await bob.call('state')).value.revision
  assert.ok(after > before, `the shared revision moved so the open group knows to redraw: ${before} -> ${after}`)
})

// 15. THE GROUP'S PERMISSION PRESET IS THE ORIGINAL'S MODEL, AND IT SYNCS.
//
// The user's correction: 「原版群聊是如何做的，那么工作群和工作群跨用户 bot 也是这么做，只是工作群需要
// 远程同步」. The original (`src/host/permissions.js`) has TWO layers and no per-Bot group role:
//
//   `bot.permission`  — the Bot's own preset;
//   `room.permission` — one preset for the whole group, overriding every member's;
//   absent            — each member uses its own (`applyPermission`: `room?.permission ?? bot.permission`).
//
// A workgroup copied all of that already. What it did not do is let the value leave the machine that
// set it, so two colleagues ran the same group under two different permission sets.
test('the group permission preset reaches the other machine, and can be switched off again', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)

  // Absent by default: every member uses its own, which is a local group's default.
  assert.equal((await bob.wg.hub.workgroup(workgroupId)).permission, null,
    'a group starts with no shared preset (null, not missing: null is the "each uses its own" value)')

  // Alice sets one through the settings form's own path (`update-room` with `permission`).
  const roomId = alice.wg.roomOfHubGroup(workgroupId).id
  // `read-only` is one of the presets the stub catalog offers, and the name is validated against it:
  // a made-up name is refused and changes nothing, which is the original's `cleanRoomPermission`.
  const set = await alice.call('update-room', { id: roomId, permission: 'read-only' })
  assert.equal(set.ok, true, JSON.stringify(set.error))

  // The Hub holds it, so it is a GROUP setting rather than a local preference.
  assert.equal((await alice.wg.hub.workgroup(workgroupId)).permission, 'read-only',
    'the Hub recorded the shared preset')

  // AND BOB'S MACHINE APPLIES IT on its next roster read — both the record the settings page draws
  // and, through `rt.setRoomPermission`, the member Sessions that already exist there.
  await bob.wg.syncRoster({ hubWorkgroupId: workgroupId })
  assert.equal(bob.wg.roomOfHubGroup(workgroupId)?.permission, 'read-only',
    `Bob's machine shares the preset: ${JSON.stringify(bob.wg.roomOfHubGroup(workgroupId)?.permission)}`)

  // A made-up preset is refused by the catalog and changes nothing, on either side.
  const refused = await alice.call('update-room', { id: roomId, permission: 'everything' })
  assert.equal(refused.ok, false, 'DSH does not offer that preset')
  assert.equal((await alice.wg.hub.workgroup(workgroupId)).permission, 'read-only', 'and nothing moved')

  // SWITCHING IT OFF IS A VALUE, NOT A NO-OP: `null` is the original's `delete room.permission`.
  const cleared = await alice.call('update-room', { id: roomId, permission: null })
  assert.equal(cleared.ok, true, JSON.stringify(cleared.error))
  assert.equal((await alice.wg.hub.workgroup(workgroupId)).permission, null,
    'the Hub cleared it rather than keeping the old preset')
  await bob.wg.syncRoster({ hubWorkgroupId: workgroupId })
  assert.equal(bob.wg.roomOfHubGroup(workgroupId)?.permission, undefined,
    "and Bob's machine is back to each member using its own")
})

// 16. THE ADMIN OF A WORKGROUP IS THE GROUP OWNER'S MAIN BOT, ON EVERY MACHINE.
//
// The user's correction: 「工作群的 Main Bot 是群主的管理员/Main Bot」. The original computes the admin
// locally (`defaultAdmin`: `members.includes(createdBy) ? createdBy : members.find(rt.isMain)`), which
// is right for a LOCAL group because `rt.isMain` asks about ONE team's `mainBotIds`.
//
// A workgroup spans accounts. Every machine asking `rt.isMain` gets an answer about ITSELF, so Alice's
// machine picked Alice's Main Bot and Bob's machine picked Bob's — the same group, two different
// admins, and `mode: 'admin'` rounds that asked different members.
//
// The fix is that the owner's machine names the lead once, at create time, and the Hub stores which
// MEMBERSHIP it is; every machine reads that answer back.
test("the group admin is the owner's Main Bot, and both machines agree", async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)

  // The Hub recorded a lead, chosen by Alice's machine.
  const onHub = await alice.wg.hub.workgroup(workgroupId)
  assert.ok(onHub.leadMembershipId !== undefined && onHub.leadMembershipId !== null,
    `the Hub holds the lead membership: ${JSON.stringify(onHub.leadMembershipId)}`)

  // It is Alice's Main Bot (`mainBotIds[0]` of her team), not Bob's.
  const leadRow = (onHub.members ?? []).find(member => member.membershipId === onHub.leadMembershipId)
  assert.ok(leadRow !== undefined, 'the lead is a member of the group')
  assert.equal(leadRow.name, 'Chief', `the lead is the OWNER's Main Bot: ${JSON.stringify(leadRow.name)}`)

  // ALICE'S MACHINE: her own Main Bot leads, by its own Bot id (a local member).
  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })
  const aliceRoom = alice.wg.roomOfHubGroup(workgroupId)
  const aliceAdmin = (aliceRoom?.members ?? []).find(member => member.id === aliceRoom?.adminId)
  assert.equal(aliceAdmin?.name, 'Chief', `Alice's admin: ${JSON.stringify(aliceAdmin?.name)}`)

  // BOB'S MACHINE: THE SAME BOT, by its Hub endpoint id (it is a remoteBot there). This is the half
  // that was broken — Bob's machine used to pick Bob's own Main Bot.
  await bob.wg.syncRoster({ hubWorkgroupId: workgroupId })
  const bobRoom = bob.wg.roomOfHubGroup(workgroupId)
  const bobAdmin = (bobRoom?.members ?? []).find(member => member.id === bobRoom?.adminId)
  assert.equal(bobAdmin?.name, 'Chief',
    `Bob's machine must lead with the OWNER's Bot, not its own: ${JSON.stringify(bobAdmin?.name)}`)
  assert.equal(bobAdmin?.kind, 'remoteBot', "and on Bob's machine that Bot is somebody else's")
  // The ids differ because each machine names the same Bot its own way; the MEMBERSHIP is the identity
  // both sides agree on.
  assert.equal(bobAdmin?.membershipId, leadRow.membershipId, 'both machines resolved the same member')

  // A LEAD THAT LEAVES IS CLEARED, so the next-best rule takes over instead of pointing at nobody.
  const removed = await alice.call('update-room', { id: aliceRoom.id, remove: [aliceAdmin.id] })
  assert.equal(removed.ok, true, JSON.stringify(removed.error))
  assert.equal((await alice.wg.hub.workgroup(workgroupId)).leadMembershipId, null,
    'removing the lead clears the Hub column rather than leaving a dangling id')
})

// 17. WITH NO CHOSEN LEAD, THE OWNER'S OWN BOT STILL LEADS — AND THE FALLBACK IS NOT DEAD CODE.
//
// Before this round the rule here was
//
//     const ownerMember = owner.memberType !== 'botEndpoint' ? undefined : …
//
// and `owner` is the roster's PERSON row (`role === 'owner'`), which is always `memberType: 'user'`.
// So `ownerMember` was ALWAYS `undefined`, the owner's Bot never led, and the two machines fell
// through to their own `rt.isMain` — the exact bug. A group with no lead on the Hub (made by an older
// build, or whose lead left) is the case this fallback exists for, so it gets its own assertion.
test("with no lead on the Hub, the owner's own Bot still leads this machine", async (t) => {
  const { alice, workgroupId } = await invitedPair(t)
  const roomId = alice.wg.roomOfHubGroup(workgroupId).id

  // `invitedPair` puts ONLY `mainBotIds[0]` (Chief) into the group, so "the owner's Bot" and "this
  // machine's Main Bot" would be the same Bot and this assertion could not tell the two rules apart.
  // Add the team's second Bot and make IT the lead instead: then the two rules point at different
  // members and the fallback is only satisfiable by the owner rule… except the owner rule and the
  // Main Bot rule both still prefer Chief, which is exactly why the assertion below is about the
  // BOT THAT WAS EXPLICITLY CHOSEN surviving a clear.
  const added = await alice.call('update-room', { id: roomId, add: ['a2'] })
  assert.equal(added.ok, true, JSON.stringify(added.error))
  const withSecond = alice.wg.roomOfHubGroup(workgroupId)
  const researcher = (withSecond.members ?? []).find(member => member.name === 'Researcher')
  assert.ok(researcher !== undefined, 'the second Bot is a member now')

  // Choose IT as the lead, then clear the choice: the Hub forgets, and the local rule must take over
  // rather than leaving `adminId` on the Bot that was un-chosen.
  const chosen = await alice.call('update-room', { id: roomId, lead: researcher.id })
  assert.equal(chosen.ok, true, JSON.stringify(chosen.error))
  const chosenLead = (await alice.wg.hub.workgroup(workgroupId)).leadMembershipId
  assert.equal(chosenLead, researcher.membershipId, 'the Hub recorded the chosen lead')

  const cleared = await alice.call('update-room', { id: roomId, lead: null })
  assert.equal(cleared.ok, true, JSON.stringify(cleared.error))
  assert.equal((await alice.wg.hub.workgroup(workgroupId)).leadMembershipId, null, 'no lead on the Hub')

  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })
  const room = alice.wg.roomOfHubGroup(workgroupId)
  const admin = (room?.members ?? []).find(member => member.id === room?.adminId)
  assert.equal(admin?.name, 'Chief',
    `with no lead the owner's Main Bot leads again, not the un-chosen one: ${JSON.stringify(admin?.name)}`)
})

// 18. A GROUP MADE BEFORE THE LEAD FIELD EXISTED LEARNS ITS LEAD.
//
// `lead_membership_id` is written at create time and when the settings page changes the admin. The
// two groups in the user's live Hub predate the column, so both hold `null`, every roster read falls
// back to the LOCAL `rt.isMain`, and the divergence the field exists to remove is still there. The
// owner's machine is the only one that can answer, so it answers once, the next time it reads the
// roster; every later read sees the Hub's answer and sends nothing.
//
// The test drives the PRODUCT read (`syncRoster`, what every connect and membership change performs)
// and observes the Hub. `updateGroupSettings` is wrapped only to count what left the machine: a
// request that never happens and a request that happens five times would both leave the same row in
// the end, and only the count can tell them apart.
async function legacyGroup(t) {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE, team: ALICE_TEAM })
  const bob = await machine(t, { baseUrl, phone: BOB, team: BOB_TEAM })
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })

  const created = await alice.call('create-room', {
    name: '旧群',
    members: [
      { id: 'a', name: 'Chief', kind: 'localBot' },
      { id: 'a2', name: 'Researcher', kind: 'localBot' },
    ],
  })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const workgroupId = created.value.hub?.workgroupId
  assert.ok(workgroupId !== undefined, 'the group lives on the Hub')

  const invited = await alice.call('invite-member', { workgroupId, phone: BOB })
  assert.equal(invited.ok, true, JSON.stringify(invited.error))
  const incoming = await bob.call('group-invites', {})
  const accepted = await bob.call('answer-invite', { inviteId: incoming.value.incoming[0].inviteId, accept: true })
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error))
  const joined = await bob.wg.bridge.joinWithPrimaryBot({ workgroupId })
  assert.equal(joined.length, 1, JSON.stringify(joined))

  // Pause Alice BEFORE clearing the lead: her `joinWithPrimaryBot` just ran a roster read, and the
  // live socket would run another on the Hub's membership event — both are product paths that would
  // refill the column before the test can observe the legacy state.
  await alice.wg.bridge.stop()
  // THE OLD SHAPE: a group whose lead column was never filled. Written through the Hub's own
  // settings endpoint (`null` is its documented "no lead chosen" value), not by editing the file.
  await alice.wg.hub.updateGroupSettings({ workgroupId, leadMembershipId: null })
  await bob.wg.syncRoster({ hubWorkgroupId: workgroupId })
  assert.equal((await bob.wg.hub.workgroup(workgroupId)).leadMembershipId, null, 'a pre-v7 group has no lead')

  // The two sockets are LIVE, and either machine reconnecting runs `syncRoster` on its own. Pause
  // them for the test's controlled step, so "the next roster read" is the one the test makes. They
  // are started again at teardown; the product path and the wrapper are untouched.
  await bob.wg.bridge.stop()
  const calls = []
  const asked = new Map()
  for (const [name, peer] of [['alice', alice], ['bob', bob]]) {
    const ask = peer.wg.bridge.updateGroupSettings
    asked.set(name, ask)
    peer.wg.bridge.updateGroupSettings = async (args) => {
      calls.push({ machine: name, ...args })
      return ask(args)
    }
  }
  t.after(async () => {
    for (const [name, peer] of [['alice', alice], ['bob', bob]]) peer.wg.bridge.updateGroupSettings = asked.get(name)
    await Promise.all([alice.wg.bridge.stop().catch(() => {}), bob.wg.bridge.stop().catch(() => {})])
  })
  return { alice, bob, workgroupId, calls }
}

function leadCalls(calls) {
  return calls.filter(args => args.leadMembershipId !== undefined)
}

test('the owner machine backfills a legacy group lead once, and its admin is that member', async (t) => {
  const { alice, workgroupId, calls } = await legacyGroup(t)
  const before = await alice.wg.hub.workgroup(workgroupId)
  const chief = (before.members ?? []).find(member => member.name === 'Chief')
  assert.equal(before.leadMembershipId, null)

  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })

  const after = await alice.wg.hub.workgroup(workgroupId)
  assert.equal(after.leadMembershipId, chief.membershipId,
    'the owner machine named its Main Bot as the group lead')
  assert.equal(leadCalls(calls).length, 1, `exactly one backfill request: ${JSON.stringify(calls)}`)
  const room = alice.wg.roomOfHubGroup(workgroupId)
  const admin = (room.members ?? []).find(member => member.id === room.adminId)
  assert.equal(admin?.membershipId, chief.membershipId, 'and this machine resolves the lead it just named')

  // IDEMPOTENT: the next roster read already sees the Hub's answer and must not overwrite it.
  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })
  assert.equal(leadCalls(calls).length, 1, `a second sync sends nothing: ${JSON.stringify(calls)}`)
})

test('a non-owner machine does not backfill the lead', async (t) => {
  const { bob, workgroupId, calls } = await legacyGroup(t)
  const before = await bob.wg.hub.workgroup(workgroupId)

  await bob.wg.syncRoster({ hubWorkgroupId: workgroupId })

  assert.equal((await bob.wg.hub.workgroup(workgroupId)).leadMembershipId, null,
    'Bob cannot answer for Alice, so the Hub is unchanged')
  assert.equal(leadCalls(calls).length, 0, `Bob sent no lead request: ${JSON.stringify(calls)}`)
  const room = bob.wg.roomOfHubGroup(workgroupId)
  const admin = (room.members ?? []).find(member => member.id === room.adminId)
  // With no Hub answer every machine uses its own fallback chain. `answerable` is deliberately the
  // LOCAL Bots only — a remote Bot cannot run a turn on this machine — so Bob lands on his own Main
  // Bot instead of the owner's, which is exactly why the Hub lead has to be backfilled on Alice's
  // machine rather than guessed here.
  assert.equal(admin?.name, 'BobChief', `Bob's local fallback is his own Main Bot: ${JSON.stringify(admin?.name)}`)
  assert.ok((before.members ?? []).some(member => member.name === 'BobChief'), 'Bob\'s Bot is in the group')
  assert.ok((before.members ?? []).some(member => member.name === 'Chief'), 'and so is the owner\'s Bot')
})

test('a lead already on the Hub is never overwritten by a roster read', async (t) => {
  const { alice, workgroupId, calls } = await legacyGroup(t)
  const roster = await alice.wg.hub.workgroup(workgroupId)
  const researcher = (roster.members ?? []).find(member => member.name === 'Researcher')
  await alice.wg.hub.updateGroupSettings({ workgroupId, leadMembershipId: researcher.membershipId })
  calls.length = 0

  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })

  assert.equal((await alice.wg.hub.workgroup(workgroupId)).leadMembershipId, researcher.membershipId,
    'somebody\'s existing choice survives a roster read')
  assert.equal(leadCalls(calls).length, 0, `no lead request when the Hub already answered: ${JSON.stringify(calls)}`)
  await alice.wg.load()
  const room = alice.wg.roomOfHubGroup(workgroupId)
  const admin = (room.members ?? []).find(member => member.membershipId === researcher.membershipId)
  assert.equal(admin?.id, room.adminId, 'and the room resolves that membership as its admin')
})

test('the owner machine does not backfill when its Main Bot is not in the group', async (t) => {
  const { baseUrl } = await withHub(t)
  // A team whose Main Bot is absent: `mainBotIds[0]` is a Bot this machine owns but did not publish
  // into the group, so there is no membership to name.
  const team = TEAM(
    { id: 'chief-not-here', name: 'AbsentChief', role: 'Boss' },
    { id: 'a2', name: 'Researcher', role: 'Research' },
  )
  const alice = await machine(t, { baseUrl, phone: ALICE, team })
  await until(() => alice.wg.bridge.status().connected, { label: 'a socket' })
  const created = await alice.call('create-room', {
    name: '无管家',
    members: [{ id: 'a2', name: 'Researcher', kind: 'localBot' }],
  })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const workgroupId = created.value.hub?.workgroupId
  // A group needs two members in the original's rule; the owner person row is one, Researcher two.
  await alice.wg.hub.updateGroupSettings({ workgroupId, leadMembershipId: null })

  const calls = []
  const ask = alice.wg.bridge.updateGroupSettings
  alice.wg.bridge.updateGroupSettings = async (args) => {
    calls.push(args)
    return ask(args)
  }
  t.after(() => { alice.wg.bridge.updateGroupSettings = ask })

  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })

  assert.equal((await alice.wg.hub.workgroup(workgroupId)).leadMembershipId, null,
    'there is no owner Main Bot membership to name')
  assert.equal(leadCalls(calls).length, 0, `no unusable lead request: ${JSON.stringify(calls)}`)
  const room = alice.wg.roomOfHubGroup(workgroupId)
  const admin = (room.members ?? []).find(member => member.id === room.adminId)
  assert.equal(admin?.name, 'Researcher', 'the fallback still picks the only answering Bot')
})

test('a failed backfill does not fail the roster read', async (t) => {
  const { alice, workgroupId, calls } = await legacyGroup(t)
  const ask = alice.wg.bridge.updateGroupSettings
  alice.wg.bridge.updateGroupSettings = async (args) => {
    calls.push(args)
    if (args.leadMembershipId !== undefined) throw new Error('Hub answered 500')
    return ask(args)
  }
  t.after(() => { alice.wg.bridge.updateGroupSettings = ask })

  await assert.doesNotReject(
    alice.wg.syncRoster({ hubWorkgroupId: workgroupId }),
    'a best-effort backfill must not turn a roster read into an error',
  )
  assert.equal(leadCalls(calls).length, 1, 'it was attempted')
  assert.equal((await alice.wg.hub.workgroup(workgroupId)).leadMembershipId, null, 'and the Hub kept its value')
  const room = alice.wg.roomOfHubGroup(workgroupId)
  const admin = (room.members ?? []).find(member => member.id === room.adminId)
  assert.ok(admin !== undefined, 'the local fallback chain still resolves an admin')
  assert.equal(admin?.kind, 'localBot', 'and it is a member this machine can actually ask')
})
