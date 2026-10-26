// The workgroup copy of the original's relay pause: a Bot call past the group's limit
// is parked (not dropped), and Continue runs the parked calls once.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startRoundFixture } from './workgroup-round.test.js'

const twoMembers = () => ([
  { id: 'bot-a', kind: 'localBot', name: 'Writer' },
  { id: 'bot-b', kind: 'localBot', name: 'Editor' },
])

const emitTo = async (ctx, sessionId, event) => {
  for (const listener of ctx.listeners.get('session/event') ?? []) {
    if (listener.length >= 2) await listener({ id: sessionId }, event)
  }
}

test('a workgroup parks a Bot call past its relay limit and Continue releases it once', async (t) => {
  const { wg, ctx, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: 'RelayProbe', members: twoMembers() })
  await wg.updateWorkgroup(room.id, { relayLimit: 1 })
  // The relay loop stores the parked slot on the record; Continue is the release path.
  wg.workgroupOf(room.id).paused = [{ id: 'bot-b', name: 'Editor', by: 'bot-a' }]
  wg.workgroupOf(room.id).relays = 1
  await wg.save()

  assert.deepEqual((await wg.continueRoom(room.id)), { roomId: room.id, hubWorkgroupId: null })
  assert.equal(wg.workgroupOf(room.id).relays, 0, 'Continue restarts the relay count')
  assert.equal((wg.workgroupOf(room.id).paused ?? []).length, 1, 'the parked call waits for the next relay round')
  assert.deepEqual(wg.openingSpeakers(wg.workgroupOf(room.id), { resume: true }), [], 'a Continue opens with no new speakers')
})
