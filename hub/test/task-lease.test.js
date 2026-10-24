// The coordinator lease (plan §9.5): one scheduler per group, fenced by an epoch.
//
// The interesting case is not "two devices acquire at once" — the group row's primary key already
// makes that impossible — it is a STALE holder reporting after the lease moved on. That is what the
// epoch is for, and it is what these tests measure.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startHub } from './helpers.js'
import { twoPeople, groupWith, connect } from './g4-helpers.js'

async function scene(t) {
  const hub = await startHub()
  t.after(async () => { await hub.close() })
  const { alice, bob } = await twoPeople(hub)
  const { workgroupId } = await groupWith(hub, { owner: alice, others: [bob] })
  return { hub, alice, bob, workgroupId }
}

test('a group starts with no lease, and the first acquire takes epoch 1', async (t) => {
  const { hub, alice, workgroupId } = await scene(t)
  const before = await hub.get(`/v1/workgroups/${workgroupId}/lease`, { token: alice.token })
  assert.equal(before.status, 200)
  assert.equal(before.body.lease, null)

  const acquired = await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 30_000 }, { token: alice.token })
  assert.equal(acquired.status, 200, JSON.stringify(acquired.body))
  assert.equal(acquired.body.lease.epoch, 1)
  assert.equal(acquired.body.lease.holderUserId, alice.userId)
  assert.equal(acquired.body.lease.holderDeviceId, alice.deviceId)
})

test('a second device cannot take a live lease, and hears who holds it', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 60_000 }, { token: alice.token })

  const refused = await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 60_000 }, { token: bob.token })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'lease/held')
  // The refusal says until when, so the client can wait rather than guess.
  assert.match(refused.body.error.message, /until \d{4}-/)

  const current = await hub.get(`/v1/workgroups/${workgroupId}/lease`, { token: bob.token })
  assert.equal(current.body.lease.holderUserId, alice.userId, 'the holder is unchanged')
})

test('renewing keeps the epoch: the fence is still this holder', async (t) => {
  const { hub, alice, workgroupId } = await scene(t)
  const first = await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 1000 }, { token: alice.token })
  const renewed = await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 60_000 }, { token: alice.token })
  assert.equal(renewed.body.lease.epoch, first.body.lease.epoch, 'a renewal is not a new coordinator')
  assert.notEqual(renewed.body.lease.leaseUntil, first.body.lease.leaseUntil)
})

test('a lease that expired can be taken, and the epoch moves so a stale report is refused', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  const first = await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 1000 }, { token: alice.token })
  assert.equal(first.body.lease.epoch, 1)

  // The lease lapses (a laptop slept). Bob's device takes over.
  hub.clock.advanceBy(5000)
  const taken = await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 60_000 }, { token: bob.token })
  assert.equal(taken.status, 200, JSON.stringify(taken.body))
  assert.equal(taken.body.lease.epoch, 2)

  // Alice comes back and reports a round under her old epoch. This is the case the fence exists for:
  // the round really ran, and its result must still be refused.
  const socket = connect(hub, alice)
  await socket.hello()
  const from = socket.cursor
  socket.send({ type: 'lease.check', workgroupId, epoch: 1 })
  const refused = await socket.next(message => message.type === 'lease.ok' || message.type === 'error', { from })
  assert.equal(refused.type, 'error')
  assert.equal(refused.code, 'lease/not-holder')
  await socket.close()

  // And Bob's own device, with the right epoch, is accepted.
  const bobSocket = connect(hub, bob)
  await bobSocket.hello()
  const fromBob = bobSocket.cursor
  bobSocket.send({ type: 'lease.check', workgroupId, epoch: 2 })
  const accepted = await bobSocket.next(message => message.type === 'lease.ok' || message.type === 'error', { from: fromBob })
  assert.equal(accepted.type, 'lease.ok', JSON.stringify(accepted))
  assert.equal(accepted.lease.epoch, 2)
  await bobSocket.close()
})

