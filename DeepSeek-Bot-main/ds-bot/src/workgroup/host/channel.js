// The Workgroup client channel: the POST /api/workgroup endpoints the workgroup UI
// calls. Deliberately a separate route from the original's /api/bot (P0-18) so the two
// clients can never address each other's state by mistake.
//
// Read endpoints are answered on a read-only host too; anything that writes refuses,
// the same rule the original channel applies.
import { WG_ROUTE } from '../shared/constants.js'

const READS = new Set([
  'state', 'room', 'room-progress', 'hub-state', 'hub-devices', 'hub-recovery-state',
  'upgrade-status', 'bridge-state', 'group-members', 'group-invites', 'attachment-download',
  // G5 reads. A read-only host may answer these: they say what is waiting and what a lease is,
  // without approving anything or running anything.
  'task-requests', 'task-state', 'task-list', 'task-artifacts', 'artifact-download',
  'group-lease',
])

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

export function install(wg) {
  const { ctx, rt } = wg

  const ok = value => ({ ok: true, value })
  const fail = (message, code = 'bot/error', details = undefined) => ({
    ok: false,
    error: { code, message, details: details === undefined ? {} : details },
  })

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

  // How many messages of a Hub group this person has not read yet.
  //
  // A line carries `hubSeq` when it came from the Hub's log, and only `chat.message` rows become
  // lines — a task event never does. Counting those above the cursor is therefore the same
  // question the Hub answers with `unreadCount`, asked of the copy this machine holds, so the badge
  // works with no socket and cannot disagree with the Hub while both are up.
  //
  // The local log is trimmed to WG_LOG_MAX; a backlog larger than that under-counts, which is the
  // honest failure (a badge that says "40+" rather than a number nobody can scroll to).
  const unreadOf = (room, readSeq) => (room.log ?? [])
    .filter(line => Number.isFinite(line.hubSeq) && line.hubSeq > readSeq)
    .length

  // One room in full, for the chat pane: members, notice and the recent log.
  //
  // G4 adds three things the pane needs and the G3 view did not carry:
  //   * `hub` — the Hub group's own id and how far this machine has read, when this room is a
  //     Hub group. The panel draws the invite control and the connection line only for one.
  //   * per line, `via`/`hubEventId`/`hubSeq` — whether it crossed the Hub, and which event it
  //     was. That is the message state the phase requires.
  //   * `archived` — an upgraded local group is read-only history, so the composer must say so
  //     instead of accepting a message that would go nowhere.
  const roomView = async (roomId) => {
    await wg.load()
    const room = wg.workgroupOf(roomId)
    if (room === undefined) return undefined
    await wg.loadLines?.(room)
    const hubWorkgroupId = room.hubWorkgroupId
    const bridge = hubWorkgroupId === undefined ? undefined : wg.bridge?.groupState?.(hubWorkgroupId)
    return {
      ...wg.view().find(entry => entry.id === roomId),
      log: (room.log ?? []).map(line => ({
        seq: line.seq,
        who: line.who,
        memberId: line.memberId,
        kind: line.kind,
        text: line.text,
        // A line that came in over the Hub, and which event it was. A local line has neither.
        via: line.via ?? null,
        hubEventId: line.hubEventId ?? null,
        hubSeq: line.hubSeq ?? null,
        // The line's files, so the pane can offer a download. Absent on a text-only line.
        ...(Array.isArray(line.attachments) && line.attachments.length > 0 ? { attachments: line.attachments } : {}),
      })),
      members: room.members ?? [],
      adminId: room.adminId ?? null,
      // Unread counts MESSAGES above the cursor, not the distance between two seq numbers.
      //
      // The Hub allocates one `seq` stream for the whole group, and G5 puts task, approval and
      // artifact events in it (`task.request` has to reach a machine that was offline). A
      // difference of seqs would therefore grow while nobody typed, and the badge would say "7" for
      // one unanswered approval. `unreadOf` counts the same thing the Hub's own `unreadCount`
      // does — `chat.message` rows above the cursor — over the lines this machine has applied.
      ...(hubWorkgroupId === undefined ? {} : {
        lastReadSeq: wg.bridge?.readCursor?.(hubWorkgroupId) ?? 0,
        unread: unreadOf(room, wg.bridge?.readCursor?.(hubWorkgroupId) ?? 0),
      }),
      hub: hubWorkgroupId === undefined ? null : {
        workgroupId: hubWorkgroupId,
        // How far this machine has applied the Hub's log, and how many sends still wait for an
        // ack. Both are read from the bridge, so the pane cannot invent them.
        cursor: bridge?.cursor ?? 0,
        pending: bridge?.pending ?? 0,
        connected: wg.bridge?.status?.().connected === true,
      },
      archived: wg.upgrade?.isArchived?.(roomId) === true,
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
          const members = Array.isArray(body.members) ? body.members : []
          const name = typeof body.name === 'string' ? body.name : ''
          const notice = typeof body.notice === 'string' ? body.notice : ''

          // A signed-in machine creates the group on the Hub as well, because that is the only
          // kind of group another person can join: a workgroup that exists only here is a local
          // group with a different name, and the client would draw an invite control and a Hub
          // line for a group the Hub has never heard of.
          //
          // The local Bots picked in the composer are published as Bot endpoints and added as
          // members, so the group answers the way the composer promised. Both steps are already
          // idempotent, so a retry after a partial failure does not duplicate either.
          const account = await wg.hub.restore().catch(() => undefined)
          if (account !== undefined) {
            const published = await wg.bridge.start().catch(() => undefined)
            // A session the Hub no longer knows is not an unreachable Hub: saying so would send the
            // person to check a service that is running fine, while the real next step is to sign in
            // again. `hub.js` deletes the dead record, so the only surviving evidence is the bridge's
            // own refused flag.
            if (published?.refused === true) {
              return fail(
                'Your Hub session has ended, so this device was signed out. Sign in to the Hub again, then create the workgroup.',
                'hub/signed-out',
              )
            }
            if (published === undefined) return fail('Could not reach the Hub, so the workgroup was not created.', 'hub/unreachable')
            const endpoints = await wg.bridge.publishBotEndpoints().catch(() => [])
            const endpointIds = endpoints
              .filter(endpoint => members.some(member => String(member?.id) === String(endpoint.localBotId)))
              .map(endpoint => endpoint.endpointId)
            const created = await wg.bridge.createWorkgroup({
              // The name the local room would use, because the Hub requires text and the composer legitimately
              // sends none. The original derives "You, Chief, …" from the members
              // (src/host/roster.js `autoRoomName`) and this domain's copy does the same in
              // `autoWorkgroupName`; sending `undefined` here instead made the Hub refuse the whole
              // create with "The group name must be text.", so no workgroup was ever made.
              //
              // Derived from the ROSTER (names as the Hub will show them), not from the composer's
              // list: a member this machine cannot name would otherwise contribute nothing.
              name: name.trim() === '' ? wg.autoNameFor?.(members) ?? 'Workgroup' : name.trim(),
              notice: notice === '' ? undefined : notice,
              endpointIds: endpointIds.length === 0 ? undefined : endpointIds,
            })
            const room = wg.roomOfHubGroup(created.workgroupId)
            // The Hub's roster is the truth for membership, so the local room learns it here
            // rather than keeping the composer's list: a second person in the group is not
            // somebody this machine picked.
            await wg.syncRoster?.({ hubWorkgroupId: created.workgroupId }).catch(() => {})
            return ok(await roomView(room?.id ?? created.workgroupId))
          }

          // Signed out. A workgroup lives on the Hub (plan §8.1: create it AFTER signing in), so without an
          // account there is no group anyone could join and no colleague anyone could invite. The
          // G4 version of this branch created a local-shaped group instead, and it produced
          // something that was neither a real workgroup (no Hub identity) nor a local group (a
          // different member model and a different file) — a group the person could not tell apart
          // from a real one until they tried to invite somebody.
          //
          // Refused in the HOST, not only in the client: `apiHandle` is reachable without the UI, and a
          // client-side check would leave that door open. 「Local group」 is the entry that needs no account,
          // and it is untouched.
          return fail(
            'Sign in to the Hub first: a workgroup lives on the Hub, so there is nobody to invite without one. Local group chats work without signing in.',
            'hub/not-signed-in',
          )
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

        // A local group being turned into a workgroup (plan §8.2), through the four-state
        // transaction in host/upgrade.js:
        //
        //   PREPARING → HUB_CREATED → LOCAL_LINKED → ACTIVE
        //
        // The call is idempotent end to end, which is what gate item 4 measures: calling it again
        // after a failure continues from wherever the previous attempt stopped, and the Hub is
        // asked with the SAME upgrade id, so N retries leave one group. The original group's log is
        // never part of the request — the body this endpoint accepts is a name, a notice and the Bot
        // endpoints to publish, and the Hub refuses anything else by name (gate item 3).
        case 'upgrade-room': {
          const localRoomId = String(body.localRoomId ?? '')
          if (localRoomId === '') throw invalid('No local group named')
          try {
            const result = await wg.upgrade.run({
              localRoomId,
              deviceId: wg.hub?.account?.deviceId,
              // Only these three fields ever leave this machine. `members` is deliberately absent:
              // a local group's members are Bots on this device, and a workgroup's roster is decided
              // on the Hub.
              preview: {
                name: typeof body.name === 'string' ? body.name : undefined,
                notice: typeof body.notice === 'string' ? body.notice : undefined,
                endpointIds: Array.isArray(body.endpointIds) ? body.endpointIds : undefined,
              },
            })
            return ok(result)
          } catch (error) {
            // The link keeps where it stopped, so the panel can say which state it is in and offer
            // the retry. A failure that left no link at all is reported as-is.
            const status = await wg.upgrade.fail(localRoomId, error).catch(() => undefined)
            return fail(error?.message ?? String(error), error?.code ?? 'bot/error', status)
          }
        }

        // What the panel needs to draw a local group's upgrade state, whether it can offer the
        // action, and what to say if the last attempt stopped halfway.
        case 'upgrade-status': {
          const localRoomId = String(body.localRoomId ?? '')
          if (localRoomId === '') throw invalid('No local group named')
          return ok(wg.upgrade.statusOf(localRoomId))
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

        // A message typed into a group that lives on the Hub.
        //
        // The Hub gets it FIRST (`bridge.send` resolves once the Hub acknowledged, or reports that
        // it queued the message because the socket is down). Only then does the local pane see it,
        // because `bridge.apply` posts the Hub's own event into this room. That order is what makes
        // "I sent it" mean "everyone can see it" rather than "it is on my screen".
        //
        // It is a different endpoint from `send` on purpose: `send` is the local round (the
        // original relay, a Bot answering in this room), and a Hub group's message must not also
        // start a local round under the same text.
        case 'send-hub': {
          const workgroupId = String(body.workgroupId ?? '')
          const text = String(body.text ?? '')
          if (workgroupId === '') throw invalid('No workgroup named')
          if (text.trim() === '') throw invalid('Nothing to send')
          if (wg.roomOfHubGroup?.(workgroupId) === undefined) return fail('Unknown workgroup', 'bot/not-found')
          const result = await wg.bridge.send({ workgroupId, text })
          return ok({
            eventId: result.eventId,
            // `queued` is shown to the person: a message typed with no socket is kept, not lost.
            queued: result.queued === true,
            connected: wg.bridge.status().connected,
          })
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
          // A stored account with no live socket is the normal state after a restart — the access
          // token is deliberately not on disk. Starting here is what reconnects it, so the panel
          // (and any other reader of `hub-state`) does not have to remember to ask.
          if (account !== undefined && wg.bridge.status().state === 'offline') {
            await wg.bridge.start().catch(() => {})
          }
          // Ask again rather than trusting the snapshot above: starting the bridge is what re-mints
          // the access token, and if the Hub refuses that token the record is gone by now. Answering
          // `loggedIn: true` from the stale snapshot is what made the page show an account that could
          // not do anything — the invite control then offered itself and every invite failed.
          const live = (await wg.hub.restore().catch(() => undefined)) ?? undefined
          return ok({
            ...(live === undefined ? { loggedIn: false } : { loggedIn: true, account: live }),
            bridge: wg.bridge.status(),
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
          // Signing in is the moment a socket becomes possible, so it is started here rather than
          // left to a button: a user who signs in and then opens a workgroup expects the group to
          // be live, and a bridge that only starts from the account page is a bridge that is off
          // for everyone who never opens that page.
          //
          // A failure to connect is reported, never fatal: the account is signed in either way, and
          // a Hub that refuses WSS must not undo a successful login.
          const bridge = await wg.bridge.start()
            .catch(error => ({ connected: false, error: error?.message ?? String(error) }))
          return ok({ loggedIn: true, account, bridge })
        }

        case 'hub-logout': {
          await wg.hub.logout()
          // A sign-out closes the socket and drops the outbox: those messages belonged to the
          // account that just left.
          await wg.bridge.reset().catch(() => {})
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

        // ── the bridge ─────────────────────────────────────────────────────────────
        // Read-only status plus the three verbs a person actually needs: connect, disconnect, and
        // "show me what is wrong". Nothing here reaches the Hub unless it is asked to, so a client
        // that only polls `bridge-state` costs nothing.
        case 'bridge-state': {
          return ok(wg.bridge.status())
        }

        case 'bridge-start': {
          // Refused while signed out rather than retried forever: there is no account to connect
          // with, and the page should say so.
          const account = await wg.hub.restore()
          if (account === undefined) return fail('Sign in to the Hub first.', 'bot/not-signed-in')
          const status = await wg.bridge.start()
          // Publishing is what makes this machine's Bots addressable in a group, so a connect does
          // both. A publish failure is reported but does not fail the connect: chatting works
          // without it.
          const published = await wg.bridge.publishBotEndpoints().catch(error => {
            rt.warn?.('ds-bot: Bot endpoints not published: %s', error?.message ?? error)
            return []
          })
          return ok({ ...status, endpoints: published.length })
        }

        case 'bridge-stop': {
          await wg.bridge.stop()
          return ok(wg.bridge.status())
        }

        // Create a group straight on the Hub — the path plan §8.1 requires ("after signing in to
        // the Hub a workgroup can be created directly, without a local group first"). The local
        // room that represents it is created by the bridge, so the pane has something to open.
        case 'bridge-create-group': {
          const account = await wg.hub.restore()
          if (account === undefined) return fail('Sign in to the Hub first.', 'bot/not-signed-in')
          const name = String(body.name ?? '').trim()
          if (name === '') throw invalid('Give this workgroup a name')
          const created = await wg.bridge.createWorkgroup({
            name,
            notice: typeof body.notice === 'string' ? body.notice : undefined,
          })
          return ok({
            workgroupId: created.workgroupId,
            roomId: wg.roomOfHubGroup?.(created.workgroupId)?.id ?? null,
            name: created.workgroup?.name ?? name,
          })
        }

        case 'bridge-sync': {
          const workgroupId = String(body.workgroupId ?? '')
          if (workgroupId === '') throw invalid('No workgroup named')
          return ok(await wg.bridge.sync(workgroupId))
        }

        // ── members and invites ────────────────────────────────────────────────────
        // One Hub group's roster, as the Hub sees it. The Hub is authoritative for who is in a
        // Hub group; this machine's own room record only knows the members it has a line from.
        case 'group-members': {
          const workgroupId = String(body.workgroupId ?? '')
          if (workgroupId === '') throw invalid('No workgroup named')
          const room = wg.roomOfHubGroup?.(workgroupId)
          const remote = await wg.hub.workgroup(workgroupId).catch(error => ({ error: error?.message ?? String(error) }))
          if (remote?.error !== undefined) return fail(remote.error, 'hub/unreachable')
          return ok({ workgroupId, roomId: room?.id ?? null, members: remote.members ?? [] })
        }

        case 'group-invites': {
          // Two lists, because they answer two questions: which groups I am in, and who has
          // asked me to join one. Both come from the Hub, which owns the invite rows.
          const [incoming, groups] = await Promise.all([
            wg.hub.invites().catch(() => []),
            wg.hub.workgroups().catch(() => []),
          ])
          return ok({
            incoming: incoming ?? [],
            groups: (groups ?? []).map(group => ({
              workgroupId: group.workgroupId,
              name: group.name,
              role: group.role,
              unread: group.unreadCount ?? 0,
            })),
          })
        }

        case 'invite-member': {
          const workgroupId = String(body.workgroupId ?? '')
          if (workgroupId === '') throw invalid('No workgroup named')
          // Either a phone number or a Hub user id. The Hub has always accepted both (§13.1's
          // `hubUserId` branch, hub/src/workgroups/service.js) and this route only ever forwarded the
          // phone, so a colleague whose id you know could not be invited at all.
          const phone = String(body.phone ?? '').trim()
          const hubUserId = String(body.hubUserId ?? '').trim()
          if (phone === '' && hubUserId === '') throw invalid('Enter a phone number or a Hub user id')
          // A person, never a path or a Bot: an invite names somebody on the Hub.
          const invite = await wg.bridge.invite({
            workgroupId,
            ...(phone === '' ? {} : { phone }),
            ...(hubUserId === '' ? {} : { hubUserId }),
          })
          return ok({
            inviteId: invite.inviteId,
            inviteePhoneMasked: invite.inviteePhoneMasked,
            status: invite.status,
            expiresAt: invite.expiresAt,
          })
        }

        case 'answer-invite': {
          const inviteId = String(body.inviteId ?? '')
          if (inviteId === '') throw invalid('No invite named')
          const answer = await wg.bridge.answerInvite({ inviteId, accept: body.accept !== false })
          // Accepting brings the group's history and its roster, so both are settled before the
          // answer goes back — the pane must not be handed a group it cannot open, or one that
          // shows only itself in the member list.
          await wg.load()
          if (body.accept !== false && answer.workgroupId !== undefined) {
            await wg.syncRoster?.({ hubWorkgroupId: answer.workgroupId }).catch(() => {})
          }
          return ok(answer)
        }

        // ── read / unread ─────────────────────────────────────────────────────────
        // The unread cursor, from the pane that is reading.
        //
        // The Hub has held `read_cursors` and the `read.updated` frame since G4 started; what was
        // missing was any caller. Without one every group looked equally unread forever, which is
        // why the list showed none: a count nobody ever clears is a count nobody draws.
        case 'mark-read': {
          const workgroupId = String(body.workgroupId ?? '')
          if (workgroupId === '') throw invalid('No workgroup named')
          if (wg.roomOfHubGroup?.(workgroupId) === undefined) return fail('Unknown workgroup', 'bot/not-found')
          const seq = Number(body.seq ?? 0)
          const result = await wg.bridge.markRead({ workgroupId, seq })
          // The list is what draws the badge, so it is refreshed from the same answer rather than
          // left one poll behind.
          return ok({ workgroupId, lastReadSeq: result?.lastReadSeq ?? seq })
        }

        // ── attachments ───────────────────────────────────────────────────────────
        // The bytes come from a file the user picked, and are posted as bytes. No path is ever
        // sent: the Hub's endpoint takes `{name, mime, data}` and the storage key is the Hub's
        // (plan §13.2).
        case 'send-attachment': {
          const workgroupId = String(body.workgroupId ?? '')
          if (workgroupId === '') throw invalid('No workgroup named')
          const name = String(body.name ?? '')
          const mime = String(body.mime ?? '')
          const data = String(body.data ?? '')
          if (name === '' || data === '') throw invalid('Pick a file to send')
          const uploaded = await wg.bridge.sendAttachment({ workgroupId, name, mime, data })
          return ok({
            attachmentId: uploaded.attachment?.attachmentId,
            name: uploaded.attachment?.name,
            size: uploaded.attachment?.size,
            sha256: uploaded.attachment?.sha256,
            event: uploaded.event ?? null,
          })
        }

        case 'attachment-ticket': {
          const attachmentId = String(body.attachmentId ?? '')
          if (attachmentId === '') throw invalid('No attachment named')
          return ok(await wg.hub.attachmentTicket({ attachmentId }))
        }

        // The download itself, as base64, through the plugin's own route.
        //
        // The bytes are relayed rather than linked: a link would have to carry the ticket in a URL
        // the client then opens, and the ticket is short-lived and single-person. Relaying keeps one
        // authorization model (this route's session) over both halves of the file's life.
        case 'attachment-download': {
          const attachmentId = String(body.attachmentId ?? '')
          if (attachmentId === '') throw invalid('No attachment named')
          const bytes = await wg.bridge.downloadAttachment({ attachmentId })
          return ok({ attachmentId, data: bytes.toString('base64'), size: bytes.length })
        }

        case 'publish-endpoints': {
          // Refused while signed out, like every Hub write: there is no owner to publish under.
          const account = await wg.hub.restore()
          if (account === undefined) return fail('Sign in to the Hub first.', 'bot/not-signed-in')
          return ok({ endpoints: await wg.bridge.publishBotEndpoints() })
        }

        // ── tasks (G5) ────────────────────────────────────────────────────────
        //
        // The approval card, the decision, the run and the result. Every one of these is a thin
        // wrapper: `task-runner.js` owns what happens, and this file owns only the wire the panel
        // uses. None of them is reachable while signed out, because a task is a Hub record.
        // What waits for a decision, AND what this machine is already running.
        //
        // Both halves are needed: the running half is what lets the panel offer "start", "cancel" and
        // "the result" on the same card the person approved a moment ago. G4's audit found six
        // endpoints with no caller, so every one of these lists exists because a screen needs it.
        case 'task-requests': {
          await wg.load()
          return ok({
            requests: wg.taskRequests(),
            active: wg.taskActivity(),
          })
        }

        // B answering the card. `mode` is one of the three plan §10.1 ways to assign the work.
        case 'task-decide': {
          const taskId = String(body.taskId ?? '')
          if (taskId === '') throw invalid('No task named')
          const decision = body.decision === 'rejected' ? 'rejected' : 'granted'
          return ok(await wg.decideTask({
            taskId,
            decision,
            mode: typeof body.mode === 'string' ? body.mode : 'existingBot',
            botId: typeof body.botId === 'string' ? body.botId : undefined,
            workDir: typeof body.workDir === 'string' && body.workDir !== '' ? body.workDir : undefined,
            capabilities: Array.isArray(body.capabilities) ? body.capabilities : undefined,
            resources: Array.isArray(body.resources) ? body.resources : undefined,
            leaseMs: Number.isFinite(body.leaseMs) ? body.leaseMs : undefined,
          }))
        }

        // The run itself. Separate from `task-decide` because approving and executing are two
        // decisions: B may approve now and start a minute later, and the guard is what stops a start
        // that was never approved.
        case 'task-start': {
          const taskId = String(body.taskId ?? '')
          if (taskId === '') throw invalid('No task named')
          // Starting IS working: `runTask` delivers the approved request into the Task Session, it
          // does not merely move the record to RUNNING. The version that called `startTask` here left
          // a task reporting RUNNING with the Bot never asked to do anything.
          return ok(await wg.runTask({ taskId, ...(typeof body.text === 'string' ? { text: body.text } : {}) }))
        }

        // The end of a run: the result review and the completion together, because a person pressing
        // "done" means both. The runner walks RESULT_REVIEW → COMPLETED so the Hub's machine sees the
        // same two steps the plan names.
        case 'task-finish': {
          const taskId = String(body.taskId ?? '')
          if (taskId === '') throw invalid('No task named')
          return ok(await wg.finishTask({
            taskId,
            summary: typeof body.summary === 'string' ? body.summary : undefined,
            artifacts: Array.isArray(body.artifacts) ? body.artifacts : [],
          }))
        }

        case 'task-cancel': {
          const taskId = String(body.taskId ?? '')
          if (taskId === '') throw invalid('No task named')
          return ok(await wg.cancelTask({ taskId, reason: typeof body.reason === 'string' ? body.reason : undefined }))
        }

        // What this machine knows about one task: the Hub's record, plus the local ledger state so
        // the panel can say "approved here, waiting there" rather than one of the two.
        case 'task-state': {
          await wg.load()
          const taskId = String(body.taskId ?? '')
          if (taskId === '') throw invalid('No task named')
          const local = wg.taskOf(taskId)
          const remote = await wg.hub.task(taskId).catch(error => ({ error: error?.message ?? String(error), code: error?.code }))
          return ok({
            taskId,
            local: local === undefined ? null : {
              state: local.state,
              version: local.version,
              botId: local.botId,
              expiresAt: local.expiresAt,
              live: wg.liveTask(taskId) !== undefined,
            },
            remote: remote?.error === undefined ? remote.task : { error: remote.error, code: remote.code },
          })
        }

        // The tasks this person must answer, and the ones they asked for, straight from the Hub.
        case 'task-list': {
          const role = body.role === 'owner' || body.role === 'requester' ? body.role : undefined
          return ok({
            tasks: await wg.hub.tasks({
              workgroupId: typeof body.workgroupId === 'string' ? body.workgroupId : undefined,
              role,
            }),
          })
        }

        // A asking B for work. The envelope is signed here, by the Hub client's own signer, so this
        // endpoint never holds a key.
        case 'task-request': {
          const workgroupId = String(body.workgroupId ?? '')
          const targetUserId = String(body.targetUserId ?? '')
          if (workgroupId === '') throw invalid('No workgroup named')
          if (targetUserId === '') throw invalid('Say who the task is for')
          return ok(await wg.requestTask({
            workgroupId,
            targetUserId,
            targetEndpointId: typeof body.targetEndpointId === 'string' ? body.targetEndpointId : undefined,
            title: String(body.title ?? ''),
            resources: Array.isArray(body.resources) ? body.resources : undefined,
            capabilities: Array.isArray(body.capabilities) ? body.capabilities : undefined,
            ttlMs: Number.isFinite(body.ttlMs) ? body.ttlMs : undefined,
          }))
        }

        case 'task-artifacts': {
          const taskId = String(body.taskId ?? '')
          if (taskId === '') throw invalid('No task named')
          return ok({ artifacts: await wg.hub.taskArtifacts({ taskId }) })
        }

        case 'artifact-download': {
          const artifactId = String(body.artifactId ?? '')
          if (artifactId === '') throw invalid('No artifact named')
          const bytes = await wg.hub.downloadArtifact({ artifactId })
          return ok({ artifactId, size: bytes.length, data: bytes.toString('base64') })
        }

        // ── the coordinator lease ───────────────────────────────────────────────
        // Plan §9.5: one scheduler per group. The panel needs to know whether THIS device is it
        // before it offers to start a round.
        case 'group-lease': {
          const workgroupId = String(body.workgroupId ?? '')
          if (workgroupId === '') throw invalid('No workgroup named')
          return ok(await wg.hub.lease({ workgroupId }))
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
