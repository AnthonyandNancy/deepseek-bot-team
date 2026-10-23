// The event log: the sequence, the dedup key, the per-device receipts, and the read cursor.
//
// The four properties the gates measure, and where each one is enforced:
//
//   * ordering — `seq` comes from `workgroups.last_seq`, incremented by the same `UPDATE` that
//     returns it, inside the same transaction that inserts the row. Two concurrent senders get
//     1 and 2, never 1 and 1, and never a hole.
//   * dedup — `event_id` is the primary key. A resent event is answered with the row already
//     stored (same seq), so a retry cannot append a second copy or advance anyone's cursor.
//   * delivery — `deliveries` records that a device was handed an event, and `ack_at` that the
//     device persisted it. `unackedFor` is what a reconnect replays: everything above the cursor
//     the device last acknowledged, whether or not a socket was ever there.
//   * read state — `read_cursors` is per (group, person), so two devices of one person share one
//     notion of "read" instead of each inventing its own.
import { randomUUID } from 'node:crypto'
import { badRequest, notFound } from '../errors.js'
import { prepared } from '../db/prepared.js'
import { isUniqueViolation } from '../db/index.js'
import { EVENT_TYPES, MAX_PAYLOAD_BYTES } from '../workgroups/service.js'

const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '')}`

// The cap on one pull. A client that reconnects after a month asks for "everything after 0"; the
// Hub answers with a bounded batch and a `hasMore` flag rather than a megabyte of JSON.
export const MAX_PULL = 200

export function createEventService({ db, audit, now = () => Date.now() }) {
  const stmt = prepared(db)
  const iso = () => new Date(now()).toISOString()

  const bumpSeq = stmt('UPDATE workgroups SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq')
  const insert = stmt(`INSERT INTO events
    (event_id, workgroup_id, seq, type, sender_id, sender_device_id, sender_endpoint_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const byEventId = stmt('SELECT * FROM events WHERE event_id = ?')
  const bySeq = stmt('SELECT * FROM events WHERE workgroup_id = ? AND seq = ?')
  // Named `afterSeqRows`, not `afterSeq`: the pull handler has a parameter of that name and a
  // shadowed statement would be called as a function ("afterSeq.all is not a function").
  const afterSeqRows = stmt('SELECT * FROM events WHERE workgroup_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
  const sinceSeq = stmt('SELECT * FROM events WHERE workgroup_id = ? AND seq > ? ORDER BY seq ASC')
  const latest = stmt('SELECT seq FROM events WHERE workgroup_id = ? ORDER BY seq DESC LIMIT 1')

  const recordDelivery = stmt(`INSERT INTO deliveries (event_id, device_id, delivered_at)
    VALUES (?, ?, ?)
    ON CONFLICT (event_id, device_id) DO UPDATE SET delivered_at = COALESCE(deliveries.delivered_at, excluded.delivered_at)`)
  const ackDelivery = stmt(`INSERT INTO deliveries (event_id, device_id, delivered_at, ack_at)
    VALUES (?, ?, NULL, ?)
    ON CONFLICT (event_id, device_id) DO UPDATE SET ack_at = COALESCE(deliveries.ack_at, excluded.ack_at)`)
  const markDelivered = stmt('UPDATE deliveries SET delivered_at = ? WHERE event_id = ? AND device_id = ? AND delivered_at IS NULL')
  const deliveryState = stmt('SELECT * FROM deliveries WHERE event_id = ? AND device_id = ?')
  const ackedSeqs = stmt(`SELECT e.seq FROM events e
    JOIN deliveries d ON d.event_id = e.event_id
    WHERE e.workgroup_id = ? AND d.device_id = ? AND d.ack_at IS NOT NULL`)

  const cursorOf = stmt('SELECT * FROM read_cursors WHERE workgroup_id = ? AND user_id = ?')
  const upsertCursor = stmt(`INSERT INTO read_cursors (workgroup_id, user_id, last_read_seq, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (workgroup_id, user_id) DO UPDATE SET
      last_read_seq = MAX(read_cursors.last_read_seq, excluded.last_read_seq),
      updated_at = excluded.updated_at`)

  // A payload must be a JSON object with a bounded serialised size. Enforced here rather than in
  // the socket handler so the HTTP path (an attachment message, say) cannot bypass it.
  const packedPayload = (payload) => {
    const value = payload === undefined ? {} : payload
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw badRequest('event/invalid-payload', 'An event payload must be a JSON object.')
    }
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw badRequest('event/payload-too-large', `An event payload may not exceed ${MAX_PAYLOAD_BYTES} bytes.`)
    }
    return text
  }

  const publicEvent = row => ({
    eventId: row.event_id,
    workgroupId: row.workgroup_id,
    seq: row.seq,
    type: row.type,
    sender: {
      userId: row.sender_id ?? undefined,
      deviceId: row.sender_device_id ?? undefined,
      botEndpointId: row.sender_endpoint_id ?? undefined,
    },
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
  })

  const service = {
    publicEvent,

    // ── append ────────────────────────────────────────────────────────────────────────
    // `sender` comes from the authenticated connection, never from the frame: a client cannot
    // claim to be someone else by filling in a field (plan §9.2).
    //
    // `eventId` is accepted from the caller so a resend after a lost response reuses the id, but
    // it is the *primary key*, not a hint: a second append with the same id returns the stored
    // event and allocates nothing.
    append({ workgroupId, eventId, type, sender, payload }) {
      if (typeof type !== 'string' || !EVENT_TYPES.has(type)) {
        throw badRequest('event/invalid-type', `"${String(type)}" is not an event type this Hub accepts.`)
      }
      const id = typeof eventId === 'string' && eventId.length > 0 && eventId.length <= 128 ? eventId : newId('evt')
      const body = packedPayload(payload)

      const existing = byEventId.get(id)
      if (existing !== undefined) {
        // The same id in a different group would be a client bug worth surfacing, not silently
        // "deduplicated" into the wrong conversation.
        if (existing.workgroup_id !== workgroupId) {
          throw badRequest('event/id-conflict', 'That event id already exists in another workgroup.')
        }
        return { event: publicEvent(existing), duplicate: true }
      }

      const at = iso()
      db.exec('BEGIN')
      let row
      try {
        row = bumpSeq.get(workgroupId)
        if (row === undefined) {
          db.exec('ROLLBACK')
          throw notFound('workgroup/not-found', 'No such workgroup.')
        }
        insert.run(id, workgroupId, row.last_seq, type, sender?.userId ?? null, sender?.deviceId ?? null,
          sender?.botEndpointId ?? null, body, at)
        db.exec('COMMIT')
      } catch (error) {
        // A concurrent append with the same id: the other one committed first, so answer with it.
        if (isUniqueViolation(error)) {
          try { db.exec('ROLLBACK') } catch { /* the transaction is already gone */ }
          const winner = byEventId.get(id)
          if (winner !== undefined && winner.workgroup_id === workgroupId) {
            return { event: publicEvent(winner), duplicate: true }
          }
        } else {
          try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
        }
        throw error
      }

      audit.record({ actorId: sender?.userId ?? null, deviceId: sender?.deviceId ?? null, action: 'event.append', targetId: workgroupId, result: type })
      return { event: publicEvent(byEventId.get(id)), duplicate: false }
    },

    // ── replay ────────────────────────────────────────────────────────────────────────
    // `afterSeq` is the cursor. The response carries the group's current `lastSeq` so a client
    // can tell "caught up" from "the group is empty" without another round trip.
    pull({ workgroupId, afterSeq = 0, limit = MAX_PULL }) {
      const from = Number.isFinite(afterSeq) && afterSeq > 0 ? Math.floor(afterSeq) : 0
      const take = Math.min(MAX_PULL, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : MAX_PULL))
      // One extra row tells us whether there is more without a second query.
      const rows = afterSeqRows.all(workgroupId, from, take + 1)
      const events = rows.slice(0, take).map(publicEvent)
      return {
        events,
        lastSeq: latest.get(workgroupId)?.seq ?? 0,
        hasMore: rows.length > take,
        nextAfterSeq: events.length === 0 ? from : events[events.length - 1].seq,
      }
    },

    // Everything after a cursor, unpaged. Used by the socket's reconnect path where the set is
    // bounded by what the device has not acknowledged yet.
    since({ workgroupId, afterSeq = 0 }) {
      return sinceSeq.all(workgroupId, afterSeq).map(publicEvent)
    },

    // ── receipts ──────────────────────────────────────────────────────────────────────
    // Called by the fan-out for every socket an event was written to. Writing before the send
    // would record a delivery that never left; writing after means a crash between the two loses
    // the receipt but not the event — the client's cursor pull still finds it.
    markDelivered({ eventId, deviceId }) {
      recordDelivery.run(eventId, deviceId, iso())
      // A row inserted by `ackDelivery` first has `delivered_at` NULL; fill it in.
      markDelivered.run(iso(), eventId, deviceId)
    },

    // An ack is idempotent and monotonic: a repeated ack keeps the first timestamp, and an ack for
    // an event this device never saw is still recorded (the client may have pulled it over HTTP,
    // which is the normal path after a reconnect).
    ack({ eventId, deviceId }) {
      const event = byEventId.get(eventId)
      if (event === undefined) throw notFound('event/not-found', 'No such event.')
      ackDelivery.run(eventId, deviceId, iso())
      return { eventId, seq: event.seq, ackedAt: deliveryState.get(eventId, deviceId)?.ack_at ?? iso() }
    },

    // The highest seq this device has acknowledged in a group, for the reconnect handshake.
    ackedThrough({ workgroupId, deviceId }) {
      const rows = ackedSeqs.all(workgroupId, deviceId)
      return rows.reduce((max, row) => Math.max(max, row.seq), 0)
    },

    // ── read cursor ───────────────────────────────────────────────────────────────────
    // Forward only. A cursor that could move backwards would make "unread" reappear on a message
    // the person already read, which reads as a bug to them.
    markRead({ workgroupId, userId, seq }) {
      const lastSeq = latest.get(workgroupId)?.seq ?? 0
      const target = Math.max(0, Math.min(lastSeq, Number.isFinite(seq) ? Math.floor(seq) : lastSeq))
      upsertCursor.run(workgroupId, userId, target, iso())
      return { workgroupId, lastReadSeq: Math.max(target, cursorOf.get(workgroupId, userId)?.last_read_seq ?? 0) }
    },

    cursor({ workgroupId, userId }) {
      return cursorOf.get(workgroupId, userId)?.last_read_seq ?? 0
    },

    // Used by the socket to answer "what did I miss" in one call: the events after the cursor and
    // the cursor itself, so a client that reconnects twice in a row does not re-fetch.
    missed({ workgroupId, deviceId, afterSeq }) {
      const acked = service.ackedThrough({ workgroupId, deviceId })
      const from = Math.max(Number.isFinite(afterSeq) ? afterSeq : 0, acked)
      return { events: service.since({ workgroupId, afterSeq: from }), afterSeq: from }
    },

    // Test/diagnostic helper: how many events a group holds. Gate 3 asserts this is 0 right after
    // an upgrade, so the number must mean exactly "rows in the log".
    count(workgroupId) {
      return stmt('SELECT count(*) AS c FROM events WHERE workgroup_id = ?').get(workgroupId).c
    },

    eventAt(workgroupId, seq) {
      return bySeq.get(workgroupId, seq)
    },
  }

  return service
}
