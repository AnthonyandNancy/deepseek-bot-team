> **⚠️ 已被 G6R 取代（2026-10-24）。** 本方案把“原版群记忆没有跨机传输”误判为“原版没有群记忆”，
> 据此刻意新建了 `group_memories` 表、`memory-*` 端点和独立记忆 UI，违反“工作群是原版群聊复制件、
> 先在复制件上改”的规则。保留本文仅作历史记录与反例，**不得据此实施**。现行方案见
> [`docs/superpowers/plans/2026-10-24-g6r-copy-first-group-memory.md`](../../superpowers/plans/2026-10-24-g6r-copy-first-group-memory.md)
> 与 [`docs/workgroup/g6r/NEXT-INSTRUCTION.md`](../../workgroup/g6r/NEXT-INSTRUCTION.md)。

# G6 续接指令（BotCode · 自足版）

- 用法：新建会话后，把下面「指令正文」整段作为第一条消息发出。
- 适用范围：**只在本仓库工作**。`Workgroup-AI` 已冻结：不读、不改、不引用。技术方案已复制到
  `BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md`，读这份副本。
- 前置：G5 自动部分已完成，G4/G5 修补轮已并入 `main`。见 `docs/workgroup/gates.md`、
  `docs/workgroup/g5/EVIDENCE-MATRIX.md`。
- **本文件不含 G6 设计细节**，只写范围、判据、口径、依赖与既有事实。设计与任务拆分在
  [`docs/superpowers/plans/2026-10-26-g6-group-memory.md`](../../superpowers/plans/2026-10-26-g6-group-memory.md)。
- **状态：G6 尚未开始。** 本文是开工前的交接，不是执行记录。

---

## 指令正文（复制以下全部内容）

