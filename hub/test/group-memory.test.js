// Group memory over the public Hub surface (plan §11–§13; gate V1 and T18).
//
// These tests never call the memory service directly: every step is an HTTP request a plugin
// would make. The assertions are about what another member can read, what a correction does to a
// stale writer, and what remains on disk after a deletion.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startHub, PHONE_A, PHONE_B, PASSWORD } from './helpers.js'
import { person, groupWith, connect } from './g4-helpers.js'

const CAROL_PHONE = '+8613700137000'

async function memoryScene(t) {
  const hub = await startHub()
  t.after(async () => { await hub.close() })
  const alice = await person(hub, { phone: PHONE_A, name: 'Alice' })
  const bob = await person(hub, { phone: PHONE_B, name: 'Bob' })
  const carol = await person(hub, { phone: CAROL_PHONE, name: 'Carol' })
  const { workgroupId } = await groupWith(hub, { owner: alice, others: [bob] })
  return { hub, alice, bob, carol, workgroupId }
}

async function createMemory(hub, who, workgroupId, body = {}) {
  return hub.post(`/v1/workgroups/${workgroupId}/memories`, {
    type: 'fact',
    content: 'The budget closes on the 25th.',
    sourceRefs: [],
    acl: [],
    ...body,
  }, { token: who.token })
}

const membershipOf = async (hub, who, workgroupId) => {
  const answer = await hub.get(`/v1/workgroups/${workgroupId}`, { token: who.token })
  return (answer.body.members ?? []).find(member => member.userId === who.userId)
}

test('a non-member cannot read or search a group memory, and a member cannot read it when not in the ACL', async (t) => {
  const { hub, alice, bob, carol, workgroupId } = await memoryScene(t)
  const created = await createMemory(hub, alice, workgroupId, { acl: [alice.userId] })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const memoryId = created.body.memory.memoryId

  const ownerList = await hub.get(`/v1/workgroups/${workgroupId}/memories`, { token: alice.token })
  assert.equal(ownerList.status, 200)
  assert.equal(ownerList.body.memories.some(entry => entry.memoryId === memoryId), true)

  // Bob is a member but is not named in the ACL. The ACL is an explicit list, not a claim that
  // every member may read every row.
  const bobList = await hub.get(`/v1/workgroups/${workgroupId}/memories`, { token: bob.token })
  assert.equal(bobList.status, 200)
  assert.deepEqual(bobList.body.memories, [])
  const bobSearch = await hub.get(`/v1/workgroups/${workgroupId}/memories/search?q=budget`, { token: bob.token })
  assert.equal(bobSearch.status, 200)
  assert.deepEqual(bobSearch.body.memories, [])

  // Carol is outside the group. Missing and unauthorized answer the same 404, so ids cannot be probed.
  const outsider = await hub.get(`/v1/workgroups/${workgroupId}/memories`, { token: carol.token })
  assert.equal(outsider.status, 404)
  assert.equal(outsider.body.error.code, 'workgroup/not-found')
  const outsiderSearch = await hub.get(`/v1/workgroups/${workgroupId}/memories/search?q=budget`, { token: carol.token })
  assert.equal(outsiderSearch.status, 404)
})

test('the creator is always in the ACL and an ACL cannot name an outsider', async (t) => {
  const { hub, alice, bob, carol, workgroupId } = await memoryScene(t)
  const created = await createMemory(hub, alice, workgroupId, { acl: [bob.userId] })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.deepEqual(created.body.memory.acl.sort(), [alice.userId, bob.userId].sort())

  const refused = await createMemory(hub, alice, workgroupId, { content: 'not for Carol', acl: [carol.userId] })
  assert.equal(refused.status, 400, JSON.stringify(refused.body))
  assert.equal(refused.body.error.code, 'memory/acl-not-in-group')

  const bobList = await hub.get(`/v1/workgroups/${workgroupId}/memories`, { token: bob.token })
  assert.equal(bobList.body.memories.some(entry => entry.memoryId === created.body.memory.memoryId), true)
})

