// The attachment relay (acceptance case T08: two machines, chat, attachments, member invites).
//
// The promise under test is narrow and absolute: a message may carry *bytes*, never a path. The
// tests below therefore check both directions of that promise —
//
//   * nothing named like a local path is accepted (the request body has three fields, and the
//     stored row has no column a path could live in);
//   * the bytes that come back are the bytes that went in, and only for someone still in the
//     group, with a ticket that expires.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { startHub, PHONE_A, PHONE_B } from './helpers.js'
import { connect, groupWith, person, say } from './g4-helpers.js'
import { MAX_ATTACHMENT_BYTES, safeDisplayName } from '../src/attachments/service.js'

// A small PNG-ish payload. The bytes do not need to be a real image: what is under test is the
// relay, not a decoder — but they must be non-trivial so a truncation would show.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const setup = async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const alice = await person(hub, { phone: PHONE_A, name: 'Alice' })
  const bob = await person(hub, { phone: PHONE_B, name: 'Bob' })
  const { workgroupId } = await groupWith(hub, { owner: alice, others: [bob] })
  return { hub, alice, bob, workgroupId }
}

const upload = (hub, who, workgroupId, body) =>
  hub.post(`/v1/workgroups/${workgroupId}/attachments`, body, { token: who.token })

test('a file uploaded on one machine downloads byte-identically on the other', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const sha = createHash('sha256').update(PNG).digest('hex')

  const uploaded = await upload(hub, alice, workgroupId, { name: 'pixel.png', mime: 'image/png', data: PNG.toString('base64') })
  assert.equal(uploaded.status, 201)
  const attachment = uploaded.body.attachment
  assert.equal(attachment.name, 'pixel.png')
  assert.equal(attachment.mime, 'image/png')
  assert.equal(attachment.size, PNG.length)
  assert.equal(attachment.sha256, sha, 'the Hub hashes what it received, not what it was told')

  // Bob is in the group, so he may ask for a ticket and download.
  const ticket = await hub.post(`/v1/attachments/${attachment.attachmentId}/ticket`, undefined, { token: bob.token })
  assert.equal(ticket.status, 200)
  assert.match(ticket.body.downloadPath, /^\/v1\/attachments\/att_[0-9a-f]+\/download\?ticket=tik_/)

  const download = await fetch(`${hub.base}${ticket.body.downloadPath}`, { headers: { authorization: `Bearer ${bob.token}` } })
  assert.equal(download.status, 200)
  const received = Buffer.from(await download.arrayBuffer())
  assert.equal(received.length, PNG.length)
  assert.equal(createHash('sha256').update(received).digest('hex'), sha, 'the bytes round-trip unchanged')
  // A download is served as a file, never as a page.
  assert.equal(download.headers.get('content-type'), 'image/png')
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
  assert.match(download.headers.get('content-disposition'), /^attachment;/)
})

test('the upload announces itself in the group log, with metadata and no path', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await a.hello()
  await b.hello()

  await upload(hub, alice, workgroupId, { name: 'notes.txt', mime: 'text/plain', data: Buffer.from('hi').toString('base64') })
  const received = await b.next(message => message.type === 'event')
  const event = received.event

  assert.deepEqual(event.payload.text, '')
  assert.equal(event.payload.attachments.length, 1)
  const described = JSON.stringify(event.payload)
  assert.equal(described.includes('storage_key'), false, 'the Hub\'s own storage key never leaves the Hub')
  assert.equal(described.includes('C:\\'), false)
  assert.equal(described.includes('/tmp/'), false)
  // What a client needs to fetch it, and nothing more.
  assert.deepEqual(Object.keys(event.payload.attachments[0]).sort(), [
    'attachmentId', 'createdAt', 'expiresAt', 'mime', 'name', 'sha256', 'size', 'workgroupId',
  ])
})

