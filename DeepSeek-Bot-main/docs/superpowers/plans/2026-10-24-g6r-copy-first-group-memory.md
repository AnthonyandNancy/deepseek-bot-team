# G6R 群记忆纠偏实施计划（复制原版引擎 · Hub 只做跨机传输）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 撤回 G6 自建的平行群记忆（`group_memories` 表、`memory-*` 端点、独立记忆 UI），改成“原版群聊已有的 Markdown 群记忆引擎原样复用，Hub 只把同一份群记忆的变更跨机器、跨用户传输并收敛”。

**Architecture:** 原版 `ds-bot/src/host/memory.js` 仍是唯一的记忆引擎与唯一的写入路径：`memory/groups/<roomId>/MEMORY.md` + 主题文件、`remember/forget/recall`、成员校验、容量、回顾、记忆面板、`journal.jsonl`、`archive/` 全部保留。工作群只新增一层**传输适配器**：原版引擎每完成一次群记忆写入，适配器把这次变更作为一条 `memory.change` 事件经 Hub 的既有 `events.seq` 流送出；其他机器收到后，调用原版引擎的同一条写入路径落地。于是每台机器都用同一套原版代码、同一份 Markdown 格式读到同一份群记忆。

**Tech Stack:** Node.js ESM, `node:test`, `node:sqlite` (`DatabaseSync`), `ws`, React sources compiled by `scripts/build-client.mjs`。复用既有 Hub HTTP + WSS `/v1/ws` 与既有 `/api/bot/feed`；不新增浏览器传输、不新增数据库表、不新增记忆 UI。

## Global Constraints

1. **复制优先，禁止另造。** 工作群是原版群聊的复制件。任何“要让工作群做到 X”的需求，顺序固定为：
   1. 先找原版群聊是否已有 X 的实现；
   2. 已有 → 在复制件上改，或通过原版暴露的只读接缝复用；不得新写一套平行实现；
   3. 原版没有 → 才允许新写，且必须在 `docs/workgroup/diff-manifest.md` 的“原版没有 → 新写”登记表里写明：原版最接近的实现是哪个文件哪个函数、为什么不能覆盖这个场景、为什么不能改复制件。
   违反此顺序的实现一律回退重做。
2. **业务语义不得新写。** 传输层、存储后端、协议适配可以新写；**谁能读写、条目长什么样、容量多少、回顾规则、面板形态**必须来自原版。原版已有的语义再写一遍就是缺陷。
3. **原版群记忆不是缺口。** 原版自带群作用域、成员校验、容量、回顾、面板与归档。工作群缺的只是**跨机传输**。把“本机各写各的”说成“没有群记忆”是错误的，不得作为新建平行存储的理由。
4. **不改 DSH，不打补丁。** 缺能力就停下说明。
5. **冻结文件逐字节不变：** `ds-bot/src/host/{groups,turns,delivery,resume,constants}.js`。
6. **`ds-bot/src/host/memory.js` 按“行为冻结”处理。** 允许的改动只有两类，且必须各自单独提交并说明：
   - 通用接缝：通过已存在的 `rt.roomOf` / `rt.workgroupRoomOf` 让原版代码解析工作群（本计划需要补 `rt.memoryRoomOf`，理由见 Task 5）；
   - 纯观测 + 受控应用：新增“写入完成后通知”的观测钩子，以及“把一条远端变更按原版写入路径应用”的入口。两者都不改变原版任何既有分支的结果，原版 `memory.test.js` 的断言不得修改。
   任何改变本机群记忆读写结果、文件布局、权限判断的改动＝越界，停下写“Plan deviation”。
7. **一个 Runtime 只安装一次工作群域**；二次安装必须抛错；域故障不得拖垮本地团队。
8. **数据隔离：** 本地群、工作群、私人记忆、团队记忆互不串写；本地群历史不自动上传。
9. **测试不得指向 `~/.dsh` 或用户数据**，只用临时目录。
10. **不发版、不改版本号、不打包。**
11. **人工项不得自评 PASS。**
12. **不读、不改、不引用** `Workgroup-AI`（冻结源）。

---

## 0. 本计划的由来（必须先读）

### 0.1 用户指出的两个致命问题

1. **群记忆是原版群聊已有的，G6 却自建了一套。** 工作群的群记忆应当是把原版已有的群记忆**跨用户共享**，不是新建一个平行的群记忆再共享。
2. **`AGENTS.md` 与各任务文档没有强制“在复制后的工作群代码上改”。** 文档更多在鼓励“新建 UI / 新建功能”，导致实现偏离“复制原版、只做打通”。

### 0.2 核实到的事实（每条都可复现）

| 事实 | 证据（`main` = `1a022df`） |
|---|---|
| 原版有群记忆作用域 `memory/groups/<roomId>/` | `ds-bot/src/host/memory.js:7`、`:463-464` |
| 原版群记忆是“这个群的成员共享，只在这个群里读” | `docs/plans/2026-10-09-context-and-memory.md:84`、`:97`、`:104` |
| 原版已有群记忆读写工具 | `memory.js` 的 `remember` / `forget` / `recall`，群内默认 `scope: "group"`（`:850-960` 区间） |
| 原版已有成员校验 | `writeDenied`（`memory.js:559`）→ `roomOf(scope.roomId)?.members.includes(botId)` |
| 原版已有容量与格式 | `MEMORY_LIMITS = { entry: 300, main: 4_000, topic: 16_000, topics: 40 }`（`memory.js:40`） |
| 原版已有群记忆回顾 | `reviewGroup`（`:1354`）、`groupBatch`（`:1242`）、`keeperOf`（`:474`） |
| 原版已有群记忆面板 | `panelOf`（`:1078`）、`groupSummaryRequest`（`:340`）、`memoryView/Ask/Forget`（`:1114-1190`） |
| 原版已有群记忆归档 | `archiveGroupMemory`（`:705`）；原版 `deleteRoom` 调用它（`src/host/roster.js:484`） |
| 原版面板已能在工作群上打开 | `rt.workgroupRoomOf` 接缝（`ownership.js:81`）；`workgroup-round.test.js` 的 `MemoryProbe` 用例 |
| `main` 上原版回顾**不会**为工作群成员触发 | `memory.js:1474-1476` 的 `rt.isBotSession` 过滤，且 `main` 没有 `rt.memoryRoomOf` |
| `main` 上工作群删除**不会**归档记忆 | `workgroup/host/groups.js:1229-1288` 无 `archiveGroupMemory` 调用 |
| G6 另建了一整套平行实现 | `feat/g6-group-memory`：`hub/src/memories/service.js`（311 行）、迁移 v8 三张表、`ds-bot/src/workgroup/host/memories.js`、五个 `memory-*` 端点、`group-settings.js` 的 `MemoryCard` |
| G6 把“本机记忆”误判为“没有记忆” | G6 计划 M3 行：`Workgroup memory is a local Markdown folder only` → “No shared store at all” |
| 复制优先规则只散落在个别文档 | `g3/NEXT-INSTRUCTION.md:87-88`、`HANDOFF-NEXT-SESSION.md:25`；`AGENTS.md` 完全没有 |
| `main` 的 Hub 只有 `chat.message` 一个发送 frame | `hub/src/ws.js:165` 起的 `handlers` 表；`EVENT_TYPES` 18 项（`hub/src/workgroups/service.js:34-56`） |
| `main` 的 Hub 迁移只到 v7 | `hub/src/db/migrations.js` 共 7 个 `version:`，`LATEST_VERSION` 为 7 |
| 插件 `bridge` 已有通用出站帧 | `bridge.sendEvent({ workgroupId, frameType, payload, eventId })`（`bridge.js:671`）与 `frameOf`（`:150-170`） |
| Hub HTTP body 上限 64 KiB | `hub/src/http.js:15` |
| Hub 事件载荷上限 16 KiB | `hub/src/workgroups/service.js:101` |

### 0.3 结论

- **保留**原版群记忆的一切：格式、容量、权限、回顾、面板、归档、`journal.jsonl`。
- **废弃** G6 的平行模型：`group_memories` / `group_memory_events` / `group_memories_fts` 迁移 v8、`hub/src/memories/service.js`、五个 `memory-*` 端点、`MemoryCard`、`state.memories` 投影、`memory.*` 四类事件。
- **新增**的只有“跨机传输”：一条 `memory.change` 事件类型、Hub 的一个帧处理器、插件端一个传输适配器、原版引擎的观测钩子与受控应用入口。

---

## 1. 目标与非目标

### 1.1 目标

1. 两台机器、两个不同账号，在同一个工作群看到**同一份**群记忆；A 用原版 `remember`、记忆面板或回顾产生的变更，B 无需手动刷新即可读到。
2. 每台机器的群记忆仍在原版位置、原版格式：`<home>/memory/groups/<roomId>/MEMORY.md` 与主题文件。
3. 权限仍由原版规则决定：只有该群成员能读写；离群后立即读不到、写不了。
4. 删除工作群时，原版 `archiveGroupMemory` 把该群记忆整份移入 `archive/`。
5. 原版群聊与本地群的记忆行为**零变化**：既有 `memory.test.js` 全绿且断言不改。
6. 文档层面把“复制优先、禁止平行实现”写成硬规则，让后续会话能据此拒绝自建方案。

### 1.2 非目标