test('a correction based on an old version is refused and changes nothing', async (t) => {
  const { hub, alice, workgroupId } = await memoryScene(t)
  const created = await createMemory(hub, alice, workgroupId)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const memoryId = created.body.memory.memoryId

  const first = await hub.post(`/v1/workgroups/${workgroupId}/memories/${memoryId}/correct`, {
    content: 'The budget closes on the 26th.', expectedVersion: 1,
  }, { token: alice.token })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.memory.version, 2)

  const stale = await hub.post(`/v1/workgroups/${workgroupId}/memories/${memoryId}/correct`, {
    content: 'old overwrite', expectedVersion: 1,
  }, { token: alice.token })
  assert.equal(stale.status, 409, JSON.stringify(stale.body))
  assert.equal(stale.body.error.code, 'memory/version-conflict')

  const listed = await hub.get(`/v1/workgroups/${workgroupId}/memories`, { token: alice.token })
  assert.equal(listed.body.memories.find(entry => entry.memoryId === memoryId).content,
    'The budget closes on the 26th.')
  const audit = hub.hub.db.prepare('SELECT action, version FROM group_memory_events WHERE memory_id = ? ORDER BY at').all(memoryId)
  assert.deepEqual(audit.map(row => [row.action, row.version]), [['created', 1], ['corrected', 2]])
})

