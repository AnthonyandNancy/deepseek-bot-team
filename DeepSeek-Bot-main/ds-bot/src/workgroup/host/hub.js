// The Hub account: talking to the Hub, and holding what a login produces.
//
// Rules this module is responsible for, because they are easy to break from the outside:
//   * the password exists only for the duration of one request — it is never stored, cached,
//     logged, or put in state.json;
//   * the refresh token and the device private key live in the store (hub-store.js) and never
//     leave this module, so the settings page cannot read them;
//   * the access token lives in this module's memory only, so a restart re-mints it;
//   * nothing here touches the original Bot team. Every exported call is inert while signed
//     out, which is what keeps the local Chief/Bots/private chats/local groups working with no
//     Hub at all.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { createHubStore } from './hub-store.js'

export const REQUEST_TIMEOUT_MS = 15000

const trimBase = value => String(value ?? '').trim().replace(/\/+$/, '')

// A refusal from the Hub, carrying its code so the page can translate it. A network failure is a
// different kind of problem and gets its own code, because "wrong password" and "the Hub is not
// running" must never look the same to a person.
export class HubRequestError extends Error {
  constructor(message, { code, status } = {}) {
    super(message)
    this.name = 'HubRequestError'
    this.code = code ?? 'hub/network'
    this.status = status
  }
}

// Why a request never got an answer, in words a person can act on.
//
// Node's `fetch` reports every transport failure as the single string "fetch failed", hiding the
// real cause in `error.cause` — which the user saw verbatim on the account page and could do
// nothing with. The three causes that actually happen here are a Hub that is not running, a
// certificate this machine does not trust, and a name that does not resolve. Each has a different
// fix, so each gets its own sentence.
export function describeNetworkError(error, base) {
  if (error?.name === 'AbortError') {
    return `The Hub at ${base} did not answer in time. Check that it is running and reachable.`
  }
  const code = error?.cause?.code ?? error?.code ?? ''
  const reason = String(error?.cause?.message ?? error?.message ?? error ?? '')

  // Nothing listening: either the Hub was never started, or the port is wrong.
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(reason)) {
    return `Nothing is listening at ${base}. Start the Hub first (cd hub && npm start), then try again.`
  }
  // A self-signed certificate is the normal case for a local Hub, and Node refuses it by design.
  // Saying "fetch failed" here would send someone looking for a network problem.
  if (/SELF_SIGNED|DEPTH_ZERO|UNABLE_TO_VERIFY|CERT_|ERR_TLS/.test(code) || /certificate/i.test(reason)) {
    return `The Hub at ${base} presented a certificate this machine does not trust. `
      + 'Either trust its certificate, or start the Hub with HUB_ALLOW_INSECURE_LOCALHOST=1 for loopback-only plaintext.'
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo/.test(reason)) {
    return `The Hub address ${base} could not be resolved. Check the host name.`
  }
  if (code === 'ECONNRESET' || /socket hang up/i.test(reason)) {
    return `The connection to ${base} was closed before the Hub answered. Check that the Hub is still running.`
  }
  return `Could not reach the Hub at ${base}. Check the address and that the Hub is running.`
}

// The public half of an Ed25519 key, as SPKI PEM. Derived from the private key so the two can
// never disagree about which pair is in use.
export const publicFromPrivate = privateKeyPem =>
  createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' })

// What the Hub verifies for a device registration: `<challengeId>.<nonce>`.
export const signChallenge = (privateKeyPem, challengeId, nonce) =>
  sign(null, Buffer.from(`${challengeId}.${nonce}`), createPrivateKey(privateKeyPem)).toString('base64')

