# G6R 纠偏续接指令（复制原版群记忆 · Hub 只做跨机传输）

- 用法：新建会话后，把下面「指令正文」整段作为第一条消息发出。
- 适用范围：**只在本仓库工作**。`Workgroup-AI` 已冻结：不读、不改、不引用。
- 前置：G4/G5 自动门禁已并入 `main`（`e71119b`）；`main` 当前 HEAD 是 `1a022df`。
- 现行计划：[`docs/superpowers/plans/2026-10-24-g6r-copy-first-group-memory.md`](../../superpowers/plans/2026-10-24-g6r-copy-first-group-memory.md)
- **被否决方案**：`feat/g6-group-memory` 分支（10 个提交）与
  `docs/superpowers/plans/2026-10-26-g6-group-memory.md`。保留为反例，**不得 merge、不得继续实施**。
- **状态：G6R 尚未开工。** 本文是纠偏交接，不是执行记录。

---

## 指令正文（复制以下全部内容）

```text
你在 BotCode 工作副本里继续「工作群」项目，执行 G6R：把群记忆纠正为“复用原版群聊已有的
群记忆引擎，Hub 只做跨用户传输”，并先修掉让实现偏离的规则与文档。

## 0. 为什么有这个纠偏（先读，别跳过）

上一轮 G6 交付后，用户指出两个致命问题：

1. 群记忆本身原版群聊就有；工作群是复制原版群聊的，G6 却另建了一套 `group_memories`
   表和独立的记忆 UI。工作群的群记忆应当是**把原版已有的群记忆跨用户共享**，不是新建一个
   平行的群记忆再共享。
2. `AGENTS.md` 与各任务文档没有强制要求“在原版群聊复制后的工作群代码上改”，更多是在鼓励
   自制新 UI 或新功能。原版群聊的功能已经很完善；跨用户工作群要做的是**把一个群的所有信息
   打通、实时共享**，不是重做一遍。

已核实的事实（不要重新论证，直接接受）：

- 原版 `ds-bot/src/host/memory.js` 自带群记忆作用域 `memory/groups/<roomId>/`、
  `remember/forget/recall`、成员读写校验、容量（条目 300、MEMORY.md 4000、主题 16000、
  最多 40 主题）、回合后回顾 `reviewGroup`、记忆面板 `memory-view/ask/forget`、
  删除群时 `archiveGroupMemory` 归档。
- 原版面板已经能在工作群上打开：G3 补了 `rt.workgroupRoomOf` 只读解析缝。
- `main` 上真正缺的只有三件事：
  a. `roomIdOf(sessionId)` 不认识工作群成员 Session → 成员 Session 的提示词没有群记忆段，
     回顾也不会为它触发，`remember` 在工作群里默认写进 Bot 私人记忆；
  b. 工作群删除时没有调用 `archiveGroupMemory`；
  c. 群记忆只在本机文件里，没有任何跨机传输。
- `feat/g6-group-memory` 的迁移 v8（`group_memories`/`group_memory_events`/
  `group_memories_fts`）、`hub/src/memories/service.js`、五个 `memory-*` 端点、
  `group-settings.js` 的 `MemoryCard`、`state.memories` 投影、四类 `memory.*` 事件，
  都是**被否决的平行实现**，不要复用、不要 merge。

## 1. 仓库与基线

1. 根目录：`D:\code\ai\DeepSeek-Bot\BotCode`
   - 插件：`DeepSeek-Bot-main/ds-bot`
   - 服务端：`hub`（相对 `ds-bot` 是 `../../hub`）
   - 桌面端：`DeepSeek-Bot-main/app`
2. 从 `main` 开始，新分支名：`feat/g6r-group-memory-sync`。
   **不要**从 `feat/g6-group-memory` 开始：`git rev-parse --abbrev-ref HEAD` 必须是新分支，
   `git log --oneline main..HEAD` 在开工时必须是空。
3. 基线（`main` = `1a022df`，2026-10-25 重跑）：
   - `cd hub && npm test` → 268 tests / 268 pass / 0 fail
   - `cd ds-bot && npm test` → 1132 tests / 1131 pass / 1 skip / 0 fail
   - `node scripts/build-client.mjs --check` → exit 0
   - `npm run lint` → 0 error / 13 warning
   - `git diff --name-only main -- ds-bot/src/host` → 空
4. 不发版、不改版本号、不打包。
5. 口径优先级：用户需求 > 本指令「已定口径」 > 技术方案 > g0–g5 历史文档。

## 2. 必读（全部在本仓库）

1. `docs/superpowers/plans/2026-10-24-g6r-copy-first-group-memory.md` —— **本轮唯一实施计划**
2. `docs/plans/2026-10-09-context-and-memory.md` —— 原版记忆的格式、容量、权限、回顾、面板
3. `docs/workgroup/parity-audit.md` —— 复制完整性；注意 §1 与 §5 的群记忆口径已纠偏
4. `docs/workgroup/diff-manifest.md` §3.1 —— “原版没有 → 新写”登记表
5. `docs/workgroup/g6/NEXT-INSTRUCTION.md` 与
   `docs/superpowers/plans/2026-10-26-g6-group-memory.md` —— **反例**，只看它错在哪
6. `docs/workgroup/gates.md` —— 自动门禁的证据格式
7. `docs/workgroup/manual-checklist.md` —— 人工项不得自评

## 3. 范围（只做这些）

1. **规则层**：`AGENTS.md` + `CONTRIBUTING.md` 增加“工作群复制优先、禁止平行实现”硬规则。
2. **文档层**：纠正“原版没有群记忆”的错误口径；在 `diff-manifest.md` 增加新写登记表；
   给旧 G6 两份文档加“已被取代”声明。
3. **接缝层**：`rt.memoryRoomOf(sessionId)`（成员 Session → 本机 room id），并让原版
   `roomIdOf` 与 `agent/status` 用它。**不改 `rt.isBotSession` 语义。**
4. **观测层**：原版写入完成后调用 `rt.onMemoryWritten(change)`，异常只 warn，不改写入结果。
5. **传输层**：Hub `EVENT_TYPES` 加 `memory.change`；`hub/src/ws.js` 加同名帧处理器；
   插件 `memory-sync.js` 负责发送与接收；`bridge.apply` 分发；`ack.ok` 的聊天补偿只对聊天帧。
6. **应用层**：`rt.applyRemoteMemoryChange(change)` 走原版 `queued` 写队列、同一
   `writable` 校验、同一 `writeText`/`journal`/`noteNews`，按 `eventId` 幂等。
7. **归档**：`deleteWorkgroup` 调用 `rt.archiveGroupMemory(room)`。
8. **验证**：单机单元测试 + 两 Runtime 真 Hub 的跨机测试 + 全量门禁 + 证据矩阵。

## 4. 已定口径（不用再问）

1. **原版群记忆引擎是唯一的引擎与唯一的写入路径。** 工作群不新建第二个记忆存储、
   不新建第二套条目格式、不新建第二套权限规则、不新建第二个记忆面板。
2. **Hub 只做传输与顺序。** `memory.change` 是一条事件，Hub 不解释 `op`/`before`/`after`，
   不做 ACL 判断，不做容量校验，不生成记忆内容。
3. **不需要新表、不需要迁移。** 既有 `events` 表载荷上限 16 KiB；原版单条 ≤ 300 字符，
   一条变更远小于上限。迁移版本保持 v7。
4. **不新增 `memory-*` 端点。** 原版 `memory-view` / `memory-ask` / `memory-forget`
   已经在工作群房间上可用（G3 解析缝），继续用它们。
5. **不新增记忆 UI。** 工作群记忆入口仍是原版群详情里的 `MemoryRow` → `MemoryDialog`。
   删除 G6 的 `MemoryCard`、`panel.js` 的 memory feed 分支、`i18n.js` 的相关文案。
6. **`ds-bot/src/host/memory.js` 行为冻结。** 允许的改动只有：`roomIdOf` 加
   `rt.memoryRoomOf?.()` 分支、`agent/status` 过滤加同一接缝、`reportWrite` 观测、
   `applyRemoteMemoryChange` 受控应用入口。既有 `memory.test.js` 的断言不得修改。
7. **`rt.isBotSession` 语义不变。** 工作群成员 Session 依然不是原版 Bot Session；
   它只通过 `rt.memoryRoomOf` 参与记忆，不参与原版回合机制。
8. **私聊、团队、本地群记忆一律不上传。** 只有 `scope.kind === 'group'` 且该 room 有
   `hubWorkgroupId` 的才发事件。
9. **不发版、不打包**；人工验收仍由维护者执行。
10. **旧 G6 分支不删除、不 rebase、不 merge。** 它是被否决方案的证据。

## 5. 执行顺序（严格按计划 Task 1→13）

1. 规则：`AGENTS.md`、`CONTRIBUTING.md`
2. 文档口径：`parity-audit.md`、`COPY-BASELINE.md`、`progress-and-gaps.md`、`README.md`
3. 新写登记表：`diff-manifest.md` §3.1
4. 接缝：`rt.memoryRoomOf`（`ownership.js`）
5. 原版读/回顾：`memory.js` 的 `roomIdOf` 与 `agent/status`
6. 观测：`memory.js` 的 `reportWrite`
7. Hub：`EVENT_TYPES` + `ws.js` 帧处理器
8. 发送：`memory-sync.js` + `index.js` 挂 `rt.onMemoryWritten` + `state.js` 的 `memorySync`
9. 接收：`memory.js` 的 `applyRemoteMemoryChange` + `memory-sync.js` 的 `onMemoryEvent`
10. 分发：`bridge.js` 的 `apply()` + `ack.ok` 的 `frameType` 收敛
11. 归档：`groups.js` 的 `deleteWorkgroup`
12. 两机：`test-realtime/workgroup-memory-sync.test.js`
13. 文档与证据：`docs/workgroup/g6r/*`、旧 G6 声明、`README.md`、`gates.md`

每个任务都是「先写失败测试 → 跑出预期失败 → 最小实现 → 跑绿 → 提交」。

## 6. 每轮必须交付

- 改了哪些文件（diff 或摘要），以及每个改动属于「复制/复用」还是「原版没有 → 新写」
- 执行的命令与结果（Hub 测试、ds-bot 测试、build check、lint）
- 新增/修改的测试，以及它们证明哪条门禁
- 未解决的问题与阻塞（谁需要做什么）

## 7. 硬规则（违反即停）

1. **复制优先。** 任何“工作群要做到 X”的需求，先找原版群聊的 X 在哪个文件哪个函数；
   有就改复制件或走只读接缝；没有才新写，并先登记到 `diff-manifest.md` §3.1。
2. **不新建第二套业务语义。** 条目格式、容量、谁能读写、回顾规则、面板形态，一律来自原版。
3. **不改 DSH，不打补丁，不依赖 DSH 安装目录内的文件。** 缺能力就停下说明。
4. **冻结文件逐字节不变：** `ds-bot/src/host/{groups,turns,delivery,resume,constants}.js`。
   每轮交付前跑 `git diff --name-only main -- ds-bot/src/host`，输出只应包含 `memory.js`。
5. **`memory.test.js` 的既有断言不得改。** 只允许追加新用例。
6. **一个 Runtime 只安装一次工作群域**；二次安装必须抛错；域故障不能拖垮本地团队。
7. **数据隔离：** 本地群、工作群、私人记忆、团队记忆互不串写；本地群历史不上传。
8. **测试不得指向 `~/.dsh` 或用户自己的 DSH 数据**；用临时目录。
9. **测试必须走产品路径。** 跨机测试用两个 `createRuntime` + 真 Hub；单机测试用真实
   `startRoundFixture`；只有纯函数/迁移允许直接调用。
10. **不发版、不改版本号、不打包。**
11. **人工项不得自评 PASS。** G6-M1 与 G4/G5 人工项保持 BLOCKED。
12. **不读、不改、不引用 `Workgroup-AI`。**
13. **遇到会改变需求或架构的问题：停下，写「Plan deviation」，等人确认。**

## 8. 完成定义

- 两台 Runtime 上，A 用原版 `remember`（成员 Session 内）写一条群记忆，B 的
  `memory-view` 无需刷新即可看到；B 离群后不再收到新变更。
- 每台机器的记忆仍在 `<home>/memory/groups/<roomId>/MEMORY.md`，格式未变。
- 删除工作群后，该目录进入 `<home>/memory/archive/group-<roomId>-…`。
- `memory.test.js` 既有断言零改动且全绿；`hub npm test`、`ds-bot npm test`、
  `build-client --check`、`npm run lint` 全绿。
- `git diff --name-only main -- ds-bot/src/host` 只有 `memory.js`。
- 文档能回答：为什么 G6 是错的、G6R 改了什么、哪些是复制、哪些是新写、哪些必须人工。

## 9. 人工项（保持 BLOCKED）

- G6-M1：两台真机、两个账号；A 用记忆面板或群内 `remember` 写入，B 无需刷新可见；
  B 离群后不可见；Hub 重启后条目仍在。
- G4-1、G4-5、G4-6、G4-T20、G5-T12、G5-N3、G5-T14：不变。

## 附录 A：原版群记忆的准确位置（`main` = `1a022df`）

| 内容 | 位置 |
|---|---|
| 存储布局说明 | `ds-bot/src/host/memory.js:1-24` |
| 容量常量 | `memory.js:40` — `{ entry: 300, main: 4_000, topic: 16_000, topics: 40 }` |
| 群 scope 与目录 | `memory.js:463-464` — `groupScope` / `dirOf(..., 'groups', safeId(roomId))` |
| 成员 Session → room | `memory.js:468` — `roomIdOf`（缺 `rt.memoryRoomOf`） |
| 房间解析 | `memory.js:472` — `rt.roomOf(id) ?? rt.workgroupRoomOf?.(id)` |
| 群 keeper | `memory.js:474` — `keeperOf`（admin 的 Bot，否则第一个成员） |
| 写入权限 | `memory.js:523-531` — `writable()`；`memory.js:559` — `writeDenied()` |
| 添加/替换/删除 | `memory.js` 的 `addEntry` / `replaceEntry` / `removeEntry`（约 `:598-690`） |
| 归档 | `memory.js:705` — `archiveGroupMemory(room)` |
| 提示词记忆段 | `memory.js:733` — `memorySection`；群段标题见 `:320` |
| 面板 | `memory.js:1078` — `panelOf`；`memoryView/Ask/Forget` 在 `:1114-1190` |
| 群回顾 | `memory.js:1242` — `groupBatch`；`:1354` — `reviewGroup` |
| 回顾触发过滤 | `memory.js:1474-1476` — `agent/status` + `rt.isBotSession` |
| 导出 | `memory.js:1508-1511` — `memoryEndpoint`、`archiveGroupMemory` 等 |
| 原版删除群归档 | `ds-bot/src/host/roster.js:484` — `rt.archiveGroupMemory(room)` |

## 附录 B：Hub 与插件的当前事实（`main` = `1a022df`）

| 内容 | 事实 |
|---|---|
| 迁移 | 7 个版本，`LATEST_VERSION = 7`（`hub/src/db/migrations.js`） |
| 事件类型 | 18 项，无 `memory.*`（`hub/src/workgroups/service.js:34-56`） |
| 可读事件（未读） | `READABLE_EVENT_TYPE = 'chat.message'`（`service.js:61`） |
| WS 发送 handler | 只有 `chat.message` 一个（`hub/src/ws.js:179`） |
| 群成员检查 | `requireGroup`（`hub/src/ws.js:151`），非成员与不存在同回 `workgroup/not-found` |
| 事件载荷上限 | 16 KiB（`hub/src/workgroups/service.js:101`） |
| HTTP body 上限 | 64 KiB（`hub/src/http.js:15`） |
| 插件出站帧 | `bridge.sendEvent({ workgroupId, frameType, payload, eventId })`（`bridge.js:671`） |
| 帧构造 | `frameOf`（`bridge.js:150-170`） |
| **ack 聊天补偿** | `bridge.js:337-356`：收到自己 ack 时用 `sent.payload` 构造 `chat.message` 调 `apply` —— **非聊天帧必须先判断 `frameType`，否则会凭空多一条群消息** |
| 入站分发 | `bridge.js` 的 `apply()`：`chat.message`（`:211`）、task（`:238`） |
| 工作群房间映射 | `wg.roomOfHubGroup(workgroupId)`（`workgroup/host/groups.js:436-443`） |
| 成员 Session 创建 | `wg.sessionFor(room, member)`（`groups.js` 约 `:1373`） |
| 工作群状态文件 | `workgroup/host/state.js`，`emptyState()` 与 `adopt` 白名单（`:68`） |
| 测试夹具 | `ds-bot/test/workgroup-round.test.js` 的 `startRoundFixture()`（返回 `ctx/rt/wg/home/stop`） |
| 原版记忆测试夹具 | `ds-bot/test/memory.test.js` 的 `start()`；它不返回 runtime，Task 6 需把 `apply(ctx, …)` 换成 `createRuntime(ctx, …)` 并返回 `rt` |
| 跨机夹具 | `main` 上 **没有** `helpers-pair.js`；`withHub/openMachine/until/invitedPair/roomOf/lineByText` 是 `workgroup-realtime.test.js` 的私有函数（`:56/:86/:157/:188/:220/:224`），G6R Task 12 先把它们抽成导出文件再复用 |
| Hub 测试夹具 | `hub/test/ws-events.test.js` 的 `setup(t)`；`hub/test/g4-helpers.js` 的 `connect/groupWith` |

## 附录 C：开工前 checklist

- [ ] `git rev-parse --abbrev-ref HEAD` 是 `feat/g6r-group-memory-sync`，不是 `feat/g6-group-memory`
- [ ] `git log --oneline main..HEAD` 为空
- [ ] `git diff --name-only main -- ds-bot/src/host` 为空
- [ ] 跑过 §1 的四条基线命令，数字与记录一致
- [ ] 读过 §2 的 6 项必读，能说出旧 G6 错在哪一条
- [ ] 能指出原版 `memory.js` 的 `groups/<roomId>/`、`writeDenied`、`reviewGroup`、`panelOf` 在哪一行
```
