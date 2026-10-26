// G6R: the original memory engine stays the only writer, and this domain only carries its changes.
//
// One machine is enough to prove the adapter's boundary: a group write becomes one `memory.change`
// addressed by the Hub group id, private/team/local-group writes become nothing, a remote change lands
// in the ORIGINAL store and is idempotent, and deleting the group archives that same store.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { startRoundFixture } from './workgroup-round.test.js'

const twoMembers = () => ([
  { id: 'bot-a', kind: 'localBot', name: 'Writer' },
  { id: 'bot-b', kind: 'localBot', name: 'Editor' },
])

const memoryFile = (home, roomId) => join(home, 'memory', 'groups', roomId, 'MEMORY.md')

// The group is on the Hub (has a hubWorkgroupId), and the member Session is registered the way the
// round path registers it. Nothing else about the Hub is needed: the adapter's transport is replaced
// by recording calls, because this file is about what the adapter chooses to send.
async function linkedFixture(t) {
  const fixture = startRoundFixture()
  t.after(fixture.stop)
  const { wg, rt } = fixture
  const room = await wg.createWorkgroup({
    name: 'MemorySync',
    members: twoMembers(),
    adminId: 'bot-a',
    hubWorkgroupId: 'wg_hub_memory_sync',
  })
  rt.state.bots['bot-a'] = { id: 'bot-a', name: 'Writer', role: 'Writer', instructions: 'Write', model: 'deepseek/v4', createdAt: 1 }
  rt.state.mainBotIds = ['bot-a']
  rt.state.bots['bot-b'] = { id: 'bot-b', name: 'Editor', role: 'Editor', instructions: 'Edit', model: 'deepseek/v4', createdAt: 2 }
  const member = room.members[0]
  const session = await wg.sessionFor(room, member)
  assert.ok(session?.id !== undefined)
  const sent = []
  wg.bridge = {
    status: () => ({ connected: true }),
    sendEvent: async (frame) => { sent.push(frame); return { queued: false, eventId: frame.eventId } },
  }
  // Deletion asks the Hub before touching the local room. This file replaces the transport above,
  // so it must also stand in for the one call deletion makes. It records nothing: deletion is not a
  // second memory path.
  wg.hub.deleteWorkgroup = async () => ({ deleted: true })
  return { ...fixture, room, member, session: session.id, sent }
}

const remember = (ctx, text, session) =>
  ctx.registeredTools.get('remember').execute({ text }, { agent: { id: session } })

