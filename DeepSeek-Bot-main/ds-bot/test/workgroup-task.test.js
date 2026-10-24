// Cross-user tasks on B's machine: gates 1, 2, 3 and N1, driven through the product path.
//
// Every test here talks to the Workgroup domain the way the UI does — `wg.apiHandle(endpoint,
// payload)` — and to a real Hub over a real socket. Nothing calls `bridge.start()` or the task runner
// directly, because that is exactly the mistake G4's fourth round found: fifteen tests that started
// an internal component themselves went green while the product never started it.
//
// What these tests are evidence FOR:
//   * gate 1 — a request creates an approval card and nothing else; a rejection runs nothing; the
//     Hub never sees `task.started`;
//   * gate 2 — the approved run reaches the real Bot's own Session, with the guard installed;
//   * gate 3 — the decision is recorded on B's device;
//   * N1 — a revoked task refuses the next tool call.
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
  rooms: {},
  agents: {}, capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, works: {}, questions: {},
  views: {}, prefs: {}, switching: {}, revision: 0,
}

// A Hub and one domain, on temp directories. The domain is signed in as `phone`, so its device and
// its sockets are real.
async function withHub(t) {
  const { createHub } = await import('../../../hub/src/server.js')
  const { createMemoryLogger } = await import('../../../hub/src/log.js')
  const dataDir = mkdtempSync(join(tmpdir(), 'ds-bot-g5-hub-'))
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
  const post = async (path, body, token) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let parsed
    try { parsed = text.length === 0 ? undefined : JSON.parse(text) } catch { parsed = text }
    return { status: response.status, body: parsed }
  }
  return { hub, baseUrl, post }
}

async function withDomain(t, { baseUrl, phone }) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-g5-home-'))
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
      // Recorded so a test can prove the Bot was actually ASKED to do something. An empty
      // `followup` is how a task reached RUNNING with the model never told about it.
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => { ctx.__delivered ??= []; ctx.__delivered.push({ sessionId, message }) } } }),
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
  const call = (endpoint, payload) => wg.apiHandle(endpoint, payload)
  // Signed in through the CHANNEL, not `wg.hub.authenticate` directly. That distinction is the whole
  // G4 lesson: the channel is what starts the bridge after a login, so a test that signs in below it
  // would leave this machine with no socket and then prove nothing about the product.
  const registered = await call('hub-register', { baseUrl, phone, password: PASSWORD })
  assert.equal(registered.ok, true, JSON.stringify(registered))
  assert.equal(registered.value.bridge?.connected, true, 'the product path must leave a live socket')
  return { rt, wg, ctx, call, root }
}

const settled = (ms = 500) => new Promise(resolve => setTimeout(resolve, ms))

// Two machines in one group: A asks, B answers. Both are real domains with their own device and
// socket, and neither starts a component itself.
async function twoMachines(t) {
  const { hub, baseUrl, post } = await withHub(t)
  const a = await withDomain(t, { baseUrl, phone: '+8613800138000' })
  const b = await withDomain(t, { baseUrl, phone: '+8613900139000' })

  // A creates the group and invites B, all through the product endpoints.
  const created = await a.call('bridge-create-group', { name: '费用汇总' })
  assert.equal(created.ok, true, JSON.stringify(created))
  const workgroupId = created.value.workgroupId
  const invited = await a.call('invite-member', { workgroupId, phone: '+8613900139000' })
  assert.equal(invited.ok, true, JSON.stringify(invited))
  const invites = await b.call('group-invites')
  const invite = invites.value.incoming.find(entry => entry.workgroupId === workgroupId)
  assert.ok(invite !== undefined, 'B must see the invite')
  const accepted = await b.call('answer-invite', { inviteId: invite.inviteId, accept: true })
  assert.equal(accepted.ok, true, JSON.stringify(accepted))
  await settled()

  // `root` is the temp directory the test may put real folders in (the folder check resolves real
  // paths, so it needs real directories rather than made-up ones).
  return { hub, baseUrl, post, a, b, workgroupId, root: a.root }
}

// A requests B's Chief. Returns the taskId as the Hub recorded it.
async function askFor(t, { a, b, workgroupId, title = '把上个月的报销汇总一下' }) {
  const members = await a.call('group-members', { workgroupId })
  const bob = members.value.members.find(member => member.userId === b.wg.hub.account.hubUserId)
  assert.ok(bob !== undefined, 'B must be in the roster')

  const asked = await a.call('task-request', { workgroupId, targetUserId: bob.userId, title })
  assert.equal(asked.ok, true, JSON.stringify(asked))
  await settled()
  return { taskId: asked.value.taskId, targetUserId: bob.userId }
}

