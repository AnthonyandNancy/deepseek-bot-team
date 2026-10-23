// Authorized artifacts (plan §12 `artifacts`, §13.2 file relay).
//
// This is NOT the chat attachment relay. `attachments` (G4) is an ordinary file in a conversation:
// anybody in the group may upload one and anybody in the group may download it. An artifact is a
// RESULT — it hangs off an approved task, it carries an ACL that says who may read it, and it
// becomes `revoked` the moment the approval behind it is withdrawn. Keeping the two apart is what
// lets "share this with the group" and "share the outcome of this task with the person who asked"
// be different decisions.
//
// The rules, each with a reason:
//   * the bytes travel, never a path. `blob_path` is generated here from a fresh id and is not
//     returned by any endpoint — the same shape as `attachments.storage_key`, and the reason
//     `/v1/artifacts/uploads` takes `{ taskId, name, mime, data }` and nothing else (§13.2:
//     "绝不传可直接访问本地目录的绝对路径");
//   * size, extension and MIME are checked here, once, before anything is written;
//   * the ACL is a list of Hub user ids, and the requester of the task is on it by default. A
//     downloaded artifact is checked against that list AND against current group membership, so
//     leaving the group closes the door on an artifact whose ACL still names you;
//   * revocation is a state, not a delete: the event log references the artifact, and a reader
//     should see "withdrawn" rather than a broken reference.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HubError, badRequest, conflict, forbidden, notFound } from '../errors.js'
import { prepared } from '../db/prepared.js'
import { ALLOWED_TYPES, MIME_ALIASES, safeDisplayName } from '../attachments/service.js'

