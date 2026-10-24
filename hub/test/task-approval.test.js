// Approval, decisions, revocation and the state machine (plan §10.1–§10.4; gates 1, 3, 4; T13, T16).
//
// Gate 1 is "A asks B, and when B refuses, B runs no model and no tool". The Hub's share of that
// claim is narrow and checkable: REJECTED is a final state, `APPROVED` is only reachable from
// `PENDING_APPROVAL` through a decision made by B's own device, and `RUNNING` refuses to happen
// without a live approval. If any of those three were reachable any other way, the plugin's
// "nothing ran" would be an assertion about the plugin alone.
//
// Gate 3 is "the issuing device is unambiguous". Every test here reads the stored
// `approved_device_id` and the event's `sender_device_id` and compares them to the device that
// actually made the call — not to a value the request supplied.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sign } from 'node:crypto'
import { startHub } from './helpers.js'
import { person, twoPeople, groupWith, connect } from './g4-helpers.js'
import { signingBytes } from '../src/tasks/envelope.js'

const signEnvelope = (keys, envelope) => sign(null, signingBytes(envelope), keys.privateKey).toString('base64')

// A group with A and B, both connected. B's Chief is published so a request can name a real endpoint.
async function scene(t) {
  const hub = await startHub()
  t.after(async () => { await hub.close() })
  const { alice, bob } = await twoPeople(hub)
  const { workgroupId } = await groupWith(hub, { owner: alice, others: [bob] })
  const endpoint = (await hub.post('/v1/bot-endpoints', {
    localBotId: 'bob-chief', name: 'Bob Chief', capabilities: ['chat', 'files'],
  }, { token: bob.token })).body.endpoint
  return { hub, alice, bob, workgroupId, endpoint }
}

async function submitTask({ hub, alice, bob, workgroupId, endpoint, payload, ttlMs }) {
  const socket = connect(hub, alice)
  await socket.hello()
  const at = Date.now()
  const envelope = {
    v: 1,
    eventId: `evt_${Math.random().toString(36).slice(2)}`,
    type: 'task.request',
    workgroupId,
    taskId: `task_${Math.random().toString(36).slice(2)}`,
    sender: { userId: alice.userId, deviceId: alice.deviceId },
    target: { userId: bob.userId, ...(endpoint === undefined ? {} : { botEndpointId: endpoint.endpointId }) },
    createdAt: new Date(at).toISOString(),
    expiresAt: new Date(at + (ttlMs ?? 60 * 60 * 1000)).toISOString(),
    payload: payload ?? { title: '费用汇总', requestedCapabilities: ['read'] },
  }
  envelope.signature = signEnvelope(alice.keys, envelope)
  const from = socket.cursor
  socket.send({ type: 'task.request', envelope })
  const answer = await socket.next(message => message.type === 'task.ok' || message.type === 'error', { from })
  await socket.close()
  assert.equal(answer.type, 'task.ok', JSON.stringify(answer))
  return answer.taskId
}

test('B refusing ends the task, and nothing may approve or run it afterwards', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  const taskId = await submitTask({ hub, alice, bob, workgroupId, endpoint })

  const decided = await hub.post(`/v1/tasks/${taskId}/decision`, { decision: 'rejected' }, { token: bob.token })
  assert.equal(decided.status, 200, JSON.stringify(decided.body))
  assert.equal(decided.body.task.state, 'REJECTED')

  // The rejection is a final state: the plugin's own machine agrees, and so must the Hub.
  const again = await hub.post(`/v1/tasks/${taskId}/decision`, { decision: 'granted' }, { token: bob.token })
  assert.equal(again.status, 409)
  assert.match(again.body.error.code, /task\/(not-awaiting-decision|already-finished)/)

  // And work cannot be reported for it, whatever the executing device says.
  const socket = connect(hub, bob)
  await socket.hello()
  const from = socket.cursor
  socket.send({ type: 'task.report', taskId, next: 'RUNNING' })
  const refused = await socket.next(message => message.type === 'task.reported' || message.type === 'error', { from })
  assert.equal(refused.type, 'error')
  assert.match(refused.code, /task\/(already-finished|transition-refused)/)
  await socket.close()

  // Hub-side evidence for gate 1: no `task.started` was ever written, so a timeline cannot show work
  // that did not happen.
  const events = hub.hub.events.pull({ workgroupId, afterSeq: 0 }).events
  assert.equal(events.some(event => event.type === 'task.started'), false)
  assert.equal(events.some(event => event.type === 'task.completed'), false)
  assert.equal(events.some(event => event.type === 'approval.rejected'), true)
})

