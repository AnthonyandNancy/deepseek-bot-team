// G1 behaviour gates: a workgroup round really runs, is stoppable, and is recoverable.
//
// The isolation suite (workgroup-isolation.test.js) proves the two domains cannot touch
// each other. This file proves the copied round machinery actually works — the plan's
// G1 gate asks for 创建、改名、@、讨论、进度、Stop、删除、恢复 to be verified, not just wired.
//
// A member's answer is played back through the session/event listener the way the
// original's rounds.test.js does it, so a round runs with no model call.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

export function startRoundFixture() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-wg-round-'))
  const ctx = fakeContext()
  const workspaces = new Map()
  const created = []
  const cancelled = []
  const archived = []
  // Every message delivered into a Session, in order: what a group chat would show.
  const followups = []
  let seq = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }] },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async (id) => { archived.push(id) },
    },
    sessionController: {
      create: async () => { const sessionId = `s-${++seq}`; created.push(sessionId); return { sessionId } },
      resolveAgent: async sessionId => ({
        agent: {
          session: { id: sessionId },
          followup: (message) => { followups.push({ sessionId, message }) },
          cancel: (why) => { cancelled.push({ sessionId, why }) },
        },
      }),
      selectModel: async () => {},
      prompt: async () => ({ accepted: true }),
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  // The workgroup channel's own route, captured so the RPC surface is exercised the way
  // the panel calls it (not by reaching into wg directly).
  const wgRoutes = []
  const registerRoute = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    if (options.path === '/api/workgroup') wgRoutes.push(options)
    return registerRoute(options)
  }
  const rt = createRuntime(ctx, { home })
  const wg = rt.workgroup
  const rpc = async (endpoint, payload) => {
    const route = wgRoutes.at(-1)
    const response = await route.fetch(new Request('http://localhost/api/workgroup', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }

  // One member answers: the domain's own session/event listener resolves the waiter.
  // A reply is what the member's TURN ends with (the original resolves a room waiter on
  // `turn/end`, not on each intermediate message), so the whole turn is played back, the
  // same way test/rounds.test.js does it for the original domain.
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const answer = async (sessionId, text) => {
    await emit(sessionId, { type: 'turn/start', data: { turn: 1 } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }
  // Start a round the way the relay tool does, but return the promise plus the round so
  // the test can answer or stop mid-round.
  const beginRound = async (room, text) => {
    wg.roomInbox.set(room.id, [{ text, who: 'User' }])
    return ctx.registeredTools.get('workgroup_relay').execute({}, { agent: { id: 'relay-session' }, callId: 'call-1', signal: new AbortController().signal })
  }
  // Wait until the round has actually ATTACHED a waiter for a member's Session, then
  // answer it.
  //
  // The fixed 30/40 ms sleeps these tests used are a race with two distinct failures under
  // `npm run verify` (the suite runs its files in parallel): sometimes the Session does not
  // exist yet, and sometimes it exists but the round has not yet registered its waiter —
  // `sessionFor` (which creates the Session) runs BEFORE `roomWaiters.set`. In the second
  // window the answer is delivered to a Session nothing is listening to, and the round
  // either waits out `WG_REPLY_TIMEOUT_MS` (240 s) or returns an empty reply.
  //
  // Two earlier attempts polled with `setTimeout` and deadlocked: a timer poll starves the
  // round's own continuation, so the waiter it waits for is never registered. `setImmediate`
  // does not have that problem — it yields to the microtask queue and the timer phase
  // between checks, so the round keeps advancing while this waits.
  const untilWaiter = async (memberId, deadlineMs = 20_000) => {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      const waiter = [...wg.roomWaiters.values()].find(entry => entry.memberId === memberId)
      if (waiter !== undefined) return waiter.sessionId
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${memberId}'s waiter`)
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, wg, home, answer, beginRound, rpc, stop, created, cancelled, archived, followups, untilWaiter }
}

const twoMembers = () => ([
  { id: 'bot-a', kind: 'localBot', name: 'Writer' },
  { id: 'bot-b', kind: 'localBot', name: 'Editor' },
])

// The team's Bots as the host actually stores them. A member Session renders its Bot's
// identity from `state.bots`, so a test about identity needs the Bots to exist — in the
// real app they always do.
const plantBots = (rt) => {
  for (const [id, name, role] of [['bot-a', 'Writer', 'the writer'], ['bot-b', 'Editor', '']]) {
    rt.state.bots[id] = { id, name, ...(role ? { role } : {}), instructions: `${name} instructions`, createdAt: 1, capabilities: [] }
  }
}

// The relay tool only runs for a Session this domain owns, so the test must register the
// relay's own Session first — that is also what proves the ownership gate is enforced.
async function ownRelaySession(wg) {
  const room = await wg.createWorkgroup({ name: 'RoundProbe', members: twoMembers() })
  wg.registerSessionOwner('relay-session', { kind: 'workgroup', workgroupId: room.id })
  return room
}

test('a workgroup round runs, posts each answer and records who passed', async (t) => {
  const { wg, answer, beginRound, stop, untilWaiter } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  // The admin (first member) answers; the second passes.
  const running = beginRound(room, '讨论一下这个方案')
  // Wait for the round's own waiter, not for the Session: `sessionFor` creates the
  // Session BEFORE `roomWaiters.set`, so a Session that exists can still have nothing
  // listening to it, and an answer delivered in that window is dropped.
  const adminSession = await untilWaiter('bot-a')
  assert.ok(wg.workgroupOf(room.id).sessions['bot-a'] !== undefined, 'the admin got a Session of its own')
  await answer(adminSession, '我建议先做隔离')
  const result = JSON.parse(await running)
  assert.equal(result.replies[0].text, '我建议先做隔离')
  assert.equal(wg.workgroupOf(room.id).log.at(-1).text, '我建议先做隔离', 'the round is in the room log')
})

test('a finished round leaves no recovery record, and a stopped one does', async (t) => {
  const { wg, answer, beginRound, stop, untilWaiter } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  const live = []
  const original = wg.persistRound
  wg.persistRound = (round) => { live.push(round.id ?? round.roundId); return original(round) }
  const running = beginRound(room, '只让管理员回答一次')
  const adminSession = await untilWaiter('bot-a')
  await answer(adminSession, '完成了')
  await running
  const id = live.find(entry => entry !== undefined)
  assert.ok(id !== undefined, 'the round was projected while it ran')
  assert.equal(wg.roundOf(id), undefined, 'a fully answered round is not an open obligation')
})

test('a round names only the member an @mention calls', async (t) => {
  const { wg, answer, beginRound, stop } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  const running = beginRound(room, '@Editor 你看看')
  await new Promise(resolve => setTimeout(resolve, 30))
  const editorSession = wg.workgroupOf(room.id).sessions['bot-b']
  assert.ok(editorSession !== undefined, 'the mentioned member was called')
  assert.equal(wg.workgroupOf(room.id).sessions['bot-a'], undefined, 'the unmentioned admin was not called')
  await answer(editorSession, '看过了，没问题')
  const result = JSON.parse(await running)
  assert.equal(result.replies[0].name, 'Editor')
})

test('@all calls every member, one at a time', async (t) => {
  const { wg, answer, beginRound, stop } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  const running = beginRound(room, '@all 大家好')
  // A round is serial by design (the original's rule: one member speaks at a time), so
  // the second member is only called after the first has answered.
  await new Promise(resolve => setTimeout(resolve, 40))
  const first = wg.workgroupOf(room.id).sessions['bot-a']
  assert.ok(first !== undefined, 'the admin was called first')
  assert.equal(wg.workgroupOf(room.id).sessions['bot-b'], undefined, 'the others wait their turn')
  await answer(first, '收到')
  await new Promise(resolve => setTimeout(resolve, 40))
  const second = wg.workgroupOf(room.id).sessions['bot-b']
  assert.ok(second !== undefined, 'then the other member is called')
  await answer(second, '也收到')
  const result = JSON.parse(await running)
  assert.equal(result.replies.length, 2, 'both members posted')
})

test('a [PASS] reply stays out of the room log', async (t) => {
  const { wg, answer, beginRound, stop, untilWaiter } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  const running = beginRound(room, '闲聊')
  // Answer the turn that is really listening. A fixed sleep can land after the Session exists but
  // before its waiter is registered; the answer then goes nowhere and this test waits 240 s for a
  // timeout it was supposed to avoid.
  const sessionId = await untilWaiter('bot-a')
  await answer(sessionId, '[PASS]')
  const result = JSON.parse(await running)
  assert.equal(result.replies.length, 0, 'nothing was posted')
  assert.ok(result.passed.includes('Writer'), 'and the member is recorded as having passed')
})

test('stopping a round cancels the member turn and drops its late reply', async (t) => {
  const { wg, answer, beginRound, cancelled, stop, untilWaiter } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  const running = beginRound(room, '做点慢活')
  // `sessionFor` creates the member's Session BEFORE `roomWaiters` gets its entry. A fixed sleep
  // sometimes landed inside that gap, so the stop found nothing to cancel. Wait for the waiter —
  // the same condition the other round tests use — and stop that exact turn.
  const sessionId = await untilWaiter('bot-a')
  const stopped = await wg.stopRound(room.id)
  assert.equal(stopped, true, 'stopRound reports that it stopped something')
  assert.ok(cancelled.some(entry => entry.sessionId === sessionId), 'the member turn was cancelled')
  // A reply arriving after the stop must not reach the log.
  await answer(sessionId, '这是我迟到的回答')
  await running
  const texts = wg.workgroupOf(room.id).log.map(line => line.text)
  assert.equal(texts.includes('这是我迟到的回答'), false, 'the late reply was dropped')
})

test('stopping a round that is not running is a no-op, not an error', async (t) => {
  const { wg, stop } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  assert.equal(await wg.stopRound(room.id), false)
})

test('names are labels: a custom name may repeat, and an empty name restores the automatic one', async (t) => {
  const { wg, stop } = startRoundFixture()
  t.after(stop)
  const first = await wg.createWorkgroup({ name: '原名', members: twoMembers() })
  await wg.createWorkgroup({ name: '另一个', members: twoMembers() })
  await wg.updateWorkgroup(first.id, { name: '新名' })
  assert.equal(wg.workgroupOf(first.id).name, '新名')
  // Names are labels, not identities: reusing another group's custom name is allowed.
  await wg.updateWorkgroup(first.id, { name: '另一个' })
  assert.equal(wg.workgroupOf(first.id).name, '另一个')

  // An empty name returns the group to its automatic name, which is derived from the
  // members and may therefore equal another group's — exactly as two local groups over
  // the same Bots share "You, Writer, Editor".
  await wg.updateWorkgroup(first.id, { name: '' })
  // The automatic name is the members plus the group's creation time.
  assert.match(wg.workgroupOf(first.id).name, /^You, Writer, Editor · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.equal(wg.workgroupOf(first.id).named, undefined, 'an automatic name is not "custom"')
})

test('only the user or the admin may change a workgroup', async (t) => {
  const { wg, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: '权限', members: twoMembers() })
  assert.equal(wg.workgroupOf(room.id).adminId, 'bot-a')
  await wg.updateWorkgroup(room.id, { notice: '管理员改的' }, 'bot-a')
  assert.equal(wg.workgroupOf(room.id).notice, '管理员改的')
  await assert.rejects(() => wg.updateWorkgroup(room.id, { notice: '路人改的' }, 'bot-b'), /Only the user or the admin/)
})

test('removing a member releases and archives its Session', async (t) => {
  const { wg, archived, stop } = startRoundFixture()
  t.after(stop)
  // Three members, so one may legally leave: a group may never drop below two (the
  // original's `checkMembers`, which this domain now enforces as well).
  const room = await wg.createWorkgroup({ name: '成员变更', members: [...twoMembers(), { id: 'bot-c', kind: 'localBot', name: 'Third' }] })
  // Give the member a Session by handing it one directly through the domain.
  const { id: sessionId } = await wg.sessionFor(wg.workgroupOf(room.id), wg.workgroupOf(room.id).members[1])
  assert.ok(sessionId !== undefined)
  assert.ok(wg.sessionOwners.has(sessionId))
  await wg.updateWorkgroup(room.id, { remove: ['bot-b'] })
  assert.equal(wg.workgroupOf(room.id).members.some(member => member.id === 'bot-b'), false)
  assert.equal(wg.sessionOwners.has(sessionId), false, 'the ownership was released')
  assert.ok(archived.includes(sessionId), 'and the Session was archived')
})

test('deleting a workgroup clears its map entries and releases every Session', async (t) => {
  const { wg, archived, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: '待删除', members: twoMembers() })
  const { id: sessionId } = await wg.sessionFor(wg.workgroupOf(room.id), wg.workgroupOf(room.id).members[0])
  await wg.deleteWorkgroup(room.id)
  assert.equal(wg.workgroupOf(room.id), undefined)
  assert.equal(wg.sessionOwners.has(sessionId), false)
  assert.ok(archived.includes(sessionId))
  assert.equal(wg.roomInbox.has(room.id), false, 'no inbox entry is left behind')
})

test('resume reports interrupted work but never replays a round', async (t) => {
  const { wg, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: '恢复', members: twoMembers() })
  await wg.sessionFor(wg.workgroupOf(room.id), wg.workgroupOf(room.id).members[0])
  const outcome = await wg.resumeWorkgroup(room.id)
  assert.equal(outcome.replayed, false, 'a resumed round is never replayed automatically')
  assert.equal(outcome.interrupted.length, 1, 'the member with a Session is reported')
  // and the room says so, so the user knows why the work stopped
  assert.ok(wg.workgroupOf(room.id).log.some(line => line.kind === 'resumed'))
})

test('the relay tool refuses a Session this domain does not own', async (t) => {
  const { ctx, wg, stop } = startRoundFixture()
  t.after(stop)
  await wg.createWorkgroup({ name: '越权', members: twoMembers() })
  // 'relay-session' was never registered as owned.
  const out = await ctx.registeredTools.get('workgroup_relay').execute({}, { agent: { id: 'relay-session' }, callId: 'c', signal: new AbortController().signal })
  assert.match(out, /Not a workgroup Session/)
})

test('the read tool refuses a Session this domain does not own', async (t) => {
  const { ctx, wg, stop } = startRoundFixture()
  t.after(stop)
  await wg.createWorkgroup({ name: '越权读', members: twoMembers() })
  const out = await ctx.registeredTools.get('read_workgroup_chat').execute({ group: '越权读' }, { agent: { id: 'stranger' } })
  assert.match(out, /Only members of a Workgroup/)
})

// A workgroup created from the new-chat menu must not be a dead end: with no members
// there is no relay Session, so a posted message would queue forever and the panel would
// look frozen. The route refuses instead, and says why.
test('sending into a workgroup with no members is refused, not silently queued', async (t) => {
  const { wg, rpc, stop } = startRoundFixture()
  t.after(stop)
  // A workgroup can no longer be CREATED empty — it needs two members, like a local group
  // (the original's `checkMembers`). The send guard still matters, because a record can
  // reach this state from older data or from a Bot being deleted, so the room is emptied
  // here directly rather than through a create that would now be refused.
  const room = await wg.createWorkgroup({ name: 'Empty', members: twoMembers() })
  await wg.load()
  wg.workgroupOf(room.id).members = []
  const result = await rpc('send', { roomId: room.id, text: '有人吗' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bot/invalid')
  assert.match(result.error.message, /no members yet/)
  // Nothing was left behind in the inbox, so a later member cannot receive a stale post.
  assert.equal(wg.roomInbox.get(room.id), undefined)
})

test('sending into a workgroup prompts its own Session, the way a group chat does', async (t) => {
  const { wg, rpc, stop, followups } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  const result = await rpc('send', { roomId: room.id, text: '开始吧' })
  assert.equal(result.ok, true)
  // COPY OF THE ORIGINAL: the message goes into the group's own Session as an ordinary
  // user message — `actions.send(room.id, text)` on a local group — so it is visible in
  // the group chat and the relay answers it. Queuing it directly in `roomInbox` (what
  // this used to do) meant nothing prompted the group, so no round ever ran.
  const posted = followups.at(-1)
  assert.equal(posted.sessionId, room.id, 'the message went into the group\'s own Session')
  assert.equal(posted.message.source?.kind, 'user', 'it is the user\'s own message')
})

// The user's report: creating a second workgroup with the SAME bots failed with
// "A workgroup named You, Chief, 阿三大苏打 already exists". The original never does that:
// its automatic name is derived from the members, so two groups over the same Bots share
// it by design, and only a CUSTOM name is checked for a clash.
test('the same Bots can make several workgroups: the automatic name may repeat', async (t) => {
  const { wg, stop } = startRoundFixture()
  t.after(stop)
  const a = await wg.createWorkgroup({ members: twoMembers() })
  const b = await wg.createWorkgroup({ members: twoMembers() })
  assert.notEqual(a.id, b.id, 'two distinct workgroups')
  // Both carry the members; each is stamped with its own creation time.
  assert.match(a.name, /^You, Writer, Editor · /)
  assert.match(b.name, /^You, Writer, Editor · /, 'the second one is not refused')
  // Identity is the id — now the group's own Session id, exactly as the original's
  // `buildRoom` does it (`const id = await createSession(title)`).
  assert.ok(typeof a.id === 'string' && a.id !== '' && a.id !== b.id)
  assert.equal(wg.state.workgroups[a.id].named, undefined, 'neither counts as custom')
  assert.equal(wg.state.workgroups[b.id].named, undefined)
})

test('members are de-duplicated, as the original composer does', async (t) => {
  const { wg, stop } = startRoundFixture()
  t.after(stop)
  // The picker can hand the same Bot twice; a Bot is an identity, not an occurrence.
  const room = await wg.createWorkgroup({ members: [...twoMembers(), ...twoMembers()] })
  assert.deepEqual(room.members.map(member => member.id), ['bot-a', 'bot-b'])
  assert.match(room.name, /^You, Writer, Editor · /, 'a duplicate does not repeat in the name')
})

test('two workgroups may share a custom name: the id is what identifies them', async (t) => {
  const { wg, stop } = startRoundFixture()
  t.after(stop)
  const a = await wg.createWorkgroup({ name: '财务月报', members: twoMembers() })
  const b = await wg.createWorkgroup({ name: '财务月报', members: twoMembers() })
  assert.equal(a.name, b.name, 'the same label on both')
  assert.notEqual(a.id, b.id, 'but distinct ids')
  assert.equal(wg.workgroupOf(a.id).name, '财务月报')
  assert.equal(wg.workgroupOf(b.id).name, '财务月报')
})

// The user's rule: groups that share a name cannot have their admin changed — with two
// rows reading the same, a change is not safely attributable to one of them. Give this
// one its own name first, then change the admin.
test('a group whose name is shared with another cannot have its admin changed', async (t) => {
  const { wg, stop } = startRoundFixture()
  t.after(stop)
  // Same members => the same automatic name, which is exactly the ambiguous case. The
  // automatic name carries a SECOND-granularity stamp (`stamp` in groups.js), so two
  // creates that straddle a second boundary legitimately differ and the assertion used to
  // race the clock. Both get the same explicit name instead: that is the ambiguity this
  // test is about, and it cannot flake.
  const a = await wg.createWorkgroup({ name: 'Ops', members: twoMembers() })
  const b = await wg.createWorkgroup({ name: 'Ops', members: twoMembers() })
  assert.equal(a.name, b.name, 'both carry the same name')

  await assert.rejects(() => wg.updateWorkgroup(a.id, { adminId: 'bot-b' }), /rename this one before changing its admin/)
  assert.equal(wg.workgroupOf(a.id).adminId, 'bot-a', 'the admin is unchanged')

  // Give it a name of its own first: then the change is unambiguous and allowed.
  await wg.updateWorkgroup(a.id, { name: '财务月报' })
  await wg.updateWorkgroup(a.id, { adminId: 'bot-b' })
  assert.equal(wg.workgroupOf(a.id).adminId, 'bot-b')

  // Now that it is the only group with that name, its admin may change too — the block
  // was about the ambiguity, not about the group.
  await wg.updateWorkgroup(b.id, { adminId: 'bot-a' })
  assert.equal(wg.workgroupOf(b.id).adminId, 'bot-a')
})

test('a uniquely-named group may change its admin without renaming', async (t) => {
  const { wg, stop } = startRoundFixture()
  t.after(stop)
  // One workgroup with this member set, so its automatic name is unique: nothing ambiguous.
  const room = await wg.createWorkgroup({ members: twoMembers() })
  await wg.updateWorkgroup(room.id, { adminId: 'bot-b' })
  assert.equal(wg.workgroupOf(room.id).adminId, 'bot-b')
})

// The user's report: a workgroup could be created but not opened.
//
// Cause: the original opens a group with `openSession(room.id)` because a group IS a
// Session (`buildRoom`: `const id = await createSession(title)`). The workgroup had only
// per-member Sessions and a synthetic `wg-<uuid>` id, so there was nothing to open.
test('a workgroup is a Session, exactly as an original group is', async (t) => {
  const { wg, rt, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ members: twoMembers() })
  // Its id is a real Session id from the runtime, not a made-up string.
  assert.match(room.id, /^s-\d+$/, `expected a Session id, got ${room.id}`)
  assert.equal(room.id, wg.workgroupOf(room.id).id, 'the room is keyed by its Session')
  // And it is owned by THIS domain, so the original never claims it.
  assert.equal(rt.groupOwners?.has(room.id) ?? false, false, 'the original must not own it')
  assert.equal(rt.roomOf?.(room.id), undefined, 'the original must not see it as a local group')
  assert.equal(rt.resolveSessionOwnerStrict(room.id).domain, 'workgroup')
})

test('opening a workgroup is the original openSession(room.id)', async (t) => {
  const { wg, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ members: twoMembers() })
  // The client action resolves the room id and hands it to openSession — the same call
  // the original makes for a group. Nothing else needs to be selected.
  assert.equal(typeof room.id, 'string')
  assert.ok(room.id.length > 0)
})

// Groups created before "a group is a Session" carry a synthetic `wg-<uuid>` id and have
// no Session, so they could not be opened. Reading the list upgrades them in place rather
// than leaving dead rows the user cannot enter.
test('a legacy workgroup gets a Session the first time the list is read', async (t) => {
  const { wg, rt, rpc, stop } = startRoundFixture()
  t.after(stop)
  // Plant a legacy record the way the old code wrote it.
  await wg.load()
  wg.state.workgroups['wg-OLD'] = {
    id: 'wg-OLD', name: '旧工作群', notice: '', members: [{ id: 'bot-a', name: 'Writer', kind: 'localBot' }],
    adminId: 'bot-a', mode: 'admin', createdAt: 1, seq: 0, log: [], seen: {}, sessions: {}, segments: {},
  }
  await wg.save()

  const listed = await rpc('state', {})
  const ids = listed.value.rooms.map(room => room.id)
  assert.equal(ids.some(id => String(id).startsWith('wg-')), false, `still synthetic: ${ids}`)
  // The migrated group keeps its name and becomes openable.
  const opened = await rpc('room', { id: ids[0] })
  assert.equal(opened.ok, true)
  assert.equal(opened.value.name, '旧工作群')
  assert.equal(rt.resolveSessionOwnerStrict(ids[0]).domain, 'workgroup')
})

// A workgroup opened from the menu must be a working group chat, not an empty page.
// The three pieces below are copied from the original group chat; each was missing, and
// together they are what "进入工作群聊" means.
test('the group\'s own Session is told to relay, as an original group Session is', async (t) => {
  const { ctx, wg, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: 'RelayPrompt', members: twoMembers() })
  const section = ctx.sections.get('workgroup-relay')
  assert.ok(section !== undefined, 'the relay instruction is registered')

  // A workgroup Session gets it, naming the relay tool and forbidding its own text.
  const mine = section.text({ agent: { id: room.id } })
  assert.match(mine, /workgroup_relay/)
  assert.match(mine, /You are only the relay/)
  assert.match(mine, /Never add your own text/)

  // A member's Session is a Bot's own turn, and an ordinary Session is nobody's: neither
  // may be told it is a relay.
  const memberSession = Object.values(wg.workgroupOf(room.id).sessions ?? {})[0]
  if (memberSession !== undefined) assert.equal(section.text({ agent: { id: memberSession } }), '')
  assert.equal(section.text({ agent: { id: 'some-other-session' } }), '')
  assert.equal(section.text(undefined), '')
})