const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '')}`

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
export const ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const ARTIFACT_TICKET_TTL_MS = 5 * 60 * 1000

const extensionOf = (name) => {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name ?? ''))
  return match === null ? '' : match[1].toLowerCase()
}

export function createArtifactService({ db, audit, dataDir, now = () => Date.now(), ttlMs = ARTIFACT_TTL_MS }) {
  const stmt = prepared(db)
  const iso = () => new Date(now()).toISOString()
  const blobs = join(dataDir, 'artifacts')

  const insert = stmt(`INSERT INTO artifacts
    (id, task_id, workgroup_id, owner_id, uploader_device_id, name, mime, size, hash, blob_path, acl, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const byId = stmt('SELECT * FROM artifacts WHERE id = ?')
  const ofTask = stmt('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC')
  const revokeRow = stmt("UPDATE artifacts SET state = 'revoked', revoked_at = ? WHERE id = ?")
  const dueRows = stmt("SELECT * FROM artifacts WHERE state = 'available' AND expires_at <= ?")

  // A ticket table for artifacts would be a second copy of the attachment one; instead the download
  // is authorized on every request by the ACL, which is the stronger check and needs no expiry of
  // its own. What an artifact does NOT get is a short-lived URL: it gets a bearer-authorized GET,
  // because the requester may come back to it for as long as the artifact exists.

  const publicArtifact = row => ({
    artifactId: row.id,
    taskId: row.task_id,
    workgroupId: row.workgroup_id,
    ownerId: row.owner_id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    hash: row.hash,
    acl: JSON.parse(row.acl),
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  })

  // The same double check the attachment relay uses: an extension on the allow-list AND a MIME the
  // extension agrees with. One alone is how a renamed executable becomes a "png".
  const checkType = (name, mime) => {
    const ext = extensionOf(name)
    if (ext === '') throw badRequest('artifact/unknown-type', `"${name}" has no extension, so its type cannot be checked.`)
    const canonical = ALLOWED_TYPES.get(ext)
    if (canonical === undefined) {
      throw badRequest('artifact/type-not-allowed', `Files of type .${ext} are not accepted for sharing. Accepted: ${[...ALLOWED_TYPES.keys()].join(', ')}.`)
    }
    const declared = String(mime ?? '').toLowerCase().split(';')[0].trim()
    const allowed = MIME_ALIASES.get(ext) ?? [canonical]
    if (!allowed.includes(declared)) {
      throw badRequest('artifact/type-mismatch', `A .${ext} file must be sent as ${allowed.join(' or ')}, not "${declared || '(none)'}".`)
    }
    return { ext, mime: canonical }
  }

  // Whether this person may read this artifact right now. Both halves matter: the ACL is the
  // sharing decision, and membership is the fact it was made in.
  const mayRead = ({ userId, row, isMember }) => {
    if (row.state !== 'available') return false
    const acl = JSON.parse(row.acl)
    if (!acl.includes(userId)) return false
    return isMember(row.workgroup_id, userId)
  }

  const service = {
    MAX_ARTIFACT_BYTES,
    publicArtifact,
    checkType,

    // ── POST /v1/artifacts/uploads ───────────────────────────────────────────────────
    // Only the owner of the task may share its result: the person who ran the work decides what of
    // it becomes visible, which is §10.1 step 7 and the reason this is not an open upload.
    async upload({ userId, deviceId, body, isMember }) {
      const taskId = String(body?.taskId ?? '')
      if (taskId === '') throw badRequest('artifact/task-required', 'An artifact needs the task it is the result of.')
      const task = stmt('SELECT * FROM tasks WHERE id = ?').get(taskId)
      if (task === undefined) throw notFound('artifact/task-unknown', 'No such task.')
      if (task.owner_id !== userId) throw notFound('artifact/task-unknown', 'No such task.')
      // An artifact with no approval behind it is a file the group never agreed to receive.
      const live = stmt(`SELECT * FROM approvals WHERE task_id = ? AND decision = 'granted' AND revoked_at IS NULL`).get(taskId)
      if (live === undefined) throw conflict('artifact/not-approved', 'That task has no live approval, so its result cannot be shared.')
      if (live.expires_at <= iso()) throw conflict('artifact/approval-expired', 'The approval behind that task has expired.')
      if (task.state !== 'RUNNING' && task.state !== 'RESULT_REVIEW' && task.state !== 'COMPLETED') {
        throw conflict('artifact/task-not-running', `That task is ${task.state}; it has no result to share yet.`)
      }
      if (!isMember(task.workgroup_id, userId)) throw notFound('workgroup/not-found', 'No such workgroup.')

      const name = safeDisplayName(body?.name)
      const { mime } = checkType(name, body?.mime)
      if (typeof body?.data !== 'string' || body.data.length === 0) throw badRequest('artifact/invalid-body', 'An upload needs its bytes as base64 in "data".')
      let bytes
      try { bytes = Buffer.from(body.data, 'base64') } catch { throw badRequest('artifact/invalid-body', 'The artifact data is not valid base64.') }
      if (bytes.length === 0) throw badRequest('artifact/invalid-body', 'The artifact is empty.')
      if (bytes.length > MAX_ARTIFACT_BYTES) {
        throw badRequest('artifact/too-large', `An artifact may be at most ${Math.floor(MAX_ARTIFACT_BYTES / (1024 * 1024))} MiB.`)
      }
      const hash = createHash('sha256').update(bytes).digest('hex')
      const id = newId('art')
      const blobPath = `${id}.${extensionOf(name)}`

      // Who may read it. The requester is on the list by default — they asked for the work — and the
      // owner always is. Anything else is the owner's explicit choice, and only group members can be
      // added: an ACL naming a stranger would be a grant nobody could exercise.
      const requested = Array.isArray(body?.acl) ? body.acl.map(String) : []
      const acl = [...new Set([task.requester_id, userId, ...requested])]
      for (const person of acl) {
        if (!isMember(task.workgroup_id, person)) {
          throw badRequest('artifact/acl-not-in-group', 'An artifact may only be shared with members of its workgroup.')
        }
      }

      await mkdir(blobs, { recursive: true })
      await writeFile(join(blobs, blobPath), bytes, { mode: 0o600 })
      const at = now()
      try {
        insert.run(id, task.id, task.workgroup_id, userId, deviceId ?? null, name, mime, bytes.length, hash,
          blobPath, JSON.stringify(acl), new Date(at).toISOString(), new Date(at + ttlMs).toISOString())
      } catch (error) {
        // A refused row must not leave an orphan file behind.
        await rm(join(blobs, blobPath), { force: true })
        throw error
      }
      audit.record({ actorId: userId, deviceId: deviceId ?? null, action: 'artifact.upload', targetId: id, result: 'ok' })
      return { artifact: publicArtifact(byId.get(id)) }
    },

    // ── GET /v1/artifacts/:id/download ──────────────────────────────────────────────
    // Authorized on every request: the ACL decides, current membership confirms.
    async download({ userId, artifactId, isMember }) {
      const row = byId.get(artifactId)
      if (row === undefined) throw notFound('artifact/not-found', 'No such artifact.')
      if (!mayRead({ userId, row, isMember })) {
        // One answer for "not shared with you", "withdrawn" and "not in this group": an artifact id
        // must not become a way to learn what somebody else was given, and all three mean the same
        // thing to the person asking.
        throw notFound('artifact/not-found', 'No such artifact.')
      }
      if (row.expires_at <= iso()) throw new HubError(410, 'artifact/expired', 'That artifact has expired and was removed.')
      let bytes
      try {
        bytes = await readFile(join(blobs, row.blob_path))
      } catch {
        throw new HubError(410, 'artifact/gone', 'That artifact is no longer stored.')
      }
      return { artifact: row, bytes }
    },

    listForTask({ userId, taskId, isMember }) {
      const task = stmt('SELECT * FROM tasks WHERE id = ?').get(taskId)
      if (task === undefined) throw notFound('task/not-found', 'No such task.')
      if (task.owner_id !== userId && task.requester_id !== userId) throw notFound('task/not-found', 'No such task.')
      return {
        artifacts: ofTask.all(taskId)
          .filter(row => row.state === 'available' && JSON.parse(row.acl).includes(userId) && isMember(row.workgroup_id, userId))
          .map(publicArtifact),
      }
    },

    // Withdrawing an artifact. The owner may do it; so may the task's owner after a revoke, which is
    // why the revoke path calls `revokeForTask` rather than this.
    revoke({ userId, artifactId }) {
      const row = byId.get(artifactId)
      if (row === undefined) throw notFound('artifact/not-found', 'No such artifact.')
      if (row.owner_id !== userId) throw forbidden('artifact/not-owner', 'Only the person who shared this artifact may withdraw it.')
      revokeRow.run(iso(), row.id)
      audit.record({ actorId: userId, deviceId: null, action: 'artifact.revoke', targetId: row.id, result: 'ok' })
      return { artifact: publicArtifact(byId.get(row.id)) }
    },

    // Called when an approval is revoked: every artifact of that task stops being readable at once.
    // Returns the rows so the caller can append the `artifact.revoked` events.
    revokeForTask(taskId) {
      const rows = ofTask.all(taskId).filter(row => row.state === 'available')
      for (const row of rows) revokeRow.run(iso(), row.id)
      return rows.map(row => publicArtifact(byId.get(row.id)))
    },

    // Expiry: mark and delete the bytes. Marked rather than deleted so a log line that names the
    // artifact still resolves to "expired" instead of a dangling id.
    async sweep() {
      const at = iso()
      const rows = dueRows.all(at)
      let removed = 0
      for (const row of rows) {
        await rm(join(blobs, row.blob_path), { force: true })
        revokeRow.run(at, row.id)
        removed += 1
      }
      return { removed }
    },

    artifactsOf: taskId => ofTask.all(taskId).map(publicArtifact),
  }

  return service
}
