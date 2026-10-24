// Bot endpoints: what a device publishes so other people in a group can address a Bot that runs
// on it.
//
// The boundary this module exists to hold (instruction §2, plan §10.4): an endpoint is
//   identity + a minimal set of capability names + the device that runs it.
// Nothing else. There is no column for a working directory, a session id, a command, or a file,
// and the request body is filtered against a closed key set so an unfamiliar field is refused
// rather than stored. That is what makes "the Hub never learns where a Bot keeps its files" a
// property of the schema instead of a promise in a comment.
import { randomUUID } from 'node:crypto'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { prepared } from '../db/prepared.js'
import { isUniqueViolation } from '../db/index.js'

const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '')}`

// The capabilities a `chat.message` round can actually make use of in G4. Kept deliberately
// small: a capability name that nothing acts on is a claim the product cannot honour, and the
// instruction is explicit that the set is "available-or-not", not a spec to guess at.
export const CAPABILITIES = new Set(['chat', 'files', 'tools'])

export const VISIBILITIES = new Set(['private', 'workgroup'])

// The only keys a publish request may carry. Anything else — `workDir`, `cwd`, `sessionId`,
// `path`, `config` — is refused with a message that says why, because the alternative is a
// client author quietly believing it now publishes its folder.
const ALLOWED_KEYS = new Set(['localBotId', 'name', 'visibility', 'capabilities', 'avatar'])

export const MAX_ENDPOINTS_PER_DEVICE = 50

export function createBotEndpointService({ db, audit, now = () => Date.now() }) {
  const stmt = prepared(db)
  const iso = () => new Date(now()).toISOString()

  const insert = stmt(`INSERT INTO bot_endpoints (id, owner_id, device_id, local_bot_id, name, visibility, capabilities, avatar, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
  const byId = stmt('SELECT * FROM bot_endpoints WHERE id = ?')
  const byLocal = stmt('SELECT * FROM bot_endpoints WHERE owner_id = ? AND device_id = ? AND local_bot_id = ?')
  const ofOwner = stmt('SELECT * FROM bot_endpoints WHERE owner_id = ? ORDER BY created_at ASC')
  const restore = stmt("UPDATE bot_endpoints SET status = 'active', name = ?, visibility = ?, capabilities = ?, avatar = ?, revoked_at = NULL WHERE id = ?")
  const revoke = stmt("UPDATE bot_endpoints SET status = 'revoked', revoked_at = ? WHERE id = ?")
  const countOnDevice = stmt('SELECT count(*) AS c FROM bot_endpoints WHERE device_id = ?')

  const publicEndpoint = row => ({
    endpointId: row.id,
    ownerId: row.owner_id,
    deviceId: row.device_id,
    localBotId: row.local_bot_id,
    name: row.name,
    visibility: row.visibility,
    capabilities: JSON.parse(row.capabilities),
    // The Bot's appearance, as its owner published it. Absent for an endpoint published before this
    // column existed, and the reader then falls back to the pre-publish behaviour.
    ...(row.avatar === null || row.avatar === undefined ? {} : { avatar: JSON.parse(row.avatar) }),
    status: row.status,
    createdAt: row.created_at,
  })

  // The appearance an endpoint may publish: a registered shape NAME, a palette NAME, and — because
  // the original lets a Bot carry a photo instead of a character — the data URL of that photo.
  //
  // Why it travels at all: the original derives a Bot's look from ITS OWN id (`lookOf()`,
  // characters.js). A group's roster arrives with Hub ids (`ep_…`), so without this the same Bot was
  // drawn in somebody else's machine from the wrong id — a different shape and a different colour,
  // which is exactly 「每个 bot 的头像是不能变的，现在是变了」.
  //
  // Why a closed allow-list of THREE things: anything richer is a way to smuggle a local fact onto
  // the Hub. `shape` and `color` are names the plugin validates against its own tables; `image` is
  // bytes the Bot already holds inline, capped well under one HTTP body. Nothing here names a file,
  // a path or a session.
  const MAX_AVATAR_IMAGE_LENGTH = 200_000
  const cleanAvatar = (raw) => {
    if (raw === undefined || raw === null) return null
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw badRequest('endpoint/invalid-avatar', 'avatar must be an object with a shape, a color, or an image.')
    }
    const avatar = {}
    for (const key of Object.keys(raw)) {
      if (!['shape', 'color', 'image'].includes(key)) {
        throw badRequest('endpoint/unsupported-field',
          `"${key}" is not part of a Bot's appearance. Allowed: shape, color, image.`)
      }
    }
    if (typeof raw.shape === 'string' && /^[a-z][\w-]{0,31}$/.test(raw.shape)) avatar.shape = raw.shape
    if (typeof raw.color === 'string' && /^[a-z][\w-]{0,31}$/.test(raw.color)) avatar.color = raw.color
    if (typeof raw.image === 'string' && raw.image.startsWith('data:image/')) {
      if (raw.image.length > MAX_AVATAR_IMAGE_LENGTH) {
        throw badRequest('endpoint/invalid-avatar', `The avatar image is ${raw.image.length} characters; the limit is ${MAX_AVATAR_IMAGE_LENGTH}. Use a smaller square image.`)
      }
      avatar.image = raw.image
    }
    return Object.keys(avatar).length === 0 ? null : avatar
  }

  const cleanCapabilities = (raw) => {
    if (raw === undefined) return ['chat']
    if (!Array.isArray(raw)) throw badRequest('endpoint/invalid-capabilities', 'capabilities must be an array of names.')
    const names = [...new Set(raw.map(name => String(name)))]
    for (const name of names) {
      if (!CAPABILITIES.has(name)) {
        throw badRequest('endpoint/unknown-capability',
          `"${name}" is not a capability this Hub knows. Known: ${[...CAPABILITIES].join(', ')}.`)
      }
    }
    return names
  }

  const service = {
    publicEndpoint,
    CAPABILITIES,

    // ── POST /v1/bot-endpoints ────────────────────────────────────────────────────────
    // Idempotent per (owner, device, local Bot): re-publishing the same Bot is how a client
    // refreshes its name or capability list after a restart, and must not accumulate rows.
    async publish({ userId, deviceId, body }) {
      for (const key of Object.keys(body ?? {})) {
        if (!ALLOWED_KEYS.has(key)) {
          throw badRequest('endpoint/unsupported-field',
            `"${key}" is not part of a Bot endpoint. An endpoint publishes its identity, its capabilities and its device — not a folder, a path or a session.`)
        }
      }
      const localBotId = typeof body.localBotId === 'string' ? body.localBotId.trim() : ''
      if (localBotId === '' || localBotId.length > 128) throw badRequest('endpoint/invalid-bot-id', 'A Bot endpoint needs the id of the local Bot it stands for.')
      const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 80) : localBotId
      const visibility = typeof body.visibility === 'string' ? body.visibility : 'workgroup'
      if (!VISIBILITIES.has(visibility)) throw badRequest('endpoint/invalid-visibility', 'visibility must be "private" or "workgroup".')
      const capabilities = cleanCapabilities(body.capabilities)
      // A publisher that does not mention `avatar` keeps whatever the Hub already holds: an older
      // client must not blank out the appearance a newer one published.
      const avatar = body.avatar === undefined ? undefined : cleanAvatar(body.avatar)
      const avatarJson = avatar === undefined ? undefined : (avatar === null ? null : JSON.stringify(avatar))

      const existing = byLocal.get(userId, deviceId, localBotId)
      if (existing !== undefined) {
        if (existing.status === 'revoked') {
          // A revoke is a decision, but publishing again is the same user asking for the same Bot
          // on the same device: refusing here would leave a Bot permanently unpublishable after
          // one misclick.
          restore.run(name, visibility, JSON.stringify(capabilities), avatarJson ?? existing.avatar ?? null, existing.id)
        } else {
          db.prepare('UPDATE bot_endpoints SET name = ?, visibility = ?, capabilities = ?, avatar = ? WHERE id = ?')
            .run(name, visibility, JSON.stringify(capabilities), avatarJson ?? existing.avatar ?? null, existing.id)
        }
        return { endpoint: publicEndpoint(byId.get(existing.id)), created: existing.status === 'revoked' }
      }

      if (countOnDevice.get(deviceId).c >= MAX_ENDPOINTS_PER_DEVICE) {
        throw conflict('endpoint/too-many', `One device may publish at most ${MAX_ENDPOINTS_PER_DEVICE} Bot endpoints.`)
      }

      const id = newId('ep')
      try {
        insert.run(id, userId, deviceId, localBotId, name, visibility, JSON.stringify(capabilities), avatarJson ?? null, iso())
      } catch (error) {
        if (isUniqueViolation(error)) {
          const raced = byLocal.get(userId, deviceId, localBotId)
          if (raced !== undefined) return { endpoint: publicEndpoint(raced), created: false }
        }
        throw error
      }
      audit.record({ actorId: userId, deviceId, action: 'endpoint.publish', targetId: id, result: 'ok' })
      return { endpoint: publicEndpoint(byId.get(id)), created: true }
    },

    // ── GET /v1/bot-endpoints ─────────────────────────────────────────────────────────
    // The caller's own endpoints, plus — when a group is named — the endpoints of the other
    // members of that group, so a member list can show "Chief (Alice's desktop)". Only published
    // ones: a `private` endpoint is never visible to anyone else.
    async list({ userId, workgroupId }) {
      const mine = ofOwner.all(userId).filter(row => row.status === 'active').map(publicEndpoint)
      if (workgroupId === undefined) return { endpoints: mine }

      const rows = stmt(`SELECT e.* FROM bot_endpoints e
        JOIN memberships m ON m.endpoint_id = e.id AND m.member_type = 'botEndpoint' AND m.status = 'active'
        WHERE m.workgroup_id = ?`).all(workgroupId)
      const others = rows
        .filter(row => row.owner_id !== userId && row.visibility === 'workgroup' && row.status === 'active')
        .map(publicEndpoint)
      // `owned` is separated rather than merged so a client never has to compare owner ids to know
      // which endpoints it is allowed to publish or revoke.
      return { endpoints: [...mine, ...others], owned: mine.map(row => row.endpointId) }
    },

    // ── POST /v1/bot-endpoints/:id/revoke ─────────────────────────────────────────────
    async revoke({ userId, deviceId, endpointId }) {
      const endpoint = byId.get(endpointId)
      if (endpoint === undefined || endpoint.owner_id !== userId) throw notFound('endpoint/not-found', 'No such Bot endpoint.')
      if (endpoint.status !== 'revoked') {
        revoke.run(iso(), endpoint.id)
        audit.record({ actorId: userId, deviceId, action: 'endpoint.revoke', targetId: endpoint.id, result: 'ok' })
      }
      return { endpointId: endpoint.id, status: 'revoked' }
    },

    // Used by the group service when a member adds a Bot endpoint to a group: the endpoint must
    // exist, be published, and belong to the person adding it (or be visible to the group).
    endpointFor({ endpointId, workgroupId }) {
      const endpoint = byId.get(endpointId)
      if (endpoint === undefined || endpoint.status !== 'active') return undefined
      if (endpoint.visibility === 'private') return undefined
      // A workgroup-visible endpoint may only be added to a group its owner is in — otherwise
      // knowing an endpoint id would be enough to pull someone's Bot into a stranger's group.
      const ownerMember = stmt(`SELECT 1 AS ok FROM memberships
        WHERE workgroup_id = ? AND member_type = 'user' AND user_id = ? AND status = 'active'`).get(workgroupId, endpoint.owner_id)
      return ownerMember === undefined ? undefined : endpoint
    },

    // The endpoints whose owners are in a group, for the socket's fan-out set.
    endpointsOfGroup(workgroupId) {
      return stmt(`SELECT e.* FROM bot_endpoints e
        JOIN memberships m ON m.endpoint_id = e.id AND m.member_type = 'botEndpoint' AND m.status = 'active'
        WHERE m.workgroup_id = ? AND e.status = 'active'`).all(workgroupId)
    },

    requireOwnEndpoint(userId, endpointId) {
      const endpoint = byId.get(endpointId)
      if (endpoint === undefined || endpoint.owner_id !== userId) throw forbidden('endpoint/not-owner', 'That Bot endpoint belongs to another account.')
      return endpoint
    },
  }

  return service
}
