# G6R 设计：复制原版群记忆，Hub 只做跨机传输

- 日期：2026-10-24
- 状态：**自动化已实施；人工项 BLOCKED**（取代 G6 `group_memories` 方案）
- 范围：跨用户工作群的群记忆共享
- 非目标：新记忆存储、新记忆 UI、新记忆协议、向量检索、多 Hub 联邦、本地群历史导入、发版

## 1. 一句话结论

原版群聊**已经有完整的群记忆**：`memory/groups/<roomId>/` 的 Markdown、成员读写校验、容量、
回合后回顾、记忆面板、删除归档。工作群是原版群聊的复制件，所以要做的不是“新建一个群记忆”，
而是**把原版群记忆的变更跨机器同步**，让两台机器用同一套原版代码读到同一份记忆。

## 2. 错在哪（G6 的根因）

G6 计划把 M3 写成：

> Workgroup memory is a local Markdown folder only (`bot/memory/groups/<roomId>`) —
> Nothing crosses machines; no ACL, version or source refs — No shared store at all

这句话的前半句是对的（只在本机），后半句是错的（“没有共享存储”被读成“没有群记忆能力”）。
于是它另建：

- `hub/src/memories/service.js`：第二套条目模型（`type/content/acl/version/sourceRefs`）；
- 迁移 v8：`group_memories`、`group_memory_events`、`group_memories_fts`；
- 五个 `memory-*` 端点与 `ds-bot/src/workgroup/host/memories.js` 投影；
- `group-settings.js` 的 `MemoryCard`：第二个记忆面板；
- 四类 `memory.*` 事件。

这违反了两件事：

1. **工作群是原版群聊的复制件**：原版已有的能力，不应在工作群域再实现一次；
2. **跨用户工作群只做打通**：Hub 的职责是把一个群的信息实时共享，不是重新定义群的业务语义。

## 3. 设计

### 3.1 原版引擎不动

保留 `ds-bot/src/host/memory.js` 的全部行为：存储布局、条目格式、容量、权限、回顾、面板、归档、
`journal.jsonl`、`snapshots/`、`reviewed.json`。

### 3.2 只补三个缺口

| 缺口 | 修法 | 为什么不是“新功能” |
|---|---|---|
| 工作群成员 Session 不属于原版 `groupOwners`，`roomIdOf` 找不到群 | 新增 `rt.memoryRoomOf(sessionId)`，`roomIdOf` 追加该分支 | 与 G3 的 `rt.workgroupRoomOf` 同类：只补“这个 Session 属于哪个群”的解析 |
| 回顾的 `agent/status` 过滤只认 `rt.isBotSession` | 追加 `!rt.memoryRoomOf?.(id)` | 让原版回顾覆盖工作群成员；`rt.isBotSession` 语义不变 |
| 工作群删除不归档记忆 | `deleteWorkgroup` 调用 `rt.archiveGroupMemory(room)` | 原版 `deleteRoom` 本来就这么做（`roster.js:484`） |

### 3.3 跨机传输

```
原版写入完成
   ↓ rt.onMemoryWritten(change)        ← 纯观测，异常只 warn
工作群传输适配器 memory-sync.js
   ↓ bridge.sendEvent({ frameType: 'memory.change', payload })
Hub events 表（既有，无新表）
   ↓ events.seq 顺序 + event_id 去重 + deliveries + ack
另一台机器的 bridge.apply()
   ↓ wg.onMemoryEvent({ workgroupId, event })
rt.applyRemoteMemoryChange(change)
   ↓ 原版 queued 写队列 + writable() + writeText() + journal() + noteNews()
另一台机器的 memory/groups/<本机 roomId>/MEMORY.md
```

### 3.4 为什么走事件流而不是文件同步

文件同步会绕过原版引擎，产生原版不会有的四类问题：

1. 并发覆盖：两台机器同时改 `MEMORY.md`，后写覆盖先写；
2. 容量校验失效：合并后的文件可能超过 4000 / 16000 字符；
3. 权限绕过：文件同步不检查成员身份；
4. `journal.jsonl`、`reviewed.json`、`snapshots/` 与实际内容不一致。

走原版写入路径，这四个问题都由原版代码回答。

### 3.5 为什么不需要新表

- `events` 表能存任意 `type` + `payload`，载荷上限 16 KiB；
- 原版单条条目 ≤ 300 字符，一条变更携带 `before` + `after` 两行；
- 最坏情况远小于 16 KiB。

所以 `memory.change` 就是一条普通事件，复用 `seq`、`event_id`、`deliveries`、`ack_at`、
`sync.request`、`read_cursors` 的既有语义。**不新增迁移。**

### 3.6 幂等与顺序

- 发送端为每条变更生成 `eventId`（`mev_…`），走 bridge outbox；未 ack 的重连后重发，Hub 按
  `event_id` 去重。