test('a request becomes an approval card and nothing else runs', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)

  // Gate 1's first half: B has a card.
  const cards = await scene.b.call('task-requests')
  assert.equal(cards.ok, true, JSON.stringify(cards))
  const card = cards.value.requests.find(entry => entry.taskId === taskId)
  assert.ok(card !== undefined, `B must see the request; saw ${JSON.stringify(cards.value.requests)}`)
  assert.equal(card.state, 'PENDING_APPROVAL')
  assert.equal(card.title, '把上个月的报销汇总一下')

  // Gate 1's second half: no local task, no Session, no ledger entry.
  assert.equal(scene.b.wg.taskOf(taskId), undefined, 'nothing may be registered before a decision')
  assert.equal(scene.b.wg.liveTask(taskId), undefined)
  assert.equal(scene.b.wg.sessionOwners.has(taskId), false)

  // And the Hub has no `task.started` for it: the timeline cannot show work that did not happen.
  const events = await scene.a.wg.hub.events({ workgroupId: scene.workgroupId })
  assert.equal(events.events.some(event => event.type === 'task.started'), false)
  assert.equal(events.events.some(event => event.type === 'task.request'), true)
})

test('a rejection ends the task, and nothing runs on B machine', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)

  const decided = await scene.b.call('task-decide', { taskId, decision: 'rejected' })
  assert.equal(decided.ok, true, JSON.stringify(decided))
  await settled()

  // Every local path is empty: no task record, no Session owner, no run.
  assert.equal(scene.b.wg.taskOf(taskId), undefined)
  // Starting it is refused, so a UI that offered "run" after a refusal cannot do anything.
  const started = await scene.b.call('task-start', { taskId })
  assert.equal(started.ok, false)
  // The runner's own refusal, which is the same check the guard makes: the ledger has no live entry.
  assert.equal(started.error.code, 'task/not-approved')

  // The Hub's record is REJECTED and nothing started there either.
  const remote = await scene.b.call('task-state', { taskId })
  assert.equal(remote.value.remote.state, 'REJECTED')
  const events = await scene.a.wg.hub.events({ workgroupId: scene.workgroupId })
  assert.equal(events.events.some(event => event.type === 'task.started'), false)
  assert.equal(events.events.some(event => event.type === 'task.completed'), false)
})

test('approving registers a real Bot locally, on B own device, and the Hub records both', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)

  const decided = await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b' })
  assert.equal(decided.ok, true, JSON.stringify(decided))
  await settled()

  // The local ledger holds the binding: a Task Session, the real Bot, B's own Hub user and device.
  const record = scene.b.wg.taskOf(taskId)
  assert.ok(record !== undefined, 'the approval must produce a local grant')
  assert.equal(record.botId, 'b')
  assert.equal(record.hubUserId, scene.b.wg.hub.account.hubUserId)
  assert.equal(record.deviceId, scene.b.wg.hub.account.deviceId)
  assert.equal(record.state, 'APPROVED')
  // The Session it names is claimed as a task Session, so the guard can find it.
  assert.equal(scene.b.wg.sessionOwners.get(record.sessionId)?.kind, 'task')
  // The Bot that will run is B's, not A's: `rt.botOf` reads this machine's roster.
  assert.equal(scene.b.rt.botOf(record.botId)?.name, 'Writer')

  // The Hub has the grant, on B's device.
  const remote = await scene.b.call('task-state', { taskId })
  assert.equal(remote.value.remote.state, 'APPROVED')
  const approval = remote.value.remote.approvals.find(entry => entry.decision === 'granted')
  assert.ok(approval !== undefined)
  assert.equal(approval.approvedBy, scene.b.wg.hub.account.hubUserId)
  assert.equal(approval.approvedDeviceId, scene.b.wg.hub.account.deviceId)
  assert.notEqual(approval.approvedDeviceId, scene.a.wg.hub.account.deviceId, "B's device, never A's")
})

