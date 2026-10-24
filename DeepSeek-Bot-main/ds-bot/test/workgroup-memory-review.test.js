// The memory review must see a workgroup member Session (G6, plan Task 6).
//
// The original's review gate asks `rt.isBotSession`. A workgroup member is a Bot, but its Session is
// owned by this domain and is deliberately not in the original index — changing that predicate
// would make the original's turn machinery manage a foreign Session. The fix is a narrow read-only
// seam that answers "which workgroup does this member Session speak in", while the relay Session
// answers undefined.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startRoundFixture } from './workgroup-round.test.js'

const twoMembers = () => ([
  { id: 'bot-a', kind: 'localBot', name: 'Writer' },
  { id: 'bot-b', kind: 'localBot', name: 'Editor' },
])

test('a workgroup member Session is eligible for a memory review, and the relay is not', async (t) => {
  const { wg, rt, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: 'ReviewProbe', members: twoMembers(), adminId: 'bot-a' })
  const memberSession = await wg.sessionFor(room, room.members[0])
  assert.ok(memberSession?.id !== undefined)

  assert.equal(typeof rt.memoryRoomOf, 'function', 'memory needs a workgroup-aware room lookup')
  assert.equal(rt.memoryRoomOf(memberSession.id), room.id, 'a member Session resolves to its group')
  // The group's own relay Session is not a participant: reviewing it would create memory for a
  // speaker that does not exist.
  assert.equal(rt.memoryRoomOf(room.id), undefined)
  assert.equal(rt.memoryRoomOf(undefined), undefined)

  // The original predicate stays untouched. The gate must add the seam rather than redefine what a
  // Bot Session is for the original turn machinery.
  assert.equal(rt.isBotSession(memberSession.id), false)
})

test('deleting a workgroup archives its local memory and removes the Hub entries', async (t) => {
  const { wg, rt, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: 'DeleteProbe', members: twoMembers(), adminId: 'bot-a' })

  const archived = []
  const original = rt.archiveGroupMemory
  rt.archiveGroupMemory = (value) => {
    archived.push(value)
    return Promise.resolve()
  }
  t.after(() => { rt.archiveGroupMemory = original })

  await wg.deleteWorkgroup(room.id)
  assert.equal(archived.length, 1, 'deleteWorkgroup must archive group memory exactly once')
  assert.equal(archived[0].id, room.id, 'it archives the record being deleted, before the record is dropped')
  assert.equal(wg.workgroupOf(room.id), undefined, 'and the local record is still removed')
})