- 接收端 `rt.applyRemoteMemoryChange` 用 `<home>/memory/applied.json` 记录已应用的 `eventId`
  （最近 500 个），同一事件重放不产生第二条。
- 应用顺序由 `events.seq` 决定；`bridge.apply` 已经按 `seq` 排序 `sync.batch`。
- **`ack.ok` 的聊天补偿必须按 `frameType` 收敛**：`bridge.js:337-356` 会用 `sent.payload`
  构造 `chat.message` 并 `apply(..., { mine: true })`，那是给聊天消息的。`memory.change` 若
  不排除，发送端自己的记忆变更会变成一条空聊天行。

### 3.7 权限与失效

- 发送端：原版 `writable()` 已在写之前校验成员身份；适配器只上传 `scope.kind === 'group'`
  且该 room 有 `hubWorkgroupId` 的变更。
- 接收端：`applyRemoteMemoryChange` 再调一次原版 `writable()`，成员不在群里就返回
  `{ changed: false, reason: 'not-member' }`，不抛给 socket。
- 离群：Hub 停止向该设备投递该群事件（既有 `deliveries` + `memberUserIds`）；本机 `writable()`
  也拒绝。
- 删群：本机 `archiveGroupMemory` 归档；Hub 群删除后事件流不再有新事件。

### 3.8 记忆的逻辑归属与物理落点

| 概念 | 值 | 用途 |
|---|---|---|
| Hub `workgroupId` | `wg_…`，全局唯一 | 事件里的 `roomKey`；跨机身份 |
| 本机 `roomId` | `wg-…`（群 Session id），每台机器不同 | `memory/groups/<roomId>/` 的目录名 |
| 映射 | `wg.roomOfHubGroup(workgroupId).id` | 接收端把 Hub id 换成本机目录 |

**这就是“跨用户共享”的实现方式**：逻辑上是同一份群记忆，物理上各机器用自己的原版目录。

## 4. 与 G6 的逐项对比

| 项 | G6（被否决） | G6R |
|---|---|---|
| 记忆存储 | Hub `group_memories` 表 | 各机器原版 `memory/groups/<roomId>/` |
| 记忆格式 | `type/content/acl/version/sourceRefs` 新模型 | 原版 AgentMemoryRepo Markdown |
| 谁能读写 | Hub ACL 数组 | 原版 `writeDenied` + 群成员 |
| 容量 | 4000 字符/条 | 原版 300/4000/16000/40 |
| 检索 | Hub FTS5 | 原版 `recall`（本机文件） |
| 回顾 | 保留本机回顾，但只写本机 | 原版 `reviewGroup`，跨机同步结果 |
| 面板 | 新建 `MemoryCard` | 原版 `MemoryRow` → `MemoryDialog` |
| 迁移 | v8 三张表 | 无 |
| 端点 | 五个 `memory-*` | 无（沿用 `memory-view/ask/forget`） |
| 事件 | 四类 `memory.*` | 一类 `memory.change` |
| UI 文件 | 改 `group-settings.js` | 不改 |

## 5. 风险与取舍

### 5.1 并发写

两台机器同时写同一条目：Hub 的 `seq` 决定应用顺序，后到的 `replace` 会覆盖先到的。
这是原版“单机串行写”的自然延伸；原版没有版本号，也不引入版本号（引入就是新语义）。
**如果将来需要冲突提示，另开任务，不在 G6R 扩范围。**

### 5.2 离线写入

A 离线时用原版 `remember` 写的条目，在原版引擎里已经落盘；但 `onMemoryWritten` 因
`bridge.status().connected !== true` 不上报。**这是有意的取舍**：G6R 的第一个版本不补发历史，
因为“补发”需要扫描 `journal.jsonl` 并与 Hub 去重，属于新功能。文档必须如实写明这个限制。

> 若维护者要求离线写入也同步，正确做法是：在 `memory-sync.js` 里读 `journal.jsonl` 的未发送
> 记录，用同一个 `memory.change` 帧补发，而不是把整个文件传上去。这是后续任务，不是 G6R。

### 5.3 记忆条目与消息的因果关系

`memory.change` 只带 `before/after` 与 `actor`，不带“从哪条消息学到的”。原版条目本身带
`[source: …]` 元数据，跨机同步后仍然保留，因此来源可追溯。**不新增 `sourceRefs` 字段**。

### 5.4 隐私

群记忆只在该群成员之间同步；私人记忆与团队记忆不进 `memory.change`（发送端按
`scope.kind === 'group'` 过滤，测试断言 `sent === []`）。离群后 Hub 停止投递。

## 6. 验收

自动化：

- 原版 `memory.test.js` 全绿且断言未改；
- 单机：群写入上报、私聊/团队/本地群不上报、远端应用幂等、删除归档；
- Hub：`memory.change` 扇出且不计未读；
- 两机：A 的 `remember` 让 B 的 `memory-view` 看到，B 离群后收不到。

人工（BLOCKED）：

- G6-M1：两台真机、两个账号、真实网络与界面。
