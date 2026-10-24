// Assembles one Hub from a config: database, services, router, HTTP server, WSS.
//
// Everything is created here and injected, so a test builds the same object the process runs
// and drives it over a real socket — no mocks of the Hub's own guts.
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isLoopback, loadConfig } from './config.js'
import { openDatabaseIn } from './db/index.js'
import { createAudit } from './audit.js'
import { createLogger } from './log.js'
import { createLimiters } from './auth/limiter.js'
import { createAuthService } from './auth/service.js'
import { createRecoveryService } from './auth/recovery.js'
import { createDeviceService } from './devices/service.js'
import { createRouter } from './router.js'
import { bytes, createHttpHandler, created, noContent } from './http.js'
import { createWsService } from './ws.js'
import { bearerToken } from './auth/tokens.js'
import { HubError, notFound } from './errors.js'
import { createWorkgroupService } from './workgroups/service.js'
import { createEventService } from './events/service.js'
import { createBotEndpointService } from './endpoints/service.js'
import { createAttachmentService, MAX_ATTACHMENT_BYTES } from './attachments/service.js'
import { createTaskService } from './tasks/service.js'
import { createArtifactService, MAX_ARTIFACT_BYTES } from './artifacts/service.js'
import { createLeaseService } from './leases/service.js'

export function createHub({ config = loadConfig(), logger = createLogger(), now = () => Date.now(), database } = {}) {
  const db = database ?? openDatabaseIn(config.dataDir)
  const audit = createAudit(db)
  const limiters = createLimiters({ now })
  const auth = createAuthService({ db, audit, limiters, config, now })
  const recovery = createRecoveryService({ db, audit, limiters, config, now })
  // The event log is created first: the group service appends a `member.changed` event when a
  // membership changes, so both share one owner of `seq` and one ordering.
  const eventsService = createEventService({ db, audit, now })
  // A membership change nudges the live sockets, but is not a group event: see the note in
  // workgroups/service.js. `wsService` is assigned further down, so the hook reads it lazily.
  const workgroups = createWorkgroupService({
    db, audit, now,
    onMembershipChanged: payload => wsService?.notifyMembership?.(payload),
  })
  const endpoints = createBotEndpointService({ db, audit, now })
  // G5: the task record, the artifacts a task produces and the coordinator fence. Created after the
  // event service because every task transition writes a group event, and before the socket service
  // because the socket is where a `task.request` arrives.
  const tasks = createTaskService({
    db, audit, now,
    workgroups,
    events: eventsService,
    onTaskEvent: payload => wsService?.broadcast?.(payload.workgroupId, payload.event),
  })
  const artifacts = createArtifactService({ db, audit, dataDir: config.dataDir, now })
  const leases = createLeaseService({ db, audit, now, workgroups })
  // Attachments live beside the database, in the data directory this Hub already owns. Nothing
  // outside that directory is ever read or written.
  const attachments = createAttachmentService({ db, audit, dataDir: config.dataDir, now })

  // The device service needs to close sockets when a device is revoked, and the WSS service
  // needs the device service to validate a handshake — a cycle, resolved by a hook the
  // server fills in once both exist.
  let wsService
  const devices = createDeviceService({
    db, audit, auth, now,
    onRevoked: (deviceId) => { wsService?.closeDevice(deviceId) },
  })

  const router = createRouter()
  const token = ({ headers }) => bearerToken(headers.authorization)

  router.post('/v1/auth/register', async ({ body, ip }) => created(await auth.register({ phone: body.phone, password: body.password, ip })))
  router.post('/v1/auth/login', ({ body, ip }) => auth.login({ phone: body.phone, password: body.password, ip }))
  router.post('/v1/auth/refresh', ({ body }) => auth.refresh({ refreshToken: body.refreshToken }))
  router.post('/v1/auth/logout', async ({ headers }) => { await auth.logout({ accessToken: bearerToken(headers.authorization) }); return noContent() })
  router.get('/v1/auth/me', ({ headers }) => auth.me({ accessToken: bearerToken(headers.authorization) }))

  // Password recovery. Layer 2 (signed out, holding a code) and layer 3 (operator reset) are
  // different trusts: the operator path is deliberately not an endpoint, so the only way to reach
  // it is the command line with the database file in hand.
  router.post('/v1/auth/recover', ({ body, ip }) => recovery.recoverWithCode({
    phone: body.phone, code: body.code, password: body.password, ip,
  }))
  router.post('/v1/auth/password', ({ body, headers }) => recovery.changePassword({
    accessToken: bearerToken(headers.authorization),
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
    sessionOf: auth.sessionOf,
  }))
  router.get('/v1/auth/recovery-code', ({ headers }) => recovery.recoveryState({
    accessToken: bearerToken(headers.authorization), sessionOf: auth.sessionOf,
  }))
  router.post('/v1/auth/recovery-code', async ({ headers }) => created(await recovery.createRecoveryCode({
    accessToken: bearerToken(headers.authorization), sessionOf: auth.sessionOf,
  })))

  router.post('/v1/devices/challenge', ({ body, headers }) => devices.challenge({ accessToken: bearerToken(headers.authorization), publicKey: body.publicKey }))
  router.post('/v1/devices/register', ({ body, headers }) => devices.register({
    accessToken: bearerToken(headers.authorization),
    challengeId: body.challengeId,
    signature: body.signature,
    name: body.name,
    platform: body.platform,
  }))
  router.get('/v1/devices', ({ headers }) => devices.list({ accessToken: bearerToken(headers.authorization) }))
  router.post('/v1/devices/:id/revoke', ({ params, headers }) => devices.revoke({ accessToken: bearerToken(headers.authorization), deviceId: params.id }))

  // Unauthenticated liveness check. It reports the transport so a client can tell "the Hub is
  // up but on plaintext" from "the Hub is down", which are different problems to fix.
  router.get('/v1/health', () => ({ ok: true, tls: config.tls !== null, service: 'workgroup-ai-hub' }))

  // Every route below resolves the caller from the bearer token here, in one expression, so
  // there is no handler that can forget to: `auth.sessionOf` throws for anything that is not a
  // live session, and the HTTP layer turns that into a 401.
  const caller = headers => auth.sessionOf(bearerToken(headers.authorization))
  const queryOf = req => new URL(req.url ?? '/', 'http://hub.invalid').searchParams

  // ── workgroups ────────────────────────────────────────────────────────────────────
  router.post('/v1/workgroups', async ({ body, headers }) => {
    const session = caller(headers)
    return created(await workgroups.create({
      userId: session.user_id, deviceId: session.device_id, body, endpointService: endpoints,
    }))
  })
  router.get('/v1/workgroups', async ({ headers }) => workgroups.list({ userId: caller(headers).user_id }))
  router.get('/v1/workgroups/:id', async ({ params, headers }) => {
    const session = caller(headers)
    const group = await workgroups.get({ userId: session.user_id, workgroupId: params.id })
    // Presence is added here rather than stored: the socket registry already knows it exactly, and a
    // column would need a writer on every connect and disconnect to stay true.
    const online = wsService?.onlineUsers((group.members ?? []).map(member => member.userId)) ?? new Set()
    return {
      ...group,
      // The caller's own role in the group, so a client can decide what to offer before it tries.
      myRole: group.role ?? 'member',
      members: (group.members ?? []).map(member => ({
        ...member,
        // Only a person has a socket. A Bot endpoint is online when its owner's device is.
        ...(member.userId === undefined ? {} : { online: online.has(member.userId) }),
        // WHOSE BOT THIS IS, answered where the answer is known. Read from the connection, not from
        // the request: a member cannot claim somebody else's Bot is theirs by sending a flag.
        ...(member.ownerUserId === undefined ? {} : { ownerIsYou: member.ownerUserId === session.user_id }),
      })),
    }
  })
  // A group's own settings: the name and the notice, which are the two the Hub stores and every
  // machine copies. POST rather than PATCH, like every other write here.
  router.post('/v1/workgroups/:id/settings', async ({ params, body, headers }) => {
    const session = caller(headers)
    return workgroups.updateSettings({
      userId: session.user_id, deviceId: session.device_id, workgroupId: params.id, body,
    })
  })
  router.post('/v1/workgroups/:id/members', async ({ params, body, headers }) => {
    const session = caller(headers)
    return created(await workgroups.addEndpointMember({
      userId: session.user_id, deviceId: session.device_id, workgroupId: params.id,
      endpointId: String(body.endpointId ?? ''), endpointService: endpoints,
    }))
  })
  router.post('/v1/workgroups/:id/members/:memberId/leave', async ({ params, headers }) => {
    const session = caller(headers)
    return workgroups.removeMember({
      userId: session.user_id, deviceId: session.device_id, workgroupId: params.id, membershipId: params.memberId,
    })
  })
  // Deleting a group, by its owner, for everyone. Without this the client's 「删除工作群」 only
  // removed the local room, so the group came back on the next start.
  //
  // POST, not DELETE: `createRouter` has `get` and `post` only, and every other write in this Hub is
  // a POST with the action in the path.
  router.post('/v1/workgroups/:id/delete', async ({ params, headers }) => {
    const session = caller(headers)
    return workgroups.dissolve({ userId: session.user_id, deviceId: session.device_id, workgroupId: params.id })
  })
  router.post('/v1/workgroups/:id/invites', async ({ params, body, headers }) => {
    const session = caller(headers)
    return created(await workgroups.invite({
      userId: session.user_id, deviceId: session.device_id, workgroupId: params.id, body,
    }))
  })
  router.get('/v1/invites', async ({ headers }) => workgroups.invitesFor({ userId: caller(headers).user_id }))
  router.post('/v1/invites/:id/accept', async ({ params, headers }) => {
    const session = caller(headers)
    return workgroups.answerInvite({ userId: session.user_id, deviceId: session.device_id, inviteId: params.id, accept: true })
  })
  router.post('/v1/invites/:id/decline', async ({ params, headers }) => {
    const session = caller(headers)
    return workgroups.answerInvite({ userId: session.user_id, deviceId: session.device_id, inviteId: params.id, accept: false })
  })

  // ── events ────────────────────────────────────────────────────────────────────────
  // The pull a reconnecting client uses. `afterSeq` is the cursor; `hasMore` says whether a long
  // catch-up is paged rather than silently truncated.
  router.get('/v1/workgroups/:id/events', async ({ params, headers, req }) => {
    const session = caller(headers)
    // Not a member reads as "no such group": a member check and a 404 are the same answer, so the
    // endpoint cannot be used to probe which group ids exist.
    if (!workgroups.isMember(params.id, session.user_id)) throw notFound('workgroup/not-found', 'No such workgroup.')
    const query = queryOf(req)
    const limit = query.get('limit') === null ? undefined : Number(query.get('limit'))
    return eventsService.pull({ workgroupId: params.id, afterSeq: Number(query.get('afterSeq') ?? 0), limit })
  })
  router.post('/v1/workgroups/:id/read', async ({ params, body, headers }) => {
    const session = caller(headers)
    return workgroups.markRead({ userId: session.user_id, workgroupId: params.id, seq: Number(body.seq ?? 0), events })
  })

  // ── bot endpoints ─────────────────────────────────────────────────────────────────
  router.get('/v1/bot-endpoints', async ({ headers, req }) => {
    const session = caller(headers)
    return endpoints.list({ userId: session.user_id, workgroupId: queryOf(req).get('workgroupId') ?? undefined })
  })
  // A publish carries the Bot's appearance, and an appearance may be a photo the owner picked — a
  // data URL capped at 200 000 characters by `cleanAvatar`. The default 64 KiB body cap is smaller
  // than that, so this route raises it; nothing else about the route changes.
  router.post('/v1/bot-endpoints', async ({ body, headers }) => {
    const session = caller(headers)
    return created(await endpoints.publish({ userId: session.user_id, deviceId: session.device_id, body }))
  }, { maxBodyBytes: 256 * 1024 })
  router.post('/v1/bot-endpoints/:id/revoke', async ({ params, headers }) => {
    const session = caller(headers)
    return endpoints.revoke({ userId: session.user_id, deviceId: session.device_id, endpointId: params.id })
  })

  // ── attachments ───────────────────────────────────────────────────────────────────
  // The one route with a larger body cap: the body IS the file. `data` is base64, so the cap is
  // the decoded limit plus the 4/3 base64 costs, plus room for the JSON around it.
  const UPLOAD_BODY_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 16 * 1024
  router.post('/v1/workgroups/:id/attachments', async ({ params, body, headers }) => {
    const session = caller(headers)
    const result = await attachments.upload({
      userId: session.user_id, deviceId: session.device_id, workgroupId: params.id, body,
      isMember: workgroups.isMember,
    })
    // The upload announces itself in the group log, so a client sees the file without polling a
    // second endpoint. The event carries the attachment's metadata — never a path.
    const appended = eventsService.append({
      workgroupId: params.id,
      type: 'chat.message',
      sender: { userId: session.user_id, deviceId: session.device_id },
      payload: { text: '', attachments: [result.attachment] },
    })
    wsService?.broadcast(params.id, appended.event, { exceptDeviceId: session.device_id })
    return created({ ...result, event: appended.event })
  }, { maxBodyBytes: UPLOAD_BODY_BYTES })
  router.get('/v1/workgroups/:id/attachments', async ({ params, headers }) => {
    const session = caller(headers)
    return attachments.list({ userId: session.user_id, workgroupId: params.id, isMember: workgroups.isMember })
  })
  router.post('/v1/attachments/:id/ticket', async ({ params, headers }) => {
    const session = caller(headers)
    return attachments.issueTicket({ userId: session.user_id, attachmentId: params.id, isMember: workgroups.isMember })
  })
  router.get('/v1/attachments/:id/download', async ({ params, headers, req }) => {
    const session = caller(headers)
    const result = await attachments.download({
      userId: session.user_id, attachmentId: params.id, ticketId: queryOf(req).get('ticket'), isMember: workgroups.isMember,
    })
    return bytes(result.bytes, {
      'content-type': result.attachment.mime,
      'content-length': String(result.bytes.length),
      // A download is a file, not a page: `attachment` plus `nosniff` is what stops a stored text
      // file being rendered as markup by a browser that trusted its declared type.
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.attachment.name)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    })
  })

  // ── tasks (§13.1) ─────────────────────────────────────────────────────────────────
  // The plan lists exactly two task endpoints: `decision` and `revoke`. A task is *requested* over
  // WSS (`task.request`), because a request has to survive B being offline and G4's outbox already
  // does that — see docs/workgroup/g5/DESIGN-CHANNEL-AND-SEQ.md. The read below is this phase's
  // addition: without it a client would fold the whole event log to draw a task panel.
  router.get('/v1/tasks', ({ headers, req }) => {
    const session = caller(headers)
    const query = queryOf(req)
    const workgroupId = query.get('workgroupId') ?? undefined
    const role = query.get('role') ?? 'all'
    const limit = query.get('limit') === null ? undefined : Number(query.get('limit'))
    return tasks.list({
      userId: session.user_id, workgroupId, role, limit,
      isMember: workgroups.isMember,
    })
  })
  router.get('/v1/tasks/:id', ({ params, headers }) => {
    const session = caller(headers)
    return tasks.get({ userId: session.user_id, taskId: params.id })
  })
  router.post('/v1/tasks/:id/decision', async ({ params, body, headers }) => {
    const session = caller(headers)
    // The device is the authenticated one, never `body.deviceId`: gate 3 asks that the issuing
    // device be unambiguous, and a value a caller can type is not evidence.
    const result = await tasks.decide({ userId: session.user_id, deviceId: session.device_id, taskId: params.id, body })
    return result
  })
  router.post('/v1/tasks/:id/revoke', async ({ params, body, headers }) => {
    const session = caller(headers)
    const result = await tasks.revoke({ userId: session.user_id, deviceId: session.device_id, taskId: params.id, body })
    // Revoking a grant withdraws whatever was already shared: leaving an artifact readable after the
    // approval behind it is gone would make the ACL a decoration.
    for (const artifact of artifacts.revokeForTask(params.id)) {
      const appended = eventsService.append({
        workgroupId: result.task.workgroupId,
        type: 'artifact.revoked',
        sender: { userId: session.user_id, deviceId: session.device_id },
        payload: { taskId: params.id, artifactId: artifact.artifactId },
      })
      wsService?.broadcast(result.task.workgroupId, appended.event, { exceptDeviceId: session.device_id })
    }
    return result
  })

  // ── artifacts (§13.1) ────────────────────────────────────────────────────────────
  // Same body shape as the attachment relay (bytes as base64) and the same larger cap, because the
  // body IS the file. What differs is who may do it and who may read it back.
  const ARTIFACT_BODY_BYTES = Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4 + 16 * 1024
  router.post('/v1/artifacts/uploads', async ({ body, headers }) => {
    const session = caller(headers)
    const result = await artifacts.upload({
      userId: session.user_id, deviceId: session.device_id, body, isMember: workgroups.isMember,
    })
    // The group learns a result exists through the same log as everything else, so a requester who
    // was offline while it was produced sees it on reconnect.
    const appended = eventsService.append({
      workgroupId: result.artifact.workgroupId,
      type: 'artifact.available',
      sender: { userId: session.user_id, deviceId: session.device_id },
      payload: {
        taskId: result.artifact.taskId,
        artifactId: result.artifact.artifactId,
        name: result.artifact.name,
        mime: result.artifact.mime,
        size: result.artifact.size,
        hash: result.artifact.hash,
      },
    })
    wsService?.broadcast(result.artifact.workgroupId, appended.event, { exceptDeviceId: session.device_id })
    return created({ ...result, event: appended.event })
  }, { maxBodyBytes: ARTIFACT_BODY_BYTES })
  router.get('/v1/tasks/:id/artifacts', ({ params, headers }) => {
    const session = caller(headers)
    return artifacts.listForTask({ userId: session.user_id, taskId: params.id, isMember: workgroups.isMember })
  })
  router.get('/v1/artifacts/:id/download', async ({ params, headers }) => {
    const session = caller(headers)
    const result = await artifacts.download({ userId: session.user_id, artifactId: params.id, isMember: workgroups.isMember })
    return bytes(result.bytes, {
      'content-type': result.artifact.mime,
      'content-length': String(result.bytes.length),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.artifact.name)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    })
  })

  // ── the coordinator lease (§9.5) ────────────────────────────────────────────────
  // The plan gives the semantics (`coordinatorEpoch / leaseUntil`) and no route. These are the
  // addition this phase records in gates.md: without a way to acquire a lease the fence could only
  // be enforced against a value the client made up.
  router.get('/v1/workgroups/:id/lease', ({ params, headers }) => {
    const session = caller(headers)
    if (!workgroups.isMember(params.id, session.user_id)) throw notFound('workgroup/not-found', 'No such workgroup.')
    return leases.current({ workgroupId: params.id })
  })
  router.post('/v1/workgroups/:id/lease', ({ params, body, headers }) => {
    const session = caller(headers)
    return leases.acquire({
      userId: session.user_id, deviceId: session.device_id, workgroupId: params.id,
      leaseMs: body?.leaseMs === undefined ? undefined : Number(body.leaseMs),
    })
  })
  router.post('/v1/workgroups/:id/lease/release', ({ params, headers }) => {
    const session = caller(headers)
    return leases.release({ userId: session.user_id, deviceId: session.device_id, workgroupId: params.id })
  })

  const handle = createHttpHandler({
    router,
    logger,
    allowInsecureLoopbackOnly: config.insecureLoopbackOnly,
    now,
  })

  const server = config.tls === null
    ? createHttpServer(handle)
    : createHttpsServer({
      cert: readFileSync(config.tls.cert),
      key: readFileSync(config.tls.key),
    }, handle)

  wsService = createWsService({
    server, auth, devices, logger, workgroups, events: eventsService, now,
    tasks, artifacts, leases,
  })

  return {
    config,
    db,
    server,
    auth,
    recovery,
    devices,
    audit,
    limiters,
    router,
    workgroups,
    events: eventsService,
    endpoints,
    attachments,
    tasks,
    artifacts,
    leases,
    ws: wsService,

    async listen() {
      // The address is decided ONCE, in config.js, which refuses a plaintext bind outside loopback
      // unless the operator set HUB_ALLOW_PLAINTEXT_LAN. This used to silently rewrite such a bind
      // to 127.0.0.1, which made HUB_HOST=0.0.0.0 look accepted while the Hub listened on loopback
      // only — the local network could not reach it and nothing said so.
      //
      // The check below is a belt-and-braces assertion, not a policy: reaching it means config and
      // this line disagree, so it fails loudly instead of quietly binding somewhere else.
      const host = config.host
      if (config.insecureLoopbackOnly && !isLoopback(host)) {
        throw new Error(`ds-hub: refusing to bind ${host} in plaintext; config.js should have refused first`)
      }
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, host, () => {
          server.off('error', reject)
          resolve()
        })
      })
      const address = server.address()
      const scheme = config.tls === null ? 'http' : 'https'
      // Which database this Hub is actually serving, printed on every start. Without it, "signed in
      // but the refresh token is not valid" is indistinguishable from a real credential problem,
      // when the usual cause is a second Hub started from a different directory and therefore
      // holding a different, empty file.
      logger.info('hub.listening', {
        scheme, host: address.address, port: address.port, tls: config.tls !== null, dataDir: config.dataDir,
      })
      // Said out loud, once, when the operator has accepted plaintext beyond loopback: this is the
      // state in which a password typed on one machine crosses the local network in the clear.
      if (config.tls === null && !isLoopback(address.address)) {
        logger.info('hub.plaintext-on-network', {
          host: address.address,
          detail: 'passwords cross the network in the clear; HUB_ALLOW_PLAINTEXT_LAN is set',
        })
      }
      return { scheme, host: address.address, port: address.port, url: `${scheme}://${address.address}:${address.port}` }
    },

    async close() {
      await wsService.close()
      await new Promise((resolve) => {
        server.close(() => resolve())
        // A keep-alive connection would otherwise hold the close open forever.
        server.closeAllConnections?.()
      })
      if (database === undefined) db.close()
    },
  }
}

export { loadConfig, HubError }
