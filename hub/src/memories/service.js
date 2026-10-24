// Group memory: the Hub's authoritative store for what a workgroup knows (plan §11–§12).
//
// The rules and where they live:
//
//   * membership first — every method calls `requireMember` before it looks at a memory id, so a
//     non-member gets the same 404 as a missing group and cannot probe either;
//   * the ACL is explicit — a row is readable only by the user ids in its JSON `acl`; the creator
//     is always included, and every id must be an active member of this group;
//   * a correction is compare-and-apply — the caller sends the version it read, and a stale write
//     changes nothing;
//   * a delete is soft — the entry leaves reads and the FTS index (via the migration trigger), but
//     `group_memory_events` keeps the audit trail.
import { randomUUID } from 'node:crypto'
import { badRequest, conflict, notFound } from '../errors.js'
import { prepared } from '../db/prepared.js'

const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '')}`

export const MEMORY_TYPES = new Set(['canon', 'decision', 'faq', 'fact', 'artifact'])
export const MAX_CONTENT_LENGTH = 4000
const MAX_SOURCE_REFS = 50
const SOURCE_KINDS = new Set(['message', 'task', 'artifact', 'manual'])
// Deliberately narrow: this catches the common copy/paste mistake without pretending to be a
// secret scanner. A false positive only asks the author to rephrase; a miss is handled by the
// member-only ACL and the operator's own key hygiene.
const CREDENTIAL = /(?:api[_-]?key|password|secret|token)\s*[:=]/i

export function createMemoryService({ db, audit, now = () => Date.now(), events, onMemoryEvent } = {}) {
  const stmt = prepared(db)
  const iso = () => new Date(now()).toISOString()

  const membershipOf = stmt(`SELECT id FROM memberships
    WHERE workgroup_id = ? AND member_type = 'user' AND user_id = ? AND status = 'active'`)
  const groupExists = stmt('SELECT id FROM workgroups WHERE id = ?')
  const byId = stmt('SELECT * FROM group_memories WHERE id = ? AND workgroup_id = ?')
  const insertMemory = stmt(`INSERT INTO group_memories
    (id, workgroup_id, type, content, source_refs, acl, version, created_by, created_at, updated_at, expires_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`)
  const correctMemory = stmt(`UPDATE group_memories
    SET content = ?, source_refs = ?, acl = ?, version = version + 1, updated_at = ?
    WHERE id = ? AND workgroup_id = ? AND version = ? AND deleted_at IS NULL`)
  const deleteMemory = stmt(`UPDATE group_memories
    SET version = version + 1, updated_at = ?, deleted_at = ?
    WHERE id = ? AND workgroup_id = ? AND version = ? AND deleted_at IS NULL`)
  const insertAudit = stmt(`INSERT INTO group_memory_events
    (id, memory_id, workgroup_id, action, version, before, after, actor_id, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const sourceMessage = stmt('SELECT event_id FROM events WHERE event_id = ? AND workgroup_id = ?')

  // FTS is asked first, then the ACL is applied by the caller. The content of an entry the caller
  // may not read is never returned, even though FTS itself has no notion of users.
  const listed = stmt(`SELECT * FROM group_memories
    WHERE workgroup_id = ? AND deleted_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC, id DESC`)
  const searched = stmt(`SELECT m.* FROM group_memories m
    JOIN group_memories_fts f ON f.rowid = m.rowid
    WHERE m.workgroup_id = ? AND m.deleted_at IS NULL
      AND (m.expires_at IS NULL OR m.expires_at > ?)
      AND group_memories_fts MATCH ?
    ORDER BY bm25(group_memories_fts), m.updated_at DESC
    LIMIT ?`)

  const publicMemory = row => ({
    memoryId: row.id,
    workgroupId: row.workgroup_id,
    type: row.type,
    content: row.content,
    sourceRefs: JSON.parse(row.source_refs),
    acl: JSON.parse(row.acl),
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  })

  // A group the caller cannot see is reported as missing, not forbidden. This is the one gate every
  // public method crosses; keeping it in a single function is what stops a future read path from
  // forgetting it.
  const requireMember = (workgroupId, userId) => {
    if (groupExists.get(workgroupId) === undefined) throw notFound('workgroup/not-found', 'No such workgroup.')
    if (membershipOf.get(workgroupId, userId) === undefined) throw notFound('workgroup/not-found', 'No such workgroup.')
  }

  const normalizeContent = (content) => {
    if (typeof content !== 'string') throw badRequest('memory/invalid-content', 'Memory content must be text.')
    const trimmed = content.trim()
    if (trimmed.length === 0 || trimmed.length > MAX_CONTENT_LENGTH) {
      throw badRequest('memory/invalid-content', `Memory content must be 1–${MAX_CONTENT_LENGTH} characters.`)
    }
    if (CREDENTIAL.test(trimmed)) {
      throw badRequest('memory/credential-like', 'That text looks like a credential; store it elsewhere.')
    }
    return trimmed
  }

  const normalizeType = (type) => {
    if (typeof type !== 'string' || !MEMORY_TYPES.has(type)) {
      throw badRequest('memory/invalid-type', 'A memory type is canon, decision, faq, fact or artifact.')
    }
    return type
  }

  const normalizeSourceRefs = (workgroupId, sourceRefs) => {
    const refs = sourceRefs === undefined ? [] : sourceRefs
    if (!Array.isArray(refs) || refs.length > MAX_SOURCE_REFS) {
      throw badRequest('memory/invalid-source-refs', 'Source refs must be an array of at most 50 references.')
    }
    return refs.map((ref) => {
      if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
        throw badRequest('memory/invalid-source-refs', 'Each source ref must be an object.')
      }
      if (!SOURCE_KINDS.has(ref.kind) || typeof ref.id !== 'string' || ref.id === '') {
        throw badRequest('memory/invalid-source-refs', 'A source ref needs a known kind and a non-empty id.')
      }
      if (ref.kind === 'message' && sourceMessage.get(ref.id, workgroupId) === undefined) {
        throw badRequest('memory/source-not-in-group', 'A message source must belong to this workgroup.')
      }
      return { kind: ref.kind, id: ref.id }
    })
  }

  const normalizeAcl = (workgroupId, userId, acl) => {
    const requested = acl === undefined ? [] : acl
    if (!Array.isArray(requested)) throw badRequest('memory/invalid-acl', 'The ACL must be an array of user ids.')
    const ids = [...new Set([userId, ...requested])]
    for (const id of ids) {
      if (typeof id !== 'string' || id === '') throw badRequest('memory/invalid-acl', 'The ACL must contain user ids.')
      if (membershipOf.get(workgroupId, id) === undefined) {
        throw badRequest('memory/acl-not-in-group', 'Every ACL user must be an active member of this workgroup.')
      }
    }
    return ids
  }

  const normalizeExpiry = (expiresAt) => {
    if (expiresAt === undefined || expiresAt === null || expiresAt === '') return null
    const parsed = Date.parse(String(expiresAt))
    if (!Number.isFinite(parsed)) throw badRequest('memory/invalid-expiry', 'expiresAt must be an ISO date.')
    return new Date(parsed).toISOString()
  }

  const appendEvent = ({ row, action, actorId, before }) => {
    const appended = events.append({
      workgroupId: row.workgroup_id,
      type: `memory.${action}`,
      sender: { userId: actorId },
      payload: {
        memoryId: row.id,
        type: row.type,
        version: row.version,
        content: row.content,
        sourceRefs: JSON.parse(row.source_refs),
        acl: JSON.parse(row.acl),
      },
    })
    // The log is already the durable record. A dead socket must never undo a committed memory.
    try { onMemoryEvent?.({ workgroupId: row.workgroup_id, event: appended.event }) } catch { /* best effort */ }
    audit.record({ actorId, action: `memory.${action}`, targetId: row.id, result: 'ok' })
    return { memory: publicMemory(row), event: appended.event, ...(before === undefined ? {} : { before }) }
  }

  const readable = (row, userId) => {
    try {
      return JSON.parse(row.acl).includes(userId)
    } catch {
      // A malformed ACL must fail closed. Rows are written by this service, but a hand-edited
      // database should not become a way to read everything.
      return false
    }
  }

  const requireVersion = (expectedVersion) => {
    const version = Number(expectedVersion)
    if (!Number.isInteger(version) || version < 1) {
      throw badRequest('memory/version-required', 'A correction or deletion must name the version it read.')
    }
    return version
  }

  const service = {
    create({ userId, workgroupId, type, content, sourceRefs, acl, expiresAt }) {
      requireMember(workgroupId, userId)
      const normalizedType = normalizeType(type)
      const normalizedContent = normalizeContent(content)
      const refs = normalizeSourceRefs(workgroupId, sourceRefs)
      const users = normalizeAcl(workgroupId, userId, acl)
      const expiry = normalizeExpiry(expiresAt)
      const at = iso()
      const id = newId('mem')
      db.exec('BEGIN')
      let row
      try {
        insertMemory.run(id, workgroupId, normalizedType, normalizedContent, JSON.stringify(refs),
          JSON.stringify(users), userId, at, at, expiry)
        row = byId.get(id, workgroupId)
        insertAudit.run(newId('memev'), id, workgroupId, 'created', row.version, null,
          JSON.stringify(publicMemory(row)), userId, at)
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* already gone */ }
        throw error
      }
      return appendEvent({ row, action: 'created', actorId: userId })
    },

    correct({ userId, workgroupId, memoryId, content, sourceRefs, acl, expectedVersion }) {
      requireMember(workgroupId, userId)
      const current = byId.get(memoryId, workgroupId)
      if (current === undefined || current.deleted_at !== null) {
        throw notFound('memory/not-found', 'No such memory.')
      }
      const version = requireVersion(expectedVersion)
      const normalizedContent = normalizeContent(content)
      const refs = sourceRefs === undefined ? JSON.parse(current.source_refs) : normalizeSourceRefs(workgroupId, sourceRefs)
      const users = acl === undefined ? JSON.parse(current.acl) : normalizeAcl(workgroupId, userId, acl)
      const at = iso()
      db.exec('BEGIN')
      let row
      try {
        const changed = correctMemory.run(normalizedContent, JSON.stringify(refs), JSON.stringify(users),
          at, memoryId, workgroupId, version)
        if (changed.changes === 0) {
          db.exec('ROLLBACK')
          // The caller's version is stale, or a concurrent delete won. Both mean "re-read"; neither
          // may overwrite the newer state.
          throw conflict('memory/version-conflict', 'That memory moved on; re-read it and try again.')
        }
        row = byId.get(memoryId, workgroupId)
        insertAudit.run(newId('memev'), memoryId, workgroupId, 'corrected', row.version,
          JSON.stringify(publicMemory(current)), JSON.stringify(publicMemory(row)), userId, at)
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* already gone */ }
        throw error
      }
      return appendEvent({ row, action: 'corrected', actorId: userId, before: publicMemory(current) })
    },

    remove({ userId, workgroupId, memoryId, expectedVersion }) {
      requireMember(workgroupId, userId)
      const current = byId.get(memoryId, workgroupId)
      if (current === undefined || current.deleted_at !== null) {
        throw notFound('memory/not-found', 'No such memory.')
      }
      const version = requireVersion(expectedVersion)
      const at = iso()
      db.exec('BEGIN')
      let row
      try {
        const changed = deleteMemory.run(at, at, memoryId, workgroupId, version)
        if (changed.changes === 0) {
          db.exec('ROLLBACK')
          throw conflict('memory/version-conflict', 'That memory moved on; re-read it and try again.')
        }
        row = byId.get(memoryId, workgroupId)
        insertAudit.run(newId('memev'), memoryId, workgroupId, 'deleted', row.version,
          JSON.stringify(publicMemory(current)), JSON.stringify(publicMemory(row)), userId, at)
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* already gone */ }
        throw error
      }
      return appendEvent({ row, action: 'deleted', actorId: userId, before: publicMemory(current) })
    },

    list({ userId, workgroupId }) {
      requireMember(workgroupId, userId)
      return {
        memories: listed.all(workgroupId, iso()).filter(row => readable(row, userId)).map(publicMemory),
      }
    },

    search({ userId, workgroupId, query, limit = 50 }) {
      requireMember(workgroupId, userId)
      const normalized = typeof query === 'string' ? query.trim() : ''
      if (normalized === '') return { memories: [] }
      const take = Math.min(50, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50))
      // FTS5 query syntax accepts operators and quotes; a user typing `"` must not turn a search box
      // into a 500. Each term is quoted as a phrase, which is also what makes trigram matching
      // predictable for ordinary words.
      const terms = normalized.split(/\s+/).filter(Boolean).map(term => `"${term.replaceAll('"', '""')}"`)
      if (terms.length === 0) return { memories: [] }
      const rows = searched.all(workgroupId, iso(), terms.join(' AND '), take * 4)
      return { memories: rows.filter(row => readable(row, userId)).slice(0, take).map(publicMemory) }
    },
  }

  return service
}
