// Device keys and revocation.
//
// The properties worth proving here are the ones an attacker would attack:
//   * a registration must prove it holds the private key (a signature over the challenge);
//   * a challenge is single-use, so a captured signature cannot be replayed;
//   * a revoked key cannot come back (otherwise revoking a leaked key would be pointless);
//   * revoking someone else's device is impossible, and does not even confirm it exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sign } from 'node:crypto'
import { PASSWORD, PHONE_A, PHONE_B, newKeyPair, registerDevice, signChallenge, startHub } from './helpers.js'

const signUp = async (hub, phone = PHONE_A) => (await hub.post('/v1/auth/register', { phone, password: PASSWORD })).body

test('a challenge with a valid signature registers a device', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)

  const device = await registerDevice(hub, created.accessToken, { name: 'My laptop', platform: 'win32' })
  assert.match(device.deviceId, /^dev_/)
  assert.equal(device.name, 'My laptop')
  assert.equal(device.platform, 'win32')
})

test('a signature over the wrong bytes is refused', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)
  const keys = newKeyPair()

  const challenge = await hub.post('/v1/devices/challenge', { publicKey: keys.publicKey }, { token: created.accessToken })
  // Signed with the right key, over the wrong message: a Hub that only checked "is there a
  // signature" would accept this.
  const wrongSignature = sign(null, Buffer.from('some other message'), keys.privateKey).toString('base64')
  const response = await hub.post('/v1/devices/register', {
    challengeId: challenge.body.challengeId, signature: wrongSignature, name: 'X',
  }, { token: created.accessToken })
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'device/bad-signature')
})

test('a challenge cannot be used twice', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)
  const keys = newKeyPair()

  const challenge = await hub.post('/v1/devices/challenge', { publicKey: keys.publicKey }, { token: created.accessToken })
  const signature = signChallenge(keys, challenge.body.challengeId, challenge.body.nonce)
  const body = { challengeId: challenge.body.challengeId, signature, name: 'X' }

  const first = await hub.post('/v1/devices/register', body, { token: created.accessToken })
  assert.equal(first.status, 200)
  const replay = await hub.post('/v1/devices/register', body, { token: created.accessToken })
  assert.equal(replay.status, 401)
  assert.equal(replay.body.error.code, 'device/challenge-invalid')
})

test('a non-Ed25519 key is refused before any signature work', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)

  for (const publicKey of ['not a key', '', '-----BEGIN PUBLIC KEY-----\nzzz\n-----END PUBLIC KEY-----']) {
    const response = await hub.post('/v1/devices/challenge', { publicKey }, { token: created.accessToken })
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'device/invalid-key')
  }
})

test('registering the same key twice keeps one device row', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)
  const keys = newKeyPair()

  const first = await registerDevice(hub, created.accessToken, { keys, name: 'Laptop' })
  // The same machine reinstalling: a new challenge, the same key.
  const second = await registerDevice(hub, created.accessToken, { keys, name: 'Laptop again' })

  assert.equal(second.deviceId, first.deviceId, 'a known key must not accumulate device rows')
  const listed = await hub.get('/v1/devices', { token: created.accessToken })
  assert.equal(listed.body.devices.length, 1)
})

test('a revoked device key cannot register again', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())

  // Revoking a device ends that device's own sessions too, so the attempt to bring the key
  // back has to come from a session that is still alive — i.e. the other machine. That is
  // also the realistic case: the leaked key is on the device that was just kicked off.
  const laptop = (await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })).body
  const device = await registerDevice(hub, laptop.accessToken, { name: 'Laptop' })
  const desktop = (await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).body
  await registerDevice(hub, desktop.accessToken, { name: 'Desktop' })

  await hub.post(`/v1/devices/${device.deviceId}/revoke`, undefined, { token: desktop.accessToken })
  assert.equal((await hub.get('/v1/auth/me', { token: laptop.accessToken })).status, 401, 'the revoked device is signed out')

  // A leaked key must be useless after revocation. The client has to mint a new pair.
  const challenge = await hub.post('/v1/devices/challenge', { publicKey: device.keys.publicKey }, { token: desktop.accessToken })
  assert.equal(challenge.status, 403)
  assert.equal(challenge.body.error.code, 'device/key-revoked')
})

test('revoking a device ends that device\'s sessions', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())

  // Two devices, each with its own login session.
  const laptop = (await hub.post('/v1/auth/register', { phone: PHONE_A, password: PASSWORD })).body
  const laptopDevice = await registerDevice(hub, laptop.accessToken, { name: 'Laptop' })
  const desktop = (await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).body
  const desktopDevice = await registerDevice(hub, desktop.accessToken, { name: 'Desktop' })

  const revoked = await hub.post(`/v1/devices/${laptopDevice.deviceId}/revoke`, undefined, { token: desktop.accessToken })
  assert.equal(revoked.status, 200)

  // The revoked device is signed out; the device that did the revoking is not.
  assert.equal((await hub.get('/v1/auth/me', { token: laptop.accessToken })).status, 401)
  assert.equal((await hub.get('/v1/auth/me', { token: desktop.accessToken })).status, 200)
  // And its refresh token is dead too, so it cannot silently come back.
  assert.equal((await hub.post('/v1/auth/refresh', { refreshToken: laptop.refreshToken })).status, 401)
})

test('another account\'s device cannot be revoked, and is not confirmed to exist', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const a = await signUp(hub, PHONE_A)
  const b = await signUp(hub, PHONE_B)
  const device = await registerDevice(hub, a.accessToken)

  const response = await hub.post(`/v1/devices/${device.deviceId}/revoke`, undefined, { token: b.accessToken })
  // 404, not 403: a distinct "forbidden" would tell B that this device id is real.
  assert.equal(response.status, 404)
  assert.equal(response.body.error.code, 'device/not-found')
  // A's device is untouched.
  assert.equal((await hub.get('/v1/auth/me', { token: a.accessToken })).status, 200)
})

test('device endpoints require a session', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const created = await signUp(hub)
  const device = await registerDevice(hub, created.accessToken)

  assert.equal((await hub.post('/v1/devices/challenge', { publicKey: newKeyPair().publicKey })).status, 401)
  assert.equal((await hub.get('/v1/devices')).status, 401)
  assert.equal((await hub.post(`/v1/devices/${device.deviceId}/revoke`)).status, 401)
})
