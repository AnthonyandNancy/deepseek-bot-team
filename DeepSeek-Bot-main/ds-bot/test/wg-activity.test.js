// G1: a member at work in a workgroup shows in the client exactly as it does in a local
// group — the mascot's "thinking" mark, the round's "{name} is typing…" line, and the
// activity capsule above the composer.
//
// The bug a screenshot exposed: a workgroup showed none of them. All three are computed
// from the client's ONE state poll (`activity[botId]`, `work.bots[botId]`,
// `work.rooms[roomId]`), and the original fills those from its own `live` map. Its
// listener drops every Session that is neither a Bot's own chat nor a local group's
// (`!rt.isBotSession(id) && !rt.roomOf(id)`, src/host/turns.js:352) — and a workgroup
// member Session is neither. The map was therefore always empty for this domain, so
// `workingIn`, the "still busy" check in `roomTurn`, and the merged views all found
// nothing. This domain now keeps its own `live` and merges its views into that one poll.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-wg-activity-'))
  const ctx = fakeContext()
  let seq = 0
  // Every message actually delivered into a Session. A round is only "running" once the
  // delivery has landed: before that, `roomTurn` has not yet read whether the member is
  // busy with earlier work, so a turn started too early makes the round end as `working`.
  const deliveries = []
  Object.assign(ctx, {
    llm: { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }] },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s-${++seq}` }),
      resolveAgent: async sessionId => ({
        agent: { session: { id: sessionId }, followup: (message) => { deliveries.push({ sessionId, message }) }, cancel: () => {} },
      }),
      selectModel: async () => {},
      prompt: async () => ({ accepted: true }),
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const routes = []
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes.push(options)
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  const call = async (path, endpoint, payload) => {
    const route = routes.filter(item => item.path === path).at(-1)
    const response = await route.fetch(new Request(`http://localhost${path}`, {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload: payload ?? null }),
    }))
    return response.json()
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, call, deliveries, stop }
}

const members = () => ([
  { id: 'bot-a', kind: 'localBot', name: 'Writer' },
  { id: 'bot-b', kind: 'localBot', name: 'Editor' },
])

// A member Session renders its Bot's identity from state.bots, so the Bots must exist —
// in the real app they always do.
function plantBots(rt) {
  for (const [id, name] of [['bot-a', 'Writer'], ['bot-b', 'Editor']]) {
    rt.state.bots[id] = { id, name, instructions: `${name} instructions`, createdAt: 1, capabilities: [] }
  }
}

