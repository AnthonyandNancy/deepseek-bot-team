> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g0/G0-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G0 执行报告：环境、锁版、完整源码审计

日期：2026-10-21 · 基线：Fei2411/DeepSeek-Bot `v0.1.7` @ `939a663` · 范围：**G0 only**

> 本报告只陈述**实际观测到的证据**。凡未验证项均显式标为 UNVERIFIED 或 BLOCKED。
> 本报告**不**声明 G1–G6 任何门禁通过，也**不**声明 V1 验收通过。

---

## 0. 一句话结论

G0 的**代码、环境与"原版可运行"三项门禁均 PASS**。唯一未达成的是 **DSH 精确 commit SHA 锁定**（只能锁到发布版本号），以及 `npm run lint` 脚本原样调用因缺少 `.gitignore` 而 scope-invalid（first-party 源码 0 error，已用两种独立方式证明）。

| 门禁 | 结论 |
|---|---|
| 锁版（DS Bot 完整 SHA + 许可） | **PASS** |
| 两目录骨架 + 原版完整 Fork | **PASS** |
| 原版构建 / 测试 / lint（真实执行） | **PASS** |
| 真实 DSH 冷启动原版 Bot（0.2.1-rc.2 + 0.2.1-rc.2） | **PASS** |
| DSH 精确 commit SHA | **BLOCKED（仅锁到版本号）** |
| groups.js 依赖与注册审计 + A/B/C 清单 | **PASS** |
| 全局调用扫描（工具/监听器/Session/UI Slot） | **PASS** |
| G1 计划与回归测试设计 | **PASS** |

---

## 1. 已验证的完整版本 SHA 与环境

### 1.1 DS Bot（可精确锁定）

| 项 | 值 | 证据 |
|---|---|---|
| 仓库 | `https://github.com/Fei2411/DeepSeek-Bot.git` | `.g0-work/upstream/.git/config` |
| 标签 | `v0.1.7` | `.g0-work/upstream/.git/packed-refs` 第 22 行 |
| **完整 commit SHA** | **`939a6635830cb5b246e7dd19c67b0e1352ad1c07`** | `packed-refs`：`939a6635…1c07 refs/tags/v0.1.7`；`.git/HEAD` 指向同一 SHA |
| 短 SHA | `939a663` | 与方案第 7 行所述发行页短 SHA **完全一致** → 基线核对通过 |
| 包版本 | `ds-bot@0.1.7` | `ds-bot/package.json` |
| 许可 | Apache-2.0 | `ds-bot/LICENSE`、`LICENSE-REPO-ROOT`、`NOTICE` 三份完整保留 |

### 1.2 DSH（只能锁到版本号，SHA 未获得）

| 项 | 值 | 用途 |
|---|---|---|
| `0.2.1-rc.2` | 上游**明确测试**的版本（`dev/harness/package.json` 固定；README 声明；CI 主矩阵） | 测试基线 |
| `0.2.1-rc.2` | 本机 DSH Desktop 实际运行时（`.g0-work/desktop-runtime.json`） | 生产目标 |
| `hostProtocolVersion` | `4` | 协议兼容 |
| DSH 期望 Node / pnpm | `24.21.0` / `11.28.5` | 见 §1.3 偏差 |

> **DSH commit SHA = UNVERIFIED**。`@deepseek-ai/dsh` 以 npm tarball 分发，本地无 `.git`，网络受限（`github.com`、`api.github.com`、`registry.npmjs.org` 均解析到非公网 IP，`web_fetch` 被拒）。因此**只能锁发布版本号**。这与方案 §17「DSH 兼容 commit SHA 是实施前必须落地的运行参数」的要求**尚差一项**，如实记录为未完成。

### 1.3 本机环境与偏差（不掩盖）

| 项 | 值 |
|---|---|
| Node | `v26.7.0` |
| npm | `11.19.0` |
| pnpm | `10.34.5` |
| git | `2.55.0.windows.2` |
| OS | `Microsoft Windows NT 10.0.26100.0`（Windows 10.0.26100） |
| 记录时间 | `2026-10-21T03:11:07Z` |

