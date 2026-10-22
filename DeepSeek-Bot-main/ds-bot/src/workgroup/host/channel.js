// The Workgroup client channel: the POST /api/workgroup endpoints the workgroup UI
// calls. Deliberately a separate route from the original's /api/bot (P0-18) so the two
// clients can never address each other's state by mistake.
//
// Read endpoints are answered on a read-only host too; anything that writes refuses,
// the same rule the original channel applies.
import { WG_ROUTE } from '../shared/constants.js'

const READS = new Set(['state', 'room', 'room-progress', 'hub-state', 'hub-devices', 'hub-recovery-state'])

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

export function install(wg) {
  const { ctx, rt } = wg

  const ok = value => ({ ok: true, value })
  const fail = (message, code = 'bot/error') => ({ ok: false, error: { code, message, details: {} } })

  // The list the sidebar needs: one row per workgroup, no log bodies.
  const listView = () => wg.view()

  // The activity of every member at work, keyed by Bot id — the shape the original's
  // `activityView` has, which the mascot reads. A workgroup member's mascot showed nothing
  // because the original's map only knows a Bot's own chat and local groups.
  const activityView = () => {
    const merged = {}
    for (const [sessionId, entry] of wg.live ?? []) {
      if (entry.turn === undefined) continue
      const owner = wg.sessionOwners.get(sessionId)
      if (owner?.botId === undefined) continue
      merged[owner.botId] ??= entry.tool === undefined ? 'thinking' : /search|fetch|browse|browser|read|grep|glob|list/i.test(entry.tool) ? 'searching' : 'working'
    }
    return merged
  }

  // Every workgroup's members at work, keyed by room id — the original's `roomWorkView`.
  const roomWorkViews = () => Object.fromEntries(Object.keys(wg.state?.workgroups ?? {})
    .map(id => [id, wg.roomWorkView?.(id) ?? []])
    .filter(([, entries]) => entries.length > 0))

  // One room in full, for the chat pane: members, notice and the recent log.
  const roomView = async (roomId) => {
    await wg.load()
    const room = wg.workgroupOf(roomId)
    if (room === undefined) return undefined
    await wg.loadLines?.(room)
    return {
      ...wg.view().find(entry => entry.id === roomId),
      log: (room.log ?? []).map(line => ({ seq: line.seq, who: line.who, memberId: line.memberId, kind: line.kind, text: line.text })),
      members: room.members ?? [],
      adminId: room.adminId ?? null,
    }
  }

  async function handle(endpoint, payload) {
    try {
      const body = payload ?? {}
      const readOnly = rt.readOnly?.()
      if (readOnly !== undefined && !READS.has(endpoint)) return fail(readOnly, 'bot/read-only')
      switch (endpoint) {
        case 'state': {
          await wg.load()
          // A group created before "a group is a Session" has no Session to open. Give it
          // one now, so the list never hands out an id the UI cannot enter.
          for (const room of Object.values(wg.state.workgroups)) {
            if (String(room.id).startsWith('wg-')) await wg.adoptSession(room)
          }
          // A workgroup deleted by a build that did not archive its own Session left that
          // Session behind, and the "@" menu kept offering it (「右键菜单删除的群聊，
          // @的时候还存在」). `deleteWorkgroup` archives it from now on; this clears what
          // older builds left, once.
          await wg.adoptOrphans?.()
          // COPY OF THE ORIGINAL state answer (src/host/channel.js:73): what changes without
          // a new revision goes with every state answer, so the member capsule and the
          // mascot know who is at work before the next poll of the original route. `work` is
          // this domain's own view — the original's never holds a workgroup member Session.
          return ok({
            rooms: listView(),
            route: WG_ROUTE,
            activity: activityView(),
            work: { bots: wg.workView?.() ?? {}, rooms: roomWorkViews(), approvals: [], waiting: {} },
          })
        }

        case 'room': {
          const room = await roomView(String(body.id ?? ''))
          return room === undefined ? fail('Unknown workgroup', 'bot/not-found') : ok(room)
        }

        // COPY OF THE ORIGINAL (`room-progress`, src/host/channel.js:152): the replies a
        // running round has so far, and who is speaking now. The client polls this while a
        // relay is in flight to draw the members one by one, so a workgroup round has to
        // answer it from THIS domain's rounds — the original route holds only local ones.
        case 'room-progress': {
          const roomId = String(body.roomId ?? '')
          return ok([...wg.roomProgress.entries()]
            .filter(([, entry]) => entry.roomId === roomId)
            .map(([callId, entry]) => ({ callId, replies: entry.replies, speaking: entry.speaking ?? null })))
        }

        case 'create-room': {
          // No name is required: the original derives one from the members ("You, A, B")
          // and only checks a clash for a CUSTOM name. Requiring one here would make the
          // workgroup composer behave differently from the group composer it copies.
          const room = await wg.createWorkgroup({
            name: typeof body.name === 'string' ? body.name : '',
            notice: typeof body.notice === 'string' ? body.notice : '',
            members: Array.isArray(body.members) ? body.members : [],
          })
          return ok(await roomView(room.id))
        }

        case 'update-room': {
          const id = String(body.id ?? '')
          const patch = {}
          // COPY OF THE ORIGINAL payload (`update-room`, src/host/channel.js:192): the
          // settings form here IS the original form, so it sends the original fields —
          // name, notice, mode, admin, members, add, remove, workDir, permission. Every
          // one of them that this endpoint did not carry was a field the form offered and
          // the host silently dropped, which is exactly "设置无法写入": the write answered
          // OK and nothing changed.
          //
          // `admin` is forwarded as this domain's own `adminId`, because a workgroup keeps
          // its admin under that name (a member is not always a local Bot, so the original
          // `room.admin` field could not be reused). `permission` is the group's own
          // preset, and only the user may set it — `updateWorkgroup` enforces that,
          // because this endpoint calls it with no actor.
          for (const key of ['name', 'notice', 'mode', 'permission', 'workDir']) if (body[key] !== undefined) patch[key] = body[key]
          if (body.adminId !== undefined) patch.adminId = body.adminId
          // The original's field name is `admin`; accept both so either caller works.
          if (body.admin !== undefined && body.adminId === undefined) patch.adminId = body.admin
          if (Array.isArray(body.members)) patch.members = body.members
          if (Array.isArray(body.add)) patch.add = body.add
          if (Array.isArray(body.remove)) patch.remove = body.remove
          const room = await wg.updateWorkgroup(id, patch)
          return ok(await roomView(room.id))
        }

        // COPY OF THE ORIGINAL (`set-flags`, src/host/channel.js:233 / roster.js:269).
        // The sidebar's Pin, Mark as unread and Hide entries appear on a workgroup row too
        // — it is the same row component — and they call the ORIGINAL route, which finds
        // only local Bots and rooms and answered "Unknown conversation" for a workgroup.
        // These flags live on this domain's own record, so this route is the one that can
        // set them.
        case 'set-flags': {
          await wg.load()
          const room = wg.workgroupOf(String(body.id ?? ''))
          if (room === undefined) return fail('Unknown workgroup', 'bot/not-found')
          const set = body.flags !== null && typeof body.flags === 'object' ? body.flags : body
          if (typeof set.pinned === 'boolean') room.pinned = set.pinned
          if (typeof set.hidden === 'boolean') room.hidden = set.hidden
          await wg.save()
          return ok(room)
        }

        case 'delete-room': {
          await wg.deleteWorkgroup(String(body.id ?? ''))
          return ok(true)
        }

        // A local group being turned into a linked workgroup (plan §8.2). G1 only
        // creates the linked room and records the mapping; it never uploads history.
        case 'upgrade-room': {
          const localRoomId = String(body.localRoomId ?? '')
          if (localRoomId === '') throw invalid('No local group named')
          const existing = wg.linkOf(localRoomId)
          // Idempotent by localRoomId: a retried upgrade must not make a second group.
          if (existing !== undefined) {
            const found = wg.workgroupOf(existing.workgroupId)
            return found === undefined
              ? fail('The linked workgroup is gone', 'bot/stale')
              : ok({ workgroupId: found.id, created: false })
          }
          const local = rt.roomOf?.(localRoomId)
          if (local === undefined) return fail('Unknown local group', 'bot/not-found')
          const room = await wg.createWorkgroup({
            name: typeof body.name === 'string' && body.name.trim() !== '' ? body.name : local.name,
            notice: typeof body.notice === 'string' ? body.notice : (local.notice ?? ''),
          })
          wg.state.links[localRoomId] = {
            workgroupId: room.id,
            upgradeId: `up-${localRoomId}-${room.id}`,
            status: 'LOCAL_LINKED',
            createdAt: Date.now(),
          }
          await wg.save()
          return ok({ workgroupId: room.id, created: true })
        }

        // Posting into a workgroup. The original's composer does not queue the text
        // itself: it prompts the group's own Session, and that Session's relay answers.
        // The identical path is used here — the message goes into the group's chat, the
        // `user/message` listener queues it, and the relay tool runs the round — so a
        // message typed into a workgroup behaves exactly like one typed into a group.
        case 'send': {
          const roomId = String(body.roomId ?? '')
          const text = String(body.text ?? '')
          if (text.trim() === '') throw invalid('Nothing to send')
          const room = wg.workgroupOf(roomId)
          if (room === undefined) return fail('Unknown workgroup', 'bot/not-found')
          // A workgroup with nobody in it has no one to answer. Refuse instead of
          // pretending, so the UI can say what is actually wrong.
          if ((room.members ?? []).length === 0) {
            return fail('This workgroup has no members yet, so there is no one to answer. Add a member first.', 'bot/invalid')
          }
          await wg.postToSession(room, text, {
            ...(Array.isArray(body.files) ? { files: body.files } : {}),
            ...(Array.isArray(body.images) ? { images: body.images } : {}),
          })
          return ok(true)
        }

        case 'stop-round': {
          return ok(await wg.stopRound(String(body.roomId ?? '')))
        }

        // COPY OF THE ORIGINAL `stop-member-work`: stop one member of a round, not the
        // whole round. The original checks `rt.live`, which holds the LOCAL domain's
        // turns; this domain keeps its own rounds in `wg.roomProgress`, so that is what
        // says whether this member is working right now.
        case 'stop-member-work': {
          return ok(await wg.stopMemberWork(String(body.roomId ?? ''), String(body.botId ?? '')))
        }

        // ── the Hub account ────────────────────────────────────────────────────────
        // These are deliberately last and deliberately separate from everything above: a Hub
        // failure must never be able to disturb a workgroup call. Every one of them is inert
        // while signed out, which is what keeps the local team usable with no Hub at all.
        case 'hub-state': {
          const account = await wg.hub.restore()
          return ok({
            ...(account === undefined ? { loggedIn: false } : { loggedIn: true, account }),
            // Which store holds the device key, so the page can say so rather than implying an
            // OS keychain the plugin cannot reach (docs/g3/PLAN.md §0).
            backend: wg.hubStore.backend,
            storage: wg.hubStore.location,
          })
        }

        case 'hub-register':
        case 'hub-login': {
          const account = await wg.hub.authenticate({
            baseUrl: String(body.baseUrl ?? ''),
            phone: String(body.phone ?? ''),
            // Read once, passed once, never stored.
            password: String(body.password ?? ''),
            mode: endpoint === 'hub-register' ? 'register' : 'login',
          })
          return ok({ loggedIn: true, account })
        }

        case 'hub-logout': {
          await wg.hub.logout()
          return ok({ loggedIn: false })
        }

        case 'hub-devices': {
          return ok({ devices: await wg.hub.devices() })
        }

        case 'hub-me': {
          return ok(await wg.hub.me())
        }

        case 'hub-revoke-device': {
          await wg.hub.revokeDevice(String(body.deviceId ?? ''))
          return ok({ revoked: true })
        }

        case 'hub-health': {
          return ok(await wg.hub.health(String(body.baseUrl ?? '')))
        }

        // ── password recovery ──────────────────────────────────────────────────────
        // Three paths, matching the Hub's three layers. The operator path is NOT here: it runs
        // from the Hub command line against the database file, because an HTTP route that resets
        // any password without a session is a back door.
        case 'hub-recover': {
          const account = await wg.hub.recover({
            baseUrl: String(body.baseUrl ?? ''),
            phone: String(body.phone ?? ''),
            code: String(body.code ?? ''),
            // Read once, passed once, never stored.
            newPassword: String(body.newPassword ?? ''),
          })
          return ok({ loggedIn: true, account })
        }

        case 'hub-change-password': {
          await wg.hub.changePassword({
            currentPassword: String(body.currentPassword ?? ''),
            newPassword: String(body.newPassword ?? ''),
          })
          return ok({ changed: true })
        }

        case 'hub-recovery-state': {
          return ok(await wg.hub.recoveryState())
        }

        case 'hub-create-recovery-code': {
          return ok(await wg.hub.createRecoveryCode())
        }

        default:
          return fail(`Unknown endpoint ${endpoint}`, 'bot/not-found')
      }
    } catch (error) {
      const code = error?.code ?? 'bot/error'
      if (code === 'bot/internal') rt.noteFailure?.({ source: 'workgroup-api', text: String(error?.message ?? error), code, stack: error?.stack })
      return fail(error?.message ?? String(error), code)
    }
  }

  // A route of its own, exactly like the original channel registers /api/bot.
  ctx.effect(() => ctx.connection.fetch.register({
    path: WG_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try { body = await request.json() } catch { body = {} }
      const result = await handle(String(body?.endpoint ?? ''), body?.payload)
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }), 'ds-bot: workgroup api route')

  // Exposed so the original state answer can merge this domain's activity into the one
  // poll the client reads (src/host/channel.js `live`). Read-only projections.
  wg.activityView = activityView
  wg.roomWorkViews = roomWorkViews

  wg.apiHandle = handle
}
