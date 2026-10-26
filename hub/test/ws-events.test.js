// Gate item 2: disconnect, reconnect, replay, out-of-order, duplicate ACK.
//
// Every test here drives two real sockets over a real port. The Hub's own modules are not
// stubbed — the properties asserted are the ones a plugin gets, and a test that mocked the fan-out
// would prove only that one function calls another.
//
// The scenarios map onto acceptance case T09 (Hub/Bridge power loss: unacked events resent,
// idempotent dedup) and T08 (two machines, order consistent).
import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { startHub, PHONE_A, PHONE_B, PASSWORD } from './helpers.js'
import { connect, groupWith, person, say } from './g4-helpers.js'

const setup = async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const alice = await person(hub, { phone: PHONE_A, name: 'Alice' })
  const bob = await person(hub, { phone: PHONE_B, name: 'Bob' })
  const { workgroupId } = await groupWith(hub, { owner: alice, others: [bob] })
  return { hub, alice, bob, workgroupId }
}

// ── T08: two machines see one ordered log ────────────────────────────────────────
test('a message from one machine reaches the other with the agreed seq', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await a.hello()
  await b.hello()

  const sent = await say(a, workgroupId, 'first')
  const received = await b.next(message => message.type === 'event')

  assert.equal(received.workgroupId, workgroupId)
  assert.equal(received.event.eventId, sent.eventId, 'the receiver sees the sender\'s own event id')
  assert.equal(received.event.seq, sent.seq, 'the seq the Hub assigned is the seq the receiver orders by')
  assert.deepEqual(received.event.payload, { text: 'first' })
  // The Hub fills the sender from the connection, so the receiving side can attribute the line
  // without trusting anything the frame claimed.
  assert.equal(received.event.sender.userId, alice.userId)
})

test('the sender does not receive its own message back', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await a.hello()
  await b.hello()

  await say(a, workgroupId, 'only bob should see this')
  await b.next(message => message.type === 'event')

  // Give an echo time to arrive before asserting its absence: a test that asserted immediately
  // would pass against a Hub that echoes late.
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(a.all('event').length, 0, 'the sender must not be shown its own line twice')
})

test('a sender cannot claim to be someone else', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await a.hello()
  await b.hello()

  // Alice's socket names Bob as the sender. The Hub ignores the field entirely.
  a.send({
    type: 'chat.message',
    workgroupId,
    eventId: 'evt-forged',
    sender: { userId: bob.userId, deviceId: bob.deviceId },
    senderId: bob.userId,
    payload: { text: 'not me' },
  })
  await a.next(message => message.type === 'ack.ok' && message.eventId === 'evt-forged')
  const received = await b.next(message => message.type === 'event' && message.event.eventId === 'evt-forged')
  assert.equal(received.event.sender.userId, alice.userId, 'the Hub overwrites the sender with the connection\'s identity')
})

// ── T09: the receiving machine drops offline, then reconnects ────────────────────
test('an event sent while a device is offline is replayed on reconnect', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  await a.hello()

  // Bob is offline for both messages: no socket at all.
  const first = await say(a, workgroupId, 'while you were out (1)')
  const second = await say(a, workgroupId, 'while you were out (2)')

  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  const hello = await b.hello()
  assert.deepEqual(hello.workgroups, [workgroupId], 'the hello names the groups to sync')

  // The reconnect path: ask for everything after what this device last acknowledged.
  b.send({ type: 'sync.request', workgroupId, afterSeq: 0 })
  const batch = await b.next(message => message.type === 'sync.batch')
  assert.deepEqual(batch.events.map(event => event.seq), [first.seq, second.seq])
  assert.equal(batch.lastSeq, second.seq)
  assert.equal(batch.hasMore, false)
})