test('the three assignment modes each name the Bot that ran', async (t) => {
  for (const mode of ['existingBot', 'chiefPicks', 'newBot']) {
    const scene = await twoMachines(t)
    const { taskId } = await askFor(t, scene, { title: `mode ${mode}` })
    const decided = await scene.b.call('task-decide', { taskId, decision: 'granted', mode, botId: 'b' })
    assert.equal(decided.ok, true, `${mode}: ${JSON.stringify(decided)}`)
    const record = scene.b.wg.taskOf(taskId)
    assert.ok(record !== undefined, `${mode} must register a task`)
    // Every mode ends in a real Bot of this machine — not a prompt, not A's Bot.
    assert.ok(scene.b.rt.botOf(record.botId) !== undefined, `${mode} must name a Bot this machine has`)
    assert.equal(record.botId !== 'a' || mode === 'chiefPicks', true, `${mode} must not silently pick the Chief`)
    await settled(150)
  }
})

test('an approved task starts, reports to the Hub, and the Hub shows it running', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)
  await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b' })
  await settled()

  const started = await scene.b.call('task-start', { taskId })
  assert.equal(started.ok, true, JSON.stringify(started))
  await settled()

  const local = scene.b.wg.taskOf(taskId)
  assert.equal(local.state, 'RUNNING')
  const remote = await scene.b.call('task-state', { taskId })
  assert.equal(remote.value.remote.state, 'RUNNING')

  // Gate 2's Hub-side half: the group's timeline says the work started, on B's device.
  const events = await scene.a.wg.hub.events({ workgroupId: scene.workgroupId })
  const startedEvent = events.events.find(event => event.type === 'task.started')
  assert.ok(startedEvent !== undefined, 'the timeline must show the task started')
  assert.equal(startedEvent.sender.userId, scene.b.wg.hub.account.hubUserId)
})

test('revoking stops the next tool call, which is gate N1', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)
  await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b' })
  await settled()
  await scene.b.call('task-start', { taskId })
  await settled()

  const record = scene.b.wg.taskOf(taskId)
  const cancelled = await scene.b.call('task-cancel', { taskId, reason: 'stop' })
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
  assert.notEqual(scene.b.wg.taskOf(taskId).state, 'RUNNING')
  // `liveTask` is what the guard consults, so this is the same question the guard asks.
  assert.equal(scene.b.wg.liveTask(taskId), undefined, 'a cancelled task is not live')

  // The real check: the guard refuses a tool call in that Session. Reaching the guard the way DSH
  // does is the only way to prove the boundary rather than the bookkeeping.
  const refusal = runGuard(scene.b, { sessionId: record.sessionId, name: 'write_file' })
  assert.equal(typeof refusal, 'string', `the guard must refuse; got ${String(refusal)}`)
  assert.match(refusal, /no longer authorized/)
})

// The guards this domain registered, exercised through the same context DSH calls them on.
//
// `fakeContext` records every `ctx.tools.guard(...)` in registration order — the original team's own
// guards are in there too — and the first refusal wins, which is how DSH itself resolves them.
function runGuard(machine, { sessionId, name }) {
  for (const guard of machine.ctx.guards) {
    const answer = guard({ name, agent: { session: { id: sessionId } } })
    if (answer !== undefined) return answer
  }
  return undefined
}

test('a live task may use a tool its approval covered, and not one it did not', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)
  // A scope that names exactly one tool.
  const decided = await scene.b.call('task-decide', {
    taskId, decision: 'granted', mode: 'existingBot', botId: 'b', capabilities: ['read_file'],
  })
  assert.equal(decided.ok, true, JSON.stringify(decided))
  await scene.b.call('task-start', { taskId })
  await settled()
  const record = scene.b.wg.taskOf(taskId)

  assert.equal(runGuard(scene.b, { sessionId: record.sessionId, name: 'read_file' }), undefined, 'an approved tool runs')
  assert.match(String(runGuard(scene.b, { sessionId: record.sessionId, name: 'write_file' })), /not part of what was approved/)
})

test('a task may never use the tools that would reach past its scope', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)
  await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b' })
  await scene.b.call('task-start', { taskId })
  await settled()
  const record = scene.b.wg.taskOf(taskId)

  // Plan §10.4: the original team's own chat, Bot-to-Bot dispatch and Bot management are all ways
  // out of a delegated task's scope, so they are refused whatever the group's preset allows.
  for (const name of ['read_own_chat', 'message_bot', 'create_bot', 'update_bot', 'delete_bot']) {
    const answer = runGuard(scene.b, { sessionId: record.sessionId, name })
    assert.equal(typeof answer, 'string', `${name} must be refused`)
    assert.match(answer, /not available to a delegated task/)
  }
})

