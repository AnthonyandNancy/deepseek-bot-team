// The attachment relay (plan §13.2, acceptance case T08).
//
// The flow is fixed: the sender produces bytes locally, checks them, and posts the bytes. The Hub
// stores them under a key of its own making and hands back an id. Nobody ever sends a path, and
// there is nowhere to put one: the request body is `{ name, mime, data }` and the storage key is
// generated here from a random id.
//
// Four refusals, each because the alternative is a hole:
//   * size — a hard cap checked before the bytes are hashed or written;
//   * type — the declared MIME *and* the file extension must both be on the allow-list, so a
//     renamed executable does not become an image by claiming to be one;
//   * ACL — upload and download both require current membership of the group, re-checked at
//     redemption rather than trusted from the ticket;
//   * expiry — a stored blob has a lifetime, and `sweep` deletes both the row and the file.
//
// The bytes are base64 in the JSON body because the Hub's HTTP layer reads a JSON body and
// nothing else. That costs 33% in transit and keeps one parser instead of two — a trade the
// acceptance matrix's "chat with an attachment" is worth, and one that the size cap bounds.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HubError, badRequest, forbidden, notFound } from '../errors.js'
import { prepared } from '../db/prepared.js'

const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '')}`

// 8 MiB of decoded bytes. Small enough that a base64 body (≈11 MiB) still fits through the Hub's
// own body cap when the route is given a larger one, large enough for a screenshot or a PDF.
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

// The allow-list is by extension *and* by MIME, and the two must agree. Guessing from one alone is
// how a `.html` uploaded as `image/png` ends up rendered as markup.
export const ALLOWED_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['pdf', 'application/pdf'],
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['csv', 'text/csv'],
  ['json', 'application/json'],
  ['zip', 'application/zip'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
])

// MIME values a client may claim for each extension, allowing the common aliases. `text/plain` is
// accepted for the text formats because that is what a browser reports for a `.md` file.
//
// Exported because G5's artifact relay checks the same list. Two copies would drift, and the drift
// would show up as "this .md uploaded fine as a chat file and was refused as a task result".
export const MIME_ALIASES = new Map([
  ['md', ['text/markdown', 'text/plain']],
  ['csv', ['text/csv', 'text/plain', 'application/csv']],
  ['json', ['application/json', 'text/plain']],
  ['txt', ['text/plain']],
  ['jpg', ['image/jpeg']],
  ['jpeg', ['image/jpeg']],
])

export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const TICKET_TTL_MS = 5 * 60 * 1000

const extensionOf = (name) => {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name ?? ''))
  return match === null ? '' : match[1].toLowerCase()
}

// A display name, stripped of anything that could be read as a path. The stored file never uses
// it — `storage_key` does — so this only has to be safe to show.
export function safeDisplayName(raw) {
  const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  const base = text.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/^\.+/, '').slice(0, 180)
  return cleaned === '' ? 'attachment' : cleaned
}

export function createAttachmentService({ db, audit, dataDir, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS }) {
  const stmt = prepared(db)
  const iso = () => new Date(now()).toISOString()
  const blobs = join(dataDir, 'blobs')

  const insert = stmt(`INSERT INTO attachments
    (id, workgroup_id, uploader_id, uploader_device_id, name, mime, size, sha256, storage_key, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const byId = stmt('SELECT * FROM attachments WHERE id = ?')
  const ofGroup = stmt('SELECT * FROM attachments WHERE workgroup_id = ? AND deleted_at IS NULL ORDER BY created_at ASC')
  const markDeleted = stmt('UPDATE attachments SET deleted_at = ? WHERE id = ?')
  const expired = stmt('SELECT * FROM attachments WHERE deleted_at IS NULL AND expires_at <= ?')

  const insertTicket = stmt('INSERT INTO attachment_tickets (id, attachment_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
  const ticketById = stmt('SELECT * FROM attachment_tickets WHERE id = ?')

  const publicAttachment = row => ({
    attachmentId: row.id,
    workgroupId: row.workgroup_id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  })

  // One place decides whether a pair of (name, mime) is acceptable, so the checks cannot drift
  // apart between the "validate" and "store" steps.
  const checkType = (name, mime) => {
    const ext = extensionOf(name)
    if (ext === '') throw badRequest('attachment/unknown-type', `"${name}" has no extension, so its type cannot be checked.`)
    const canonical = ALLOWED_TYPES.get(ext)
    if (canonical === undefined) {
      throw badRequest('attachment/type-not-allowed', `Files of type .${ext} are not accepted. Accepted: ${[...ALLOWED_TYPES.keys()].join(', ')}.`)
    }
    const declared = String(mime ?? '').toLowerCase().split(';')[0].trim()
    const allowed = MIME_ALIASES.get(ext) ?? [canonical]
    if (!allowed.includes(declared)) {
      throw badRequest('attachment/type-mismatch',
        `A .${ext} file must be sent as ${allowed.join(' or ')}, not "${declared || '(none)'}".`)
    }
    return { ext, mime: canonical }
  }

  const service = {
    MAX_ATTACHMENT_BYTES,
    publicAttachment,
    checkType,
    safeDisplayName,

    // ── POST /v1/workgroups/:id/attachments ───────────────────────────────────────────
    // `data` is base64. The decoded length is what the cap applies to: a caller cannot smuggle a
    // larger file past the check by sending bytes whose base64 is short.
    async upload({ userId, deviceId, workgroupId, body, isMember }) {
      if (!isMember(workgroupId, userId)) throw notFound('workgroup/not-found', 'No such workgroup.')
      const name = safeDisplayName(body.name)
      const { mime } = checkType(name, body.mime)
      if (typeof body.data !== 'string' || body.data.length === 0) throw badRequest('attachment/invalid-body', 'An upload needs its bytes as base64 in "data".')

      let bytes
      try {
        bytes = Buffer.from(body.data, 'base64')
      } catch {
        throw badRequest('attachment/invalid-body', 'The attachment data is not valid base64.')
      }
      if (bytes.length === 0) throw badRequest('attachment/invalid-body', 'The attachment is empty.')
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw badRequest('attachment/too-large', `An attachment may be at most ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MiB.`)
      }

      // The hash is computed from what was received, not trusted from the caller: it is what a
      // downloader can verify, and what the tests compare to prove the bytes round-trip.
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const id = newId('att')
      // The storage key is derived only from the new id and the (already checked) extension. It is
      // never a client value, so no request can name where a file lands.
      const storageKey = `${id}.${extensionOf(name)}`

      await mkdir(blobs, { recursive: true })
      await writeFile(join(blobs, storageKey), bytes, { mode: 0o600 })

      const at = now()
      try {
        insert.run(id, workgroupId, userId, deviceId ?? null, name, mime, bytes.length, sha256, storageKey,
          new Date(at).toISOString(), new Date(at + ttlMs).toISOString())
      } catch (error) {
        // A database refusal must not leave an orphan blob behind.
        await rm(join(blobs, storageKey), { force: true })
        throw error
      }

      audit.record({ actorId: userId, deviceId: deviceId ?? null, action: 'attachment.upload', targetId: id, result: 'ok' })
      return { attachment: publicAttachment(byId.get(id)) }
    },

    // ── GET /v1/workgroups/:id/attachments ────────────────────────────────────────────
    list({ userId, workgroupId, isMember }) {
      if (!isMember(workgroupId, userId)) throw notFound('workgroup/not-found', 'No such workgroup.')
      return { attachments: ofGroup.all(workgroupId).map(publicAttachment) }
    },

    // ── POST /v1/attachments/:id/ticket ───────────────────────────────────────────────
    // A download needs a ticket, and getting one needs current membership. The ticket is short
    // lived and single-purpose: it names one attachment and one person.
    issueTicket({ userId, attachmentId, isMember }) {
      const attachment = byId.get(attachmentId)
      if (attachment === undefined || attachment.deleted_at !== null) throw notFound('attachment/not-found', 'No such attachment.')
      if (!isMember(attachment.workgroup_id, userId)) throw notFound('attachment/not-found', 'No such attachment.')
      if (attachment.expires_at <= iso()) throw gone('attachment/expired', 'That attachment has expired and was removed.')

      const id = newId('tik')
      const at = now()
      const expiresAt = new Date(at + TICKET_TTL_MS).toISOString()
      insertTicket.run(id, attachment.id, userId, new Date(at).toISOString(), expiresAt)
      return {
        ticket: id,
        attachmentId: attachment.id,
        expiresAt,
        // The path to redeem it. The client is told, rather than left to construct one.
        downloadPath: `/v1/attachments/${attachment.id}/download?ticket=${encodeURIComponent(id)}`,
      }
    },

    // ── GET /v1/attachments/:id/download?ticket=… ─────────────────────────────────────
    // Membership is checked *again* here. A ticket proves "this person was in the group five
    // minutes ago"; leaving must close the door now, not when the ticket happens to expire.
    async download({ userId, attachmentId, ticketId, isMember }) {
      const ticket = ticketById.get(String(ticketId ?? ''))
      if (ticket === undefined || ticket.attachment_id !== attachmentId || ticket.user_id !== userId) {
        throw forbidden('attachment/bad-ticket', 'That download ticket is not valid for this attachment.')
      }
      if (ticket.expires_at <= iso()) throw gone('attachment/ticket-expired', 'That download ticket has expired. Ask for a new one.')

      const attachment = byId.get(attachmentId)
      if (attachment === undefined || attachment.deleted_at !== null) throw notFound('attachment/not-found', 'No such attachment.')
      if (attachment.expires_at <= iso()) throw gone('attachment/expired', 'That attachment has expired and was removed.')
      if (!isMember(attachment.workgroup_id, userId)) throw notFound('attachment/not-found', 'No such attachment.')

      let bytes
      try {
        bytes = await readFile(join(blobs, attachment.storage_key))
      } catch {
        // Row without bytes: the sweeper got there first, or a disk was lost. Either way the file
        // is gone and saying so is better than a 500.
        throw gone('attachment/gone', 'That attachment is no longer stored.')
      }
      return { attachment, bytes }
    },

    // ── expiry ───────────────────────────────────────────────────────────────────────
    // Deletes the blob and marks the row. Marked rather than deleted so an event that still
    // references it can be rendered as "attachment expired" instead of pointing at nothing.
    async sweep() {
      const at = iso()
      const rows = expired.all(at)
      let removed = 0
      for (const row of rows) {
        await rm(join(blobs, row.storage_key), { force: true })
        markDeleted.run(at, row.id)
        removed += 1
      }
      // Tickets are cheap and never read after their window; clearing them keeps the table honest.
      db.prepare('DELETE FROM attachment_tickets WHERE expires_at <= ?').run(at)
      return { removed }
    },
  }

  return service
}

// 410, distinct from 404: "this existed and is gone" is a different sentence in the UI from
// "there is no such thing", and only one of them means the person should ask for a re-send.
const gone = (code, message) => new HubError(410, code, message)
