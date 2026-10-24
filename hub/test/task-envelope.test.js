// The `task.request` envelope (plan §9.2, §9.3, acceptance T13).
//
// §9.2 is explicit that a signature check must be more than "the field is a string": the signature
// covers the canonical serialisation, the payload hash, the target, the lifetime and the protocol
// version, and the Hub must also confirm the sender is the authenticated connection and that the
// envelope is not a replay. Each of those is a separate test here, because each fails independently
// and a single "forged request is refused" test would pass with only one of them implemented.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sign } from 'node:crypto'
import { startHub, PASSWORD, PHONE_A, PHONE_B, registerDevice } from './helpers.js'
import { person, twoPeople, groupWith, connect } from './g4-helpers.js'
import { canonicalJson, payloadHash, signingBytes, signedFields } from '../src/tasks/envelope.js'

// Signs an envelope the way the plugin does: canonical bytes → device private key.
const signEnvelope = (keys, envelope) =>
  sign(null, signingBytes(envelope), keys.privateKey).toString('base64')

const makeEnvelope = ({ from, to, workgroupId, taskId = `task_${Math.random().toString(36).slice(2)}`, payload, overrides = {} }) => {
  const at = Date.now()
  return {
    v: 1,
    eventId: `evt_${Math.random().toString(36).slice(2)}`,
    type: 'task.request',
    workgroupId,
    taskId,
    sender: { userId: from.userId, deviceId: from.deviceId },
    target: { userId: to.userId },
    createdAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 60 * 60 * 1000).toISOString(),
    payload: payload ?? { title: '费用汇总' },
    ...overrides,
  }
}

// One group, A (requester) and B (target), each with a live socket and a pair of keys.
async function scene(t) {
  const hub = await startHub()
  t.after(async () => { await hub.close() })
  const { alice, bob } = await twoPeople(hub)
  const { workgroupId } = await groupWith(hub, { owner: alice, others: [bob] })
  return { hub, alice, bob, workgroupId }
}

const request = async (socket, envelope, keys) => {
  const from = socket.cursor
  socket.send({ type: 'task.request', envelope: { ...envelope, signature: envelope.signature ?? signEnvelope(keys, envelope) } })
  return socket.next(message => message.type === 'task.ok' || message.type === 'error', { label: 'task answer', from })
}

test('a correctly signed request is accepted and reaches the group log', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  const socket = connect(hub, alice)
  await socket.hello()
  const envelope = makeEnvelope({ from: alice, to: bob, workgroupId })

  const answer = await request(socket, envelope, alice.keys)
  assert.equal(answer.type, 'task.ok', JSON.stringify(answer))
  assert.equal(answer.duplicate, false)
  assert.equal(answer.state, 'REQUESTED')

  // The request is a group event, so the timeline shows "A asked B" in the same order as the chat
  // around it (§9.4). It takes a `seq` like a message.
  const events = hub.hub.events.pull({ workgroupId, afterSeq: 0 }).events
  const requestEvent = events.find(event => event.type === 'task.request')
  assert.ok(requestEvent !== undefined, 'the request must be in the group log')
  assert.equal(requestEvent.payload.taskId, envelope.taskId)
  assert.equal(requestEvent.payload.target.userId, bob.userId)
  await socket.close()
})

test('the payload cannot be changed after signing', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  const socket = connect(hub, alice)
  await socket.hello()
  const envelope = makeEnvelope({ from: alice, to: bob, workgroupId, payload: { title: 'Harmless' } })
  const signature = signEnvelope(alice.keys, envelope)

  // Same signature, different payload: this is the attack a "is signature present" check permits.
  const tampered = { ...envelope, payload: { title: 'Everything on this machine' }, signature }
  const answer = await request(socket, tampered, alice.keys)
  assert.equal(answer.type, 'error')
  // Either the payload hash or the signature itself catches it; both are refusals.
  assert.match(answer.code, /task\/(bad-signature|payload-hash-mismatch)/)
  assert.equal(hub.hub.tasks.count(workgroupId), 0)
  await socket.close()
})

