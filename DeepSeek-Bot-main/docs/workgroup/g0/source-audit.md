> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g0/source-audit.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G0 源码审计：groups.js 依赖 / 注册 / 复制范围

审计对象：`ds-bot/` = Fei2411/DeepSeek-Bot `ds-bot` v0.1.7 完整副本（未改动）。
审计方法：直接读锁版源码 + 逐项 rg 全量扫描（对应方案 5.4 节）。所有行号来自 `ds-bot/src`。

分类定义（方案 5.1–5.3）：
- **A 复制**：完整复制到 `src/workgroup/`，改为 `wg` 私有状态，与本地群等价后再接 Hub。
- **B 公共改造**：原文件只改一次，加入工作群域分发/身份识别；不复制第二份。
- **C 复用**：原版装一次即可，工作群只通过受控适配接口调用，**绝不再 install 一次**。

---

## 1. groups.js 直接 import（方案要求的第一项）

`src/host/groups.js`（877 行）顶部 import：

| 来源 | 符号 | 性质 | 工作群处置 |
|---|---|---|---|
| `node:crypto` | `randomUUID` | 平台 | 直接可用 |
| `node:fs` | `mkdirSync, writeFileSync` | 平台 | 目录须换成 `wg` 命名空间（见 P0-4） |
| `node:fs/promises` | `readFile, rm` | 平台 | 同上 |
| `node:path` | `join` | 平台 | 同上 |
| `@deepseek-ai/dsh-llm` | `createUserMessage` | DSH 公共 API | C 复用（不复制 DSH） |
| `@deepseek-ai/dsh-tools` | `defineTool` | DSH 公共 API | C 复用 |
| `./constants.js` | `GROUP_LINE_READ, ROOM_LATE_ROUNDS, ROOM_REPLY_TIMEOUT_MS, ROOM_STEP_GAP_MS, ROOM_WORK_GRACE_MS, SOURCE_KIND, TEAM_TOOLS, TEXT_KEPT` | 原版常量 | **B**：工作群需自己的命名空间常量（`WG_SOURCE_KIND`），不能共用 `SOURCE_KIND='bot'`（见 P0-3） |
| `./text.js` | `escapeRegExp, headOf, splitRef, textOf` | 纯函数 | **C**（纯工具，无状态，可共享） |
| `../shared/mentions.js` | `mentionSpans, speakerOf` | 纯函数 | **C** |
| `./tools.js` | `GROUP_REF, output` | 工具 schema 常量 | **B**：工作群工具 schema 必须独立（见 P0-2） |
| `./turns.js` | `failureLine` | 纯格式化 | **C** |

结论：`groups.js` 的直接 import 面很小且干净；**真正的耦合全在 `rt.*` 隐式依赖**（下节）。

---

## 2. groups.js 对 `rt.*` 的隐式依赖（不写 import，靠 install 顺序注入）

`index.js:44` 的 `MODULES` 顺序决定了这些字段何时存在。groups.js 在序列中位于 `chatIndex` 之后、`approvals` 之前，因此可以安全使用前 14 个模块的字段。

