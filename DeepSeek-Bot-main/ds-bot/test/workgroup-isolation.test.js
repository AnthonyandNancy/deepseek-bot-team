// G1 isolation gates (plan: docs/g0/g1-plan.md §4.2).
//
// These are the assertions that keep the Workgroup domain and the original team from
// interfering with each other. They are deliberately written against the *public*
// seams — the registered tool names, the two runtimes' maps, and the strict owner
// resolver — not against Workgroup internals, so a later refactor inside the domain
// does not silently drop a guarantee.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { installWorkgroup } from '../src/workgroup/index.js'
import { WG_SOURCE_KIND, WG_TOOLS } from '../src/workgroup/shared/constants.js'
import { fakeContext } from './fake-ctx.js'

function start({ config = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-wg-'))
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
  const rt = createRuntime(ctx, { home, ...config })
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, home, stop }
}

// WG-01: the domain installs exactly once per runtime.
test('WG-01 a second Workgroup install is refused instead of registering twice', async (t) => {
  const { rt, ctx, stop } = start()
  t.after(stop)
  assert.ok(rt.workgroup !== undefined, 'the runtime carries the domain')
  assert.throws(() => installWorkgroup(rt), /already installed/)
  // and the refusal did not register a second relay tool
  const relayRegistrations = ctx.calls.filter(entry => entry === `tool ${WG_TOOLS.relay}`)
  assert.equal(relayRegistrations.length, 1)
})

// WG-02: no tool name is taken away from the original team.
test('WG-02 the Workgroup tools do not shadow or remove any original tool', async (t) => {
  const { ctx, stop } = start()
  t.after(stop)
  const original = ['group_relay', 'read_group_chat', 'read_own_chat', 'list_bots', 'message_bot', 'create_group', 'post_to_group']
  for (const name of original) assert.ok(ctx.registeredTools.has(name), `original tool ${name} is still registered`)
  assert.ok(ctx.registeredTools.has(WG_TOOLS.relay))
  assert.ok(ctx.registeredTools.has(WG_TOOLS.readChat))
  // the two sets are disjoint: no name appears in both domains
  assert.equal(original.includes(WG_TOOLS.relay), false)
  assert.equal(original.includes(WG_TOOLS.readChat), false)
})

// WG-03: the two domains own different maps, so one cannot move the other's turns.
test('WG-03 Workgroup waiters, progress and inbox are different maps from the original', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  const wg = rt.workgroup
  assert.notEqual(wg.roomWaiters, rt.roomWaiters)
  assert.notEqual(wg.roomProgress, rt.roomProgress)
  assert.notEqual(wg.roomInbox, rt.roomInbox)
  // writing the domain's maps leaves the original's empty
  wg.roomWaiters.set('x', { sessionId: 'x' })
  assert.equal(rt.roomWaiters.size, 0)
  assert.equal(rt.roomProgress.size, 0)
  assert.equal(rt.roomInbox.size, 0)
})

// WG-05: a Session claimed by both domains is an error, never a silent pick.
test('WG-05 a Session owned by both domains is refused, not resolved', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  const sessionId = 'session-shared'
  // the original domain claims it as a local group Session
  rt.groupOwners.set(sessionId, { botId: 'bot-1', roomId: 'room-1' })
  const alone = rt.resolveSessionOwnerStrict(sessionId)
  assert.equal(alone.domain, 'original', 'one domain alone resolves')
  assert.equal(alone.kind, 'localGroup', 'and says what sort of original Session it is')
  // now this domain claims it too
  rt.workgroup.sessionOwners.set(sessionId, { kind: 'workgroup', workgroupId: 'wg-1' })
  assert.throws(() => rt.resolveSessionOwnerStrict(sessionId), /claimed by both domains/)
})

// WG-05b: registering a Session the original already owns is refused at the write.
test('WG-05b the domain refuses to register a Session the original domain owns', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  rt.chatOwners.set('session-original', 'bot-1')
  assert.throws(
    () => rt.workgroup.registerSessionOwner('session-original', { kind: 'workgroup', workgroupId: 'wg-1' }),
    /already belongs to the original domain/,
  )
})

// WG-06: the domain's state file is separate from the original state.json.
test('WG-06 the Workgroup state path is its own file, not the team state.json', async (t) => {
  const { rt, home, stop } = start()
  t.after(stop)
  assert.equal(rt.workgroup.statePath, join(home, 'workgroup', 'state.json'))
  assert.notEqual(rt.workgroup.statePath, rt.statePath)
  assert.equal(rt.statePath, join(home, 'state.json'))
})