test('a deleted memory disappears from search but keeps its audit row and version', async (t) => {
  const { hub, alice, workgroupId } = await memoryScene(t)
  const created = await createMemory(hub, alice, workgroupId, {
    type: 'decision', content: 'Deploy uses the blue green switch',
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const memoryId = created.body.memory.memoryId

  const gone = await hub.post(`/v1/workgroups/${workgroupId}/memories/${memoryId}/delete`, {
    expectedVersion: 1,
  }, { token: alice.token })
  assert.equal(gone.status, 200, JSON.stringify(gone.body))
  assert.equal(gone.body.memory.version, 2)

  const found = await hub.get(`/v1/workgroups/${workgroupId}/memories/search?q=blue%20green`, { token: alice.token })
  assert.deepEqual(found.body.memories, [])
  const listed = await hub.get(`/v1/workgroups/${workgroupId}/memories`, { token: alice.token })
  assert.deepEqual(listed.body.memories, [])

  const audit = hub.hub.db.prepare('SELECT action, version FROM group_memory_events WHERE memory_id = ? ORDER BY at').all(memoryId)
  assert.deepEqual(audit.map(row => [row.action, row.version]), [['created', 1], ['deleted', 2]])
  const row = hub.hub.db.prepare('SELECT deleted_at FROM group_memories WHERE id = ?').get(memoryId)
  assert.notEqual(row.deleted_at, null, 'a delete is a soft delete, not a vanished row')
})

test('credential-shaped content is refused and source refs must point into this group', async (t) => {
  const { hub, alice, workgroupId } = await memoryScene(t)
  const secret = await createMemory(hub, alice, workgroupId, {
    content: 'api_key = sk-live-this-must-not-be-stored',
  })
  assert.equal(secret.status, 400, JSON.stringify(secret.body))
  assert.equal(secret.body.error.code, 'memory/credential-like')

  const bogus = await createMemory(hub, alice, workgroupId, {
    content: 'The budget closes on the 25th.',
    sourceRefs: [{ kind: 'message', id: 'evt_not_in_this_group' }],
  })
  assert.equal(bogus.status, 400, JSON.stringify(bogus.body))
  assert.equal(bogus.body.error.code, 'memory/source-not-in-group')
})

test('memory events fan out on the existing sequence without counting as unread', async (t) => {
  const { hub, alice, bob, workgroupId } = await memoryScene(t)
  const socket = connect(hub, bob)
  t.after(async () => { await socket.close() })
  await socket.hello()

  const before = await hub.get(`/v1/workgroups/${workgroupId}`, { token: bob.token })
  const created = await createMemory(hub, alice, workgroupId, {
    type: 'canon', content: 'Every invoice needs a PO number.', acl: [bob.userId],
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const frame = await socket.next(message => message.type === 'event' && message.event.type === 'memory.created')
  assert.equal(frame.event.payload.memoryId, created.body.memory.memoryId)
  assert.ok(Number.isInteger(frame.event.seq) && frame.event.seq > 0, 'a memory event takes the normal seq')

  const after = await hub.get(`/v1/workgroups/${workgroupId}`, { token: bob.token })
  assert.equal(after.body.unreadCount, before.body.unreadCount, 'memory is not an unread chat message')
})

test('a member who left stops reading and searching immediately', async (t) => {
  const { hub, alice, bob, workgroupId } = await memoryScene(t)
  const created = await createMemory(hub, alice, workgroupId, { acl: [bob.userId] })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const bobMembership = await membershipOf(hub, bob, workgroupId)
  assert.ok(bobMembership !== undefined)
  const left = await hub.post(`/v1/workgroups/${workgroupId}/members/${bobMembership.membershipId}/leave`, {}, { token: bob.token })
  assert.equal(left.status, 200, JSON.stringify(left.body))

  const list = await hub.get(`/v1/workgroups/${workgroupId}/memories`, { token: bob.token })
  assert.equal(list.status, 404)
  assert.equal(list.body.error.code, 'workgroup/not-found')
  const search = await hub.get(`/v1/workgroups/${workgroupId}/memories/search?q=budget`, { token: bob.token })
  assert.equal(search.status, 404)
  assert.equal(search.body.error.code, 'workgroup/not-found')
  // Alice, still a member, keeps reading the same row; leaving changed Bob's access, not the data.
  const still = await hub.get(`/v1/workgroups/${workgroupId}/memories`, { token: alice.token })
  assert.equal(still.body.memories.some(entry => entry.memoryId === created.body.memory.memoryId), true)
})

test('group deletion removes the Hub memory and audit rows, and a stale client cannot read them', async (t) => {
  const { hub, alice, workgroupId } = await memoryScene(t)
  const created = await createMemory(hub, alice, workgroupId)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const memoryId = created.body.memory.memoryId
  const deleted = await hub.post(`/v1/workgroups/${workgroupId}/delete`, {}, { token: alice.token })
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))

  const after = await hub.get(`/v1/workgroups/${workgroupId}/memories`, { token: alice.token })
  assert.equal(after.status, 404, 'the group is gone for every member')
  assert.equal(hub.hub.db.prepare('SELECT count(*) AS c FROM group_memories WHERE id = ?').get(memoryId).c, 0)
  assert.equal(hub.hub.db.prepare('SELECT count(*) AS c FROM group_memory_events WHERE memory_id = ?').get(memoryId).c, 0)
})

test('the same memory is readable after reopening the same database file, and only by the same members', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createHub } = await import('../src/server.js')
  const { createMemoryLogger } = await import('../src/log.js')
  const dataDir = mkdtempSync(join(tmpdir(), 'hub-g6-restart-'))
  const config = {
    host: '127.0.0.1', port: 0, tls: null, allowInsecure: true, insecureLoopbackOnly: true, dataDir,
    accessTtlMs: 30 * 60 * 1000, refreshTtlMs: 24 * 60 * 60 * 1000, logLevel: 'error',
  }
  const open = async () => {
    const hub = createHub({ config, logger: createMemoryLogger().logger })
    const address = await hub.listen()
    const base = `http://127.0.0.1:${address.port}`
    return { hub, base, config }
  }
  const first = await startHub({ dataDir })
  // `startHub.close()` deletes the data directory, which would make this test reopen an empty
  // database. The test owns the directory and removes it below.
  first.close = async () => { await first.hub.close() }
  let second
  t.after(async () => {
    await second?.close().catch(() => {})
    await first.close().catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 50))
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
  })
  const alice = await person(first, { phone: PHONE_A, name: 'Alice' })
  const bob = await person(first, { phone: PHONE_B, name: 'Bob' })
  const { workgroupId } = await groupWith(first, { owner: alice, others: [bob] })
  const created = await first.post(`/v1/workgroups/${workgroupId}/memories`, {
    type: 'fact', content: 'The budget closes on the 25th.', sourceRefs: [], acl: [bob.userId],
  }, { token: alice.token })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const memoryId = created.body.memory.memoryId
  await first.close()

  second = await startHub({ dataDir })
  second.close = async () => { await second.hub.close() }
  const alicesSecond = await second.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })
  const bobsSecond = await second.post('/v1/auth/login', { phone: PHONE_B, password: PASSWORD })
  assert.equal(alicesSecond.status, 200, JSON.stringify(alicesSecond.body))
  assert.equal(bobsSecond.status, 200, JSON.stringify(bobsSecond.body))
  const listed = await second.get(`/v1/workgroups/${workgroupId}/memories`, { token: bobsSecond.body.accessToken })
  assert.equal(listed.status, 200)
  assert.equal(listed.body.memories.some(entry => entry.memoryId === memoryId), true)
  const found = await second.get(`/v1/workgroups/${workgroupId}/memories/search?q=budget`, { token: bobsSecond.body.accessToken })
  assert.equal(found.status, 200)
  assert.equal(found.body.memories.some(entry => entry.memoryId === memoryId), true)

  const bobMembership = await membershipOf(second, { ...bob, token: bobsSecond.body.accessToken }, workgroupId)
  const left = await second.post(`/v1/workgroups/${workgroupId}/members/${bobMembership.membershipId}/leave`, {}, { token: bobsSecond.body.accessToken })
  assert.equal(left.status, 200, JSON.stringify(left.body))
  const denied = await second.get(`/v1/workgroups/${workgroupId}/memories`, { token: bobsSecond.body.accessToken })
  assert.equal(denied.status, 404)
  const deniedSearch = await second.get(`/v1/workgroups/${workgroupId}/memories/search?q=budget`, { token: bobsSecond.body.accessToken })
  assert.equal(deniedSearch.status, 404)
})