test('approving moves the task forward and starts its approval record on B device', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  const taskId = await submitTask({ hub, alice, bob, workgroupId, endpoint })

  const decided = await hub.post(`/v1/tasks/${taskId}/decision`, {
    decision: 'granted',
    scope: { allowedResources: ['resource:monthly-expenses'], capabilities: ['read'], endpointId: endpoint.endpointId },
  }, { token: bob.token })
  assert.equal(decided.status, 200, JSON.stringify(decided.body))
  assert.equal(decided.body.task.state, 'APPROVED')
  assert.equal(decided.body.task.approvals.length, 1)

  const approval = decided.body.task.approvals[0]
  assert.equal(approval.decision, 'granted')
  // Gate 3: the device is B's own registered device, taken from the session.
  assert.equal(approval.approvedDeviceId, bob.deviceId)
  assert.equal(approval.approvedBy, bob.userId)
  assert.deepEqual(approval.scope.allowedResources, ['resource:monthly-expenses'])

  // And the group's timeline says so, ordered with the chat.
  const events = hub.hub.events.pull({ workgroupId, afterSeq: 0 }).events
  const granted = events.find(event => event.type === 'approval.granted')
  assert.ok(granted !== undefined, 'the grant must be a group event')
  assert.equal(granted.sender.deviceId, bob.deviceId)
})

test('the device is the session device, not a value the request body carries', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  const taskId = await submitTask({ hub, alice, bob, workgroupId, endpoint })
  // Bob has a second machine; A has one too. Neither of those devices made this call.
  const bobOther = await bob.otherDevice('Bob desktop')

  const decided = await hub.post(`/v1/tasks/${taskId}/decision`, {
    decision: 'granted',
    // A caller trying to attribute the decision elsewhere. Ignored, not merely unvalidated.
    deviceId: alice.deviceId,
    approvedDeviceId: alice.deviceId,
  }, { token: bob.token })
  assert.equal(decided.status, 200, JSON.stringify(decided.body))
  assert.equal(decided.body.task.approvals[0].approvedDeviceId, bob.deviceId)
  assert.notEqual(decided.body.task.approvals[0].approvedDeviceId, alice.deviceId)
  assert.notEqual(decided.body.task.approvals[0].approvedDeviceId, bobOther.deviceId)
})

test('only the person the task is for may approve it', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  const taskId = await submitTask({ hub, alice, bob, workgroupId, endpoint })

  // The requester cannot approve their own request: that would make the whole gate meaningless.
  const byRequester = await hub.post(`/v1/tasks/${taskId}/decision`, { decision: 'granted' }, { token: alice.token })
  assert.equal(byRequester.status, 404, 'answering for somebody else reads as "no such task"')

  // A third person in the group cannot either.
  const carol = await person(hub, { phone: '+8613700137000', name: 'Carol laptop' })
  const invite = await hub.post(`/v1/workgroups/${workgroupId}/invites`, { phone: carol.phone }, { token: alice.token })
  await hub.post(`/v1/invites/${invite.body.inviteId}/accept`, undefined, { token: carol.token })
  const byBystander = await hub.post(`/v1/tasks/${taskId}/decision`, { decision: 'granted' }, { token: carol.token })
  assert.equal(byBystander.status, 404)

  // The task is untouched by both attempts.
  const view = await hub.get(`/v1/tasks/${taskId}`, { token: bob.token })
  assert.equal(view.body.task.state, 'REQUESTED')
  assert.equal(view.body.task.approvals.length, 0)
})

test('a task cannot run without a live approval, even reported by its own owner', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  const taskId = await submitTask({ hub, alice, bob, workgroupId, endpoint })

  const socket = connect(hub, bob)
  await socket.hello()
  // Straight from REQUESTED to RUNNING: refused by the transition table.
  let from = socket.cursor
  socket.send({ type: 'task.report', taskId, next: 'RUNNING' })
  const tooFar = await socket.next(message => message.type === 'task.reported' || message.type === 'error', { from })
  assert.equal(tooFar.type, 'error')
  assert.match(tooFar.code, /task\/transition-refused/)

  // Walk the legal path up to APPROVED and try again without an approval on record.
  await hub.post(`/v1/tasks/${taskId}/decision`, { decision: 'granted' }, { token: bob.token })
  from = socket.cursor
  socket.send({ type: 'task.report', taskId, next: 'ASSIGNED' })
  await socket.next(message => message.type === 'task.reported', { from })
  from = socket.cursor
  socket.send({ type: 'task.report', taskId, next: 'RUNNING' })
  const started = await socket.next(message => message.type === 'task.reported' || message.type === 'error', { from })
  assert.equal(started.type, 'task.reported', 'with a live approval, running is allowed')
  assert.equal(started.state, 'RUNNING')
  await socket.close()
})