export function createHubClient({ store, logger, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  // Memory only. `undefined` means "no usable access token right now".
  let accessToken
  let accessExpiresAt
  // The non-secret half of the account, which the client view may show.
  let account

  const isLoggedIn = () => accessToken !== undefined && (accessExpiresAt ?? Infinity) > now()

  // Every request names its own base address. The account's address is only a fallback for the
  // calls that happen after a login, and passing it explicitly is what lets a login work before
  // `account` exists.
  const call = async (base, path, { method = 'POST', body, token, timeoutMs = REQUEST_TIMEOUT_MS } = {}) => {
    if (base === '') throw new HubRequestError('This device has no Hub address yet.', { code: 'hub/no-address' })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      throw new HubRequestError(describeNetworkError(error, base), { code: 'hub/unreachable' })
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    let parsed
    try { parsed = text.length === 0 ? undefined : JSON.parse(text) } catch { parsed = undefined }
    if (!response.ok) {
      const message = parsed?.error?.message ?? `The Hub refused this request (HTTP ${response.status}).`
      throw new HubRequestError(message, { code: parsed?.error?.code ?? `hub/http-${response.status}`, status: response.status })
    }
    return parsed
  }

  const address = () => trimBase(account?.baseUrl)

  // Refreshes the access token from the stored refresh token, so no caller has to think about
  // lifetime. The Hub rotates both halves, so the stored refresh token is replaced at once:
  // keeping the old one would make the next restart fail to sign in.
  const ensureAccess = async () => {
    if (isLoggedIn()) return accessToken
    const stored = await store.load()
    if (stored === undefined) throw new HubRequestError('This device is not signed in to the Hub.', { code: 'hub/not-signed-in' })
    const base = trimBase(stored.baseUrl)
    const refreshed = await call(base, '/v1/auth/refresh', { body: { refreshToken: stored.refreshToken } })
    accessToken = refreshed.accessToken
    accessExpiresAt = Date.parse(refreshed.accessExpiresAt)
    account = {
      baseUrl: base, hubUserId: stored.hubUserId, phoneMasked: stored.phoneMasked, deviceId: stored.deviceId,
    }
    await store.save({ ...stored, refreshToken: refreshed.refreshToken })
    return accessToken
  }

  // The name a person will recognise in their device list.
  const describeDevice = () => {
    let name = 'This device'
    const host = process.env.COMPUTERNAME ?? process.env.HOSTNAME
    if (typeof host === 'string' && host.trim() !== '') name = host.trim()
    return { name, platform: process.platform }
  }

  // Challenge, sign, register: the three steps the Hub requires before a key counts as this
  // machine's.
  const registerThisDevice = async (base, token, privateKeyPem) => {
    const publicKey = publicFromPrivate(privateKeyPem)
    const challenge = await call(base, '/v1/devices/challenge', { body: { publicKey }, token })
    const signature = signChallenge(privateKeyPem, challenge.challengeId, challenge.nonce)
    const registered = await call(base, '/v1/devices/register', {
      body: { challengeId: challenge.challengeId, signature, ...describeDevice() },
      token,
    })
    return registered.deviceId
  }

  const clearMemory = () => {
    accessToken = undefined
    accessExpiresAt = undefined
    account = undefined
  }

  const client = {
    get account() {
      return account === undefined ? undefined : { ...account, backend: store.backend }
    },
    // Whether the page should show the signed-in view. A stored refresh token counts: the
    // access token is meant to be absent after a restart.
    get loggedIn() {
      return isLoggedIn() || account?.deviceId !== undefined
    },

    // ── session restore ───────────────────────────────────────────────────────────
    // Called when the settings page opens. Restores the non-secret account facts from the store
    // so the page renders "signed in as +86****8000" without a Hub round trip: opening settings
    // while offline must not hang.
    async restore() {
      const stored = await store.load()
      if (stored === undefined) {
        clearMemory()
        return undefined
      }
      account = {
        baseUrl: stored.baseUrl,
        hubUserId: stored.hubUserId,
        phoneMasked: stored.phoneMasked,
        deviceId: stored.deviceId,
        backend: store.backend,
      }
      return client.account
    },

    // ── register / login ──────────────────────────────────────────────────────────
    // One path for both: the page's two buttons differ only in which endpoint they call. A fresh
    // key pair is generated per sign-in, so a key from an older install is never silently reused.
    async authenticate({ baseUrl, phone, password, mode = 'login' }) {
      const base = trimBase(baseUrl)
      if (base === '') throw new HubRequestError('Enter the Hub address first.', { code: 'hub/no-address' })
      const path = mode === 'register' ? '/v1/auth/register' : '/v1/auth/login'
      const result = await call(base, path, { body: { phone, password } })
      // `password` is not referenced past this line. Nothing below copies it into a stored object.
      clearMemory()
      accessToken = result.accessToken
      accessExpiresAt = Date.parse(result.accessExpiresAt)
      account = { baseUrl: base, hubUserId: result.hubUserId, phoneMasked: result.phoneMasked, deviceId: undefined }

      const privateKeyPem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
      const deviceId = await registerThisDevice(base, accessToken, privateKeyPem)
      account = { ...account, deviceId }
      await store.save({
        baseUrl: base,
        hubUserId: result.hubUserId,
        phoneMasked: result.phoneMasked,
        deviceId,
        refreshToken: result.refreshToken,
        privateKeyPem,
      })
      logger?.info?.('ds-bot: signed in to the Hub as %s', result.phoneMasked)
      return client.account
    },

    async logout() {
      const token = accessToken
      const base = address()
      clearMemory()
      // Best effort: a Hub that cannot be reached must not stop the local sign-out, or a user
      // could be stuck signed in with no way out.
      if (token !== undefined) await call(base, '/v1/auth/logout', { token }).catch(() => {})
      await store.clear()
      return true
    },

    // ── what the page shows ───────────────────────────────────────────────────────
    async devices() {
      const token = await ensureAccess()
      const result = await call(address(), '/v1/devices', { method: 'GET', token })
      return result.devices ?? []
    },

    async me() {
      const token = await ensureAccess()
      return call(address(), '/v1/auth/me', { method: 'GET', token })
    },

    async revokeDevice(deviceId) {
      const token = await ensureAccess()
      await call(address(), `/v1/devices/${encodeURIComponent(deviceId)}/revoke`, { token })
      // Revoking this very machine signs it out, so the local record has to go too.
      if (deviceId === account?.deviceId) await client.forget()
      return true
    },

    // Drops the local record without calling the Hub: used when the Hub itself said this device
    // is gone, where a logout call would only fail.
    async forget() {
      clearMemory()
      await store.clear()
    },

    // ── password recovery ─────────────────────────────────────────────────────────
    // These three exist because the account is otherwise unrecoverable: there is no SMS and no
    // email, so the only thing that can prove ownership is a code the user already holds.
    //
    // `newPassword` is used for one request and never stored, exactly like `password` in
    // authenticate(); the code is likewise only forwarded.

    // Signed out, holding a code. Returns a fresh session, so the machine doing the recovery —
    // usually a new one — ends up signed in.
    async recover({ baseUrl, phone, code, newPassword }) {
      const base = trimBase(baseUrl)
      if (base === '') throw new HubRequestError('Enter the Hub address first.', { code: 'hub/no-address' })
      const result = await call(base, '/v1/auth/recover', { body: { phone, code, password: newPassword } })
      // A recovery revokes every device, including any this machine had, so a fresh key pair and a
      // device registration are required before the session is usable for a socket.
      clearMemory()
      accessToken = result.accessToken
      accessExpiresAt = Date.parse(result.accessExpiresAt)
      account = { baseUrl: base, hubUserId: result.hubUserId, phoneMasked: result.phoneMasked, deviceId: undefined }
      const privateKeyPem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
      const deviceId = await registerThisDevice(base, accessToken, privateKeyPem)
      account = { ...account, deviceId }
      await store.save({
        baseUrl: base,
        hubUserId: result.hubUserId,
        phoneMasked: result.phoneMasked,
        deviceId,
        refreshToken: result.refreshToken,
        privateKeyPem,
      })
      logger?.info?.('ds-bot: recovered the Hub account %s', result.phoneMasked)
      return client.account
    },

    // Signed in. Requires the current password, then replaces the stored refresh token because
    // every other session was just ended.
    async changePassword({ currentPassword, newPassword }) {
      const token = await ensureAccess()
      const base = address()
      const stored = await store.load()
      const result = await call(base, '/v1/auth/password', { body: { currentPassword, newPassword }, token })
      accessToken = result.accessToken
      accessExpiresAt = Date.parse(result.accessExpiresAt)
      if (stored !== undefined) await store.save({ ...stored, refreshToken: result.refreshToken })
      logger?.info?.('ds-bot: changed the Hub password')
      return true
    },

    // Whether a recovery code exists. The code itself can never be read back.
    async recoveryState() {
      const token = await ensureAccess()
      return call(address(), '/v1/auth/recovery-code', { method: 'GET', token })
    },

    // Creates a new code. This is the only time it is ever visible.
    async createRecoveryCode() {
      const token = await ensureAccess()
      return call(address(), '/v1/auth/recovery-code', { token })
    },

    // A connectivity check that does not need a session, so the page can tell "the Hub is up but
    // my password is wrong" from "the Hub is not there" before anyone signs in.
    async health(baseUrl) {
      return call(trimBase(baseUrl), '/v1/health', { method: 'GET' })
    },
  }

  return client
}

// One install, into the runtime this domain already has. `wg.bridge` is the placeholder
// src/workgroup/index.js left for exactly this ("filled in G3+"): the Hub connection belongs to
// the remote domain, so it lives here rather than in the original src/host/.
//
// Nothing is started: no timer, no socket, no file read at install time. The account is restored
// when the settings page asks for it, so a Bot team with no Hub configured pays nothing and a
// Hub that is down cannot slow down a startup.
export function install(wg) {
  const { rt } = wg
  wg.hubStore = createHubStore({ ctx: rt.ctx, home: rt.home, logger: rt })
  wg.hub = createHubClient({ store: wg.hubStore, logger: rt })
  wg.bridge = wg.hub
}