| rt 成员 | 定义处 | 定义方式 | 工作群处置 |
|---|---|---|---|
| `rt.readOnly()` | store.js | Object.assign | C |
| `rt.warn()` | diagnostics.js | Object.assign | C |
| `rt.home` | index.js:52 | rt 字面量 | **B**：工作群需独立 home 子目录 |
| `rt.load / rt.save` | store.js | Object.assign | **B**：见 P0-1（同一 state.json） |
| `rt.botOf` | store.js:316 | Object.assign | C（读 roster） |
| `rt.roomOf` | store.js:317 | Object.assign | **B**：必须能同时识别 local room 与 wg room（见 P0-1） |
| `rt.selfOf / isBotSession` | store.js:356/358 | Object.assign | **B**：身份解析必须扩展工作群（见 P0-5） |
| `rt.chatOwners / groupOwners / pastOwners` | store.js:331-335 | Map | **B**：工作群不得写入原版 `groupOwners`，否则被原版 turns/parts/resume 误消费（见 P0-1） |
| `rt.isAdminOf` | store.js:394 | Object.assign | **B**：工作群管理员是 Hub 真人/角色，语义不同 |
| `rt.retireGroupSession` | store.js:373 | Object.assign | B |
| `rt.groupSessionsOf / dropGroupSession` | store.js:359/360 | Object.assign | B |
| `rt.createSession` | roster.js:46 | Object.assign | **B（高危）**：目录回退逻辑见 P0-4 |
| `rt.workDirOf` | folders.js:24 | Object.assign | **B**：cwd 回退到 teamFolder 是 P0-4 |
| `rt.ensureCapabilities` | capabilities.js | Object.assign | C |
| `rt.desiredModel` / `rt.selectSessionModel` | models.js | Object.assign | B（工作群 Session 继承真实 Bot 模型，不得放大） |
| `rt.applyPermission` | permissions.js:79 | Object.assign | **B（安全关键）**：见 P0-6 |
| `rt.ownChatBrief` | chat-index.js:292 | Object.assign | C |
| `rt.partsOf / partIndex / noteText / aroundOwnChat / latestOwnChat / searchOwnChat / clock` | chat-index.js, parts.js | Object.assign | C（只读），但工作群记忆必须走独立索引（P0-7） |
| `rt.roomWaiters` | turns.js:630 | Object.assign（Map 实例） | **A/B 关键**：工作群**必须**用自己的 `wg.roomWaiters`，共用即串群（P0-8） |
| `rt.roomProgress` | turns.js:630 | 同上 | 同上 → `wg.roomProgress` |
| `rt.roomInbox` | turns.js:630 | 同上 | 同上 → `wg.roomInbox` |
| `rt.live / liveOf` | turns.js:630 | 同上 | C（事件驱动，只读） |
| `rt.deliver` | delivery.js:161，**resume.js:101 覆盖** | 二次赋值 | **P0-9**：`deliver` 被 resume.js 包装；工作群远程投递若也包装会叠加，需单点 |
| `rt.resolveAgent` | delivery.js:161 | Object.assign | C |
| `rt.stopsRoomTurn / touchRoomTurn / failRoomTurn / yieldRoomTurn / workRoomTurn` | groups.js 自己定义 | rt 赋值 | A（随 groups.js 复制） |
| `rt.postToRoom / lateRoomReply / roomStepText / takeRoomSteps / withRoomSteps / stopMemberWork / lateRoomFailure / greetRoom / keepGroupLine / dropGroupLines` | groups.js | rt 赋值 | **A（必须改名）**：与原版同名会互相覆盖（P0-2） |
| `rt.waitsForApproval / approvalsView / answerApproval / cancelApprovals` | approvals.js:68 | Object.assign | **B**：跨用户授权 ≠ DSH 工具审批，必须两套（P0-10） |
| `rt.uiLanguage` | channel.js:24 | rt 赋值 | C |
| `rt.pickRoom` | tools.js:722 | Object.assign | **B**：工作群选群必须走 Hub 群表 |
| `rt.hideBotUnusedTools` | tools.js:722 | Object.assign | C |
| `rt.imagesForGroup` | images.js:210 | Object.assign | B：工作群附件走 Hub 中转（P0-11） |

---

## 3. 工具注册清单（重复安装 / 同名冲突）

全部 23 个 `ctx.tools.register` 调用点：

| 工具名 | 文件:行 | 工作群处置 |
|---|---|---|
| `list_bots` | tools.js:49 | C（原版一次） |
| `message_bot` | tools.js:131 | **B（P0-12）**：必须加域检查，禁止成为跨群派单旁路 |
| `stop_bot` | tools.js:216 | C |
| `create_bot` / `update_bot` | tools.js:243/275 | C |
| `list_models` | tools.js:311 | C |
| `create_group` / `update_group` / `delete_group` / `post_to_group` | tools.js:347/376/437/454 | **C 保留原名给本地群**；工作群新增 `workgroup_*`（方案 6.3） |
| `ask_user` | tools.js:503 | C |
| `request_secret` / `list_secrets` | secrets.js:375/424 | C |
| `group_relay` | **groups.js:489** | **A → `workgroup_relay`**；同名二次注册会冲突 |
| `read_own_chat` | **groups.js:582** | **A → 需域判定**；它同时服务本地群与私聊（P0-13） |
| `read_group_chat` | **groups.js:637** | **A → `read_workgroup_chat`** |
| `remember` / `forget` / `recall` | memory.js:775/807/840 | C（私人记忆）；工作群记忆独立工具名（P0-7） |
| `read_browser` | browser.js:229 | C（仅 Desktop profile） |
| `list_capabilities` / `save_capability` / `delete_capability` | tools.js:625/649/679 | C |

