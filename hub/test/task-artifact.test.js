// Artifacts (plan §12, §13.2; T17's second half, §10.1 step 7).
//
// What these tests hold the Hub to:
//   * a result can only be shared for a task with a live approval, and only by the task's owner;
//   * the ACL decides who may read it, and current membership confirms it — leaving the group closes
//     the door even while the ACL still names you;
//   * revoking the approval withdraws what was already shared;
//   * no endpoint ever accepts or returns a filesystem path: the body is bytes, the stored key is
//     generated, and a `.exe` renamed to `.png` is refused on the MIME/extension pair.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, sign } from 'node:crypto'
import { startHub } from './helpers.js'
import { person, twoPeople, groupWith, connect } from './g4-helpers.js'
import { signingBytes } from '../src/tasks/envelope.js'

const signEnvelope = (keys, envelope) => sign(null, signingBytes(envelope), keys.privateKey).toString('base64')
const PDF = Buffer.from('%PDF-1.4\n% artifact test\n', 'utf8')

async function scene(t) {
  const hub = await startHub()
  t.after(async () => { await hub.close() })
  const { alice, bob } = await twoPeople(hub)
  const { workgroupId } = await groupWith(hub, { owner: alice, others: [bob] })
  const endpoint = (await hub.post('/v1/bot-endpoints', {
    localBotId: 'bob-chief', name: 'Bob Chief', capabilities: ['chat', 'files'],
  }, { token: bob.token })).body.endpoint

  // A task from A to B, approved, and walked to RUNNING through the legal states.
  const socket = connect(hub, alice)
  await socket.hello()
  const at = Date.now()
  const envelope = {
    v: 1,
    eventId: `evt_${Math.random().toString(36).slice(2)}`,
    type: 'task.request',
    workgroupId,
    taskId: `task_${Math.random().toString(36).slice(2)}`,
    sender: { userId: alice.userId, deviceId: alice.deviceId },
    target: { userId: bob.userId, botEndpointId: endpoint.endpointId },
    createdAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 3600 * 1000).toISOString(),
    payload: { title: '费用汇总' },
  }
  envelope.signature = signEnvelope(alice.keys, envelope)
  const from = socket.cursor
  socket.send({ type: 'task.request', envelope })
  const accepted = await socket.next(message => message.type === 'task.ok' || message.type === 'error', { from })
  await socket.close()
  assert.equal(accepted.type, 'task.ok', JSON.stringify(accepted))
  const taskId = accepted.taskId

  const approved = await hub.post(`/v1/tasks/${taskId}/decision`, { decision: 'granted' }, { token: bob.token })
  assert.equal(approved.status, 200, JSON.stringify(approved.body))

  const bobSocket = connect(hub, bob)
  await bobSocket.hello()
  for (const next of ['ASSIGNED', 'RUNNING']) {
    const at2 = bobSocket.cursor
    bobSocket.send({ type: 'task.report', taskId, next })
    const reported = await bobSocket.next(message => message.type === 'task.reported' || message.type === 'error', { from: at2 })
    assert.equal(reported.type, 'task.reported', JSON.stringify(reported))
  }
  await bobSocket.close()
  return { hub, alice, bob, workgroupId, endpoint, taskId }
}

const upload = (hub, who, body) => hub.post('/v1/artifacts/uploads', body, { token: who.token })

test('the owner of a task may share its result, and the bytes round-trip', async (t) => {
  const { hub, alice, bob, taskId } = await scene(t)
  const created = await upload(hub, bob, {
    taskId,
    name: 'expenses.pdf',
    mime: 'application/pdf',
    data: PDF.toString('base64'),
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const artifact = created.body.artifact
  assert.equal(artifact.taskId, taskId)
  assert.equal(artifact.size, PDF.length)
  // The hash is of the bytes the Hub received, so a downloader can verify them.
  assert.equal(artifact.hash, createHash('sha256').update(PDF).digest('hex'))
  // The ACL names the requester by default: they asked for the work.
  assert.ok(artifact.acl.includes(alice.userId))
  assert.ok(artifact.acl.includes(bob.userId))

  // No path, ever: the response has no field that could be one, and nothing in it looks like a
  // filesystem location (a drive letter, a UNC share, or the Hub's own directory separator).
  const serialised = JSON.stringify(created.body)
  assert.equal(serialised.includes('blob'), false, 'the storage key is not returned')
  assert.equal(/[A-Za-z]:[\\/]/.test(serialised), false, 'no drive-letter path')
  assert.equal(serialised.includes('\\\\'), false, 'no UNC path')
  assert.equal(Object.keys(artifact).some(key => /path|dir|file|location/i.test(key)), false, 'no field names a location')

  const downloaded = await fetch(`${hub.base}/v1/artifacts/${artifact.artifactId}/download`, {
    headers: { authorization: `Bearer ${alice.token}` },
  })
  assert.equal(downloaded.status, 200)
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), PDF)
  assert.match(downloaded.headers.get('content-disposition'), /attachment; filename\*=UTF-8''expenses\.pdf/)

  // And the group's log says a result exists, so a requester who was offline sees it on reconnect.
  const events = hub.hub.events.pull({ workgroupId: created.body.artifact.workgroupId, afterSeq: 0 }).events
  const available = events.find(event => event.type === 'artifact.available')
  assert.ok(available !== undefined)
  assert.equal(available.payload.artifactId, artifact.artifactId)
})