test('one attachment may only carry one message: a replayed upload makes a second file, not a duplicate event', async (t) => {
  const { hub, alice, workgroupId } = await setup(t)
  const first = await upload(hub, alice, workgroupId, { name: 'a.txt', mime: 'text/plain', data: 'b25l' })
  const second = await upload(hub, alice, workgroupId, { name: 'a.txt', mime: 'text/plain', data: 'b25l' })
  // Each upload is its own message. Deduplication belongs to `event_id` on the message path, and
  // an upload has no client-supplied id — deliberately, because two identical photos are allowed.
  assert.notEqual(first.body.attachment.attachmentId, second.body.attachment.attachmentId)
  assert.notEqual(first.body.event.eventId, second.body.event.eventId)
  assert.equal(second.body.event.seq, first.body.event.seq + 1)
})

test('the displayed name is stripped of anything path-like, and the stored key is the Hub\'s own', async (t) => {
  const { hub, alice, workgroupId } = await setup(t)
  const uploaded = await upload(hub, alice, workgroupId, {
    name: 'C:\\Users\\alice\\secret\\report.csv', mime: 'text/csv', data: Buffer.from('a,b\n1,2').toString('base64'),
  })
  assert.equal(uploaded.status, 201)
  assert.equal(uploaded.body.attachment.name, 'report.csv', 'only the base name is kept')

  const row = hub.hub.db.prepare('SELECT * FROM attachments WHERE id = ?').get(uploaded.body.attachment.attachmentId)
  assert.match(row.storage_key, /^att_[0-9a-f]+\.csv$/, 'the storage key is derived from the Hub\'s id, never from the client name')
  assert.equal(JSON.stringify(row).includes('Users'), false, 'no part of the client path reached the row')
  // And the blob really is inside the Hub's own data directory.
  assert.equal(existsSync(`${hub.config.dataDir}/blobs/${row.storage_key}`), true)
})

test('a path in the body is refused: the relay takes bytes, not a location', async (t) => {
  const { hub, alice, workgroupId } = await setup(t)
  // The whole point of the relay. A client that sent `path` instead of `data` gets a refusal whose
  // reason names the missing bytes.
  const refused = await upload(hub, alice, workgroupId, {
    name: 'report.csv', mime: 'text/csv', path: 'C:\\Users\\alice\\report.csv',
  })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error.code, 'attachment/invalid-body')
})

test('the size cap is applied to the decoded bytes', async (t) => {
  const { hub, alice, workgroupId } = await setup(t)
  const tooBig = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61)
  const refused = await upload(hub, alice, workgroupId, { name: 'big.txt', mime: 'text/plain', data: tooBig.toString('base64') })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error.code, 'attachment/too-large')
  assert.match(refused.body.error.message, /8 MiB/)
})

test('the type is checked by extension and MIME together', async (t) => {
  const { hub, alice, workgroupId } = await setup(t)
  const data = Buffer.from('x').toString('base64')

  // A renamed executable: the extension is not on the list.
  const exe = await upload(hub, alice, workgroupId, { name: 'tool.exe', mime: 'image/png', data })
  assert.equal(exe.status, 400)
  assert.equal(exe.body.error.code, 'attachment/type-not-allowed')

  // An HTML file claiming to be an image: both are checked, so the mismatch is refused.
  const mismatch = await upload(hub, alice, workgroupId, { name: 'page.html', mime: 'image/png', data })
  assert.equal(mismatch.status, 400)
  assert.equal(mismatch.body.error.code, 'attachment/type-not-allowed')

  // A real image claiming to be text: the extension is fine, the MIME is not.
  const lying = await upload(hub, alice, workgroupId, { name: 'pixel.png', mime: 'text/html', data })
  assert.equal(lying.status, 400)
  assert.equal(lying.body.error.code, 'attachment/type-mismatch')

  // No extension at all: nothing to check, so nothing is accepted.
  const bare = await upload(hub, alice, workgroupId, { name: 'README', mime: 'text/plain', data })
  assert.equal(bare.status, 400)
  assert.equal(bare.body.error.code, 'attachment/unknown-type')
})