`TEAM_TOOLS`（constants.js:64-71）是上述名单的**唯一真源**，`test/agents.test.js:204` 断言"TEAM_TOOLS 精确等于已注册工具"。→ **任何工作群新增工具都必须同步 TEAM_TOOLS，否则该测试立即失败**（这正是我们想要的回归护栏）。

---

## 4. 事件监听器注册清单

23 个 `ctx.on`；23 处 `ctx.effect(` 匹配（其中 1 处为 `agent.ctx.effect`、3 处为经 `attach()` 包装的条件注册，故实际顶层 effect 约 19 个）；1 个 `ctx.tools.guard`；1 个 fetch route。

| 事件 | 注册点 | 工作群风险 |
|---|---|---|
| `llm/stream` | groups.js:845, images.js:178, parts.js:1017, secrets.js:465, usage.js:574 | **P0-14**：5 个监听器已串联；工作群再加一个"群 Session 只走 relay"的拦截器会改变 next() 链顺序 |
| `session/event` | turns.js:349, tools.js:616, resume.js:131 | **P0-15**：3 处都在做"这是不是我的 Session"判定，全部依赖 `isBotSession`/`groupOwners`；工作群必须在这 3 处都能正确分流，否则消息双投递或丢失 |
| `agent/created` | agents.js:70, capabilities.js:485, parts.js:241, tools.js:585 | **P0-16**：4 处；工作群新建 Session 会触发全部 4 个，其中 tools.js:585 会调用 `restrict()` 隐藏工具 |
| `agent/status` | images.js:192, memory.js:1347, parts.js:1007 | P1 |
| `agent/pre-step` | parts.js:845, time-context.js:18 | P1 |
| `tools/execute` | secrets.js:444 | **P0-6**：这是密钥脱敏管线，工作群远程执行必须复用而非绕过 |
| `approval/request` | approvals.js:15 | **P0-10** |
| `system-prompt/assemble` | parts.js:907 | P1 |
| `agent/request-error` | parts.js:939, parts.js:957 | P1 |
| `agent/inbox/discarded` | resume.js:121 | P1 |
| `tools.guard` | tools.js:581 | **P0-17**：唯一的全局工具拦截点；跨用户授权必须在此强制（方案 10.4） |
| `fetch.register POST /api/bot` | channel.js:347，路径 `/api/bot`（constants.js:22） | **P0-18**：单一路由；工作群 RPC 必须换路径，不能注册第二个 `/api/bot` |

卸载语义：全部注册都在 `ctx.effect(...)` 内返回 disposer，`test/install.test.js:32` 用 `ctx.calls` 逐条断言 71 项注册**顺序**；`test/capabilities.test.js:337` 断言卸载时释放所有 mount。→ 复制工作群代码时，**该顺序断言会因新增注册而失败**，这是必须显式更新的预期差异（不是"测试坏了"）。

---

## 5. Session 身份归属（`store.js` 索引）

`store.js:337-358` `indexSessions()` 从 `state.bots` / `state.rooms` 重建三张 Map：

```
chatOwners   : sessionId -> botId            （私聊，bot.sessionId + segments）
groupOwners  : sessionId -> {botId, roomId}  （本地群，room.sessions）
pastOwners   : sessionId -> {botId, roomId?} （归档段）
```

`selfOf(id) = chatOwners ?? groupOwners?.botId ?? pastOwners?.botId`
`isBotSession(id) = chatOwners.has(id) || groupOwners.has(id)`

被 12 个文件消费。**原始扫描证据**见 `docs/workgroup/g0/scans/s1-session-identity.txt`（方案 §5.4 的原样模式，**110 处匹配**）；逐引用点分类见 `docs/workgroup/g0/reference-classification.md` §A。**工作群处置（B 类，只改一次）**：
- 新增 `wg.sessionOwners: Map<sessionId, {kind:'workgroup'|'task', hubUserId, deviceId, botId, workgroupId, taskId, authorizationId}>`；
- `indexSessions()` 重建时**同时**从持久化 `workgroupSessionOwners` 重建该表；
- 新增 `resolveSessionOwnerStrict(id)`：命中两个域 → **抛错拒绝执行**（方案 6.1 明确要求，禁止"先匹配先使用"）；
- 12 个消费点改为调用 strict 解析或保持原义（只读遥测可保持原版）。