test('a task with no live approval cannot produce an artifact', async (t) => {
  const { hub, alice, bob, workgroupId, endpoint } = await scene(t)
  // A second task, requested but never approved.
  const socket = connect(hub, alice)
  await socket.hello()
  const at = Date.now()
  const envelope = {
    v: 1, eventId: `evt_${Math.random().toString(36).slice(2)}`, type: 'task.request', workgroupId,
    taskId: `task_${Math.random().toString(36).slice(2)}`,
    sender: { userId: alice.userId, deviceId: alice.deviceId },
    target: { userId: bob.userId, botEndpointId: endpoint.endpointId },
    createdAt: new Date(at).toISOString(), expiresAt: new Date(at + 3600 * 1000).toISOString(),
    payload: { title: 'unapproved' },
  }
  envelope.signature = signEnvelope(alice.keys, envelope)
  const from = socket.cursor
  socket.send({ type: 'task.request', envelope })
  const answer = await socket.next(message => message.type === 'task.ok' || message.type === 'error', { from })
  await socket.close()

  // Even Bob, who owns the task, cannot attach a file to work nobody approved: that would be a
  // result appearing in the group with no consent behind it.
  const refused = await upload(hub, bob, { taskId: answer.taskId, name: 'a.txt', mime: 'text/plain', data: Buffer.from('hi').toString('base64') })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'artifact/not-approved')
})

test('only the task owner may share a result', async (t) => {
  const { hub, alice, bob, taskId } = await scene(t)
  // A asked; A cannot publish B's result on B's behalf.
  const refused = await upload(hub, alice, { taskId, name: 'a.pdf', mime: 'application/pdf', data: PDF.toString('base64') })
  // Read as "no such task" for the requester, so the endpoint is not an oracle for other people's
  // work; the point is that it is refused either way.
  assert.equal(refused.status, 404)
  assert.equal(refused.body.error.code, 'artifact/task-unknown')
})

test('a person the artifact was not shared with cannot download it', async (t) => {
  const { hub, alice, bob, taskId, workgroupId } = await scene(t)
  const created = await upload(hub, bob, { taskId, name: 'a.pdf', mime: 'application/pdf', data: PDF.toString('base64') })
  const artifactId = created.body.artifact.artifactId

  const carol = await person(hub, { phone: '+8613700137000', name: 'Carol laptop' })
  const invite = await hub.post(`/v1/workgroups/${workgroupId}/invites`, { phone: carol.phone }, { token: alice.token })
  await hub.post(`/v1/invites/${invite.body.inviteId}/accept`, undefined, { token: carol.token })

  // Carol is in the group but not on the ACL: the group's chat is shared, a task result is not.
  const refused = await fetch(`${hub.base}/v1/artifacts/${artifactId}/download`, { headers: { authorization: `Bearer ${carol.token}` } })
  assert.equal(refused.status, 404)
})

