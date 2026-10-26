// G6R across two real machines: A uses the ORIGINAL remember tool, B's ORIGINAL memory panel sees the
// entry without a manual refresh, and B stops receiving after the person leaves the group.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invitedPair, roomOf, until } from './helpers-pair.js'

const entryTexts = async (machine, roomId) => {
  const view = await machine.rt.memoryEndpoint('memory-view', { roomId })
  return view.entries.map(entry => entry.text)
}

test('a group entry written with the original remember tool reaches the other machine', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  const aliceRoom = roomOf(alice, workgroupId)
  const bobRoom = roomOf(bob, workgroupId)
  assert.ok(aliceRoom !== undefined && bobRoom !== undefined)
  assert.notEqual(aliceRoom.id, bobRoom.id, 'each machine keeps its own original memory folder')

  const member = aliceRoom.members.find(entry => entry.kind === 'localBot')
  const session = await alice.wg.sessionFor(aliceRoom, member)
  const said = await alice.ctx.registeredTools.get('remember').execute(
    { text: 'Ship on Friday' },
    { agent: { id: session.id } },
  )
  assert.match(said, /^Saved to the group memory/)

  await until(async () => (await entryTexts(bob, bobRoom.id)).includes('Ship on Friday'),
    { label: "Bob's original group memory to receive the entry", timeoutMs: 12000 })
  assert.deepEqual(await entryTexts(bob, bobRoom.id), ['Ship on Friday'])
})

test('a person who leaves stops receiving later group memory changes', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  const aliceRoom = roomOf(alice, workgroupId)
  const bobRoom = roomOf(bob, workgroupId)
  const member = aliceRoom.members.find(entry => entry.kind === 'localBot')
  const session = await alice.wg.sessionFor(aliceRoom, member)
  const remember = text => alice.ctx.registeredTools.get('remember').execute(
    { text },
    { agent: { id: session.id } },
  )

  assert.match(await remember('Before leaving'), /^Saved to the group memory/)
  await until(async () => (await entryTexts(bob, bobRoom.id)).includes('Before leaving'),
    { label: "Bob's memory to receive the first entry", timeoutMs: 12000 })

  // Bob leaves the group himself. Memory belongs to the group and is delivered to every member
  // account, not to one Bot, so removing only his Bot would leave him — correctly — a recipient.
  const roster = await bob.call('group-members', { workgroupId })
  assert.equal(roster.ok, true, JSON.stringify(roster.error))
  const account = await bob.wg.hub.restore()
  const bobUser = roster.value.members.find(entry => entry.memberType === 'user' && entry.userId === account.hubUserId)
  assert.ok(bobUser !== undefined, 'Bob sees his own account membership')
  await bob.wg.hub.leaveMember({ workgroupId, membershipId: bobUser.membershipId })
  await alice.wg.syncRoster({ hubWorkgroupId: workgroupId })

  assert.match(await remember('After leaving'), /^Saved to the group memory/)
  // Give the Hub and the socket a real chance to deliver; absence is asserted after a bounded wait,
  // not immediately (a late frame would otherwise pass).
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal((await entryTexts(bob, bobRoom.id)).includes('After leaving'), false,
    'a device no longer in the group receives no later memory change')
})