**P0-5**：`createSession`（roster.js:46-58）在 `rt.resolveAgent` 之后才返回 id，工作群 Session 的归属登记必须在此之前失败关闭，否则存在窗口期内 `selfOf` 返回 undefined。

---

## 6. UI Slot 清单（`client/index.js`）

`inject = ['sessions','uiWorkspace','uiConversation','slots','theme','layout']`（client/index.js:38）。

侧栏（`installShell`，index.js:764-789）：
| Slot | id/key | priority | 组件 |
|---|---|---|---|
| `sidebar.workspaces` | — | BOT_PRIORITY=-100 | TeamSidebar（**整体替换原侧栏**） |
| `sidebar.brand.mark` / `.name` | — | -100 | BrandMark / BrandName |
| `sidebar.footer.action` | `bot-account` (-200), `bot-connect` (-100), `bot-return` (-300) | — | FooterAccount / ConnectPlugins / BotReturn |
| `settings.trigger` | — | -100 | YouAvatar |
| `settings.launcher` | — | -100 | AccountLauncher |
| `shell.overlay` | `bot` (50), `bot-signin` (55), `bot-toast` (60) | — | Overlays / DeepSeekSignIn / ErrorToast |

会话（`installConversation`，index.js:790-824）：
`conversation.session.header`、`conversation.chat.node`（key: assistant-step / turn-trigger / tool-call / turn-process / question-reply / compaction / user / steering）、`conversation.chat.turnTail`、`conversation.input.permission / .plan / .model / .left / .right / .dock`、`conversation.composer.dock`。

**P0-19（UI Slot）**：`sidebar.workspaces` 是被 **shadow 整格替换**的，`freePriority()`（surface.js:60）保证"低于任何已有同类注册"。这意味着：
1. 原版"插件"一级入口并不在该 Slot 内，而是 DSH 壳自己的导航；工作群/工作 Bot 入口必须**另找接缝**，不能靠这个 Slot 插队。
2. 方案第 9 条要求"原'插件'入口原位保留，其下仅添加'Bot'一级入口"——**目前没有任何原版代码证明该接缝存在**，这是 G1 必须先验证的阻塞项（对应方案 16.2 第 2 条）。

`SETTINGS_PAGES`（settings.js:26）是硬编码数组，新增 "Hub 账号" 页只需追加一项 + `PAGE_ICONS` 一项（B 类，方案 7.1）。

---

## 7. 逐文件 A/B/C 清单

### 7.1 host（共 34 文件）