test('a round\'s answers reach the client the original way: through the relay result', async (t) => {
  const { wg, answer, beginRound, stop } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  const running = beginRound(room, '说说你的看法')
  await new Promise(resolve => setTimeout(resolve, 30))
  await answer(wg.workgroupOf(room.id).sessions['bot-a'], '我建议先做隔离')
  const result = JSON.parse(await running)

  // The ORIGINAL does not post in-round replies into the group's Session: `group_relay`
  // returns them, and the client draws them from that result (`GroupReplies`). Copying
  // that is what makes a workgroup chat render like a local group chat.
  assert.equal(result.replies.length, 1, 'the round returns its replies')
  assert.equal(result.replies[0].text, '我建议先做隔离')
  assert.equal(result.replies[0].botId, 'bot-a', 'attributed to the member')
  assert.equal(result.replies[0].name, 'Writer')
  // The line is in this domain's own room log, which `read_workgroup_chat` reads.
  assert.equal(wg.workgroupOf(room.id).log.at(-1).text, '我建议先做隔离')
})

test('what the user types into a workgroup is queued for the next round', async (t) => {
  const { ctx, wg, stop } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  // The original's turns.js listener does this for a local group: a user message in the
  // group Session becomes the next relay's post. Without it the relay had nothing to
  // relay and the group never answered.
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    await listener({ id: room.id }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '大家好' }] } })
  }
  assert.equal(wg.roomInbox.get(room.id).at(-1).text, '大家好')

  // A member's own Session is not the group: its turn is a Bot answering, not the user
  // posting, so nothing is queued for the group from it.
  wg.roomInbox.delete(room.id)
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    await listener({ id: 'bot-a' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '不是群消息' }] } })
  }
  assert.equal(wg.roomInbox.get(room.id), undefined)
})

