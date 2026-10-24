// The plugin's copy of the task envelope, compared byte for byte with the Hub's.
//
// There are two implementations on purpose: the plugin and the Hub are separate packages with
// separate dependency trees, and the plugin must not import the Hub's source to sign its own
// requests. The cost of that choice is drift, and drift on this function shows up as "bad signature"
// on somebody's machine with nothing to point at. So the two are compared here, over the shapes that
// actually occur plus the ones that are easy to get subtly wrong (nested objects, arrays, `undefined`
// values, unicode, and a payload whose key order differs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import {
  canonicalJson as pluginCanonical, payloadHash as pluginHash, signingBytes as pluginBytes, buildTaskRequest,
} from '../src/workgroup/host/envelope.js'

const hub = await import('../../../hub/src/tasks/envelope.js')

const SHAPES = [
  {},
  { a: 1 },
  { b: 2, a: 1 },
  { a: [3, { y: 1, x: 2 }] },
  { a: undefined, b: 1 },
  { text: '费用汇总', nested: { z: [1, 2, 3], y: { deep: true } } },
  { n: -0.5, m: 1e21, flag: false, nothing: null },
  { list: [], dict: {} },
  { 'ключ': 'значение', emoji: '✅' },
]

test('the canonical form of both copies is identical', () => {
  for (const shape of SHAPES) {
    assert.equal(pluginCanonical(shape), hub.canonicalJson(shape), `differs for ${JSON.stringify(shape)}`)
  }
})

test('the payload hash of both copies is identical', () => {
  for (const shape of SHAPES) {
    assert.equal(pluginHash(shape), hub.payloadHash(shape), `differs for ${JSON.stringify(shape)}`)
  }
})

test('the signed bytes of both copies are identical, including a reordered payload', () => {
  const envelope = {
    v: 1,
    eventId: 'evt_1',
    type: 'task.request',
    workgroupId: 'wg_1',
    taskId: 'task_1',
    sender: { userId: 'u-a', deviceId: 'd-a', botEndpointId: 'ep-a' },
    target: { userId: 'u-b', botEndpointId: 'ep-b' },
    createdAt: '2026-10-22T01:00:00.000Z',
    expiresAt: '2026-10-23T01:00:00.000Z',
    payload: { title: '费用汇总', requestedResources: ['resource:a'], requestedCapabilities: ['read'] },
  }
  assert.equal(pluginBytes(envelope).toString('utf8'), hub.signingBytes(envelope).toString('utf8'))

  // Key order in the object must not change the bytes: this is the property a naive
  // `JSON.stringify` loses, and the one that would make a signature fail intermittently.
  const reordered = { ...envelope, payload: { requestedCapabilities: ['read'], requestedResources: ['resource:a'], title: '费用汇总' } }
  assert.equal(pluginBytes(reordered).toString('utf8'), pluginBytes(envelope).toString('utf8'))
  // A different payload, though, must change them.
  assert.notEqual(pluginBytes({ ...envelope, payload: { title: 'something else' } }).toString('utf8'), pluginBytes(envelope).toString('utf8'))
})

test('an envelope the plugin signed verifies with the Hub verifier', () => {
  // The real interoperation check: sign with the plugin's builder, verify with the Hub's function.
  // A test that only compared strings would still pass if both were wrong in the same way.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pemPrivate = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const pemPublic = publicKey.export({ type: 'spki', format: 'pem' })
  const signBytes = (bytes) => sign(null, bytes, createPrivateKey(pemPrivate)).toString('base64')

  const envelope = buildTaskRequest({
    taskId: 'task_1',
    workgroupId: 'wg_1',
    sender: { userId: 'u-a', deviceId: 'd-a' },
    target: { userId: 'u-b' },
    payload: { title: '费用汇总', requestedResources: ['resource:a'] },
    signBytes,
    now: Date.parse('2026-10-22T01:00:00.000Z'),
  })

  assert.equal(hub.verifyEnvelope(pemPublic, envelope, envelope.signature), true)
  // Changing one field invalidates it, which is what the Hub's own contract tests rely on.
  assert.equal(hub.verifyEnvelope(pemPublic, { ...envelope, workgroupId: 'wg_2' }, envelope.signature), false)
  assert.equal(hub.verifyEnvelope(pemPublic, { ...envelope, payload: { title: 'other' } }, envelope.signature), false)
  // And so does the Hub's own check of the payload hash, independently of the signature.
  const tampered = { ...envelope, payload: { title: 'other' } }
  assert.equal(hub.checkEnvelope({ envelope: tampered, now: Date.parse('2026-10-22T01:00:00.000Z') }).code, 'task/payload-hash-mismatch')
  // The envelope the fast path built is otherwise acceptable.
  assert.equal(hub.checkEnvelope({ envelope, now: Date.parse('2026-10-22T01:00:00.000Z') }).ok, true)
})

test('the builder refuses a lifetime longer than the Hub would accept', () => {
  const { privateKey } = generateKeyPairSync('ed25519')
  const pemPrivate = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const at = Date.parse('2026-10-22T01:00:00.000Z')
  const envelope = buildTaskRequest({
    taskId: 'task_1',
    workgroupId: 'wg_1',
    sender: { userId: 'u-a', deviceId: 'd-a' },
    target: { userId: 'u-b' },
    payload: {},
    signBytes: bytes => sign(null, bytes, createPrivateKey(pemPrivate)).toString('base64'),
    now: at,
    // A year, which the Hub would refuse.
    ttlMs: 365 * 24 * 60 * 60 * 1000,
  })
  // The builder clamps rather than sending something the Hub will reject, so a client cannot build a
  // request that is wasted on arrival.
  assert.equal(Date.parse(envelope.expiresAt) - at, 7 * 24 * 60 * 60 * 1000)
})

test('the public key of the signing pair is what the Hub would read from its device row', () => {
  // A device row stores SPKI PEM; the plugin derived the same form at registration. This asserts the
  // round trip the two halves rely on, so a format change breaks here rather than at "bad signature".
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const derived = createPublicKey(createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' })))
    .export({ type: 'spki', format: 'pem' })
  assert.equal(derived, publicKey.export({ type: 'spki', format: 'pem' }))
})
