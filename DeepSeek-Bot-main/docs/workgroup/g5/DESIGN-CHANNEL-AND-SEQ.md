# G5 设计决定：任务的通道与序号

- 日期：2026-10-22
- 状态：**已定**（G5 会话不需要再问）
- 决定人：用户（在两条候选方案中选定本文件结论）
- 适用：G5 全部轮次

本文件回答 G5 开工前必须定的两个设计问题。两条都按「照方案做」而非「另立一套」取舍，理由与代价写在下面，**可行性已在当前代码上逐条核实**。

- 配套文档：续接指令 [`NEXT-INSTRUCTION.md`](NEXT-INSTRUCTION.md)；复制基线 [`COPY-BASELINE.md`](COPY-BASELINE.md)；轮次日志 [`ROUND-LOG.md`](ROUND-LOG.md)
---

## 决定 1：`task.*` / `approval.*` / `artifact.*` **占用群内 `seq`**

### 结论

这 13 种事件（方案 §9.3 逐条列出的任务 7、审批 4、附件 2）与 `chat.message` **共用同一个 `seq` 流**，走 G4 已有的 `deliveries` + `ack_at` + 游标补拉。

不单独开一条“任务流”，也不像 `member.changed` 那样走提示帧。

### 为什么

1. **B 可能离线时被请求。** 审批请求是必须送达的可执行内容。走 `seq` 就自动继承 G4 已验证的补投链路：B 重连时 `sync.request(afterSeq=cursor)` 一次拉回，审批请求就在里面。走独立帧则要另建一条“重连时主动查待办”的路径，同一个问题做两遍。
2. **方案 §9.4 原文如此**：「**所有**公开群事件由 Hub 分配单调递增的群内 `seq`；客户端以持久化游标补拉」。占 `seq` 是照做；不占才需要写「Plan 偏差」。
3. **时间线要能交错还原。** A 侧看到「请求 → 批准 → 运行中 → 完成」与同一时刻的聊天必须落在同一个顺序里，这正是 UI 要显示的。

### 与 `member.changed` 的区别（判据，不是双标）

> 客户端重连时会**权威重读**的状态 → 走提示帧；
> **离线必须补投**的可执行内容 → 走 `seq`。

名册每次连接都由 `syncRoster` 全量重读，提示帧丢了无害（G4 `hub/src/ws.js` 的 `notifyMembership`）。审批请求丢了，B 就永远不知道有人找他办事。

### 代价与连带改动（必须一起做）

| # | 改动 | 位置 | 现状 |
|---|---|---|---|
| 1 | **未读数改为「`seq > 游标` 的 `chat.message` 条数**，不再是游标差 | `hub/src/workgroups/service.js:268` `unreadCount: Math.max(0, group.last_seq - lastReadSeq)` | 现在是 `last_seq - lastReadSeq`，任务事件一占 `seq` 就会把未读数刷爆 |
| 2 | 同上，插件侧房间视图 | `ds-bot/src/workgroup/host/channel.js:84` `unread: Math.max(0, (bridge?.cursor ?? 0) - readCursor)` | 同上问题 |
| 3 | `EVENT_TYPES` 从**现有 5 项**（`chat.message`/`chat.edited`/`chat.deleted`/`member.changed`/`read.updated`）**增加 13 项**，共 18 项 | `hub/src/workgroups/service.js:25` | 封闭集合，未知名被拒；逐个加入 |
| 4 | WSS 新帧类型 | `hub/src/ws.js` 的 `handlers` 对象（现有 6 个键：`subscribe`/`chat.message`/`event.ack`/`sync.request`/`read.updated`/`heartbeat`） | 加 `task.request` 等键即可，路由表按 `message.type` 分发 |

**未读数的正确算法**（两处同一语义）：

```sql
-- 人读的是「消息」，不是「事件」
SELECT count(*) FROM events
WHERE workgroup_id = ? AND seq > ? AND type = 'chat.message'
```

### 限速（不做会撑爆 `events`）

- 只记**状态迁移**：`task.request`、`task.received`、`task.started`、`task.completed`、`task.failed`、`task.cancel`，以及 4 个 `approval.*`、2 个 `artifact.*`。
- `task.progress` **必须合并/节流**：同一任务 2 秒内的多次进度合并成一条，否则 `events` 是无限增长的表，而它是每个客户端要补拉的。建议在插件侧合并后再 append。

---

## 决定 2：发起任务走 **WSS 的 `task.request`**，不设 `POST /v1/tasks`

### 结论

| 用途 | 通道 | 依据 |
|---|---|---|
| 发起任务 `task.request` | **WSS** | 方案 §9.2 事件信封 + §9.3 类型 + 复用 G4 outbox 幂等 |
| 进度/完成/失败、审批事件、产物事件 | **WSS** | 同上，占 `seq`（决定 1） |
| 批准 / 拒绝 | `POST /v1/tasks/:id/decision` | 方案 §13.1 明列 |
| 撤权 | `POST /v1/tasks/:id/revoke` | 方案 §13.1 明列 |
| 读任务（A 看进度、B 看待办） | `GET`（**方案未定义，本阶段新增**） | 否则每次开面板都要折整条日志 |