// THE reason a workgroup chat works at all, copied from the original.
//
// A group's own Session must never consult the model: models drift from "only call the
// relay tool", so the original synthesizes the relay tool call in `llm/stream` and returns
// it as the model's answer. Relying on a system prompt instead left the group silent
// whenever the model chose to answer in its own voice — the reported "进不去".
test('the group Session relays by itself, without asking the model', async (t) => {
  const { ctx, wg, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: 'RelayStream', members: twoMembers() })
  const hook = ctx.listeners.get('llm/stream').find(listener => listener.relay === 'workgroup_relay')
  assert.ok(hook !== undefined, 'the relay hook is registered')

  const drain = async stream => { const out = []; for await (const chunk of stream) out.push(chunk); return out }
  let called = 0
  const next = () => { called += 1; return (async function* () {})() }

  // A user message in the group Session: the relay tool call is synthesized.
  const opening = { sessionId: room.id, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '大家好' }] }] }
  const chunks = await drain(hook(opening, next))
  assert.equal(called, 0, 'the model was never asked')
  const call = chunks.find(chunk => chunk.type === 'block-end')?.block
  assert.equal(call?.name, 'workgroup_relay', 'the relay tool was called')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })

  // After the relay's own tool step there is nothing to relay: the turn just stops.
  const afterTool = { sessionId: room.id, messages: [{ role: 'user', source: { kind: 'user' }, content: [] }, { role: 'assistant', content: [] }, { role: 'tool', content: [] }] }
  const stopped = await drain(hook(afterTool, next))
  assert.deepEqual(stopped, [{ type: 'finish', reason: { kind: 'stop' } }])

  // A member's Session is a Bot's real turn, and an ordinary Session is nobody's: both
  // must reach the model.
  for (const sessionId of ['bot-a', 'some-other-session']) {
    let passed = 0
    await drain(hook({ sessionId, messages: [{ role: 'user', source: { kind: 'user' }, content: [] }] }, () => { passed += 1; return (async function* () {})() }))
    assert.equal(passed, 1, `${sessionId} reaches the model`)
  }
})

