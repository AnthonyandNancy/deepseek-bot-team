# G6R 轮次日志

- 分支：`feat/g6-group-memory`（原地改造）
- 起点：`424ea46 docs(workgroup): add the in-place G6R conversion instruction`
- 状态：**自动化完成；人工项 BLOCKED**
- 口径优先级：用户需求 > `g6r/NEXT-INSTRUCTION.md` 的已定口径 > 技术方案 > g0–g5 历史文档

## 0. 纠偏的由来

2026-10-24，用户在执行完 G6 后指出两个致命问题：

1. **群记忆原版群聊就有。** 工作群是复制原版群聊的，G6 却自建了 `group_memories` 表、
   `memory-*` 端点和独立 `MemoryCard`。工作群的群记忆应该是把原版已有的群记忆**跨用户共享**，
   不是新建后共享。
2. **`AGENTS.md` 与任务文档没有强制“在复制后的工作群代码上改”。** 文档更多在鼓励新建 UI 或
   新建功能。原版群聊功能已经很完善；跨用户工作群要做的是把一个群的信息**打通、实时共享**。

## 1. 核实结论

### 1.1 原版确实有群记忆

| 能力 | 位置（`main` = `1a022df`） |
|---|---|
| 群作用域 `memory/groups/<roomId>/` | `ds-bot/src/host/memory.js:463-464` |
| 成员读写校验 | `memory.js:523-531`（`writable`）、`:559`（`writeDenied`） |
| 容量 | `memory.js:40` — 条目 300 / MEMORY.md 4000 / 主题 16000 / 40 主题 |
| 群回顾 | `memory.js:1242`（`groupBatch`）、`:1354`（`reviewGroup`） |
| 群面板 | `memory.js:1078`（`panelOf`）、`:1114-1190`（`memoryView/Ask/Forget`） |
| 删除群归档 | `memory.js:705`；原版 `roster.js:484` 调用它 |
| 工作群面板已可打开 | `rt.workgroupRoomOf`（`ownership.js:81`）；`workgroup-round.test.js` 的 `MemoryProbe` |
| 设计文档 | `docs/plans/2026-10-09-context-and-memory.md:80-112` |

### 1.2 `main` 上真正缺的三件事

| 缺口 | 证据 |
|---|---|
| 工作群成员 Session 不在原版 `groupOwners`，`roomIdOf` 找不到群 | `memory.js:468` 只查 `groupOwners` / `pastOwners`；`main` 无 `rt.memoryRoomOf` |
| 回顾过滤只认 `rt.isBotSession` | `memory.js:1474-1476` |
| 删除工作群不归档记忆 | `workgroup/host/groups.js:1229-1288` 无 `archiveGroupMemory` |

### 1.3 G6 的错

| G6 产物 | 为什么是错 |
|---|---|
| 迁移 v8 + `group_memories` / `group_memory_events` / `group_memories_fts` | 原版已有群记忆存储（Markdown），新建第二套存储 |
| `hub/src/memories/service.js`（311 行） | 第二套条目模型（`type/acl/version/sourceRefs`）、第二套权限、第二套容量 |
| 五个 `memory-*` 端点 | 原版 `memory-view/ask/forget` 已可用，端点重复 |
| `group-settings.js` 的 `MemoryCard` | 原版 `MemoryRow → MemoryDialog` 已有，UI 重复 |
| 四类 `memory.*` 事件 | 只需要“一条变更”一种事件，四类是新协议 |

**根因**：G6 计划 M3 把“只在本机”写成“No shared store at all”，把**传输缺失**误判为
**能力缺失**。

## 2. 纠偏设计（一句话）

原版引擎不动，只加一层传输：`rt.onMemoryWritten` → `memory.change` 事件 → Hub `events.seq`
→ 另一台机器 `rt.applyRemoteMemoryChange` → 原版写入路径。详见
`docs/workgroup/g6r/DESIGN-COPY-FIRST.md`。

## 3. 任务与真实结果

> 本轮在同一工作树原地完成；提交号在提交后回填。测试数字都是本轮实际运行的结果。

