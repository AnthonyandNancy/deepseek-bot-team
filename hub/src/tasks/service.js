// Tasks: the Hub's half of cross-user delegation (plan §10, §12, §13.1).
//
// What the Hub owns, and what it deliberately does not:
//
//   * it owns the RECORD — who asked whom for what, in which state, with which approval scope, and
//     which device made the decision. Every transition is checked against §10.2's machine, so an
//     unapproved task can never be stored as RUNNING;
//   * it does NOT own authorization. `docs/workgroup/g5/DESIGN-CHANNEL-AND-SEQ.md` and §10.3 are
//     unambiguous: "Hub 的『批准』事件不能独立激活 B 的工具权限". An approval row here is a record of
//     what B decided on B's device; the thing that lets a tool run is B's local ledger.
//
// Three invariants worth naming, because each is a gate:
//
//   1. **The decider is the owner's device.** `decision` reads the device from the authenticated
//      session and stores it; the body cannot name one. Gate 3 ("出单设备明确") is therefore a row,
//      not a claim.
//   2. **Only §10.2's moves are accepted.** A transition list that named no rules would let
//      REJECTED → RUNNING through, which is precisely what gate 1 measures.
//   3. **A task id is the requester's.** A redelivered `task.request` (the plugin's outbox resends
//      the same id after a lost ack) returns the stored task instead of creating a second one. That
//      is what keeps at-least-once delivery from becoming twice the work (gate 5).
import { randomUUID } from 'node:crypto'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { prepared } from '../db/prepared.js'
import { isUniqueViolation } from '../db/index.js'
import { EVENT_TYPES, MAX_PAYLOAD_BYTES } from '../workgroups/service.js'
import { checkEnvelope, payloadHash, verifyEnvelope } from './envelope.js'