test('replaying the same memory.created event does not create a second entry', async (t) => {
  const { hub, alice, workgroupId } = await memoryScene(t)
  const body = {
    type: 'fact', content: 'The budget closes on the 25th.', sourceRefs: [], acl: [], eventId: 'evt_memory_replay_1',
  }
  const first = await hub.post(`/v1/workgroups/${workgroupId}/memories`, body, { token: alice.token })
  assert.equal(first.status, 201, JSON.stringify(first.body))
  const again = await hub.post(`/v1/workgroups/${workgroupId}/memories`, body, { token: alice.token })
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.equal(again.body.duplicate, true)
  assert.equal(again.body.memory.memoryId, first.body.memory.memoryId)

  const listed = await hub.get(`/v1/workgroups/${workgroupId}/memories`, { token: alice.token })
  assert.equal(listed.body.memories.filter(entry => entry.memoryId === first.body.memory.memoryId).length, 1)
  assert.equal(hub.hub.db.prepare('SELECT count(*) AS c FROM group_memories WHERE id = ?').get(first.body.memory.memoryId).c, 1)
  assert.equal(hub.hub.db.prepare('SELECT count(*) AS c FROM group_memory_events WHERE id = ?').get('memev_evt_memory_replay_1').c, 1)
})

test('group memory search never returns another group or a local private/team marker', async (t) => {
  const { hub, alice, bob, workgroupId } = await memoryScene(t)
  const other = await groupWith(hub, { owner: alice, others: [bob] })
  const mine = await createMemory(hub, alice, workgroupId, { content: 'GROUP_ONLY_7c1a budget closes' })
  const elsewhere = await createMemory(hub, alice, other.workgroupId, { content: 'OTHER_GROUP_9b2f budget closes' })
  assert.equal(mine.status, 201, JSON.stringify(mine.body))
  assert.equal(elsewhere.status, 201, JSON.stringify(elsewhere.body))

  const found = await hub.get(`/v1/workgroups/${workgroupId}/memories/search?q=budget`, { token: alice.token })
  assert.equal(found.status, 200)
  assert.deepEqual(found.body.memories.map(entry => entry.memoryId), [mine.body.memory.memoryId])
  assert.equal(JSON.stringify(found.body).includes('PRIVATE_ONLY_MARKER'), false)
  assert.equal(JSON.stringify(found.body).includes('TEAM_ONLY_MARKER'), false)
  assert.equal(found.body.memories.some(entry => entry.memoryId === elsewhere.body.memory.memoryId), false)
})