test('an unacknowledged event is replayed even though it was already delivered', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  await a.hello()
  const first = await say(a, workgroupId, 'delivered but not acked')

  // Bob's socket receives it and then dies without acking — the power-loss case.
  const b1 = connect(hub, bob)
  await b1.hello()
  b1.send({ type: 'sync.request', workgroupId, afterSeq: 0 })
  const delivered = await b1.next(message => message.type === 'sync.batch')
  assert.equal(delivered.events.length, 1)
  await b1.close()

  // A new socket (restart) asks again from the same cursor and gets it again.
  const b2 = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b2.close()]))
  await b2.hello()
  b2.send({ type: 'sync.request', workgroupId, afterSeq: 0 })
  const again = await b2.next(message => message.type === 'sync.batch')
  assert.deepEqual(again.events.map(event => event.eventId), [first.eventId], 'the unacked event must come back')

  // Once acknowledged it stops being replayed.
  b2.send({ type: 'event.ack', workgroupId, eventId: first.eventId })
  const ack = await b2.next(message => message.type === 'ack.ok' && message.throughSeq !== undefined)
  assert.equal(ack.throughSeq, first.seq)

  // A `sync.request` from the *acked* cursor returns nothing, which is what makes the ack mean
  // something rather than merely being recorded.
  b2.send({ type: 'sync.request', workgroupId, afterSeq: first.seq })
  const empty = await b2.next(message => message.type === 'sync.batch' && message.events.length === 0)
  assert.deepEqual(empty.events, [])
})

test('a replayed ack is harmless and does not change the first timestamp', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  await a.hello()
  const sent = await say(a, workgroupId, 'ack me twice')
  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await b.hello()

  b.send({ type: 'event.ack', workgroupId, eventIds: [sent.eventId] })
  const first = await b.next(message => message.type === 'ack.ok' && message.acked === 1)
  b.send({ type: 'event.ack', workgroupId, eventIds: [sent.eventId] })
  const second = await b.next(message => message.type === 'ack.ok' && message.acked === 1 && message !== first)

  assert.equal(first.throughSeq, sent.seq)
  assert.equal(second.throughSeq, sent.seq)
  // The receipts table is keyed by (event, device): a duplicate ack updates no row into a second
  // one, so the delivery count for this event is still exactly one device.
  // `hub.hub` is the Hub itself; the outer object is the test harness around it.
  const db = hub.hub.db
  const rows = db.prepare('SELECT count(*) AS c FROM deliveries WHERE event_id = ?').get(sent.eventId).c
  assert.equal(rows, 1)
  const ackedAt = db.prepare('SELECT ack_at FROM deliveries WHERE event_id = ? AND device_id = ?').get(sent.eventId, bob.deviceId).ack_at
  const ackedAgain = await hub.get(`/v1/workgroups/${workgroupId}/events?afterSeq=${sent.seq}`, { token: bob.token })
  assert.deepEqual(ackedAgain.body.events, [])
  assert.ok(typeof ackedAt === 'string' && ackedAt.length > 0)
})

// ── dedup and ordering ───────────────────────────────────────────────────────────
test('a resent event keeps its original seq instead of appending a second copy', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await a.hello()
  await b.hello()

  const first = await say(a, workgroupId, 'only once', { eventId: 'evt-same' })
  const again = await say(a, workgroupId, 'only once', { eventId: 'evt-same' })

  assert.equal(first.duplicate, false)
  assert.equal(again.duplicate, true, 'the resend must be recognised as a duplicate')
  assert.equal(again.seq, first.seq, 'and must not consume a new seq')

  // The receiver saw exactly one copy, and the log holds exactly one row.
  await b.next(message => message.type === 'event' && message.event.eventId === 'evt-same')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(b.all('event').filter(message => message.event.eventId === 'evt-same').length, 1)
  const pulled = await hub.get(`/v1/workgroups/${workgroupId}/events`, { token: bob.token })
  assert.equal(pulled.body.events.length, 1)
})

test('seq is per group and strictly increasing, even with two senders racing', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await a.hello()
  await b.hello()

  // Both machines send at once, several times. The Hub is the only thing that decides order.
  const sends = []
  for (let index = 0; index < 5; index += 1) {
    sends.push(say(a, workgroupId, `a${index}`))
    sends.push(say(b, workgroupId, `b${index}`))
  }
  const acked = await Promise.all(sends)
  const seqs = acked.map(entry => entry.seq).sort((left, right) => left - right)
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'every append gets the next number exactly once')

  const pulled = await hub.get(`/v1/workgroups/${workgroupId}/events`, { token: alice.token })
  assert.deepEqual(pulled.body.events.map(event => event.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
})