test('a download needs a ticket, and the ticket belongs to one person', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const uploaded = await upload(hub, alice, workgroupId, { name: 'a.txt', mime: 'text/plain', data: 'b25l' })
  const attachmentId = uploaded.body.attachment.attachmentId

  // No ticket at all.
  const bare = await hub.get(`/v1/attachments/${attachmentId}/download`, { token: bob.token })
  assert.equal(bare.status, 403)

  const ticket = await hub.post(`/v1/attachments/${attachmentId}/ticket`, undefined, { token: bob.token })
  // Alice asking with Bob's ticket is refused: the ticket names its holder.
  const stolen = await hub.get(`/v1/attachments/${attachmentId}/download?ticket=${ticket.body.ticket}`, { token: alice.token })
  assert.equal(stolen.status, 403)
  assert.equal(stolen.body.error.code, 'attachment/bad-ticket')

  // Bob with his own ticket still works, so the refusal above was about the person, not the ticket.
  const own = await hub.get(`/v1/attachments/${attachmentId}/download?ticket=${ticket.body.ticket}`, { token: bob.token })
  assert.equal(own.status, 200)
})

test('someone outside the group cannot upload, list, or download', async (t) => {
  const hub = await startHub()
  t.after(() => hub.close())
  const alice = await person(hub, { phone: PHONE_A })
  const bob = await person(hub, { phone: PHONE_B })
  const { workgroupId } = await groupWith(hub, { owner: alice })
  const uploaded = await upload(hub, alice, workgroupId, { name: 'a.txt', mime: 'text/plain', data: 'b25l' })

  const uploadRefused = await upload(hub, bob, workgroupId, { name: 'b.txt', mime: 'text/plain', data: 'dHdv' })
  assert.equal(uploadRefused.status, 404)
  const listRefused = await hub.get(`/v1/workgroups/${workgroupId}/attachments`, { token: bob.token })
  assert.equal(listRefused.status, 404)
  const ticketRefused = await hub.post(`/v1/attachments/${uploaded.body.attachment.attachmentId}/ticket`, undefined, { token: bob.token })
  assert.equal(ticketRefused.status, 404)
})

test('leaving the group ends access at once, even with an unexpired ticket', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const uploaded = await upload(hub, alice, workgroupId, { name: 'a.txt', mime: 'text/plain', data: 'b25l' })
  const attachmentId = uploaded.body.attachment.attachmentId
  const ticket = await hub.post(`/v1/attachments/${attachmentId}/ticket`, undefined, { token: bob.token })

  // Bob leaves of his own accord.
  const group = await hub.get(`/v1/workgroups/${workgroupId}`, { token: bob.token })
  const bobsMembership = group.body.members.find(member => member.userId === bob.userId).membershipId
  const left = await hub.post(`/v1/workgroups/${workgroupId}/members/${bobsMembership}/leave`, undefined, { token: bob.token })
  assert.equal(left.status, 200)

  // The ticket is still within its five minutes; membership is checked again at redemption.
  const download = await hub.get(`/v1/attachments/${attachmentId}/download?ticket=${ticket.body.ticket}`, { token: bob.token })
  assert.equal(download.status, 404)
})

test('an expired attachment is removed from disk and reported as gone', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const uploaded = await upload(hub, alice, workgroupId, { name: 'old.txt', mime: 'text/plain', data: 'b2xk' })
  const attachmentId = uploaded.body.attachment.attachmentId
  const row = hub.hub.db.prepare('SELECT storage_key FROM attachments WHERE id = ?').get(attachmentId)
  const blobPath = `${hub.config.dataDir}/blobs/${row.storage_key}`
  assert.equal(existsSync(blobPath), true)

  // Age the row past its expiry, then sweep — the same path a real Hub runs on a timer.
  hub.hub.db.prepare('UPDATE attachments SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), attachmentId)
  const swept = await hub.hub.attachments.sweep()
  assert.equal(swept.removed, 1)
  assert.equal(existsSync(blobPath), false, 'the bytes are deleted, not merely hidden')

  const ticket = await hub.post(`/v1/attachments/${attachmentId}/ticket`, undefined, { token: bob.token })
  assert.equal(ticket.status, 404, 'an expired attachment is not even ticketable')
})