- 不新建 Hub 记忆表、不做 FTS、不做 `expectedVersion` 面板协议。
- 不新建 `memory-*` 端点、不新建 `MemoryCard`、不改工作群设置页的记忆区。
- 不新建独立记忆 UI：工作群沿用原版群详情里的 `MemoryRow` → `MemoryDialog`。
- 不做服务端记忆生成；回顾仍由原版 `reviewGroup` 在本机用群管理员模型完成。
- 不导入本地群历史到工作群。
- 不引入向量库。
- 不改 DSH、不发版、不改版本号、不打包。

---

## 2. 设计

### 2.1 数据流

```
   A 机器                                              Hub                                    B 机器
┌───────────────────────────┐                ┌────────────────────┐                ┌───────────────────────────┐
│ 原版 memory.js             │  memory.change │ events（既有表）    │  memory.change │ 原版 memory.js             │
│  remember/forget/recall    │ ─────────────▶ │ seq 单调、event_id  │ ─────────────▶ │  remember/forget/recall    │
│  reviewGroup               │                │ 去重、deliveries    │                │  reviewGroup               │
│  memory/groups/<room>/     │ ◀───────────── │ ack_at、补拉        │ ◀───────────── │  memory/groups/<room>/     │
│  MEMORY.md + topics        │   回执/重连     └────────────────────┘   回执/重连      │  MEMORY.md + topics        │
└───────────────────────────┘                                                   └───────────────────────────┘
```

- **本机写入仍走原版**：`remember`、`forget`、记忆面板、回顾都是原版函数，落盘仍是原版 Markdown。
- **变更上报**：原版写入完成后，通过纯观测钩子 `rt.onMemoryWritten(change)` 交给传输适配器；适配器只在 scope 是“与本机某个工作群关联的群记忆”时才发 Hub。
- **远端应用**：B 收到后调用原版引擎的受控应用入口（同一 `queued` 写队列、同一 `writable()` 校验、同一 `writeText`/`journal`/`noteNews`），因此权限、容量、去重、日志、快照失效全部与原版一致。
- **一致性**：Hub 的 `events.seq` 是唯一顺序源；`event_id` 去重；重连后用既有 `sync.request` / `afterSeq` 补拉；应用幂等。

### 2.2 为什么不做文件同步

文件级同步会绕过原版引擎，产生原版本来不会有的四类问题：并发覆盖、容量校验失效、权限绕过、`journal.jsonl` 与 `reviewed.json` 不一致。**必须走原版写入路径**。

### 2.3 为什么不需要新表

Hub 的 `events` 表已能存任意 `type` + `payload`，载荷上限 16 KiB（`workgroups/service.js:101`）。原版单条条目上限 300 字符（`MEMORY_LIMITS.entry`），一条 `memory.change` 携带 `before` + `after` 两行，远小于 16 KiB。**因此本计划不新增迁移、不新增表、不新增 FTS。**

### 2.4 群记忆的标识

原版群记忆目录 key 是本机 `roomId`（群 Session id）。工作群有两层 id：

- 本机 room id（`wg-…`，每台机器不同）；
- Hub `workgroupId`（`wg_…`，全局唯一）。

事件携带 Hub `workgroupId`；接收端用 `wg.roomOfHubGroup(workgroupId)` 找回本机 room id，映射到本机 `memory/groups/<本机 roomId>/`。**这是跨用户共享能成立的关键**：记忆的逻辑归属是 Hub 群，物理落点是各机器自己的原版目录。

### 2.5 权限与失效

- 发送端：适配器只在该 room 有 `hubWorkgroupId` 且 bridge 已连接时上报；本机原版 `writable()` 已在写之前校验成员身份。
- 接收端：应用前由原版 `writable()` 再次校验本机 roster 里该 actor 仍是成员。
- 离群：Hub 停止向该设备投递该群事件（既有 `deliveries`）；本机原版 `writable()` 因成员不在 `members` 而拒绝写入。
- 删群：本机 `deleteWorkgroup` 调用原版 `archiveGroupMemory`；Hub 群删除后不再有事件。

### 2.6 为什么仍需 `rt.memoryRoomOf`

`main` 上 `memory.js` 的 `roomIdOf(sessionId)` 只查原版 `groupOwners` / `pastOwners`。工作群成员 Session 不在这两个 map 里，于是：

- `sectionFor()` 找不到 room → 工作群成员 Session 的提示词里**没有群记忆段**；
- `reviewOf()`/`reviewGroup` 找不到 room → 工作群**永远不回顾**；
- `callerOf()` 的 `roomId` 为空 → `remember` 在工作群里默认写到 Bot 私人记忆，而不是群记忆。

这不是“原版没有群记忆”，而是“原版不知道工作群成员 Session 属于哪个群”。补一个只读的 `rt.memoryRoomOf(sessionId)` 正是 G3 那次 `rt.workgroupRoomOf` 解析缝的同类延续。**只补解析，不改语义。**

---

## 3. 文件结构

| 文件 | 责任 | 性质 |
|---|---|---|
| `AGENTS.md` | 增加“工作群复制优先”硬规则 | 文档 |
| `CONTRIBUTING.md` | 同一规则，面向人类贡献者 | 文档 |
| `docs/workgroup/README.md` | 纠正水位与阅读顺序 | 文档 |
| `docs/workgroup/parity-audit.md` | 改写“记忆缺口”口径 | 文档 |
| `docs/workgroup/diff-manifest.md` | 增加“原版没有 → 新写”登记表 | 文档 |
| `docs/workgroup/g6/NEXT-INSTRUCTION.md` | 顶部加“已被 G6R 取代”声明 | 文档 |
| `docs/superpowers/plans/2026-10-26-g6-group-memory.md` | 顶部加“已被 G6R 取代”声明 | 文档 |
| `docs/workgroup/g6r/NEXT-INSTRUCTION.md` | **新**：自足纠偏续接指令 | 新文档 |
| `docs/workgroup/g6r/DESIGN-COPY-FIRST.md` | **新**：设计与取舍 | 新文档 |
| `docs/workgroup/g6r/EVIDENCE-MATRIX.md` | **新**：证据矩阵 | 新文档 |
| `docs/workgroup/g6r/ROUND-LOG.md` | **新**：轮次与偏差 | 新文档 |
| `ds-bot/src/host/memory.js` | 观测钩子 + 受控远端应用入口（行为不变） | 极小改动 |
| `ds-bot/src/workgroup/host/ownership.js` | 新增 `rt.memoryRoomOf(sessionId)` | 极小改动 |
| `ds-bot/src/workgroup/host/memory-sync.js` | **新**：把原版写入转成 Hub 事件、把远端事件应用回原版引擎 | 新代码 |
| `ds-bot/src/workgroup/host/groups.js` | `deleteWorkgroup` 调用 `archiveGroupMemory` | 改复制件 |
| `ds-bot/src/workgroup/host/bridge.js` | 分发 `memory.change` 事件 | 改复制件 |
| `ds-bot/src/workgroup/index.js` | 安装 `memory-sync`，挂 `rt.onMemoryWritten` | 改复制件 |
| `ds-bot/src/workgroup/host/state.js` | `memorySync` 状态键（发送/应用游标） | 改复制件 |
| `ds-bot/src/workgroup/host/channel.js` | **不新增**记忆端点（原版 `memory-view/ask/forget` 已可用） | 不改 |
| `ds-bot/src/workgroup/client/group-settings.js` | **不新增** `MemoryCard` | 不改 |
| `ds-bot/test/workgroup-memory-sync.test.js` | **新**：单机单元测试 | 新测试 |
| `ds-bot/test-realtime/workgroup-memory-sync.test.js` | **新**：两 Runtime + 真 Hub | 新测试 |
| `ds-bot/test/memory.test.js` | **不改断言**，只追加一个“钩子不改变结果”的用例 | 追加测试 |
| `hub/src/workgroups/service.js` | `EVENT_TYPES` 加 `memory.change` | 极小改动 |
| `hub/src/ws.js` | 新增 `memory.change` 帧处理器 | 小改动 |
| `hub/test/ws-events.test.js` | 追加：`memory.change` 扇出且不计未读 | 追加测试 |

**明确不做（相对 `feat/g6-group-memory` 全部删除，不 merge 该分支）**：

- 迁移 v8 与三张表、`hub/src/memories/service.js`、`hub/test/db-g6-schema.test.js`、`hub/test/group-memory.test.js`
- `ds-bot/src/workgroup/host/memories.js`
- `ds-bot/test/workgroup-memory-isolation.test.js`、`workgroup-memory-review.test.js`、`test-realtime/workgroup-memory.test.js`
- `group-settings.js` 的 `MemoryCard`、`panel.js` 的 memory feed 分支、`i18n.js` 相关文案
- `hub.js` 的五个 memory 方法、`channel.js` 的五个 memory case 与 `READS` 项
- `state.js` 的 `memories` 投影、`ownership.js` 的 `memoryRoomOf` **保留**（本计划需要）

> 旧分支 `feat/g6-group-memory` 保留在仓库里作为“被否决方案”的证据，不删除、不 rebase、不 merge。

---

## 4. 任务

### Task 1: 把“复制优先”写成仓库硬规则

**Files:**
- Modify: `AGENTS.md`（Hard rules，第 5 条之后）
- Modify: `CONTRIBUTING.md`（The rules that matter most，第 5 条之后）
- Test: 无（文档）

**Interfaces:**
- Produces: 一条所有后续会话都会读到的硬规则，措辞必须能直接否掉“新写一套平行功能”。

- [ ] **Step 1: 在 `AGENTS.md` 的 Hard rules 里加第 6 条**

