// The group: creation (including the upgrade path), membership, invites, and the event log.
//
// The rules this module owns, each because a gate depends on it:
//
//   * `seq` is handed out inside the same transaction that inserts the event, from a counter on
//     the group row. Two senders racing produce 1 and 2, never 1 and 1, and never a gap that a
//     reader would wait for forever.
//   * `event_id` is the client's dedup key. A resent event returns the row the Hub already has
//     and does NOT take a new seq — that is what makes at-least-once delivery harmless.
//   * `upgradeId` is unique, so replaying one upgrade N times produces one group (gate 4).
//   * Nothing shaped like history is accepted on create: an upgrade request carries a name, a
//     notice, an avatar and member ids. A body containing messages, a transcript or a log is
//     refused outright (gate 3), so the promise "local history is never uploaded" is enforced by
//     the Hub rather than by the client's good behaviour.
import { randomUUID } from 'node:crypto'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { prepared } from '../db/prepared.js'
import { isUniqueViolation } from '../db/index.js'
import { maskPhone, normalizePhone } from '../phone.js'

export const MEMBER_ROLES = new Set(['owner', 'admin', 'member'])

// The event types this Hub may write. A closed set, because an unknown type would be stored and
// then replayed forever to a client that cannot act on it.
//
// G4 wrote the first five. G5 adds plan §9.3's task (7), approval (4) and artifact (2) types — the
// thirteen that make cross-user delegation visible in the group's own order. They share ONE `seq`
// with `chat.message` on purpose: a task request has to reach B while B is offline, so it needs the
// replay path `deliveries` + `ack_at` + cursor already gives a message, and a timeline has to show
// "asked → approved → running → done" interleaved with the chat around it.
//
// `memory.*` stays absent: group memory is G6, and a type nothing writes would be stored and
// replayed forever to a client that cannot act on it.
export const EVENT_TYPES = new Set([
  'chat.message',
  'chat.edited',
  'chat.deleted',
  'member.changed',
  'read.updated',
  // ── tasks (§9.3) ────────────────────────────────────────
  'task.request',
  'task.received',
  'task.cancel',
  'task.started',
  'task.progress',
  'task.completed',
  'task.failed',
  // ── approvals (§9.3) ───────────────────────────────────
  'approval.request',
  'approval.granted',
  'approval.rejected',
  'approval.revoked',
  // ── artifacts (§9.3) ───────────────────────────────────
  'artifact.available',
  'artifact.revoked',
])

// The one event type a person is reading. Unread is a count of THESE, never a difference of `seq`:
// once a task event takes a number, `last_seq - lastReadSeq` would count approvals and progress
// ticks as unread messages and the badge would climb while nobody typed anything.
export const READABLE_EVENT_TYPE = 'chat.message'

// Key names that describe a chat's contents rather than a group's settings. Any of them in a
// create body means the caller is trying to upload history, which the plan forbids (§8.2).
export const HISTORY_KEYS = [
  'messages', 'message', 'log', 'logs', 'history', 'transcript', 'transcripts',
  'events', 'turns', 'rounds', 'conversation', 'conversations', 'body', 'content', 'text',
]

// The only fields a create (or upgrade) body may carry. A closed allow-list, not a deny-list: a
// deny-list has to anticipate every name a conversation could be stored under, and the one it
// misses uploads a log. `localPath`, `workDir` and `localRoomId` are therefore refused as unknown
// rather than merely ignored — a client author learns on the first call instead of discovering
// later that the field they believed was published never was.
export const CREATE_FIELDS = new Set(['name', 'notice', 'avatar', 'upgradeId', 'endpointIds'])

export const MAX_NAME_LENGTH = 120
export const MAX_NOTICE_LENGTH = 4000

