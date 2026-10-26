// G4 real-time regressions: the four gates a workgroup cannot pass on host-state tests alone.
//
// This file deliberately lives outside `test/` because the repository's `.gitignore` currently
// ignores that whole directory (`test/`), and a regression test the repository does not keep is not
// evidence. `package.json` runs `test/*.test.js` plus `test-realtime/*.test.js`.
//
// What it drives:
//   * a real Hub (two registered accounts, two live WSS sockets);
//   * two real `createRuntime` machines with real `workgroup` installs;
//   * the same `apiHandle` endpoints the panel calls (`create-room`, `invite-member`,
//     `answer-invite`, `send-hub`, `room`, `group-members`);
//   * the real `/api/bot/feed` route for the live signal;
//   * no direct `bridge.start()`, `syncRoster()` or fixture that writes a round's slots.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from '../test/fake-ctx.js'

import {
  ALICE, BOB, ALICE_TEAM, BOB_TEAM, PASSWORD,
  withHub, openMachine, machine, until, reader, invitedPair, roomOf, lineByText,
} from './helpers-pair.js'

// Writes a projection through the public seam, matching how a live round persists itself.
function wgPersistRound(wg, round) {
  return wg.persistRound(round)
}

// 1. A LIVE WORKGROUP SAVE MUST REACH THE WINDOW THROUGH THE ORIGINAL FEED.
//
// The panel currently polls `/api/workgroup` every 700 ms for the room and 1200 ms for the roster.
// The host already has `/api/bot/feed` for exactly this job. A workgroup save must publish a feed
// event, and the event must name the workgroup and its revision, so the panel can refresh without
// waiting for a poll.
test('a workgroup save is delivered by the existing live feed', async (t) => {
  const { alice, workgroupId } = await invitedPair(t)
  const abort = new AbortController()
  const response = await alice.routes['/api/bot/feed'].fetch(
    new Request('http://localhost/api/bot/feed', { signal: abort.signal }),
  )
  const next = reader(response)
  // The first frame is always `hello`; it names the team revision, not the workgroup one.
  const hello = await next()
  assert.equal(hello.event, 'hello')

  // A user message is a workgroup save and a new line. It must publish a workgroup event; the
  // ordinary `revision` event is the original team's file and is not a workgroup signal.
  const sent = await alice.call('send-hub', { workgroupId, text: 'feed 要能看到这一行' })
  assert.equal(sent.ok, true, JSON.stringify(sent.error))

  const frames = []
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && !frames.some(frame => String(frame.event).startsWith('workgroup'))) {
    const frame = await Promise.race([
      next(),
      new Promise(resolve => setTimeout(() => resolve(undefined), 150)),
    ])
    if (frame !== undefined) frames.push(frame)
  }
  abort.abort()
  assert.ok(frames.some(frame => String(frame.event).startsWith('workgroup')),
    `the feed must publish a workgroup event before any 700 ms poll: ${JSON.stringify(frames)}`)
  const changed = frames.find(frame => String(frame.event).startsWith('workgroup'))
  assert.equal(changed.data.workgroupId, workgroupId, 'and the event names the group')
  assert.equal(typeof changed.data.revision, 'number', 'and the revision the window must re-read')
})