async function ready() {
  const host = start()
  const { deliveries } = host
  plantBots(host.rt)
  const wg = host.rt.workgroup
  assert.ok(wg !== undefined, 'the Workgroup domain installed')
  const room = await wg.createWorkgroup({ name: 'ActivityProbe', members: members() })
  // The relay runs in a Session this domain owns.
  wg.registerSessionOwner('relay-session', { kind: 'workgroup', workgroupId: room.id })
  const emit = async (sessionId, event) => {
    for (const listener of host.ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  // Start a round and leave the admin's turn running, so "at work" can be observed.
  const begin = () => {
    wg.roomInbox.set(room.id, [{ text: '帮我写点东西', who: 'User' }])
    return host.ctx.registeredTools.get('workgroup_relay')
      .execute({}, { agent: { id: 'relay-session' }, callId: 'call-1', signal: new AbortController().signal })
  }
  // Wait for the round to have DELIVERED the turn, not merely to have created the Session:
  // `roomTurn` reads `live` for "still busy with earlier work" before the delivery, so a
  // turn started too early makes the round resolve as `working` and end at once. That is
  // the copied original behaviour, so the test has to sequence itself around it.
  // Poll rather than sleep a fixed time: under a loaded full-suite run neither the Session
  // nor the delivery is there within a few tens of milliseconds.
  const waitFor = async (check, why) => {
    for (let at = 0; at < 400; at += 1) {
      const value = check()
      if (value !== undefined) return value
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail(why)
  }
  const memberSession = async () => {
    const running = begin()
    const sessionId = await waitFor(() => wg.workgroupOf(room.id).sessions['bot-a'],
      'the admin got its own Session')
    await waitFor(() => (deliveries.some(item => item.sessionId === sessionId) ? true : undefined),
      'the round delivered the turn')
    return { running, sessionId }
  }
  return { ...host, wg, room, emit, memberSession }
}

// The one poll the client reads, as the original route answers it.
const poll = async (call) => (await call('/api/bot', 'state', {})).value

test('a member at work appears in the mascot and capsule views of the one state poll', async (t) => {
  const { call, wg, room, emit, memberSession, stop } = await ready()
  t.after(stop)
  const { running, sessionId } = await memberSession()

  await emit(sessionId, { type: 'turn/start', data: { turn: 1 }, time: Date.now() })
  await emit(sessionId, { type: 'tool/call', data: { callId: 'c1', name: 'shell', arguments: JSON.stringify({ description: 'Run the tests' }) } })

  const live = await poll(call)
  assert.equal(live.activity['bot-a'], 'working', 'the mascot is marked as working')
  const here = live.work.rooms[room.id] ?? []
  assert.equal(here.length, 1, 'the capsule lists the member at work in this group')
  assert.equal(here[0].botId, 'bot-a')
  assert.equal(here[0].tool, 'shell', 'and which tool it runs')
  assert.equal(here[0].note, 'Run the tests', 'and what the tool is for')
  assert.equal(here[0].speaking, true, 'the round marks the member that is speaking')
  assert.equal(live.work.bots['bot-a']?.roomId, room.id, "the Bot's own chat knows which group it is in")

  // The state answer on this domain's own route carries the same views.
  const wgState = (await call('/api/workgroup', 'state')).value
  assert.equal(wgState.activity['bot-a'], 'working')
  assert.equal((wgState.work.rooms[room.id] ?? []).length, 1)

  await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const after = await poll(call)
  assert.equal(after.activity['bot-a'], undefined, 'the mark goes when the turn ends')
  assert.deepEqual(after.work.rooms[room.id] ?? [], [], 'and the capsule empties')
  assert.equal(wg.live.get(sessionId)?.turn, undefined, 'the turn record is cleared')
  await wg.stopRound(room.id)
  await running
})

test('a workgroup round reports its current speaker, which the typing line needs', async (t) => {
  const { call, wg, room, memberSession, stop } = await ready()
  t.after(stop)
  const { running } = await memberSession()

  // `GroupReplies` polls this while a relay is in flight and draws "{name} is typing…"
  // from `speaking`. The client used to unwrap a `{ok, value}` envelope that
  // `callWorkgroup` had already unwrapped, so it always got `[]`.
  const inFlight = (await call('/api/workgroup', 'room-progress', { roomId: room.id })).value
  assert.equal(inFlight.length, 1, 'the running round is reported')
  assert.equal(inFlight[0].speaking, 'bot-a', 'with the member that is speaking now')

  await wg.stopRound(room.id)
  await running
  const after = (await call('/api/workgroup', 'room-progress', { roomId: room.id })).value
  assert.deepEqual(after, [], 'a finished round leaves nothing to poll')
})

test('the local domain never sees a workgroup member as its own work', async (t) => {
  const { rt, wg, room, emit, memberSession, stop } = await ready()
  t.after(stop)
  const { running, sessionId } = await memberSession()
  await emit(sessionId, { type: 'turn/start', data: { turn: 1 }, time: Date.now() })

  // The isolation rule (P0-3): this domain's Sessions are not in the original's indexes,
  // so the original's own views must stay empty. Merging happens at the answer, not by
  // registering a workgroup member as a local group's member.
  assert.equal(rt.isBotSession(sessionId), false, 'the member Session is not a local Bot Session')
  assert.equal(rt.roomOf(sessionId), undefined, 'and not a local group')
  assert.equal(rt.live.get(sessionId), undefined, "so the original's live map never held it")
  assert.equal(rt.activityView()[sessionId], undefined)
  await wg.stopRound(room.id)
  await running
})