const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '')}`

// Plan §10.2, verbatim: the main line, then the branches.
export const TASK_STATES = [
  'REQUESTED', 'DELIVERED', 'PENDING_APPROVAL', 'APPROVED', 'ASSIGNED', 'RUNNING',
  'RESULT_REVIEW', 'COMPLETED',
  'REJECTED', 'EXPIRED', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED', 'INTERRUPTED',
]

// A state a task never leaves. Kept identical to the plugin's own list
// (ds-bot/src/workgroup/host/tasks.js) — the two machines are the same machine.
export const FINAL_STATES = ['COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED']

const TRANSITIONS = {
  REQUESTED: ['DELIVERED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  DELIVERED: ['PENDING_APPROVAL', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  APPROVED: ['ASSIGNED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  ASSIGNED: ['RUNNING', 'EXPIRED', 'CANCELLED', 'FAILED', 'INTERRUPTED'],
  RUNNING: ['RESULT_REVIEW', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED', 'INTERRUPTED', 'COMPLETED'],
  RESULT_REVIEW: ['COMPLETED', 'CANCELLED', 'FAILED'],
  CANCEL_REQUESTED: ['CANCELLED', 'FAILED'],
  INTERRUPTED: ['ASSIGNED', 'RUNNING', 'CANCELLED', 'FAILED'],
}

// The states in which a task still means something to a reader. Anything else is history.
export const LIVE_STATES = [
  'REQUESTED', 'DELIVERED', 'PENDING_APPROVAL', 'APPROVED', 'ASSIGNED', 'RUNNING',
  'RESULT_REVIEW', 'CANCEL_REQUESTED', 'INTERRUPTED',
]

export const allowedNext = state => TRANSITIONS[state] ?? []

// A decision may only ever answer a task that is still WAITING for one. Stated as a set so the
// refusal is one sentence rather than "the transition table said no".
const AWAITING_DECISION = ['REQUESTED', 'DELIVERED', 'PENDING_APPROVAL']

export function createTaskService({ db, audit, now = () => Date.now(), workgroups, events, onTaskEvent } = {}) {
  const stmt = prepared(db)
  const iso = () => new Date(now()).toISOString()

  const insert = stmt(`INSERT INTO tasks
    (id, workgroup_id, requester_id, requester_device_id, owner_id, owner_device_id, endpoint_id,
     state, title, payload, version, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
  const byId = stmt('SELECT * FROM tasks WHERE id = ?')
  const patchTask = stmt(`UPDATE tasks SET state = ?, version = version + 1, updated_at = ?,
    delivered_at = COALESCE(?, delivered_at), approved_at = COALESCE(?, approved_at),
    started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at),
    endpoint_id = COALESCE(?, endpoint_id), round_id = COALESCE(?, round_id),
    epoch = COALESCE(?, epoch), error = COALESCE(?, error)
    WHERE id = ?`)
  const ofGroup = stmt('SELECT * FROM tasks WHERE workgroup_id = ? ORDER BY created_at ASC')
  const assignedTo = stmt('SELECT * FROM tasks WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?')
  const requestedBy = stmt('SELECT * FROM tasks WHERE requester_id = ? ORDER BY created_at DESC LIMIT ?')

  const insertApproval = stmt(`INSERT INTO approvals
    (id, task_id, approved_by, approved_device_id, decision, scope, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  const approvalsOf = stmt('SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at ASC')
  const liveApproval = stmt(`SELECT * FROM approvals
    WHERE task_id = ? AND decision = 'granted' AND revoked_at IS NULL`)
  const revokeApproval = stmt('UPDATE approvals SET revoked_at = ?, version = version + 1 WHERE id = ?')

  const publicTask = (row, approvals) => ({
    taskId: row.id,
    workgroupId: row.workgroup_id,
    requesterId: row.requester_id,
    requesterDeviceId: row.requester_device_id ?? undefined,
    ownerId: row.owner_id ?? undefined,
    // The device the work is owed from. Never the requester's, and never a body field.
    ownerDeviceId: row.owner_device_id ?? undefined,
    endpointId: row.endpoint_id ?? undefined,
    state: row.state,
    version: row.version,
    title: row.title,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.approved_at === null ? {} : { approvedAt: row.approved_at }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.round_id === null ? {} : { roundId: row.round_id }),
    ...(row.epoch === null ? {} : { epoch: row.epoch }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(approvals === undefined ? {} : {
      approvals: approvals.map(row2 => ({
        approvalId: row2.id,
        decision: row2.decision,
        approvedBy: row2.approved_by,
        approvedDeviceId: row2.approved_device_id,
        scope: JSON.parse(row2.scope),
        createdAt: row2.created_at,
        expiresAt: row2.expires_at,
        ...(row2.revoked_at === null ? {} : { revokedAt: row2.revoked_at }),
      })),
    }),
  })

  // The single place a state changes. `expected` is the version the caller read; a stale update
  // matches no row, and the caller hears "it moved on" instead of overwriting a newer state.
  const moveTo = (row, next, { expected, extra = {} } = {}) => {
    if (!TASK_STATES.includes(next)) throw badRequest('task/unknown-state', `"${next}" is not a task state.`)
    if (FINAL_STATES.includes(row.state)) {
      throw conflict('task/already-finished', `That task is ${row.state} and cannot change again.`)
    }
    // A SAME-STATE REPORT IS AN ACKNOWLEDGEMENT, NOT A TRANSITION.
    //
    // A device can lose the answer to its own `RUNNING` report and resend it after reconnecting (or
    // after a restart adopted the task). The state has not moved, so accepting it changes nothing and
    // must not bump the version. Other illegal moves stay refused.
    if (next === row.state) return byId.get(row.id)
    if (!allowedNext(row.state).includes(next)) {
      throw conflict('task/transition-refused', `${row.state} → ${next} is not a transition plan §10.2 allows.`)
    }
    if (expected !== undefined && expected !== row.version) {
      throw conflict('task/version-conflict', `That task moved on (version ${row.version}, not ${expected}).`)
    }
    // Gate 3's other half: work begins on the owner's device or not at all. Stated here rather than
    // only at the decision, because a later `started` report must not be able to introduce one.
    if (next === 'RUNNING') {
      const live = liveApproval.get(row.id)
      if (live === undefined) throw conflict('task/not-approved', 'A task cannot run without a live approval from its owner.')
      if (live.expires_at <= iso()) throw conflict('task/approval-expired', 'That approval has expired; the task cannot start.')
    }
    const at = iso()
    const patch = {
      deliveredAt: next === 'DELIVERED' ? at : null,
      approvedAt: next === 'APPROVED' ? at : null,
      startedAt: next === 'RUNNING' ? at : null,
      finishedAt: FINAL_STATES.includes(next) ? at : null,
      endpointId: extra.endpointId ?? null,
      roundId: extra.roundId ?? null,
      epoch: Number.isFinite(extra.epoch) ? extra.epoch : null,
      error: extra.error ?? null,
    }
    patchTask.run(next, at, patch.deliveredAt, patch.approvedAt, patch.startedAt, patch.finishedAt,
      patch.endpointId, patch.roundId, patch.epoch, patch.error, row.id)
    const updated = byId.get(row.id)
    audit.record({ actorId: updated.owner_id ?? updated.requester_id, deviceId: updated.owner_device_id, action: 'task.transition', targetId: row.id, result: next })
    return updated
  }

  // Brings a task to PENDING_APPROVAL through the states the plan allows, when a decision arrives
  // while it is still earlier in the line.
  //
  // B answering is proof that B's device received the request and put it in front of B — that is
  // exactly what DELIVERED and PENDING_APPROVAL mean. Walking the two named steps rather than
  // jumping keeps the machine honest: `REQUESTED → APPROVED` is not a transition §10.2 allows, and
  // a service that let a decision write it would allow the same jump for every other caller.
  //
  // A plugin that already reported `task.received` (its own `DELIVERED`) simply finds the task
  // further along; this is a no-op then.
  const settleBeforeDecision = (row) => {
    let current = row
    if (current.state === 'REQUESTED') current = moveTo(current, 'DELIVERED', {})
    if (current.state === 'DELIVERED') current = moveTo(current, 'PENDING_APPROVAL', {})
    return current
  }

  // An event that belongs to the group's log, appended through the same service a message uses, so
  // it takes a `seq` and is replayed to a device that was offline. Best effort at the call sites:
  // the task row is already committed, and a log that refuses one line must not undo a decision.
  const appendEvent = (row, type, sender, payload) => {
    if (!EVENT_TYPES.has(type)) throw new Error(`ds-hub: ${type} is not an event type`)
    const appended = events.append({
      workgroupId: row.workgroup_id,
      type,
      sender,
      payload: { taskId: row.id, ...(payload ?? {}) },
    })
    try { onTaskEvent?.({ workgroupId: row.workgroup_id, event: appended.event }) } catch { /* the log is the record */ }
    return appended
  }

  const service = {
    publicTask,
    allowedNext,
    LIVE_STATES,
    FINAL_STATES,

    // ── the requester's side (WSS `task.request`) ────────────────────────────────────
    // `sender` is the authenticated connection. The envelope's own `sender` must agree with it —
    // that check lives in the socket handler, which is the only place that knows both.
    request({ envelope, isMember }) {
      const checked = checkEnvelope({ envelope, now: now() })
      if (!checked.ok) throw badRequest(checked.code, checked.detail)

      const workgroupId = envelope.workgroupId
      // A group the sender is not in is reported as missing, exactly like every other route: a task
      // request must not become a way to probe which groups exist (gate 4: 群外访问被拒).
      if (!isMember(workgroupId, envelope.sender.userId)) throw notFound('workgroup/not-found', 'No such workgroup.')
      // And the target must be in it too, or the request would be delegating to a stranger.
      if (!isMember(workgroupId, envelope.target.userId)) throw notFound('task/target-not-in-group', 'That person is not in this workgroup.')

      // A task id already used is the SAME request arriving again — the outbox resent it after a
      // lost ack. Answer with the stored row: allocating a second task would make at-least-once
      // delivery run the work twice, which is the thing gate 5 forbids.
      const existing = byId.get(envelope.taskId)
      if (existing !== undefined) {
        if (existing.workgroup_id !== workgroupId || existing.requester_id !== envelope.sender.userId) {
          // Same id, different ask: a client bug worth surfacing rather than "deduplicating" into
          // somebody else's task.
          throw conflict('task/id-conflict', 'That task id is already in use for a different request.')
        }
        return { task: publicTask(existing, approvalsOf.all(existing.id)), duplicate: true }
      }

      const title = typeof envelope.payload?.title === 'string' ? envelope.payload.title.slice(0, 200) : ''
      const payloadText = JSON.stringify(envelope.payload ?? {})
      if (Buffer.byteLength(payloadText, 'utf8') > MAX_PAYLOAD_BYTES) {
        throw badRequest('task/payload-too-large', `A task request may not exceed ${MAX_PAYLOAD_BYTES} bytes.`)
      }
      // The endpoint, when the requester named one, must belong to the target: a request addressed
      // to B's Chief is B's to answer, and naming somebody else's endpoint would make the target
      // field decorative.
      let endpointId = null
      if (typeof envelope.target.botEndpointId === 'string' && envelope.target.botEndpointId !== '') {
        const endpoint = stmt('SELECT * FROM bot_endpoints WHERE id = ?').get(envelope.target.botEndpointId)
        if (endpoint === undefined || endpoint.owner_id !== envelope.target.userId || endpoint.status !== 'active') {
          throw notFound('task/endpoint-unknown', 'That Bot endpoint does not belong to the person the task is for.')
        }
        endpointId = endpoint.id
      }

      const at = iso()
      db.exec('BEGIN')
      let row
      try {
        insert.run(envelope.taskId, workgroupId, envelope.sender.userId, envelope.sender.deviceId,
          envelope.target.userId, null, endpointId, 'REQUESTED', title, payloadText, at, at, envelope.expiresAt)
        db.exec('COMMIT')
        row = byId.get(envelope.taskId)
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* gone */ }
        // Two racing deliveries of the same request: the other one won, and this call answers with
        // the winner rather than a 500.
        if (isUniqueViolation(error)) {
          const winner = byId.get(envelope.taskId)
          if (winner !== undefined) return { task: publicTask(winner, approvalsOf.all(winner.id)), duplicate: true }
        }
        throw error
      }

      audit.record({ actorId: envelope.sender.userId, deviceId: envelope.sender.deviceId, action: 'task.request', targetId: row.id, result: 'ok' })
      // The log line the whole group sees: "A asked B". Appended after the row so a reader that
      // receives the event can resolve the task it names.
      // `target` is carried in the payload so a reader of the log knows who was asked without
      // joining the task row: the timeline says "A asked B" on its own.
      // The event carries what the approval card needs, in the plan's own field names (§9.2):
      // `requestedResources` and `requestedCapabilities`. B decides from this card, so a scope the
      // card cannot show is a scope B cannot weigh.
      appendEvent(row, 'task.request', { userId: envelope.sender.userId, deviceId: envelope.sender.deviceId }, {
        title,
        requesterId: envelope.sender.userId,
        target: { userId: envelope.target.userId, ...(endpointId === null ? {} : { botEndpointId: endpointId }) },
        requestedResources: Array.isArray(envelope.payload?.requestedResources) ? envelope.payload.requestedResources : [],
        requestedCapabilities: Array.isArray(envelope.payload?.requestedCapabilities) ? envelope.payload.requestedCapabilities : [],
        ...(envelope.expiresAt === undefined ? {} : { expiresAt: envelope.expiresAt }),
      })
      return { task: publicTask(byId.get(row.id), approvalsOf.all(row.id)), duplicate: false }
    },

    // Verifies an envelope against the device's own key. Separate from `request` because the socket
    // handler resolves the key from the connection; keeping the crypto question in one function
    // makes the contract tests able to call it directly.
    verifyEnvelopeFor({ envelope, publicKeyPem }) {
      return verifyEnvelope(publicKeyPem, envelope, envelope?.signature)
    },

    hashOf: payloadHash,

    // ── the owner's side (POST /v1/tasks/:id/decision) ───────────────────────────────
    // B accepts or refuses. `deviceId` and `userId` come from the authenticated session, never from
    // the body — that is the whole of gate 3.
    decide({ userId, deviceId, taskId, body }) {
      const row = byId.get(taskId)
      if (row === undefined) throw notFound('task/not-found', 'No such task.')
      // Only the person the task is for may answer it. The requester and a bystander both get the
      // same "no such task", so the endpoint is not an oracle for other people's work.
      if (row.owner_id !== userId) throw notFound('task/not-found', 'No such task.')
      if (!AWAITING_DECISION.includes(row.state)) {
        throw conflict('task/not-awaiting-decision', `That task is ${row.state}; it is not waiting for a decision.`)
      }
      if (row.expires_at !== null && row.expires_at <= iso()) {
        moveTo(row, 'EXPIRED', {})
        // Not an approval: rejecting on the requester's behalf is worse than saying it lapsed.
        appendEvent(byId.get(row.id), 'task.failed', { userId, deviceId }, { reason: 'expired' })
        throw conflict('task/expired', 'That request has expired.')
      }

      const decision = body?.decision === 'granted' || body?.decision === 'approve' ? 'granted'
        : body?.decision === 'rejected' || body?.decision === 'reject' ? 'rejected'
          : undefined
      if (decision === undefined) throw badRequest('task/invalid-decision', 'A decision is "granted" or "rejected".')

      // Answering IS the evidence of delivery: walk to PENDING_APPROVAL by the named steps before
      // applying the decision, so the transition written is always one the plan allows.
      const awaiting = settleBeforeDecision(row)

      // The scope is B's, and it is stored as JSON without the Hub interpreting it: what B allows is
      // decided by B's ledger, and this row is the record both sides read back.
      const scope = body?.scope === undefined ? {} : body.scope
      if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
        throw badRequest('task/invalid-scope', 'A scope must be a JSON object.')
      }
      const scopeText = JSON.stringify(scope)
      if (Buffer.byteLength(scopeText, 'utf8') > MAX_PAYLOAD_BYTES) throw badRequest('task/scope-too-large', 'That scope is too large.')

      // A grant's lifetime: B's choice, bounded by the Hub so a "forever" approval cannot be sent by
      // a client that computed the date wrong.
      const requestedTtl = Number(scope.expiresAt === undefined ? NaN : Date.parse(String(scope.expiresAt)))
      const defaultTtlMs = 24 * 60 * 60 * 1000
      const maxTtlMs = 7 * 24 * 60 * 60 * 1000
      const at = now()
      const expiresAt = Number.isFinite(requestedTtl)
        ? new Date(Math.min(requestedTtl, at + maxTtlMs)).toISOString()
        : new Date(at + defaultTtlMs).toISOString()

      if (decision === 'rejected') {
        db.exec('BEGIN')
        let updated
        try {
          insertApproval.run(newId('apr'), row.id, userId, deviceId, 'rejected', scopeText, iso(), expiresAt)
          updated = moveTo(awaiting, 'REJECTED', {})
          db.exec('COMMIT')
        } catch (error) {
          try { db.exec('ROLLBACK') } catch { /* gone */ }
          throw error
        }
        audit.record({ actorId: userId, deviceId, action: 'task.reject', targetId: row.id, result: 'ok' })
        // `task.failed` rather than `task.completed`: nothing ran, and the group's timeline should
        // not offer a result that does not exist.
        appendEvent(updated, 'approval.rejected', { userId, deviceId }, { decision, scope })
        appendEvent(updated, 'task.failed', { userId, deviceId }, { reason: 'rejected' })
        return { task: publicTask(byId.get(row.id), approvalsOf.all(row.id)), decision }
      }

      // A live grant already exists (a second click, or two devices of B's racing). One approval per
      // task is the schema's rule; report the existing one instead of failing the person.
      const live = liveApproval.get(row.id)
      if (live !== undefined) {
        return { task: publicTask(row, approvalsOf.all(row.id)), decision, duplicate: true }
      }

      db.exec('BEGIN')
      let updated
      try {
        insertApproval.run(newId('apr'), row.id, userId, deviceId, 'granted', scopeText, iso(), expiresAt)
        // The core of gate 1: PENDING_APPROVAL → APPROVED happens here and only here, so a task that
        // was rejected can never reach APPROVED, and an approval is what makes ASSIGNED reachable.
        updated = moveTo(awaiting, 'APPROVED', { extra: { endpointId: typeof scope.endpointId === 'string' ? scope.endpointId : null } })
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* gone */ }
        throw error
      }
      audit.record({ actorId: userId, deviceId, action: 'task.decide', targetId: row.id, result: 'granted' })
      appendEvent(updated, 'approval.granted', { userId, deviceId }, { scope, expiresAt })
      return { task: publicTask(byId.get(row.id), approvalsOf.all(row.id)), decision }
    },

    // ── POST /v1/tasks/:id/revoke ───────────────────────────────────────────────────
    // B withdraws. Whatever the task is doing, the record stops being approved at once: a later
    // `RUNNING` report is refused by `moveTo` because the live grant is gone.
    revoke({ userId, deviceId, taskId, body }) {
      const row = byId.get(taskId)
      if (row === undefined) throw notFound('task/not-found', 'No such task.')
      // The owner revokes; the requester may CANCEL (a different act with a different record), and
      // the Hub keeps the two apart so "I cancelled my request" never reads as "B withdrew consent".
      if (row.owner_id !== userId) throw forbidden('task/not-owner', 'Only the person the task was given to may revoke it.')
      const live = liveApproval.get(row.id)
      if (live === undefined) throw conflict('task/not-approved', 'That task has no live approval to revoke.')

      const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : undefined
      db.exec('BEGIN')
      let updated
      try {
        revokeApproval.run(iso(), live.id)
        // A running task is not silently erased: it moves to CANCELLED through the states the plan
        // allows, so the local side is told to stop and the timeline says why.
        const next = row.state === 'RUNNING' ? 'CANCEL_REQUESTED' : 'CANCELLED'
        updated = moveTo(row, next, { ...(reason === undefined ? {} : { extra: { error: reason } }) })
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* gone */ }
        throw error
      }
      audit.record({ actorId: userId, deviceId, action: 'task.revoke', targetId: row.id, result: 'ok' })
      appendEvent(updated, 'approval.revoked', { userId, deviceId }, { ...(reason === undefined ? {} : { reason }) })
      appendEvent(updated, 'task.cancel', { userId, deviceId }, { reason: reason ?? 'revoked' })
      return { task: publicTask(byId.get(row.id), approvalsOf.all(row.id)) }
    },

    // ── transitions the executing device reports (WSS, plugin → Hub) ────────────────
    // Only the owner's own device may report progress on its own task: the state is what the
    // requester reads, and letting A write it would make the timeline a claim rather than a record.
    report({ userId, deviceId, taskId, next, body }) {
      const row = byId.get(taskId)
      if (row === undefined) throw notFound('task/not-found', 'No such task.')
      if (row.owner_id !== userId) throw notFound('task/not-found', 'No such task.')
      const updated = moveTo(row, next, {
        expected: Number.isFinite(body?.version) ? body.version : undefined,
        extra: {
          ...(typeof body?.endpointId === 'string' ? { endpointId: body.endpointId } : {}),
          ...(typeof body?.roundId === 'string' ? { roundId: body.roundId } : {}),
          ...(Number.isFinite(body?.epoch) ? { epoch: body.epoch } : {}),
          ...(typeof body?.error === 'string' ? { error: body.error.slice(0, 500) } : {}),
        },
      })
      audit.record({ actorId: userId, deviceId, action: 'task.report', targetId: row.id, result: next })
      const type = next === 'RUNNING' ? 'task.started'
        : next === 'COMPLETED' ? 'task.completed'
          : next === 'FAILED' ? 'task.failed'
            : next === 'RESULT_REVIEW' ? 'task.progress'
              : next === 'CANCELLED' ? 'task.cancel' : undefined
      if (type !== undefined) {
        appendEvent(updated, type, { userId, deviceId }, {
          state: next,
          ...(typeof body?.summary === 'string' ? { summary: body.summary.slice(0, 2000) } : {}),
          ...(typeof body?.error === 'string' ? { error: body.error.slice(0, 500) } : {}),
        })
      }
      return { task: publicTask(byId.get(row.id), approvalsOf.all(row.id)) }
    },

    // Progress is the one event worth throttling. It is recorded on the group's log only when the
    // caller asks (the plugin merges ticks itself); this method exists so a `task.progress` event has
    // one producer and one shape rather than being assembled at the call site.
    progress({ userId, deviceId, taskId, body }) {
      const row = byId.get(taskId)
      if (row === undefined) throw notFound('task/not-found', 'No such task.')
      if (row.owner_id !== userId) throw notFound('task/not-found', 'No such task.')
      if (row.state !== 'RUNNING') throw conflict('task/not-running', 'Only a running task reports progress.')
      appendEvent(row, 'task.progress', { userId, deviceId }, {
        note: typeof body?.note === 'string' ? body.note.slice(0, 500) : '',
        ...(Number.isFinite(body?.percent) ? { percent: Math.max(0, Math.min(100, Math.round(body.percent))) } : {}),
      })
      return { taskId: row.id, recorded: true }
    },

    // ── reads ───────────────────────────────────────────────────────────────────────
    // The endpoint plan §13.1 does not define and this phase adds: without it a client would have to
    // fold the whole event log to draw a task panel.
    get({ userId, taskId }) {
      const row = byId.get(taskId)
      if (row === undefined) throw notFound('task/not-found', 'No such task.')
      // Both sides of the task may read it; nobody else. Same 404 as a missing row.
      if (row.owner_id !== userId && row.requester_id !== userId) throw notFound('task/not-found', 'No such task.')
      return { task: publicTask(row, approvalsOf.all(row.id)) }
    },

    list({ userId, workgroupId, role = 'all', isMember, limit = 100 }) {
      const take = Math.min(500, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 100))
      if (workgroupId !== undefined) {
        if (!isMember(workgroupId, userId)) throw notFound('workgroup/not-found', 'No such workgroup.')
        const rows = ofGroup.all(workgroupId)
          .filter(row => role === 'requester' ? row.requester_id === userId
            : role === 'owner' ? row.owner_id === userId
              : row.requester_id === userId || row.owner_id === userId)
        return { tasks: rows.map(row => publicTask(row)) }
      }
      // No group named: everything addressed to this person, and everything they asked for.
      const seen = new Set()
      const rows = []
      for (const row of [...assignedTo.all(userId, take), ...requestedBy.all(userId, take)]) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        rows.push(row)
      }
      return { tasks: rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(row => publicTask(row)) }
    },

    // A task nobody answered in time. Called by the sweeper and by `decide` on the way in, so an
    // expired request is refused even if no timer ever ran.
    expireDue() {
      const at = iso()
      const rows = stmt("SELECT * FROM tasks WHERE state IN ('REQUESTED', 'DELIVERED', 'PENDING_APPROVAL') AND expires_at IS NOT NULL AND expires_at <= ?").all(at)
      let expired = 0
      for (const row of rows) {
        try {
          const updated = moveTo(row, 'EXPIRED', {})
          appendEvent(updated, 'task.failed', { userId: row.requester_id }, { reason: 'expired' })
          expired += 1
        } catch { /* a task that moved on is not this sweeper's problem */ }
      }
      return { expired }
    },

    count(workgroupId) {
      return stmt('SELECT count(*) AS c FROM tasks WHERE workgroup_id = ?').get(workgroupId).c
    },
  }

  return service
}