test('an expired request cannot be approved, and is recorded as expired', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  // A request that lives one minute. The window has to stay under the access token's own 30-minute
  // life, or the test would be measuring the session expiring rather than the task.
  const taskId = await submitTask({ hub, alice, bob, workgroupId, endpoint, payload: { title: 'late' }, ttlMs: 60 * 1000 })

  // Move the Hub's clock past the request's own expiry. The plugin cannot extend it: `expiresAt` is
  // inside the signature (see task-envelope.test.js).
  hub.clock.advanceBy(2 * 60 * 1000)
  const late = await hub.post(`/v1/tasks/${taskId}/decision`, { decision: 'granted' }, { token: bob.token })
  assert.equal(late.status, 409)
  assert.equal(late.body.error.code, 'task/expired')

  const view = await hub.get(`/v1/tasks/${taskId}`, { token: bob.token })
  assert.equal(view.body.task.state, 'EXPIRED')
  assert.equal(view.body.task.approvals.length, 0, 'an expired request does not get an approval record')
})

test('revoking stops the task, withdraws the grant, and refuses a later start', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  const taskId = await submitTask({ hub, alice, bob, workgroupId, endpoint })
  await hub.post(`/v1/tasks/${taskId}/decision`, { decision: 'granted' }, { token: bob.token })

  const revoked = await hub.post(`/v1/tasks/${taskId}/revoke`, { reason: 'changed my mind' }, { token: bob.token })
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
  assert.equal(revoked.body.task.approvals[0].revokedAt !== undefined, true)
  assert.match(revoked.body.task.state, /CANCELLED|CANCEL_REQUESTED/)

  // Gate 4 / N1 on the Hub side: a grant that was withdrawn cannot be used to start work.
  const socket = connect(hub, bob)
  await socket.hello()
  const from = socket.cursor
  socket.send({ type: 'task.report', taskId, next: 'RUNNING' })
  const refused = await socket.next(message => message.type === 'task.reported' || message.type === 'error', { from })
  assert.equal(refused.type, 'error')
  assert.match(refused.code, /task\/(already-finished|transition-refused)/)
  await socket.close()

  const events = hub.hub.events.pull({ workgroupId, afterSeq: 0 }).events
  assert.equal(events.some(event => event.type === 'approval.revoked'), true)
  assert.equal(events.some(event => event.type === 'task.cancel'), true)
})

test('the requester cannot revoke an approval: only the owner withdraws consent', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  const taskId = await submitTask({ hub, alice, bob, workgroupId, endpoint })
  await hub.post(`/v1/tasks/${taskId}/decision`, { decision: 'granted' }, { token: bob.token })

  // A cancelling their own request and B withdrawing their consent are different acts, and the Hub
  // keeps them apart so "A gave up" can never look like "B withdrew".
  const byRequester = await hub.post(`/v1/tasks/${taskId}/revoke`, {}, { token: alice.token })
  assert.equal(byRequester.status, 403)
  assert.equal(byRequester.body.error.code, 'task/not-owner')
})

test('revoking a task with no live approval is refused rather than recorded', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  const taskId = await submitTask({ hub, alice, bob, workgroupId, endpoint })
  const revoked = await hub.post(`/v1/tasks/${taskId}/revoke`, {}, { token: bob.token })
  assert.equal(revoked.status, 409)
  assert.equal(revoked.body.error.code, 'task/not-approved')
})

test('a second approval answers with the first instead of adding a second grant', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  const taskId = await submitTask({ hub, alice, bob, workgroupId, endpoint })

  const first = await hub.post(`/v1/tasks/${taskId}/decision`, { decision: 'granted' }, { token: bob.token })
  assert.equal(first.status, 200)
  // A double click from a slow UI. The state is already APPROVED, so this is answered as
  // "not awaiting a decision" rather than creating an ambiguity about which scope is in force.
  const second = await hub.post(`/v1/tasks/${taskId}/decision`, { decision: 'granted' }, { token: bob.token })
  assert.equal(second.status, 409)
  const view = await hub.get(`/v1/tasks/${taskId}`, { token: bob.token })
  assert.equal(view.body.task.approvals.length, 1)
})

