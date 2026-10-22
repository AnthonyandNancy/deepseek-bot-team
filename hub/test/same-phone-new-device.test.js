// Gate item 2, first half: the same phone number on a new machine keeps the same hubUserId.
//
// The claim is about identity stability, not about the login mechanism. A new key pair, a new
// device row, and the same account: that is what lets a workgroup address a person rather than
// a machine.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PASSWORD, PHONE_A, registerDevice, startHub } from './helpers.js'

test('the same phone on a second device keeps the same hubUserId', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())

  const first = (await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })).body
  const firstDevice = await registerDevice(hub, first.accessToken, { name: 'Laptop' })

  // A second machine: new key pair, new login, same phone number.
  const second = (await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).body
  const secondDevice = await registerDevice(hub, second.accessToken, { name: 'Desktop' })

  assert.equal(second.hubUserId, first.hubUserId, 'the account must not change with the device')
  assert.notEqual(secondDevice.deviceId, firstDevice.deviceId, 'each machine is its own device')
})

test('both devices appear in the account device list', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())

  const first = (await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })).body
  const laptop = await registerDevice(hub, first.accessToken, { name: 'Laptop' })
  const second = (await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).body
  const desktop = await registerDevice(hub, second.accessToken, { name: 'Desktop' })

  // The older device must stay visible: a "logged in elsewhere" warning needs it.
  const listed = await hub.get('/v1/devices', { token: first.accessToken })
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.devices.map(device => device.deviceId).sort(), [laptop.deviceId, desktop.deviceId].sort())
  assert.deepEqual(listed.body.devices.map(device => device.name).sort(), ['Desktop', 'Laptop'])
})

test('a device registration binds the session to that device', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = (await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })).body
  const device = await registerDevice(hub, created.accessToken)

  const me = await hub.get('/v1/auth/me', { token: created.accessToken })
  assert.equal(me.body.session.deviceId, device.deviceId)
  assert.equal(me.body.devices.length, 1)
  assert.equal(me.body.devices[0].current, true)
})

test('two phone numbers never share a device list', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const a = (await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })).body
  await registerDevice(hub, a.accessToken, { name: 'A laptop' })
  const b = (await hub.post('/v1/auth/register', { phone: '+8613900139000', password: PASSWORD })).body

  const listed = await hub.get('/v1/devices', { token: b.accessToken })
  assert.deepEqual(listed.body.devices, [], 'a new account must not inherit another account\'s devices')
})