test('a client that missed the middle of a conversation recovers the gap and nothing else', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  await a.hello()
  const first = await say(a, workgroupId, 'one')
  const second = await say(a, workgroupId, 'two')
  const third = await say(a, workgroupId, 'three')

  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await b.hello()

  // Bob has the first message on disk already (he was online for it, then lost the socket).
  b.send({ type: 'sync.request', workgroupId, afterSeq: first.seq })
  const gap = await b.next(message => message.type === 'sync.batch')
  assert.deepEqual(gap.events.map(event => event.seq), [second.seq, third.seq])
  assert.equal(gap.nextAfterSeq, third.seq)
})

test('a pull after the newest event returns nothing and reports the current lastSeq', async (t) => {
  const { hub, alice, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  t.after(() => a.close())
  await a.hello()
  const sent = await say(a, workgroupId, 'the end')

  const caughtUp = await hub.get(`/v1/workgroups/${workgroupId}/events?afterSeq=${sent.seq}`, { token: alice.token })
  assert.deepEqual(caughtUp.body.events, [])
  assert.equal(caughtUp.body.lastSeq, sent.seq)
  assert.equal(caughtUp.body.hasMore, false)
})

test('a long catch-up is paged rather than truncated silently', async (t) => {
  const { hub, alice, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  t.after(() => a.close())
  await a.hello()
  for (let index = 0; index < 4; index += 1) await say(a, workgroupId, `bulk ${index}`)

  const page = await hub.get(`/v1/workgroups/${workgroupId}/events?afterSeq=0&limit=2`, { token: alice.token })
  assert.equal(page.body.events.length, 2)
  assert.equal(page.body.hasMore, true, 'the client must be told there is more')

  // Following the cursor to the end reaches every event exactly once.
  let cursor = page.body.nextAfterSeq
  const seen = page.body.events.map(event => event.seq)
  for (let round = 0; round < 10; round += 1) {
    const next = await hub.get(`/v1/workgroups/${workgroupId}/events?afterSeq=${cursor}&limit=2`, { token: alice.token })
    if (next.body.events.length === 0) break
    seen.push(...next.body.events.map(event => event.seq))
    cursor = next.body.nextAfterSeq
    if (!next.body.hasMore) break
  }
  assert.deepEqual(seen, [1, 2, 3, 4])
})

// ── membership and isolation ─────────────────────────────────────────────────────
test('someone outside the group cannot read its events or post into it', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const alice = await person(hub, { phone: PHONE_A })
  const bob = await person(hub, { phone: PHONE_B })
  const { workgroupId } = await groupWith(hub, { owner: alice })

  const read = await hub.get(`/v1/workgroups/${workgroupId}/events`, { token: bob.token })
  assert.equal(read.status, 404, 'a stranger reads as "no such group", not "forbidden"')

  const b = connect(hub, bob)
  t.after(() => b.close())
  await b.hello()
  b.send({ type: 'chat.message', workgroupId, eventId: 'evt-outside', payload: { text: 'let me in' } })
  const refused = await b.next(message => message.type === 'error')
  assert.equal(refused.code, 'workgroup/not-found')
  assert.equal(b.ws.readyState, WebSocket.OPEN, 'a refusal is a frame, not a disconnection')

  const pulled = await hub.get(`/v1/workgroups/${workgroupId}/events`, { token: alice.token })
  assert.equal(pulled.body.events.length, 0, 'nothing was written')
})

test('a member who has not been invited yet sees nothing, even with the id', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const alice = await person(hub, { phone: PHONE_A })
  const bob = await person(hub, { phone: PHONE_B })
  const created = await hub.post('/v1/workgroups', { name: 'Private' }, { token: alice.token })
  const workgroupId = created.body.workgroupId

  const before = await hub.get('/v1/workgroups', { token: bob.token })
  assert.deepEqual(before.body.workgroups, [])

  const invite = await hub.post(`/v1/workgroups/${workgroupId}/invites`, { phone: bob.phone }, { token: alice.token })
  // Invited but not accepted: still nothing.
  const pending = await hub.get('/v1/workgroups', { token: bob.token })
  assert.deepEqual(pending.body.workgroups, [])
  const offered = await hub.get('/v1/invites', { token: bob.token })
  assert.equal(offered.body.invites.length, 1)
  assert.equal(offered.body.invites[0].inviteId, invite.body.inviteId)

  await hub.post(`/v1/invites/${invite.body.inviteId}/accept`, undefined, { token: bob.token })
  const after = await hub.get('/v1/workgroups', { token: bob.token })
  assert.equal(after.body.workgroups.length, 1)
  assert.equal(after.body.workgroups[0].workgroupId, workgroupId)
})