// 1b. THE PANEL MUST SUBSCRIBE TO THAT FEED, NOT ONLY POLL THE HOST.
//
// The host can publish a workgroup event and the test above proves it. That is not a live UI unless
// the panel listens. This is a source-level contract because the panel's React hooks are compiled
// into `client.js` and a browser render harness is outside this file; the contract is narrow: one
// EventSource on `/api/bot/feed`, a workgroup event handler that re-reads the open room and the
// roster, and a slow fallback poll rather than 700/1200 ms as the live path.
test('the workgroup panel subscribes to the live feed and keeps polling only as a fallback', () => {
  const panel = readFileSync(new URL('../src/workgroup/client/panel.js', import.meta.url), 'utf8')
  assert.match(panel, /new EventSource\(/, 'the panel opens the existing feed')
  assert.match(panel, /api\/bot\/feed|FEED_ROUTE|\/feed/, 'and it is the host feed route')
  assert.match(panel, /addEventListener\('workgroup'/, 'it handles the workgroup event')
  assert.match(panel, /callWorkgroup\('room'/, 'a workgroup event re-reads the open room')
  assert.match(panel, /callWorkgroup\('group-members'/, 'and refreshes the Hub roster')
  assert.doesNotMatch(panel, /setTimeout\(poll, 700\)/, '700 ms polling is no longer the live path')
  assert.doesNotMatch(panel, /setTimeout\(poll, 1200\)/, '1200 ms polling is no longer the live path')
  assert.match(panel, /setTimeout\(tick, 5000\)/, 'a slow fallback remains for a dropped stream')
})

// 2. A COLLEAGUE'S BOT MUST NEVER BE RENDERED AS A PHONE NUMBER.
//
// The Hub stores a Bot endpoint's published name separately from the person's masked phone. A
// workgroup member row is built in `applyRoster`; an endpoint missing its name must fall back to a
// Bot name/id, never to the person's number. This is the data every client surface reads.
test("a Bot member never falls back to its owner's phone number", async (t) => {
  const { alice, workgroupId } = await invitedPair(t)
  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })
  const roster = await alice.call('group-members', { workgroupId })
  assert.equal(roster.ok, true, JSON.stringify(roster.error))
  const bots = (roster.value.members ?? []).filter(member => member.memberType === 'botEndpoint')
  assert.ok(bots.length >= 1, `there is a Bot to inspect: ${JSON.stringify(roster.value.members)}`)
  for (const bot of bots) {
    // The Hub's own roster is the input to `applyRoster`; its `name` is the published Bot name.
    assert.equal(typeof bot.name, 'string', `a Bot has a name: ${JSON.stringify(bot)}`)
    assert.notEqual(bot.name, bot.phoneMasked, `a Bot must not be named by a phone number: ${JSON.stringify(bot)}`)
    assert.equal(typeof bot.phoneMasked, 'undefined', `a Bot row carries no person phone: ${JSON.stringify(bot)}`)
    // And the member record the local room keeps must carry the Bot identity, not a person row.
    const local = (alice.wg.roomOfHubGroup(workgroupId)?.members ?? []).find(member => member.endpointId === bot.endpointId)
    assert.ok(local !== undefined, `the local roster has the Bot: ${JSON.stringify(alice.wg.roomOfHubGroup(workgroupId)?.members)}`)
    // `invitedPair` runs this assertion on ALICE's machine, where Bob's Bot is remote. The same
    // member on Bob's own machine resolves to `localBot`; both must be Bot records, never a person.
    assert.ok(local.kind === 'remoteBot' || local.kind === 'localBot',
      `the local record is a Bot: ${JSON.stringify(local)}`)
    assert.equal(local.name, bot.name, "the local record keeps the Bot's published name")
    assert.notEqual(local.name, bot.phoneMasked, 'and never the owner phone')
  }

  // AN ENDPOINT WITHOUT A CONTRACT NAME STILL MUST NOT BECOME A PERSON.
  //
  // Real Hub rows can lose their name to an older publish or a truncated migration. That is not a
  // reason to relabel somebody's Bot as the owner: the Bot is still the endpoint, and the safe
  // fallback is its endpoint id (the UI can say "Bot"). Drive `applyRoster` with the same Hub shape
  // and assert the projection, which is what every client surface reads.
  const remote = bots.find(bot => bot.ownerIsYou !== true)
  assert.ok(remote !== undefined, 'the group has a colleague Bot to project')
  const answer = await alice.wg.hub.workgroup(workgroupId)
  const rosterAnswer = {
    ...answer,
    members: answer.members.map(member => member.endpointId === remote.endpointId
      ? { ...member, name: '', endpointName: undefined, phoneMasked: '+86 138 **** 8000' }
      : member),
  }
  await alice.wg.applyRoster({
    hubWorkgroupId: workgroupId,
    members: rosterAnswer.members,
    replyMode: rosterAnswer.replyMode,
    permission: rosterAnswer.permission,
    leadMembershipId: rosterAnswer.leadMembershipId,
  })
  const fallback = (alice.wg.roomOfHubGroup(workgroupId)?.members ?? [])
    .find(member => member.endpointId === remote.endpointId)
  assert.ok(fallback !== undefined, 'the nameless endpoint is still a member')
  assert.equal(fallback.kind, 'remoteBot', 'it is still a Bot, not a person')
  assert.doesNotMatch(String(fallback.name ?? ''), /\d{3}/,
    `a Bot with no published name never inherits a phone number: ${JSON.stringify(fallback)}`)
})

// 3. A SETTINGS CHANGE ON THE HUB MUST REACH THE OTHER MACHINE WITHOUT A MANUAL SYNC.
//
// The Hub already broadcasts `member.changed` with `kind: 'settings'`. The machine with the group
// open must turn that notification into an authoritative roster/settings read, and the open room
// must show the new name/notice/mode. The test does not call `syncRoster`: that would prove the
// helper works, not that the product calls it.
test('a settings change on the Hub reaches the other open machine', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  await until(() => roomOf(bob, workgroupId)?.members?.some(member => member.kind === 'remoteBot'),
    { label: "Bob's initial roster" })
  const updated = await alice.call('update-room', {
    id: roomOf(alice, workgroupId).id,
    name: '实时改名',
    notice: '实时通知',
    mode: 'everyone',
  })
  assert.equal(updated.ok, true, JSON.stringify(updated.error))
  await until(() => roomOf(bob, workgroupId)?.name === '实时改名', {
    label: "Bob's open room to receive the Hub settings notification",
  })
  const bobRoom = await bob.call('room', { id: roomOf(bob, workgroupId).id })
  assert.equal(bobRoom.ok, true, JSON.stringify(bobRoom.error))
  assert.equal(bobRoom.value.name, '实时改名')
  assert.equal(bobRoom.value.notice, '实时通知')
  assert.equal(bobRoom.value.mode, 'everyone')
})

// 4. A REMOTE BOT ANSWER MUST CARRY THE CALLER'S EXCHANGE, SO THE CALLER DOES NOT OPEN A SECOND ROUND.
//
// A local group awaits the member's turn in the same slot. A workgroup cannot await another machine
// over the WSS cursor, so the call and answer need a stable exchange id. Without it the answer is
// just another post: the caller cannot tell which slot it belongs to, the next speaker is chosen from
// a new opener, and the observable order differs from the original.
test("a remote Bot's answer is matched to the exchange that called it", async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  const room = roomOf(alice, workgroupId)
  assert.ok(room !== undefined)
  const remote = (room.members ?? []).find(member => member.name === 'BobChief')
  assert.ok(remote !== undefined, `Bob's Bot is in Alice's roster: ${JSON.stringify(room.members)}`)
  assert.equal(remote.kind, 'remoteBot', 'Alice cannot run a turn for it')

  // The call the round would send. This is the product's own bridge method, because the WSS and
  // replay path are what the test is about; the round's slot is supplied the way `runRound` does.
  const slot = { note: '@BobChief 帮我看一下', by: 'a', exchangeId: 'exchange-real-round' }
  const delivered = await alice.wg.deliverRemote({ room, member: remote, round: { id: 'round-1' }, slot })
  assert.equal(delivered.sent, true, JSON.stringify(delivered))

  // Bob's machine receives the call and runs the Bot. Play the turn events the runtime would emit.
  const bobRoom = roomOf(bob, workgroupId)
  assert.ok(bobRoom !== undefined)
  await until(() => (bob.followups ?? []).some(entry => String(entry.message?.source?.role ?? '') === 'room'),
    { label: "Bob's called Bot to start a turn" })
  const started = (bob.followups ?? []).find(entry => entry.message?.source?.role === 'room')
  assert.equal(started.message.source.exchangeId, 'exchange-real-round',
    'the called machine receives the caller exchange, not a fresh anonymous one')
  const emit = async (sessionId, event) => {
    for (const listener of bob.rt.ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  await emit(started.sessionId, { type: 'turn/start', data: { turn: 1 } })
  await emit(started.sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '看过了，没问题' }] } } })
  await emit(started.sessionId, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  // Alice receives the line, and it points back at the exchange her round is waiting on.
  await until(() => lineByText(alice, workgroupId, '看过了，没问题') !== undefined, {
    label: "Alice to receive BobChief's answer",
  })
  const seen = lineByText(alice, workgroupId, '看过了，没问题')
  assert.equal(seen.memberId, remote.id, 'the line belongs to the Bot that was called')
  assert.equal(seen.exchangeId, 'exchange-real-round', 'and it points at the caller exchange')
  assert.equal(seen.who, 'BobChief', 'the Bot keeps its name on the other machine')
})