// A new workgroup opens with its admin asking what the group is for, as a new local group
// does. Without this the chat is a blank page and there is nothing to relay — greetRoom
// in the original.
test('a new workgroup posts a kickoff, so its chat is never a blank page', async (t) => {
  const { wg, stop, followups } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: 'Greeted', members: twoMembers() })
  // The kickoff is delivered asynchronously, on purpose: creating the group must not wait
  // for a Session round trip.
  await new Promise(resolve => setTimeout(resolve, 40))
  const kickoff = followups.findLast(entry => entry.message.source?.role === 'kickoff')
  assert.ok(kickoff !== undefined, 'the group opened with a kickoff')
  assert.equal(kickoff.sessionId, room.id, 'into the group\'s own Session')
  assert.equal(kickoff.message.source.kind, 'workgroup', 'under this domain\'s source kind')
})

// Stopping ONE member: the original's stopMemberWork. The round keeps going for the
// others; only the stopped member's reply is dropped.
test('one member can be stopped while the round goes on', async (t) => {
  const { wg, rpc, beginRound, stop, answer } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  // No @all: the admin answers alone, so the round has exactly one member to stop. With
  // two, the second would legitimately keep waiting and the test would hang on its own
  // setup rather than on the behaviour under test.
  const running = beginRound(room, '说说你的看法')
  await new Promise(resolve => setTimeout(resolve, 40))
  const adminSession = wg.workgroupOf(room.id).sessions['bot-a']
  assert.ok(adminSession !== undefined, 'the admin started working')

  assert.equal(await rpc('stop-member-work', { roomId: room.id, botId: 'bot-a' })
    .then(result => result.value), true, 'the working member stops')

  // A member that is not working answers false, not an error — the original's answer.
  const again = await rpc('stop-member-work', { roomId: room.id, botId: 'bot-a' })
  assert.equal(again.ok, true)
  assert.equal(again.value, false)
  const unknown = await rpc('stop-member-work', { roomId: room.id, botId: 'nobody' })
  assert.equal(unknown.value, false)

  // A reply that still arrives after the stop is dropped, not posted into the group.
  await answer(adminSession, '我还是说出来了')
  const result = JSON.parse(await running)
  assert.equal(result.replies.length, 0, 'the stopped member posted nothing')
  assert.equal(wg.workgroupOf(room.id).log.some(line => line.text === '我还是说出来了'), false, 'and it stayed out of the log')
})