| Task | 内容 | 结果 |
|---|---|---|
| 1–3 | 复制优先规则、口径纠正、新写登记表 | 仓库既有文档；本轮把 diff-manifest 中 4 条已删除的平行实现移出“新写”表 |
| 4 | `rt.memoryRoomOf` 接缝 | 保留（G6 已做对）；`workgroup-memory-room.test.js` 通过 |
| 5 | 原版读/回顾覆盖工作群 | 保留 `roomIdOf` 与 `agent/status` 两处接缝；`bot-memory` 段测试通过 |
| 6 | `rt.onMemoryWritten` 观测 | 新增 `reportWrite`；原版 59 条既有断言未改，新增 observer 用例通过 |
| 7 | Hub `memory.change` 类型与帧处理器 | `EVENT_TYPES` 收敛为一类；`hub/test/ws-events.test.js` 扇出/未读测试通过 |
| 8 | 发送端 `memory-sync.js` | 新文件；上传过滤、roomKey、endpoint 身份测试通过 |
| 9 | 接收端 `applyRemoteMemoryChange` | 走原版 `queued`/`writable`/journal；幂等与离群拒绝通过 |
| 10 | bridge 分发 + ack 聊天补偿收敛 | 精确分发 `memory.change`；ack 仅 chat 走补偿；回归测试已验红绿 |
| 11 | 删除工作群归档 | 原版 `archiveGroupMemory` 调用保留；单机归档测试通过 |
| 12 | 两机传播 | 两台 `createRuntime` + 真 Hub：A 原版 `remember` → B 原版 `memory-view`；B 本人离群后收不到 |
| 13 | 文档与证据 | 本文件与 `EVIDENCE-MATRIX.md` 按真实输出更新；人工项保持 BLOCKED |

## 4. 计划偏差登记

### D1 — 远端 actor 身份必须使用 Hub endpoint，不能用对方本机 Bot id

- **原计划写法**：接收端 `writable(groupScope(roomId), actor)`，`actor` 就是事件里的
  `{ id: 'bot-a', name: 'Writer' }`。
- **实际 blocker**：`bot-a` 是 A 机器的本地 Bot id；B 机器没有这个 id，原版 `writable()` 会把它判成
  “已删除的 Bot”（`rt.botOf(id) === undefined`）。两机测试因此收不到条目。
- **偏差**：`memory.change` 帧携带 Hub 稳定身份 `botEndpointId`（与既有 `chat.message` 相同字段）；
  接收端用 `event.sender.botEndpointId` 在本机 roster 中解析成员。解析不到就丢弃。`applyRemoteMemoryChange`
  先验证该成员仍在本群；随后以原版 USER 身份写入（面板用户路径），把远端 Bot 名保留在 journal/by 中。
- **没有放宽的语义**：本群成员检查仍在；本机已删除的群仍由原版 `writable()` 拒绝；容量、条目格式、
  凭据拒收、journal、快照失效全部沿用原版。
- **确认**：用户本轮要求按复制的原版引擎落地，并明确“业务语义一律沿用原版”；此偏差是让协议能表达
  “跨机是谁写的”，不新增记忆语义。

### D2 — ack 回归测试必须观察 `receiveRemote`，不能只看日志行数

- **原计划写法**：ack 后 `room.log.length` 不变。
- **实际情况**：旧 bug 构造的空 `chat.message` 会被 `receiveRemote` 的空文本规则拒掉，日志行数仍不变，
  该断言抓不到 bug。
- **偏差**：回归测试同时 spy `wg.receiveRemote`，断言 memory ack 调用 0 次；临时移除 `isChat` guard 时
  得到 RED（2≠0），恢复后 GREEN。

## 5. 未解决与人工项

- G6-M1：**BLOCKED**，步骤见 `manual-checklist.md`。
- G4-1/5/6、G4-T20、G5-T12/N3/T14：**BLOCKED**。
- OS 钥匙串：DSH 0.2.1-rc.2 的 `dsh-credentials-local` README 明确 deferred；G6R 不涉及。
- 离线写入不补发：见 `DESIGN-COPY-FIRST.md` §5.2，属后续任务，不在 G6R。