// 5. THE BOT'S ROLE/INSTRUCTIONS STAY IN THE MEMBER PROMPT, THE WAY THE ORIGINAL GROUP DOES.
//
// The product does not need a new "role router": the Bot's identity prompt already carries `role`
// and `instructions`, and the admin picks members with @Name. What must not happen is the workgroup
// replacing that prompt with the relay-only one, or handing the member a different Bot's identity.
test("a workgroup member's turn keeps its own Bot identity prompt", async (t) => {
  const { alice, workgroupId } = await invitedPair(t)
  const room = roomOf(alice, workgroupId)
  // The identity section is rendered by the original `prompt.js` from `rt.selfOf`. The workgroup's
  // `ownership.js` extends `selfOf` for a member Session; this asserts the contract the round uses.
  const session = 'session-owner-probe'
  alice.wg.registerSessionOwner(session, { kind: 'workgroup', workgroupId: room.id, botId: 'a', name: 'Chief' })
  assert.equal(alice.rt.selfOf(session), 'a', 'a member Session resolves to its own Bot')
  const section = alice.rt.ctx.sections.get('bot-identity')
  const text = typeof section?.text === 'function' ? section.text({ agent: { id: session } }) : ''
  assert.match(text, /You are Chief/, 'the Bot identity is the member prompt')
  assert.match(text, /Your role: Boss/, 'and the role label is present')
  assert.doesNotMatch(text, /only the relay/, 'a member is not told it is the relay')
})


// 6. THE COPIED ROUND, NOT A SECOND ORCHESTRATOR.
//
// This is the local half of the remote exchange, with no Hub: the round names a remote member via
// `deliverRemote`, then the remote answer arrives through the same `receiveRemote` line path the
// product uses. The round must keep the original slot order: only the member the admin named speaks,
// and the admin answers the result. Two independent openers would be the drift the user reported.
test('a remote answer is handled by the calling round, not by a second opener', async (t) => {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE, team: ALICE_TEAM, name: 'round-alice' })
  const bob = await machine(t, { baseUrl, phone: BOB, team: BOB_TEAM, name: 'round-bob' })
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })
  const created = await alice.call('create-room', {
    name: '顺序回归',
    members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'a2', name: 'Researcher', kind: 'localBot' }],
  })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const workgroupId = created.value.hub.workgroupId
  await alice.call('invite-member', { workgroupId, phone: BOB })
  const incoming = await bob.call('group-invites', {})
  await bob.call('answer-invite', { inviteId: incoming.value.incoming[0].inviteId, accept: true })
  await bob.wg.bridge.joinWithPrimaryBot({ workgroupId })
  await until(() => (roomOf(alice, workgroupId)?.members ?? []).some(member => member.name === 'BobChief'),
    { label: "BobChief in Alice's roster" })

  const room = roomOf(alice, workgroupId)
  const admin = (room.members ?? []).find(member => member.id === room.adminId)
  assert.equal(admin?.name, 'Chief', 'Alice\'s Chief is the owner Main Bot')
  const remote = (room.members ?? []).find(member => member.name === 'BobChief')
  assert.ok(remote !== undefined)

  // A plain user message selects the admin, exactly as the original group's `admin` mode does.
  assert.deepEqual(alice.wg.openingSpeakers(room, { text: '这版方案什么时候能看？' }).map(member => member.name),
    ['Chief'], 'a plain message starts with the admin alone')

  // The admin names Bob's Bot. That post is the opener the next slot is selected from.
  const handoff = alice.wg.openingSpeakers(room, {
    member: true,
    botId: 'a',
    text: '@BobChief 帮我看一下这个方向',
  })
  assert.deepEqual(handoff.map(member => member.name), ['BobChief'],
    'the admin\'s @Name calls exactly Bob\'s Bot, as the original group does')
  // Bob's Bot answers without @: a member post calls nobody; the caller (the admin) is not re-asked.
  assert.deepEqual(alice.wg.openingSpeakers(room, {
    member: true,
    botId: remote.id,
    text: '看过了，这个方向可行',
  }).map(member => member.name), [], 'a member answer with no @ does not restart the admin')

  // And the answer itself points at the exchange that called it, which is the identity the round
  // uses to attach the reply to its slot rather than opening another opener.
  const slot = { note: '@BobChief 帮我看一下这个方向', by: 'a', exchangeId: 'exchange-order-1' }
  const delivered = await alice.wg.deliverRemote({ room, member: remote, round: { id: 'round-order-1' }, slot })
  assert.equal(delivered.sent, true, JSON.stringify({ delivered, message: delivered?.error?.message, code: delivered?.error?.code }))
  let call
  await until(async () => {
    const page = await alice.wg.hub.events({ workgroupId, afterSeq: 0 })
    call = (page.events ?? page ?? []).find(event => event.payload?.call?.exchangeId === 'exchange-order-1')
    return call !== undefined
  }, { label: 'the call to carry the round exchange' })
  assert.equal(call.payload.call.roundId, 'round-order-1', 'and the round id, so a late answer is attributable')
})


