// Gate item 4: revoking a device disconnects it immediately.
//
// "Immediately" is measured, not assumed: the test opens a real WebSocket, revokes the device
// over HTTP, and asserts the close frame arrives with code 4401 within a short bound. A test
// that only checked `connections.size` would pass against a Hub that never told the client.
//
// One detail of the `ws` library shapes these tests: the HTTP upgrade completes before the
// Hub's `connection` handler runs, so a refused handshake still *opens* and is then closed.
// The property to assert is therefore "closed with the right code and never greeted" — not
// "the connect call failed". Asserting the latter would pass for the wrong reason.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sign } from 'node:crypto'
import { WebSocket } from 'ws'
import { PASSWORD, PHONE_A, PHONE_B, registerDevice, newKeyPair, startHub } from './helpers.js'
import { CLOSE_BAD_AUTH, CLOSE_REVOKED, CLOSE_STALE } from '../src/ws.js'

// Opens a socket and records everything that happens to it from the first instant, so a
// `hello` sent immediately on connection cannot be missed by a listener attached too late.
function connect(hub, token, { deviceId, keys }, { timestamp = Date.now(), nonce = Math.random().toString(36).slice(2), signature } = {}) {
  const sig = signature ?? sign(null, Buffer.from(`${deviceId}.${timestamp}.${nonce}`), keys.privateKey).toString('base64')
  const url = `${hub.base.replace('http', 'ws')}/v1/ws?deviceId=${encodeURIComponent(deviceId)}&ts=${timestamp}&nonce=${encodeURIComponent(nonce)}&sig=${encodeURIComponent(sig)}`
  const ws = new WebSocket(url, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } })

  const record = { ws, messages: [], closeCode: undefined, closeReason: undefined, failed: false }
  ws.on('message', (data) => record.messages.push(JSON.parse(String(data))))
  ws.once('error', () => { record.failed = true })
  ws.once('close', (code, reason) => { record.closeCode = code; record.closeReason = String(reason) })
  record.opened = new Promise((resolve) => {
    ws.once('open', resolve)
    ws.once('error', resolve)
    ws.once('close', resolve)
  })
  record.closed = new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return }
    ws.once('close', () => resolve())
  })
  return record
}

// Waits for a record to close, with a bound, and fails loudly if it never does.
async function expectClose(record, timeoutMs = 3000) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`socket did not close within ${timeoutMs}ms`)), timeoutMs))
  await Promise.race([record.closed, timeout])
  return record.closeCode
}

const signedIn = async (hub, phone = PHONE_A) => {
  const created = (await hub.post('/v1/auth/register', { phone, password: PASSWORD })).body
  const device = await registerDevice(hub, created.accessToken)
  return { created, device }
}

test('revoking a device closes its socket at once', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const { created, device } = await signedIn(hub)

  const conn = connect(hub, created.accessToken, device)
  await conn.opened
  assert.equal(conn.ws.readyState, WebSocket.OPEN)

  const started = Date.now()
  await hub.post(`/v1/devices/${device.deviceId}/revoke`, undefined, { token: created.accessToken })
  const code = await expectClose(conn)
  const elapsed = Date.now() - started

  assert.equal(code, CLOSE_REVOKED, 'the client must be told the device was revoked, not that the network failed')
  assert.ok(elapsed < 1000, `close should be immediate, took ${elapsed}ms`)
})

test('every connection of a revoked device is closed', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const { created, device } = await signedIn(hub)
  const desktop = (await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).body
  const desktopDevice = await registerDevice(hub, desktop.accessToken, { name: 'Desktop' })

  // Two windows on the same machine, and one on another machine that must stay connected.
  const one = connect(hub, created.accessToken, device)
  const two = connect(hub, created.accessToken, device, { nonce: 'second-window' })
  const other = connect(hub, desktop.accessToken, desktopDevice, { nonce: 'other-machine' })
  await Promise.all([one.opened, two.opened, other.opened])

  await hub.post(`/v1/devices/${device.deviceId}/revoke`, undefined, { token: desktop.accessToken })
  assert.equal(await expectClose(one), CLOSE_REVOKED)
  assert.equal(await expectClose(two), CLOSE_REVOKED)

  // The unrelated device is untouched: a revoke must not be a broadcast.
  assert.equal(other.ws.readyState, WebSocket.OPEN)
  assert.equal(other.messages.length, 1, 'it still holds its own hello')
  other.ws.close()
})

test('a handshake without a valid session is refused', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const { device } = await signedIn(hub)

  for (const token of ['dsb_at_wrong', '', undefined]) {
    const conn = connect(hub, token, device)
    assert.equal(await expectClose(conn), CLOSE_BAD_AUTH, `token ${JSON.stringify(token)} should be refused`)
    // The decisive assertion: no `hello`, so the client never learns it was authenticated.
    assert.equal(conn.messages.length, 0)
  }
})

