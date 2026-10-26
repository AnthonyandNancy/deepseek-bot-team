# Workgroup relay and Continue baseline (2026-10-26)

- Upstream baseline: DS-Bot v0.2.2 (zip commit `de55888a93983fc51c94f7d22bc94b4f8293205d`).
- Local plugin version: 0.2.8 (not downgraded).
- The original `src/host/groups.js` now has `defaultRelayLimit`, `relayLimit`, `room.paused`, and `continueRoom`.
- The workgroup copy in `src/workgroup/host/groups.js` mirrors those semantics: Bot-origin slots consume relays, a slot past the limit is parked in `room.paused`, a user message resets relays and resumes parked calls, and Continue resumes through the group Session.
- The workgroup transport adds only `continue-room` and `group.continue`; it does not add a second memory or round store.
- `client.js` is rebuilt from `src/client/` and `src/workgroup/client/`; run `npm run build` and commit both.
- Known test cleanup: a few Hub/WebSocket tests leave a handle and need `--test-force-exit`; assertions pass.