// THE member identity bug, found from the real session log the user sent.
//
// The log showed a member Session whose system prompt said "# Workgroup relay … You are
// only the relay, not a participant. Never add your own text." — so the Bot answered with
// an empty message on every single turn and the group looked dead ("@bot 和对话都没回复").
//
// The original renders a member's group Session with that MEMBER's own prompt and tools
// (`room.sessions[botId]`), and only the group's own Session is the relay.
test('a member Session carries its Bot identity, and only the group Session is the relay', async (t) => {
  const { ctx, wg, rt, stop } = startRoundFixture()
  t.after(stop)
  plantBots(rt)
  const room = await wg.createWorkgroup({ name: 'Identity', members: twoMembers() })
  const section = ctx.sections.get('workgroup-relay')
  assert.ok(section !== undefined)

  // The group's own Session is the relay: it must not speak in its own voice.
  const relay = section.text({ agent: { id: room.id } })
  assert.match(relay, /You are only the relay/)
  assert.match(relay, /Never add your own text/)

  // A member's Session is that Bot's own turn: it gets the Bot's name and is never told
  // to stay silent.
  const { id: memberSession } = await wg.sessionFor(room, room.members[0])
  assert.ok(memberSession !== undefined)
  const member = section.text({ agent: { id: memberSession } })
  assert.match(member, /# Your identity/, 'the member knows who it is')
  assert.match(member, /Writer/, 'by its own name')
  assert.doesNotMatch(member, /Never add your own text/, 'and is not told to stay silent')
  assert.doesNotMatch(member, /You are only the relay/, 'a member is a participant, not the relay')
})

// The three defects a real session log exposed (G1R13). Each one is asserted at the
// exact place the log showed it, so the same report can never come back unnoticed.

// 1. "没有像原版群聊那样初始化": the kickoff must open a real round with the admin and the
//    original's kickoff prompt. Before this, the kickoff was relayed as an empty user
//    message, and the admin was asked to answer "User: " with nothing after it.
test('the kickoff opens a round with the admin and the original kickoff prompt', async (t) => {
  const { ctx, wg, followups, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: 'Kickoff', members: twoMembers() })
  await new Promise(resolve => setTimeout(resolve, 40))
  // The kickoff is delivered into the group's Session; that Session then emits the
  // `user/message` the domain's listener turns into a queued kickoff cue. The fake harness
  // records deliveries instead of running a Session, so the event is played back here.
  const kickoff = followups.findLast(entry => entry.message.source?.role === 'kickoff')
  assert.ok(kickoff !== undefined, 'the group opened with a kickoff')
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    await listener({ id: room.id }, { type: 'user/message', data: { source: kickoff.message.source, content: kickoff.message.content } })
  }
  const queued = wg.roomInbox.get(room.id) ?? []
  assert.equal(queued.length, 1, 'the kickoff was queued')
  assert.equal(queued[0].kickoff, true, 'queued as a kickoff cue, not as an empty message')
  const relay = ctx.registeredTools.get('workgroup_relay')
  wg.registerSessionOwner('relay-kickoff', { kind: 'workgroup', workgroupId: room.id })
  const running = relay.execute({}, { agent: { id: 'relay-kickoff' }, callId: 'c-kick', signal: new AbortController().signal })
  await new Promise(resolve => setTimeout(resolve, 40))
  const adminSession = wg.workgroupOf(room.id).sessions['bot-a']
  assert.ok(adminSession !== undefined, 'the admin was called for the opening turn')
  const prompt = followups.findLast(entry => entry.sessionId === adminSession)?.message.content[0].text ?? ''
  assert.match(prompt, /created this group and has not written yet/, 'the original kickoff text is used')
  assert.match(prompt, /Greet the user/, 'and it asks the admin to greet the user')
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    await listener({ id: adminSession }, { type: 'turn/start', data: { turn: 1 } })
    await listener({ id: adminSession }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '想让我做什么？' }] } } })
    await listener({ id: adminSession }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }
  const result = JSON.parse(await running)
  assert.equal(result.replies[0].text, '想让我做什么？', 'the greeting is posted')
})