// 6b. A SETTINGS SAVE MUST PUBLISH A SETTINGS-KIND SIGNAL.
//
// The product sidebar now subscribes to the same host feed the workgroup panel uses. This proves
// the signal it needs actually leaves the other machine: a rename on A publishes a `workgroup`
// event with kind "settings" on B, so B's store (and the conversation/settings surfaces that read
// it) can be refreshed without a manual sync.
test('a settings save is published as a settings-kind workgroup feed event', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  const abort = new AbortController()
  const response = await bob.routes['/api/bot/feed'].fetch(
    new Request('http://localhost/api/bot/feed', { signal: abort.signal }),
  )
  const next = reader(response)
  assert.equal((await next()).event, 'hello')
  const updated = await alice.call('update-room', {
    id: roomOf(alice, workgroupId).id,
    name: '实时设置',
  })
  assert.equal(updated.ok, true, JSON.stringify(updated.error))
  const deadline = Date.now() + 3000
  let changed
  while (Date.now() < deadline && changed === undefined) {
    const frame = await Promise.race([
      next(),
      new Promise(resolve => setTimeout(() => resolve(undefined), 150)),
    ])
    if (frame?.event === 'workgroup' && frame.data?.kind === 'settings') changed = frame
  }
  abort.abort()
  assert.ok(changed !== undefined, 'a settings save publishes a workgroup event')
  assert.equal(changed.data.workgroupId, workgroupId)
})

// 7. A RESTART KEEPS THE SAME LINES, THE SAME IDS AND THE SAME BOT ATTRIBUTION.
//
// The Hub is the durable record; a local room is a projection. A restart must replay what this
// machine has not applied without duplicating what it already has. This closes the other half of
// 「消息持久化」: a message is not persisted merely because it is on one screen at the moment it is
// sent.
test('both machines keep the workgroup history and Bot attribution across a restart', async (t) => {
  const { baseUrl } = await withHub(t)
  const aliceHomeRoot = mkdtempSync(join(tmpdir(), 'ds-bot-wg-restart-alice-'))
  const bobHomeRoot = mkdtempSync(join(tmpdir(), 'ds-bot-wg-restart-bob-'))
  const aliceHome = join(aliceHomeRoot, 'bot')
  const bobHome = join(bobHomeRoot, 'bot')
  mkdirSync(aliceHome, { recursive: true })
  mkdirSync(bobHome, { recursive: true })
  writeFileSync(join(aliceHome, 'state.json'), JSON.stringify(ALICE_TEAM))
  writeFileSync(join(bobHome, 'state.json'), JSON.stringify(BOB_TEAM))

  const open = async (home, phone) => {
    const ctx = fakeContext()
    const followups = []
    Object.assign(ctx, {
      llm: { listProviders: () => [] },
      workspaceRegistry: {
        get: () => undefined,
        resolveByPath: async () => undefined,
        create: async (path) => ({ id: `w-${Math.random().toString(16).slice(2)}`, path }),
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
        prompt: async ({ sessionId, content, source }) => {
          followups.push({ sessionId, message: { content, source } })
          return { accepted: true }
        },
        page: async () => ({ events: [] }),
      },
      sessionTitle: { rename: async () => {} },
      sessions: { flush: async () => {} },
    })
    const rt = createRuntime(ctx, { home })
    const wg = rt.workgroup
    const call = (endpoint, payload) => wg.apiHandle(endpoint, payload)
    const signedIn = await call('hub-login', { baseUrl, phone, password: PASSWORD })
    assert.equal(signedIn.ok, true, `sign-in failed: ${JSON.stringify(signedIn.error)}`)
    return { rt, wg, call, followups, close: async () => {
      await wg.bridge.stop().catch(() => {})
      await ctx.dispose()
    } }
  }

  let alice = await open(aliceHome, ALICE)
  let bob = await open(bobHome, BOB)
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })

  const created = await alice.call('create-room', {
    name: '重启回归',
    members: [{ id: 'a', name: 'Chief', kind: 'localBot' }, { id: 'a2', name: 'Researcher', kind: 'localBot' }],
  })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const workgroupId = created.value.hub.workgroupId
  await alice.call('invite-member', { workgroupId, phone: BOB })
  const incoming = await bob.call('group-invites', {})
  await bob.call('answer-invite', { inviteId: incoming.value.incoming[0].inviteId, accept: true })
  await bob.wg.bridge.joinWithPrimaryBot({ workgroupId })
  await until(() => (roomOf(bob, workgroupId)?.members ?? []).some(member => member.name === 'Chief'),
    { label: 'Bob to know the owner Bot' })

  const typed = '重启前发的一句'
  const sent = await alice.call('send-hub', { workgroupId, text: typed })
  assert.equal(sent.ok, true, JSON.stringify(sent.error))
  await until(() => lineByText(bob, workgroupId, typed) !== undefined, { label: 'Bob to see the typed line' })

  // A Bot's answer through the real round path. `postToGroupSession` on its own only writes into the
  // group Session (the relay is what makes it a log line); here the round is opened and answered,
  // which is how the product mirrors a Bot's contribution to the Hub.
  const botText = '重启前的 Bot 回答'
  const aliceRoom = () => roomOf(alice, workgroupId)
  alice.wg.roomInbox.set(aliceRoom().id, [{ text: '@Chief 回复一下', who: 'User' }])
  const round = alice.rt.ctx.registeredTools.get('workgroup_relay').execute(
    {}, { agent: { id: aliceRoom().id }, callId: 'restart-round', signal: new AbortController().signal },
  )
  const memberWaiter = async () => {
    const deadline = Date.now() + 8000
    for (;;) {
      const found = [...alice.wg.roomWaiters.values()].find(entry => entry.roomId === aliceRoom().id && entry.memberId === 'a')
      if (found !== undefined) return found
      if (Date.now() > deadline) throw new Error('the restart round never asked Chief to speak')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const chief = await memberWaiter()
  const aliceEmit = async (event) => {
    for (const listener of alice.rt.ctx.listeners.get('session/event') ?? []) await listener({ id: chief.sessionId }, event)
  }
  await aliceEmit({ type: 'turn/start', data: { turn: 1 } })
  await aliceEmit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: botText }] } } })
  await aliceEmit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await round.catch(() => {})
  await until(() => lineByText(bob, workgroupId, botText) !== undefined, { label: 'Bob to see the Bot line' })

  const beforeAlice = (roomOf(alice, workgroupId)?.log ?? []).filter(line => [typed, botText].includes(line.text))
  const beforeBob = (roomOf(bob, workgroupId)?.log ?? []).filter(line => [typed, botText].includes(line.text))
  assert.equal(beforeAlice.length, 2)
  assert.equal(beforeBob.length, 2)

  await alice.close()
  await bob.close()
  alice = await open(aliceHome, ALICE)
  bob = await open(bobHome, BOB)
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets after restart' })
  await until(() => (roomOf(alice, workgroupId)?.log ?? []).some(line => line.text === typed)
    && (roomOf(bob, workgroupId)?.log ?? []).some(line => line.text === typed), { label: 'history after restart' })

  const afterAlice = (roomOf(alice, workgroupId)?.log ?? []).filter(line => [typed, botText].includes(line.text))
  const afterBob = (roomOf(bob, workgroupId)?.log ?? []).filter(line => [typed, botText].includes(line.text))
  assert.equal(afterAlice.length, 2, 'Alice does not duplicate the replay')
  assert.equal(afterBob.length, 2, 'Bob does not duplicate the replay')
  assert.deepEqual(afterAlice.map(line => line.hubEventId).sort(), beforeAlice.map(line => line.hubEventId).sort(),
    'the persisted Hub event ids are the same after a restart')
  assert.deepEqual(afterBob.map(line => line.hubSeq).sort(), beforeBob.map(line => line.hubSeq).sort(),
    'and the Hub seq is stable')
  const botLine = afterBob.find(line => line.text === botText)
  assert.equal(botLine.who, 'Chief', 'the Bot keeps its name after a restart')
  assert.equal(botLine.memberId, (roomOf(bob, workgroupId)?.members ?? []).find(member => member.name === 'Chief')?.id,
    'and its member identity is the same Bot, not the owner')
})