```markdown
6. **The workgroup is a copy of the original group chat; copy first, never build a parallel one.**
   Every workgroup behaviour starts from the original group chat's implementation:
   - if the original already does it, change the copy under `ds-bot/src/workgroup/`, or reuse the
     original through a read-only seam — do not write a second implementation;
   - if the original does not do it, write it, and record in `docs/workgroup/diff-manifest.md`
     (the "原版没有 → 新写" table) which original file and function came closest, why it cannot
     cover this case, and why the copy cannot be changed instead.
   A new store, a new UI, or a new protocol that duplicates something the original group chat
   already has is a defect, not a feature. When a workgroup requirement looks like "the original
   cannot do this", first prove the original cannot: a missing cross-machine link is not a missing
   capability.
```

- [ ] **Step 2: 在 `CONTRIBUTING.md` 的 “The rules that matter most” 加第 6 条**

```markdown
6. **The workgroup copies the original group chat.** The workgroup under
   `ds-bot/src/workgroup/` is a copy of the original group chat, changed only where a workgroup
   genuinely differs (several accounts, a Hub, remote members). Before adding anything, check what
   the original already does: reuse it, or change the copy. A second implementation of something the
   original already has — a second memory store, a second settings UI, a second message path — is a
   defect. If the original truly lacks the capability, say so in the pull request and record it in
   `docs/workgroup/diff-manifest.md`.
```

- [ ] **Step 3: 自查**

```bash
cd DeepSeek-Bot-main
grep -n "copy of the original group chat" AGENTS.md
grep -n "copies the original group chat" CONTRIBUTING.md
```

Expected: 各命中 1 行。

- [ ] **Step 4: 提交**

```bash
git add AGENTS.md CONTRIBUTING.md
git commit -m "docs: require the workgroup to copy the original group chat first"
```

---

### Task 2: 纠正文档里“原版没有群记忆”的错误口径

**Files:**
- Modify: `docs/workgroup/parity-audit.md`（§1 结论、§4 表格“群记忆”行、§5 第 2 条）
- Modify: `docs/workgroup/g5/COPY-BASELINE.md`（第 151 行）
- Modify: `docs/workgroup/progress-and-gaps.md`（G6 行、缺口 11）
- Modify: `docs/workgroup/README.md`（水位行）

**Interfaces:**
- Produces: 所有文档统一口径——“原版有群记忆引擎；缺的是跨机传输”。

- [ ] **Step 1: 改 `parity-audit.md` §1 结论段**

原文：

```markdown
结论：**群模块本身复制完整**；缺的是**跨模块的群解析**——原版 `memory.js` 只认 `state.rooms`，工作群房间不在其中。已补一条只读解析缝并加测试。
```

改为：

```markdown
结论：**群模块本身复制完整，群记忆也原本就有**。原版 `memory.js` 自带群作用域
（`memory/groups/<roomId>/`）、成员读写校验、容量、回顾、记忆面板与归档；工作群缺的只是
**跨机传输**——每台机器各写各的本机文件，没有任何东西把它们连起来。G3 补的只读解析缝让原版
面板能在工作群上打开；G6R 补的是把同一份群记忆同步到其他机器，**不是新建一套群记忆**。
```

- [ ] **Step 2: 改 §4 表格的“群记忆”行**

原文：

```markdown
| **群记忆** | `host/memory.js` 按 room 查找 | 原缺失，本次补解析缝 | **本次修复** |
```

改为：

```markdown
| **群记忆** | `host/memory.js`：`groups/<roomId>/`、成员校验、回顾、面板、归档 | 原版引擎直接复用；跨机传输属 G6R | **已复制（引擎）/ G6R（传输）** |
```

- [ ] **Step 3: 改 §5 第 2 条**

原文：

```markdown
2. **群记忆只做到本机面板可用**：跨用户检索、来源与授权属 G6。
```

改为：

```markdown
2. **群记忆只做到本机可用**：原版引擎、面板、回顾都在，但每台机器各写各的文件，跨机共享属
   G6R。措辞要准确：这不是“原版没有群记忆”，而是“原版群记忆没有跨机传输”。
```

- [ ] **Step 4: 改 `g5/COPY-BASELINE.md` 第 151 行**

原文：

```markdown
| 群记忆跨用户检索 | 原版没有，属 G6 | `progress-and-gaps.md` 缺口 11 |
```

改为：

```markdown
| 群记忆跨机传输 | 原版有群记忆引擎，没有跨机传输；属 G6R | `parity-audit.md` §1、§5 |
```

- [ ] **Step 5: 改 `progress-and-gaps.md`**

G6 行改为：

```markdown
| G6R 群记忆跨机传输 | **未开工**（原 G6 方案被否决） | `docs/superpowers/plans/2026-10-24-g6r-copy-first-group-memory.md` | 原版引擎复用；人工项 G6-M1 仍待 |
```

缺口 11 改为：

```markdown
| 11 | ~~跨用户 Bot 委派/审批~~ **已做**（G5）；**群记忆跨机传输仍未做**：原版引擎已有，缺的是把本机变更同步到其他机器 | 原版有引擎、无传输 | 已定 | G6R |
```

- [ ] **Step 6: 改 `README.md` 水位行**

```markdown
- 水位：**G6 原方案被否决，G6R 纠偏待开工**。原版群记忆引擎已复用（G3 解析缝 + 原版面板）；缺的是跨机传输。G4/G5 自动门禁已并入 `main`（`e71119b`）；G4-1/5/6、G4-T20、G5-T12/N3/T14、G6-M1 仍待人工。纠偏计划见 `docs/superpowers/plans/2026-10-24-g6r-copy-first-group-memory.md`，续接指令见 `g6r/NEXT-INSTRUCTION.md`
```

- [ ] **Step 7: 自查**

```bash
cd DeepSeek-Bot-main
grep -rn "原版没有.*群记忆\|No shared store at all" docs/workgroup docs/superpowers/plans || echo "none"
```

Expected: `none`，或只剩明确标注为历史口径的旧阶段文档。

- [ ] **Step 8: 提交**

```bash
git add docs/workgroup/parity-audit.md docs/workgroup/g5/COPY-BASELINE.md \
  docs/workgroup/progress-and-gaps.md docs/workgroup/README.md
git commit -m "docs(workgroup): correct the claim that the original had no group memory"
```

---

### Task 3: 在 `diff-manifest.md` 增加“原版没有 → 新写”登记表

**Files:**
- Modify: `docs/workgroup/diff-manifest.md`（§3 之后）

**Interfaces:**
- Produces: 一个新写功能的登记表，后续任何“原版没有”的新代码都必须先在这里登记。

- [ ] **Step 1: 追加一节**

在“## 3. 未修改的原版文件（逐字节相同）”之后插入：

```markdown
## 3.1 “原版没有 → 新写”登记

任何工作群代码，若声称“原版没有这个能力，所以要新写”，必须先在本表登记，再写代码。
没有登记的新写模块，评审直接拒绝。

| 新写模块 | 原版最接近的实现 | 为什么不能复用或改复制件 | 判定 |
|---|---|---|---|
| `src/workgroup/host/hub.js` | 无（原版没有 Hub） | 跨用户传输在原版不存在，属真正的本域新增 | ✅ 合理 |
| `src/workgroup/host/bridge.js` | 无（原版没有 socket 同步） | 同上 | ✅ 合理 |
| `src/workgroup/host/memory-sync.js` | `src/host/memory.js` 的全套群记忆 | **不新写记忆引擎**：只把原版写入转成事件、把远端事件喂回原版写入路径 | ✅ 传输层新增，引擎复用 |
| ~~`hub/src/memories/service.js`~~ | `src/host/memory.js` | 重复实现了原版已有的条目模型、权限、容量与回顾入口 | ❌ 已否决（G6） |
| ~~`group-settings.js` 的 `MemoryCard`~~ | `client/memory-panel.js` + 原版群详情 `MemoryRow` | 重复实现了原版已有的记忆面板 | ❌ 已否决（G6） |

判定口径：

1. “原版没有”必须给出文件与函数级证据（哪个文件、哪个函数、为什么覆盖不了这个场景）。
2. “不能复用”必须说明复用会破坏什么（例如原版引擎是单进程文件写，跨机需要传输层）。
3. 传输、存储后端、协议适配可以是新写；**业务语义（谁能读写、条目长什么样、容量、回顾规则）不得新写**。
```

- [ ] **Step 2: 自查**

```bash
cd DeepSeek-Bot-main
grep -n "原版没有 → 新写" docs/workgroup/diff-manifest.md
```

Expected: 命中 1 行。

- [ ] **Step 3: 提交**

```bash
git add docs/workgroup/diff-manifest.md
git commit -m "docs(workgroup): require new modules to justify why the original cannot be reused"
```

---

### Task 4: 让原版回顾认识工作群成员 Session

**Files:**
- Modify: `ds-bot/src/workgroup/host/ownership.js`（新增 `memoryRoomOf`，并加入 `Object.assign(rt, …)`）
- Test: `ds-bot/test/workgroup-memory-room.test.js`

**Interfaces:**
- 新增 `rt.memoryRoomOf(sessionId)`：
  - 工作群**成员** Session → 该群的本机 room id；
  - 群自己的 relay Session（`owner.botId === undefined`）→ `undefined`；
  - 非本域 Session → `undefined`。
- `memory.js` **本任务不改**：`main` 上已有 `roomIdOf` 的可选调用吗？**没有**。因此本任务只加接缝，Task 5 再接上 `memory.js` 的两处调用点。