| 文件 | 行数级 | 与 groups 关系 | 分类 | 说明 |
|---|---|---|---|---|
| `host/groups.js` | 877 | 本体 | **A** | 复制为 `workgroup/host/groups.js`；改 `wg.*`、改工具名、换 `WG_SOURCE_KIND`、群行目录换命名空间 |
| `host/turns.js` | 631 | rt.roomWaiters/roomProgress/roomInbox、3 处 session/event | **B** | 单一事件入口做域分发；**不复制**（复制会产生第二套 live/activity） |
| `host/store.js` | 402 | 身份索引 | **B** | 扩展 `indexSessions` + `resolveSessionOwnerStrict`；工作群持久映射 |
| `host/roster.js` | 580 | 群创建/改名/成员（`createRoom` 321、`updateRoom` 405、`deleteRoom` 467） | **B + A(部分)** | 本地群路径保留；`workgroup/host/roster.js` 复制群成员/ACL 部分并改为 Hub 成员 |
| `host/delivery.js` | 161 | `deliver` | **B** | 本地投递保留；远程走 Bridge，**不改原 deliver 语义** |
| `host/tools.js` | 723 | 12 个工具 + guard + agent/created | **B** | 工具名保持；`message_bot` 加域检查；guard 扩展授权 |
| `host/approvals.js` | 68 | 群审批展示 | **B** | 展示层复用；跨用户授权另建 authorization.js |
| `host/resume.js` | 251 | 覆盖 `rt.deliver`(101)、resume 群轮次 | **B** | 绝不能复制（会二次包装 deliver）；工作群任务**默认不自动重放** |
| `host/parts.js` | 1088 | 上下文分段/压缩，群段 | **B** | Session Part 切换必须覆盖工作群（T04） |
| `host/channel.js` | 363 | `/api/bot` 路由 + `state` 视图含 rooms | **B** | 工作群 RPC 用新路径；视图新增 wg 分区 |
| `host/permissions.js` | 79 | `applyPermission` / `setRoomPermission` | **B** | 工作群权限只能**收紧**，不得放大 |
| `host/folders.js` | 142 | `workDirOf` / `cleanWorkDir` / `sessionFolder` | **B（P0-4）** | cwd 校验 + fail-closed |
| `host/prompt.js` | 72 | `bot-identity` section（room relay 分支） | **B** | 工作群 Session 需独立 identity 分支 |
| `host/chat-index.js` | 329 | `searchOwnChat` 等 | **B** | 私聊检索；工作群记忆独立索引 |
| `host/handoffs.js` | 185 | `openWork` 含 `room`/`fromRoom` | **B** | 绑定远端 taskId |
| `host/memory.js` | ~1390 | 私人 Bot 记忆 | **C**（私人）+ **A**（工作群记忆另建） | `state.rooms` 管理员判定耦合见 P0-7 |
| `host/models.js` | 197 | 模型选择 | **B** | 工作群 Task Session 继承真实 Bot 模型 |
| `host/capabilities.js` | ~520 | MCP/Skills mount | **C** | 工作群复用，但须限制远程可见面 |
| `host/images.js` | 211 | `imagesForGroup` | **B** | 附件走 Hub |
| `host/constants.js` | 88 | `TEAM_TOOLS`、`SOURCE_KIND`、`ROUTE` | **B** | 新增 `WG_*` 常量，保持原值不动 |
| `host/text.js` | — | 纯函数 | **C** | |
| `host/agents.js` | 185 | DSH Agent + `restrict` | **C** | |
| `host/schedules.js` | 150 | 群任务定时 | **B** | 见 7.3 |
| `host/secrets.js` | 537 | `tools/execute` 脱敏 | **C** | 远程执行必须复用 |
| `host/connectors.js`、`browser.js`、`usage.js`、`update.js`、`dsh-update.js`、`diagnostics.js`、`time-context.js`、`home-lock.js`、`steward.js`、`links.js` | — | 与群无直接关系 | **C** | 仅 `usage.js` 需读 wg 归因（P1），`home-lock.js` 影响双 dsh 只读语义 |

### 7.2 shared
| 文件 | 分类 | 说明 |
|---|---|---|
| `shared/mentions.js` | **C** | 纯 mention 解析，工作群直接复用；但成员 ID 语义需从 botId 扩展到 `hubUserId`（新增 `workgroup/shared/mentions.js` 薄封装，**不复制原逻辑**） |

### 7.3 client（共 58 文件）

| 文件 | 与群关系 | 分类 | 说明 |
|---|---|---|---|
| `client/group-settings.js` | 群设置表单（159-215） | **A** | → `workgroup/client/group-settings.js`；成员改真人/Hub、加邀请/退群/群记忆/升级 |
| `client/sidebar.js` | `RoomRow`(94)、群排序(261)、右键(111) | **A（群行）+ B（骨架）** | `sidebar.js` 整体保留；新增 `workgroup/client/sidebar.js` 提供群行与右键"升级为工作群" |
| `client/at-menu.js` | `BOTS_SOURCE`/`CHATS_SOURCE`、群成员 @ | **B** | 新增 `WG_SOURCE`，跨用户成员 ID |
| `client/member-status.js` | `MemberDock`、`StopMemberWork` | **A** | 复制到工作群，显示远端成员在线/离线 |
| `client/cells.js` | `GroupEvent`、群气泡 | **A（群气泡部分）** | 保持原版视觉，消息源换 Hub |
| `client/composer.js` | 输入区 | **B** | |
| `client/context-menu.js` | 群右键菜单（38-39 行） | **A（追加项）** | 增加"升级为工作群"，其余保持 |
| `client/details-drawer.js` | 群详情 | **A** | |
| `client/settings.js` | `SETTINGS_PAGES`(26) | **B** | 追加 `['hub','Hub account']` + 图标 |
| `client/index.js` | Slot 装配(764-824) | **B** | 工作群 Slot 单独装配（P0-19） |
| `client/api.js` | `call(endpoint)` → `/api/bot` | **B** | 工作群 RPC 走新端点 |
| `client/surface.js` | `groupsFor`/`freePriority` | **C** | 关键接缝：优先级机制 |
| `client/mark.js`、`characters.js`、`inks.js`、`themes.js`、`styles.js`、`i18n.js`、`icons.js`、`motion.js` | 视觉/文案 | **C** | 原版外观必须共用 |
| `client/storage.js`、`shared-map.js` | localStorage 键 | **B** | 工作群需按 `hubUserId` 分区（P0-20） |
| `client/palette.js`、`schedules.js`、`usage-page.js`、`header.js`、`activity-row.js`、`user-message.js`、`voice.js` | 读写 `roster.rooms` | **B** | 需同时识别 wg 群 |