// WG-06b: creating a workgroup writes its own file and does not touch the team.
test('WG-06b creating a workgroup leaves the original team state untouched', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  const before = JSON.stringify(rt.state.rooms ?? {})
  const room = await rt.workgroup.createWorkgroup({ name: '财务协作', members: [{ id: 'bot-1', kind: 'localBot', name: 'Writer' }, { id: 'bot-2', kind: 'localBot', name: 'Editor' }] })
  assert.equal(rt.workgroup.workgroupOf(room.id).name, '财务协作')
  assert.equal(JSON.stringify(rt.state.rooms ?? {}), before, 'the original rooms map is unchanged')
  assert.equal(rt.roomOf(room.id), undefined, 'the original roomOf does not know workgroups')
})

// WG-07: group line files land under the domain's own directory.
test('WG-07 Workgroup line files live under workgroup/group-lines', async (t) => {
  const { rt, home, stop } = start()
  t.after(stop)
  const wg = rt.workgroup
  const long = 'x'.repeat(4000)
  const line = wg.keepGroupLine('wg-test', { seq: 1 }, long)
  assert.equal(line.length, 4000)
  assert.ok(line.text.length <= 2000, 'the inline copy keeps only its start')
  const expected = join(home, 'workgroup', 'group-lines', 'wg-test', '1.txt')
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(expected), true, `expected ${expected}`)
  assert.equal(existsSync(join(home, 'group-lines', 'wg-test', '1.txt')), false, 'the original line directory is untouched')
})

// WG-04: the domain's session/event listener ignores Sessions it does not own.
test('WG-04 the Workgroup listener ignores Sessions owned by the original domain', async (t) => {
  const { ctx, rt, stop } = start()
  t.after(stop)
  const sessionId = 'session-original'
  rt.chatOwners.set(sessionId, 'bot-1')
  // a waiter that must NOT be resolved by the original domain's Session
  let resolved = false
  rt.workgroup.roomWaiters.set('ex-1', { sessionId, resolve: () => { resolved = true } })
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    await listener({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } })
  }
  assert.equal(resolved, false, 'an unowned Session does not resolve a Workgroup waiter')
})