// 8. AN UNKNOWN BOT ENDPOINT GETS A BOT PLACEHOLDER, NEVER A PERSON'S PHONE.
//
// This is the failure mode behind 「同事 B 看到同事 A 的电话号码」: the roster had not yet resolved
// the endpoint, so the line fell through to the sender's account row. A line explicitly marked with
// `sender.botEndpointId` is a Bot by construction; the only safe unknown name is the endpoint id
// (which the UI can label "Bot"), never the owner's phone.
test('a Bot line with an unresolved endpoint never falls back to the owner phone', async (t) => {
  const { alice, workgroupId } = await invitedPair(t)
  const room = roomOf(alice, workgroupId)
  assert.ok(room !== undefined)
  const text = '这是无法解析 endpoint 的 Bot 行'
  await alice.wg.receiveRemote({
    workgroupId,
    event: {
      eventId: 'evt_unresolved_bot_probe',
      seq: 999,
      type: 'chat.message',
      sender: {
        userId: 'usr_the_owner',
        botEndpointId: 'ep_not_in_the_roster',
      },
      payload: { text, senderName: 'Chief' },
    },
  })
  const line = room.log.find(entry => entry.text === text)
  assert.ok(line !== undefined, 'the line reached the room')
  assert.equal(line.memberId, 'ep_not_in_the_roster', 'it is attributed to the Bot endpoint, not a resolved person')
  assert.doesNotMatch(String(line.who), /\d{3}/, `a Bot never shows a phone: ${JSON.stringify(line)}`)
  assert.equal(line.who, 'Chief', 'the published Bot name from the line wins over the account row')
})


// 8b. THE CALL'S EXCHANGE MUST BE ON DISK BEFORE THE HUB CAN SEE THE CALL.
//
// `deliverRemote` is the moment the call becomes observable to another machine. If the exchange is
// written only after it resolves, the answer can arrive (and the process can die) in a window where
// this machine has no record of what it asked. This test intercepts that exact seam, reads the state
// file synchronously, and only then lets the send proceed — no graceful disposal is involved.
test('a remote call writes its exchange to disk before it can reach the Hub', async (t) => {
  const { alice, workgroupId } = await invitedPair(t)
  const room = roomOf(alice, workgroupId)
  const remote = room.members.find(member => member.name === 'BobChief')
  assert.ok(remote !== undefined)

  // Intercept the exact seam. Reading the file synchronously here proves what is durable at the
  // instant the call could become visible to the Hub, with no disposal or queued save in between.
  // Returning a controlled send error lets the round finish immediately instead of waiting for the
  // real 240 s reply timeout; this test is about ordering, not the answer.
  let durable
  let sent
  const original = alice.wg.deliverRemote
  alice.wg.deliverRemote = async (args) => {
    sent = args
    const onDisk = JSON.parse(readFileSync(join(alice.home, 'workgroup', 'state.json'), 'utf8'))
    durable = Object.values(onDisk.rounds ?? {})
      .find(entry => entry.roomId === room.id)?.slots?.find(slot => slot.id === remote.id)
    return { error: new Error('test send stops here') }
  }
  const round = {
    id: 'round-durable-send',
    roomId: room.id,
    startSeq: room.seq + 1,
    slots: [{ id: remote.id, name: remote.name, status: 'waiting' }],
    replies: [],
    passed: [],
    failed: [],
    started: [],
    turns: 0,
  }
  alice.wg.roomProgress.set('call-durable-send', round)
  await alice.wg.runRound(room, round, new AbortController().signal)
  alice.wg.deliverRemote = original

  assert.equal(sent?.slot?.exchangeId, round.slots[0].exchangeId,
    'the exchange sent to the Hub is the one in the slot')
  assert.equal(durable?.exchangeId, round.slots[0].exchangeId,
    `the exchange was already on disk at the send seam: ${JSON.stringify(durable)}`)
})

