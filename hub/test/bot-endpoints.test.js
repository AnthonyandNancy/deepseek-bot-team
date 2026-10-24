// Bot endpoints: an identity, a capability set and a device. Nothing else.
//
// The instruction is explicit that an endpoint publishes "identity + a minimal capability set +
// the device it belongs to", and never a working directory or a path. These tests hold that line
// two ways: the schema has no column for a path, and the request is filtered against a closed key
// set so a field the Hub does not know is refused rather than stored in the hope it is useful.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startHub, PHONE_A, PHONE_B } from './helpers.js'
import { person } from './g4-helpers.js'
import { CAPABILITIES, MAX_ENDPOINTS_PER_DEVICE } from '../src/endpoints/service.js'

const setup = async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const alice = await person(hub, { phone: PHONE_A, name: 'Alice laptop' })
  return { hub, alice }
}

test('publishing an endpoint records its identity, capabilities and device', async (t) => {
  const { hub, alice } = await setup(t)
  const published = await hub.post('/v1/bot-endpoints', {
    localBotId: 'chief', name: 'Chief', capabilities: ['chat', 'files'],
  }, { token: alice.token })

  assert.equal(published.status, 201)
  const endpoint = published.body.endpoint
  assert.equal(endpoint.localBotId, 'chief')
  assert.equal(endpoint.name, 'Chief')
  assert.equal(endpoint.deviceId, alice.deviceId, 'the endpoint is bound to the device that published it')
  assert.equal(endpoint.ownerId, alice.userId)
  assert.deepEqual(endpoint.capabilities, ['chat', 'files'])
  assert.equal(endpoint.status, 'active')
  // Exactly the advertised shape: no extra field could smuggle a path out.
  assert.deepEqual(Object.keys(endpoint).sort(), [
    'capabilities', 'createdAt', 'deviceId', 'endpointId', 'localBotId', 'name', 'ownerId', 'status', 'visibility',
  ])
})

test('every field that could name a local folder is refused with a reason', async (t) => {
  const { hub, alice } = await setup(t)
  const forbidden = {
    workDir: 'C:\\Users\\alice\\work',
    cwd: '/home/alice',
    path: '/tmp/x',
    root: 'D:\\',
    sessionId: 'ses_1',
    model: 'deepseek-chat',
  }
  for (const [key, value] of Object.entries(forbidden)) {
    const response = await hub.post('/v1/bot-endpoints', { localBotId: 'chief', name: 'Chief', [key]: value }, { token: alice.token })
    assert.equal(response.status, 400, `"${key}" must be refused`)
    assert.equal(response.body.error.code, 'endpoint/unsupported-field')
    // The message says what an endpoint is, so the client author knows what to send instead.
    assert.match(response.body.error.message, /identity, its capabilities and its device/)
  }
  const list = await hub.get('/v1/bot-endpoints', { token: alice.token })
  assert.deepEqual(list.body.endpoints, [])
})

test('an unknown capability is refused, and the known ones are a small fixed set', async (t) => {
  const { hub, alice } = await setup(t)
  assert.deepEqual([...CAPABILITIES].sort(), ['chat', 'files', 'tools'])

  const refused = await hub.post('/v1/bot-endpoints', {
    localBotId: 'chief', capabilities: ['chat', 'administers-the-machine'],
  }, { token: alice.token })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error.code, 'endpoint/unknown-capability')
  assert.match(refused.body.error.message, /Known: chat, files, tools/)
})

test('re-publishing the same Bot on the same device updates it instead of adding a row', async (t) => {
  const { hub, alice } = await setup(t)
  const first = await hub.post('/v1/bot-endpoints', { localBotId: 'chief', name: 'Chief', capabilities: ['chat'] }, { token: alice.token })
  const second = await hub.post('/v1/bot-endpoints', { localBotId: 'chief', name: 'Chief (renamed)', capabilities: ['chat', 'tools'] }, { token: alice.token })

  assert.equal(second.body.endpoint.endpointId, first.body.endpoint.endpointId, 'a restart must not mint a new endpoint')
  assert.equal(second.body.endpoint.name, 'Chief (renamed)')
  assert.deepEqual(second.body.endpoint.capabilities, ['chat', 'tools'])
  const all = await hub.get('/v1/bot-endpoints', { token: alice.token })
  assert.equal(all.body.endpoints.length, 1)
})

