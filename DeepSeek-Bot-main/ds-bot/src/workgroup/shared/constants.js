// Constants that belong to the Workgroup domain only. Nothing here replaces or
// shadows a value in ../host/constants.js: the original plugin keeps its own
// values untouched, and every Workgroup value that must not be confused with the
// original one is declared here with its own name.

// The `source.kind` of a UserMessage this domain writes, and the only kind it
// consumes. It must differ from the original SOURCE_KIND ('bot'), or the original
// turns/delivery/handoff listeners would treat Workgroup events as their own.
export const WG_SOURCE_KIND = 'workgroup'

// Every tool this domain registers. `workgroup_` keeps clear of the original
// `group_relay` / `read_group_chat`, and TEAM_TOOLS in ../host/constants.js stays
// the sole list of the original tools.
export const WG_TOOLS = {
  relay: 'workgroup_relay',
  readChat: 'read_workgroup_chat',
  // The original registers read_own_chat alongside read_group_chat, and the round prompt
  // tells a member it may look at its own chat, so this domain needs the tool too.
  readOwn: 'workgroup_read_own_chat',
  // The original's `post_to_group`, copied for this domain (§5.1 lists the group tool set as
  // an A-class copy). It is also the only producer of a post's `sub`, the work a poster waits
  // on, so without it a workgroup hand-off could never be closed.
  post: 'workgroup_post',
}

// A Workgroup RPC route of its own: /api/bot belongs to the original channel.
export const WG_ROUTE = '/api/workgroup'

// Workgroup state lives in a file of its own, next to the original state.json,
// so one domain can never rewrite the other's data.
export const WG_STATE_FILE = 'state.json'
export const WG_DIR = 'workgroup'
export const WG_STATE_VERSION = 1

// The room log and its per-line files. Same shape as the original limits so the
// chat looks and behaves the same, but kept here so tuning one domain cannot
// change the other.
export const WG_LOG_MAX = 60
export const WG_FIRST_LOOK = 12
export const WG_DELTA_MAX = 24
export const WG_LINE_READ = 20_000
export const WG_TEXT_KEPT = 2000
export const WG_READ_MAX = 30

// Member kinds. A remote member is a real person on another device; it is never
// turned into a local Session.
export const WG_MEMBER_KINDS = ['localBot', 'remoteBot', 'user']

// COPY OF THE ORIGINAL (`ROOM_MODES`, src/host/constants.js:53). The two ways a group
// decides who answers. Kept here for the same reason as the round limits below: the
// admin/notice/mode rules a workgroup enforces must not drift when the original's are
// tuned, and a workgroup record's `mode` is written by this domain alone.
export const WG_ROOM_MODES = ['everyone', 'admin']

// COPY OF THE ORIGINAL (`checkMembers`, src/host/roster.js:312) and the limit it enforces
// (`ROOM_MAX_MEMBERS`, src/host/constants.js:56). A group is a conversation: one member is
// not one (there is nobody to answer), and an unbounded list would let a single message fan
// out into an arbitrary number of model turns.
//
// This domain copied `createRoom`/`updateRoom` but not this check, so it built a
// "workgroup" with one member — and with none at all — while a local group refuses both.
// Found by diffing the two domains' function inventories, not by a failing test.
export const WG_ROOM_MIN_MEMBERS = 2
export const WG_ROOM_MAX_MEMBERS = 12

// Round limits, copied one-for-one from ../host/constants.js so a workgroup round
// behaves exactly like a local group's round. They live here for the same reason as
// the log limits above: tuning one domain must never change the other.
//
// A member has this long to answer a round turn before the round goes on without it.
export const WG_REPLY_TIMEOUT_MS = 240_000
// A member still at work this long after its first tool call lets the round go on.
export const WG_WORK_GRACE_MS = 15_000
// Answers a round gives to what members post after the round moved on.
export const WG_LATE_ROUNDS = 10
// Lines a member writes closer together than this are posted as one message.
export const WG_STEP_GAP_MS = 30_000
// Turns a round may run beyond its opening speakers, by who is admin.
export const WG_EXTRA_TURNS = 4
export const WG_ADMIN_EXTRA_TURNS = 4
// How often one member may be called again inside a round.
export const WG_TURNS_EACH = 2
export const WG_ADMIN_TURNS_EACH = 4
// How often the group list asks the Hub which groups this account is in. `state` is polled, so this
// keeps a poll from becoming Hub traffic while staying far below the time a missing group would go
// unnoticed.
export const WG_ADOPT_INTERVAL_MS = 60_000