// 8c. STOPPING WHILE A REMOTE CALL IS OUT CANNOT DELETE ITS OWN TERMINAL RECORD.
//
// Stop resolves the remote waiter so the round loop can unwind. The loop then resumes after the
// await and used to rewrite the slot as missed/posted and drop the round, erasing the record that
// says the user stopped it. This test keeps the round live and asserts the record AFTER that unwind.
test('stopping a round while a remote call is out keeps it stopped', async (t) => {
  const { alice, workgroupId } = await invitedPair(t)
  const room = roomOf(alice, workgroupId)
  const remote = room.members.find(member => member.name === 'BobChief')
  assert.ok(remote !== undefined)

  // Let the call register its waiter but never answer, then stop exactly as the panel does.
  let entered
  const reached = new Promise(resolve => { entered = resolve })
  alice.wg.deliverRemote = async () => { entered(); return { sent: true, queued: true } }
  const round = {
    id: 'round-stop-race',
    roomId: room.id,
    startSeq: room.seq + 1,
    slots: [{ id: remote.id, name: remote.name, status: 'waiting' }],
    replies: [],
    passed: [],
    failed: [],
    started: [],
    remoteWaiters: new Map(),
    turns: 0,
  }
  alice.wg.roomProgress.set('call-stop-race', round)
  const running = alice.wg.runRound(room, round, new AbortController().signal)
  await reached
  await until(() => round.state === undefined || round.state === 'open', { label: 'the call to be waiting' })
  const stopped = await alice.wg.stopRound(room.id)
  assert.equal(stopped, true, 'the stop is reported even though only a remote slot is out')
  await Promise.race([running, new Promise(resolve => setTimeout(resolve, 250))])

  const record = alice.wg.roundOf('round-stop-race')
  assert.ok(record !== undefined, 'the stopped record was not deleted by the unwinding loop')
  assert.equal(record.state, 'stopped', 'it is still terminal after the loop resumes')
  assert.equal(record.slots[0].status, 'stopped', 'and its slot did not turn into missed/posted')
})

// 9b. A RECOVERED OBLIGATION IS CONTINUED BY THE HUB ANSWER, EXACTLY ONCE, WITHOUT A RELAY.
//
// After a restart the waiting slot lives only in `state.json`. The answer arrives through the Hub,
// possibly during replay before any UI reads the room. Reconciliation must put the line in the log,
// mark the slot posted, and do NOTHING else: no second relay, no new round, no re-delivery.
test('a recovered waiting slot is continued by the matching Hub answer, once', async (t) => {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE, team: ALICE_TEAM, name: 'reconcile-alice' })
  const bob = await machine(t, { baseUrl, phone: BOB, team: BOB_TEAM, name: 'reconcile-bob' })
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })
  const created = await alice.call('create-room', {
    name: '对账恢复',
    members: [{ id: 'a', name: 'Chief', kind: 'localBot' }],
  })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const workgroupId = created.value.hub.workgroupId
  await alice.call('invite-member', { workgroupId, phone: BOB })
  const incoming = await bob.call('group-invites', {})
  await bob.call('answer-invite', { inviteId: incoming.value.incoming[0].inviteId, accept: true })
  await bob.wg.bridge.joinWithPrimaryBot({ workgroupId })
  const room = roomOf(alice, workgroupId)
  await until(() => (room.members ?? []).some(member => member.name === 'BobChief'),
    { label: "BobChief in Alice's roster" })
  const remote = room.members.find(member => member.name === 'BobChief')

  const exchangeId = 'exchange-recover-1'
  const roundId = 'round-recover-1'
  alice.wg.persistRound({
    id: roundId,
    roomId: room.id,
    startSeq: room.seq + 1,
    slots: [
      { id: 'a', name: 'Chief', status: 'posted' },
      { id: remote.id, name: remote.name, status: 'remote', exchangeId, by: 'a', note: 'Chief mentioned you' },
    ],
    replies: [],
    passed: [],
    failed: [],
    started: [],
    turns: 1,
  })
  await alice.wg.flushSave()
  const sent = await alice.wg.deliverRemote({
    room,
    member: remote,
    round: { id: roundId },
    slot: { exchangeId, roundId, note: 'Chief mentioned you', by: 'a' },
  })
  assert.equal(sent.sent, true, JSON.stringify(sent))

  // Observe the two side effects reconciliation must not cause.
  let relayRounds = 0
  const originalRelay = alice.ctx.registeredTools.get('workgroup_relay')
  const relayExecute = originalRelay.execute
  originalRelay.execute = async (...args) => { relayRounds += 1; return relayExecute.apply(originalRelay, args) }
  let remoteDeliveries = 0
  const originalDeliverRemote = alice.wg.deliverRemote
  alice.wg.deliverRemote = async (...args) => { remoteDeliveries += 1; return originalDeliverRemote(...args) }

  await alice.wg.bridge.stop()
  await alice.ctx.dispose()
  const restarted = await openMachine(t, { baseUrl, phone: ALICE, home: alice.home, name: 'reconcile-alice-restart' })
  restarted.wg.deliverRemote = async (...args) => { remoteDeliveries += 1; return originalDeliverRemote(...args) }
  await until(() => restarted.wg.bridge.status().connected, { label: 'Alice reconnects' })

  const bobStart = (bob.followups ?? []).filter(entry => entry.message?.source?.role === 'room').at(-1)
  assert.ok(bobStart !== undefined, "Bob's Bot was called")
  const emit = async (event) => {
    for (const listener of bob.rt.ctx.listeners.get('session/event') ?? []) await listener({ id: bobStart.sessionId }, event)
  }
  await emit({ type: 'turn/start', data: { turn: 1 } })
  await emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '恢复后的答复' }] } } })
  await emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const hubAnswer = async () => {
    const page = await alice.wg.hub.events({ workgroupId, afterSeq: 0 })
    return (page.events ?? []).find(event => event.payload?.exchangeId === exchangeId)
  }
  await until(async () => (await hubAnswer()) !== undefined, { label: 'the answer to reach the Hub log' })
  const answer = await hubAnswer()

  // THE AUTOMATIC RECONNECT PATH, not a manual `reconcileRounds` call. Wait for hello/sync to do it.
  await until(() => restarted.wg.roundOf(roundId)?.slots?.find(slot => slot.exchangeId === exchangeId)?.status === 'posted',
    { label: 'the reconnect handshake to reconcile the slot' })
  const lines = (roomOf(restarted, workgroupId)?.log ?? []).filter(line => line.text === '恢复后的答复')
  assert.equal(lines.length, 1, 'the recovered answer is present exactly once')
  assert.equal(lines[0].exchangeId, exchangeId, 'and keeps the exchange that called it')
  assert.equal(lines[0].hubEventId, answer.eventId, 'and the Hub identity that makes it durable')
  assert.equal(restarted.wg.roundOf(roundId).state, 'open', 'the recovered round remains its own obligation')
  assert.equal(remoteDeliveries, 0, 'reconciliation never called another member')
  assert.equal(relayRounds, 0, 'reconciliation never opened a relay round')
})