test('an expired grant stops a run rather than letting it continue', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)
  await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b' })
  await settled()
  await scene.b.call('task-start', { taskId })
  await settled()
  const record = scene.b.wg.taskOf(taskId)
  assert.equal(scene.b.wg.liveTask(taskId) !== undefined, true)

  // The authorization lapses. `liveTask` treats expiry as "not usable" without rewriting the record,
  // so the history stays intact and the guard refuses at the next call.
  scene.b.wg.state.tasks[taskId].expiresAt = Date.now() - 1000
  assert.equal(scene.b.wg.liveTask(taskId), undefined)
  assert.equal(typeof runGuard(scene.b, { sessionId: record.sessionId, name: 'read_file' }), 'string')
})

test('a task Session is not confused with a local group or a Bot chat', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)
  await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b' })
  const record = scene.b.wg.taskOf(taskId)

  // A Session with no task owner is not this guard's business: the original team must behave
  // exactly as it did before G5, down to a tool a task would refuse.
  assert.equal(runGuard(scene.b, { sessionId: 'not-a-task-session', name: 'read_own_chat' }), undefined)
  assert.equal(runGuard(scene.b, { sessionId: 'not-a-task-session', name: 'write_file' }), undefined)
  // A task Session IS one, even before it starts: the denied tools are refused the moment an
  // approval exists, so a finished approval cannot be used to reach past its scope.
  assert.match(String(runGuard(scene.b, { sessionId: record.sessionId, name: 'read_own_chat' })), /not available to a delegated task/)
})

test('the progress report is merged, so a chatty run cannot flood the log', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)
  await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b' })
  await settled()
  await scene.b.call('task-start', { taskId })
  await settled()

  // Driven the way the product drives it: the task Session's own tool calls, emitted by DSH. There is
  // no `task-progress` endpoint any more precisely so this is the only way in — a second door would
  // have let a caller report progress for work that never happened.
  const record = scene.b.wg.taskOf(taskId)
  const emit = name => scene.b.ctx.emitBoth('session/event', { id: record.sessionId }, { type: 'tool/call', data: { name } })
  for (const tool of ['read_file', 'read_file', 'read_file', 'read_file', 'read_file']) emit(tool)
  await settled()

  const events = await scene.a.wg.hub.events({ workgroupId: scene.workgroupId })
  const progress = events.events.filter(event => event.type === 'task.progress')
  assert.equal(progress.length, 1, `five tool calls inside the window make one event, not five; saw ${progress.length}`)
  // And the one event names the tool, so a reader learns something from it.
  assert.equal(progress[0].payload.note, 'read_file')
})

test('a completed task reports its result, and the request is answerable end to end', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)
  await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b' })
  await settled()
  await scene.b.call('task-start', { taskId })
  await settled()

  const finished = await scene.b.call('task-finish', { taskId, summary: '汇总好了' })
  assert.equal(finished.ok, true, JSON.stringify(finished))
  await settled()

  assert.equal(scene.b.wg.taskOf(taskId).state, 'COMPLETED')
  const remote = await scene.b.call('task-state', { taskId })
  assert.equal(remote.value.remote.state, 'COMPLETED')
  // A can read the same record: they asked for it, so they may see what came of it.
  const asRequester = await scene.a.call('task-state', { taskId })
  assert.equal(asRequester.ok, true, JSON.stringify(asRequester))
  assert.equal(asRequester.value.remote.state, 'COMPLETED')

  const events = await scene.a.wg.hub.events({ workgroupId: scene.workgroupId })
  assert.ok(events.events.some(event => event.type === 'task.completed'))
})

test('a task cannot be started before it is approved, whatever the endpoint is asked', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)

  // The card exists, so the id is known; starting must still be refused.
  const started = await scene.b.call('task-start', { taskId })
  assert.equal(started.ok, false)
  assert.equal(scene.b.wg.taskOf(taskId), undefined, 'a refused start leaves no record')
  const events = await scene.a.wg.hub.events({ workgroupId: scene.workgroupId })
  assert.equal(events.events.some(event => event.type === 'task.started'), false)
})

