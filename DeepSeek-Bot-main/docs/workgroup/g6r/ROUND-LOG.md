# G6R 轮次日志

- 分支：`feat/g6r-group-memory-sync`（待创建）
- 起点：`main` = `1a022df docs(workgroup): add the G6 group memory plan and handoff`
- 状态：**未开工**
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

## 3. 任务与提交

> 实施后在此表逐行填写真实提交与测试结果。**未实施前不得填写。**

| Task | 内容 | 提交 | 证据 |
|---|---|---|---|
| 1 | 复制优先硬规则（`AGENTS.md`、`CONTRIBUTING.md`） | 待填 | 待填 |
| 2 | 纠正文档口径 | 待填 | 待填 |
| 3 | 新写登记表 | 待填 | 待填 |
| 4 | `rt.memoryRoomOf` 接缝 | 待填 | 待填 |
| 5 | 原版读/回顾覆盖工作群 | 待填 | 待填 |
| 6 | `rt.onMemoryWritten` 观测 | 待填 | 待填 |
| 7 | Hub `memory.change` 类型与帧处理器 | 待填 | 待填 |
| 8 | 发送端 `memory-sync.js` | 待填 | 待填 |
| 9 | 接收端 `applyRemoteMemoryChange` | 待填 | 待填 |
| 10 | bridge 分发 + ack 聊天补偿收敛 | 待填 | 待填 |
| 11 | 删除工作群归档 | 待填 | 待填 |
| 12 | 两机传播 | 待填 | 待填 |
| 13 | 文档与证据 | 待填 | 待填 |

## 4. 计划偏差登记

> 实施中出现偏差时在此登记：哪一步、为什么、谁确认。未实施前为空。

（无）

## 5. 未解决与人工项

- G6-M1：**BLOCKED**，步骤见 `manual-checklist.md`。
- G4-1/5/6、G4-T20、G5-T12/N3/T14：**BLOCKED**。
- OS 钥匙串：DSH 0.2.1-rc.2 的 `dsh-credentials-local` README 明确 deferred；G6R 不涉及。
- 离线写入不补发：见 `DESIGN-COPY-FIRST.md` §5.2，属后续任务，不在 G6R。