test('a sweep deletes only what is expired', async (t) => {
  const { hub, alice, workgroupId } = await setup(t)
  const keep = await upload(hub, alice, workgroupId, { name: 'keep.txt', mime: 'text/plain', data: 'a2VlcA==' })
  const drop = await upload(hub, alice, workgroupId, { name: 'drop.txt', mime: 'text/plain', data: 'ZHJvcA==' })
  hub.hub.db.prepare('UPDATE attachments SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), drop.body.attachment.attachmentId)

  assert.equal((await hub.hub.attachments.sweep()).removed, 1)
  const listed = await hub.get(`/v1/workgroups/${workgroupId}/attachments`, { token: alice.token })
  assert.deepEqual(listed.body.attachments.map(entry => entry.name), ['keep.txt'])
  assert.equal(hub.hub.db.prepare('SELECT deleted_at FROM attachments WHERE id = ?').get(drop.body.attachment.attachmentId).deleted_at !== null, true)
  assert.equal(hub.hub.db.prepare('SELECT deleted_at FROM attachments WHERE id = ?').get(keep.body.attachment.attachmentId).deleted_at, null)
})

test('a download whose blob is gone answers "gone" rather than crashing', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const uploaded = await upload(hub, alice, workgroupId, { name: 'lost.txt', mime: 'text/plain', data: 'bG9zdA==' })
  const attachmentId = uploaded.body.attachment.attachmentId
  const row = hub.hub.db.prepare('SELECT storage_key FROM attachments WHERE id = ?').get(attachmentId)
  await rm(`${hub.config.dataDir}/blobs/${row.storage_key}`, { force: true })

  const ticket = await hub.post(`/v1/attachments/${attachmentId}/ticket`, undefined, { token: bob.token })
  const download = await hub.get(`/v1/attachments/${attachmentId}/download?ticket=${ticket.body.ticket}`, { token: bob.token })
  assert.equal(download.status, 410)
  assert.equal(download.body.error.code, 'attachment/gone')
})

test('the relay works for a message that also has text', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await a.hello()
  await b.hello()

  const uploaded = await upload(hub, alice, workgroupId, { name: 'chart.png', mime: 'image/png', data: PNG.toString('base64') })
  const attachment = uploaded.body.attachment
  // The client then sends the message that carries it, naming the attachment by id.
  const sent = await say(a, workgroupId, 'see attached')
  assert.ok(sent.seq > uploaded.body.event.seq, 'the text message follows the upload in the same log')
  const received = await b.next(message => message.type === 'event' && message.event.payload.text === 'see attached')
  assert.equal(received.event.seq, sent.seq)

  // Both messages are in the log, in order, and the file is readable by the other machine.
  const pulled = await hub.get(`/v1/workgroups/${workgroupId}/events`, { token: bob.token })
  assert.deepEqual(pulled.body.events.map(event => event.seq), [uploaded.body.event.seq, sent.seq])
  const ticket = await hub.post(`/v1/attachments/${attachment.attachmentId}/ticket`, undefined, { token: bob.token })
  const download = await fetch(`${hub.base}${ticket.body.downloadPath}`, { headers: { authorization: `Bearer ${bob.token}` } })
  assert.equal(download.status, 200)
})

test('safeDisplayName keeps a usable name and drops the path', () => {
  assert.equal(safeDisplayName('report.csv'), 'report.csv')
  assert.equal(safeDisplayName('/tmp/a/report.csv'), 'report.csv')
  assert.equal(safeDisplayName('C:\\Users\\me\\report.csv'), 'report.csv')
  assert.equal(safeDisplayName('../../etc/passwd'), 'passwd')
  assert.equal(safeDisplayName(''), 'attachment')
  assert.equal(safeDisplayName(undefined), 'attachment')
  // Control characters would corrupt a header and a filename alike.
  assert.equal(safeDisplayName('re\u0000port.csv'), 'report.csv')
})
