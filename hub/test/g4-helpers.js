// Shared support for the G4 tests: two accounts, each with a device, and real sockets.
//
// Nothing here mocks the Hub's internals. A test opens the same HTTP and WSS surfaces a plugin
// does, so a passing test means the wire protocol works, not that two modules agree with each
// other.
import { sign } from 'node:crypto'
import { WebSocket } from 'ws'
import { PASSWORD, PHONE_A, PHONE_B, newKeyPair, registerDevice } from './helpers.js'

// One person = one account + one registered device + one live socket, opened on demand.
export async function person(hub, { phone, name = 'Laptop' } = {}) {
  const created = (await hub.post('/v1/auth/register', { phone, password: PASSWORD })).body
  if (created?.accessToken === undefined) throw new Error(`register failed: ${JSON.stringify(created)}`)
  const device = await registerDevice(hub, created.accessToken, { name })

  return {
    token: created.accessToken,
    userId: created.hubUserId,
    deviceId: device.deviceId,
    keys: device.keys,
    phone,
    // A second login on the same account, as "my other machine" would do.
    async otherDevice(label = 'Desktop') {
      const session = (await hub.post('/v1/auth/login', { phone, password: PASSWORD })).body
      const registered = await registerDevice(hub, session.accessToken, { name: label })
      return { token: session.accessToken, userId: session.user_id ?? created.hubUserId, deviceId: registered.deviceId, keys: registered.keys }
    },
  }
}

export const twoPeople = async (hub) => {
  const alice = await person(hub, { phone: PHONE_A, name: 'Alice laptop' })
  const bob = await person(hub, { phone: PHONE_B, name: 'Bob laptop' })
  return { alice, bob }
}

// A socket that records everything from the first instant, so a frame sent immediately on
// connection is never missed by a late listener.
export function connect(hub, who, { timestamp = Date.now(), nonce, signature, device } = {}) {
  const deviceId = device?.deviceId ?? who.deviceId
  const keys = device?.keys ?? who.keys
  const token = device?.token ?? who.token
  const nonceValue = nonce ?? `n-${Math.random().toString(36).slice(2)}`
  const sig = signature ?? sign(null, Buffer.from(`${deviceId}.${timestamp}.${nonceValue}`), keys.privateKey).toString('base64')
  const url = `${hub.base.replace('http', 'ws')}/v1/ws?deviceId=${encodeURIComponent(deviceId)}&ts=${timestamp}&nonce=${encodeURIComponent(nonceValue)}&sig=${encodeURIComponent(sig)}`
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })

  const record = {
    ws,
    messages: [],
    closeCode: undefined,
    waiters: [],
    // Resolves as soon as a matching frame arrives, or rejects after the bound. A test reads
    // frames by predicate rather than by index, because fan-out order across devices is not a
    // contract the Hub makes.
    //
    // `from` is the index to start looking at, and it is what makes "the same request twice" testable:
    // a predicate that would also match an earlier frame (two acks carrying the same event id) must
    // only see frames that arrived after the second request was sent.
    next(predicate, { timeoutMs = 4000, label = 'frame', from = 0 } = {}) {
      const found = record.messages.slice(from).find(predicate)
      if (found !== undefined) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        const entry = { predicate, resolve, reject }
        entry.timer = setTimeout(() => {
          record.waiters = record.waiters.filter(other => other !== entry)
          reject(new Error(`timed out waiting for ${label}; saw ${JSON.stringify(record.messages.map(message => message.type))}`))
        }, timeoutMs)
        record.waiters.push(entry)
      })
    },
    // Every frame of a type, in arrival order.
    all(type) {
      return record.messages.filter(message => message.type === type)
    },
    // How many frames have arrived. A caller that is about to send twice snapshots this.
    get cursor() {
      return record.messages.length
    },
  }

  ws.on('message', (data) => {
    const message = JSON.parse(String(data))
    record.messages.push(message)
    for (const waiter of [...record.waiters]) {
      if (!waiter.predicate(message)) continue
      clearTimeout(waiter.timer)
      record.waiters = record.waiters.filter(other => other !== waiter)
      waiter.resolve(message)
    }
  })
  ws.once('close', (code) => { record.closeCode = code })
  record.opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  record.closed = new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return }
    ws.once('close', () => resolve())
  })
  record.hello = () => record.next(message => message.type === 'hello', { label: 'hello' })
  record.send = value => ws.send(JSON.stringify({ v: 1, ...value }))
  record.close = async () => {
    ws.close()
    await record.closed
  }
  return record
}

// A group created by `who`, with `others` invited and having accepted. Returns the ids the tests
// need; every step goes through the public API.
export async function groupWith(hub, { owner, others = [] }) {
  const group = await hub.post('/v1/workgroups', { name: '费用汇总' }, { token: owner.token })
  if (group.status !== 201) throw new Error(`create failed: ${JSON.stringify(group.body)}`)
  const workgroupId = group.body.workgroupId

  for (const other of others) {
    const invite = await hub.post(`/v1/workgroups/${workgroupId}/invites`, { phone: other.phone }, { token: owner.token })
    if (invite.status !== 201) throw new Error(`invite failed: ${JSON.stringify(invite.body)}`)
    const accepted = await hub.post(`/v1/invites/${invite.body.inviteId}/accept`, undefined, { token: other.token })
    if (accepted.status !== 200) throw new Error(`accept failed: ${JSON.stringify(accepted.body)}`)
  }
  return { workgroupId, group: group.body }
}

// Sends one chat message over the socket and waits for the Hub's own ack, which carries the seq.
// Going through the socket (not the service) is what makes these tests evidence for gate 2.
export async function say(socket, workgroupId, text, { eventId } = {}) {
  const id = eventId ?? `evt-${Math.random().toString(36).slice(2)}`
  // Snapshot before sending: a resend reuses the event id, so the first ack would otherwise
  // satisfy the second wait and the duplicate flag would be read from the wrong frame.
  const from = socket.cursor
  socket.send({ type: 'chat.message', workgroupId, eventId: id, payload: { text } })
  const ack = await socket.next(message => message.type === 'ack.ok' && message.eventId === id, { label: `ack for ${text}`, from })
  return { eventId: id, seq: ack.seq, duplicate: ack.duplicate }
}

export const newKeys = newKeyPair