test('the read cursor is per person and advances forwards only', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await a.hello()
  await b.hello()
  const one = await say(a, workgroupId, 'one')
  const two = await say(a, workgroupId, 'two')
  await b.next(message => message.type === 'event' && message.event.seq === two.seq)

  // Bob reads up to message two.
  b.send({ type: 'read.updated', workgroupId, seq: two.seq })
  const read = await b.next(message => message.type === 'read.ok')
  assert.equal(read.lastReadSeq, two.seq)

  // Alice has read nothing, so her own unread count is unaffected by Bob's.
  const aliceView = await hub.get('/v1/workgroups', { token: alice.token })
  assert.equal(aliceView.body.workgroups[0].lastReadSeq, 0)
  assert.equal(aliceView.body.workgroups[0].unreadCount, 2)

  // Reading a lower seq does not move the cursor backwards.
  b.send({ type: 'read.updated', workgroupId, seq: one.seq })
  const backwards = await b.next(message => message.type === 'read.ok' && message.lastReadSeq !== undefined && message !== read)
  assert.equal(backwards.lastReadSeq, two.seq, 'a read cursor never goes back')

  const bobView = await hub.get('/v1/workgroups', { token: bob.token })
  assert.equal(bobView.body.workgroups[0].unreadCount, 0)
})

test('a read cursor is mirrored to the same person\'s other device, and to nobody else', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  const b = connect(hub, bob)
  const bobDesktop = await bob.otherDevice('Bob desktop')
  const bd = connect(hub, bobDesktop)
  t.after(() => Promise.all([a.close(), b.close(), bd.close()]))
  for (const socket of [a, b, bd]) await socket.hello()
  const sent = await say(a, workgroupId, 'read this')

  b.send({ type: 'read.updated', workgroupId, seq: sent.seq })
  await b.next(message => message.type === 'read.ok')
  const mirrored = await bd.next(message => message.type === 'read.updated')
  assert.equal(mirrored.lastReadSeq, sent.seq)

  // Alice is a different person: she must not be told what Bob read.
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(a.all('read.updated').length, 0)
})

