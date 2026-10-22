// Rate limiting: a sliding window in process memory, keyed by what an attacker has to vary
// (a phone number, a peer address) and what the limit protects (failed logins).
//
// In memory is a deliberate V1 limit, recorded in docs/g3/PLAN.md §4.3: a restart clears it
// and a second instance would not share it. A database-backed limiter would put a write on
// the critical path of every failed login, which is a worse trade for one instance.

export function createLimiter({ windowMs, max }) {
  const hits = new Map()

  const live = (key, at) => (hits.get(key) ?? []).filter(time => at - time < windowMs)

  return {
    // Records one attempt for `key`. Returns `{ allowed, retryAfterMs }`, where a refusal
    // also says how long the caller should wait: the age of the oldest attempt still in
    // the window, i.e. the moment a slot frees up.
    hit(key, at = Date.now()) {
      const kept = live(key, at)
      if (kept.length >= max) {
        hits.set(key, kept)
        return { allowed: false, retryAfterMs: windowMs - (at - kept[0]) }
      }
      kept.push(at)
      hits.set(key, kept)
      return { allowed: true, retryAfterMs: 0 }
    },
    // Checks without recording, for a caller that only wants to know whether it is already
    // over the limit (so a successful login does not consume a slot).
    peek(key, at = Date.now()) {
      const kept = live(key, at)
      if (kept.length === 0) return { allowed: true, retryAfterMs: 0 }
      if (kept.length < max) return { allowed: true, retryAfterMs: 0 }
      return { allowed: false, retryAfterMs: windowMs - (at - kept[0]) }
    },
    reset(key) {
      hits.delete(key)
    },
    // Drops windows that no longer contain a live attempt, so an idle process does not keep
    // one entry per phone number it has ever seen.
    prune(at = Date.now()) {
      for (const key of hits.keys()) {
        if (live(key, at).length === 0) hits.delete(key)
      }
    },
    get size() {
      return hits.size
    },
  }
}

// Two windows per rule, because the two keys answer different questions: the per-phone one
// stops a targeted guessing run, and the per-address one stops a single client from working
// through a list of numbers.
export function createLimiters({ now = () => Date.now() } = {}) {
  return {
    loginByPhone: createLimiter({ windowMs: 15 * 60 * 1000, max: 10 }),
    loginByIp: createLimiter({ windowMs: 15 * 60 * 1000, max: 30 }),
    registerByIp: createLimiter({ windowMs: 60 * 60 * 1000, max: 5 }),
    // A recovery attempt is an offline-verifiable guess: an attacker with a stolen phone number
    // could otherwise grind codes. Tighter than login because a legitimate person recovers about
    // once a year, and a 16-character code from a 32-letter alphabet is not guessable anyway —
    // the limit exists to make attempts visible rather than to be the only defence.
    recoverByPhone: createLimiter({ windowMs: 60 * 60 * 1000, max: 5 }),
    recoverByIp: createLimiter({ windowMs: 60 * 60 * 1000, max: 10 }),
    now,
  }
}