test('a second login is a different device, so the same Bot publishes twice', async (t) => {
  const { hub, alice } = await setup(t)
  const desktop = await alice.otherDevice('Desktop')
  const laptop = await hub.post('/v1/bot-endpoints', { localBotId: 'chief', name: 'Chief' }, { token: alice.token })
  const onDesktop = await hub.post('/v1/bot-endpoints', { localBotId: 'chief', name: 'Chief' }, { token: desktop.token })

  assert.notEqual(laptop.body.endpoint.endpointId, onDesktop.body.endpoint.endpointId)
  assert.equal(onDesktop.body.endpoint.deviceId, desktop.deviceId)
  const all = await hub.get('/v1/bot-endpoints', { token: alice.token })
  assert.equal(all.body.endpoints.length, 2)
})

test('another person\'s endpoint is never listed, even in a shared group', async (t) => {
  const { hub, alice } = await setup(t)
  const bob = await person(hub, { phone: PHONE_B, name: 'Bob laptop' })
  const aliceEndpoint = await hub.post('/v1/bot-endpoints', { localBotId: 'chief', name: 'Chief' }, { token: alice.token })
  await hub.post('/v1/bot-endpoints', { localBotId: 'helper', name: 'Helper' }, { token: bob.token })

  const group = await hub.post('/v1/workgroups', { name: 'Shared' }, { token: alice.token })
  const workgroupId = group.body.workgroupId
  // Bob's endpoint is not a member yet.
  const bobList = await hub.get(`/v1/bot-endpoints?workgroupId=${workgroupId}`, { token: bob.token })
  assert.equal(bobList.body.endpoints.length, 1, 'only his own')
  assert.equal(bobList.body.endpoints[0].ownerId, bob.userId)

  // Once Alice adds hers to the group, Bob sees it in the group context — and only there.
  const added = await hub.post(`/v1/workgroups/${workgroupId}/members`, { endpointId: aliceEndpoint.body.endpoint.endpointId }, { token: alice.token })
  assert.equal(added.status, 201)
  const bobInGroup = await hub.get(`/v1/bot-endpoints?workgroupId=${workgroupId}`, { token: bob.token })
  assert.deepEqual(bobInGroup.body.endpoints.map(endpoint => endpoint.name), ['Helper', 'Chief'])
})

test('a private endpoint is invisible to everyone else', async (t) => {
  const { hub, alice } = await setup(t)
  const bob = await person(hub, { phone: PHONE_B, name: 'Bob' })
  const group = await hub.post('/v1/workgroups', { name: 'Group' }, { token: alice.token })
  const workgroupId = group.body.workgroupId
  const invite = await hub.post(`/v1/workgroups/${workgroupId}/invites`, { phone: bob.phone }, { token: alice.token })
  await hub.post(`/v1/invites/${invite.body.inviteId}/accept`, undefined, { token: bob.token })

  const secret = await hub.post('/v1/bot-endpoints', { localBotId: 'chief', name: 'Chief', visibility: 'private' }, { token: alice.token })
  const seen = await hub.get(`/v1/bot-endpoints?workgroupId=${workgroupId}`, { token: bob.token })
  assert.equal(seen.body.endpoints.some(endpoint => endpoint.endpointId === secret.body.endpoint.endpointId), false)

  // And it cannot be pulled into the group either.
  const refused = await hub.post(`/v1/workgroups/${workgroupId}/members`, { endpointId: secret.body.endpoint.endpointId }, { token: alice.token })
  assert.equal(refused.status, 404)
})