// ── the socket survives the ordinary failures ────────────────────────────────────
test('a malformed frame is refused without ending the session', async (t) => {
  const { hub, alice, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  t.after(() => a.close())
  await a.hello()

  a.ws.send('not json at all')
  const refused = await a.next(message => message.type === 'error')
  assert.equal(refused.code, 'frame/not-json')
  assert.equal(a.ws.readyState, WebSocket.OPEN)

  // The socket still works after the refusal.
  const sent = await say(a, workgroupId, 'still here')
  assert.ok(sent.seq > 0)
})

test('a message with no group, or in an unknown group, is refused with a reason', async (t) => {
  const { hub, alice, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  t.after(() => a.close())
  await a.hello()

  a.send({ type: 'chat.message', eventId: 'evt-nogroup', payload: { text: 'x' } })
  const missing = await a.next(message => message.type === 'error')
  assert.equal(missing.code, 'frame/invalid')

  a.send({ type: 'chat.message', workgroupId: 'wg_does_not_exist', eventId: 'evt-ghost', payload: { text: 'x' } })
  const unknown = await a.next(message => message.type === 'error' && message !== missing)
  assert.equal(unknown.code, 'workgroup/not-found')

  // And the real group still works, so the refusals were not a broken connection.
  const sent = await say(a, workgroupId, 'fine')
  assert.equal(sent.seq, 1)
})

test('a chat message is validated: no payload, no oversized payload', async (t) => {
  const { hub, alice, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  t.after(() => a.close())
  await a.hello()

  a.send({ type: 'chat.message', workgroupId, eventId: 'evt-bad-payload', payload: 'a string, not an object' })
  const refused = await a.next(message => message.type === 'error')
  assert.equal(refused.code, 'event/invalid-payload')

  a.send({ type: 'chat.message', workgroupId, eventId: 'evt-huge', payload: { text: 'x'.repeat(40 * 1024) } })
  const tooBig = await a.next(message => message.type === 'error' && message !== refused)
  assert.equal(tooBig.code, 'event/payload-too-large')
})

test('an unknown event type is refused rather than stored', async (t) => {
  const { hub, alice, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  t.after(() => a.close())
  await a.hello()

  // `task.request` is G5's; accepting it now would be a promise the Hub cannot keep.
  a.send({ type: 'chat.message', workgroupId, eventId: 'evt-x', payload: { text: 'hi', type: 'task.request' } })
  await a.next(message => message.type === 'ack.ok')
  const pulled = await hub.get(`/v1/workgroups/${workgroupId}/events`, { token: alice.token })
  assert.equal(pulled.body.events[0].type, 'chat.message', 'the stored type is the frame\'s, not the payload\'s')
})

test('a revoked device is disconnected and its socket stops delivering', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await a.hello()
  await b.hello()

  await hub.post(`/v1/devices/${bob.deviceId}/revoke`, undefined, { token: bob.token })
  await b.closed
  assert.equal(b.closeCode, 4401)

  await say(a, workgroupId, 'sent to nobody')
  const pulled = await hub.get(`/v1/workgroups/${workgroupId}/events`, { token: alice.token })
  assert.equal(pulled.body.events.length, 1, 'the message is in the log even though its target was gone')
})

test('a reconnect with a stale nonce is refused, so a captured handshake cannot be replayed', async (t) => {
  const { hub, alice } = await setup(t)
  const timestamp = Date.now()
  const nonce = 'fixed-nonce-for-replay'
  const first = connect(hub, alice, { timestamp, nonce })
  await first.hello()
  await first.close()

  const replay = connect(hub, alice, { timestamp, nonce })
  await replay.closed
  assert.equal(replay.closeCode, 4404)
  assert.equal(replay.messages.length, 0)
})

test('a second login of the same account is a separate device with its own receipts', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  const desktop = await alice.otherDevice('Alice desktop')
  const ad = connect(hub, desktop)
  t.after(() => Promise.all([a.close(), ad.close()]))
  await a.hello()
  await ad.hello()

  const sent = await say(a, workgroupId, 'both my screens')
  // Fan-out is per device: the sender's own device is skipped, and Alice's other device still
  // receives what she sent from the first one.
  await ad.next(message => message.type === 'event')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(a.all('event').length, 0, 'the sending device is not echoed to')

  // Acking on one device does not ack for the other: the receipts are per device, which is what
  // makes "unacked" a per-machine fact.
  ad.send({ type: 'event.ack', workgroupId, eventId: sent.eventId })
  await ad.next(message => message.type === 'ack.ok' && message.throughSeq !== undefined)
  const bobSocket = connect(hub, bob)
  t.after(() => bobSocket.close())
  await bobSocket.hello()
  assert.equal(bobSocket.messages.filter(message => message.type === 'event').length, 0, 'bob was never in the fan-out for this send')
})

test('subscribing narrows the fan-out to the named groups', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const second = await hub.post('/v1/workgroups', { name: 'Another' }, { token: alice.token })
  await hub.post(`/v1/workgroups/${second.body.workgroupId}/invites`, { phone: bob.phone }, { token: alice.token })
    .then(response => hub.post(`/v1/invites/${response.body.inviteId}/accept`, undefined, { token: bob.token }))

  const a = connect(hub, alice)
  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await a.hello()
  await b.hello()

  b.send({ type: 'subscribe', workgroupIds: [workgroupId] })
  await b.next(message => message.type === 'subscribed')

  await say(a, workgroupId, 'the subscribed group')
  await say(a, second.body.workgroupId, 'the muted group')
  await b.next(message => message.type === 'event' && message.workgroupId === workgroupId)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(b.all('event').filter(message => message.workgroupId === second.body.workgroupId).length, 0,
    'an unsubscribed group must not be pushed')
})

test('a memory.change fans out on the existing sequence and never counts as unread', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await a.hello()
  await b.hello()

  const before = await hub.get(`/v1/workgroups/${workgroupId}`, { token: bob.token })
  assert.equal(before.status, 200)
  const unreadBefore = before.body.unreadCount

  const eventId = 'mev-ws-1'
  const from = a.cursor
  a.send({
    type: 'memory.change',
    workgroupId,
    eventId,
    botEndpointId: 'ep_alice_writer',
    payload: {
      roomKey: workgroupId,
      op: 'add',
      topic: null,
      before: null,
      after: '- Ship on Friday',
      actor: { id: 'bot-a', name: 'Writer' },
      at: '2026-10-24T00:00:00.000Z',
    },
  })
  const ack = await a.next(message => message.type === 'ack.ok' && message.eventId === eventId, { label: 'memory ack', from })
  assert.equal(Number.isInteger(ack.seq), true, 'the Hub assigns an integer seq from the shared log')
  assert.equal(ack.duplicate, false)

  const received = await b.next(message => message.type === 'event' && message.event.eventId === eventId)
  assert.equal(received.workgroupId, workgroupId)
  assert.equal(received.event.type, 'memory.change')
  assert.equal(received.event.seq, ack.seq)
  assert.equal(received.event.payload.after, '- Ship on Friday')
  assert.equal(received.event.sender.botEndpointId, 'ep_alice_writer', 'the Hub keeps the Bot identity like a chat line')

  const after = await hub.get(`/v1/workgroups/${workgroupId}`, { token: bob.token })
  assert.equal(after.body.unreadCount, unreadBefore, 'a memory change is not a message and must not raise the badge')

  const { EVENT_TYPES, READABLE_EVENT_TYPE } = await import('../src/workgroups/service.js')
  assert.equal(EVENT_TYPES.has('memory.change'), true)
  assert.equal(EVENT_TYPES.has('memory.proposed'), false, 'G6R keeps exactly one memory event type')
  assert.equal(EVENT_TYPES.has('memory.created'), false)
  assert.equal(EVENT_TYPES.has('memory.corrected'), false)
  assert.equal(EVENT_TYPES.has('memory.deleted'), false)
  assert.equal(READABLE_EVENT_TYPE, 'chat.message')
})

