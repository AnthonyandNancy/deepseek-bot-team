// Schema migrations, one entry per version, applied inside a transaction. A migration is
// a list of statements, not a function: an idempotency mistake then shows up as a failing
// SQL string rather than as a partially-applied side effect.
//
// G3 uses four tables — users, auth_sessions, devices, audit_events. Section 12's remaining
// twelve (bot_endpoints, workgroups, memberships, events, ...) are deliberately NOT created
// here: their columns would be guesses until G4 writes the queries that read them, and an
// empty table reads as "done" to the next person. G4 adds them from version 2 onward.
//
// `otp_challenges` is absent by decision, not omission: V1 authenticates with a password,
// no SMS is sent, and a table for one-time codes that nothing writes would invite someone
// to implement the flow later without the gateway the gate requires (docs/g3/PLAN.md §0).

export const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE users (
        id                TEXT PRIMARY KEY,
        phone_e164        TEXT NOT NULL UNIQUE,
        phone_verified_at TEXT,
        password_phc      TEXT NOT NULL,
        password_version  INTEGER NOT NULL DEFAULT 1,
        status            TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'suspended')),
        created_at        TEXT NOT NULL
      )`,
      // One row per login. `device_id` is nullable because a client may log in before it has
      // registered a key pair; the binding is set by the devices flow.
      `CREATE TABLE auth_sessions (
        id                 TEXT PRIMARY KEY,
        user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id          TEXT,
        access_hash        TEXT NOT NULL UNIQUE,
        access_expires_at  TEXT NOT NULL,
        refresh_hash       TEXT NOT NULL UNIQUE,
        refresh_expires_at TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        last_used_at       TEXT,
        revoked_at         TEXT
      )`,
      'CREATE INDEX auth_sessions_user ON auth_sessions(user_id)',
      // `public_key` is the whole identity of a device: the private half never leaves the
      // client, so the Hub can check a signature but can never sign as the device.
      `CREATE TABLE devices (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key   TEXT NOT NULL,
        name         TEXT NOT NULL,
        platform     TEXT,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at   TEXT,
        UNIQUE (user_id, public_key)
      )`,
      'CREATE INDEX devices_user ON devices(user_id)',
      // No passwords, no tokens, no full phone numbers: an audit trail that leaks is worse
      // than none, because it is the one log expected to be kept.
      `CREATE TABLE audit_events (
        id        TEXT PRIMARY KEY,
        actor_id  TEXT,
        device_id TEXT,
        action    TEXT NOT NULL,
        target_id TEXT,
        result    TEXT NOT NULL,
        at        TEXT NOT NULL
      )`,
      'CREATE INDEX audit_events_at ON audit_events(at)',
    ],
  },
  {
    // Password recovery, added because the account is otherwise unrecoverable: there is no SMS
    // and no email, so the only thing that can prove ownership is something the user already
    // holds. A recovery code is that thing.
    //
    // `code_hash` is an scrypt digest, not sha256: a recovery code is a *memorable-to-copy*
    // secret a person may keep for years, so it gets password-strength hashing rather than the
    // fast digest used for the 256-bit random session tokens.
    version: 2,
    statements: [
      `CREATE TABLE recovery_codes (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash  TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at    TEXT
      )`,
      'CREATE INDEX recovery_codes_user ON recovery_codes(user_id)',
      // A recovery must leave a trace even after the code is spent: "my password was changed and
      // I did not do it" is unanswerable otherwise.
      `CREATE TABLE password_resets (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        method     TEXT NOT NULL CHECK (method IN ('recovery-code', 'operator')),
        at         TEXT NOT NULL
      )`,
      'CREATE INDEX password_resets_user ON password_resets(user_id)',
    ],
  },
]

export const LATEST_VERSION = MIGRATIONS.at(-1)?.version ?? 0