```text
你在 BotCode 工作副本里继续「工作群」项目，执行 G6：群记忆、恢复、完整验收和交付。
所有代码、测试、文档都写在这里。

## 0. 仓库与基线

1. 根目录：D:\code\ai\DeepSeek-Bot\BotCode
   - 插件：DeepSeek-Bot-main/ds-bot
   - 服务端：hub（相对 ds-bot 是 ../../hub）
   - 桌面端：DeepSeek-Bot-main/app
2. 分支：从 `main` 开始，当前 `main` = e71119b（2026-10-25 G4/G5 修补轮的最后一个提交）。
   工作分支按 AGENTS.md 命名：`feat/g6-group-memory`。
3. 实跑基线（2026-10-26 在 `main` 上跑过）：
   - `cd hub && npm test` → 268 tests / 268 pass / 0 fail
   - `cd ds-bot && npm test` → 1132 tests / 1131 pass / 1 skip / 0 fail / exit 0
   - `node scripts/build-client.mjs --check` → exit 0
   - `npm run lint` → 0 error / 13 warning（与历史基线相同）
   - `git diff --name-only e71119b -- ds-bot/src/host` → 空（原版群核心仍逐字节未改）
4. 不发版、不改版本号、不打包。
5. 技术方案换算规则见 `docs/workgroup/CONVERSION.md`；方案里的 `bot-plugin/` 是本仓库
   `ds-bot/`，方案里的 `hub/` 是 `BotCode/hub/`。
6. 口径优先级：用户需求 > 本指令「已定口径」 > 技术方案 > g0–g5 历史文档。冲突时按此取，
   并在 `docs/workgroup/g6/ROUND-LOG.md` 记一笔。

## 1. 必读（全部在本仓库）

- `docs/superpowers/plans/2026-10-26-g6-group-memory.md`  **本轮实施计划：10 个任务，含每步代码与命令**
- `BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md`  §11（群记忆设计）、§12（`group_memories`
  表）、§13（API 草案）、§14 G6 门禁、§15 T18
- `docs/plans/2026-10-09-context-and-memory.md`  记忆格式、容量、谁能读写、回顾机制
- `docs/workgroup/parity-audit.md`  §1 记忆为什么丢、§3 复制完整性、§5 剩余差异
- `docs/workgroup/KNOWN-GAPS.md`  已接受缺口（尤其第 1 项：OS 钥匙串）
- `docs/workgroup/gates.md`  自动门禁的证据格式
- `docs/workgroup/progress-and-gaps.md`  台账与决定记录
- `docs/workgroup/g5/DESIGN-CHANNEL-AND-SEQ.md`  事件序号与通道的既有决定（G6 复用，不新造）

## 2. G6 范围（本阶段只做这些）

1. **Hub 群记忆存储**：迁移 v8 建 `group_memories`、`group_memory_events`、`group_memories_fts`
   （FTS5 trigram）。字段照方案 §12，并补 `acl / version / expires_at / deleted_at / created_by`。
2. **Hub 群记忆服务**：创建、修正、软删除、列表、检索；每条都先做成员检查；`acl` 只能是本群
   活跃成员；修正用 `expectedVersion` 做 compare-and-apply；删除保留审计行、移出检索索引。
3. **事件扇出**：`memory.proposed / memory.created / memory.corrected / memory.deleted` 加入
   `EVENT_TYPES`，走既有 WSS `seq` 流；它们**不计入未读消息**。
4. **插件 Hub 客户端与投影**：`memory-list / memory-search / memory-create / memory-correct /
   memory-delete` 五个 `apiHandle` 端点；本机只保留缓存投影，不作为权威。
5. **记忆回顾**：工作群成员 Session 结束后的回顾要能触发。现有 `memory.js` 的
   `agent/status` 过滤只看 `rt.isBotSession`，工作群成员不在其中——补一个只读接缝
   `rt.memoryRoomOf(sessionId)`，不要改 `rt.isBotSession` 的语义。
6. **删除归档**：`deleteWorkgroup` 必须调用 `rt.archiveGroupMemory(room)`，与原版 `deleteRoom`
   一致；否则删除后的群记忆仍留在本机，且可能被同 id 的新房间读到。
7. **UI**：工作群设置里增加记忆区（列表、检索、新增、修正、删除），全部走 `callWorkgroup`；
   收到 `memory.*` 事件后重读，不在客户端合并。
8. **T18 与恢复**：按角色/离群/删除验证「未授权不可检索」；修正与删除保留来源与版本；Hub 重启
   后同一批成员仍能检索，离群成员不能。
9. **文档收口**：修正在评审中发现的三处陈旧声明（见 §4），写 `g6/EVIDENCE-MATRIX.md` 与
   `g6/ROUND-LOG.md`。

## 3. 门禁（判据先写死，不许自评）

方案 §14 G6 门禁：

1. **V1 群记忆可用，且与私人记忆隔离**：
   - 群记忆只能在该群成员的工作群会话里读到；
   - 私人记忆（`bots/<botId>/`）与团队记忆（`team/`）不出现在群记忆检索结果里；
   - 群记忆也不出现在 Bot 私聊的记忆段里。
2. **断网重启不泄漏、不乱序、不误恢复**：
   - Hub 关闭再打开同一数据库文件，条目与检索仍一致；
   - 重放同一 `memory.created` 事件不会产生第二条；
   - 离开群后再次请求，列表与检索都返回 404。
3. **关键安全用例通过**：非成员不能读写；`acl` 不含自己时读不到；修正带旧版本被拒绝；
   删除后检索为空但审计可查；疑似凭据内容被拒。
4. **所有代码/测试/迁移/配置示例在两个目录内**：`hub/` 与 `ds-bot/` 的改动都能在计划里指到
   文件；不引入新的一级目录；不新增运行时依赖（FTS5 由 `node:sqlite` 提供，已实测可用）。
5. **交付最终验收报告**：`docs/workgroup/g6/EVIDENCE-MATRIX.md` 每行指向具体测试与断言；
   人工项写 BLOCKED 与步骤，不写 PASS。

验收矩阵 T18（方案 §15）：

| 编号 | 场景 | 必须观察到 | 优先级 |
|---|---|---|---|
| T18 | 群记忆按角色/离群/删除 | 未授权不可检索，引用与纠错完整 | P0 |

## 4. 已定口径（这些不用再问）

1. **Hub 是群记忆的唯一权威**；本机 Markdown 记忆是投影/缓存，用于提示词冻结，不参与多机合并。
2. **不引入向量库**：V1 只用 SQLite FTS5；`node:sqlite` 的 FTS5 已在本机实测可用。
3. **不新建浏览器传输**：记忆刷新复用既有 `/api/bot/feed` 的 `workgroup` 事件与 `apiHandle`。
4. **不改原版群语义**：`ds-bot/src/host/{groups,turns,delivery,resume,constants}.js` 逐字节不变。
   需要的行为放进 `src/workgroup/host/` 或原版已有的只读接缝。
5. **OS 钥匙串仍不可做**：`@deepseek-ai/dsh-credentials-local` 的 README 明确写 OS-keychain
   provider deferred，且同 UID 进程可读。G6 只做**事实记录**，不假装完成；若 DSH 已升级提供，
   按 `KNOWN-GAPS.md` 第 1 项的替换路径做，并补一条测试。
6. **人员显示名缺口不在 G6 扩范围**：Hub `users` 没有 `display_name`，成员行仍显示打码手机号；
   要改是账号模型变更，需维护者决定。
7. **不发版、不打包**；人工验收与发布仍由维护者执行。
8. **文档里的旧数字是历史**：不能把 G4/G5 当时跑出的 `190`、`990`、`253`、`1024`、`1080` 当成
   当前基线；当前基线是 §0 的 `268` 与 `1132`。

## 5. 建议顺序（按依赖）

严格按实施计划的 Task 1 → 10：

1. 迁移 v8 + FTS（含 cascade 与触发器）
2. Hub 记忆服务（ACL、版本、软删除、检索）
3. `memory.*` 事件类型
4. 插件 Hub 客户端 + 本机投影
5. `apiHandle` 五个端点
6. 回顾触发接缝（`rt.memoryRoomOf`）
7. 删除归档
8. 设置界面记忆区
9. T18 负例与重启恢复
10. 文档与证据

每个任务都是「先写失败测试 → 跑出预期失败 → 最小实现 → 跑绿 → 提交」。

## 6. 每轮必须交付

- 改了哪些文件（diff 或摘要）
- 执行的命令与结果（Hub 测试、ds-bot 测试、build check、lint）
- 新增/修改的测试，以及它们证明哪条门禁
- 未解决的问题与阻塞（谁需要做什么）
- 文档更新：`docs/workgroup/g6/EVIDENCE-MATRIX.md`、`docs/workgroup/g6/ROUND-LOG.md`，
  以及 `gates.md` / `progress-and-gaps.md` 的对应小节

## 7. 硬规则（违反即停）

1. 不修改 DSH，不打补丁，不依赖 DSH 安装目录内的文件。缺能力就停下说明。
2. 不改本地群语义：`src/host/{groups,turns,delivery,resume,constants}.js` 必须逐字节不变。
   每轮交付前跑 `git diff --name-only <base> -- ds-bot/src/host`，输出必须为空。
   - `src/host/memory.js` **可以改**（它不是上述冻结文件），但只能改「工作群也适用」的接缝：
     新增 `rt.memoryRoomOf` 分支，不得改变原版本地群/私聊的记忆行为。
   - `src/host/feed.js` 已经有一次批准的改动（`workgroupStateSaved`）；G6 不再新增 `src/host/` 改动。
3. 一个 Runtime 只安装一次工作群域；二次安装必须抛错；域故障不能拖垮本地团队。
4. 本地群与工作群数据、会话、权限、记忆隔离；本地群历史不上传。
5. 不发版、不改版本号、不打包。
6. 测试不得指向 `~/.dsh` 或用户自己的 DSH 数据；用临时目录。
7. 不读、不改、不引用 `Workgroup-AI`。
8. **测试必须走产品路径**：新端点测试用 `apiHandle`，跨机测试用两个 `createRuntime` + 真 Hub
   进程。只有纯函数/迁移允许直接调用。
9. 遇到会改变需求或架构的问题：停下，写「Plan deviation」，等人确认。

## 8. 完成定义

- 方案 §14 G6 的 5 条门禁都有自动化证据；T18 的每个子项在 `g6/EVIDENCE-MATRIX.md` 能指到
  「哪条测试、哪条断言」。
- `hub npm test`、`ds-bot npm test`、`node scripts/build-client.mjs --check`、`npm run lint`
  全绿；`src/host/` 冻结文件零改动。
- `memory.*` 事件能在两台 Runtime 之间传播；离群后列表与检索都拒绝。
- 文档能回答：G6 做到哪、缺什么、哪些必须人工、下一步是什么。
- 人工项（G4-1/5/6、G4-T20、G5-T12/N3/T14、G6-M1）保持 BLOCKED，写清步骤，不写 PASS。

## 附录 A：当前事实（2026-10-26 核对）

**Hub 表**：迁移 v1–v7，共 20 张（G3 六张 + G4 九张 + G5 五类中的四张 + 两处修补列）——
`users`、`auth_sessions`、`devices`、`audit_events`、`recovery_codes`、`password_resets`、
`bot_endpoints`、`workgroups`、`memberships`、`invites`、`events`、`deliveries`、`read_cursors`、
`attachments`、`attachment_tickets`、`tasks`、`approvals`、`round_leases`、`artifacts`、
`schema_version`。
`group_memories` **刻意不存在**，G6 Task 1 建它。

**`workgroups` 已有列**：`id, owner_user_id, name, notice, avatar, config_version, last_seq,
upgrade_id, created_at, archived_at, reply_mode, permission, lead_membership_id`。
`config_version` 已用于设置 CAS（G4/G5 修补轮）。

**Hub 已有路由**（不要重复实现）：
`/v1/auth/{register,login,refresh,logout,me,recover,password,recovery-code}`
`/v1/devices/{challenge,register}`、`/v1/devices`、`/v1/devices/:id/revoke`
`/v1/workgroups`(GET/POST)、`/v1/workgroups/:id`、`/v1/workgroups/:id/{settings,members,delete,invites,events,read,attachments,lease}`
`/v1/invites`、`/v1/invites/:id/{accept,decline}`
`/v1/bot-endpoints`(GET/POST)、`/v1/bot-endpoints/:id/revoke`
`/v1/attachments/:id/{ticket,download}`
`/v1/tasks`、`/v1/tasks/:id`、`/v1/tasks/:id/{decision,revoke}`、`/v1/tasks/:id/artifacts`
`/v1/artifacts/uploads`、`/v1/artifacts/:id/download`、`/v1/health`、WS `/v1/ws`

**`EVENT_TYPES` 现有 18 项**：`chat.message`、`chat.edited`、`chat.deleted`、`member.changed`、
`read.updated`、7 个 `task.*`、4 个 `approval.*`、2 个 `artifact.*`。
`READABLE_EVENT_TYPE` 只有 `chat.message`。

**DB 驱动**：`node:sqlite` 的 `DatabaseSync`；WAL、`foreign_keys=ON`、`busy_timeout=5000`、
`synchronous=NORMAL` 已设置。FTS5 在本机实测可用（`CREATE VIRTUAL TABLE ... USING fts5` 成功）。

**插件本机记忆位置**：`<home>/bot/memory/`，`groups/<roomId>/` 是群记忆，`bots/<botId>/` 是私人，
`team/` 是团队；`journal.jsonl` 记录每次改动；`snapshots/` 冻结每个 Session 的记忆段。
容量：单条 300 字符，`MEMORY.md` 4000，主题 16000，最多 40 个主题。

**已知接缝**：
- `rt.workgroupRoomOf(roomId)`（`workgroup/host/ownership.js`）让 `memory.js` 的 `panelOf` 能用
  工作群 id 打开记忆面板；测试在 `test/workgroup-round.test.js`。
- `rt.sessionGroupScope(sessionId)` 给 `tools.js` 用，**不是**记忆的接口。
- `memory.js:1476` 的 `agent/status` 过滤只认 `rt.isBotSession`，这是 G6 Task 6 要修的缺口。

**测试夹具**：
- Hub：`test/helpers.js` 的 `startHub()`、`person()`、`groupWith()`；`startHub.close()` 会删除
  自己的临时数据目录。
- 插件：`test-realtime/workgroup-realtime.test.js` 的 `machine/openMachine/invitedPair`；
  `test/workgroup-round.test.js` 的 `start()`。

## 附录 B：自足性说明（每条结论在本仓库的位置）

| 结论 | 位置 |
|---|---|
| G6 范围与门禁 | `BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md` §11、§12、§14、§15 |
| 群记忆字段与表名 | 同上 §12 的 `group_memories` 行 |
| 记忆格式、容量、谁能读写 | `docs/plans/2026-10-09-context-and-memory.md` |
| 工作群记忆目前只在本机 | `docs/workgroup/parity-audit.md` §1、§5 |
| 删除群时不归档记忆 | `ds-bot/src/workgroup/host/groups.js` 的 `deleteWorkgroup`（无 `archiveGroupMemory` 调用） |
| 原版删除群会归档 | `ds-bot/src/host/roster.js:484` |
| 回顾不覆盖工作群 | `ds-bot/src/host/memory.js:1476` |
| 面板已能打开工作群记忆 | `ds-bot/src/host/memory.js:1078-1087` + `ownership.js:71-81` |
| OS 钥匙串不可用 | `dev/harness/node_modules/@deepseek-ai/dsh-credentials-local/README.md` 的 Known Limitations |
| 当前测试基线 | `main` @ e71119b：hub 268/268、ds-bot 1131 pass / 1 skip |
| 事件类型封闭集 | `hub/src/workgroups/service.js:34-56` |

## 附录 C：开工前清单（逐条打勾）

- [ ] `git checkout main && git pull`（无远端时跳过 pull），确认 `git log -1` 是 `e71119b`
- [ ] `cd hub && npm test` → 268/268
- [ ] `cd ../DeepSeek-Bot-main/ds-bot && npm ci && npm test` → 1131 pass / 1 skip
- [ ] `node scripts/build-client.mjs --check` → 0
- [ ] `npm run lint` → 0 error
- [ ] `git diff --name-only e71119b -- ds-bot/src/host` → 空
- [ ] 建工作分支 `feat/g6-group-memory`
- [ ] 读完实施计划的 Task 1–10
- [ ] 确认 `node:sqlite` 的 FTS5 可用（`CREATE VIRTUAL TABLE ... USING fts5` 成功）
- [ ] 确认人工门禁清单在 `docs/workgroup/manual-checklist.md`，本轮不代写 PASS
```