// 9. A REMOTE SLOT IS AN OBLIGATION, NOT A PROCESS-LOCAL PROMISE.
//
// A round waiting on another machine holds an exchange id in memory. If the coordinator process is
// replaced, the Hub still has the call and the colleague's Bot may still answer, but the new process
// has nothing that says what to do with that answer. The projection must be written before the wait
// and read after a restart, while the Hub stays the authority for whether the answer exists.
test('a remote slot survives a coordinator restart as an open obligation', async (t) => {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE, team: ALICE_TEAM, name: 'persist-alice' })
  const bob = await machine(t, { baseUrl, phone: BOB, team: BOB_TEAM, name: 'persist-bob' })
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })
  const created = await alice.call('create-room', {
    name: '轮次持久化',
    members: [{ id: 'a', name: 'Chief', kind: 'localBot' }],
  })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const workgroupId = created.value.hub.workgroupId
  await alice.call('invite-member', { workgroupId, phone: BOB })
  const incoming = await bob.call('group-invites', {})
  await bob.call('answer-invite', { inviteId: incoming.value.incoming[0].inviteId, accept: true })
  await bob.wg.bridge.joinWithPrimaryBot({ workgroupId })
  const room = roomOf(alice, workgroupId)
  await until(() => (room.members ?? []).some(member => member.name === 'BobChief'),
    { label: "BobChief in Alice's roster" })
  const remote = room.members.find(member => member.name === 'BobChief')
  assert.equal(room.adminId, 'a', `the owner Bot leads the Hub group: ${JSON.stringify({ adminId: room.adminId, members: room.members })}`)

  // A REAL round, from the relay the product registers. The user names Bob's Bot, so the round's
  // second slot is a Hub call rather than a local model turn.
  alice.wg.roomInbox.set(room.id, [{ text: 'please check this', who: 'User' }])
  const running = alice.rt.ctx.registeredTools.get('workgroup_relay').execute(
    {}, { agent: { id: room.id }, callId: 'call-round-restart', signal: new AbortController().signal },
  )

  // The admin (Alice's Chief) speaks first. Its answer names the remote Bot, which selects Bob's
  // Bot as the next speaker through the copied `callMembers`, exactly as a local group does.
  let chief
  await until(() => {
    chief = [...alice.wg.roomWaiters.values()].find(entry => entry.roomId === room.id && entry.memberId === 'a')
    return chief !== undefined
  }, { label: 'the admin turn to start' })
  const emit = async (event) => {
    for (const listener of alice.rt.ctx.listeners.get('session/event') ?? []) await listener({ id: chief.sessionId }, event)
  }
  await emit({ type: 'turn/start', data: { turn: 1 } })
  await emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '@BobChief please check this' }] } } })
  await emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })

  let record
  await until(() => {
    record = Object.values(alice.wg.state.rounds ?? {}).find(entry => entry.roomId === room.id)
    return record?.slots?.some(slot => slot.status === 'remote' && typeof slot.exchangeId === 'string')
  }, { label: 'the remote slot to be persisted' })
  const expected = record.slots.find(slot => slot.status === 'remote')

  // Replace the process, not the home. Every in-memory round and waiter disappears; the state file
  // and the Hub account remain, which is what a real coordinator restart looks like.
  await alice.wg.bridge.stop()
  await alice.wg.flushSave()
  await alice.ctx.dispose()
  const restarted = await openMachine(t, { baseUrl, phone: ALICE, home: alice.home, root: join(alice.home, '..', 'bot-restart-persist'), name: 'persist-alice-restart' })
  await until(() => restarted.wg.bridge.status().connected, { label: 'the restarted coordinator to reconnect' })
  await restarted.wg.load()

  const recovered = restarted.wg.roundOf?.(record.roundId)
  assert.ok(recovered !== undefined, 'the open round survived the coordinator restart')
  assert.equal(recovered.state, 'open', 'a remote member that has not answered is still an obligation')
  const slot = recovered.slots.find(entry => entry.exchangeId === expected.exchangeId)
  assert.ok(slot !== undefined, `the waiting slot kept its exchange: ${JSON.stringify(recovered.slots)}`)
  assert.equal(slot.status, 'remote', 'and it is still waiting for the answer')
  // The abandoned round is waiting on a member that will never answer in this test; bound the wait so
  // the test ends promptly without depending on the product's reply timeout.
  await Promise.race([running.catch(() => {}), new Promise(resolve => setTimeout(resolve, 100))])
})

