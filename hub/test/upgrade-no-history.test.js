// Gate item 3: local group history is never uploaded.
//
// The gate has two halves and this file proves both:
//
//   * the *request* an upgrade sends carries settings only — a name, a notice, an avatar, member
//     ids — and nothing that could hold a conversation. The Hub refuses such a body outright, so a
//     client bug cannot turn into an upload;
//   * the *result* is an empty Hub-side log. A group created by an upgrade has zero events, which
//     is the number the gate asks for ("the Hub side has 0 events for that group") and the only
//     thing that distinguishes "we did not upload" from "we uploaded and nobody looked".
//
// Acceptance case T10 ("upgrade a local group, retry on failure: one workgroup, old history kept
// and not uploaded") is covered here together with gate 4.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startHub, PHONE_A } from './helpers.js'
import { connect, person, say } from './g4-helpers.js'
import { HISTORY_KEYS } from '../src/workgroups/service.js'

const setup = async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const alice = await person(hub, { phone: PHONE_A })
  return { hub, alice }
}

// The body an honest client sends when upgrading a local group. Deliberately the *whole* body, so
// the negative test below can be read as a diff against it.
const upgradeBody = (upgradeId) => ({
  name: '费用汇总',
  notice: '每周五汇总',
  upgradeId,
})

test('an upgrade request carries settings only, and lands as an empty group', async (t) => {
  const { hub, alice } = await setup(t)
  const created = await hub.post('/v1/workgroups', upgradeBody('up-1'), { token: alice.token })
  assert.equal(created.status, 201)
  assert.equal(created.body.created, true)
  assert.equal(created.body.workgroup.lastSeq, 0, 'a freshly upgraded group has an empty log')

  // The gate's number: zero events on the Hub side for the upgraded group.
  const log = await hub.get(`/v1/workgroups/${created.body.workgroupId}/events`, { token: alice.token })
  assert.deepEqual(log.body.events, [])
  assert.equal(log.body.lastSeq, 0)
  const direct = hub.hub.db.prepare('SELECT count(*) AS c FROM events WHERE workgroup_id = ?').get(created.body.workgroupId).c
  assert.equal(direct, 0)
})

test('every key that could hold chat content is refused, not quietly dropped', async (t) => {
  const { hub, alice } = await setup(t)

  // One request per forbidden key, each otherwise a perfectly valid upgrade. A Hub that silently
  // ignored the field would pass a test that only checked the final count; this one asserts the
  // refusal, so a client author learns immediately.
  for (const key of HISTORY_KEYS) {
    const response = await hub.post('/v1/workgroups', { ...upgradeBody(`up-${key}`), [key]: 'anything' }, { token: alice.token })
    assert.equal(response.status, 400, `a body with "${key}" must be refused`)
    assert.equal(response.body.error.code, 'workgroup/history-not-accepted')
  }

  // Nothing was created by any of those attempts.
  const list = await hub.get('/v1/workgroups', { token: alice.token })
  assert.deepEqual(list.body.workgroups, [])
  assert.equal(hub.hub.db.prepare('SELECT count(*) AS c FROM workgroups').get().c, 0)
})

test('the refusal covers a nested transcript as well as a top-level list', async (t) => {
  const { hub, alice } = await setup(t)
  // `members` is a legitimate field, so a nested payload is the shape a careless client would use
  // to sneak a log through under an allowed name. Only top-level keys are screened — which is why
  // the allowed set is small and the rest is refused by omission (see the next test).
  const response = await hub.post('/v1/workgroups', {
    ...upgradeBody('up-nested'),
    conversation: { turns: [{ text: 'secret' }] },
  }, { token: alice.token })
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, 'workgroup/history-not-accepted')
})

test('a create body has no way to name a local file or folder', async (t) => {
  const { hub, alice } = await setup(t)
  // A workgroup's creation takes a name, a notice, an avatar and an upgrade id. Anything else is
  // ignored — and the point of this test is that "ignored" is visible: the stored row has no
  // column for a path, so a client that sent one would get a group with no trace of it.
  const created = await hub.post('/v1/workgroups', {
    ...upgradeBody('up-path'),
    localRoomId: 'room_abc',
    localPath: 'C:\\Users\\alice\\project',
    workDir: '/home/alice/work',
  }, { token: alice.token })
  assert.equal(created.status, 400, 'an unknown field is refused rather than silently stored')
})