**不设 `POST /v1/tasks`。** 这个不对称（请求走 WSS、决策走 HTTP）是方案自己的形状，不是笔误。

### 为什么

1. **G4 的 outbox 正是门禁 5 要的机制。** `ds-bot/src/workgroup/host/bridge.js` 的 `send()` 已在断网时入队、用**同一个 `eventId`** 重连补发，Hub 侧 `events.event_id` 是主键。任务请求走这条路，「至少一次投递 + 不重复执行」白拿；走 HTTP 就得另造 outbox 与去重键。
2. **信封本来就是事件。** 方案 §9.2 的字段是 `eventId/type/workgroupId/taskId/sender/target/createdAt/expiresAt/payload/signature`，`type` 取值含 `task.request`。
3. **§10.1 第 1 步的措辞**是「A 的 Bridge 生成 taskId、签名并**发给** Hub」，不是「调用端点」。
4. **§13.1 里与任务相关的只有 `decision` 与 `revoke`**——方案自己把「发起」排除在 HTTP 之外。
5. **T13（伪造 `senderId`）已有硬件级证明**：WSS 握手用设备私钥签过 `deviceId.ts.nonce`，帧的发送方由**连接**决定。G4 已实测：帧里写别人的 `sender.userId` 会被 Hub 覆盖为连接身份。

### 可行性核实：outbox 目前硬编码 `chat.message`，需一处小改

现状（`bridge.js` 的 `flush`）：

```js
socket.send(JSON.stringify({
  v: 1, type: 'chat.message', workgroupId, eventId: pending.eventId, payload: pending.payload, ...
}))
```

`type` 是写死的。要复用它发 `task.request`，把帧类型放进 outbox 项即可：

```js
const pending = { eventId, frameType, payload, queuedAt, botEndpointId }
// flush: type: pending.frameType ?? 'chat.message'
```

`bridge.send()` 的**语义扩展**建议：新增 `bridge.sendEvent({ workgroupId, frameType, payload })`，`send()` 保持现状只发聊天（避免把 UI 的“发消息”和“发任务请求”混成一个入口）。两者共用 `flush`。

### 签名要在信封里，不只在握手里

握手签名证明「这台设备持有私钥」，但**不覆盖 payload**。方案 §9.2 要求署名涵盖「规范化序列化的关键字段、payload hash、目标、有效期、协议版本」。所以 `task.request` 的信封里需要独立签名字段：

- 规范化序列化（键排序 + 明确数字/字符串编码）→ 哈希 → 设备私钥签。
- Hub 校验：签名有效 **且** `sender` 与连接身份一致 **且** 未过期 **且** nonce/请求 id 未见过。
- 契约测试必须证明「改 payload 后签名失效」「改 sender 后拒绝」「重放被拒」——方案 §9.2 明文要求不可只检查 `signature` 字段存在。

---

## 落地清单（G5 第 1–3 步照这个做）

1. `hub/src/db/migrations.js` 迁移 v4：`tasks`、`approvals`、`round_leases`、`artifacts`（字段照方案 §12）。
2. `hub/src/workgroups/service.js`：`EVENT_TYPES` **增加 13 项**（现有 5 项 + 新增 13 = 18）；`unreadCount` 改为按 `chat.message` 计数。
3. `hub/src/ws.js`：新增 `task.request`（及后续任务帧）的 handler；签名与防重放校验。
4. `hub/src/server.js`：`POST /v1/tasks/:id/decision`、`POST /v1/tasks/:id/revoke`、`POST /v1/artifacts/uploads`、`GET /v1/artifacts/:id/download`，以及新增的读任务 `GET`。
5. `ds-bot/src/workgroup/host/bridge.js`：outbox 项加 `frameType`；新增 `sendEvent`；`channel.js` 的房间视图 `unread` 改计数。
6. `ds-bot/src/workgroup/host/tasks.js`：把状态迁移接到 Hub 记录上（状态机本身不改）。
7. 测试：`hub/test/task-*.test.js`、`ds-bot/test/workgroup-task*.test.js`；**全部走 `apiHandle` 或真 socket，不显式启动内部组件**。

## 要在 `gates.md` 里记成「本阶段新增」的东西

- 读任务的 `GET` 端点（方案未定义）。
- 租约端点（方案只给语义：`coordinatorEpoch / leaseUntil`）。
- 未读数从游标差改为消息计数（这是**行为变更**，会影响 G4 的两个未读测试的期望值）。
- `bridge.sendEvent`（G4 只有 `send`）。