test('an artifact shared with a third person is readable by them, and only while they are in the group', async (t) => {
  const { hub, alice, bob, taskId, workgroupId } = await scene(t)
  const carol = await person(hub, { phone: '+8613700137000', name: 'Carol laptop' })
  const invite = await hub.post(`/v1/workgroups/${workgroupId}/invites`, { phone: carol.phone }, { token: alice.token })
  await hub.post(`/v1/invites/${invite.body.inviteId}/accept`, undefined, { token: carol.token })

  const created = await upload(hub, bob, {
    taskId, name: 'a.pdf', mime: 'application/pdf', data: PDF.toString('base64'), acl: [carol.userId],
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const artifactId = created.body.artifact.artifactId
  assert.ok(created.body.artifact.acl.includes(carol.userId))

  const allowed = await fetch(`${hub.base}/v1/artifacts/${artifactId}/download`, { headers: { authorization: `Bearer ${carol.token}` } })
  assert.equal(allowed.status, 200)

  // Carol leaves the group. The ACL still names her, and that is exactly why membership is checked
  // again at redemption: a stale grant must not outlive the group it was made in.
  const membership = await hub.get(`/v1/workgroups/${workgroupId}`, { token: carol.token })
  const mine = membership.body.members.find(member => member.userId === carol.userId)
  await hub.post(`/v1/workgroups/${workgroupId}/members/${mine.membershipId}/leave`, undefined, { token: carol.token })
  const refused = await fetch(`${hub.base}/v1/artifacts/${artifactId}/download`, { headers: { authorization: `Bearer ${carol.token}` } })
  assert.equal(refused.status, 404)
})

test('an ACL cannot name somebody outside the group', async (t) => {
  const { hub, bob, taskId } = await scene(t)
  const outsider = await person(hub, { phone: '+8613600136000', name: 'Outsider' })
  const refused = await upload(hub, bob, {
    taskId, name: 'a.pdf', mime: 'application/pdf', data: PDF.toString('base64'), acl: [outsider.userId],
  })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error.code, 'artifact/acl-not-in-group')
})

test('revoking the approval withdraws the artifact that was already shared', async (t) => {
  const { hub, alice, bob, taskId, workgroupId } = await scene(t)
  const created = await upload(hub, bob, { taskId, name: 'a.pdf', mime: 'application/pdf', data: PDF.toString('base64') })
  const artifactId = created.body.artifact.artifactId
  assert.equal((await fetch(`${hub.base}/v1/artifacts/${artifactId}/download`, { headers: { authorization: `Bearer ${alice.token}` } })).status, 200)

  const revoked = await hub.post(`/v1/tasks/${taskId}/revoke`, { reason: 'stop' }, { token: bob.token })
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body))

  // The share is withdrawn with the consent behind it; leaving it readable would make the ACL a
  // decoration.
  const after = await fetch(`${hub.base}/v1/artifacts/${artifactId}/download`, { headers: { authorization: `Bearer ${alice.token}` } })
  assert.equal(after.status, 404)
  const events = hub.hub.events.pull({ workgroupId, afterSeq: 0 }).events
  assert.ok(events.some(event => event.type === 'artifact.revoked'))
})

test('a renamed executable is refused on the extension/MIME pair', async (t) => {
  const { hub, bob, taskId } = await scene(t)
  const asExe = await upload(hub, bob, { taskId, name: 'setup.exe', mime: 'application/octet-stream', data: PDF.toString('base64') })
  assert.equal(asExe.status, 400)
  assert.equal(asExe.body.error.code, 'artifact/type-not-allowed')

  const lying = await upload(hub, bob, { taskId, name: 'setup.png', mime: 'application/octet-stream', data: PDF.toString('base64') })
  assert.equal(lying.status, 400)
  assert.equal(lying.body.error.code, 'artifact/type-mismatch')

  // And an ordinary, honest file is still accepted, so the check is narrow rather than a ban.
  const ok = await upload(hub, bob, { taskId, name: 'notes.md', mime: 'text/markdown', data: Buffer.from('# hi').toString('base64') })
  assert.equal(ok.status, 201, JSON.stringify(ok.body))
})

test('an oversized artifact is refused before anything is stored', async (t) => {
  const { hub, bob, taskId } = await scene(t)
  // One byte over the decoded cap. The route's body cap is the base64 of the limit plus a little
  // room, so a larger file would be refused by the transport before the service ever saw it — this
  // size is the one that proves the service's own check runs.
  const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61)
  const refused = await upload(hub, bob, { taskId, name: 'big.txt', mime: 'text/plain', data: big.toString('base64') })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error.code, 'artifact/too-large')
})

test('a task lists only the artifacts this reader may see', async (t) => {
  const { hub, alice, bob, taskId } = await scene(t)
  await upload(hub, bob, { taskId, name: 'a.pdf', mime: 'application/pdf', data: PDF.toString('base64') })
  await upload(hub, bob, { taskId, name: 'b.csv', mime: 'text/csv', data: Buffer.from('a,b\n1,2\n').toString('base64') })

  const seenByRequester = await hub.get(`/v1/tasks/${taskId}/artifacts`, { token: alice.token })
  assert.equal(seenByRequester.status, 200)
  assert.equal(seenByRequester.body.artifacts.length, 2)
  // Metadata only — never a path and never the bytes.
  for (const artifact of seenByRequester.body.artifacts) {
    assert.equal(typeof artifact.name, 'string')
    assert.equal(artifact.blobPath, undefined)
    assert.equal(artifact.blob_path, undefined)
  }

  const outsider = await person(hub, { phone: '+8613600136000', name: 'Outsider' })
  assert.equal((await hub.get(`/v1/tasks/${taskId}/artifacts`, { token: outsider.token })).status, 404)
})

test('an artifact cannot be attached to a task that does not exist', async (t) => {
  const { hub, bob } = await scene(t)
  const refused = await upload(hub, bob, { taskId: 'task_missing', name: 'a.pdf', mime: 'application/pdf', data: PDF.toString('base64') })
  assert.equal(refused.status, 404)
  assert.equal(refused.body.error.code, 'artifact/task-unknown')
})