---

## 8. P0 风险清单（按严重度）

| ID | 风险 | 证据 | 后果 | G1/G2 处置 |
|---|---|---|---|---|
| P0-1 | 工作群若写入原版 `state.rooms` / `groupOwners`，被 turns/parts/resume/approvals/memory/usage **无差别消费** | store.js:337-358；12 文件 137 处 | 串群、错误恢复、错误计费 | `wg.*` 独立命名空间 + strict 解析 |
| P0-2 | 工具名/ rt 方法同名覆盖 | groups.js:489/582/637/695/717/760/795/809/822 | 静默覆盖，本地群回归 | `workgroup_*` + `wg.*`；TEAM_TOOLS 同步 |
| P0-3 | `SOURCE_KIND='bot'` 共用 | constants.js:41；turns.js:401-471 6 处 | 工作群事件被原版当本地 Bot 事件 | `WG_SOURCE_KIND` 独立值 |
| P0-4 | `createSession` 目录无效时**静默回退到团队工作区** | roster.js:51-53 `rt.warn(... starts in the team workspace)` | 远程任务在 B 的团队目录执行 → **越权写** | realpath + fail-closed（方案 6.4） |
| P0-5 | Session 归属登记窗口期 | roster.js:54-57 | 窗口内 `selfOf` 未定义 | 先登记后返回 |
| P0-6 | `applyPermission` 只设 preset，非 OS 沙箱 | permissions.js:30-45 | 误以为有文件/网络隔离 | 明确标注 + G2 实测 |
| P0-7 | 工作群记忆若复用 `memory.js` | memory.js:490 `writesTeam` 依赖 `state.rooms` 管理员 | 私人记忆泄漏进群 / 群记忆权限错 | 独立 `workgroup memory` + ACL |
| P0-8 | 共用 `roomWaiters/roomProgress/roomInbox` | turns.js:77-82 | 群 A 的 waiter 被群 B 触碰 → 串轮次 | 三张 Map 全部 `wg.*` |
| P0-9 | `rt.deliver` 被 resume.js 二次包装 | delivery.js:161 → resume.js:101 | 再加一层桥接会叠加副作用 | 远程投递走独立函数，不改 deliver |
| P0-10 | `approval/request` 只有一个监听，语义是 DSH 工具审批 | approvals.js:15-25 | 跨用户"本人审批"被当成工具审批 | 两套通道，Hub 批准不激活本地权限（方案 10.3） |
| P0-11 | 群附件经 `imagesForGroup` 读本地文件 | images.js:210 | 远程请求可读本地文件 | 附件只走 Hub 中转 + 授权 |
| P0-12 | `message_bot` 可跨 Bot 派单 | tools.js:131；test 覆盖 group→member | 成为绕过审批的旁路 | guard 内加域与授权检查（T15） |
| P0-13 | `read_own_chat` 同时服务私聊与群 | groups.js:582-634 | 远程任务可读私人历史 | 远程 Session 默认 deny（方案 10.4） |
| P0-14 | 5 个 `llm/stream` 监听串联 | groups.js:845 等 | 顺序错乱导致 relay 拦截失败 | 新增监听须明确位置并测 |
| P0-15 | 3 处 `session/event` 各自判定归属 | turns.js:349 / tools.js:616 / resume.js:131 | 双投递或丢失 | 单点 strict 分流 |
| P0-16 | 4 处 `agent/created`（其中 tools.js:585 调 restrict） | tools.js:585 | 工作群 Session 被错误隐藏工具 | 实测 restrict 是否覆盖 wg 工具 |
| P0-17 | `tools.guard` 是唯一全局拦截点，但**不覆盖**作用域自注册工具 / PTC / MCP | tools.js:581；方案 2.2 | 安全边界缺口 | G2 必测（T15） |
| P0-18 | 单一 `/api/bot` fetch 路由 | channel.js:347 | 无法为工作群加第二路由 | 新路径 + 实测 register 冲突 |
| P0-19 | `sidebar.workspaces` 是整格 shadow；"插件"入口不在该 Slot | client/index.js:777；surface.js:60 | "Bot"一级入口位置**无源码证据** | **G1 首要待验证**（方案 16.2-2） |
| P0-20 | localStorage 键未按用户分区 | client/storage.js | 切换账号泄漏工作群数据（方案 17） | 按 `hubUserId` 分区 |