test('the request the panel sends is signed and reaches the other machine', async (t) => {
  const scene = await twoMachines(t)
  const members = await scene.a.call('group-members', { workgroupId: scene.workgroupId })
  const bob = members.value.members.find(member => member.userId === scene.b.wg.hub.account.hubUserId)

  const asked = await scene.a.call('task-request', {
    workgroupId: scene.workgroupId, targetUserId: bob.userId, title: 'signed request', resources: ['resource:ledger'],
  })
  assert.equal(asked.ok, true, JSON.stringify(asked))
  // The envelope the plugin built carries a signature and a payload hash, which is what the Hub
  // verified to accept it at all.
  assert.equal(typeof asked.value.envelope.eventId, 'string')
  assert.equal(typeof asked.value.envelope.expiresAt, 'string')
  await settled()

  const cards = await scene.b.call('task-requests')
  const card = cards.value.requests.find(entry => entry.taskId === asked.value.taskId)
  assert.ok(card !== undefined, 'the signed request must arrive as a card')
  assert.equal(card.title, 'signed request')
  assert.deepEqual(card.resources, ['resource:ledger'])
})

// ── T17: a started run is an idempotent side effect ───────────────────────────────
// A caller may retry `task-start` after a lost answer, or the same request may be replayed on
// reconnect. The Bot must not be asked twice, and a restart must not quietly run a new turn.

test('starting the same approved task twice delivers it once', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene, { title: '只执行一次的汇总' })
  await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b' })
  await settled()
  scene.b.ctx.__delivered = []

  await scene.b.wg.runTask({ taskId })
  const first = scene.b.wg.taskOf(taskId)
  assert.equal(scene.b.ctx.__delivered.length, 1)
  await scene.b.wg.runTask({ taskId })
  assert.equal(scene.b.ctx.__delivered.length, 1, 'the second start must not prompt the Bot again')
  assert.equal(scene.b.wg.taskOf(taskId).state, 'RUNNING')
  assert.equal(scene.b.wg.taskOf(taskId).runId, first.runId, 'and it is the same run')
})

test('a restart while RUNNING marks the task interrupted and never replays it', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene, { title: '重启中断的任务' })
  await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b' })
  await settled()
  await scene.b.wg.runTask({ taskId })
  const record = scene.b.wg.taskOf(taskId)
  assert.equal(record.state, 'RUNNING')
  const runId = record.runId
  assert.equal(typeof runId, 'string')
  const deliveries = scene.b.ctx.__delivered.length

  // Simulate the next process reading the SAME durable record. `indexTasks` is the product's
  // rebuild hook, called by `state.load`; no test-only code may manufacture the state change.
  scene.b.wg.indexTasks()
  assert.equal(scene.b.wg.taskOf(taskId).state, 'INTERRUPTED')
  assert.equal(scene.b.wg.taskOf(taskId).runId, runId, 'the interrupted run keeps its identity')
  assert.equal(scene.b.ctx.__delivered.length, deliveries, 'no new prompt is sent by indexing')

  // An explicit new start is allowed, but it is a NEW run: it must not reuse the interrupted run's
  // delivery marker, and it must prompt the Bot itself. Merely indexing after a restart sends nothing.
  await scene.b.wg.runTask({ taskId })
  const resumed = scene.b.wg.taskOf(taskId)
  assert.equal(resumed.state, 'RUNNING')
  assert.ok(resumed.runId !== undefined && resumed.runId !== runId, 'an explicit start opens a new run')
  assert.equal(scene.b.ctx.__delivered.length, deliveries + 1, 'the new run is prompted exactly once')
  await scene.b.wg.runTask({ taskId })
  assert.equal(scene.b.ctx.__delivered.length, deliveries + 1, 'and a replay of the new run is not delivered again')
})

