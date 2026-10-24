// A group's settings are one shared value on several machines. Two people may save at almost the
// same moment; without a version the slower request silently wins and overwrites the newer value.
// `config_version` has existed since the first Hub migration, so this exposes it and makes a write
// carry the version it was based on.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startHub, PHONE_A, PHONE_B } from './helpers.js'
import { person, groupWith } from './g4-helpers.js'

const scene = async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const alice = await person(hub, { phone: PHONE_A, name: 'Alice' })
  const bob = await person(hub, { phone: PHONE_B, name: 'Bob' })
  const { workgroupId } = await groupWith(hub, { owner: alice, others: [bob] })
  return { hub, alice, bob, workgroupId }
}

const settings = (hub, who, workgroupId, body) =>
  hub.post(`/v1/workgroups/${workgroupId}/settings`, body, { token: who.token })

test('the group response carries its config version', async (t) => {
  const { hub, alice, workgroupId } = await scene(t)
  const group = await hub.get(`/v1/workgroups/${workgroupId}`, { token: alice.token })
  assert.equal(group.status, 200, JSON.stringify(group.body))
  assert.equal(typeof group.body.configVersion, 'number')
  assert.equal(group.body.configVersion, 1, 'a fresh group starts at version 1')
})

test('a settings write from an old config version is refused', async (t) => {
  const { hub, alice, workgroupId } = await scene(t)
  const first = await settings(hub, alice, workgroupId, { name: 'v2', configVersion: 1 })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.workgroup.configVersion, 2)

  const stale = await settings(hub, alice, workgroupId, { name: 'v1-overwrite', configVersion: 1 })
  assert.equal(stale.status, 409, JSON.stringify(stale.body))
  assert.equal(stale.body.error?.code ?? stale.body.code, 'workgroup/settings-stale')
  assert.match(stale.body.error?.message ?? stale.body.message, /version 2/,
    'the refusal names the version the caller must re-read')

  const current = await hub.get(`/v1/workgroups/${workgroupId}`, { token: alice.token })
  assert.equal(current.body.name, 'v2', 'the stale write never touched the stored name')
})

test('a settings write without a config version still works for older clients', async (t) => {
  const { hub, alice, workgroupId } = await scene(t)
  const changed = await settings(hub, alice, workgroupId, { notice: 'no version here' })
  assert.equal(changed.status, 200, JSON.stringify(changed.body))
  assert.equal(changed.body.workgroup.configVersion, 2, 'the Hub still advances the version')
})