- [ ] **Step 1: 写失败测试**

```js
// ds-bot/test/workgroup-memory-room.test.js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startRoundFixture } from './workgroup-round.test.js'

test('a workgroup member Session resolves to its group; the relay Session does not', async (t) => {
  const { wg, rt, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({
    name: 'RoomProbe',
    members: [
      { id: 'bot-a', kind: 'localBot', name: 'Writer' },
      { id: 'bot-b', kind: 'localBot', name: 'Editor' },
    ],
    adminId: 'bot-a',
  })
  const memberSession = await wg.sessionFor(room, room.members[0])
  assert.equal(typeof rt.memoryRoomOf, 'function', 'memory needs a workgroup-aware room lookup')
  assert.equal(rt.memoryRoomOf(memberSession.id), room.id)
  assert.equal(rt.memoryRoomOf(room.id), undefined, 'the relay Session is not a member')
  assert.equal(rt.memoryRoomOf(undefined), undefined)
  assert.equal(rt.memoryRoomOf('not-a-session'), undefined)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-memory-room.test.js
```
Expected: FAIL — `rt.memoryRoomOf` is not a function。

- [ ] **Step 3: 实现**

在 `ownership.js` 的 `sessionGroupScope` 之后、`originalSelfOf` 之前插入：

```js
  // The group a MEMBER Session speaks in, for the original memory module. It answers a different
  // question from `sessionGroupScope` above: memory needs the ROOM ID, not a tool-facing scope
  // object, and it must not see the group's own relay Session (which has no member botId).
  //
  // Deliberately read-only, and deliberately NOT a change to `rt.isBotSession`: the original turn
  // machinery filters on that predicate, and answering "yes" here would make it manage a foreign
  // Session.
  function memoryRoomOf(sessionId) {
    const owner = sessionId === undefined ? undefined : sessionOwners.get(sessionId)
    return owner === undefined || owner.botId === undefined ? undefined : owner.workgroupId
  }
  wg.memoryRoomOf = memoryRoomOf
```

并在文件末尾 `Object.assign(rt, { … })` 里加 `memoryRoomOf,`。

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-memory-room.test.js
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add ds-bot/src/workgroup/host/ownership.js ds-bot/test/workgroup-memory-room.test.js
git commit -m "feat(workgroup): resolve a member Session to its group for the memory module"
```

---

### Task 5: 让原版记忆在工作群里读、写、回顾

**Files:**
- Modify: `ds-bot/src/host/memory.js`（两处：`roomIdOf` 与 `agent/status` 过滤）
- Test: `ds-bot/test/workgroup-memory-room.test.js`（追加）

**Interfaces:**
- `roomIdOf` 变成 `rt.groupOwners.get(sessionId)?.roomId ?? rt.pastOwners.get(sessionId)?.roomId ?? rt.memoryRoomOf?.(sessionId)`
- `agent/status` 过滤变成 `if (id === undefined || (!rt.isBotSession(id) && !rt.memoryRoomOf?.(id) && !turnOwners.has(id))) return`
- `rt.isBotSession` 语义**不变**。

- [ ] **Step 1: 追加失败测试**

```js
test('a workgroup member Session gets the group memory section and is reviewed', async (t) => {
  const { ctx, wg, rt, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({
    name: 'ReviewProbe',
    members: [
      { id: 'bot-a', kind: 'localBot', name: 'Writer' },
      { id: 'bot-b', kind: 'localBot', name: 'Editor' },
    ],
    adminId: 'bot-a',
  })
  const memberSession = await wg.sessionFor(room, room.members[0])
  // The prompt section is the ORIGINAL one (`bot-memory`), read the same way memory.test.js reads it.
  const section = ctx.sections.get('bot-memory').text({ agent: { id: memberSession.id } })
  assert.match(section, /## Group memory, shared by the members of this group chat/)
  // The relay Session speaks for no Bot, so it has no memory section at all.
  assert.equal(ctx.sections.get('bot-memory').text({ agent: { id: room.id } }), '')
  // The original predicate is untouched.
  assert.equal(rt.isBotSession(memberSession.id), false)
})
```

> `startRoundFixture()` 返回 `ctx`（`workgroup-round.test.js:116`），`fakeContext` 把注册的
> systemPrompt section 存在 `ctx.sections`（`fake-ctx.js:29,82`），`memory.test.js` 正是用
> `ctx.sections.get('bot-memory').text(...)` 读它。**不要为了测试新造导出。**

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL — 工作群成员 Session 的 section 里没有群记忆段。

- [ ] **Step 3: 实现两处改动**

`memory.js`：

```js
  const roomIdOf = sessionId => rt.groupOwners.get(sessionId)?.roomId ?? rt.pastOwners.get(sessionId)?.roomId ?? rt.memoryRoomOf?.(sessionId)
```

```js
      if (id === undefined || (!rt.isBotSession(id) && !rt.memoryRoomOf?.(id) && !turnOwners.has(id))) return
```

- [ ] **Step 4: 跑原版记忆测试，确认零回归**

Run:
```bash
cd ds-bot && node --test test/memory.test.js
```
Expected: 全部 PASS，且**没有修改任何既有断言**。

- [ ] **Step 5: 跑新测试**

Run:
```bash
cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-memory-room.test.js test/workgroup-round.test.js
```
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add ds-bot/src/host/memory.js ds-bot/test/workgroup-memory-room.test.js
git commit -m "feat(workgroup): let the original memory module read and review workgroup members"
```

---

### Task 6: 原版写入完成后发出一条纯观测通知

**Files:**
- Modify: `ds-bot/src/host/memory.js`（`addEntry`、`replaceEntry`、`removeEntry`）
- Test: `ds-bot/test/memory.test.js`（**只追加**一个用例）

**Interfaces:**
- Produces `rt.onMemoryWritten?.(change)`，其中：

```js
{
  scope: { kind: 'group', roomId } | { kind: 'bot', botId } | { kind: 'team' },
  file: { topic: string | undefined, file: string, path: string },
  op: 'add' | 'replace' | 'remove',
  before: string | undefined,   // the whole line before the change
  after: string | undefined,    // the whole line after the change
  actor: { id: string, name: string },
}
```

- 返回值和异常都被忽略：异常只 `rt.warn`，绝不影响原版写入结果。

- [ ] **Step 1: 追加失败测试**

在 `ds-bot/test/memory.test.js` 末尾追加（`start()` 是文件已有的 fixture）：

```js
test('a completed memory write is reported to an observer, and a failing observer changes nothing', async (t) => {
  const { rt, tool, read, stop } = start()
  t.after(() => stop())
  const seen = []
  rt.onMemoryWritten = (change) => { seen.push(change) }
  assert.match(await tool('remember', { text: 'Observer probe' }, 'b2'), /^Saved to your memory/)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].op, 'add')
  assert.equal(seen[0].scope.kind, 'bot')
  assert.match(seen[0].after, /^- Observer probe \[source: .+; added: \d{4}-\d{2}-\d{2}\]$/)
  // A throwing observer must not fail or roll back the write.
  rt.onMemoryWritten = () => { throw new Error('observer exploded') }
  assert.match(await tool('remember', { text: 'Still saved' }, 'b2'), /^Saved to your memory/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /Still saved/)
})
```

> `start()` 目前不暴露 runtime：它调 `apply(ctx, …)`，而 `apply` 是
> `createRuntime(ctx, config)` 的丢弃返回值包装（`ds-bot/index.js:50-52`）。**最小改法**：把
> `start()` 里那行 `apply(ctx, { home, ...config })` 换成
> `const rt = createRuntime(ctx, { home, ...config })`，从 `ds-bot/index.js` 的具名导出里加
> `createRuntime`，并把 `rt` 加进 `start()` 的返回对象。这是**测试夹具**的最小改动，不新增产品
> 导出、不改任何断言。

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL — `seen.length` 为 0。

- [ ] **Step 3: 实现**

在 `memory.js` 的 `journal` 附近加：

```js
  // A pure observer: the workgroup transport uses it to mirror a change it did not make itself.
  // It runs AFTER the file and the journal are written, its result is ignored, and a failure is a
  // warning — never a reason for a memory write to fail or to be rolled back.
  function reportWrite(change) {
    try {
      rt.onMemoryWritten?.(change)
    } catch (error) {
      rt.warn('ds-bot: memory observer failed: %s', error?.message ?? error)
    }
  }
```

在 `addEntry` 的 `noteNews(scope, actor, 'add', line)` 之前加：

```js
      reportWrite({ scope, file: target, op: 'add', before: undefined, after: line, actor })
```

在 `replaceEntry` 的 `noteNews(scope, actor, 'replace', line)` 之前加：

```js
      reportWrite({ scope, file: old.file, op: 'replace', before, after: line, actor })
```

在 `removeEntry` 的 `noteNews(scope, actor, 'remove', before)` 之前加：

```js
      reportWrite({ scope, file: old.file, op: 'remove', before, after: undefined, actor })
```

- [ ] **Step 4: 跑测试**

Run:
```bash
cd ds-bot && node --test test/memory.test.js
```
Expected: 新用例 PASS，既有用例全绿。

- [ ] **Step 5: 提交**

```bash
git add ds-bot/src/host/memory.js ds-bot/test/memory.test.js
git commit -m "feat(memory): report a completed write to an optional observer"
```

---

### Task 7: Hub 接受并扇出 `memory.change`

**Files:**
- Modify: `hub/src/workgroups/service.js`（`EVENT_TYPES`）
- Modify: `hub/src/ws.js`（新增 `memory.change` 帧处理器）
- Test: `hub/test/ws-events.test.js`（追加）

**Interfaces:**
- `EVENT_TYPES` 加 `'memory.change'`；`READABLE_EVENT_TYPE` 保持 `'chat.message'`。
- 新 frame：`{ v:1, type:'memory.change', workgroupId, eventId, payload }`
- 处理器与 `chat.message` 同形：`requireGroup` → `events.append({ type:'memory.change', sender:{userId,deviceId}, payload })` → `ack.ok` → `fanOut(...)`。
- 载荷形状由插件定义，Hub **不解释**：

```js
{
  roomKey: 'wg_hub_1',                 // Hub workgroupId
  op: 'add' | 'replace' | 'remove',
  topic: null | 'travel',              // null = MEMORY.md
  before: null | '- …',
  after: null | '- …',
  actor: { id: 'bot-a', name: 'Writer' } | { id: 'user', name: 'user' },
  at: '2026-10-24T00:00:00.000Z'
}
```

- [ ] **Step 1: 写失败测试**

在 `hub/test/ws-events.test.js` 追加。该文件顶部的 `setup(t)` 与 `connect`（来自
`./g4-helpers.js`）就是现成夹具，直接使用：

```js
test('a memory change fans out and is never an unread chat message', async (t) => {
  const { hub, alice, bob, workgroupId } = await setup(t)
  const a = connect(hub, alice)
  const b = connect(hub, bob)
  t.after(() => Promise.all([a.close(), b.close()]))
  await a.hello()
  await b.hello()
  const before = await hub.get(`/v1/workgroups/${workgroupId}`, { token: bob.token })
  const eventId = 'evt-memory-1'
  const from = a.cursor
  a.send({
    type: 'memory.change',
    workgroupId,
    eventId,
    payload: {
      roomKey: workgroupId,
      op: 'add',
      topic: null,
      before: null,
      after: '- The budget closes on the 25th. [source: test; added: 2026-10-24]',
      actor: { id: 'bot-a', name: 'Writer' },
      at: '2026-10-24T00:00:00.000Z',
    },
  })
  const ack = await a.next(message => message.type === 'ack.ok' && message.eventId === eventId, { label: 'ack', from })
  assert.ok(Number.isInteger(ack.seq))
  const received = await b.next(message => message.type === 'event' && message.event.eventId === eventId)
  assert.equal(received.event.payload.after, '- The budget closes on the 25th. [source: test; added: 2026-10-24]')
  const after = await hub.get(`/v1/workgroups/${workgroupId}`, { token: bob.token })
  assert.equal(after.body.unreadCount, before.body.unreadCount, 'memory is not an unread chat message')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd hub && node --test test/ws-events.test.js
```
Expected: FAIL — `"memory.change" is not part of the v1 protocol.`

- [ ] **Step 3: 加事件类型**

`hub/src/workgroups/service.js` 的 `EVENT_TYPES` 末尾（`artifact.revoked` 之后）加：

```js
  // ── group memory (G6R) ──────────────────────────────────────────────────
  // One change the ORIGINAL memory engine already made on the machine that made it. The Hub
  // stores and orders it; it never interprets the entry, its format or who may write it.
  'memory.change',
```

- [ ] **Step 4: 加帧处理器**

`hub/src/ws.js` 的 `handlers` 表里、`chat.message` 之后加：

```js
    'memory.change'(ws, info, message) {
      const workgroupId = requireGroup(ws, info, message.workgroupId)
      if (workgroupId === undefined) return undefined
      try {
        const { event, duplicate } = events.append({
          workgroupId,
          eventId: message.eventId,
          type: 'memory.change',
          sender: { userId: info.userId, deviceId: info.deviceId },
          payload: message.payload,
        })
        send(ws, { type: 'ack.ok', workgroupId, eventId: event.eventId, seq: event.seq, duplicate })
        if (!duplicate) fanOut(workgroupId, event, { exceptDeviceId: info.deviceId })
        return undefined
      } catch (error) {
        if (error instanceof HubError) return refuse(ws, error.code, error.message)
        throw error
      }
    },
```

- [ ] **Step 5: 跑测试**

Run:
```bash
cd hub && node --test test/ws-events.test.js
```
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add hub/src/workgroups/service.js hub/src/ws.js hub/test/ws-events.test.js
git commit -m "feat(hub): accept and fan out memory.change events"
```

---

### Task 8: 原版变更上报到 Hub（发送端）

**Files:**
- Create: `ds-bot/src/workgroup/host/memory-sync.js`
- Modify: `ds-bot/src/workgroup/index.js`（import + 模块顺序 + 挂 `rt.onMemoryWritten`）
- Modify: `ds-bot/src/workgroup/host/state.js`（`memorySync: {}` 加入 `emptyState` 与 `adopt` 白名单）
- Test: `ds-bot/test/workgroup-memory-sync.test.js`

**Interfaces:**
- `wg.onMemoryWritten(change)`：只在 `change.scope.kind === 'group'` 且该 room 有 `hubWorkgroupId` 且 bridge 已连接时发事件；否则返回。
- `wg.memorySyncState(workgroupId)`：`{ lastSentAt, lastAppliedAt, applied }`（测试/排障）。
- 状态键：`wg.state.memorySync[hubWorkgroupId] = { lastSentAt, lastAppliedAt, applied }`。

- [ ] **Step 1: 写失败测试**

```js
// ds-bot/test/workgroup-memory-sync.test.js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startRoundFixture } from './workgroup-round.test.js'

const twoMembers = () => ([
  { id: 'bot-a', kind: 'localBot', name: 'Writer' },
  { id: 'bot-b', kind: 'localBot', name: 'Editor' },
])

test('a group memory write is sent as one memory.change event', async (t) => {
  const { wg, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: 'SyncProbe', members: twoMembers(), adminId: 'bot-a', hubWorkgroupId: 'wg_hub_1' })
  const sent = []
  wg.bridge = { status: () => ({ connected: true }), sendEvent: async (frame) => { sent.push(frame) } }

  await wg.onMemoryWritten({
    scope: { kind: 'group', roomId: room.id },
    file: { topic: undefined, file: 'MEMORY.md', path: '/tmp/MEMORY.md' },
    op: 'add',
    before: undefined,
    after: '- The budget closes on the 25th. [source: test; added: 2026-10-24]',
    actor: { id: 'bot-a', name: 'Writer' },
  })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].frameType, 'memory.change')
  assert.equal(sent[0].workgroupId, 'wg_hub_1')
  assert.equal(sent[0].payload.roomKey, 'wg_hub_1', 'the Hub id, never the local room id')
  assert.equal(sent[0].payload.op, 'add')
  assert.equal(sent[0].payload.topic, null)
  assert.match(sent[0].payload.after, /budget closes on the 25th/)
})

