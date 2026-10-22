// The operator command, exercised as a command.
//
// Run as a child process against a real database file, because that is how it will be used: the
// whole design claim is that reaching it requires the database file rather than a session. Calling
// the function in-process would not prove the file is the barrier, nor that the argument handling
// and exit codes work.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHub } from '../src/server.js'
import { createMemoryLogger } from '../src/log.js'

const HUB_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'an entirely new passphrase here'
const PHONE = '+8613800138000'

// A Hub with a known data directory, so the CLI can be pointed at the same file.
const withDataDir = async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hub-cli-'))
  const hub = createHub({
    config: {
      host: '127.0.0.1', port: 0, tls: null, allowInsecure: true, insecureLoopbackOnly: true,
      dataDir, accessTtlMs: 30 * 60 * 1000, refreshTtlMs: 24 * 60 * 60 * 1000, logLevel: 'info',
    },
    logger: createMemoryLogger().logger,
  })
  const address = await hub.listen()
  const base = `http://127.0.0.1:${address.port}`
  t.after(async () => {
    await hub.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json().catch(() => undefined) }
  }

  return { hub, base, dataDir, post }
}

// Runs the CLI with HUB_DATA_DIR set, capturing stdout and the exit code.
const runCli = (dataDir, args) => {
  try {
    const stdout = execFileSync(process.execPath, [join(HUB_DIR, 'src', 'cli.js'), ...args], {
      cwd: HUB_DIR,
      env: { ...process.env, HUB_DATA_DIR: dataDir },
      encoding: 'utf8',
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

test('--help explains the two commands', () => {
  const result = runCli(HUB_DIR, ['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /reset/)
  assert.match(result.stdout, /show/)
  // The reset is destructive; the help says what it costs.
  assert.match(result.stdout, /ends every session/i)
})

test('a missing database is refused with a path a person can act on', () => {
  const empty = mkdtempSync(join(tmpdir(), 'hub-cli-empty-'))
  const result = runCli(empty, ['show', '--phone', PHONE])
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /no database at/)
  rmSync(empty, { recursive: true, force: true })
})

test('show reports the account without printing a secret', async (t) => {
  const { dataDir, hub, post } = await withDataDir(t)
  await post('/v1/auth/register', { phone: PHONE, password: PASSWORD })

  const result = runCli(dataDir, ['show', '--phone', PHONE])
  assert.equal(result.code, 0, result.stderr)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.hubUserId.startsWith('usr_'), true)
  assert.equal(summary.recoveryCodes, 0)
  // The output goes into a terminal that may be logged or screenshotted.
  assert.equal(result.stdout.includes(PHONE), false)
  assert.equal(result.stdout.includes('$scrypt$'), false)
  assert.equal(result.stdout.includes(PASSWORD), false)
  assert.notEqual(hub, undefined)
})

test('reset changes the password and kills the sessions the user cannot get out of', async (t) => {
  const { dataDir, base, post } = await withDataDir(t)
  const created = await post('/v1/auth/register', { phone: PHONE, password: PASSWORD })
  assert.equal(created.status, 201)

  const result = runCli(dataDir, ['reset', '--phone', PHONE, '--password', NEW_PASSWORD])
  assert.equal(result.code, 0, result.stderr)
  // The confirmation names the account by its masked number only.
  assert.match(result.stdout, /\+86\*{4}8000/)
  assert.equal(result.stdout.includes(NEW_PASSWORD), false, 'a terminal scrollback is a file')
  assert.equal(result.stdout.includes(PASSWORD), false)

  // The old token is dead, the old password is dead, the new password works.
  const me = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${created.body.accessToken}` } })
  assert.equal(me.status, 401)
  assert.equal((await post('/v1/auth/login', { phone: PHONE, password: PASSWORD })).status, 401)
  assert.equal((await post('/v1/auth/login', { phone: PHONE, password: NEW_PASSWORD })).status, 200)
})

test('reset refuses an unknown account, a weak password, and a national-format number', async (t) => {
  const { dataDir, post } = await withDataDir(t)
  await post('/v1/auth/register', { phone: PHONE, password: PASSWORD })

  const unknown = runCli(dataDir, ['reset', '--phone', '+8613700137000', '--password', NEW_PASSWORD])
  assert.notEqual(unknown.code, 0)
  assert.match(unknown.stderr, /no account/i)

  const weak = runCli(dataDir, ['reset', '--phone', PHONE, '--password', 'short'])
  assert.notEqual(weak.code, 0)
  assert.match(weak.stderr, /at least 10/i)

  // A national number would silently become a different account's phone in some countries.
  const national = runCli(dataDir, ['reset', '--phone', '13800138000', '--password', NEW_PASSWORD])
  assert.notEqual(national.code, 0)
  assert.match(national.stderr, /international form/i)
})

test('a missing argument is refused rather than guessed', async (t) => {
  const { dataDir } = await withDataDir(t)
  const noPhone = runCli(dataDir, ['reset', '--password', NEW_PASSWORD])
  assert.notEqual(noPhone.code, 0)
  assert.match(noPhone.stderr, /--phone is required/)

  const noPassword = runCli(dataDir, ['reset', '--phone', PHONE])
  assert.notEqual(noPassword.code, 0)
  assert.match(noPassword.stderr, /--password is required/)
})

test('reset is audited, so a surprise password change is answerable', async (t) => {
  const { dataDir, hub, post } = await withDataDir(t)
  await post('/v1/auth/register', { phone: PHONE, password: PASSWORD })
  runCli(dataDir, ['reset', '--phone', PHONE, '--password', NEW_PASSWORD])

  const actions = hub.audit.list().map(event => event.action)
  assert.ok(actions.includes('auth.password-reset-operator'), 'the operator path must leave a trace')
  assert.equal(JSON.stringify(hub.audit.list()).includes(NEW_PASSWORD), false)
})