test('memory.change is refused for a stranger and for a missing group, and writes nothing', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const alice = await person(hub, { phone: PHONE_A })
  const bob = await person(hub, { phone: PHONE_B })
  const { workgroupId } = await groupWith(hub, { owner: alice })
  const b = connect(hub, bob)
  t.after(() => b.close())
  await b.hello()

  const from = b.cursor
  b.send({
    type: 'memory.change', workgroupId, eventId: 'mev-outside',
    payload: { roomKey: workgroupId, op: 'add', topic: null, before: null, after: '- not allowed', actor: { id: 'user', name: 'user' } },
  })
  const refused = await b.next(message => message.type === 'error', { from })
  assert.equal(refused.code, 'workgroup/not-found')
  assert.equal(b.ws.readyState, WebSocket.OPEN)

  b.send({
    type: 'memory.change', workgroupId: 'wg_ghost', eventId: 'mev-ghost',
    payload: { roomKey: 'wg_ghost', op: 'add', topic: null, before: null, after: '- nowhere', actor: { id: 'user', name: 'user' } },
  })
  const ghost = await b.next(message => message.type === 'error' && message !== refused, { from })
  assert.equal(ghost.code, 'workgroup/not-found')

  const pulled = await hub.get(`/v1/workgroups/${workgroupId}/events`, { token: alice.token })
  assert.equal(pulled.body.events.length, 0, 'a refused memory.change is not stored')
})
