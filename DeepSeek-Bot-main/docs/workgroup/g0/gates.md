> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g0/gates.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G0 Verification Gates — ds-bot v0.1.7 fork (`ds-bot/`)

All exit codes below are **observed**, captured with an explicit `echo "EXITCODE=$?"` appended
to the end of each log file. Platform: Windows 10 (Git Bash shell driving `npm`/`node`).

Scope-invalidity warning: `npm run lint` (last row) is **not** a valid code-quality gate in this
copy. `ds-bot/` is not a git repository, so oxlint 1.76.0 cannot apply `.gitignore` and lints
`dev/harness/node_modules/**` (third-party code). Its 20745 errors are bogus — see the
scoped / `--ignore-pattern` rows, which report 0 errors.

| Gate | Command | Exit code | PASS/FAIL/BLOCKED | Evidence file | Note |
|---|---|---|---|---|---|
| `npm ci` | `npm ci` | 0 | PASS | `docs/workgroup/g0/logs/npm-ci.log` | "added 2 packages in 1s"; warns esbuild postinstall not covered by allowScripts (npm warning only, not a failure). |
| `npm run harness` | `npm run harness` | 0 | PASS | `docs/workgroup/g0/logs/npm-run-harness.log` | Installs `dev/harness` (`npm install --prefix dev/harness --legacy-peer-deps=false --no-package-lock --no-fund --no-audit`). Ends with allowScripts warnings for node-pty/protobufjs/esbuild; exit 0. |
| `npm run build` | `npm run build` | 0 | PASS | `docs/workgroup/g0/logs/build.log` | Runs `node scripts/build-client.mjs`. client.js SHA256 unchanged across the run: `2e2df9be…669b` before and after. |
| `build-client --check` | `node scripts/build-client.mjs --check` | 0 | PASS | `docs/workgroup/g0/logs/build-check.log` | Passes silently — by design this mode prints nothing on success and exits 0; nonzero would print `client.js is stale: …`. No CRLF/staleness false positive occurred. |
| `npm test` | `npm test` | 0 | PASS | `docs/workgroup/g0/logs/test.log` | node:test runner: `tests 635 / pass 635 / fail 0 / cancelled 0 / skipped 0 / todo 0`. The `[ds-bot] … failed:` lines are expected negative-path output from passing tests, not failures. |
| `npm run lint` (scoped) | `node dev/harness/node_modules/oxlint/bin/oxlint -c .oxlintrc.json index.js web-search.js src scripts test dev/characters.mjs dev/*.mjs` | 0 | PASS | `docs/workgroup/g0/logs/lint-scoped.log` | **Found 13 warnings and 0 errors.** 184 files. First-party only: excludes `dev/harness`. |
| `npm run lint` (as invoked by script) | `npm run lint` | 1 | BLOCKED (scope-invalid) | `docs/workgroup/g0/logs/lint.log` | **Found 29206 warnings and 20745 errors** over 20167 files. Not a real code signal: without `.git`, oxlint ignores no `dev/harness/node_modules/**`. Superseded by the two scoped runs. |

## Corroborating scoped run

`node dev/harness/node_modules/oxlint/bin/oxlint -c .oxlintrc.json --ignore-pattern "dev/harness/**" index.js web-search.js src dev scripts test`
→ **Found 13 warnings and 0 errors**, exit 0, 196 files — `docs/workgroup/g0/logs/lint-ignore-flag.log`.
`--ignore-pattern` **is** supported by oxlint 1.76.0 and is a drop-in fix for `scripts/lint.mjs`.

The 12-file delta (196 vs 184) comes from `dev/desktop-linux/*.mjs`/`*.mts`, which the
`dev/*.mjs` glob does not match. That directory was linted separately to close the gap:
`node dev/harness/node_modules/oxlint/bin/oxlint -c .oxlintrc.json dev/desktop-linux`
→ **Found 0 warnings and 0 errors**, 13 files. So all first-party dev files are clean at 0 errors.

## client.js integrity vs upstream

`ds-bot/client.js` is **byte-for-byte identical** to `解压出的快照目录/client.js`
(850,958 bytes; SHA256 `2e2df9be58def2d2fb8ac1bbf213efbcfdce6d73f91b6d53a19612c6592b669b` on both).
Verified twice — before and after `npm run build` — with `fc /b` ("no differences encountered",
`FC_EXITCODE=0`) and independently with `cmp` (exit 0). No restore was needed; the upstream copy
was not modified.