| 偏差 | 影响（必须记住） |
|---|---|
| Node 26 vs DSH 期望 24 | **跨 2 个 major**。上游 CI 只测 Node 22/24，**从未测过 26**。635 测试在 26 上通过是正面信号，但不能推断原生模块（`node-pty`、`koffi`、`node-addon-system`）在 Desktop 内同样正常。 |
| pnpm 10.34.5 vs 11.28.5 | 仅影响"以 Desktop 方式装插件"的复现；本仓库构建用 npm，不受影响。 |
| Windows vs 上游 ubuntu 为主 | 上游 CI 含 `windows-latest` 一条（Node 24 + dsh 0.2.1-rc.2），Windows 路径**被覆盖过一次**，但组合不同。 |

---

## 2. 两个一级目录的结构

仓库根（`D:\code\ai\DeepSeek-Bot\`）**只有**两个一级代码目录，无 `bridge/`、`protocol/`、`ui/`、`client/`、`shared/` 等第三工程。

```text
D:\code\ai\DeepSeek-Bot\
├── hub/                     ← 一级目录一（G0 仅骨架，无业务代码）
│   ├── README.md
│   ├── package.json          {"name":"workgroup-ai-hub","version":"0.0.0","private":true,"type":"module"}
│   ├── src/.gitkeep
│   └── test/.gitkeep
├── ds-bot/              ← 一级目录二（完整 Fork 的 ds-bot v0.1.7）
│   ├── index.js             Host 唯一入口（export name/inject/apply/createRuntime）
│   ├── client.js            浏览器产物（850,958 B，与上游字节一致）
│   ├── web-search.js
│   ├── cordis.patch.yml     dsh.bundle.patch
│   ├── package.json         ds-bot@0.1.7, Apache-2.0
│   ├── package-lock.json    sha256 3b2fcb64…bace7
│   ├── LICENSE                     ← 上游 ds-bot/LICENSE（Apache-2.0 全文）
│   ├── LICENSE-REPO-ROOT           ← 上游根 LICENSE（同内容，未覆盖包内许可）
│   ├── NOTICE                      ← 上游根 NOTICE（71 行）
│   ├── README.md
│   ├── .npmrc / .oxlintrc.json / .gitattributes
│   ├── src/host/     (34 文件)
│   ├── src/client/   (58 文件)
│   ├── src/shared/   (mentions.js)
│   ├── test/         (79 测试文件 + fixtures + fake-ctx.js + harness-resolve.mjs)
│   ├── dev/          (harness/、mock-llm.mjs、desktop-linux/、bench.sh…)
│   ├── scripts/      (build-client.mjs、lint.mjs)
│   ├── node_modules/ (安装产物)
│   └── docs/workgroup/g0/      ← 本次新增（不覆盖任何上游文件）
└── (非代码目录) .g0-work/  Workgroup-AI/
```

### 2.1 原版源码与许可完整保留（可核对）

| 核对项 | 结果 |
|---|---|
| 上游 `ds-bot/` 文件数 | **217** |
| 复制到 `ds-bot/` 的源文件数 | **217**（含 `.npmrc`、`.oxlintrc.json`、`.gitattributes` 等 dotfile） |
| 追加的许可文件 | 2（`LICENSE-REPO-ROOT`、`NOTICE`） |
| 对上游文件的修改 | **0**（`ds-bot/` 内所有上游文件保持原字节） |
| `client.js` 字节一致性 | sha256 `2e2df9be58def2d2fb8ac1bbf213efbcfdce6d73f91b6d53a19612c6592b669b`，与 `解压出的快照目录/client.js` **完全相同**（`fc /b` 无差异、`cmp` exit 0），且在 `npm run build` **前后**均未变 |

> 说明：`ds-bot/` 子包自带 `LICENSE`，仓库根另有 `LICENSE`+`NOTICE`。二者 LICENSE 内容相同，NOTICE 仅存在于根。为同时满足"Fork 保留上游许可"与"不覆盖插件包内许可"，根 LICENSE 以 `LICENSE-REPO-ROOT` 并列保存，NOTICE 置于 `ds-bot/NOTICE`。三份均未被修改或删除。

---

## 3. 构建 / 测试 / lint 的真实命令与输出

全部在 `ds-bot/` 下执行；退出码由显式 `echo "EXITCODE=$?"` 捕获后写入日志。

| # | 命令 | 退出码 | 关键真实输出 | 日志 |
|---|---|---|---|---|
| 1 | `npm ci` | **0** | `added 2 packages in 1s`（仅 esbuild 构建工具） | `docs/workgroup/g0/logs/npm-ci.log` |
| 2 | `npm run harness` | **0** | `added 574 packages in 1m`；安装 `@deepseek-ai/dsh@0.2.1-rc.2` + jsdom 29.1.1 + oxlint 1.76.0 | `logs/npm-run-harness.log` |
| 3 | `npm run build` | **0** | `node scripts/build-client.mjs`；client.js sha256 前后不变 | `logs/build.log` |
| 4 | `node scripts/build-client.mjs --check` | **0** | 成功时**按设计无输出**；失败会打印 `client.js is stale: …` | `logs/build-check.log` |
| 5 | `npm test` | **0** | `ℹ tests 635 / ℹ pass 635 / ℹ fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 7366.9` | `logs/test.log` |
| 6 | oxlint（first-party scoped） | **0** | `Found 13 warnings and 0 errors.` / 184 files | `logs/lint-scoped.log` |
| 7 | oxlint（`--ignore-pattern "dev/harness/**"`） | **0** | `Found 13 warnings and 0 errors.` / 196 files | `logs/lint-ignore-flag.log` |
| 8 | `npm run lint`（脚本原样调用） | **1** | `Found 29206 warnings and 20745 errors.` / 20167 files | `logs/lint.log` |

### 3.1 关于第 8 行（必须如实说明，不得当作通过）

`npm run lint` 退出 1，但**这不是本插件源码的缺陷**：

- `ds-bot/` 不是 git 仓库（复制时未带 `.git`），oxlint 无法应用 `.gitignore`；
- `scripts/lint.mjs:23` 把字面目录 `dev` 传给 oxlint，于是它递归进了 `dev/harness/node_modules/**`（openai、@deepseek-ai/dsh-* 等第三方代码）；
- 20745 个 error 全部来自第三方文件。第 6、7 行用两种独立方式排除该目录后均为 **0 errors**。

**处置**：G0 **不修改上游代码**。此项记为 **BLOCKED（scope-invalid）**，并给出已验证的最小修复方案（G1 执行）：在 `scripts/lint.mjs` 增加 `--ignore-pattern "dev/harness/**"`（已验证 oxlint 1.76.0 支持，结果与 scoped 完全一致），或在 `ds-bot/` 增补 `.gitignore`。二者都属对上游的**有意偏离**，需在 G1 的 `diff-manifest.md` 中登记原因。

---

## 4. groups.js 审计结论摘要

完整版见 **`docs/workgroup/g0/source-audit.md`**（含逐文件 A/B/C 清单、23 个工具、注册点清单、20 条 P0 风险、12 张复用测试表）；逐引用点的四类分类（本地群独有 / 工作群独有 / 通用一次 / 危险待核验，含调用者、被调对象、注册次数、卸载行为、测试用例）见 **`docs/workgroup/g0/reference-classification.md`**；方案 §5.4 五条 `rg` 的**原始输出**见 `docs/workgroup/g0/scans/s1…s5`（匹配数分别 **110 / 76 / 70 / 83 / 27**）。

核心结论：

1. `groups.js` 的直接 import 只有 **10 条**，且 8 条是纯函数/平台 API，真正需要隔离的只有 `SOURCE_KIND`、`GROUP_REF/output` 两项。
2. **真正的耦合在 `rt.*` 隐式依赖**：`groups.js` 依赖 40+ 个由 `index.js` 的 `MODULES` 顺序注入的 `rt` 字段与 9 个自建 `rt.*` 方法。
3. **A 类（复制）**：`host/groups.js`、`client/group-settings.js`、`client/member-status.js`、`client/cells.js` 群气泡部分、`client/details-drawer.js`。
4. **B 类（公共改造，只改一次）**：`store.js`（身份索引）、`turns.js`（单点域分发）、`tools.js`（guard/域检查）、`folders.js`（cwd fail-closed）、`permissions.js`、`prompt.js`、`channel.js`、`constants.js`、`settings.js`（Hub 账号页）、`client/index.js`（Slot）。
5. **C 类（复用不重装）**：`text.js`、`shared/mentions.js`、`secrets.js`（`tools/execute` 脱敏）、`agents.js`、`capabilities.js`、以及全部视觉/主题/i18n 模块。
6. **绝不复制**：`turns.js`、`resume.js`、`parts.js`、`approvals.js`、`store.js`——复制会产生第二套 `live` 状态、二次包装 `rt.deliver`、重复 `session/event` 监听。

### 4.1 六类风险的直接证据

| 风险 | 证据位置 | 结论 |
|---|---|---|
| 重复安装 | `index.js:44` `MODULES` 29 项；`test/install.test.js:32` 逐条断言 **71 项注册顺序** | 任何重复 install 立刻被测试捕获 |
| 工具名冲突 | 23 个 `ctx.tools.register`；`group_relay`/`read_group_chat` 在 `groups.js:489/637` | 工作群必须改名 `workgroup_*` |
| 消息双投递 | 3 处 `ctx.on('session/event')`：`turns.js:349`、`tools.js:616`、`resume.js:131` | 必须单点 `resolveSessionOwnerStrict` 分流 |
| Session Part 切换 | `parts.js:646-649` `placeOf`/`currentOf` 经 `groupOwners`；`groups.js:333` `waitersOf` 用 `groupOwners` 兜底 | 工作群 Part 切换会让原版找不到归属 |
| 工作目录回退 | `roster.js:51-53`：目录不存在时 `rt.warn(... starts in the team workspace)` 并**静默改用团队目录** | **P0**：远程任务可能落在 B 的团队目录 |
| 共用 Waiter/Inbox | `turns.js:77-82` 三张 Map，`Object.assign` 到 `rt` | 工作群必须用 `wg.roomWaiters/roomProgress/roomInbox` |

---

## 5. 真实 DSH 冷启动（已实证：插件装载成功，主模型轮次未测）

### 5.1 证据链（全部本人独立复核，非子任务转述）

| 步骤 | 结果 | 证据 |
|---|---|---|
| 安装 `@deepseek-ai/dsh@0.2.1-rc.2` 到隔离目录 | exit **0**，`added 536 packages in 58s` | `logs/dsh-install-0.2.1-rc.2.log` |
| 安装 `@deepseek-ai/dsh@0.2.1-rc.2` 到隔离目录 | exit **0**，`added 611 packages in 1m` | `logs/dsh-install-0.2.1-rc.2.log` |
| 解析版本与 bin | `0.2.1-rc.2` / `0.2.1-rc.2`，bin 均为 `{"dsh":"lib/bin.js"}` | `logs/dsh-versions.txt` |
| CLI 能力发现 | `dsh [--profile] <name>`、`dsh plugin --profile <name> <pnpm-args…>`、`dsh <profile> headless`、`--dump-config` | `logs/dsh-help.txt` |
| 把本地 `ds-bot` 装入隔离 profile | **成功**：profile `package.json` 含 `"ds-bot": "link:D:/code/ai/DeepSeek-Bot/ds-bot"`，`dsh.profile.bundles` 含 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、**`ds-bot`** | `dsh-g0-bench/home-020/profiles/web/package.json`（我直接读取） |
| 真实 DSH web 主机启动（两版本） | **成功**：`dsh web: http://127.0.0.1:8791/` 与 `:8792/`，进程存活 50s+ | `logs/dsh-coldstart-0.2.1-rc.2.log`、`…-0.2.1-rc.2.log` |
| **插件自身装载并响应** | **成功，两版本均成立** | 见下 4 项 |

**判定"插件已装载"的四项硬证据（两版本各一份）：**

1. **私有 HTTP 路由应答**：`POST /api/bot {"endpoint":"state"}` → **HTTP 200**，返回
   `{"ok":true,"value":{"revision":3,…,"bots":[{"id":"session-…","name":"Chief","role":"Chief of Staff",…}],"rooms":[],…}}`
2. **对照路由 404**：同一 POST 打到插件未注册的 `/api/health` → **HTTP 404 `not found`**。
   → 证明 200 是该插件注册的 `ROUTE='/api/bot'`（`channel.js:347`）在应答，而非宿主兜底。
3. **客户端产物被服务端提供**：served index.html 的 bundle registry 含
   `{"id":"ds-bot","url":"plugins/??ds-bot/client.js&rev=40c9a99ae73e"}`；直接 GET 该 URL →
   **HTTP 200，851,021 bytes**，内容以 `// Generated from src/client by …` 与 `window.__ModuleLoader__.load({ id: 'ds-bot', … })` 开头。
4. **插件落盘了自身状态**：`$DSH_HOME/bot/state.json` 被创建，内含真实 `Chief` 主 Bot 记录
   （`mainBotIds`、`avatar.shape:"whale"`、`whaleStored:true`、`kickoff.text`、`workspaceId`）。
   我直接读取了两个 bench 的该文件，内容与 `POST /api/bot state` 的返回一致（同一 `session-…` id）。

**结论**：门禁「原版可运行」= **PASS**。原版 `ds-bot@0.1.7` 在**真实 DSH `0.2.1-rc.2` 与 `0.2.1-rc.2`** 上
均能装载 Host 模块、注册 `/api/bot`、提供客户端 bundle、初始化团队状态并创建 Chief。这不只是"主机起来了"。

### 5.2 本次冷启动**没有**证明的事（不得据此推断）

| 未覆盖 | 说明 |
|---|---|
| 真实模型轮次 | 未提供 API key，未让 Chief 真正调用模型与工具。`0.2.1-rc.2` 的 `state` 返回里 `models` 有 2 项（`deepseek-flash`/`deepseek-v4-pro`）、`0.2.1-rc.2` 里 `models:[]`、`defaultModel:null`——这是两 bench 的 provider 配置差异，**不是缺陷**，但也说明模型链路未打通 |
| 原生模块可用性 | `node-pty` / `koffi` / `dsh-subprocess-local` 的 spawn-helper 的安装脚本被 `allowScripts` 跳过（见 §5.3）。宿主能启动说明 Host 侧不依赖它们即可装载插件，但**任何"Bot 真跑终端/子进程"的验证（含 G2 `run_code`）在这些二进制缺失前不可信** |
| 冷启动的 GUI/Electron 路径 | 仅验证 web profile；Desktop Electron 冷启动（T20）未做 |
| 错误扫描 | `-0.2.1-rc.2.log` 第 36-37 行记录"error scan 命中 1 条"，被中断前未导出该行原文。**故不能声称"无错误日志"**；鉴于上述 4 项证据均成立，判定为"存在 1 条未经确认的日志匹配，不影响装载结论，但需在下一轮导出确认" |
| 进程清理 | `-0.2.1-rc.2.log` 第 36-44 行显示 8791 主机（pid 380/57588）已停止，`GET /` 返回 `000`（连接拒绝）；`-0.2.1-rc.2.log` 记录到第 38 行结束，**其 8792 主机是否已停未在日志中留证**，需下一轮确认 |

### 5.3 仍需在 G1 前解决的安装脚本问题

两次 DSH 安装（`dsh-install-0.2.1-rc.2.log` 第 13-20 行、`dsh-install-0.2.1-rc.2.log` 第 13-20 行）与 `npm run harness`（`npm-run-harness.log` 第 40-45 行）都报告：

```
npm warn install-scripts 5 packages have install scripts not yet covered by allowScripts:
    @deepseek-ai/dsh-subprocess-local@<ver> (postinstall: node scripts/ensure-spawn-helper.mjs)
    koffi@3.1.1                            (install: node ./cnoke.cjs --prebuild --release)
    node-pty@1.2.0-beta.15                 (install: node scripts/prebuild.js || node-gyp rebuild; postinstall: …)
    @google/genai@2.21.0                   (preinstall: no-op)
    protobufjs@7.6.6                       (postinstall: node scripts/postinstall)
```

含义：npm 的 `allowScripts` 策略**跳过了这些原生依赖的编译/准备步骤**。`node-pty` 无 prebuild、`koffi` 无 cnoke、`dsh-subprocess-local` 无 spawn-helper。它**没有**阻止本次插件装载，但会阻断后续任何需要真实终端/子进程的验证。

**G1 前必做**：对 bench 前缀 `npm install-scripts approve` 这 5 个包（或在允许脚本的模式下重装），确认二进制实际产出；若在 Node 26 下编译失败，则降到 DSH 期望的 **Node 24.21.0** 重试。这是 §1.3 版本偏差的真实代价。

### 5.4 一处需要说明的观测差异

- 磁盘上的 `ds-bot/client.js` = **850,958** bytes（与上游字节一致）。
- 服务端实际下发的 `/plugins/??ds-bot/client.js` = **851,021** bytes，多 **63** bytes。

该差异来自插件/宿主在服务时对产物做了包装（不是源文件被改动）。判定依据：磁盘文件 sha256 在 `npm run build` 前后均为 `2e2df9be…669b`，且 `fc /b` 与上游无差异。此处如实记录，不声称"下发内容与磁盘完全逐字节相同"。

---

## 6. P0 风险清单

完整 20 条（含证据行号与 G1/G2 处置）见 `source-audit.md` §8。按后果排序的前 8 条：

| ID | 风险 | 后果 |
|---|---|---|
| P0-4 | `createSession` 目录无效时**静默回退到团队工作区**（`roster.js:51-53`） | 远程任务在 B 的团队目录执行 → **越权写** |
| P0-19 | `sidebar.workspaces` 是整格 shadow，"插件"入口不在该 Slot（`client/index.js:777`、`surface.js:60`） | 「Bot 一级入口」位置**无源码证据**，可能阻塞 G1 |
| P0-1 | 工作群若写入原版 `state.rooms`/`groupOwners`，被 12 文件无差别消费（s1 扫描 110 处） | 串群、错误恢复、错误计费 |
| P0-8 | 共用 `roomWaiters/roomProgress/roomInbox`（`turns.js:77-82`） | 群 A 的 waiter 被群 B 触碰 → 串轮次 |
| P0-17 | `tools.guard` 是唯一全局拦截点，但**不覆盖**作用域自注册工具 / PTC `run_code` / MCP 转发 | 安全边界缺口 |
| P0-10 | `approval/request` 只有一个监听，语义是 DSH 工具审批 | 跨用户"本人审批"被误当工具审批 |
| P0-6 | `applyPermission` 只设 preset，**不是 OS 沙箱** | 误以为有文件/网络隔离 |
| P0-2/P0-3 | 工具名与 `rt.*` 方法同名覆盖；`SOURCE_KIND='bot'` 共用 | 静默覆盖，本地群回归 |

---

## 7. 待验证的不稳定 / 私有 API

见 `source-audit.md` §9。**均不得当作已确认签名**：

| API | 状态 |
|---|---|
| `ctx.slots.inject` + `freePriority` 最小优先级语义 | 源码级 + 单测；**未在真 DSH 版本矩阵验证** |
| `ctx.sessionController.create({cwd\|workspaceId, agentPreset})` | 源码级 |
| `agent.ctx.tools.restrict({deny})` 对**作用域自注册**工具的覆盖 | **未验证（G2 关键）** |
| `ctx.tools.guard` 对 PTC 子调用 / MCP 转发的覆盖 | **未验证（P0）** |
| `ctx.workspaceRegistry.archiveSession(id,{stopActivity})` | 源码级 |
| `sessions.list` 的 `retainedBy.mainView` | **私有形状，未验证** |
| `uiConversation.binding(b).target('chat')` | **私有形状，未验证** |
| 群 Session capability 可见面与 `ensureCapabilities` 时序 | 仅模拟测试 |
| `cordis.patch.yml` `insert` 语义与 profile 覆盖 | **已实测**：两版本均装载成功（§5）；`--dump-config` 的逐节点输出仍待导出 |

---

## 8. 测试用例与门禁状态

### 8.1 G0 门禁

| 门禁 | 结论 | 依据 |
|---|---|---|
| DS Bot 完整 SHA + 许可保留 | **PASS** | §1.1、§2.1 |
| 两目录骨架，无第三工程 | **PASS** | §2 |
| 原版 217 文件完整复制、零修改 | **PASS** | §2.1 |
| `npm ci` / `harness` / `build` / `--check` / `test` | **PASS**（全 exit 0） | §3 |
| oxlint（first-party） | **PASS**（0 errors） | §3 第 6/7 行 |
| `npm run lint` 脚本原样 | **BLOCKED**（scope-invalid，已定位为缺 `.gitignore`） | §3.1 |
| 真实 DSH 冷启动原版 Bot | **PASS**（两版本均装载并应答，见 §5；模型轮次未测） |
| DSH 精确 commit SHA | **BLOCKED**（仅版本号） | §1.2 |
| 审计 + A/B/C 清单 + 风险 | **PASS** | §4、`source-audit.md` |
| G1 计划与回归设计 | **PASS** | `g1-plan.md` |

### 8.2 与方案 §15 测试矩阵的对应（G0 只完成基线部分）

| 编号 | G0 状态 |
|---|---|
| T01 原版回归 | **部分**：635 单测通过；Electron 冷启动未做 |
| T03 注册/卸载/热重载 | **部分**：`install.test.js` 顺序断言 + `surface.test.js` 卸载测试通过；真机重载未做 |
| T14 路径穿越/非法 cwd | **部分**：`work-dir.test.js` 19 例通过（含"目录消失则换团队目录"——正是 P0-4 的现状） |
| T19 UI 对照 | **未开始**（需真机） |
| T20 Windows 冷启动 | **部分**：DSH web profile 冷启动 + 插件装载已实证（§5）；Desktop Electron 冷启动未做 |
| T02/T04/T05–T13/T15–T18 | **未开始**（G1+） |

---

## 9. 遗留问题

**P0（阻塞后续）**
1. DSH commit SHA 未锁定（§1.2）——只能锁到发布版本号。
2. `sidebar.workspaces` 之外是否存在可插入一级导航的 Slot —— 未验证，可能阻塞 G1（P0-19）。
3. `tools.guard` / `tools.restrict` 对 PTC、MCP、作用域自注册工具的覆盖 —— 未验证（P0-17）。

**P1**
4. **原生依赖安装脚本被 allowScripts 跳过**（`node-pty`/`koffi`/`dsh-subprocess-local` 的 spawn-helper），见 §5.3；不阻止插件装载，但会阻断任何"Bot 真跑终端/子进程"的验证（含 G2 `run_code` 用例）。G1 前必须解决。
5. `npm run lint` 脚本原样退出 1（需在 G1 加 `--ignore-pattern`，属对上游的有意偏离，须登记）。
6. Node 26 与 DSH 期望的 Node 24 差距；本次冷启动在 26 上成功，但原生模块仍需在 Node 24 下复核。
7. 冷启动日志 `-0.2.1-rc.2` 第 36-37 行记录了"error scan 命中 1 条"但未导出原文；8792 主机是否已停也未留证。需下一轮导出确认（不影响装载结论）。
8. `ds-bot/` 非 git 仓库，无法用 `git diff` 生成上游差异清单；G1 需建立 `docs/workgroup/g1/diff-manifest.md` 手工对照。

**P2**
9. `hub/` 仅有骨架（符合 G0 范围）。

---

## 10. G1 入场判据

G1 **可以**开始，但必须先完成两件**不产生业务代码**的事：

1. **解决 §5.3 的安装脚本问题**（让 `node-pty`/`koffi`/spawn-helper 真正编译产出），否则 G2 的 `run_code`/终端类安全用例无法可信验证；
2. **执行 G1-A Slot 探针**（`g1-plan.md` §2）：在真 DSH 中枚举 `ctx.slots.entries()`，回答 V1/V2/V3；这是唯一可能真正阻塞 G1 的未知项。

两项完成后，按 `g1-plan.md` §3 的 7 项最小变更开始实现。

---

## 附录：本报告引用的文件

| 文件 | 内容 |
|---|---|
| `docs/workgroup/g0/version-lock.md` | SHA、许可、环境、装载机制、环境偏差 |
| `docs/workgroup/g0/source-audit.md` | 逐文件 A/B/C、工具/监听器/Session/Slot 清单、20 条 P0、复用测试表 |
| `docs/workgroup/g0/reference-classification.md` | **方案 §5.4 强制产物**：逐引用点四类分类（本地群独有/WG/通用一次/危险待核验）+ 调用者、被调对象、注册次数、卸载行为、测试用例；含 DANGER 汇总 |
| `docs/workgroup/g0/scans/` | **方案 §5.4 五条 `rg` 原始输出**（s1=110、s2=76、s3=70、s4=83、s5=27）+ `SUMMARY.md`（含 distinct files 与最热文件） |
| `docs/workgroup/g0/g1-plan.md` | G1 范围、Slot 探针、7 项最小变更、WG-01…WG-10 用例、成功标准 |
| `docs/workgroup/g0/gates.md` | 7 行门禁表（命令/退出码/结论/证据）+ client.js 完整性 |
| `docs/workgroup/g0/environment.txt` | Node/npm/pnpm/git/PS/OS/时间/lock sha256 |
| `docs/workgroup/g0/logs/*` | 13 份真实命令/探测日志（含 `dsh-versions.txt`、`dsh-help.txt`、两份冷启动探测） |