test('the same person on two machines is two coordinators, not one', async (t) => {
  const { hub, alice, workgroupId } = await scene(t)
  const other = await alice.otherDevice('Alice desktop')
  await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 60_000 }, { token: alice.token })

  // Being the same user is not enough: two machines running rounds is what §9.5 forbids.
  const refused = await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 60_000 }, { token: other.token })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'lease/held')
})

test('a stale epoch from the current holder is still refused', async (t) => {
  const { hub, bob, alice, workgroupId } = await scene(t)
  await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 1000 }, { token: alice.token })
  hub.clock.advanceBy(5000)
  await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 60_000 }, { token: bob.token })

  const socket = connect(hub, bob)
  await socket.hello()
  // Bob holds the lease at epoch 2; a round he queued under epoch 1 (before he re-acquired) must not
  // commit under the new one.
  const from = socket.cursor
  socket.send({ type: 'lease.check', workgroupId, epoch: 1 })
  const refused = await socket.next(message => message.type === 'lease.ok' || message.type === 'error', { from })
  assert.equal(refused.type, 'error')
  assert.equal(refused.code, 'lease/stale-epoch')
  await socket.close()
})

test('checking a lease that does not exist is refused rather than granted', async (t) => {
  const { hub, alice, workgroupId } = await scene(t)
  const socket = connect(hub, alice)
  await socket.hello()
  const from = socket.cursor
  socket.send({ type: 'lease.check', workgroupId })
  const refused = await socket.next(message => message.type === 'lease.ok' || message.type === 'error', { from })
  assert.equal(refused.type, 'error')
  assert.equal(refused.code, 'lease/none')
  await socket.close()
})

test('an expired lease is not a licence to commit', async (t) => {
  const { hub, alice, workgroupId } = await scene(t)
  await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 1000 }, { token: alice.token })
  hub.clock.advanceBy(5000)

  const socket = connect(hub, alice)
  await socket.hello()
  const from = socket.cursor
  socket.send({ type: 'lease.check', workgroupId, epoch: 1 })
  const refused = await socket.next(message => message.type === 'lease.ok' || message.type === 'error', { from })
  assert.equal(refused.type, 'error')
  // Still the holder, but the lease lapsed: a round cannot claim to be the coordinator after its
  // window closed, or a hung client would keep the group forever.
  assert.equal(refused.code, 'lease/expired')
  await socket.close()
})

test('only the holder may release, and a release lets another device take it', async (t) => {
  const { hub, alice, bob, workgroupId } = await scene(t)
  await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 60_000 }, { token: alice.token })

  const byOther = await hub.post(`/v1/workgroups/${workgroupId}/lease/release`, undefined, { token: bob.token })
  assert.equal(byOther.status, 403)

  const released = await hub.post(`/v1/workgroups/${workgroupId}/lease/release`, undefined, { token: alice.token })
  assert.equal(released.status, 200, JSON.stringify(released.body))

  const taken = await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 60_000 }, { token: bob.token })
  assert.equal(taken.status, 200)
  // The epoch still moves forward after a release, so an in-flight round from the previous holder is
  // fenced out rather than racing the new one.
  assert.equal(taken.body.lease.epoch, 2)
})

test('a lease cannot be taken in a group the caller is not in', async (t) => {
  const { hub, workgroupId, alice } = await scene(t)
  const outsider = await (await import('./g4-helpers.js')).person(hub, { phone: '+8613600136000', name: 'Outsider' })
  const refused = await hub.post(`/v1/workgroups/${workgroupId}/lease`, { leaseMs: 60_000 }, { token: outsider.token })
  assert.equal(refused.status, 404, 'a group the caller cannot see is reported as missing')
  // And the owner's view of it is unchanged.
  assert.equal((await hub.get(`/v1/workgroups/${workgroupId}/lease`, { token: alice.token })).body.lease, null)
})
