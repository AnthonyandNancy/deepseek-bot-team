# Workgroup AI Hub

The server side of this repository: Hub accounts, device keys, and the WebSocket endpoint the
Bot plugin connects to.

**G3 scope only.** Accounts, devices, TLS, and a minimal WSS whose one job is to prove that a
revoked device is disconnected at once. There is no workgroup, no message persistence, and no
event fan-out here yet — that is G4.

## Running it

```bash
cd hub
npm install
npm start
```

It will refuse to start without TLS, which is deliberate (see below). For local development:

```bash
# 1. A local certificate. Any self-signed one with an IP SAN works.
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout key.pem -out cert.pem -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1"

# 2. Start with it.
HUB_TLS_CERT=./cert.pem HUB_TLS_KEY=./key.pem npm start
# → {"event":"hub.ready","url":"https://127.0.0.1:7788"}
```

Or, for a throwaway loopback instance with no certificate at all:

```bash
HUB_ALLOW_INSECURE_LOCALHOST=1 npm start
```

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `HUB_HOST` | `127.0.0.1` | Bind address. Forced to loopback when running without TLS. |
| `HUB_PORT` | `7788` | Listen port. |
| `HUB_TLS_CERT` | — | Path to the certificate. Must be set together with `HUB_TLS_KEY`. |
| `HUB_TLS_KEY` | — | Path to the private key. |
| `HUB_ALLOW_INSECURE_LOCALHOST` | — | Set to exactly `1` to allow plaintext **on loopback only**. |
| `HUB_DATA_DIR` | `hub/.data` | Directory holding `hub.db`. |
| `HUB_ACCESS_TTL` | `1800` | Access token lifetime, in seconds. |
| `HUB_REFRESH_TTL` | `2592000` | Refresh token lifetime, in seconds (30 days). |

### Why TLS is mandatory

V1 authenticates with a **password**, not a one-time code. A one-time code that is intercepted
is spent; a password that is intercepted is a permanent credential, and people reuse them. So
the Hub refuses to start without a certificate unless you explicitly opt in to plaintext, and
even then it refuses every request whose peer is not this machine — checked per request, not
only at startup, because a listener can end up reachable through a proxy or a container bridge
after it starts.

The opt-in is the exact string `1`. `true`, `yes`, and `TRUE` all leave it off: a typo must not
silently start a plaintext server.

## Endpoints

All responses are JSON. Errors are `{ "error": { "code": "…", "message": "…" } }` with a
matching status.

```
GET  /v1/health                  unauthenticated: is it up, and is it TLS?

POST /v1/auth/register           { phone, password } → 201 { hubUserId, phoneMasked, accessToken, … }
POST /v1/auth/login              { phone, password } → 200 same shape
POST /v1/auth/refresh            { refreshToken }    → 200 { accessToken, refreshToken, … }
POST /v1/auth/logout             Bearer access       → 204
GET  /v1/auth/me                 Bearer access       → 200 { hubUserId, phoneMasked, session, devices }

POST /v1/auth/password           Bearer access + { currentPassword, newPassword } → fresh session
POST /v1/auth/recover            { phone, code, password } → 200 fresh session
GET  /v1/auth/recovery-code      Bearer access       → { hasCode, count, createdAt }
POST /v1/auth/recovery-code      Bearer access       → 201 { code }   ← the only time it is visible

POST /v1/devices/challenge       { publicKey }       → { challengeId, nonce, expiresAt }
POST /v1/devices/register        { challengeId, signature, name, platform } → { deviceId }
GET  /v1/devices                                     → { devices: […] }
POST /v1/devices/:id/revoke                          → the device's sockets close at once

WSS  /v1/ws?deviceId=&ts=&nonce=&sig=   (Authorization: Bearer <access>)
```

## Accounts: a phone number is a login name, not a verified identity

This is the most important thing to understand about this Hub.

**No SMS is ever sent.** The phone number is accepted at registration and used to log in, and
that is all. Consequences, which are requirements rather than observations:

* `users.phone_verified_at` is **always NULL**. Nothing in this codebase, its responses, or its
  documentation may call a number verified. There is no "verified" badge because there is
  nothing to badge.
* The number is never returned in full. Responses carry `phoneMasked` (`+86****8000`). Other
  users, workgroups, and every API see `hubUserId` and only `hubUserId` — a phone number is
  never a cross-user address.
