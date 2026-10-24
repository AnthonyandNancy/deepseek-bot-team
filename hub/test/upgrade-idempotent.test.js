// Gate item 4: a failed upgrade retried does not create a second group.
//
// The gate's wording is "replay the same upgradeId N times, the Hub has one group, the client has
// one link". The Hub half is proven here, including the case that actually breaks naive
// implementations: N retries that arrive nearly simultaneously, so the check-then-insert race is
// exercised rather than assumed away. The client half (one local link) is proven in the plugin's
// own test, because it is the plugin that owns the local record.
//
// Acceptance case T10 is the same scenario seen from the user's side.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startHub, PHONE_A } from './helpers.js'
import { person } from './g4-helpers.js'

const setup = async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const alice = await person(hub, { phone: PHONE_A })
  return { hub, alice }
}

const groupsIn = hub => hub.hub.db.prepare('SELECT * FROM workgroups').all()

test('replaying one upgrade id ten times leaves exactly one group', async (t) => {
  const { hub, alice } = await setup(t)
  const body = { name: '费用汇总', notice: 'weekly', upgradeId: 'up-tenant-1' }

  const responses = []
  for (let attempt = 0; attempt < 10; attempt += 1) {
    responses.push(await hub.post('/v1/workgroups', body, { token: alice.token }))
  }

  assert.equal(groupsIn(hub).length, 1, 'ten retries, one group')
  const ids = new Set(responses.map(response => response.body.workgroupId))
  assert.equal(ids.size, 1, 'every retry answers with the same id')
  // Exactly one of the ten is the creator; the rest are replays that wrote nothing.
  assert.equal(responses.filter(response => response.body.created === true).length, 1)
  assert.equal(responses.filter(response => response.body.created === false).length, 9)
  // The owner membership is not duplicated either, which is the row a careless replay would add.
  assert.equal(hub.hub.db.prepare('SELECT count(*) AS c FROM memberships').get().c, 1)
})

test('retries that arrive together still make one group', async (t) => {
  const { hub, alice } = await setup(t)
  const body = { name: 'Concurrent', upgradeId: 'up-concurrent' }

  // Ten requests in flight at once: the pre-check in the service sees nothing for all of them, so
  // only the UNIQUE constraint stands between this and ten groups.
  const responses = await Promise.all(Array.from({ length: 10 }, () => hub.post('/v1/workgroups', body, { token: alice.token })))

  const ids = new Set(responses.map(response => response.body.workgroupId))
  assert.equal(ids.size, 1, `every concurrent retry must resolve to one id, got ${[...ids].join(', ')}`)
  assert.equal(groupsIn(hub).length, 1)
  // No 500s: a race is resolved, not surfaced as a crash.
  assert.deepEqual(responses.map(response => response.status).filter(status => status >= 500), [])
})

test('two different upgrades make two groups, each still one', async (t) => {
  const { hub, alice } = await setup(t)
  const one = await hub.post('/v1/workgroups', { name: 'A', upgradeId: 'up-a' }, { token: alice.token })
  const two = await hub.post('/v1/workgroups', { name: 'B', upgradeId: 'up-b' }, { token: alice.token })
  assert.notEqual(one.body.workgroupId, two.body.workgroupId)

  // Replaying each still resolves to its own group, so the keys did not collapse into one.
  const replayOne = await hub.post('/v1/workgroups', { name: 'A', upgradeId: 'up-a' }, { token: alice.token })
  const replayTwo = await hub.post('/v1/workgroups', { name: 'B', upgradeId: 'up-b' }, { token: alice.token })
  assert.equal(replayOne.body.workgroupId, one.body.workgroupId)
  assert.equal(replayTwo.body.workgroupId, two.body.workgroupId)
  assert.equal(groupsIn(hub).length, 2)
})

test('the replay is answered from the stored row, not from the request body', async (t) => {
  const { hub, alice } = await setup(t)
  const first = await hub.post('/v1/workgroups', { name: 'Original name', upgradeId: 'up-1' }, { token: alice.token })
  // A retry that renamed the group in flight — say the user edited the field before the first
  // response arrived — must not rewrite what was already created.
  const replay = await hub.post('/v1/workgroups', { name: 'Edited name', upgradeId: 'up-1' }, { token: alice.token })
  assert.equal(replay.body.workgroupId, first.body.workgroupId)
  assert.equal(replay.body.workgroup.name, 'Original name')
})

test('a retry after the group was deleted starts a new one, because the key went with it', async (t) => {
  const { hub, alice } = await setup(t)
  const first = await hub.post('/v1/workgroups', { name: 'Temp', upgradeId: 'up-temp' }, { token: alice.token })
  // Deleting the row deletes the key. That is deliberate: an upgrade that failed before anyone
  // saw it may be withdrawn, and the next attempt must be able to try again with the same key.
  hub.hub.db.prepare('DELETE FROM workgroups WHERE id = ?').run(first.body.workgroupId)

  const second = await hub.post('/v1/workgroups', { name: 'Temp', upgradeId: 'up-temp' }, { token: alice.token })
  assert.equal(second.status, 201)
  assert.equal(second.body.created, true)
  assert.notEqual(second.body.workgroupId, first.body.workgroupId)
})

test('a failed upgrade leaves nothing behind, so a retry is a first attempt', async (t) => {
  const { hub, alice } = await setup(t)
  // A body the Hub refuses: the transaction never opened, so no group, no membership, no key.
  const refused = await hub.post('/v1/workgroups', { name: 'Bad', upgradeId: 'up-retry', messages: [] }, { token: alice.token })
  assert.equal(refused.status, 400)

  const retried = await hub.post('/v1/workgroups', { name: 'Good', upgradeId: 'up-retry' }, { token: alice.token })
  assert.equal(retried.body.created, true, 'the retry is the first successful attempt')
  assert.equal(groupsIn(hub).length, 1)
  assert.equal(retried.body.workgroup.name, 'Good')
})

test('an upgrade with no id is not idempotent, and says so by creating each time', async (t) => {
  const { hub, alice } = await setup(t)
  // The guard is the id. A client that forgets one gets two groups, which the response makes
  // visible (`created: true` both times) rather than hiding.
  const one = await hub.post('/v1/workgroups', { name: 'No key' }, { token: alice.token })
  const two = await hub.post('/v1/workgroups', { name: 'No key' }, { token: alice.token })
  assert.equal(one.body.created, true)
  assert.equal(two.body.created, true)
  assert.equal(groupsIn(hub).length, 2)
})

test('an empty upgrade id is refused instead of silently becoming a duplicate key', (t) => {
  // An empty string would be a key shared by every such request. Refusing it is what keeps
  // "idempotent" from meaning "collapsed".
  return startHub().then(async (hub) => {
    t.after(() => hub.close())
    const alice = await person(hub, { phone: PHONE_A })
    const refused = await hub.post('/v1/workgroups', { name: 'Empty', upgradeId: '' }, { token: alice.token })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error.code, 'workgroup/invalid-field')
  })
})
