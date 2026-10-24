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

// What the Hub verifies for a socket handshake: `<deviceId>.<timestamp>.<nonce>`. It lives here,
// beside the other signing helper, so the private key is read in exactly one module and the
// bridge never holds it (docs/g3/PLAN.md §8.3: the settings page cannot obtain the long-lived key).
export const signHandshake = (privateKeyPem, deviceId, timestamp, nonce) =>
  sign(null, Buffer.from(`${deviceId}.${timestamp}.${nonce}`), createPrivateKey(privateKeyPem)).toString('base64')

// What the Hub verifies for a task envelope (plan §9.2): a signature over bytes this module does not
// assemble. The caller passes the canonical bytes (`host/envelope.js` builds them), so the shape of
// an envelope lives in one place and the private key lives in another.
export const signBytes = (privateKeyPem, bytes) =>
  sign(null, bytes, createPrivateKey(privateKeyPem)).toString('base64')

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

  // Which refusals from `/v1/auth/refresh` mean the stored record can never work again, and which
  // only mean "not right now".
  //
  // The Hub answers 401 for a token it has no row for, one that was already rotated, one that
  // expired, and one whose session was ended. In every one of those cases the token is gone for
  // good — rotation is single-use, so a rejected token is never going to be accepted on a retry.
  // Without this, a machine whose Hub database was replaced kept the dead record on disk, reported
  // itself as signed in, and failed every single call with "The refresh token is not valid." That is
  // indistinguishable, from the page, from a working account.
  //
  // Anything else — an unreachable Hub, a TLS rejection, a 500 — is a condition that can pass, so the
  // record is kept and the next attempt retries it. Deleting on a network blip would silently sign
  // the person out of a fine session.
  const sessionRefused = error => error?.status === 401

  // Refreshes the access token from the stored refresh token, so no caller has to think about
  // lifetime. The Hub rotates both halves, so the stored refresh token is replaced at once:
  // keeping the old one would make the next restart fail to sign in.
  const ensureAccess = async () => {
    if (isLoggedIn()) return accessToken
    const stored = await store.load()
    if (stored === undefined) throw new HubRequestError('This device is not signed in to the Hub.', { code: 'hub/not-signed-in' })
    const base = trimBase(stored.baseUrl)
    let refreshed
    try {
      refreshed = await call(base, '/v1/auth/refresh', { body: { refreshToken: stored.refreshToken } })
    } catch (error) {
      if (!sessionRefused(error)) throw error
      // The Hub answered, and its answer was "this session does not exist". Drop the record so the
      // page shows the sign-in form, and report the state rather than the Hub's wording: the sentence
      // the person needs is "sign in again", and the account is already gone by the time they read it.
      clearMemory()
      await store.clear()
      throw new HubRequestError(
        'Your Hub session has ended, so this device was signed out. Sign in to the Hub again.',
        { code: 'hub/signed-out', status: 401 },
      )
    }
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

    // ── what the bridge needs, and nothing more ───────────────────────────────────
    // The socket handshake is signed here rather than in the bridge: the private key is never
    // returned to a caller, so no other module — and certainly not the settings page — can read
    // it. `sign` closes over the stored key for the lifetime of one return value.
    async socketAuth() {
      const token = await ensureAccess()
      const stored = await store.load()
      if (stored === undefined) throw new HubRequestError('This device is not signed in to the Hub.', { code: 'hub/not-signed-in' })
      return {
        baseUrl: trimBase(stored.baseUrl),
        hubUserId: stored.hubUserId,
        deviceId: stored.deviceId,
        accessToken: token,
        sign: (deviceId, timestamp, nonce) => signHandshake(stored.privateKeyPem, deviceId, timestamp, nonce),
        // The same key, used for a task envelope. Separate from `sign` so a caller cannot
        // accidentally reuse the handshake payload for a request (which the Hub would refuse) or the
        // other way round.
        signPayload: bytes => signBytes(stored.privateKeyPem, bytes),
      }
    },

    // ── groups ────────────────────────────────────────────────────────────────────
    // One thin method per endpoint, so the bridge holds no URL strings and a Hub route rename
    // cannot leave a stale path in two places.
    async createWorkgroup({ name, notice, upgradeId, endpointIds, leadEndpointId }) {
      const token = await ensureAccess()
      return call(address(), '/v1/workgroups', {
        body: {
          name,
          ...(notice === undefined ? {} : { notice }),
          ...(upgradeId === undefined ? {} : { upgradeId }),
          ...(endpointIds === undefined ? {} : { endpointIds }),
          // Which of those Bots leads the group. Sent because only THIS machine knows which of its
          // Bots is its Main Bot; every other machine reads the answer back instead of deriving one.
          ...(leadEndpointId === undefined ? {} : { leadEndpointId }),
        },
        token,
      })
    },
    async workgroups() {
      const token = await ensureAccess()
      return (await call(address(), '/v1/workgroups', { method: 'GET', token })).workgroups ?? []
    },
    async workgroup(workgroupId) {
      const token = await ensureAccess()
      return call(address(), `/v1/workgroups/${encodeURIComponent(workgroupId)}`, { method: 'GET', token })
    },
    // Deletes the group on the Hub, for everyone. The owner is the only one the Hub accepts this
    // from. A workgroup lives on the Hub, so deleting it only here left it there to be re-adopted on
    // the next start (「删除工作群，采取本应用后又出现了」).
    async deleteWorkgroup(workgroupId) {
      const token = await ensureAccess()
      return call(address(), `/v1/workgroups/${encodeURIComponent(workgroupId)}/delete`, { body: {}, token })
    },
    // A group's name and notice, changed for everyone.
    //
    // The two settings the Hub stores. Sending them is what makes a rename stick on the other
    // person's machine: without it the local record changed, the Hub kept the old value, and the
    // next roster read put it back.
    async updateGroupSettings({ workgroupId, name, notice, replyMode, permission, leadMembershipId, configVersion }) {
      const token = await ensureAccess()
      return call(address(), `/v1/workgroups/${encodeURIComponent(workgroupId)}/settings`, {
        body: {
          // The version this change was based on. A Hub that knows the field refuses a stale write;
          // an older Hub ignores it because it is not in its closed allow-list.
          ...(configVersion === undefined ? {} : { configVersion }),
          ...(name === undefined ? {} : { name }),
          ...(notice === undefined ? {} : { notice }),
          ...(replyMode === undefined ? {} : { replyMode }),
          // `null` is a value in both of these, not a missing one: "each member uses its own again"
          // for `permission` (the original's `delete room.permission`) and "nobody chose a lead" for
          // `leadMembershipId`. Forwarded rather than skipped, or a clear can never travel.
          ...(permission === undefined ? {} : { permission }),
          ...(leadMembershipId === undefined ? {} : { leadMembershipId }),
        },
        token,
      })
    },
    async invite({ workgroupId, phone, hubUserId }) {
      const token = await ensureAccess()
      return call(address(), `/v1/workgroups/${encodeURIComponent(workgroupId)}/invites`, {
        body: { ...(phone === undefined ? {} : { phone }), ...(hubUserId === undefined ? {} : { hubUserId }) },
        token,
      })
    },
    async invites() {
      const token = await ensureAccess()
      return (await call(address(), '/v1/invites', { method: 'GET', token })).invites ?? []
    },
    async answerInvite({ inviteId, accept }) {
      const token = await ensureAccess()
      return call(address(), `/v1/invites/${encodeURIComponent(inviteId)}/${accept ? 'accept' : 'decline'}`, { token })
    },
    async events({ workgroupId, afterSeq = 0, limit }) {
      const token = await ensureAccess()
      const query = `afterSeq=${encodeURIComponent(String(afterSeq))}${limit === undefined ? '' : `&limit=${encodeURIComponent(String(limit))}`}`
      return call(address(), `/v1/workgroups/${encodeURIComponent(workgroupId)}/events?${query}`, { method: 'GET', token })
    },
    async markRead({ workgroupId, seq }) {
      const token = await ensureAccess()
      return call(address(), `/v1/workgroups/${encodeURIComponent(workgroupId)}/read`, { body: { seq }, token })
    },
    async botEndpoints({ workgroupId } = {}) {
      const token = await ensureAccess()
      const query = workgroupId === undefined ? '' : `?workgroupId=${encodeURIComponent(workgroupId)}`
      return call(address(), `/v1/bot-endpoints${query}`, { method: 'GET', token })
    },
    async publishBotEndpoint({ localBotId, name, capabilities, visibility, avatar }) {
      const token = await ensureAccess()
      return call(address(), '/v1/bot-endpoints', {
        body: {
          localBotId,
          name,
          ...(capabilities === undefined ? {} : { capabilities }),
          ...(visibility === undefined ? {} : { visibility }),
          // The Bot's appearance: a shape name, a palette name, and optionally the photo's data URL.
          // The Hub stores it with the endpoint and hands it back on every group roster, which is
          // what makes the same Bot wear the same face on every machine.
          ...(avatar === undefined ? {} : { avatar }),
        },
        token,
      })
    },
    // Puts one published Bot endpoint into a group's roster.
    //
    // The Hub has had this route since G4 (`POST /v1/workgroups/:id/members`) and NOTHING called
    // it: publishing a Bot made it addressable to people who were already in a group with you, and
    // there was no way to bring one into a group you had just joined. So an invited colleague
    // arrived alone — the person was a member and their Bot was not — and a Bot added to a group
    // after it was made was never put into the roster at all.
    async addEndpointMember({ workgroupId, endpointId }) {
      const token = await ensureAccess()
      return call(address(), `/v1/workgroups/${encodeURIComponent(workgroupId)}/members`, {
        body: { endpointId },
        token,
      })
    },
    // Takes one membership out of a group's roster.
    //
    // The Hub has had this route since G4 as well (`POST .../members/:id/leave`), and nothing called
    // it either — so 「移除成员」 removed the row on this machine and the next roster read put it
    // straight back. Removing has to reach the Hub for the same reason adding does: the Hub owns the
    // roster, and anything this machine believes alone is overwritten.
    async leaveMember({ workgroupId, membershipId }) {
      const token = await ensureAccess()
      return call(address(), `/v1/workgroups/${encodeURIComponent(workgroupId)}/members/${encodeURIComponent(membershipId)}/leave`, {
        body: {},
        token,
      })
    },

    // ── attachments ───────────────────────────────────────────────────────────────
    // The bytes are read by the caller and posted as base64; a path is never part of the request,
    // which is what makes "the Hub cannot name a file on this machine" structural (plan §13.2).
    async uploadAttachment({ workgroupId, name, mime, data }) {
      const token = await ensureAccess()
      return call(address(), `/v1/workgroups/${encodeURIComponent(workgroupId)}/attachments`, { body: { name, mime, data }, token })
    },
    async attachmentTicket({ attachmentId }) {
      const token = await ensureAccess()
      return call(address(), `/v1/attachments/${encodeURIComponent(attachmentId)}/ticket`, { token })
    },
    async downloadAttachment({ attachmentId, ticket }) {
      const token = await ensureAccess()
      const path = `/v1/attachments/${encodeURIComponent(attachmentId)}/download?ticket=${encodeURIComponent(ticket)}`
      const response = await fetchImpl(`${address()}${path}`, { headers: { authorization: `Bearer ${token}` } })
      if (!response.ok) {
        throw new HubRequestError(`The Hub refused the download (HTTP ${response.status}).`, { code: `hub/http-${response.status}`, status: response.status })
      }
      return Buffer.from(await response.arrayBuffer())
    },
    async revokeBotEndpoint({ endpointId }) {
      const token = await ensureAccess()
      return call(address(), `/v1/bot-endpoints/${encodeURIComponent(endpointId)}/revoke`, { token })
    },

    // ── tasks (G5) ────────────────────────────────────────────────────────────────
    // A task is REQUESTED over the socket (the outbox gives it at-least-once delivery for free) and
    // DECIDED over HTTP, which is exactly the split plan §13.1 draws. These are the HTTP halves.
    async task(taskId) {
      const token = await ensureAccess()
      return call(address(), `/v1/tasks/${encodeURIComponent(taskId)}`, { method: 'GET', token })
    },
    async tasks({ workgroupId, role } = {}) {
      const token = await ensureAccess()
      const query = new URLSearchParams()
      if (workgroupId !== undefined) query.set('workgroupId', workgroupId)
      if (role !== undefined) query.set('role', role)
      const suffix = query.toString() === '' ? '' : `?${query.toString()}`
      return (await call(address(), `/v1/tasks${suffix}`, { method: 'GET', token })).tasks ?? []
    },
    async decideTask({ taskId, decision, scope }) {
      const token = await ensureAccess()
      return call(address(), `/v1/tasks/${encodeURIComponent(taskId)}/decision`, {
        body: { decision, ...(scope === undefined ? {} : { scope }) },
        token,
      })
    },
    async revokeTask({ taskId, reason }) {
      const token = await ensureAccess()
      return call(address(), `/v1/tasks/${encodeURIComponent(taskId)}/revoke`, {
        body: reason === undefined ? {} : { reason },
        token,
      })
    },

    // ── artifacts (G5) ────────────────────────────────────────────────────────────
    // Bytes, never a path: the caller reads the file and posts base64, exactly like the attachment
    // relay. What differs is that the Hub checks the task's approval before it stores anything.
    async uploadArtifact({ taskId, name, mime, data, acl }) {
      const token = await ensureAccess()
      return call(address(), '/v1/artifacts/uploads', {
        body: { taskId, name, mime, data, ...(acl === undefined ? {} : { acl }) },
        token,
      })
    },
    async taskArtifacts({ taskId }) {
      const token = await ensureAccess()
      return (await call(address(), `/v1/tasks/${encodeURIComponent(taskId)}/artifacts`, { method: 'GET', token })).artifacts ?? []
    },
    async downloadArtifact({ artifactId }) {
      const token = await ensureAccess()
      const response = await fetchImpl(`${address()}/v1/artifacts/${encodeURIComponent(artifactId)}/download`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        throw new HubRequestError(`The Hub refused the artifact download (HTTP ${response.status}).`, { code: `hub/http-${response.status}`, status: response.status })
      }
      return Buffer.from(await response.arrayBuffer())
    },

    // ── the coordinator lease (G5) ────────────────────────────────────────────────
    // Over HTTP as well as over the socket: the socket path is the one a round uses, and this exists
    // so a reconnecting client can ask "am I still the coordinator?" before it starts anything.
    async lease({ workgroupId }) {
      const token = await ensureAccess()
      return call(address(), `/v1/workgroups/${encodeURIComponent(workgroupId)}/lease`, { method: 'GET', token })
    },
    // Only the READ is here. Taking and releasing a lease happens over the socket
    // (`bridge.acquireLease`), because a round commits while it runs and the fence has to be checked on
    // the connection the round is already using. An HTTP acquire existed for a while and had no caller
    // once the round took over, so it is gone rather than left as a second door.
  }

  return client
}

// One install, into the runtime this domain already has: the account store and the HTTP client.
//
// `wg.bridge` used to be set to this client here, standing in for a connection that did not exist
// yet. G4 installs host/bridge.js instead, which wraps this client in a real socket. Keeping the
// HTTP client separate matters: the account page, the login flow and the health check all work
// with no socket at all, and a Hub that refuses WSS must not take the settings page down.
//
// Nothing is started: no timer, no socket, no file read at install time. The account is restored
// when the settings page asks for it, so a Bot team with no Hub configured pays nothing and a
// Hub that is down cannot slow down a startup.
export function install(wg) {
  const { rt } = wg
  wg.hubStore = createHubStore({ ctx: rt.ctx, home: rt.home, logger: rt })
  wg.hub = createHubClient({ store: wg.hubStore, logger: rt })
}
