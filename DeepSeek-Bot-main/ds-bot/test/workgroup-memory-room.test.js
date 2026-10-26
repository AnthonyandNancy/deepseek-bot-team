// G6R keeps the original memory engine and fills only its room lookup for workgroup members.
//
// The original review gate asks `rt.isBotSession`. A workgroup member's Session is owned by this
// domain and deliberately not in the original index — changing that predicate would make the
// original turn machinery manage a foreign Session. The seam answers the narrower question.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startRoundFixture } from './workgroup-round.test.js'

const twoMembers = () => ([
  { id: 'bot-a', kind: 'localBot', name: 'Writer' },
  { id: 'bot-b', kind: 'localBot', name: 'Editor' },
])

test('a workgroup member Session is eligible for a memory review, and the relay is not', async (t) => {
  const { ctx, wg, rt, stop } = startRoundFixture()
  t.after(stop)
  await rt.load()
  rt.state.bots['bot-a'] = { id: 'bot-a', name: 'Writer', role: 'Writer', instructions: 'Write', model: 'deepseek/v4', createdAt: 1 }
  rt.state.bots['bot-b'] = { id: 'bot-b', name: 'Editor', role: 'Editor', instructions: 'Edit', model: 'deepseek/v4', createdAt: 2 }
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

  // The seam is what makes the ORIGINAL group-memory prompt section appear. A Bot view must never
  // receive one, which is the isolation the original already guarantees for a Bot with no group.
  assert.match(ctx.sections.get('bot-memory').text({ agent: { id: memberSession.id } }),
    /## Group memory, shared by the members of this group chat/)
  assert.doesNotMatch(ctx.sections.get('bot-memory').text({ agent: { id: 'bot-a' } }),
    /## Group memory/)
})