// 2. "@bot 没回复": an @mention names the member, and only it.
test('an @mention in the first message calls that member and it answers', async (t) => {
  const { wg, answer, beginRound, stop } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  const running = beginRound(room, '@Editor 请检查一下')
  await new Promise(resolve => setTimeout(resolve, 30))
  const editorSession = wg.workgroupOf(room.id).sessions['bot-b']
  assert.ok(editorSession !== undefined, 'the mentioned member speaks')
  // The member is told it is in a group, and what "@Name" does there.
  await answer(editorSession, '检查完了')
  const result = JSON.parse(await running)
  assert.equal(result.replies.length, 1)
  assert.equal(result.replies[0].name, 'Editor', 'the mentioned member answered')
})

// 3. "对话没回复": what a member says before its last step is posted while it works, so the
//    group chat shows progress instead of going quiet until the turn ends.
test('a member at work posts what it says before its final answer', async (t) => {
  const { ctx, wg, beginRound, stop } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  const running = beginRound(room, '查一下')
  await new Promise(resolve => setTimeout(resolve, 30))
  const session = wg.workgroupOf(room.id).sessions['bot-a']
  const emit = async event => { for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: session }, event) }
  await emit({ type: 'turn/start', data: { turn: 1 } })
  // A text WITH a tool call goes on at once: the member is still working.
  await emit({ type: 'assistant/message', data: { message: { content: [
    { type: 'text', text: '我先看一下代码' },
    { type: 'tool-call', id: 't1', name: 'read', arguments: '{}' },
  ] } } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(wg.workgroupOf(room.id).log.some(line => line.text === '我先看一下代码'), 'the step line reached the group')
  await emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '看完了，没问题' }] } } })
  await emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const result = JSON.parse(await running)
  assert.equal(result.replies.at(-1).text, '看完了，没问题', 'the final answer is the reply')
})