test('a signature over different bytes is refused', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const { created, device } = await signedIn(hub)

  // Right key, wrong message: the handshake must verify what it signs, not just that a
  // signature is present.
  const signature = sign(null, Buffer.from('something else entirely'), device.keys.privateKey).toString('base64')
  const conn = connect(hub, created.accessToken, device, { signature })
  assert.equal(await expectClose(conn), CLOSE_BAD_AUTH)
  assert.equal(conn.messages.length, 0)
})

test('a stale or replayed handshake is refused', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const { created, device } = await signedIn(hub)

  // Ten minutes old: outside the ±2 min window.
  const stale = connect(hub, created.accessToken, device, { timestamp: Date.now() - 10 * 60 * 1000 })
  assert.equal(await expectClose(stale), CLOSE_STALE)
  assert.equal(stale.messages.length, 0)

  // A valid handshake, replayed verbatim: the nonce has already been spent.
  const timestamp = Date.now()
  const nonce = 'one-time-nonce'
  const first = connect(hub, created.accessToken, device, { timestamp, nonce })
  await first.opened
  first.ws.close()
  await first.closed

  const replay = connect(hub, created.accessToken, device, { timestamp, nonce })
  assert.equal(await expectClose(replay), CLOSE_STALE)
  assert.equal(replay.messages.length, 0)
})

test('a device id belonging to another account is refused', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const { device: deviceA } = await signedIn(hub, PHONE_A)
  const b = (await hub.post('/v1/auth/register', { phone: PHONE_B, password: PASSWORD })).body

  // B holds a valid token but names A's device, and signs with B's own key.
  const conn = connect(hub, b.accessToken, { deviceId: deviceA.deviceId, keys: newKeyPair() })
  assert.equal(await expectClose(conn), CLOSE_BAD_AUTH)
  assert.equal(conn.messages.length, 0)
})

test('a revoked device cannot open a new socket', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const { created, device } = await signedIn(hub)
  const desktop = (await hub.post('/v1/auth/login', { phone: PHONE_A, password: PASSWORD })).body
  await registerDevice(hub, desktop.accessToken, { name: 'Desktop' })

  await hub.post(`/v1/devices/${device.deviceId}/revoke`, undefined, { token: desktop.accessToken })
  const conn = connect(hub, created.accessToken, device)
  assert.equal(await expectClose(conn), CLOSE_BAD_AUTH)
  assert.equal(conn.messages.length, 0)
})

test('the hub greets a good handshake as the session\'s own user', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const { created, device } = await signedIn(hub)

  const conn = connect(hub, created.accessToken, device)
  await conn.opened
  // The hello arrives as soon as the handshake is accepted, so wait for it rather than
  // assuming it is already in the list.
  for (let spent = 0; conn.messages.length === 0 && spent < 100; spent += 1) await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(conn.messages.length, 1)
  const hello = conn.messages[0]
  assert.equal(hello.type, 'hello')
  assert.equal(hello.deviceId, device.deviceId)
  assert.equal(hello.userId, created.hubUserId)
  conn.ws.close()
})

test('a frame the hub cannot act on is answered rather than ignored', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const { created, device } = await signedIn(hub)
  const conn = connect(hub, created.accessToken, device)
  await conn.opened
  for (let spent = 0; conn.messages.length === 0 && spent < 100; spent += 1) await new Promise(resolve => setTimeout(resolve, 10))

  // An unknown type: silence would be indistinguishable from a delivery failure, so the Hub says
  // what it did not understand.
  conn.ws.send(JSON.stringify({ v: 1, type: 'nonsense.type', payload: {} }))
  for (let spent = 0; conn.messages.length < 2 && spent < 100; spent += 1) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(conn.messages.length, 2)
  assert.equal(conn.messages[1].type, 'error')
  assert.equal(conn.messages[1].code, 'frame/unsupported')

  // A `chat.message` with no group is a client bug, and is reported as one instead of being
  // dropped — the socket stays open either way (G4 fan-out lives in ws-events.test.js).
  conn.ws.send(JSON.stringify({ v: 1, type: 'chat.message', payload: { text: 'hi' } }))
  for (let spent = 0; conn.messages.length < 3 && spent < 100; spent += 1) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(conn.messages[2].type, 'error')
  assert.equal(conn.messages[2].code, 'frame/invalid')
  assert.equal(conn.ws.readyState, WebSocket.OPEN, 'a refused frame must not end the session')
  conn.ws.close()
})
