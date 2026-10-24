// Schema migrations, one entry per version, applied inside a transaction. A migration is
// a list of statements, not a function: an idempotency mistake then shows up as a failing
// SQL string rather than as a partially-applied side effect.
//
// Version 1 is the four tables G3 needed — users, auth_sessions, devices, audit_events. The rest
// of section 12 arrives only when a phase writes the queries that read it (G4 in version 3), so
// no table exists purely as a promise: an empty table reads as "done" to the next person.
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
  {
    // G4: the group, its members, its invites, its events and the reliability bookkeeping that
    // makes "at least once delivery, deduplicated on receipt" true rather than aspirational.
    //
    // Only the seven tables section 12 assigns to G4, plus the attachment relay the acceptance
    // matrix (T08) requires. `round_leases`, `tasks`, `approvals`, `artifacts` and
    // `group_memories` are G5/G6 and are deliberately absent — same reasoning as the absent
    // `otp_challenges` in migration 1: an empty table reads as "already done".
    //
    // `attachments` is not section 12's `artifacts`: artifacts hang off a task and carry a
    // sharing ACL that only the approval flow can produce. A group attachment is an ordinary
    // chat file with no task behind it, so it gets its own table and its own endpoints
    // (`/v1/workgroups/:id/attachments`), leaving `/v1/artifacts/*` to G5 untouched.
    version: 3,
    statements: [
      // A published Bot endpoint. It is an identity claim — "this device runs a Bot called X
      // with these capabilities" — and nothing else: no working directory, no local path, no
      // file. `capabilities` is a JSON array drawn from a closed set the service validates.
      `CREATE TABLE bot_endpoints (
        id           TEXT PRIMARY KEY,
        owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        local_bot_id TEXT NOT NULL,
        name         TEXT NOT NULL,
        visibility   TEXT NOT NULL DEFAULT 'workgroup'
                     CHECK (visibility IN ('private', 'workgroup')),
        capabilities TEXT NOT NULL DEFAULT '[]',
        status       TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'revoked')),
        created_at   TEXT NOT NULL,
        revoked_at   TEXT,
        UNIQUE (owner_id, device_id, local_bot_id)
      )`,
      'CREATE INDEX bot_endpoints_owner ON bot_endpoints(owner_id)',

      // `last_seq` is the per-group monotonic counter. It lives on the group row so a
      // transaction can do `UPDATE ... RETURNING` and hand out the next number without a
      // second table to keep in step.
      //
      // `upgrade_id` is the idempotency key of an upgrade: it is UNIQUE, so replaying the same
      // upgrade N times produces one group. It is a random value minted on the client, NOT a
      // hash of the local group id — the Hub has no business learning local identifiers.
      `CREATE TABLE workgroups (
        id            TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        notice        TEXT NOT NULL DEFAULT '',
        avatar        TEXT,
        config_version INTEGER NOT NULL DEFAULT 1,
        last_seq      INTEGER NOT NULL DEFAULT 0,
        upgrade_id    TEXT UNIQUE,
        created_at    TEXT NOT NULL,
        archived_at   TEXT
      )`,
      'CREATE INDEX workgroups_owner ON workgroups(owner_user_id)',

      // A member is either a person (one row per user) or a Bot endpoint. `role` decides who may
      // invite and rename. The expression index is what stops the same person or the same Bot
      // endpoint being added twice: a plain UNIQUE over nullable columns would let both NULLs
      // through as distinct rows.
      `CREATE TABLE memberships (
        id           TEXT PRIMARY KEY,
        workgroup_id TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
        member_type  TEXT NOT NULL CHECK (member_type IN ('user', 'botEndpoint')),
        user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
        endpoint_id  TEXT REFERENCES bot_endpoints(id) ON DELETE CASCADE,
        role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
        status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left', 'removed')),
        joined_at    TEXT NOT NULL,
        CHECK ((member_type = 'user') = (user_id IS NOT NULL)),
        CHECK ((member_type = 'botEndpoint') = (endpoint_id IS NOT NULL))
      )`,
      `CREATE UNIQUE INDEX memberships_unique ON memberships(
        workgroup_id, member_type, ifnull(user_id, ''), ifnull(endpoint_id, '')
      )`,
      'CREATE INDEX memberships_user ON memberships(user_id)',

      // An invite names one person and one group. The partial unique index allows only one
      // pending invite per person per group, so a double click cannot queue two.
      //
      // `invited_phone_masked` is kept for the invitee's own list ("who asked me"); the full
      // phone number is never stored here and is read from `users` only while inviting.
      `CREATE TABLE invites (
        id                   TEXT PRIMARY KEY,
        workgroup_id         TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
        invited_by           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invitee_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invited_phone_masked TEXT NOT NULL DEFAULT '',
        status               TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
        created_at           TEXT NOT NULL,
        expires_at           TEXT NOT NULL,
        answered_at          TEXT
      )`,
      `CREATE UNIQUE INDEX invites_pending ON invites(workgroup_id, invitee_id) WHERE status = 'pending'`,
      'CREATE INDEX invites_invitee ON invites(invitee_id)',

      // The group log. `event_id` is the client's dedup key and the primary key here, so a
      // resent event cannot become two rows; `(workgroup_id, seq)` is the ordering the client
      // pulls by, so two events can never share a position in one group.
      //
      // `sender_id` is the authenticated user id *as the Hub saw it*, never as the client
      // claimed it (section 9.2: the Hub overwrites the sender from the connection).
      `CREATE TABLE events (
        event_id           TEXT PRIMARY KEY,
        workgroup_id       TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
        seq                INTEGER NOT NULL,
        type               TEXT NOT NULL,
        sender_id          TEXT,
        sender_device_id   TEXT,
        sender_endpoint_id TEXT,
        payload            TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        UNIQUE (workgroup_id, seq)
      )`,
      'CREATE INDEX events_workgroup_created ON events(workgroup_id, created_at)',

      // Per-device receipt bookkeeping. A row is written when the Hub hands an event to a live
      // socket and `ack_at` when that device says it persisted the event; anything without
      // `ack_at` is what a reconnect replays.
      `CREATE TABLE deliveries (
        event_id     TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
        device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        delivered_at TEXT,
        ack_at       TEXT,
        PRIMARY KEY (event_id, device_id)
      )`,
      'CREATE INDEX deliveries_device_ack ON deliveries(device_id, ack_at)',

      // The read/unread cursor per person per group. One row per (group, user): a second device
      // of the same person must not create a second notion of "read".
      `CREATE TABLE read_cursors (
        workgroup_id  TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (workgroup_id, user_id)
      )`,

      // The attachment relay (section 13.2). `storage_key` is a path *inside* the Hub's own data
      // directory and is never returned by any endpoint; the download endpoint hands back a
      // short-lived ticket instead. Nothing here can name a file on the sender's machine —
      // there is no column for it, and the upload carries bytes, not a path.
      `CREATE TABLE attachments (
        id                 TEXT PRIMARY KEY,
        workgroup_id       TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
        uploader_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        uploader_device_id TEXT,
        name               TEXT NOT NULL,
        mime               TEXT NOT NULL,
        size               INTEGER NOT NULL,
        sha256             TEXT NOT NULL,
        storage_key        TEXT NOT NULL UNIQUE,
        created_at         TEXT NOT NULL,
        expires_at         TEXT NOT NULL,
        deleted_at         TEXT
      )`,
      'CREATE INDEX attachments_group ON attachments(workgroup_id)',
      'CREATE INDEX attachments_expiry ON attachments(expires_at)',

      // A download grant. Short-lived and single-purpose: it names one attachment and one user,
      // and it is checked against current membership at redemption, so leaving the group ends
      // the ability to download even with an unexpired ticket.
      `CREATE TABLE attachment_tickets (
        id            TEXT PRIMARY KEY,
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL
      )`,
      'CREATE INDEX attachment_tickets_expiry ON attachment_tickets(expires_at)',
    ],
  },
  {
    // G5: cross-user delegation. The four tables section 12 assigns to this phase — the task, the
    // approval B grants on their own device, the single-coordinator lease, and the authorized
    // artifact. `group_memories` stays absent: that is G6, and an empty table reads as "done".
    //
    // `tasks.id` is the *requester's* taskId, minted by A's Bridge and carried in the
    // `task.request` envelope. Making it the primary key is what makes gate 5 structural: a task
    // request redelivered after a lost ack finds the row and returns it instead of creating a
    // second task, exactly as `events.event_id` deduplicates a resent message.
    //
    // `state` is plan §10.2's machine, spelled out in a CHECK. The Hub refuses a state it does not
    // know for the same reason `EVENT_TYPES` is a closed set: a row in a state nothing can act on
    // would be replayed to every client forever.
    //
    // `owner_device_id` / `approvals.approved_device_id` exist so gate 3 ("the issuing device is
    // unambiguous") is a stored fact rather than a log line: the device is taken from the
    // authenticated session that made the decision, never from the request body.
    version: 4,
    statements: [
      `CREATE TABLE tasks (
        id                  TEXT PRIMARY KEY,
        workgroup_id        TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
        requester_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        requester_device_id TEXT,
        owner_id            TEXT REFERENCES users(id) ON DELETE CASCADE,
        owner_device_id     TEXT,
        endpoint_id         TEXT REFERENCES bot_endpoints(id) ON DELETE SET NULL,
        state               TEXT NOT NULL CHECK (state IN (
                              'REQUESTED', 'DELIVERED', 'PENDING_APPROVAL', 'APPROVED', 'ASSIGNED',
                              'RUNNING', 'RESULT_REVIEW', 'COMPLETED',
                              'REJECTED', 'EXPIRED', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED',
                              'INTERRUPTED')),
        title               TEXT NOT NULL DEFAULT '',
        payload             TEXT NOT NULL DEFAULT '{}',
        version             INTEGER NOT NULL DEFAULT 0,
        round_id            TEXT,
        epoch               INTEGER,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        expires_at          TEXT,
        delivered_at        TEXT,
        approved_at         TEXT,
        started_at          TEXT,
        finished_at         TEXT,
        error               TEXT
      )`,
      'CREATE INDEX tasks_workgroup ON tasks(workgroup_id, created_at)',
      'CREATE INDEX tasks_owner ON tasks(owner_id, state)',
      'CREATE INDEX tasks_requester ON tasks(requester_id)',

      // B's own decision, with the scope B chose. One *live* grant per task: a partial unique
      // index, so a second approval cannot be added on top of a running one while the history of
      // an earlier revoked grant survives.
      //
      // `scope` is the JSON the approval UI produced — allowed resources, capabilities, share
      // policy, expiry. The Hub stores it and hands it back to both sides; it never decides from it
      // (`docs`: Hub records are not authorization; B's local ledger is).
      `CREATE TABLE approvals (
        id                 TEXT PRIMARY KEY,
        task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        approved_by        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        approved_device_id TEXT NOT NULL,
        decision           TEXT NOT NULL CHECK (decision IN ('granted', 'rejected')),
        scope              TEXT NOT NULL DEFAULT '{}',
        version            INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL,
        expires_at         TEXT NOT NULL,
        revoked_at         TEXT
      )`,
      `CREATE UNIQUE INDEX approvals_live_grant ON approvals(task_id)
        WHERE decision = 'granted' AND revoked_at IS NULL`,
      'CREATE INDEX approvals_task ON approvals(task_id, created_at)',

      // The single coordinator of a group (plan §9.5). One row per group is the whole fencing
      // mechanism: `epoch` moves forward on every acquisition, and a round commit that names an
      // older epoch is refused by comparing against this row rather than by trusting a client.
      `CREATE TABLE round_leases (
        workgroup_id     TEXT PRIMARY KEY REFERENCES workgroups(id) ON DELETE CASCADE,
        epoch            INTEGER NOT NULL,
        holder_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        holder_device_id TEXT NOT NULL,
        lease_until      TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      )`,

      // An authorized result file (plan §12, §13.2). It hangs off a task — an artifact without an
      // approval behind it is a file the group never agreed to receive — and it is a different
      // thing from a chat `attachment`: the ACL column is the sharing decision, and only the
      // approval flow can produce one.
      //
      // `blob_path` is a key inside the Hub's own data directory, generated here from the new id.
      // It is NOT a path on anybody's machine and is never returned by an endpoint, exactly like
      // `attachments.storage_key`: the upload carries bytes, and no request can name where a file
      // lands (plan §13.2: "绝不传可直接访问本地目录的绝对路径").
      `CREATE TABLE artifacts (
        id                 TEXT PRIMARY KEY,
        task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        workgroup_id       TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
        owner_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        uploader_device_id TEXT,
        name               TEXT NOT NULL,
        mime               TEXT NOT NULL,
        size               INTEGER NOT NULL,
        hash               TEXT NOT NULL,
        blob_path          TEXT NOT NULL UNIQUE,
        acl                TEXT NOT NULL DEFAULT '[]',
        state              TEXT NOT NULL DEFAULT 'available'
                           CHECK (state IN ('available', 'revoked')),
        created_at         TEXT NOT NULL,
        expires_at         TEXT NOT NULL,
        revoked_at         TEXT
      )`,
      'CREATE INDEX artifacts_task ON artifacts(task_id)',
      'CREATE INDEX artifacts_expiry ON artifacts(expires_at)',
    ],
  },

  {
    // G4 修补：成员归属、Bot 头像与「谁先答」的群设置。
    //
    // 三处都是「两台机器必须看到同一份事实」，所以只能落在 Hub 上：
    //
    //   * `workgroups.reply_mode` —— 原版群有 `mode: 'admin' | 'everyone'`（谁答普通消息），
    //     而 Hub 只存 name/notice，于是两台机器各按自己的默认值决定回合，同一条消息在两台机器上
    //     由不同的成员先答。这是用户报的「同事如果没有点名 @ 其他同事的 bot，跟原群聊一样由管理员
    //     接待」：回合逻辑（`openingSpeakers`）本来就是原版的复制件，缺的是这个设置从没离开过那
    //     台机器。默认 `'admin'`，与原版 `buildRoom` 的默认值一致。
    //
    //   * `bot_endpoints.avatar` —— 形象与颜色的**快照**（JSON `{shape, color, image?}`）。
    //     必须是快照，不能靠对方机器去查：原版 `lookOf()` 用 Bot 自己的 id 派生形象和颜色，而 Hub
    //     名册给的是 `ep_…`，于是同一个 Bot 在别人机器上换了长相——用户报的「每个 bot 的头像是
    //     不能变的，现在是变了」。随发布一并写上，成员行据此还原。只存三项：形状名、调色板名、
    //     头像 data URL；没有路径、没有文件、没有模型名。
    //
    //   * `memberships.bot_role` —— 「每个 bot 的权限由群设置决定」的落点：一个成员 Bot 在本群是
    //     接待者（`lead`）还是普通成员（`member`）。原版群没有这个概念（本地群成员全是自己人），
    //     但工作群去掉「强制管家入群」之后必须另有地方指定谁接待，且两边都要读到同一个值。
    version: 5,
    statements: [
      "ALTER TABLE workgroups ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'admin'",
      'ALTER TABLE bot_endpoints ADD COLUMN avatar TEXT',
      "ALTER TABLE memberships ADD COLUMN bot_role TEXT NOT NULL DEFAULT 'member'",
    ],
  },

  {
    // G4 修补（第二轮）：Bot 权限改用**原版已有的模型**，不发明新概念。
    //
    // v5 给 `memberships` 加过一个 `bot_role`（`lead` / `member`），想用它表达「这个 Bot 在群里
    // 能做什么」。那是我自己造的概念，原版没有，而且它没有写入方，恒为 `'member'`。用户指出方向：
    // 「原版群聊是如何做的，那么工作群和工作群跨用户 bot 也是这么做，只是工作群需要远程同步」。
    //
    // 原版的做法（`src/host/permissions.js`）是**两层的，没有「每个 Bot 的角色」**：
    //
    //   `bot.permission`  —— Bot 自己的预设；
    //   `room.permission` —— 整个群共用一个预设，覆盖每个成员的；
    //   缺席              —— 各成员用自己的（`applyPermission`：`room?.permission ?? bot.permission`）。
    //
    // 工作群早就复制了这一整套，界面也有「Same for every member」那张卡。缺的只是这个值不过 Hub，
    // 于是同事机器上 `room.permission` 是空的，同一个群按两套权限跑。`workgroups.permission` 就是
    // 原版这个字段的远程副本，NULL 表示「各用各的」，与本地群一致。
    //
    // `memberships.bot_role` 随之删除：它描述的语义已经被 `permission` 覆盖，留着只会让人以为还有
    // 第二个权限开关。
    version: 6,
    statements: [
      'ALTER TABLE workgroups ADD COLUMN permission TEXT',
      'ALTER TABLE memberships DROP COLUMN bot_role',
    ],
  },
]

export const LATEST_VERSION = MIGRATIONS.at(-1)?.version ?? 0