// A failed model call is not a pass (the original's rule): the round says why the member
// is silent and goes on, so "no reply" is never silently reported as "[PASS]".
test('a failed member turn is reported as a failure, not a pass', async (t) => {
  const { ctx, wg, beginRound, stop } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  const running = beginRound(room, '帮我看一下')
  await new Promise(resolve => setTimeout(resolve, 30))
  const session = wg.workgroupOf(room.id).sessions['bot-a']
  const emit = async event => { for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: session }, event) }
  await emit({ type: 'turn/start', data: { turn: 1 } })
  await emit({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', message: 'no key' } } } })
  const result = JSON.parse(await running)
  assert.equal(result.failed.includes('Writer'), true, 'the member is listed as failed')
  assert.equal(result.passed.includes('Writer'), false, 'a failure is never a pass')
  assert.equal(result.replies[0].kind, 'failed')
  assert.equal(result.replies[0].code, 'AUTH')
})

// The bug a real screenshot exposed: a member's Session is owned by this domain under the
// same `kind: 'workgroup'` as the group's own Session, so a `kind`-only check in the relay
// hook captured it too. The member was then "answered" with a synthesized relay call
// instead of reaching the model, so every member turn ended with an empty
// `assistant/message` — kickoff produced nothing and `@Chief` produced nothing.
//
// The previous test used `'bot-a'` (a Bot id), which is not a Session id and therefore
// never exercised this path. This one uses the real member Session.
test('a member Session reaches the model, and only the group Session relays', async (t) => {
  const { ctx, wg, answer, beginRound, stop } = startRoundFixture()
  t.after(stop)
  const room = await ownRelaySession(wg)
  const hook = ctx.listeners.get('llm/stream').find(listener => listener.relay === 'workgroup_relay')
  assert.ok(hook !== undefined, 'the relay hook is registered')
  const drain = async stream => { const out = []; for await (const chunk of stream) out.push(chunk); return out }

  // Run a round far enough that the admin's own member Session exists.
  const running = beginRound(room, '说说看')
  await new Promise(resolve => setTimeout(resolve, 30))
  const memberSession = wg.workgroupOf(room.id).sessions['bot-a']
  assert.ok(memberSession !== undefined, 'the member got its own Session')

  // The member's Session must reach the model. Before the fix it was relayed instead,
  // which is why its answer came back empty.
  let memberCalls = 0
  await drain(hook({ sessionId: memberSession, messages: [{ role: 'user', source: { kind: 'workgroup', role: 'room' }, content: [] }] },
    () => { memberCalls += 1; return (async function* () {})() }))
  assert.equal(memberCalls, 1, 'the member Session is answered by the model')

  // The group's own Session still relays, and never reaches the model.
  let groupCalls = 0
  const chunks = await drain(hook({ sessionId: room.id, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '大家好' }] }] },
    () => { groupCalls += 1; return (async function* () {})() }))
  assert.equal(groupCalls, 0, 'the group Session never asks the model')
  assert.equal(chunks.find(chunk => chunk.type === 'block-end')?.block?.name, 'workgroup_relay')

  await answer(memberSession, '好')
  await running
})

// The round prompt tells a member it may call read_own_chat to look at its own chat, and
// that the group sees it looked. The copy registered only two of the original's three
// group tools, so the prompt promised a tool that did not exist.
test('a workgroup member can read its own chat, and the group sees it looked', async (t) => {
  const { ctx, rt, wg, answer, beginRound, stop } = startRoundFixture()
  t.after(stop)
  plantBots(rt)
  const room = await ownRelaySession(wg)
  const running = beginRound(room, '查一下我们之前说过什么')
  // A round nobody answers waits for the reply timeout, so an assertion that fires early
  // must not leave it pending: stop the round however this test ends.
  t.after(() => wg.stopRound(room.id))
  await new Promise(resolve => setTimeout(resolve, 30))
  const sessionId = wg.workgroupOf(room.id).sessions['bot-a']
  assert.ok(sessionId !== undefined)

  const tool = ctx.registeredTools.get('workgroup_read_own_chat')
  assert.ok(tool !== undefined, 'the tool the prompt promises really exists')
  // The Bot's own chat is read through the original chat index, which this domain shares.
  rt.latestOwnChat = async () => ['[part 1 #1 · 10-08 14:22] hello']
  const said = await tool.execute({}, { agent: { id: sessionId } })
  assert.match(said, /hello/, 'it reads the bot own chat')

  // The lookup is a line of the group log, and of the round, so the user sees it.
  const line = wg.workgroupOf(room.id).log.at(-1)
  assert.equal(line.kind, 'lookup', 'the group log records that it looked')
  assert.equal(line.who, 'Writer')
  const round = [...wg.roomProgress.values()].find(entry => entry.roomId === room.id)
  assert.ok(round.replies.some(reply => reply.kind === 'lookup' && reply.botId === 'bot-a'))

  await answer(sessionId, '看过了')
  await running
})

test('a session that is not in a workgroup cannot use read_own_chat', async (t) => {
  const { ctx, stop } = startRoundFixture()
  t.after(stop)
  const tool = ctx.registeredTools.get('workgroup_read_own_chat')
  const said = await tool.execute({}, { agent: { id: 'someone-else' } })
  assert.equal(said, 'Only members of a Workgroup can look at their own chat.')
})