test('the stored group row holds no local identifier or path', async (t) => {
  const { hub, alice } = await setup(t)
  const created = await hub.post('/v1/workgroups', {
    name: 'Settings only', notice: 'notice', upgradeId: 'up-clean',
  }, { token: alice.token })
  assert.equal(created.status, 201)

  const row = hub.hub.db.prepare('SELECT * FROM workgroups WHERE id = ?').get(created.body.workgroupId)
  const blob = JSON.stringify(row)
  // The upgrade id is the one client-supplied identifier the Hub keeps, and it is random: it says
  // nothing about which local group produced it. Everything else is settings.
  assert.equal(blob.includes('C:\\'), false)
  assert.equal(blob.includes('/home/'), false)
  assert.equal(blob.includes('room_'), false, 'no local room id is stored')
  assert.deepEqual(Object.keys(row).sort(), [
    // `reply_mode` and `permission` are settings, not content, and they sit here for the same reason
    // `name` does: two machines must agree. `reply_mode` is `'admin'` or `'everyone'` (who answers a
    // plain message); `permission` is a DSH preset name or NULL (one preset for the whole group, or
    // each member using its own — the original's `room.permission`). Neither says anything about
    // where the group's messages live.
    'archived_at', 'avatar', 'config_version', 'created_at', 'id', 'last_seq', 'lead_membership_id',
    'name', 'notice', 'owner_user_id', 'permission', 'reply_mode', 'upgrade_id',
  ])
})

test('a group that was created by upgrade answers "not created" on a replay', async (t) => {
  const { hub, alice } = await setup(t)
  const first = await hub.post('/v1/workgroups', upgradeBody('up-replay'), { token: alice.token })
  const second = await hub.post('/v1/workgroups', upgradeBody('up-replay'), { token: alice.token })

  assert.equal(first.status, 201)
  assert.equal(first.body.created, true)
  assert.equal(second.status, 201, 'a replay is not an error: the caller just needs the id')
  assert.equal(second.body.created, false)
  assert.equal(second.body.workgroupId, first.body.workgroupId)
})

test('an ordinary group without an upgrade id is never deduplicated', async (t) => {
  const { hub, alice } = await setup(t)
  // Two people may legitimately want two groups with the same name. Only an upgrade id makes a
  // create idempotent, so a plain create always makes a new group.
  const one = await hub.post('/v1/workgroups', { name: 'Same name' }, { token: alice.token })
  const two = await hub.post('/v1/workgroups', { name: 'Same name' }, { token: alice.token })
  assert.notEqual(one.body.workgroupId, two.body.workgroupId)
})

test('one account cannot claim another account\'s upgrade id', async (t) => {
  const { hub, alice } = await setup(t)
  const bob = await person(hub, { phone: '+8613900139000' })
  await hub.post('/v1/workgroups', upgradeBody('up-owned'), { token: alice.token })

  const stolen = await hub.post('/v1/workgroups', upgradeBody('up-owned'), { token: bob.token })
  assert.equal(stolen.status, 409)
  assert.equal(stolen.body.error.code, 'workgroup/upgrade-id-taken')
  // And Bob still owns nothing.
  const mine = await hub.get('/v1/workgroups', { token: bob.token })
  assert.deepEqual(mine.body.workgroups, [])
})

test('a group created by upgrade behaves like any other afterwards', async (t) => {
  const { hub, alice } = await setup(t)
  const bob = await person(hub, { phone: '+8613900139000' })
  const upgraded = await hub.post('/v1/workgroups', upgradeBody('up-live'), { token: alice.token })
  const workgroupId = upgraded.body.workgroupId

  const invite = await hub.post(`/v1/workgroups/${workgroupId}/invites`, { phone: bob.phone }, { token: alice.token })
  await hub.post(`/v1/invites/${invite.body.inviteId}/accept`, undefined, { token: bob.token })

  const a = connect(hub, alice)
  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await a.hello()
  await b.hello()

  const sent = await say(a, workgroupId, 'first workgroup message')
  // The first message after an upgrade is seq 1: the log really did start empty.
  assert.equal(sent.seq, 1)
  const received = await b.next(message => message.type === 'event')
  assert.deepEqual(received.event.payload, { text: 'first workgroup message' })

  const list = await hub.get('/v1/workgroups', { token: bob.token })
  assert.equal(list.body.workgroups[0].workgroupId, workgroupId)
})