test('private, team and local-only group writes are never sent', async (t) => {
  const { wg, stop } = startRoundFixture()
  t.after(stop)
  const local = await wg.createWorkgroup({ name: 'LocalOnly', members: twoMembers(), adminId: 'bot-a' })
  const sent = []
  wg.bridge = { status: () => ({ connected: true }), sendEvent: async (frame) => { sent.push(frame) } }
  await wg.onMemoryWritten({ scope: { kind: 'bot', botId: 'bot-a' }, file: { topic: undefined }, op: 'add', after: '- x', actor: { id: 'bot-a', name: 'Writer' } })
  await wg.onMemoryWritten({ scope: { kind: 'team' }, file: { topic: undefined }, op: 'add', after: '- y', actor: { id: 'bot-a', name: 'Writer' } })
  await wg.onMemoryWritten({ scope: { kind: 'group', roomId: local.id }, file: { topic: undefined }, op: 'add', after: '- z', actor: { id: 'bot-a', name: 'Writer' } })
  assert.deepEqual(sent, [])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-memory-sync.test.js
```
Expected: FAIL — `wg.onMemoryWritten is not a function`。

- [ ] **Step 3: 实现 `memory-sync.js`**

```js
// The workgroup's memory transport. The memory ENGINE is the original one in
// `src/host/memory.js`: the same files, rules, review and panel. This module carries a completed
// change to the other machines and applies a change that came from one.
//
// It deliberately knows nothing about entry formats, capacity or who may write: the original engine
// decides all of that before `onMemoryWritten` runs, and decides it again when a remote change is
// applied through the same write path.
import { randomUUID } from 'node:crypto'

export function install(wg) {
  const { rt } = wg

  const entryOf = (workgroupId) => {
    wg.state.memorySync ??= {}
    wg.state.memorySync[workgroupId] ??= { lastSentAt: 0, lastAppliedAt: 0, applied: 0 }
    return wg.state.memorySync[workgroupId]
  }

  const hubRoom = (roomId) => {
    const room = wg.workgroupOf(roomId)
    return room?.hubWorkgroupId === undefined ? undefined : { room, hubWorkgroupId: room.hubWorkgroupId }
  }

  async function onMemoryWritten(change) {
    if (change?.scope?.kind !== 'group') return
    const found = hubRoom(change.scope.roomId)
    if (found === undefined) return
    if (wg.bridge?.status?.().connected !== true) return
    const { hubWorkgroupId } = found
    const payload = {
      roomKey: hubWorkgroupId,
      op: change.op,
      topic: change.file?.topic ?? null,
      before: change.before ?? null,
      after: change.after ?? null,
      actor: change.actor ?? { id: 'user', name: 'user' },
      at: new Date().toISOString(),
    }
    try {
      await wg.bridge.sendEvent({
        workgroupId: hubWorkgroupId,
        frameType: 'memory.change',
        payload,
        eventId: `mev_${randomUUID().replace(/-/g, '')}`,
      })
      entryOf(hubWorkgroupId).lastSentAt = Date.now()
      await wg.save({ workgroupId: hubWorkgroupId, kind: 'memory' })
    } catch (error) {
      rt.warn?.('ds-bot: group memory change for %s not sent: %s', hubWorkgroupId, error?.message ?? error)
    }
  }

  function memorySyncState(workgroupId) {
    return entryOf(workgroupId)
  }

  wg.onMemoryWritten = onMemoryWritten
  wg.memorySyncState = memorySyncState
}
```

- [ ] **Step 4: 挂到 runtime 与安装顺序**

`state.js` 的 `emptyState()` 加 `memorySync: {}`，`adopt` 白名单加 `'memorySync'`。

`index.js`：

```js
import * as memorySync from './host/memory-sync.js'
```

模块数组里放在 `bridge` 之后（它要用 `wg.bridge`）、`channel` 之前：

```js
const WG_MODULES = [state, ownership, tasks, taskRunner, handoffs, roundState, groups, hub, bridge, memorySync, upgrade, channel]
```

安装完成后挂观测钩子（`installWorkgroup` 的 `try` 块里，循环之后）：

```js
    // The original memory engine reports a completed write; this domain decides whether it is a
    // group memory that belongs to a Hub workgroup. A team with no Hub pays nothing.
    rt.onMemoryWritten = change => { void rt.workgroup?.onMemoryWritten?.(change) }
```

> 注意：`rt.onMemoryWritten` 必须在 `installWorkgroup` 返回前设置，且**只设置一次**。二次安装
> 已经在函数开头抛错，因此不会覆盖。

- [ ] **Step 5: 跑测试**

Run:
```bash
cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-memory-sync.test.js
```
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add ds-bot/src/workgroup/host/memory-sync.js ds-bot/src/workgroup/index.js \
  ds-bot/src/workgroup/host/state.js ds-bot/test/workgroup-memory-sync.test.js
git commit -m "feat(workgroup): send a completed group memory write to the Hub"
```

---

### Task 9: 把远端变更应用回原版引擎（接收端）

**Files:**
- Modify: `ds-bot/src/host/memory.js`（新增 `rt.applyRemoteMemoryChange`，走原版 `queued` 写队列）
- Modify: `ds-bot/src/workgroup/host/memory-sync.js`（`onMemoryEvent` 真正应用）
- Test: `ds-bot/test/workgroup-memory-sync.test.js`（追加）

**Interfaces:**
- `rt.applyRemoteMemoryChange({ eventId, roomId, op, topic, before, after, actor })` →
  `{ changed: boolean, reason?: 'duplicate' | 'unknown-op' | 'not-member' }`
- 幂等表：`<home>/memory/applied.json`，存最近 500 个 `eventId`（FIFO），与原版 `reviewed.json` 同目录。
- 应用前调用原版 `writable(groupScope(roomId), actor)`；`DENIED`/`GONE` 直接返回 `{ changed: false, reason }`，不抛给 socket。

- [ ] **Step 1: 追加失败测试**

```js
test('a remote change lands in the original memory store and is idempotent', async (t) => {
  const { wg, rt, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: 'ApplyProbe', members: twoMembers(), adminId: 'bot-a' })
  const change = {
    eventId: 'mev_test_1',
    roomId: room.id,
    op: 'add',
    topic: null,
    before: null,
    after: '- Shipping address is the Hangzhou warehouse. [source: test; added: 2026-10-24]',
    actor: { id: 'bot-a', name: 'Writer' },
  }
  const first = await rt.applyRemoteMemoryChange(change)
  assert.equal(first.changed, true)
  const view = await rt.memoryEndpoint('memory-view', { roomId: room.id })
  assert.equal(view.entries.some(entry => entry.text.includes('Hangzhou warehouse')), true,
    'the entry is in the ORIGINAL memory store, not a separate cache')
  const second = await rt.applyRemoteMemoryChange(change)
  assert.equal(second.changed, false)
  assert.equal(second.reason, 'duplicate')
  assert.equal(view.entries.filter(entry => entry.text.includes('Hangzhou warehouse')).length, 1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL — `rt.applyRemoteMemoryChange is not a function`。

- [ ] **Step 3: 实现**

先把 `addEntry` / `replaceEntry` / `removeEntry` 的函数体原样提取成不含 `queued()` 的内层函数（`addEntryInner` / `replaceEntryInner` / `removeEntryInner`），外层保留 `queued(async () => …)` 与原有返回值。这是**纯结构提取**，不改任何行为，提取后立刻跑 `node --test test/memory.test.js` 确认全绿。

然后在 `removeEntry` 之后加：

```js
  // A change another machine made through THIS SAME engine. It is applied by the same queued
  // writer, the same `writable` check, the same size rules and the same journal as a local change,
  // so a remote memory can never be a shape the local engine would refuse to write itself.
  //
  // Idempotent by the Hub event id: a replay after a reconnect changes nothing.
  const appliedPath = join(root, 'applied.json')
  /** @type {Set<string> | undefined} */
  let applied
  const appliedNow = () => {
    if (applied === undefined) {
      try {
        const value = JSON.parse(readFileSync(appliedPath, 'utf8'))
        applied = new Set(Array.isArray(value) ? value : [])
      } catch {
        applied = new Set()
      }
    }
    return applied
  }
  async function rememberApplied(eventId) {
    if (typeof eventId !== 'string' || eventId === '') return
    const seen = appliedNow()
    seen.add(eventId)
    while (seen.size > 500) seen.delete(seen.values().next().value)
    await writeText(appliedPath, JSON.stringify([...seen]))
  }

  function applyRemoteMemoryChange({ eventId, roomId, op, topic, before, after, actor }) {
    return queued(async () => {
      if (typeof eventId === 'string' && appliedNow().has(eventId)) return { changed: false, reason: 'duplicate' }
      const scope = groupScope(roomId)
      try {
        writable(scope, actor)
      } catch (failure) {
        return { changed: false, reason: 'not-member', message: failure?.message }
      }
      const label = 'the group memory'
      const cleanTopicArg = topic === null || topic === undefined ? undefined : cleanTopic(String(topic))
      if (op === 'add' || op === 'replace') {
        const text = cleanEntry(String(after ?? '').replace(/^-\s+/, ''))
        const problem = entryProblem(text)
        if (problem !== undefined) return { changed: false, reason: 'invalid' }
        const meta = splitMeta(String(after)).meta
        if (op === 'add') {
          const result = await addEntryInner({ scope, topic: cleanTopicArg, text, meta, actor, label })
          if (result.changed) await rememberApplied(eventId)
          return result
        }
        const result = await replaceEntryInner({ scope, topic: cleanTopicArg, match: cleanEntry(String(before ?? '').replace(/^-\s+/, '')), text, meta, actor, label })
        if (result.changed) await rememberApplied(eventId)
        return result
      }
      if (op === 'remove') {
        const result = await removeEntryInner({ scope, topic: cleanTopicArg, match: cleanEntry(String(before ?? '').replace(/^-\s+/, '')), actor, label })
        if (result.changed) await rememberApplied(eventId)
        return result
      }
      return { changed: false, reason: 'unknown-op' }
    })
  }
```

并在文件末尾 `Object.assign(rt, { … })` 加 `applyRemoteMemoryChange`。

> `USER` 常量定义在 `:993`，`applyRemoteMemoryChange` 插在 `:720` 附近时还不可用——它只使用传入的
> `actor`，不引用 `USER`，因此没有顺序问题。

- [ ] **Step 4: 补全 `memory-sync.js` 的接收路径**

```js
  async function onMemoryEvent({ workgroupId, event }) {
    if (event?.type !== 'memory.change') return
    const body = event.payload ?? {}
    if (body.roomKey !== workgroupId) return
    const room = wg.roomOfHubGroup?.(workgroupId)
    if (room === undefined) return
    const result = await rt.applyRemoteMemoryChange({
      eventId: event.eventId,
      roomId: room.id,
      op: body.op,
      topic: body.topic,
      before: body.before,
      after: body.after,
      actor: body.actor,
    })
    if (result.changed) {
      const record = entryOf(workgroupId)
      record.applied += 1
      record.lastAppliedAt = Date.now()
      await wg.save({ workgroupId, kind: 'memory' })
    }
  }
```

并在 `install` 末尾 `Object.assign` 或直接赋值处加 `wg.onMemoryEvent = onMemoryEvent`。

- [ ] **Step 5: 跑测试**

Run:
```bash
cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test/workgroup-memory-sync.test.js
cd ds-bot && node --test test/memory.test.js
```
Expected: 新用例 PASS，原版记忆测试全绿且断言未改。

- [ ] **Step 6: 提交**

```bash
git add ds-bot/src/host/memory.js ds-bot/src/workgroup/host/memory-sync.js \
  ds-bot/test/workgroup-memory-sync.test.js
git commit -m "feat(memory): apply a remote group memory change through the original engine"
```

---

### Task 10: 接上 bridge 事件分发，并修掉 `ack.ok` 的聊天误判

**Files:**
- Modify: `ds-bot/src/workgroup/host/bridge.js`（`apply()` 内加分支；`ack.ok` 的聊天补偿按 `frameType` 收敛）
- Test: `ds-bot/test/workgroup-bridge.test.js`（追加两条断言）

**为什么必须一起改：** `bridge.js` 的 `ack.ok` 在收到自己的 ack 时，会用 `sent.payload` 拼一条
`type: 'chat.message'` 调用 `apply(..., { mine: true })`（`:337-356`）。那是给聊天消息用的
“发送方看到自己那条”的补偿。若 `memory.change` 也走同一个 outbox，它一被 ack 就会被当成聊天
行画进群日志——一条凭空出现的空消息。因此本任务同时修两件事：分发收到的 `memory.change`，
以及让 ack 的聊天补偿只对聊天消息生效。

**Interfaces:**
- `apply()` 收到 `event.type === 'memory.change'` 时调用 `wg.onMemoryEvent({ workgroupId, event })`；
- 不进入 `receiveRemote`、不写聊天日志、不启动回合。

- [ ] **Step 1: 写失败测试**

`ds-bot/test/workgroup-bridge.test.js` 已有 `withHub(t)`（真 Hub）、`signIn(hub, phone)`、
`withDomain(t, { baseUrl, phone })`（真 runtime + 已登录账号）、`until(predicate)`，以及
`alice.wg.bridge.createWorkgroup / invite / answerInvite / start / send` 的完整用法。用它们写：

```js
test('a memory.change event reaches the memory adapter and never becomes a chat line', async (t) => {
  const { hub, baseUrl } = await withHub(t)
  await signIn(hub, '+8613800138000')
  const alice = await withDomain(t, { baseUrl, phone: '+8613800138000' })
  const bobPhone = '+8613900139000'
  await signIn(hub, bobPhone)
  const bob = await withDomain(t, { baseUrl, phone: bobPhone })

  const created = await alice.wg.bridge.createWorkgroup({ name: '记忆同步' })
  const workgroupId = created.workgroupId
  const invite = await alice.wg.bridge.invite({ workgroupId, phone: bobPhone })
  await bob.wg.bridge.answerInvite({ inviteId: invite.inviteId, accept: true })
  await alice.wg.bridge.start()
  await bob.wg.bridge.start()
  await until(() => alice.wg.bridge.status().connected && bob.wg.bridge.status().connected, { label: 'both sockets' })

  const seen = []
  bob.wg.onMemoryEvent = (args) => { seen.push(args) }
  const bobRoom = bob.wg.roomOfHubGroup(workgroupId)
  const linesBefore = bobRoom.log.length

  await alice.wg.bridge.sendEvent({
    workgroupId,
    frameType: 'memory.change',
    payload: {
      roomKey: workgroupId, op: 'add', topic: null, before: null,
      after: '- The budget closes on the 25th.', actor: { id: 'user', name: 'user' },
      at: new Date().toISOString(),
    },
  })

  await until(() => seen.length === 1, { label: "Bob's memory adapter to receive the change" })
  assert.equal(seen[0].event.type, 'memory.change')
  assert.equal(bob.wg.roomOfHubGroup(workgroupId).log.length, linesBefore,
    'a memory change must never become a chat line')

  // The SENDER's own ack must not turn it into a chat line either.
  const aliceRoom = alice.wg.roomOfHubGroup(workgroupId)
  const aliceLines = aliceRoom.log.length
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(alice.wg.roomOfHubGroup(workgroupId).log.length, aliceLines,
    'the ack of a memory change must not append a chat line on the sender')
})
```

> 这里用 `bridge.sendEvent` 直接发一帧，正是产品路径（任务帧也走它）；不需要 mock Hub。

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit --test-name-pattern="memory.change" test/workgroup-bridge.test.js
```
Expected: FAIL — 没注册 `memory.change` 帧处理器时 Hub 回 `frame/unsupported`；注册后 `seen` 仍为 0，
直到 `apply()` 分发。

- [ ] **Step 3: 加两条改动**

第一处，`apply()` 里 `chat.message` 分支之后、task 分支之前加：

```js
    // A group memory change was made by the ORIGINAL memory engine on another machine. It is not a
    // chat line and starts no round; it is applied to this machine's own memory files through that
    // same engine, so every machine ends up with an identical group memory.
    if (event.type === 'memory.change') {
      void Promise.resolve(wg.onMemoryEvent?.({ workgroupId, event }))
        .catch(error => logger?.warn?.('ds-bot: memory change %s not applied: %s', event.eventId, error?.message ?? error))
    }
```

第二处，`ack.ok` 分支里，把“发送方看到自己那条”的补偿限定为聊天帧：

```js
          // The Hub does NOT echo an event back to the device that sent it, so a CHAT line has to be
          // applied here or the author never sees what they wrote. A non-chat frame (a memory
          // change, a task frame) is not a line: applying it as `chat.message` drew an empty bubble
          // the Hub never stored.
          const isChat = sent !== undefined && (sent.frameType === undefined || sent.frameType === 'chat.message')
          if (isChat && Number.isFinite(frame.seq) && frame.duplicate !== true) {
            void apply(workgroupId, {
              eventId: frame.eventId,
              workgroupId,
              seq: frame.seq,
              type: 'chat.message',
              sender: {
                userId: auth?.hubUserId,
                deviceId: auth?.deviceId,
                ...(sent.botEndpointId === undefined ? {} : { botEndpointId: sent.botEndpointId }),
              },
              payload: sent.payload,
              createdAt: new Date(now()).toISOString(),
            }, { mine: true })
          }
```

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交**

```bash
git add ds-bot/src/workgroup/host/bridge.js ds-bot/test/workgroup-bridge.test.js
git commit -m "feat(workgroup): route memory.change events to the memory sync adapter"
```

---

### Task 11: 删除工作群时归档原版群记忆

**Files:**
- Modify: `ds-bot/src/workgroup/host/groups.js`（`deleteWorkgroup`）
- Test: `ds-bot/test/workgroup-memory-sync.test.js`（追加）

**Interfaces:**
- `deleteWorkgroup` 在释放成员 Session、`dropLines` 之前调用 `rt.archiveGroupMemory(room)`。

- [ ] **Step 1: 追加失败测试**

```js
test('deleting a workgroup archives the original group memory folder', async (t) => {
  const { wg, home, stop } = startRoundFixture()
  t.after(stop)
  const room = await wg.createWorkgroup({ name: 'ArchiveProbe', members: twoMembers(), adminId: 'bot-a' })
  const dir = join(home, 'memory', 'groups', room.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n\n- Keep me [source: test; added: 2026-10-24]\n')
  await wg.deleteWorkgroup(room.id)
  assert.equal(existsSync(dir), false, 'the live folder is gone')
  const archived = readdirSync(join(home, 'memory', 'archive')).filter(name => name.startsWith(`group-${room.id}-`))
  assert.equal(archived.length, 1, 'and it moved to archive/, as the original does')
})
```

> `startRoundFixture()` 已返回 `home`（`workgroup-round.test.js:116`），用它，不要假设 `rt.home`。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 加归档调用**

在 `deleteWorkgroup` 的 Hub 删除之后、`for (const sessionId of Object.values(room.sessions ?? {}))` 之前加：

```js
    // The original `deleteRoom` moves a group's memory into `archive/`; the copied group must do the
    // same, or a deleted workgroup leaves its knowledge where a later room with the same id could
    // read it. It runs before the member Sessions leave the record, because the archive reads their
    // snapshots.
    await Promise.resolve()
      .then(() => rt.archiveGroupMemory(room))
      .catch(error => rt.warn('ds-bot: memory of workgroup %s not archived: %s', room.name, error?.message ?? error))
```

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交**

```bash
git add ds-bot/src/workgroup/host/groups.js ds-bot/test/workgroup-memory-sync.test.js
git commit -m "fix(workgroup): archive the original group memory when a workgroup is deleted"
```

---

### Task 12: 两机真实传播

**Files:**
- Create: `ds-bot/test-realtime/helpers-pair.js`
- Modify: `ds-bot/test-realtime/workgroup-realtime.test.js`（改为从新文件 import 同一批 helper）
- Create: `ds-bot/test-realtime/workgroup-memory-sync.test.js`

**Interfaces:**
- 两台 Runtime、真 Hub、两个账号、同一工作群。
- A 用**原版 `remember` 工具**（成员 Session 内，默认写群记忆）写一条；B 的 `memory-view` 无需手动刷新即可看到。
- B 离群后 A 再写，B 不再收到。

**为什么先抽取夹具：** `main` 上 `withHub` / `openMachine` / `until` / `invitedPair` /
`roomOf` / `lineByText` 都是 `workgroup-realtime.test.js` 里的**私有函数**
（`:56`、`:86`、`:157`、`:188`、`:220`、`:224`），没有 `export`。第二个测试文件要用它们，
必须先抽到一个导出文件；复制一份是第二套夹具，明令禁止。

**为什么不用 `memory-ask`：** 它要发一次模型调用，而 realtime 夹具的 `llm` 只有
`listProviders: () => []`，没有可脚本化的模型回复。`remember` 是原版引擎的同一个 `addEntry`
写路径，不需要模型，更直接地证明“原版写入会被跨机同步”。

- [ ] **Step 1: 抽取共享夹具**

把 `withHub`、`openMachine`、`until`、`invitedPair`、`roomOf`、`lineByText`，连同它们依赖的
常量（`PASSWORD`、`ALICE`、`BOB`、`TEAM`、`ALICE_TEAM`、`BOB_TEAM` 等）从
`workgroup-realtime.test.js` **原样移动**到 `helpers-pair.js`，加 `export`；原文件改成

```js
import {
  ALICE, BOB, ALICE_TEAM, BOB_TEAM, PASSWORD,
  withHub, openMachine, until, invitedPair, roomOf, lineByText,
} from './helpers-pair.js'
```

`machine` 若只被 `helpers-pair.js` 内部使用，就不导出。

- [ ] **Step 2: 先跑原 realtime 套件，确认抽取没有改变行为**

Run:
```bash
cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test-realtime/workgroup-realtime.test.js
```
Expected: 与抽取前同样的全绿（记录条数，抽取后必须一致）。

- [ ] **Step 3: 写跨机测试**

```js
// ds-bot/test-realtime/workgroup-memory-sync.test.js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invitedPair, until, roomOf } from './helpers-pair.js'

test('a group memory entry written on one machine reaches the other, through the original engine', async (t) => {
  const { alice, bob, workgroupId } = await invitedPair(t)
  // A member Session speaks in the group, so the original `remember` defaults to the GROUP scope.
  const aliceRoom = roomOf(alice, workgroupId)
  const member = aliceRoom.members.find(entry => entry.kind === 'localBot')
  assert.ok(member !== undefined, 'Alice has a local Bot in the group')
  const session = await alice.wg.sessionFor(aliceRoom, member)
  const saved = await alice.ctx.registeredTools.get('remember').execute(
    { text: 'Every invoice needs a PO number.' },
    { agent: { id: session.id } },
  )
  assert.match(saved, /^Saved to the group memory/)

  const bobRoom = roomOf(bob, workgroupId)
  await until(async () => {
    const view = await bob.rt.memoryEndpoint('memory-view', { roomId: bobRoom.id })
    return view.entries.some(entry => entry.text.includes('PO number'))
  }, { label: "Bob's original memory engine to receive Alice's entry" })
})
```

> `sessionFor(room, member)` 是产品方法（`groups.js:1373` 附近注册 member Session）；
> `remember` 工具的 execute 参数与 `memory.test.js` 相同：`({ ...args }, { agent: { id } })`。

- [ ] **Step 4: 跑测试确认失败**

Run:
```bash
cd ds-bot && node --import ./test/harness-resolve.mjs --test --test-force-exit test-realtime/workgroup-memory-sync.test.js
```
Expected: FAIL — B 的 `memory-view` 里没有该条目。

- [ ] **Step 5: 修到通过**

按失败原因定位：事件没到 Hub → 查 Task 8 的发送；到了没分发 → 查 Task 10；分发了没落盘 → 查 Task 9 的 `writable` 与 room 映射。

- [ ] **Step 6: 追加离群失效断言**

在同一个测试末尾追加：

```js
  // A member who left must stop receiving the group's memory changes.
  const roster = await alice.wg.hub.workgroup(workgroupId)
  const bobMembership = roster.members.find(entry => entry.role !== 'owner' && entry.memberType === 'user')
  await alice.wg.bridge.leaveMember({ workgroupId, membershipId: bobMembership.membershipId })
  await alice.ctx.registeredTools.get('remember').execute(
    { text: 'A second entry that Bob must not receive.' },
    { agent: { id: session.id } },
  )
  await new Promise(resolve => setTimeout(resolve, 500))
  const after = await bob.rt.memoryEndpoint('memory-view', { roomId: bobRoom.id })
  assert.equal(after.entries.some(entry => entry.text.includes('must not receive')), false,
    'a member who left receives no further memory changes')
```

> `leaveMember({ workgroupId, membershipId })` 的签名见 `bridge.js:800`；成员字段名见 Hub
> `publicMember`（`service.js:147` 起）。

- [ ] **Step 7: 跑全量**

Run:
```bash
cd ds-bot && npm test
```
Expected: 全绿。

- [ ] **Step 8: 提交**

```bash
git add ds-bot/test-realtime/helpers-pair.js ds-bot/test-realtime/workgroup-realtime.test.js   ds-bot/test-realtime/workgroup-memory-sync.test.js
git commit -m "test(workgroup): prove group memory crosses machines through the original engine"
```

---

### Task 13: 文档收口与证据矩阵

**Files:**
- Create: `docs/workgroup/g6r/DESIGN-COPY-FIRST.md`
- Create: `docs/workgroup/g6r/EVIDENCE-MATRIX.md`
- Create: `docs/workgroup/g6r/ROUND-LOG.md`
- Create: `docs/workgroup/g6r/NEXT-INSTRUCTION.md`
- Modify: `docs/workgroup/g6/NEXT-INSTRUCTION.md`（顶部“已被取代”声明）
- Modify: `docs/superpowers/plans/2026-10-26-g6-group-memory.md`（顶部“已被取代”声明）
- Modify: `docs/workgroup/README.md`（索引加 `g6r/`）
- Modify: `docs/workgroup/gates.md`（G6R 小节）

- [ ] **Step 1: 在旧 G6 两份文档顶部加声明**

```markdown
> **⚠️ 已被 G6R 取代（2026-10-24）。** 本方案把“原版群记忆没有跨机传输”误判为“原版没有群记忆”，
> 据此刻意新建了 `group_memories` 表、`memory-*` 端点和独立记忆 UI，违反“工作群是原版群聊复制件、
> 先在复制件上改”的规则。保留本文仅作历史记录与反例，**不得据此实施**。现行方案见
> [`docs/superpowers/plans/2026-10-24-g6r-copy-first-group-memory.md`](../../superpowers/plans/2026-10-24-g6r-copy-first-group-memory.md)
> 与 [`docs/workgroup/g6r/NEXT-INSTRUCTION.md`](../../workgroup/g6r/NEXT-INSTRUCTION.md)。
```

- [ ] **Step 2: 写 `g6r/NEXT-INSTRUCTION.md`**

必须自足，至少包含：

1. 仓库与基线（`main` 起点、如何确认自己不在旧分支上）；
2. 必读清单（本计划、`parity-audit.md`、`docs/plans/2026-10-09-context-and-memory.md`、旧 G6 作为反例）；
3. 已定口径（复制优先、Hub 只做传输、原版引擎行为冻结）；
4. 12 条硬规则（与本计划 Global Constraints 同源）；
5. Task 1–12 的执行顺序与每步验证命令；
6. 完成定义；
7. 附录：原版群记忆的准确位置与函数名（供新会话核对）。

- [ ] **Step 3: 写 `g6r/EVIDENCE-MATRIX.md`**

每行一条断言，指向具体测试文件与断言名；人工项 `G6-M1` 保持 BLOCKED。

- [ ] **Step 4: 跑全量门禁**

```bash
cd hub && npm test
cd ../DeepSeek-Bot-main/ds-bot && npm test
node scripts/build-client.mjs --check
npm run lint
git diff --name-only main -- ds-bot/src/host
```

Expected: 全绿；最后一条只应列出 `ds-bot/src/host/memory.js`（观测钩子、远端应用入口、两处接缝），且 `memory.test.js` 的既有断言未改。

- [ ] **Step 5: 提交**

```bash
git add docs/workgroup/g6r docs/workgroup/g6/NEXT-INSTRUCTION.md \
  docs/superpowers/plans/2026-10-26-g6-group-memory.md docs/workgroup/README.md docs/workgroup/gates.md
git commit -m "docs(workgroup): record the copy-first group memory design and evidence"
```

---

## 5. 验证矩阵

| 要求 | 任务 | 证据 |
|---|---|---|
| 仓库硬规则要求复制优先 | 1 | `AGENTS.md`、`CONTRIBUTING.md` 的 grep |
| 文档不再说“原版没有群记忆” | 2 | `grep -rn "原版没有.*群记忆"` 为空 |
| 新写模块必须登记理由 | 3 | `diff-manifest.md` §3.1 |
| 工作群成员 Session 能解析到群 | 4 | `workgroup-memory-room.test.js` |
| 原版记忆段与回顾覆盖工作群成员 | 5 | `workgroup-memory-room.test.js` + `memory.test.js` 零回归 |
| 原版写入可被观测，且行为不变 | 6 | `memory.test.js` 追加用例 + 原有用例全绿 |
| Hub 接受 `memory.change`，扇出且不算未读 | 7 | `ws-events.test.js` |
| 群写入会上报；私聊/团队/本地群不上报 | 8 | `workgroup-memory-sync.test.js` |
| 远端变更走原版引擎、幂等 | 9 | `workgroup-memory-sync.test.js` + `memory-view` 断言 |
| bridge 正确分发且不写聊天日志 | 10 | `workgroup-bridge.test.js` |
| 删除工作群归档原版记忆 | 11 | `workgroup-memory-sync.test.js` |
| 两机真实传播 | 12 | `test-realtime/workgroup-memory-sync.test.js` |
| 证据与人工项口径 | 13 | `g6r/EVIDENCE-MATRIX.md` |

## 6. 人工门禁（保持 BLOCKED）

- G6-M1：两台真机、两个账号，A 用原版记忆面板或群内 `remember` 写入，B 无需刷新可见；B 离群后不可见。
- 其余 G4/G5 人工项不变：G4-1、G4-5、G4-6、G4-T20、G5-T12、G5-N3、G5-T14。

## 7. 明确不做

- 不新建 `group_memories` 表、不建 FTS、不做 `expectedVersion`。
- 不新建 `memory-*` 端点、不新建 `MemoryCard`、不改工作群设置页的记忆区。
- 不改原版记忆的文件格式、容量、权限、回顾与面板。
- 不把本地群记忆上传。
- 不发版、不打包。