// The original keeps a message typed during the LAST speaker's turn inside that round: its
// loop condition also checks the Session's waiting lines, so the message is drained at the
// loop head even after the slots ran out. The copy only checked `index < round.slots.length`,
// so such a message opened a second round instead and the group looked like it had stopped
// answering.
test('a message typed during the last speaker stays in the same round', async (t) => {
  const { ctx, wg, answer, beginRound, stop } = startRoundFixture()
  t.after(stop)
  // Two members (a group may not have one, the original's `checkMembers`), with Writer
  // named by @mention so it is the ONLY speaker — which is the state this test needs: the
  // message typed next arrives during the last speaker's turn.
  const room = await wg.createWorkgroup({ name: 'Inbox', members: twoMembers() })
  wg.registerSessionOwner('relay-session', { kind: 'workgroup', workgroupId: room.id })
  const running = beginRound(room, '@Writer 开始')
  t.after(() => wg.stopRound(room.id))
  await new Promise(resolve => setTimeout(resolve, 30))
  const sessionId = wg.workgroupOf(room.id).sessions['bot-a']
  assert.ok(sessionId !== undefined)

  // The user types while that speaker is still answering. This is the real path: the
  // group's own Session receives a user message, which the domain's listener queues.
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    await listener({ id: room.id }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '顺便问一句' }] } })
  }
  assert.equal(wg.roomInbox.get(room.id)?.length, 1, 'the message waits for the round it was typed in')

  await answer(sessionId, '第一句')
  // The round then calls the member again for the message the user typed, inside the same
  // round. Answer that second turn too, or the round waits for the reply timeout.
  await new Promise(resolve => setTimeout(resolve, 30))
  await answer(sessionId, '答你那句')
  const result = JSON.parse(await running)
  assert.ok(result.replies.some(reply => reply.kind === 'user' && reply.text === '顺便问一句'),
    'the message the user typed mid-round is part of this round, not a second one')
  assert.ok(result.replies.some(reply => reply.text === '答你那句'),
    'and the member answered it in the same round')
})

// A Bot that posts into a group with report_back gets the members' replies back as one
// message when the round ends, and the work chain it was handed on is closed. The copy
// dropped the whole block, so a poster never heard anything back.
test('a round posted with report_back reports back to the Bot that posted it', async (t) => {
  const { ctx, wg, answer, followups, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: 'ReportBack', members: twoMembers() })
  wg.registerSessionOwner('relay-session', { kind: 'workgroup', workgroupId: room.id })
  wg.roomInbox.set(room.id, [{ text: '做一下这个', who: 'Writer', botId: 'bot-a', name: 'Writer', reportBack: true }])
  const running = ctx.registeredTools.get('workgroup_relay')
    .execute({}, { agent: { id: 'relay-session' }, callId: 'call-rb', signal: new AbortController().signal })
  t.after(() => wg.stopRound(room.id))
  await new Promise(resolve => setTimeout(resolve, 30))

  // Writer posted it, so Writer never answers its own post; Editor does.
  const editorSession = wg.workgroupOf(room.id).sessions['bot-b']
  assert.ok(editorSession !== undefined, 'the other member was called')
  await answer(editorSession, '做完了')
  await new Promise(resolve => setTimeout(resolve, 40))
  await running

  // The report reached the poster's OWN chat, not the workgroup's Session.
  const report = followups.find(item => item.message?.source?.role === 'report')
  assert.ok(report !== undefined, 'the poster got a report')
  const said = String(report.message.content[0]?.text ?? '')
  assert.match(said, /ReportBack/, 'it names the workgroup')
  assert.match(said, /做完了/, 'and carries the answer')
  assert.match(said, /Editor/, 'and who said it')
})
// The sidebar's Pin, Mark as unread and Hide entries are offered on a workgroup row too
// (it is the same row component), and they call the ORIGINAL `set-flags` route, which
// knows only local Bots and rooms and answered "Unknown conversation" for a workgroup.
// This domain keeps those flags on its own record, so its own route must take them.
test('pin and hide are recorded on the workgroup through its own route', async (t) => {
  const { wg, rpc, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: 'Ops', members: twoMembers() })
  const pinned = await rpc('set-flags', { id: room.id, pinned: true })
  assert.equal(pinned.ok, true, 'the workgroup route accepts the flag')
  assert.equal(wg.workgroupOf(room.id).pinned, true, 'and it lands on this domain record')
  const hidden = await rpc('set-flags', { id: room.id, hidden: true })
  assert.equal(hidden.ok, true)
  assert.equal(wg.workgroupOf(room.id).hidden, true)
  // The list the sidebar reads carries them.
  const state = await rpc('state', {})
  const row = state.value.rooms.find(entry => entry.id === room.id)
  assert.equal(row.pinned, true, 'the row the sidebar draws says it is pinned')
  assert.equal(row.hidden, true)
  // An id this domain does not own is refused by the route that owns workgroups.
  const missing = await rpc('set-flags', { id: 'not-a-workgroup', pinned: true })
  assert.equal(missing.ok, false, 'an unknown id is refused, not silently accepted')
  assert.match(missing.error?.message ?? '', /Unknown workgroup/)
})

test('a workgroup opens the original group memory panel instead of "Unknown group chat"', async (t) => {
  const { wg, rt, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: 'MemoryProbe', members: twoMembers() })
  // The panel the sidebar opens asks the original memory module by room id. A workgroup
  // id is not in `state.rooms`, so before the room seam it answered "Unknown group chat"
  // and the panel stayed on "loading".
  const view = await rt.memoryEndpoint('memory-view', { roomId: room.id })
  assert.equal(view.roomId, room.id, 'the panel is about this workgroup')
  assert.equal(view.error, null, 'and it is not an error panel')
  assert.deepEqual(view.entries, [], 'an empty workgroup has no entries yet')
  assert.equal(view.summarizing, false)
  // The seam must not loosen the original: an id neither domain owns still refuses.
  await assert.rejects(
    () => rt.memoryEndpoint('memory-view', { roomId: 'not-a-room' }),
    /Unknown group chat/,
    'an unknown id is still refused by the original rule',
  )
})
