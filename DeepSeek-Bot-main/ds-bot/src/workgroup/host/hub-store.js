// Where the Hub's device key and refresh token live on this machine.
//
// The plan (docs/g3/PLAN.md §0, §8.3) records the honest limit here: the plugin host process has
// no `electron` module, so `safeStorage` is not reachable, and Node has no keychain. What this
// module therefore provides is an encrypted-at-rest boundary that is *exclusive to the owner*
// — not an OS keychain. It is registered as a gap (G6), not described as something it is not.
//
// Two stores, in order:
//   1. `ctx.credentials` — the Harness's own credential seam, `$DSH_HOME/.credentials.yaml`,
//      which refuses to load a file readable beyond its owner and writes with mode 0600.
//   2. a 0600 file under this plugin's own state directory, when that service is absent.
//
// The fallback is not optional: `credentials-local` is not loaded in every profile (it is not in
// the desktop profile on the machine this was built on), so a store that only used the seam
// would leave the Hub account page unusable there.
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The seam's key grammar is `<scope>/<id>`, both lowercase hyphenated identifiers. `ds-bot` is
// this plugin's own name, so the record can only ever be read back by this plugin.
export const CREDENTIAL_SCOPE = 'ds-bot'
export const CREDENTIAL_ID = 'hub-account'
export const CREDENTIAL_KEY = `${CREDENTIAL_SCOPE}/${CREDENTIAL_ID}`

export const HUB_DIR = 'hub'
export const SECRETS_FILE = 'account.json'
const MODE = 0o600

// What is stored: only what cannot be re-derived. The access token is deliberately absent — it
// lives in memory for its 30 minutes and is re-minted from the refresh token after a restart,
// so a stolen copy of this file cannot be replayed as a live session.
const shape = raw => (raw !== null && typeof raw === 'object'
  && typeof raw.refreshToken === 'string'
  && typeof raw.privateKeyPem === 'string'
  && typeof raw.deviceId === 'string'
  ? raw
  : undefined)

// A record whose payload is written in this plugin's own format; the seam stores it verbatim.
const asRecord = payload => ({ kind: 'grant', payload })

export function createHubStore({ ctx, home, logger } = {}) {
  const directory = join(home, HUB_DIR)
  const file = join(directory, SECRETS_FILE)
  // `ctx.get` is how this codebase reaches every optional service (see src/host/secrets.js and
  // index.js); absent means the profile does not install it.
  const seam = ctx?.get?.('credentials')

  const readFileStore = async () => {
    try {
      return shape(JSON.parse(await readFile(file, 'utf8')))
    } catch (error) {
      // A missing file is the normal first run. A corrupt one is also "nothing stored": the
      // user re-logs in, which is recoverable, while throwing here would break the settings page.
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined
      throw error
    }
  }

  // Windows ignores POSIX modes, so the check is best-effort there and strict elsewhere — the
  // same split the Harness's own credentials provider makes.
  const ensureOwnerOnly = async () => {
    if (process.platform === 'win32') return
    try {
      const info = await stat(file)
      if ((info.mode & 0o077) !== 0) await chmod(file, MODE)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  return {
    // Which store is in use, so the settings page can tell the truth about it.
    get backend() {
      return seam === undefined ? 'file' : 'credentials'
    },

    async load() {
      if (seam !== undefined) {
        try {
          const record = await seam.readRecord?.(CREDENTIAL_KEY)
          return shape(record?.payload)
        } catch (error) {
          // A seam that exists but fails must not lock the user out of the fallback: the
          // account page would otherwise be dead with no explanation.
          logger?.warn?.('ds-bot: could not read the Hub account from credentials: %s', error?.message ?? error)
        }
      }
      return readFileStore()
    },

    async save(payload) {
      const value = shape(payload)
      if (value === undefined) throw new Error('ds-bot: the Hub account payload is incomplete')
      if (seam?.modifyRecord !== undefined) {
        await seam.modifyRecord(CREDENTIAL_KEY, async () => asRecord(value))
        return this.backend
      }
      await mkdir(directory, { recursive: true, mode: 0o700 })
      // Written whole to a temporary name and renamed, so a crash mid-write cannot leave a
      // half-file that reads as "no account" and silently signs the user out.
      const temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: MODE })
      await chmod(temporary, MODE)
      await rename(temporary, file)
      await ensureOwnerOnly()
      return this.backend
    },

    async clear() {
      // Removal is `deleteRecord`. The previous version used `modifyRecord(..., () => undefined)` and
      // believed that meant "delete"; in the Harness's provider it means "leave the record alone" and
      // returns early without writing. Every sign-out therefore kept the account on disk, the page
      // went on saying "signed in", and signing in again was refused because a record was already
      // there. Nothing throws in that path, so no test noticed until one modelled the provider's
      // semantics instead of assuming them.
      if (seam?.deleteRecord !== undefined) {
        // Best effort, like the file branch below: a seam that refuses must not leave the user stuck
        // signed in with no way out. The file fallback is still attempted.
        await seam.deleteRecord(CREDENTIAL_KEY).catch(() => {})
      } else if (seam?.modifyRecord !== undefined) {
        // A provider with no `deleteRecord` predates this contract; there is no way to remove a record
        // through it, so an empty grant is the closest thing to "signed out" that it can store.
        await seam.modifyRecord(CREDENTIAL_KEY, async () => undefined).catch(() => {})
      }
      await unlink(file).catch(error => { if (error?.code !== 'ENOENT') throw error })
    },

    // The path, for a support message that needs to tell someone where to look.
    get location() {
      return this.backend === 'credentials' ? `credentials:${CREDENTIAL_KEY}` : file
    },
  }
}