* Password recovery exists and takes **three** forms, because there is no verified channel to
  prove ownership through — see the "Password recovery" section below.

### Password storage

`scrypt` from `node:crypto`, one PHC-style string per user:
`$scrypt$N=32768,r=8,p=1$<salt>$<hash>`, with a 16-byte random salt per user.

`maxmem` is passed explicitly (`64 MiB`). This is not tuning: Node's default limit rejects
N=32768 with `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`, measured on Node 24. If that option is ever
removed, every registration starts throwing.

Verification uses `timingSafeEqual`. The policy is a 10-character minimum and a 128-byte cap,
and the password may not be the phone number. There is deliberately **no** character-class
requirement: composition rules push people toward `Password1!`, which is shorter and more
guessable than a passphrase.

Nothing reversible is stored, and no plaintext password is ever logged — request bodies are not
logged at all.

### Account enumeration

Two different choices, for two different reasons:

* **Login failures are indistinguishable.** An unknown phone, a wrong password, and a suspended
  account all return the same `auth/invalid-credentials`, the same message, the same status,
  and the same amount of work. When no user matches, a dummy scrypt verification runs anyway —
  without it an unknown number would answer in microseconds and a known one in ~50 ms, which is
  a free account oracle.
* **Registration tells you when a number is taken.** The alternative — pretending to succeed —
  leaves a person unable to log in with no way to find out why. This endpoint is rate-limited
  and audited, so enumeration is expensive rather than impossible. That is the trade.

## Tokens

Opaque random strings (`dsb_at_…`, `dsb_rt_…`), not JWTs. The gate requires revocation to take
effect immediately; a signed self-contained token cannot be withdrawn without a revocation list,
which is the session table this Hub already needs.

Only a SHA-256 digest is stored. A 256-bit random token cannot be brute-forced, so a fast digest
is right here — a password-style slow hash would add ~50 ms to every authenticated request for
no security gain.

Refresh tokens **rotate**: both halves are replaced in one statement, so a presented refresh
token is spent the moment the call returns, and replaying it finds no row.

Access tokens last 30 minutes and refresh tokens 30 days by default.

## Password recovery

There is no SMS and no email, so nothing can prove that a phone number belongs to the person
claiming it. Recovery therefore relies on **something the user already holds**, in three layers.
Each layer covers the others' blind spot.

| Layer | Requires | Use when |
|---|---|---|
| `POST /v1/auth/password` | a session **and** the current password | the ordinary case: changing a password you know |
| `POST /v1/auth/recover` | a recovery code | the machine is gone: stolen, re-installed, disk died |
| `node src/cli.js reset` | the phone number **and** the database file | the user holds nothing at all |

All three end every other session and revoke every device. That is the point of a recovery:
whoever had access before must lose it. The first two return a fresh session, so recovering on a
new machine leaves you signed in there.

### Recovery codes

Created from the account page while signed in — **not** at registration, so signing up stays a
two-field form.

```
XXXX-XXXX-XXXX-XXXX
```

* 16 characters from a 32-symbol alphabet with `I`, `O`, `0` and `1` removed, so a hand-copied
  code does not fail on an ambiguous character.
* Hyphens and spaces are cosmetic: the canonical form has neither, so however it is typed it
  matches.
* **Shown exactly once.** Only an scrypt digest is stored, which is why the Hub cannot display it
  again — and why the page says so.
* **Single use.** The code is spent in the same transaction that changes the password, so a crash
  cannot leave a working code behind.
* Hashed with **scrypt**, not the fast digest used for session tokens: a recovery code is a
  long-lived secret a person writes down, so it gets password-strength hashing.

Creating a new code does not invalidate an old one. Each works once.

### The operator command

```bash
cd hub
node src/cli.js show  --phone +8613800138000
node src/cli.js reset --phone +8613800138000 --password 'a long new password'
```

**Deliberately not an endpoint.** It requires the phone number *and* filesystem access to the
Hub's database — the same authority as editing that database by hand. Over HTTP it would be a back
door whose only protection is a password, on the one endpoint that controls every password.

The password is never echoed back, and every reset is recorded in `audit_events` as
`auth.password-reset-operator`, so "my password changed and I did not do it" is answerable.

## Devices

A device is an Ed25519 key pair; the Hub stores only the public half.