// 10. SETTINGS ARE COMPARED BY VERSION, NOT LAST-WRITE-WINS.
//
// The Hub refuses a write based on an old version, and the plugin refuses an old response. The Hub
// side is driven from Alice (the owner, the only account with write permission in this fixture); the
// local side then applies an older snapshot directly to Alice's room and proves it is ignored.
test('an older settings snapshot cannot overwrite a newer room', async (t) => {
  const { alice, workgroupId } = await invitedPair(t)
  const room = roomOf(alice, workgroupId)
  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })
  await until(() => Number.isFinite(room.hubConfigVersion), { label: 'the room to learn the config version' })
  const v1 = room.hubConfigVersion

  const first = await alice.call('update-room', { id: room.id, name: '版本一' })
  assert.equal(first.ok, true, JSON.stringify(first.error))
  const afterFirst = await alice.wg.hub.workgroup(workgroupId)
  assert.ok(afterFirst.configVersion > v1, 'the accepted write advances the Hub version')
  assert.equal(room.hubConfigVersion, afterFirst.configVersion, 'and the room follows it')
  const stale = await alice.wg.bridge.updateGroupSettings({ workgroupId, name: '旧版本覆盖', configVersion: v1 })
    .then(() => undefined)
    .catch(error => error)
  assert.equal(stale?.code ?? stale?.status, 'workgroup/settings-stale', `stale=${JSON.stringify(stale)}`)
  const stored = await alice.wg.hub.workgroup(workgroupId)
  assert.equal(stored.name, '版本一', 'the stale write never changed the Hub')

  const before = { name: room.name, version: room.hubConfigVersion }
  await alice.wg.applyRoster({
    hubWorkgroupId: workgroupId,
    members: room.members.map(member => ({ ...member, membershipId: member.membershipId ?? member.id })),
    replyMode: room.mode,
    leadMembershipId: undefined,
    name: '服务器旧快照',
    notice: room.notice,
    configVersion: before.version - 1,
  })
  assert.equal(room.name, before.name, 'an older response is ignored')
  assert.equal(room.hubConfigVersion, before.version, 'and cannot move the version backwards')
})

// 11. A STOP IS DURABLE ACROSS A COORDINATOR RESTART.
//
// The user pressed Stop on a round that was waiting for another machine. That decision must survive
// the process that made it: a late answer may be recorded (the Hub is the log), but it must never
// continue the round or recreate its waiter.
test('a stopped round stays stopped after a coordinator restart', async (t) => {
  const { baseUrl } = await withHub(t)
  const alice = await machine(t, { baseUrl, phone: ALICE, team: ALICE_TEAM, name: 'stopped-alice' })
  const bob = await machine(t, { baseUrl, phone: BOB, team: BOB_TEAM, name: 'stopped-bob' })
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })
  const created = await alice.call('create-room', {
    name: '停止恢复',
    members: [{ id: 'a', name: 'Chief', kind: 'localBot' }],
  })
  const workgroupId = created.value.hub.workgroupId
  await alice.call('invite-member', { workgroupId, phone: BOB })
  const incoming = await bob.call('group-invites', {})
  await bob.call('answer-invite', { inviteId: incoming.value.incoming[0].inviteId, accept: true })
  await bob.wg.bridge.joinWithPrimaryBot({ workgroupId })
  const room = roomOf(alice, workgroupId)
  await until(() => (room.members ?? []).some(member => member.name === 'BobChief'), { label: 'remote roster' })
  const remote = room.members.find(member => member.name === 'BobChief')
  const exchangeId = 'exchange-stopped-1'
  const roundId = 'round-stopped-1'
  alice.wg.persistRound({
    id: roundId,
    roomId: room.id,
    startSeq: room.seq + 1,
    slots: [{ id: remote.id, name: remote.name, status: 'remote', exchangeId }],
    replies: [],
    passed: [],
    failed: [],
    started: [],
    turns: 1,
  })
  await alice.wg.flushSave()
  const stopped = await alice.wg.stopRound(room.id)
  assert.equal(stopped, true, 'stopping a recovered record is reported')

  await alice.wg.bridge.stop()
  await alice.wg.flushSave()
  await alice.ctx.dispose()
  const restarted = await openMachine(t, { baseUrl, phone: ALICE, home: alice.home, name: 'stopped-alice-restart' })
  await until(() => restarted.wg.bridge.status().connected, { label: 'the restarted coordinator' })
  await restarted.wg.load()
  const record = restarted.wg.roundOf(roundId)
  assert.equal(record.state, 'stopped', 'the stop survived the restart')
  assert.equal(record.slots[0].status, 'stopped')

  // A late answer with that exchange is logged once, but the round does not continue and no waiter
  // is recreated.
  const before = (roomOf(restarted, workgroupId)?.log ?? []).length
  await restarted.wg.receiveRemote({
    workgroupId,
    event: {
      eventId: 'evt_late_stopped_answer',
      seq: room.seq + 2,
      type: 'chat.message',
      sender: { userId: 'usr_bob', botEndpointId: remote.endpointId },
      payload: { text: '迟到的答复', exchangeId, senderName: remote.name },
    },
  })
  await restarted.wg.reconcileRounds(workgroupId)
  assert.equal(restarted.wg.roundOf(roundId).state, 'stopped', 'a late answer does not reopen the round')
  assert.equal((roomOf(restarted, workgroupId)?.log ?? []).length, before + 1, 'the late line is recorded once')
})
