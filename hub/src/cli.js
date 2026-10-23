#!/usr/bin/env node
// The operator's recovery tool. Run from hub/:
//
//   node src/cli.js reset --phone +8613800138000 --password 'a long new password'
//   node src/cli.js show  --phone +8613800138000
//
// Why a command and not an endpoint: this is the last resort for a person who holds neither a
// session nor a recovery code. It requires the phone number *and* access to the Hub's database
// file — the same authority as editing that database by hand — so putting it behind HTTP would be
// a back door whose only protection is a password, on the one endpoint that controls every
// password.
//
// A reset ends every session and revokes every device: a recovery is exactly the situation where
// the old holders must lose access.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_DATA_DIR, loadConfig } from './config.js'
import { openDatabase } from './db/index.js'
import { createAudit } from './audit.js'
import { createLimiters } from './auth/limiter.js'
import { createRecoveryService } from './auth/recovery.js'

const USAGE = `Usage:
  node src/cli.js reset --phone <E.164> --password <new password>
  node src/cli.js show  --phone <E.164>

The database is read from HUB_DATA_DIR (default hub/.data).
A reset ends every session and revokes every device for that account.`

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let at = 0; at < rest.length; at += 1) {
    const token = rest[at]
    if (!token.startsWith('--')) continue
    // `--password` may legitimately contain spaces or start with a dash, so it takes the next
    // argument verbatim rather than being parsed further.
    options[token.slice(2)] = rest[at + 1]
    at += 1
  }
  return { command, options }
}

const { command, options } = parseArgs(process.argv.slice(2))
if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
  process.stdout.write(`${USAGE}\n`)
  process.exit(command === undefined ? 1 : 0)
}

const fail = (message) => {
  process.stderr.write(`hub-cli: ${message}\n`)
  process.exit(2)
}

// `loadConfig` refuses to start without TLS, which is right for the server and wrong for a local
// command that opens a file. The data directory is all this tool needs, so it is resolved without
// going through the transport checks.
const dataDir = resolve(process.env.HUB_DATA_DIR ?? DEFAULT_DATA_DIR)
const file = join(dataDir, 'hub.db')
if (!existsSync(file)) fail(`no database at ${file}. Start the Hub once, or set HUB_DATA_DIR.`)

const db = openDatabase(file)
const now = () => Date.now()
const recovery = createRecoveryService({
  db,
  audit: createAudit(db),
  limiters: createLimiters({ now }),
  config: { accessTtlMs: 0, refreshTtlMs: 0 },
  now,
})

try {
  if (command === 'show') {
    if (options.phone === undefined) fail('--phone is required')
    const summary = recovery.describeByOperator({ phone: options.phone })
    if (summary === undefined) fail('no account with that phone number')
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else if (command === 'reset') {
    if (options.phone === undefined) fail('--phone is required')
    if (options.password === undefined) fail('--password is required')
    const result = recovery.resetByOperator({ phone: options.phone, password: options.password })
    // The password is never echoed: a terminal scrollback is a file.
    process.stdout.write(`password reset for ${result.phoneMasked} (${result.hubUserId})\n`)
    process.stdout.write('every session and device for this account has been revoked\n')
  } else {
    fail(`unknown command "${command}". Try --help.`)
  }
} catch (error) {
  fail(error?.message ?? String(error))
} finally {
  db.close()
}
