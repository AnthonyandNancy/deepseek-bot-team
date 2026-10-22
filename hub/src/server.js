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
import { createHttpHandler, created, noContent } from './http.js'
import { createWsService } from './ws.js'
import { bearerToken } from './auth/tokens.js'
import { HubError } from './errors.js'

export function createHub({ config = loadConfig(), logger = createLogger(), now = () => Date.now(), database } = {}) {
  const db = database ?? openDatabaseIn(config.dataDir)
  const audit = createAudit(db)
  const limiters = createLimiters({ now })
  const auth = createAuthService({ db, audit, limiters, config, now })
  const recovery = createRecoveryService({ db, audit, limiters, config, now })

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

  wsService = createWsService({ server, auth, devices, logger, now })

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
    ws: wsService,

    async listen() {
      // Plaintext must not be reachable from another machine. The config refuses to start
      // without an explicit opt-in; this refuses the one remaining way to leak, a bind
      // address that is not loopback.
      const host = config.insecureLoopbackOnly && !isLoopback(config.host) ? '127.0.0.1' : config.host
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, host, () => {
          server.off('error', reject)
          resolve()
        })
      })
      const address = server.address()
      const scheme = config.tls === null ? 'http' : 'https'
      logger.info('hub.listening', { scheme, host: address.address, port: address.port, tls: config.tls !== null })
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