test('a group write becomes one memory.change keyed by the Hub group, not the local room', async (t) => {
  const { ctx, wg, room, session, sent } = await linkedFixture(t)
  assert.match(await remember(ctx, 'Ship on Friday', session), /^Saved to the group memory/)

  assert.equal(sent.length, 1, 'the write is reported exactly once')
  const [frame] = sent
  assert.equal(frame.frameType, 'memory.change')
  assert.equal(frame.workgroupId, 'wg_hub_memory_sync')
  assert.match(frame.eventId, /^mev_[0-9a-f]{32}$/)
  assert.equal(frame.payload.roomKey, wg.workgroupOf(room.id).hubWorkgroupId, 'roomKey is the Hub id')
  assert.notEqual(frame.payload.roomKey, room.id, 'roomKey must not be this machine\'s room id')
  assert.equal(frame.payload.op, 'add')
  assert.equal(frame.payload.topic, null)
  assert.equal(frame.payload.before, null)
  assert.match(frame.payload.after, /^- Ship on Friday \[source: /)
  assert.deepEqual(frame.payload.actor, { id: 'bot-a', name: 'Writer' })
  assert.equal(typeof frame.payload.at, 'string')
  assert.equal(Number.isNaN(Date.parse(frame.payload.at)), false)
})

test('private, team and local-group writes are never uploaded', async (t) => {
  const { ctx, wg, room, session, sent } = await linkedFixture(t)
  assert.match(await ctx.registeredTools.get('remember').execute(
    { text: 'Prefers tea', scope: 'own' },
    { agent: { id: session } },
  ), /^Saved to your memory/)
  assert.match(await ctx.registeredTools.get('remember').execute(
    { text: 'Use pnpm', scope: 'team' },
    { agent: { id: session } },
  ), /^Saved to the team memory/)
  assert.deepEqual(sent, [], 'private and team memory stay on this machine')

  // A local group has no hubWorkgroupId, so its memory is local by definition.
  const local = await wg.createWorkgroup({ name: 'LocalOnly', members: twoMembers(), adminId: 'bot-a' })
  const localSession = await wg.sessionFor(local, local.members[0])
  assert.match(await remember(ctx, 'Local fact', localSession.id), /^Saved to the group memory/)
  assert.deepEqual(sent, [], 'a workgroup without a Hub id is not uploaded')
  assert.equal(existsSync(memoryFile(wg.rt.home, local.id)), true, 'but it is still the original local store')

  // A disconnected Hub also sends nothing; the write itself still succeeds.
  wg.bridge.status = () => ({ connected: false })
  assert.match(await remember(ctx, 'Written offline', session), /^Saved to the group memory/)
  assert.deepEqual(sent, [])
  assert.equal(readFileSync(memoryFile(wg.rt.home, room.id), 'utf8').includes('Written offline'), true)
})

test('a remote change lands in the original store once, even when the Hub replays it', async (t) => {
  const { rt, room, sent } = await linkedFixture(t)
  const change = {
    eventId: 'mev_remote_sync_1',
    roomId: room.id,
    op: 'add',
    topic: null,
    before: null,
    after: '- Ship on Friday [source: group "MemorySync" 2026-10-24; by: Writer; added: 2026-10-24]',
    actor: { id: 'bot-a', name: 'Writer' },
  }
  const first = await rt.applyRemoteMemoryChange(change)
  assert.equal(first.changed, true)
  assert.match(await rt.memoryEndpoint('memory-view', { roomId: room.id })
    .then(view => view.entries.map(entry => entry.text).join('\n')), /Ship on Friday/)
  assert.deepEqual(await rt.applyRemoteMemoryChange(change), { changed: false, reason: 'duplicate' })
  const view = await rt.memoryEndpoint('memory-view', { roomId: room.id })
  assert.equal(view.entries.filter(entry => entry.text.includes('Ship on Friday')).length, 1)
  assert.deepEqual(sent, [], 'applying a remote event does not echo it back')
})

test('deleting the workgroup archives the original memory folder exactly once', async (t) => {
  const { ctx, wg, room, session, home } = await linkedFixture(t)
  assert.match(await remember(ctx, 'Ship on Friday', session), /^Saved to the group memory/)
  const dir = join(home, 'memory', 'groups', room.id)
  assert.equal(existsSync(dir), true)

  await wg.deleteWorkgroup(room.id)
  assert.equal(existsSync(dir), false, 'the group folder is gone')
  const archives = readdirSync(join(home, 'memory', 'archive')).filter(name => name.startsWith(`group-${room.id}-`))
  assert.equal(archives.length, 1, 'it was moved into the original archive, once')
  assert.match(readFileSync(join(home, 'memory', 'archive', archives[0], 'MEMORY.md'), 'utf8'), /Ship on Friday/)
})

test('a memory change from the other machine resolves the writer before applying it', async (t) => {
  const { rt, wg, room } = await linkedFixture(t)
  const applied = []
  const original = rt.applyRemoteMemoryChange
  rt.applyRemoteMemoryChange = async (change) => {
    applied.push(change)
    return original(change)
  }
  t.after(() => { rt.applyRemoteMemoryChange = original })

  // A Bot: the Hub sender names its endpoint, and this machine's roster maps it to the remote member.
  wg.workgroupOf(room.id).members.push({ id: 'ep_remote_writer', kind: 'remoteBot', name: 'Writer', endpointId: 'ep_remote_writer' })
  await wg.onMemoryEvent({
    workgroupId: room.hubWorkgroupId,
    event: {
      eventId: 'mev_identity_bot', type: 'memory.change', sender: { userId: 'usr_remote', deviceId: 'dev_remote', botEndpointId: 'ep_remote_writer' },
      payload: {
        roomKey: room.hubWorkgroupId, op: 'add', topic: null, before: null,
        after: '- Remote Bot fact [source: test; added: 2026-10-24]', actor: { id: 'a2', name: 'Writer' },
      },
    },
  })
  assert.equal(applied.at(-1).actor.id, 'ep_remote_writer', 'the remote endpoint is the local member id')

  // A person: no endpoint, resolved by the authenticated Hub user id.
  wg.workgroupOf(room.id).members.push({ id: 'usr_remote', kind: 'user', name: 'Bob', hubUserId: 'usr_remote' })
  await wg.onMemoryEvent({
    workgroupId: room.hubWorkgroupId,
    event: {
      eventId: 'mev_identity_user', type: 'memory.change', sender: { userId: 'usr_remote', deviceId: 'dev_remote' },
      payload: {
        roomKey: room.hubWorkgroupId, op: 'add', topic: null, before: null,
        after: '- Remote user fact [source: test; added: 2026-10-24]', actor: { id: 'user', name: 'user' },
      },
    },
  })
  assert.equal(applied.at(-1).actor.id, 'usr_remote', 'a person resolves through the Hub user id')

  // An unresolvable sender is dropped before the engine, not applied under a guessed identity.
  const count = applied.length
  await wg.onMemoryEvent({
    workgroupId: room.hubWorkgroupId,
    event: {
      eventId: 'mev_identity_unknown', type: 'memory.change', sender: { userId: 'usr_stranger', deviceId: 'dev_x' },
      payload: { roomKey: room.hubWorkgroupId, op: 'add', topic: null, before: null, after: '- Unknown', actor: { id: 'user', name: 'user' } },
    },
  })
  assert.equal(applied.length, count)
})

test('the transport counters survive a state file reload', async (t) => {
  const first = startRoundFixture()
  t.after(first.stop)
  await first.wg.load()
  first.wg.memorySyncState('wg_persisted')
  first.wg.state.memorySync.wg_persisted = { lastSentAt: 11, lastAppliedAt: 22, applied: 3 }
  await first.wg.save()
  await first.wg.flushSave()

  // A second runtime reads the same workgroup state file. `load()` is intentionally cached on one
  // runtime, so a fresh domain is the honest test of persistence.
  const second = startRoundFixture()
  t.after(second.stop)
  const copied = JSON.parse(readFileSync(first.wg.statePath, 'utf8'))
  mkdirSync(dirname(second.wg.statePath), { recursive: true })
  writeFileSync(second.wg.statePath, JSON.stringify(copied))
  await second.wg.load()
  assert.deepEqual(second.wg.state.memorySync, {
    wg_persisted: { lastSentAt: 11, lastAppliedAt: 22, applied: 3 },
  })
})
