// Group memory across two real machines (G6, plan §11 and gate T18).
//
// The Hub is authoritative; a machine only keeps a projection. This suite proves the product path:
// a memory written through Alice's apiHandle reaches Bob over the existing WSS event stream, Bob's
// Runtime re-reads the Hub by itself, and the same cache is visible through apiHandle.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invitedPair, until } from './helpers-pair.js'

test('a memory created on one machine is projected into the other machine without a manual refresh', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  const bobAccount = await bob.wg.hub.restore()
  const created = await alice.call('memory-create', {
    workgroupId,
    type: 'fact',
    content: 'Shipping address is the Hangzhou warehouse.',
    sourceRefs: [],
    acl: [bobAccount.hubUserId],
  })
  assert.equal(created.ok, true, JSON.stringify(created.error))

  await until(() => (bob.wg.state.memories?.[workgroupId]?.entries ?? [])
    .some(entry => entry.memoryId === created.value.memory.memoryId),
  { label: "Bob's projection to receive the memory event" })

  const listed = await bob.call('memory-list', { workgroupId })
  assert.equal(listed.ok, true, JSON.stringify(listed.error))
  assert.equal(listed.value.memories.some(entry => entry.memoryId === created.value.memory.memoryId), true)
})

test('the five memory endpoints use the same workgroup API as the panel', async (t) => {
  const { alice, workgroupId } = await invitedPair(t)
  const created = await alice.call('memory-create', {
    workgroupId, type: 'faq', content: 'Where do invoices go?', sourceRefs: [], acl: [],
  })
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const memoryId = created.value.memory.memoryId

  const listed = await alice.call('memory-list', { workgroupId })
  assert.equal(listed.ok, true, JSON.stringify(listed.error))
  assert.equal(listed.value.memories.some(entry => entry.memoryId === memoryId), true)

  const found = await alice.call('memory-search', { workgroupId, query: 'invoices' })
  assert.equal(found.ok, true, JSON.stringify(found.error))
  assert.equal(found.value.memories.some(entry => entry.memoryId === memoryId), true)

  const corrected = await alice.call('memory-correct', {
    workgroupId, memoryId, content: 'Where do paid invoices go?', expectedVersion: created.value.memory.version,
  })
  assert.equal(corrected.ok, true, JSON.stringify(corrected.error))
  assert.equal(corrected.value.memory.version, 2)

  const stale = await alice.call('memory-correct', {
    workgroupId, memoryId, content: 'stale overwrite', expectedVersion: 1,
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'memory/version-conflict')

  const missingVersion = await alice.call('memory-delete', { workgroupId, memoryId })
  assert.equal(missingVersion.ok, false)
  assert.equal(missingVersion.error.code, 'memory/version-required')

  const deleted = await alice.call('memory-delete', { workgroupId, memoryId, expectedVersion: 2 })
  assert.equal(deleted.ok, true, JSON.stringify(deleted.error))
  assert.deepEqual((await alice.call('memory-list', { workgroupId })).value.memories, [])
})