test('the target cannot be changed after signing', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  // A third person, so "redirect the request" means something.
  const carol = await person(hub, { phone: '+8613700137000', name: 'Carol laptop' })
  const socket = connect(hub, alice)
  await socket.hello()
  const envelope = makeEnvelope({ from: alice, to: bob, workgroupId })
  const signature = signEnvelope(alice.keys, envelope)

  const redirected = { ...envelope, target: { userId: carol.userId }, signature }
  const answer = await request(socket, redirected, alice.keys)
  assert.equal(answer.type, 'error')
  assert.equal(answer.code, 'task/bad-signature')
  await socket.close()
})

test('the lifetime cannot be extended after signing', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  const socket = connect(hub, alice)
  await socket.hello()
  const envelope = makeEnvelope({ from: alice, to: bob, workgroupId })
  const signature = signEnvelope(alice.keys, envelope)

  const extended = { ...envelope, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), signature }
  const answer = await request(socket, extended, alice.keys)
  assert.equal(answer.type, 'error')
  assert.equal(answer.code, 'task/bad-signature')
  await socket.close()
})

test('a frame claiming somebody else as the sender is refused before the signature is even read', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  const socket = connect(hub, alice)
  await socket.hello()

  // Correctly signed with Alice's key, but claiming Bob's identity. The Hub refuses on the
  // connection-identity check (§9.3: the sender comes from the authenticated socket).
  const envelope = makeEnvelope({ from: bob, to: alice, workgroupId })
  const answer = await request(socket, envelope, alice.keys)
  assert.equal(answer.type, 'error')
  assert.equal(answer.code, 'task/sender-mismatch')
  assert.equal(hub.hub.tasks.count(workgroupId), 0)
  await socket.close()
})

test('an unsigned request is refused', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  const socket = connect(hub, alice)
  await socket.hello()
  const envelope = makeEnvelope({ from: alice, to: bob, workgroupId })
  const from = socket.cursor
  socket.send({ type: 'task.request', envelope })
  const answer = await socket.next(message => message.type === 'task.ok' || message.type === 'error', { from })
  assert.equal(answer.type, 'error')
  assert.equal(answer.code, 'task/unsigned')
  await socket.close()
})

test('a replay of an old envelope is refused on its own timestamp', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  const socket = connect(hub, alice)
  await socket.hello()

  // Signed while it was fresh, presented once the window has passed. The clock is the Hub's, so a
  // client cannot extend its own request's life by lying about the time.
  const old = Date.now() - 10 * 60 * 1000
  const envelope = makeEnvelope({
    from: alice, to: bob, workgroupId,
    overrides: {
      createdAt: new Date(old).toISOString(),
      expiresAt: new Date(old + 5 * 60 * 1000).toISOString(),
    },
  })
  const answer = await request(socket, envelope, alice.keys)
  assert.equal(answer.type, 'error')
  assert.match(answer.code, /task\/(envelope-stale|envelope-expired)/)
  await socket.close()
})

test('an envelope dated in the future is refused, so its window cannot be pushed forward', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  const socket = connect(hub, alice)
  await socket.hello()
  const ahead = Date.now() + 30 * 60 * 1000
  const envelope = makeEnvelope({
    from: alice, to: bob, workgroupId,
    overrides: {
      createdAt: new Date(ahead).toISOString(),
      expiresAt: new Date(ahead + 60 * 1000).toISOString(),
    },
  })
  const answer = await request(socket, envelope, alice.keys)
  assert.equal(answer.type, 'error')
  assert.equal(answer.code, 'task/envelope-from-future')
  await socket.close()
})