// ── T14: the folder a task was approved for ──────────────────────────────────────
// `checkInsideRoot` is the one place that answers "may this run here", and the plan's requirement is
// specific: refuse and do NOT fall back to the team folder (§15 T14: "拒绝且不回退到团队目录").
// It is tested directly because a Session with a real cwd needs a real model turn; these pin the
// rule itself, and `verifyBeforeRun` is where it is applied.
test('a task path outside the approved folder is refused, never redirected', async () => {
  const { checkInsideRoot } = await import('../src/workgroup/host/task-runner.js')
  // Built with `join`, the same helper the runner compares with, so the separator is the
  // platform's own and this test does not depend on a hand-written backslash.
  const root = join(process.platform === 'win32' ? 'C:' + String.fromCharCode(92) : '/', 'approved', 'work')

  // Inside: allowed, including a nested path.
  assert.equal(checkInsideRoot(root, root).ok, true)
  assert.equal(checkInsideRoot(join(root, 'reports'), root).ok, true)

  // Outside by `..`: refused with a sentence, and the refusal never names a replacement folder.
  const up = checkInsideRoot(join(root, '..', 'elsewhere'), root)
  assert.equal(up.ok, false)
  assert.equal(up.code, 'task/bad-workspace')
  assert.match(up.detail, /outside the folder this task was approved for/)
  assert.equal(/team|workspace|fallback/i.test(up.detail), false, 'it must not suggest a fallback')

  // An absolute path somewhere else entirely.
  const elsewhere = join(process.platform === 'win32' ? 'D:' + String.fromCharCode(92) : '/', 'somewhere')
  assert.equal(checkInsideRoot(elsewhere, root).ok, false)

  // A sibling whose name merely STARTS with the root's name is outside, which is the case a naive
  // string prefix check gets wrong.
  assert.equal(checkInsideRoot(`${root}-other`, root).ok, false)
})

// ── 单协调者围栏（§9.5）────────────────────────────────────────────────────────
// The lease has to be acquired by the product, not only offered by an endpoint: a fence nobody asks
// about is not a fence. These drive it through the bridge the round uses.
test('a group lease is acquired through the product path, and a second machine is refused', async (t) => {
  const scene = await twoMachines(t)
  const first = await scene.a.wg.bridge.acquireLease({ workgroupId: scene.workgroupId })
  assert.equal(typeof first.lease.epoch, 'number')
  assert.equal(first.lease.epoch, 1)
  assert.equal(first.lease.holderDeviceId, scene.a.wg.hub.account.deviceId)

  // B's machine asks for the same group. A round on B must not run in parallel, and the refusal says
  // who holds it rather than failing silently.
  await assert.rejects(
    () => scene.b.wg.bridge.acquireLease({ workgroupId: scene.workgroupId }),
    error => {
      assert.equal(error.code, 'lease/held')
      assert.match(error.message, /holds the lease until/)
      return true
    },
  )
})

test('releasing the lease lets the other machine take it, and the epoch still moves forward', async (t) => {
  const scene = await twoMachines(t)
  const first = await scene.a.wg.bridge.acquireLease({ workgroupId: scene.workgroupId })
  await scene.a.wg.bridge.releaseLease({ workgroupId: scene.workgroupId })
  // The bridge's release is fire-and-forget (a round must not hang on it), so the next acquire is what
  // observes the effect. Waiting for the round trip keeps the assertion honest.
  await settled(200)
  const taken = await scene.b.wg.bridge.acquireLease({ workgroupId: scene.workgroupId })
  assert.equal(taken.lease.epoch, first.lease.epoch + 1, 'a handover takes a new epoch, so a stale round is fenced')
  assert.equal(taken.lease.holderDeviceId, scene.b.wg.hub.account.deviceId)
})

test('the coordinator fence is part of the round, not only an endpoint', async () => {
  // A fence nobody asks about is not a fence. The round asks before it starts and releases after,
  // and a local group (no Hub) is untouched.
  const groupsSrc = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/workgroup/host/groups.js', import.meta.url), 'utf8'))
  assert.match(groupsSrc, /const fencing = await holdLeaseFor\(room\)/)
  assert.match(groupsSrc, /if \(fencing\.held === false\)/, 'a group whose lease is elsewhere runs no round')
  assert.match(groupsSrc, /await releaseLeaseFor\(room\)/, 'and the lease is given back')
  assert.match(groupsSrc, /if \(workgroupId === undefined\) return \{ held: true, local: true \}/, 'a local group has no fence')
  assert.match(groupsSrc, /offline: true/, 'a Hub that cannot be asked does not stop a local round')
})

// ── 修复：开始就是执行 ────────────────────────────────────────────────────────────
// The defect this pins: `task-start` used to call `startTask`, which only moved the record to
// RUNNING. A task could report RUNNING to the Hub with the Bot never asked to do anything, so the
// whole of §14 gate 2 ("the real Bot runs on B's machine") rested on a state label.