// `workgroup.` prefixed ids are opaque to clients and carry no local identifier.
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '')}`

// A payload is a JSON object with a small ceiling. The whole event is stored as one TEXT column,
// so an unbounded payload is an unbounded row — and every replay sends it again.
export const MAX_PAYLOAD_BYTES = 16 * 1024

export function createWorkgroupService({ db, audit, now = () => Date.now(), events, onMembershipChanged } = {}) {
  const stmt = prepared(db)
  const iso = () => new Date(now()).toISOString()

  const byId = stmt('SELECT * FROM workgroups WHERE id = ?')
  const byUpgrade = stmt('SELECT * FROM workgroups WHERE upgrade_id = ?')
  const insertGroup = stmt(`INSERT INTO workgroups
    (id, owner_user_id, name, notice, avatar, config_version, last_seq, upgrade_id, created_at)
    VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`)
  const groupsOfUser = stmt(`SELECT w.* FROM workgroups w
    JOIN memberships m ON m.workgroup_id = w.id
    WHERE m.member_type = 'user' AND m.user_id = ? AND m.status = 'active'
    ORDER BY w.created_at ASC`)

  const membershipOf = stmt(`SELECT * FROM memberships
    WHERE workgroup_id = ? AND member_type = 'user' AND user_id = ? AND status = 'active'`)
  const membersOf = stmt("SELECT * FROM memberships WHERE workgroup_id = ? AND status = 'active' ORDER BY joined_at ASC")
  const insertMember = stmt(`INSERT INTO memberships (id, workgroup_id, member_type, user_id, endpoint_id, role, status, joined_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`)
  const reactivateMember = stmt("UPDATE memberships SET status = 'active', role = ?, joined_at = ? WHERE id = ?")
  const existingMember = stmt(`SELECT * FROM memberships WHERE workgroup_id = ? AND member_type = ? AND ifnull(user_id, '') = ? AND ifnull(endpoint_id, '') = ?`)

  // Unread is a count of MESSAGES above the cursor, not the distance between two seq numbers.
  // Every G5 task/approval/artifact event takes a `seq` too, so the difference would grow while
  // nobody typed a word.
  const unreadMessages = stmt(`SELECT count(*) AS c FROM events
    WHERE workgroup_id = ? AND seq > ? AND type = ?`)

  const userById = stmt('SELECT * FROM users WHERE id = ?')
  const endpointById = stmt('SELECT id, name FROM bot_endpoints WHERE id = ?')
  const userByPhone = stmt('SELECT * FROM users WHERE phone_e164 = ?')

  const insertInvite = stmt(`INSERT INTO invites (id, workgroup_id, invited_by, invitee_id, invited_phone_masked, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
  const inviteById = stmt('SELECT * FROM invites WHERE id = ?')
  const answerInvite = stmt('UPDATE invites SET status = ?, answered_at = ? WHERE id = ?')
  const pendingInvitesForUser = stmt("SELECT * FROM invites WHERE invitee_id = ? AND status = 'pending' ORDER BY created_at DESC")
  const pendingInviteFor = stmt("SELECT * FROM invites WHERE workgroup_id = ? AND invitee_id = ? AND status = 'pending'")

  // ── shapes ──────────────────────────────────────────────────────────────────────
  // What a client sees. `phoneMasked` only: the full number identifies a person and is not
  // needed to draw a member row.
  const publicMember = (row) => {
    const user = row.user_id === null ? undefined : userById.get(row.user_id)
    // A Bot endpoint's published name, so a member list can say "Chief" rather than an id. Read from
    // the endpoint row rather than copied into the membership, so a rename by its owner shows up
    // everywhere without touching every membership.
    const endpoint = row.endpoint_id === null || row.endpoint_id === undefined
      ? undefined
      : endpointById.get(row.endpoint_id)
    return {
      membershipId: row.id,
      memberType: row.member_type,
      userId: row.user_id ?? undefined,
      endpointId: row.endpoint_id ?? undefined,
      // `name` is whatever this member is best called by; `phoneMasked` stays separate so a client
      // never has to guess which one it received.
      name: endpoint === undefined ? undefined : endpoint.name,
      phoneMasked: user === undefined ? undefined : maskPhone(user.phone_e164),
      role: row.role,
      status: row.status,
      joinedAt: row.joined_at,
    }
  }

  const publicGroup = (row) => ({
    workgroupId: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    notice: row.notice,
    avatar: row.avatar ?? undefined,
    lastSeq: row.last_seq,
    upgradeId: row.upgrade_id ?? undefined,
    createdAt: row.created_at,
  })

  const requireMember = (workgroupId, userId) => {
    const group = byId.get(workgroupId)
    // A group the caller cannot see is reported as missing, not forbidden: "forbidden" would
    // confirm that the id exists to someone outside it.
    if (group === undefined) throw notFound('workgroup/not-found', 'No such workgroup.')
    const membership = membershipOf.get(workgroupId, userId)
    if (membership === undefined) throw notFound('workgroup/not-found', 'No such workgroup.')
    return { group, membership }
  }

  const requireAdmin = (workgroupId, userId) => {
    const found = requireMember(workgroupId, userId)
    if (found.membership.role !== 'owner' && found.membership.role !== 'admin') {
      throw forbidden('workgroup/not-admin', 'Only the group owner or an admin may do this.')
    }
    return found
  }

  // Hand leadership to the next PERSON in the group, so an owner can leave one.
  //
  // The owner could not leave at all before (`workgroup/owner-cannot-leave`), because a group with
  // no owner has nobody who can invite. Passing the role on is what makes leaving possible without
  // leaving the group ownerless. Bots are deliberately not candidates: `role` decides who may
  // invite, and an endpoint's owner would then hold that power on the machine's behalf.
  //
  // `undefined` means nobody is left, which is the last person leaving — deleting the group, not
  // this.
  const handOverOwner = (workgroupId, leavingMembershipId) => {
    const next = stmt(`SELECT * FROM memberships
      WHERE workgroup_id = ? AND status = 'active' AND member_type = 'user' AND id != ?
      ORDER BY joined_at ASC`).get(workgroupId, leavingMembershipId)
    if (next === undefined) return undefined
    stmt("UPDATE memberships SET role = 'owner' WHERE id = ?").run(next.id)
    return next
  }

  const text = (value, field, max) => {
    if (typeof value !== 'string') throw badRequest('workgroup/invalid-field', `${field} must be text.`)
    const trimmed = value.trim()
    if (trimmed.length > max) throw badRequest('workgroup/invalid-field', `${field} is longer than ${max} characters.`)
    return trimmed
  }

  // Refuses a create body that carries history. Checked by key name rather than by inspecting
  // every nested value: the rule is "this endpoint does not take chat content at all", and a
  // recursive scan would still miss a value stored under an innocent name.
  const refuseHistory = (body) => {
    for (const key of Object.keys(body ?? {})) {
      const lower = key.toLowerCase()
      if (HISTORY_KEYS.includes(lower)) {
        throw badRequest(
          'workgroup/history-not-accepted',
          `This endpoint creates a group from settings only; "${key}" looks like chat content and is refused. Local group history is never uploaded.`,
        )
      }
      // A key that is neither history nor an allowed setting is refused for the same reason: the
      // endpoint's whole job is to accept a name and a notice, so an unfamiliar field is a client
      // bug worth surfacing now.
      if (!CREATE_FIELDS.has(key)) {
        throw badRequest(
          'workgroup/unsupported-field',
          `"${key}" is not part of creating a workgroup. Allowed: ${[...CREATE_FIELDS].join(', ')}. A workgroup is created from settings; it never carries a path, a folder or a transcript.`,
        )
      }
    }
  }

  // A membership change is told to the live sockets, but it is deliberately NOT written into
  // `events`:
  //
  //   * `seq` is the group's MESSAGE order. A join that consumed a number would make gate 3's
  //     "zero events after an upgrade" false for an honest reason, and would shift every test that
  //     counts messages;
  //   * the log is what a reader scrolls. A join is not something to scroll past.
  //
  // A machine that was offline learns the roster the same way it learns everything else: it re-reads
  // the roster when it connects. The notification is only for machines that are already listening.
  const membershipChanged = (payload) => {
    try { onMembershipChanged?.(payload) } catch { /* the roster is re-read on connect regardless */ }
  }

  const service = {
    // ── POST /v1/workgroups ───────────────────────────────────────────────────────────
    // Also the upgrade path: a `upgradeId` makes the call idempotent, and the response says
    // whether this call created the group or found the one an earlier attempt made.
    async create({ userId, deviceId, body, endpointService }) {
      refuseHistory(body)
      const name = text(body.name, 'The group name', MAX_NAME_LENGTH)
      if (name.length === 0) throw badRequest('workgroup/invalid-field', 'A group needs a name.')
      const notice = body.notice === undefined ? '' : text(body.notice, 'The notice', MAX_NOTICE_LENGTH)
      const avatar = body.avatar === undefined || body.avatar === null ? null : text(body.avatar, 'The avatar', 2048)
      const upgradeId = body.upgradeId === undefined || body.upgradeId === null ? null : text(body.upgradeId, 'The upgrade id', 128)
      if (upgradeId !== null && upgradeId.length === 0) throw badRequest('workgroup/invalid-field', 'The upgrade id must not be empty.')
      const endpointIds = body.endpointIds === undefined ? []
        : Array.isArray(body.endpointIds) ? [...new Set(body.endpointIds.map(String))] : undefined
      if (endpointIds === undefined) throw badRequest('workgroup/invalid-field', 'endpointIds must be an array of Bot endpoint ids.')
      if (endpointIds.length > 64) throw badRequest('workgroup/invalid-field', 'A group may start with at most 64 Bot endpoints.')

      // Replay of an upgrade: the group already exists, so nothing is written. Scoped to the
      // caller so one account's key cannot reveal another account's group.
      if (upgradeId !== null) {
        const existing = byUpgrade.get(upgradeId)
        if (existing !== undefined) {
          if (existing.owner_user_id !== userId) throw conflict('workgroup/upgrade-id-taken', 'That upgrade id belongs to another account.')
          return { workgroupId: existing.id, created: false, workgroup: publicGroup(existing) }
        }
      }

      const id = newId('wg')
      const at = iso()
      db.exec('BEGIN')
      try {
        insertGroup.run(id, userId, name, notice, avatar, upgradeId, at)
        // The owner is a member from the first instant: every later check ("is the caller in
        // this group?") then has one rule instead of two.
        insertMember.run(newId('mem'), id, 'user', userId, null, 'owner', at)
        // Bot endpoints the caller publishes on their own devices. Validated against the endpoint
        // service so an id learned elsewhere cannot pull a stranger's Bot into this group; the
        // owner is already a member, which is exactly the condition `endpointFor` checks.
        for (const endpointId of endpointIds) {
          const endpoint = endpointService?.endpointFor({ endpointId, workgroupId: id })
          if (endpoint === undefined) {
            throw badRequest('workgroup/endpoint-unknown', `"${endpointId}" is not a published Bot endpoint this account may add.`)
          }
          insertMember.run(newId('mem'), id, 'botEndpoint', null, endpoint.id, 'member', at)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        // Two attempts racing on the same upgrade id: one wins, the other finds it.
        if (isUniqueViolation(error) && upgradeId !== null) {
          const winner = byUpgrade.get(upgradeId)
          if (winner !== undefined && winner.owner_user_id === userId) {
            return { workgroupId: winner.id, created: false, workgroup: publicGroup(winner) }
          }
          throw conflict('workgroup/upgrade-id-taken', 'That upgrade id is already in use.')
        }
        throw error
      }

      audit.record({ actorId: userId, deviceId, action: 'workgroup.create', targetId: id, result: 'ok' })
      // Creation writes no event. A new group's log starts empty — which is exactly what gate 3
      // measures after an upgrade ("the Hub side has zero events for that group"). Emitting a
      // synthetic "created" event would make that number non-zero for an honest reason and blur
      // the one signal that proves no history was uploaded.
      return { workgroupId: id, created: true, workgroup: publicGroup(byId.get(id)) }
    },

    // ── GET /v1/workgroups ───────────────────────────────────────────────────────────
    async list({ userId }) {
      const groups = groupsOfUser.all(userId).map((group) => {
        const members = membersOf.all(group.id).map(publicMember)
        const cursor = stmt('SELECT last_read_seq FROM read_cursors WHERE workgroup_id = ? AND user_id = ?').get(group.id, userId)
        const lastReadSeq = cursor?.last_read_seq ?? 0
        return {
          ...publicGroup(group),
          role: membershipOf.get(group.id, userId)?.role ?? 'member',
          members,
          lastReadSeq,
          unreadCount: unreadMessages.get(group.id, lastReadSeq, READABLE_EVENT_TYPE).c,
        }
      })
      return { workgroups: groups }
    },

    // ── GET /v1/workgroups/:id ───────────────────────────────────────────────────────
    async get({ userId, workgroupId }) {
      const { group } = requireMember(workgroupId, userId)
      const cursor = stmt('SELECT last_read_seq FROM read_cursors WHERE workgroup_id = ? AND user_id = ?').get(workgroupId, userId)
      const lastReadSeq = cursor?.last_read_seq ?? 0
      return {
        ...publicGroup(group),
        role: membershipOf.get(workgroupId, userId)?.role ?? 'member',
        members: membersOf.all(workgroupId).map(publicMember),
        lastReadSeq,
        // Same number the list reports, from the same query: a client that opens a group and then
        // asks for the list must not see two different badges.
        unreadCount: unreadMessages.get(workgroupId, lastReadSeq, READABLE_EVENT_TYPE).c,
      }
    },

    // ── POST /v1/workgroups/:id/invites ──────────────────────────────────────────────
    // By phone number or by Hub user id. A phone that is not registered is a 404 with the same
    // shape as one that is: the invite list is not an account directory.
    async invite({ userId, deviceId, workgroupId, body }) {
      const { group } = requireAdmin(workgroupId, userId)

      let invitee
      if (typeof body.hubUserId === 'string' && body.hubUserId !== '') {
        invitee = userById.get(body.hubUserId)
      } else {
        const phone = normalizePhone(body.phone)
        if (phone === undefined) throw badRequest('workgroup/invalid-phone', 'An invite needs a phone number in international form or a Hub user id.')
        invitee = userByPhone.get(phone)
      }
      if (invitee === undefined) throw notFound('workgroup/invitee-unknown', 'No account matches that person.')

      if (membershipOf.get(workgroupId, invitee.id) !== undefined) {
        throw conflict('workgroup/already-member', 'That person is already in this group.')
      }
      if (pendingInviteFor.get(workgroupId, invitee.id) !== undefined) {
        throw conflict('workgroup/already-invited', 'That person already has a pending invite.')
      }

      const id = newId('inv')
      const at = now()
      // An invite that never expires is a standing door. A week is long enough for a colleague to
      // answer and short enough that a forgotten one closes.
      const expiresAt = new Date(at + 7 * 24 * 60 * 60 * 1000).toISOString()
      insertInvite.run(id, workgroupId, userId, invitee.id, maskPhone(invitee.phone_e164), iso(), expiresAt)
      audit.record({ actorId: userId, deviceId, action: 'workgroup.invite', targetId: id, result: 'ok' })
      return {
        inviteId: id,
        workgroupId,
        inviteeId: invitee.id,
        inviteePhoneMasked: maskPhone(invitee.phone_e164),
        status: 'pending',
        expiresAt,
        groupName: group.name,
      }
    },

    // The invitee's own list. Answers "who asked me", which the notification has to say.
    async invitesFor({ userId }) {
      const rows = pendingInvitesForUser.all(userId)
      const nowIso = iso()
      return {
        invites: rows
          // An expired invite is reported as expired rather than silently dropped, so the UI can
          // say why it is gone.
          .map(row => ({
            inviteId: row.id,
            workgroupId: row.workgroup_id,
            groupName: byId.get(row.workgroup_id)?.name ?? '',
            invitedByPhoneMasked: maskPhone(userById.get(row.invited_by)?.phone_e164 ?? ''),
            status: row.expires_at <= nowIso ? 'expired' : row.status,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          })),
      }
    },

    // ── POST /v1/invites/:id/accept ──────────────────────────────────────────────────
    // Accept and decline are one transition with a different target status. Expiry is checked
    // here rather than by a timer: a row is meaningless once its moment has passed, and a sweeper
    // would be another thing that has to run for the gate to hold.
    async answerInvite({ userId, deviceId, inviteId, accept }) {
      const invite = inviteById.get(inviteId)
      if (invite === undefined || invite.invitee_id !== userId) throw notFound('invite/not-found', 'No such invite.')
      if (invite.status !== 'pending') throw conflict('invite/already-answered', 'That invite was already answered.')
      if (invite.expires_at <= iso()) {
        answerInvite.run('expired', iso(), invite.id)
        throw conflict('invite/expired', 'That invite has expired.')
      }
      if (byId.get(invite.workgroup_id) === undefined) throw notFound('invite/not-found', 'That group no longer exists.')

      if (!accept) {
        answerInvite.run('declined', iso(), invite.id)
        return { inviteId: invite.id, status: 'declined' }
      }

      db.exec('BEGIN')
      try {
        answerInvite.run('accepted', iso(), invite.id)
        const existing = existingMember.get(invite.workgroup_id, 'user', userId, '')
        if (existing === undefined) {
          insertMember.run(newId('mem'), invite.workgroup_id, 'user', userId, null, 'member', iso())
        } else if (existing.status !== 'active') {
          // Rejoining after leaving reuses the row: the membership id stays stable, so a client
          // that cached it does not have to care.
          reactivateMember.run('member', iso(), existing.id)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      audit.record({ actorId: userId, deviceId, action: 'invite.accept', targetId: invite.id, result: 'ok' })
      // A membership change is an event, so every machine's roster can follow it. Without it a group
      // that gained a member only looked right on the machine that gained them: the other machines
      // keep showing the roster they last read, and an incoming line from the new member cannot be
      // attributed to anybody.
      //
      // Best effort: the membership is already committed, and a log that refuses this one event must
      // not undo a successful accept.
      membershipChanged({
        workgroupId: invite.workgroup_id,
        kind: 'joined',
        userId,
        membershipId: membershipOf.get(invite.workgroup_id, userId)?.id,
      })
      return { inviteId: invite.id, status: 'accepted', workgroupId: invite.workgroup_id }
    },

    // ── POST /v1/workgroups/:id/members ──────────────────────────────────────────────
    // Adds a Bot endpoint to the group. Endpoint ids are not secrets, so the group's own members
    // are the shortlist: `endpointFor` also requires the endpoint's owner to be in this group, so
    // an id learned elsewhere cannot pull a stranger's Bot in.
    async addEndpointMember({ userId, deviceId, workgroupId, endpointId, endpointService }) {
      const { group } = requireAdmin(workgroupId, userId)
      const endpoint = endpointService.endpointFor({ endpointId, workgroupId })
      if (endpoint === undefined) throw notFound('workgroup/endpoint-unknown', 'No such published Bot endpoint is available to this group.')

      const existing = existingMember.get(workgroupId, 'botEndpoint', '', endpoint.id)
      if (existing !== undefined && existing.status === 'active') {
        return { membership: publicMember(existing), created: false }
      }
      db.exec('BEGIN')
      let id
      try {
        if (existing === undefined) {
          id = newId('mem')
          insertMember.run(id, workgroupId, 'botEndpoint', null, endpoint.id, 'member', iso())
        } else {
          id = existing.id
          reactivateMember.run('member', iso(), existing.id)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      audit.record({ actorId: userId, deviceId, action: 'workgroup.member-add', targetId: id, result: endpoint.id })
      return { membership: publicMember(stmt('SELECT * FROM memberships WHERE id = ?').get(id)), created: true, groupName: group.name }
    },

    // ── DELETE /v1/workgroups/:id/members/:id ────────────────────────────────────────
    // A person may always remove themselves; removing someone else needs admin. The owner cannot
    // leave their own group this way — a group with no owner has no one who can invite.
    async removeMember({ userId, deviceId, workgroupId, membershipId }) {
      const { membership: mine } = requireMember(workgroupId, userId)
      const row = stmt('SELECT * FROM memberships WHERE id = ? AND workgroup_id = ?').get(membershipId, workgroupId)
      if (row === undefined) throw notFound('workgroup/member-not-found', 'No such member.')
      const self = (row.member_type === 'user' && row.user_id === userId)
        || (row.member_type === 'botEndpoint' && stmt('SELECT owner_id FROM bot_endpoints WHERE id = ?').get(row.endpoint_id)?.owner_id === userId)
      if (!self && mine.role !== 'owner' && mine.role !== 'admin') throw forbidden('workgroup/not-admin', 'Only the group owner or an admin may remove someone else.')
      // The owner may now leave, handing the role to the next person, instead of being locked in.
      // Nobody else is left → the group has one member and nobody to lead it, which is the dissolve
      // case; refusing here keeps a group from becoming ownerless by accident.
      if (row.role === 'owner') {
        const heir = handOverOwner(workgroupId, row.id)
        if (heir === undefined) {
          throw conflict('workgroup/last-member', 'You are the last person in this group. Delete the group instead of leaving it.')
        }
        audit.record({ actorId: userId, deviceId, action: 'workgroup.owner-handover', targetId: heir.id, result: row.id })
      }

      stmt("UPDATE memberships SET status = 'left' WHERE id = ?").run(row.id)
      audit.record({ actorId: userId, deviceId, action: 'workgroup.member-remove', targetId: row.id, result: 'ok' })
      return { membershipId: row.id, status: 'left' }
    },

    // ── DELETE /v1/workgroups/:id ────────────────────────────────────────────────────
    // The owner dissolves the group for EVERYONE. `discard` above only withdraws a group that never
    // held a message (it exists for a failed upgrade), so it cannot serve this: a real group has
    // messages by definition.
    //
    // Why this is needed at all: the client's 「删除工作群」 removed the local room and told the Hub
    // nothing, so the next start listed the group again and re-adopted it — the reported 「删除工作群，
    // 采取本应用后又出现了」. A local group never came back because it exists only on that machine.
    // Leaving instead of deleting would also have worked for that symptom, but the group would live
    // on in the Hub's list for every other member, which is not what deleting a group means.
    //
    // Memberships, events, invites, cursors, attachments, tasks and artifacts all carry
    // `REFERENCES workgroups(id) ON DELETE CASCADE`, and `PRAGMA foreign_keys = ON` is set, so this
    // one statement is the whole removal.
    async dissolve({ userId, deviceId, workgroupId }) {
      const { group, membership } = requireMember(workgroupId, userId)
      if (membership.role !== 'owner') throw forbidden('workgroup/not-owner', 'Only the group owner may delete the group.')
      db.prepare('DELETE FROM workgroups WHERE id = ?').run(workgroupId)
      audit.record({ actorId: userId, deviceId, action: 'workgroup.dissolve', targetId: workgroupId, result: group.name })
      return { workgroupId, deleted: true }
    },

    // ── POST /v1/workgroups/:id/read ─────────────────────────────────────────────────
    // The unread cursor. Kept on the group service because it needs the membership check; the
    // event service owns the actual row.
    async markRead({ userId, workgroupId, seq, events }) {
      requireMember(workgroupId, userId)
      return events.markRead({ workgroupId, userId, seq })
    },

    // ── membership bookkeeping used by the event and socket layers ───────────────────
    // Who is currently in a group, as user ids. The socket fan-out uses this to decide which
    // devices an event may reach, and it is the only place that decides.
    memberUserIds(workgroupId) {
      return membersOf.all(workgroupId).filter(row => row.user_id !== null).map(row => row.user_id)
    },

    isMember(workgroupId, userId) {
      return membershipOf.get(workgroupId, userId) !== undefined
    },

    // Groups a user belongs to, for the socket's interest set.
    groupIdsOf(userId) {
      return groupsOfUser.all(userId).map(row => row.id)
    },

    // Used by the upgrade flow's cleanup: an upgrade that failed before activation may be
    // withdrawn, but only while it holds no events beyond its creation and only by its owner.
    async discard({ userId, workgroupId }) {
      const group = byId.get(workgroupId)
      if (group === undefined) throw notFound('workgroup/not-found', 'No such workgroup.')
      if (group.owner_user_id !== userId) throw notFound('workgroup/not-found', 'No such workgroup.')
      const events = stmt('SELECT count(*) AS c FROM events WHERE workgroup_id = ?').get(workgroupId).c
      if (events > 0) throw conflict('workgroup/not-empty', 'A group that already has messages cannot be withdrawn; delete it instead.')
      db.prepare('DELETE FROM workgroups WHERE id = ?').run(workgroupId)
      return { workgroupId, deleted: true }
    },

    // Exposed for the tests that assert what a create body may contain.
    refuseHistory,
    publicGroup,
    publicMember,
  }

  return service
}