test('an endpoint cannot be added to a group its owner is not in', async (t) => {
  const { hub, alice } = await setup(t)
  const bob = await person(hub, { phone: PHONE_B, name: 'Bob' })
  const alicesEndpoint = await hub.post('/v1/bot-endpoints', { localBotId: 'chief', name: 'Chief' }, { token: alice.token })

  // Bob owns a group of his own and knows Alice's endpoint id: it still must not join.
  const bobsGroup = await hub.post('/v1/workgroups', { name: 'Bob only' }, { token: bob.token })
  const refused = await hub.post(`/v1/workgroups/${bobsGroup.body.workgroupId}/members`, {
    endpointId: alicesEndpoint.body.endpoint.endpointId,
  }, { token: bob.token })
  assert.equal(refused.status, 404)
  assert.equal(refused.body.error.code, 'workgroup/endpoint-unknown')
})

test('only the owner may revoke an endpoint', async (t) => {
  const { hub, alice } = await setup(t)
  const bob = await person(hub, { phone: PHONE_B, name: 'Bob' })
  const published = await hub.post('/v1/bot-endpoints', { localBotId: 'chief', name: 'Chief' }, { token: alice.token })
  const endpointId = published.body.endpoint.endpointId

  const refused = await hub.post(`/v1/bot-endpoints/${endpointId}/revoke`, undefined, { token: bob.token })
  assert.equal(refused.status, 404, 'someone else\'s endpoint reads as missing')

  const revoked = await hub.post(`/v1/bot-endpoints/${endpointId}/revoke`, undefined, { token: alice.token })
  assert.equal(revoked.body.status, 'revoked')
  const list = await hub.get('/v1/bot-endpoints', { token: alice.token })
  assert.equal(list.body.endpoints.length, 0, 'a revoked endpoint is not listed')
})

test('re-publishing after a revoke brings the same endpoint back', async (t) => {
  const { hub, alice } = await setup(t)
  const first = await hub.post('/v1/bot-endpoints', { localBotId: 'chief', name: 'Chief' }, { token: alice.token })
  await hub.post(`/v1/bot-endpoints/${first.body.endpoint.endpointId}/revoke`, undefined, { token: alice.token })
  const again = await hub.post('/v1/bot-endpoints', { localBotId: 'chief', name: 'Chief' }, { token: alice.token })
  assert.equal(again.body.endpoint.endpointId, first.body.endpoint.endpointId)
  assert.equal(again.body.endpoint.status, 'active')
  assert.equal(again.body.created, true, 'the response says it had to be restored')
})

test('one device may publish a bounded number of endpoints', async (t) => {
  const { hub, alice } = await setup(t)
  for (let index = 0; index < MAX_ENDPOINTS_PER_DEVICE; index += 1) {
    const response = await hub.post('/v1/bot-endpoints', { localBotId: `bot-${index}`, name: `Bot ${index}` }, { token: alice.token })
    assert.equal(response.status, 201, `publish ${index} should succeed`)
  }
  const tooMany = await hub.post('/v1/bot-endpoints', { localBotId: 'one-too-many', name: 'Nope' }, { token: alice.token })
  assert.equal(tooMany.status, 409)
  assert.equal(tooMany.body.error.code, 'endpoint/too-many')
})

test('an endpoint id is not a capability: publishing says nothing about what it may run', async (t) => {
  const { hub, alice } = await setup(t)
  const published = await hub.post('/v1/bot-endpoints', {
    localBotId: 'chief', name: 'Chief', capabilities: ['chat'],
  }, { token: alice.token })
  // The registration is a claim about identity, and the row records the claim. Nothing in this
  // phase grants the endpoint any tool: that is G5's approval flow, and this test exists to keep
  // someone from "helpfully" adding a grants array here.
  const row = hub.hub.db.prepare('SELECT * FROM bot_endpoints WHERE id = ?').get(published.body.endpoint.endpointId)
  assert.deepEqual(Object.keys(row).sort(), [
    // `avatar` is the appearance the owner published — a shape name, a palette name and optionally a
    // photo's data URL. It is a DESCRIPTION of the Bot, not a capability: nothing here lets the
    // endpoint run a tool, which is the point of this test.
    'avatar', 'capabilities', 'created_at', 'device_id', 'id', 'local_bot_id', 'name', 'owner_id', 'revoked_at', 'status', 'visibility',
  ])
  assert.equal(row.capabilities, '["chat"]')
})