test('starting a task delivers the approved request into its Session', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene, { title: '把上个月的报销汇总一下' })
  await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b' })
  await settled()
  const record = scene.b.wg.taskOf(taskId)
  scene.b.ctx.__delivered = []

  const started = await scene.b.call('task-start', { taskId })
  assert.equal(started.ok, true, JSON.stringify(started))
  await settled()

  // The Bot was asked, once, in ITS task Session — not in the Bot's own chat, and not nowhere.
  const delivered = scene.b.ctx.__delivered
  assert.equal(delivered.length, 1, `the task Session must receive exactly one message; got ${delivered.length}`)
  assert.equal(delivered[0].sessionId, record.sessionId)
  const text = JSON.stringify(delivered[0].message)
  assert.match(text, /把上个月的报销汇总一下/, 'the requester\'s own words are what the Bot is given')
  // The source marks it as a task, so this domain's turn machinery starts no group round for it.
  assert.match(text, /"role":"task"/)
})

test('a request with nothing in it is refused rather than sent as an empty prompt', async (t) => {
  const scene = await twoMachines(t)
  // An explicitly empty title, not the helper's default one.
  const { taskId } = await askFor(t, { ...scene, title: ' ' })
  await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b' })
  await settled()
  scene.b.ctx.__delivered = []

  const started = await scene.b.call('task-start', { taskId })
  assert.equal(started.ok, false)
  assert.equal(started.error.code, 'task/empty')
  assert.equal(scene.b.ctx.__delivered.length, 0, 'nothing may be sent to the Bot')
  // And the record did not advance: an attempted start that refused leaves no half-started task.
  assert.equal(scene.b.wg.taskOf(taskId).state, 'APPROVED')
})

test('the approved folder is recorded as a real path, so the root exists to check against', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)
  const dir = join(scene.root, 'approved-folder')
  mkdirSync(dir, { recursive: true })
  await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b', workDir: dir })
  const record = scene.b.wg.taskOf(taskId)
  // The check in `verifyBeforeRun` reads this field. It used to be assigned nowhere, which made the
  // whole folder check dead code.
  assert.equal(typeof record.workDirRoot, 'string')
  assert.equal(record.workDirRoot, record.workDir)
  assert.equal(record.workDir, await scene.b.rt.real(dir))
})

test('a run whose Session works outside the approved folder is refused, never redirected', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)
  const root = join(scene.root, 'scope-root')
  const outside = join(scene.root, 'elsewhere')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })

  // A Session the harness reports as working in `outside`, while the task was approved for `root`.
  // `verifyBeforeRun` asks DSH where the Session really works (`rt.sessionFolder`), so this is the
  // case the gate exists for — and the one that was dead code while `workDirRoot` was never assigned.
  const realAgent = scene.b.rt.resolveAgent
  scene.b.rt.resolveAgent = async id => {
    const agent = await realAgent(id)
    agent.session.header = { cwd: outside }
    return agent
  }
  await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b', workDir: root })
  await settled()
  scene.b.ctx.__delivered = []

  const refusal = await scene.b.wg.runTask({ taskId, text: 'work over there' }).then(() => undefined, error => error)
  assert.ok(refusal !== undefined, 'a run outside the approved folder must be refused')
  assert.equal(refusal.code, 'task/bad-workspace')
  assert.match(refusal.message, /outside the folder this task was approved for/)
  // Refused, not redirected: nothing reached the Bot, and the record is not RUNNING.
  assert.equal(scene.b.ctx.__delivered.length, 0)
  assert.notEqual(scene.b.wg.taskOf(taskId).state, 'RUNNING')
})

test('a run inside the approved folder is allowed', async (t) => {
  const scene = await twoMachines(t)
  const { taskId } = await askFor(t, scene)
  const root = join(scene.root, 'ok-root')
  const inside = join(root, 'sub')
  mkdirSync(inside, { recursive: true })

  const realAgent = scene.b.rt.resolveAgent
  scene.b.rt.resolveAgent = async id => {
    const agent = await realAgent(id)
    agent.session.header = { cwd: inside }
    return agent
  }
  await scene.b.call('task-decide', { taskId, decision: 'granted', mode: 'existingBot', botId: 'b', workDir: root })
  await settled()
  scene.b.ctx.__delivered = []

  // The same setup, inside the root: this must go through, or the gate would refuse everything and
  // prove nothing.
  await scene.b.wg.runTask({ taskId, text: 'work here' })
  assert.equal(scene.b.ctx.__delivered.length, 1)
  assert.equal(scene.b.wg.taskOf(taskId).state, 'RUNNING')
})
