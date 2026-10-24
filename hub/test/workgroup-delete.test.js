// Deleting a group, and an owner leaving one.
//
// Both come from one report about the desktop app: 「删除工作群，采取本应用后又出现了，反而本地群不会」
// — the deleted group came back on the next start. The workgroup lives on the Hub, so deleting it
// only on the machine that asked left it in the Hub's list, and the client re-adopts every group it
// finds there. The Hub had no way to delete a group at all: `discard` only withdraws one that never
// held a message (it serves a failed upgrade).
//
// The owner also could not leave a group (`workgroup/owner-cannot-leave`), because a group with no
// owner has nobody who can invite. The product decision was to hand leadership to the next person
// instead, so an owner can leave without leaving an ownerless group behind.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startHub, PHONE_A, PHONE_B, PASSWORD } from './helpers.js'
import { person, groupWith } from './g4-helpers.js'

const twoInAGroup = async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const alice = await person(hub, { phone: PHONE_A, name: 'Alice' })
  const bob = await person(hub, { phone: PHONE_B, name: 'Bob' })
  const { workgroupId } = await groupWith(hub, { owner: alice, others: [bob] })
  return { hub, alice, bob, workgroupId }
}

const listed = async (hub, person) => {
  const answer = await hub.get('/v1/workgroups', { token: person.token })
  assert.equal(answer.status, 200, JSON.stringify(answer.body))
  return (answer.body.workgroups ?? []).map(group => group.workgroupId)
}

const membershipOf = async (hub, person, workgroupId) => {
  const answer = await hub.get(`/v1/workgroups/${workgroupId}`, { token: person.token })
  const mine = (answer.body.members ?? []).find(member => member.userId === person.userId)
  return mine
}

test('the owner deletes a group: it is gone from every member\'s list, not just their own', async (t) => {
  const { hub, alice, bob, workgroupId } = await twoInAGroup(t)
  assert.ok((await listed(hub, alice)).includes(workgroupId), 'the owner starts in the group')
  assert.ok((await listed(hub, bob)).includes(workgroupId), 'and so does the other member')

  const deleted = await hub.post(`/v1/workgroups/${workgroupId}/delete`, {}, { token: alice.token })
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  assert.equal(deleted.body.deleted, true)

  // The reported symptom was that the group kept coming back. What made it come back is a LIST that
  // still contains it, so the list is what this asserts.
  assert.deepEqual(await listed(hub, alice), [], 'gone from the owner\'s list')
  assert.deepEqual(await listed(hub, bob), [], 'and from everyone else\'s — deleting is not leaving')

  // Reading it by id is a 404 rather than an empty group: nothing is left to read.
  const after = await hub.get(`/v1/workgroups/${workgroupId}`, { token: alice.token })
  assert.equal(after.status, 404, JSON.stringify(after.body))
})

test('only the owner may delete a group', async (t) => {
  const { hub, bob, workgroupId } = await twoInAGroup(t)
  const refused = await hub.post(`/v1/workgroups/${workgroupId}/delete`, {}, { token: bob.token })
  assert.equal(refused.status, 403, JSON.stringify(refused.body))
  assert.equal(refused.body.error?.code ?? refused.body.code, 'workgroup/not-owner')
  // And the attempt changed nothing.
  assert.ok((await listed(hub, bob)).includes(workgroupId))
})

test('a group that is not there is reported as missing, not as forbidden', async (t) => {
  const { hub, alice } = await twoInAGroup(t)
  const missing = await hub.post('/v1/workgroups/wg_nothingHere/delete', {}, { token: alice.token })
  // "Forbidden" would confirm to a stranger that the id exists.
  assert.equal(missing.status, 404, JSON.stringify(missing.body))
})

test('the owner can leave, and leadership passes to the next person', async (t) => {
  const { hub, alice, bob, workgroupId } = await twoInAGroup(t)
  const mine = await membershipOf(hub, alice, workgroupId)
  assert.equal(mine.role, 'owner', 'the creator is the owner')

  const left = await hub.post(`/v1/workgroups/${workgroupId}/members/${mine.membershipId}/leave`, {}, { token: alice.token })
  assert.equal(left.status, 200, JSON.stringify(left.body))

  // The point of handing over: the group still has an owner, so somebody can still invite.
  const heir = await membershipOf(hub, bob, workgroupId)
  assert.equal(heir.role, 'owner', 'the remaining person now leads the group')

  assert.deepEqual(await listed(hub, alice), [], 'the owner who left no longer has the group')
  assert.deepEqual(await listed(hub, bob), [workgroupId], 'and the group still exists for the others')

  // The heir really holds the power the role carries, not just the label: an invite needs an admin
  // or the owner on this Hub, so a registered third person is the only honest way to ask.
  const carol = await person(hub, { phone: '+8613800137777', name: 'Carol' })
  const invited = await hub.post(`/v1/workgroups/${workgroupId}/invites`, { phone: carol.phone }, { token: bob.token })
  assert.equal(invited.status, 201, JSON.stringify(invited.body))
})

test('the last person cannot leave: they delete the group instead', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const alice = await person(hub, { phone: PHONE_A, name: 'Alice' })
  // A group with one person in it. `groupWith` needs a second, so this creates it directly.
  const created = await hub.post('/v1/workgroups', { name: '只有我' }, { token: alice.token })
  const workgroupId = created.body.workgroupId
  const mine = await membershipOf(hub, alice, workgroupId)

  const refused = await hub.post(`/v1/workgroups/${workgroupId}/members/${mine.membershipId}/leave`, {}, { token: alice.token })
  assert.equal(refused.status, 409, JSON.stringify(refused.body))
  assert.equal(refused.body.error?.code ?? refused.body.code, 'workgroup/last-member')
  // Refused means nothing changed — a group is never left ownerless.
  assert.ok((await listed(hub, alice)).includes(workgroupId))
})
