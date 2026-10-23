import { resolve } from 'node:path'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

// Whether a peer address is this machine. `::ffff:127.0.0.1` is what a dual-stack
// listener reports for an IPv4 connection, so it counts.
export const isLoopback = address => typeof address === 'string' && (LOOPBACK.has(address) || address.startsWith('127.'))

// The Hub's settings, read once at startup from the environment. Every value that decides
// whether credentials may cross the wire is resolved here so there is exactly one place
// where a mistake could make the service insecure — and that place is tested.

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

const DEFAULT_PORT = 7788
// Resolved against the working directory ONCE, in `loadConfig`, so that no two starts of the same
// command can silently pick different files. This used to stay relative, which meant `npm start`
// from `hub/` opened `hub/hub/.data` while the same command from the repository root opened
// `hub/.data`: an account registered against one was "not valid" against the other, and nothing on
// screen could show that the two were different databases.
export const DEFAULT_DATA_DIR = 'hub/.data'
const DEFAULT_ACCESS_TTL_MS = 30 * 60 * 1000
const DEFAULT_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000

function readPort(raw) {
  if (raw === undefined || raw === '') return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`HUB_PORT must be a port number, got "${raw}"`)
  return port
}

function readTtl(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${name} must be a positive number of seconds, got "${raw}"`)
  return Math.round(value * 1000)
}

// Presence, not truthiness: `HUB_TLS_CERT=` (empty) means "not configured", while any
// other value means the operator intends TLS and the files had better exist.
const present = value => typeof value === 'string' && value.length > 0

export function loadConfig(env = process.env) {
  const cert = present(env.HUB_TLS_CERT) ? env.HUB_TLS_CERT : undefined
  const key = present(env.HUB_TLS_KEY) ? env.HUB_TLS_KEY : undefined
  const allowInsecure = env.HUB_ALLOW_INSECURE_LOCALHOST === '1'
  // Plaintext on a routable address is a different decision from plaintext on loopback: the second
  // reaches this machine only, the first puts every password on the local network. It is offered,
  // but never assumed — without this flag the Hub refuses to start rather than silently binding
  // somewhere else (which is what it used to do, and what made HUB_HOST=0.0.0.0 look accepted).
  const allowPlaintextLan = env.HUB_ALLOW_PLAINTEXT_LAN === '1'

  if ((cert === undefined) !== (key === undefined)) {
    throw new ConfigError('HUB_TLS_CERT and HUB_TLS_KEY must be set together')
  }
  // Passwords are permanent credentials; an OTP would only ever be spent once. With no
  // TLS and no explicit opt-in there is no acceptable way to receive one.
  if (cert === undefined && !allowInsecure) {
    throw new ConfigError(
      'Refusing to start without TLS: set HUB_TLS_CERT and HUB_TLS_KEY, '
      + 'or set HUB_ALLOW_INSECURE_LOCALHOST=1 to run in plaintext on loopback only.',
    )
  }

  const host = env.HUB_HOST ?? '127.0.0.1'
  // A plaintext listener that is not loopback can be reached from the local network, so every
  // password crosses it in the clear. Refused unless the operator said so explicitly; the message
  // names both ways out. Without TLS on loopback nothing changes.
  if (cert === undefined && !isLoopback(host) && !allowPlaintextLan) {
    throw new ConfigError(
      `Refusing to listen on ${host} without TLS: passwords would cross the network in the clear. `
      + 'Set HUB_TLS_CERT and HUB_TLS_KEY, or set HUB_ALLOW_PLAINTEXT_LAN=1 to accept that.',
    )
  }

  return {
    host,
    port: readPort(env.HUB_PORT),
    tls: cert === undefined ? null : { cert, key },
    allowInsecure,
    allowPlaintextLan,
    // Loopback in plaintext unless the operator accepted the local network explicitly.
    insecureLoopbackOnly: cert === undefined && !allowPlaintextLan,
    dataDir: resolve(env.HUB_DATA_DIR ?? DEFAULT_DATA_DIR),
    accessTtlMs: readTtl(env.HUB_ACCESS_TTL, DEFAULT_ACCESS_TTL_MS, 'HUB_ACCESS_TTL'),
    refreshTtlMs: readTtl(env.HUB_REFRESH_TTL, DEFAULT_REFRESH_TTL_MS, 'HUB_REFRESH_TTL'),
    logLevel: env.HUB_LOG_LEVEL ?? 'info',
  }
}