1. `POST /v1/devices/challenge` with the public key → a one-time nonce.
2. `POST /v1/devices/register` with a signature over `<challengeId>.<nonce>` → a `deviceId`.

A challenge is deleted before its signature is checked, so a captured signature cannot be
replayed. Re-registering a known key is idempotent (a reinstall keeps its identity). A **revoked
key cannot come back** — the client must mint a new pair, which is what makes revoking a leaked
key meaningful.

Revoking a device also ends that device's sessions, including its refresh token.

## WebSocket

G3 has exactly one WSS behaviour: **a revoked device is disconnected at once**.

The handshake proves possession of the device key, not just the bearer token: the client signs
`<deviceId>.<timestamp>.<nonce>`, the timestamp must be within ±120 s, and the nonce is
single-use. A stolen access token alone therefore cannot open a socket as a device whose key it
does not hold.

Close codes:

| Code | Meaning |
|---|---|
| 4401 | The device was revoked. |
| 4402 | Bad authentication or a bad signature. |
| 4403 | A message type G3 does not implement. |
| 4404 | A stale or replayed handshake. |

There is no message fan-out — a business message is answered with `{ type: "error", code:
"unsupported" }` rather than silently dropped, so a G4 client does not read it as a delivery
failure.

## Rate limiting

In process memory, sliding window:

| Rule | Limit |
|---|---|
| login, per phone number | 10 failures / 15 min |
| login, per address | 30 failures / 15 min |
| register, per address | 5 / hour |
| recover, per phone number | 5 / hour |
| recover, per address | 10 / hour |

A restart clears them and a second instance would not share them. That is an accepted V1 limit
for a single instance; a database-backed limiter would put a write on the path of every failed
login.

## Logging

One JSON object per line. Two rules, enforced in `src/log.js` rather than trusted to callers:

* **Request bodies are never logged.** The password and the phone number are in bodies.
* **Secrets are redacted by field name**, not by guessing at shapes: `password`, `token`,
  `accessToken`, `refreshToken`, `privateKey`, `signature`, and `authorization` become
  `[redacted]` wherever they appear. Free text is additionally scrubbed for E.164 numbers and
  `dsb_`-prefixed tokens, which is where a leak actually happens (an error message that quotes
  one).

The access log carries no identity at all. The **audit trail** (`audit_events`, in the database)
is the record of who did what, and it holds a *masked* phone (`+86****8000`) so one account can
be followed without the table becoming a list of everyone's numbers. Neither ever contains a
password, a token, or a device private key.

## Database

SQLite through Node's built-in `node:sqlite` — the Hub's only dependency is `ws`. WAL, foreign
keys on, `busy_timeout=5000`.

G3 creates six tables: `users`, `auth_sessions`, `devices`, `audit_events`, `recovery_codes` and
`password_resets` (the last two from migration 2, which added password recovery). Two absences are
deliberate:

* **`otp_challenges` does not exist.** V1 has no OTP. An empty table would invite someone to
  implement the flow later without the SMS gateway the gate requires.
* **Section 12's other twelve tables do not exist.** Their columns would be guesses until G4
  writes the queries that read them, and an empty table reads as "done" to the next person.
  Migrations are versioned, so G4 starts at version 2.

## Known gaps

| Gap | Stage |
|---|---|
| Phone numbers are unverified (`phone_verified_at` is always NULL) | By decision |
| A recovery code is a bearer secret: anyone who reads the paper can take the account | Inherent to the design |
| No notification when a password is recovered — the owner learns on next sign-in | G4 (needs a channel) |
| Rate limits are in memory: cleared by a restart, not shared between instances | Before production |
| No refresh-token family revocation (reuse of an old refresh token revokes only that row, not the family) | Evaluate before G4 |
| Device challenges are in memory, so a Hub restart invalidates them (the client just asks again) | Accepted |
| WSS has no message fan-out | G4 |

## Tests

```bash
npm test
```

111 tests, no network beyond loopback. They drive a real HTTP server and real WebSocket clients
rather than mocking the Hub's own internals, because the properties that matter — a revoked
device is actually disconnected, a password is actually never logged — are properties of the
assembled service.

The TLS tests use `test/fixtures/test-cert.pem` with an explicit `ca`, so trust is real and no
`NODE_TLS_REJECT_UNAUTHORIZED=0` appears anywhere in this repository.