test('the same task id is one task, however many times the outbox resends it', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  const socket = connect(hub, alice)
  await socket.hello()
  const envelope = makeEnvelope({ from: alice, to: bob, workgroupId, taskId: 'task_fixed' })

  const first = await request(socket, envelope, alice.keys)
  assert.equal(first.duplicate, false)
  // Same envelope, three more times: this is what a reconnect does when the first ack was lost.
  for (let round = 0; round < 3; round += 1) {
    const again = await request(socket, envelope, alice.keys)
    assert.equal(again.type, 'task.ok')
    assert.equal(again.duplicate, true, 'a resend must be answered as a duplicate, not create a task')
    assert.equal(again.taskId, 'task_fixed')
  }
  assert.equal(hub.hub.tasks.count(workgroupId), 1, 'four deliveries of one request make one task')
  await socket.close()
})

test('a task cannot be requested for somebody outside the group', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  const outsider = await person(hub, { phone: '+8613600136000', name: 'Outsider laptop' })
  const socket = connect(hub, alice)
  await socket.hello()

  const envelope = makeEnvelope({ from: alice, to: outsider, workgroupId })
  const answer = await request(socket, envelope, alice.keys)
  assert.equal(answer.type, 'error')
  assert.equal(answer.code, 'task/target-not-in-group')
  await socket.close()
})

test('a non-member cannot request a task in a group at all', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  const outsider = await person(hub, { phone: '+8613600136000', name: 'Outsider laptop' })
  const socket = connect(hub, outsider)
  await socket.hello()

  const envelope = makeEnvelope({ from: outsider, to: bob, workgroupId })
  const answer = await request(socket, envelope, outsider.keys)
  assert.equal(answer.type, 'error')
  // Reported as "no such group", so the socket cannot be used to probe which group ids exist.
  assert.equal(answer.code, 'workgroup/not-found')
  await socket.close()
})

test('the endpoint named in a request must belong to the person it is addressed to', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  const aliceEndpoint = (await hub.post('/v1/bot-endpoints', {
    localBotId: 'alice-chief', name: 'Alice Chief', capabilities: ['chat'],
  }, { token: alice.token })).body

  const socket = connect(hub, alice)
  await socket.hello()
  // Addressed to Bob but naming Alice's own endpoint: the target field would be decorative if this
  // were allowed, because the work would land on the requester's own Bot.
  const envelope = makeEnvelope({
    from: alice, to: bob, workgroupId,
    overrides: { target: { userId: bob.userId, botEndpointId: aliceEndpoint.endpoint.endpointId } },
  })
  const answer = await request(socket, envelope, alice.keys)
  assert.equal(answer.type, 'error')
  assert.equal(answer.code, 'task/endpoint-unknown')
  await socket.close()
})

test('an envelope for an older protocol version is refused', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  const socket = connect(hub, alice)
  await socket.hello()
  const envelope = makeEnvelope({ from: alice, to: bob, workgroupId, overrides: { v: 2 } })
  const answer = await request(socket, envelope, alice.keys)
  assert.equal(answer.type, 'error')
  assert.equal(answer.code, 'task/unsupported-version')
  await socket.close()
})

test('the canonical form is stable and the payload hash changes with the payload', () => {
  // These two properties are what the plugin's copy is compared against, so they are asserted here
  // rather than only exercised through a socket.
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(canonicalJson({ a: [3, { y: 1, x: 2 }] }), '{"a":[3,{"x":2,"y":1}]}')
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}')
  assert.notEqual(payloadHash({ title: 'one' }), payloadHash({ title: 'two' }))
  assert.equal(payloadHash({ title: 'one' }), payloadHash({ title: 'one' }))

  const envelope = {
    v: 1, eventId: 'e', type: 'task.request', workgroupId: 'w', taskId: 't',
    sender: { userId: 'u', deviceId: 'd' }, target: { userId: 'v' },
    createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z',
    payload: { title: 'x' },
  }
  // The signed fields include the payload HASH, not the payload: a canonical envelope stays small
  // and the hash is what detects a change.
  assert.equal(signedFields(envelope).payloadHash, payloadHash(envelope.payload))
  assert.equal(signingBytes(envelope).includes('"title"'), false, 'the payload itself is not in the signed bytes')
})