test('a task is readable only by the two people it involves', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  const taskId = await submitTask({ hub, alice, bob, workgroupId, endpoint })

  assert.equal((await hub.get(`/v1/tasks/${taskId}`, { token: alice.token })).status, 200)
  assert.equal((await hub.get(`/v1/tasks/${taskId}`, { token: bob.token })).status, 200)

  const carol = await person(hub, { phone: '+8613700137000', name: 'Carol laptop' })
  const invite = await hub.post(`/v1/workgroups/${workgroupId}/invites`, { phone: carol.phone }, { token: alice.token })
  await hub.post(`/v1/invites/${invite.body.inviteId}/accept`, undefined, { token: carol.token })
  // Even a fellow group member cannot read somebody else's task: the group sees THAT a task exists
  // (the log event), not what it contains.
  assert.equal((await hub.get(`/v1/tasks/${taskId}`, { token: carol.token })).status, 404)
})

test('a task list names what this person must answer and what they asked for', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  const mine = await submitTask({ hub, alice, bob, workgroupId, endpoint, payload: { title: 'for bob' } })

  const asOwner = await hub.get('/v1/tasks?role=owner', { token: bob.token })
  assert.deepEqual(asOwner.body.tasks.map(task => task.taskId), [mine])
  const asRequester = await hub.get('/v1/tasks?role=requester', { token: alice.token })
  assert.deepEqual(asRequester.body.tasks.map(task => task.taskId), [mine])
  // Nobody else's work appears in either list.
  const carol = await person(hub, { phone: '+8613700137000', name: 'Carol laptop' })
  assert.deepEqual((await hub.get('/v1/tasks', { token: carol.token })).body.tasks, [])

  const inGroup = await hub.get(`/v1/tasks?workgroupId=${encodeURIComponent(workgroupId)}`, { token: alice.token })
  assert.equal(inGroup.body.tasks.length, 1)
})

test('the task events share the group seq with chat, and unread counts only messages', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  const socket = connect(hub, alice)
  await socket.hello()
  // One message, then a task, then an approval: three different `seq` values, one of them unread.
  const from = socket.cursor
  socket.send({ type: 'chat.message', workgroupId, eventId: 'evt_m1', payload: { text: '费用汇总请看一下' } })
  await socket.next(message => message.type === 'ack.ok' && message.eventId === 'evt_m1', { from })
  const taskId = await submitTask({ hub, alice, bob, workgroupId, endpoint })
  await hub.post(`/v1/tasks/${taskId}/decision`, { decision: 'granted' }, { token: bob.token })

  const events = hub.hub.events.pull({ workgroupId, afterSeq: 0 }).events
  const seqs = events.map(event => event.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'the log is in seq order')
  assert.equal(new Set(seqs).size, seqs.length, 'no two events share a seq')
  assert.ok(events.some(event => event.type === 'chat.message'))
  assert.ok(events.some(event => event.type === 'approval.granted'))

  // The badge counts messages, so the approval and the request do not make it climb.
  const list = await hub.get('/v1/workgroups', { token: alice.token })
  assert.equal(list.body.workgroups[0].unreadCount, 1, 'one unread message, whatever else the log holds')
  await socket.close()
})

test('a replayed RUNNING report is an idempotent acknowledgement', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  const taskId = await submitTask({ hub, alice, bob, workgroupId, endpoint })
  await hub.post(`/v1/tasks/${taskId}/decision`, { decision: 'granted' }, { token: bob.token })

  const socket = connect(hub, bob)
  await socket.hello()
  let from = socket.cursor
  socket.send({ type: 'task.report', taskId, next: 'ASSIGNED' })
  await socket.next(message => message.type === 'task.reported', { from })
  from = socket.cursor
  socket.send({ type: 'task.report', taskId, next: 'RUNNING' })
  const started = await socket.next(message => message.type === 'task.reported', { from })
  assert.equal(started.state, 'RUNNING')

  // The client lost the ack and sends it again after reconnecting. The Hub must not count this as a
  // transition: the state did not move and the version must not move either.
  from = socket.cursor
  socket.send({ type: 'task.report', taskId, next: 'RUNNING' })
  const replay = await socket.next(message => message.type === 'task.reported' || message.type === 'error', { from })
  assert.equal(replay.type, 'task.reported', JSON.stringify(replay))
  assert.equal(replay.state, 'RUNNING')
  const view = await hub.get(`/v1/tasks/${taskId}`, { token: bob.token })
  assert.equal(view.body.task.version, started.version, 'a same-state report does not bump the version')
  await socket.close()
})