---

## 9. 待验证的不稳定/私有 API（不可当作已确认）

| 项 | 当前证据 | 状态 |
|---|---|---|
| `ctx.slots.inject` + `freePriority` 的最小优先级语义 | client/index.js:728-730、surface.js:60 | 源码级；`test/surface.test.js:126` 单测覆盖，但**未在真 DSH 版本矩阵验证** |
| `ctx.sessionController.create({cwd \| workspaceId, agentPreset})` | roster.js:54 | 源码级 |
| `agent.ctx.tools.restrict({deny})` 对**作用域自注册**工具的覆盖 | tools.js:564-577、agents.js:45-62 | **未验证** |
| `ctx.tools.guard` 对 PTC `run_code` 子调用 / MCP 转发的覆盖 | tools.js:581 | **未验证（P0）** |
| `ctx.workspaceRegistry.archiveSession(id,{stopActivity})` | store.js:369 | 源码级 |
| `sessions.list` 的 `retainedBy.mainView` 字段 | client/index.js:703 | 私有形状，**未验证** |
| `uiConversation.binding(binding).target('chat')` | client/index.js:709 | 私有形状，**未验证** |
| 群 Session 的 capability 可见面与 `ensureCapabilities` 时序 | groups.js:188/212 | 依赖 `test/rounds.test.js:118` 模拟，真机未验证 |
| `cordis.patch.yml` 的 `insert` 语义与 profile 覆盖 | ds-bot/cordis.patch.yml | 需真 DSH 冷启动验证（G0 步骤 3） |

---

## 10. 测试基线与 G1 回归门禁映射

现有 635 个测试，与群/隔离直接相关的可直接复用为 G1 门禁：

| 现有测试文件 | 覆盖内容 | G1 门禁用途 |
|---|---|---|
| `test/install.test.js:32` | 71 项注册**顺序**断言 | 复制后必须显式更新预期；任何意外重复注册立刻暴露 |
| `test/groups.test.js` | `mentionsIn`/`isPass`/`stripOwnName` | 复制版必须逐条通过 |
| `test/group-work.test.js`（31 例） | 轮次/宽限/迟到/停止/@ | 工作群等价回归主套件 |
| `test/group-status.test.js`（10 例） | 审批/停止/删除/失败 | 工作群状态机回归 |
| `test/rounds.test.js`（20 例） | 轮次边界、长行、附件、Session 失效 | 工作群轮次回归 |
| `test/room-races.test.js`（6 例） | 创建/删除竞态 | 隔离性回归 |
| `test/session-identity.test.js`（3 例） | 身份归属 | **G2 strict 解析**的基线 |
| `test/store.test.js`（12 例） | state 锁/只读/迁移 | 独立命名空间不得破坏 |
| `test/surface.test.js`（10 例） | Slot 装配/优先级/卸载 | UI Slot 风险回归 |
| `test/agents.test.js:204` | TEAM_TOOLS == 已注册工具 | 新增 `workgroup_*` 时强制同步 |
| `test/blocking-question.test.js` | restrict/guard 行为 | **restrict/guard 语义**基线（G2 关键） |
| `test/work-dir.test.js`（19 例） | cwd 校验、无效目录回退 | **P0-4 fail-closed** 基线 |

**结论**：G1 不需要从零写测试，而是把上表作为"复制版等价"门禁；新增的只有工作群域隔离用例（串群、双投递、重复注册）。