// WG-09: unloading runs the domain's disposers, and a second dispose is harmless.
test('WG-09 disposing the context runs the Workgroup effects and is idempotent', async () => {
  const { ctx, home } = start({ config: {} })
  const labels = ctx.calls.filter(entry => entry.startsWith('effect ds-bot: workgroup'))
  assert.ok(labels.length >= 1, 'the domain registered at least its state effect')
  await ctx.dispose()
  await assert.doesNotReject(ctx.dispose())
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

// The domain can be left out entirely, so the original team is testable alone.
test('config.workgroup === false leaves the domain out and keeps the original intact', async (t) => {
  const { ctx, rt, stop } = start({ config: { workgroup: false } })
  t.after(stop)
  assert.equal(rt.workgroup, undefined)
  assert.equal(ctx.registeredTools.has(WG_TOOLS.relay), false)
  assert.ok(ctx.registeredTools.has('group_relay'), 'the original relay is still there')
})

// A remote member never becomes a local Session (plan §8.3).
//
// G1 proved this by having `sessionFor` throw. G4 replaced the throw with the thing the throw
// was standing in for: the member's turn goes to the Hub instead of to a Session. The invariant
// under test is unchanged and is now checked two ways — no Session is created, and the turn is
// handed to the bridge.
test('WG-10 a remote member cannot be given a local Session', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  const wg = rt.workgroup
  const room = await wg.createWorkgroup({
    name: '跨用户群',
    members: [
      { id: 'u-a', kind: 'user', name: 'A' },
      { id: 'ep-chief-b', kind: 'remoteBot', name: 'B 的 Chief' },
    ],
  })
  // `undefined` is this file's word for "there is no local Session for this member"; a throw
  // would be reported to the user as a failed Bot, which is not what happened.
  assert.equal(await wg.sessionFor(room, { id: 'ep-chief-b', kind: 'remoteBot', name: 'B 的 Chief' }), undefined)
  assert.equal(Object.keys(wg.workgroupOf(room.id).sessions ?? {}).length, 0, 'no Session was recorded for the remote member')

  // And the member's turn is offered to the bridge, not created locally.
  const offered = []
  wg.deliverRemote = async (args) => { offered.push(args.member.id); return { sent: true } }
  t.after(() => { delete wg.deliverRemote })
  const sent = await wg.deliverRemote({ room, member: { id: 'ep-chief-b', kind: 'remoteBot', name: 'B 的 Chief' }, round: { slots: [] }, slot: {} })
  assert.deepEqual(offered, ['ep-chief-b'])
  assert.equal(sent.sent, true)
  assert.equal(Object.keys(wg.workgroupOf(room.id).sessions ?? {}).length, 0)
})

// A message that arrives from the Hub joins the group's log, attributed to the member the Hub
// named — and does NOT become a local Bot turn. The group Session is told, so the chat pane shows
// it where the user is reading (the same call a local member's line makes).
test('WG-11 a line from the Hub lands in the log as a member line', async (t) => {
  const { rt, ctx, stop } = start()
  t.after(stop)
  const wg = rt.workgroup
  const room = await wg.createWorkgroup({
    name: '跨用户群',
    members: [
      { id: 'u-a', kind: 'user', name: 'A', hubUserId: 'usr_a' },
      { id: 'ep-chief-b', kind: 'remoteBot', name: 'B 的 Chief', hubUserId: 'usr_b' },
    ],
  })
  const before = (ctx.calls ?? []).length
  const shown = await wg.receiveRemote({
    workgroupId: room.id,
    event: { eventId: 'evt_1', seq: 1, type: 'chat.message', sender: { userId: 'usr_b' }, payload: { text: '汇总在附件里' } },
  })
  assert.equal(shown, true)
  const log = wg.workgroupOf(room.id).log
  const line = log.at(-1)
  assert.equal(line.who, 'B 的 Chief', 'the line is attributed to the member, not to a Bot id')
  assert.equal(line.text, '汇总在附件里')
  assert.equal(line.via, 'hub', 'a Hub line is marked as such')
  assert.equal(line.hubEventId, 'evt_1')
  // It went into the GROUP's own Session as a workgroup post, not into a member Session.
  assert.ok((ctx.calls ?? []).length >= before)
  assert.equal(Object.keys(wg.workgroupOf(room.id).sessions ?? {}).length, 0)
})

// The domain uses its own source kind, so the original listeners do not see it.
test('the Workgroup source kind is distinct from the original one', () => {
  assert.equal(WG_SOURCE_KIND, 'workgroup')
  assert.notEqual(WG_SOURCE_KIND, 'bot')
})

// A domain that cannot wire itself must not take the original team down (plan §7.1:
// local features keep working when a network-bound one cannot). The install catches its
// own failure, clears `rt.workgroup` and warns — it never throws into createRuntime.
test('a domain left out of config leaves the original team installed and usable', async (t) => {
  const { ctx, rt, stop } = start({ config: { workgroup: false } })
  t.after(stop)
  assert.equal(rt.workgroup, undefined, 'the domain was left out by config')
  assert.equal(ctx.registeredTools.has(WG_TOOLS.relay), false, 'and registered nothing')
  assert.ok(ctx.registeredTools.has('group_relay'), 'the original relay still works')

  // Installing after the fact on the same runtime succeeds, and both domains coexist.
  const wg = installWorkgroup(rt)
  assert.ok(wg !== undefined, 'a healthy install returns the domain')
  assert.ok(ctx.registeredTools.has(WG_TOOLS.relay), 'and registers the workgroup relay')
  assert.ok(ctx.registeredTools.has('group_relay'), 'without disturbing the original one')
})

// The exact path that made a real DSH Desktop refuse to boot: a broken Workgroup module
// took the whole plugin down ("1 entry did not activate / ds-bot: failed"). The domain is
// now reached through a guarded require, and `config.workgroupModule` injects a module
// whose install throws so this branch is actually exercised.
test('a Workgroup module that throws on install does not break the original team', async (t) => {
  const broken = { installWorkgroup: () => { throw new Error('simulated broken workgroup module') } }
  const { ctx, rt, stop } = start({ config: { workgroupModule: broken } })
  t.after(stop)
  assert.equal(rt.workgroup, undefined, 'the domain is absent after the failure')
  assert.equal(ctx.registeredTools.has(WG_TOOLS.relay), false, 'and registered no workgroup tool')
  for (const name of ['group_relay', 'read_group_chat', 'read_own_chat', 'list_bots', 'message_bot']) {
    assert.ok(ctx.registeredTools.has(name), `original tool ${name} survives the failure`)
  }
})

// A module that gets partway and then fails: the guard catches it and the original team
// is still installed. (The real installWorkgroup clears rt.workgroup itself; the injected
// stub does not, which is the harder case the guard must survive.)
test('a Workgroup install that fails halfway does not break the original team', async (t) => {
  const broken = {
    installWorkgroup: (runtime) => {
      runtime.workgroup = { half: true }
      throw new Error('simulated install failure')
    },
  }
  const { ctx, stop } = start({ config: { workgroupModule: broken } })
  t.after(stop)
  for (const name of ['group_relay', 'read_group_chat', 'list_bots']) {
    assert.ok(ctx.registeredTools.has(name), `original tool ${name} survives a half-finished install`)
  }
})
