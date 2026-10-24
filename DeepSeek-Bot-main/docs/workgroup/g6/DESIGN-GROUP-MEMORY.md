> **⚠️ 已被 G6R 否决（2026-10-24）。** 本文件记录的是被否决的 G6 方案：它在 Hub 新建了
> `group_memories` 存储、`memory-*` 端点和独立记忆 UI，而原版 `memory.js` 已有群记忆引擎。
> 这里的“通过”只说明那套平行实现在自己的测试里自洽，**不是有效的阶段门禁**。
> 现行方案见 [`docs/superpowers/plans/2026-10-24-g6r-copy-first-group-memory.md`](../../superpowers/plans/2026-10-24-g6r-copy-first-group-memory.md)
> 与 [`docs/workgroup/g6r/NEXT-INSTRUCTION.md`](../g6r/NEXT-INSTRUCTION.md)。

# G6 群记忆设计（V1）

- 日期：2026-10-26
- 范围：Hub 权威存储、ACL、版本、软删除、FTS5、插件投影与 UI
- 非目标：向量检索、多 Hub 联邦、本地群历史导入、OS 钥匙串、发版

## 1. 权威边界

Hub 是群记忆的唯一权威。`group_memories` 保存条目，`group_memory_events` 保存每次
created/corrected/deleted 的版本与操作者，`group_memories_fts` 只索引未软删除的条目。
插件侧 `state.memories` 只是投影缓存，用于提示词冻结与快速视图；面板读写一律经
`callWorkgroup('memory-*')` 到 Hub，不从缓存合并写入。

## 2. ACL 与成员检查

每个服务方法先调用同一个 `requireMember(workgroupId, userId)`：

- 群不存在与非成员都返回 404 `workgroup/not-found`，避免探测群 id；
- `acl` 是显式 Hub user id 列表；创建者总被加入；
- ACL 中每个 id 必须是本群 `status = 'active'` 的 user membership；
- `list` / `search` 先做成员检查，再按 `acl` 过滤；ACL 不含调用者时返回空列表，而不是泄露条目；
- 离群后下一次 list/search 立即 404。

这与计划 Task 2 示例中“`acl: []` 的条目对成员可见”的宽松描述不同。用户门禁明确要求
“acl 不含自己时读不到”，因此采用显式 ACL 口径；差异记入 `ROUND-LOG.md`。

## 3. 版本与删除

- `version` 是 compare-and-apply 令牌；`correct` / `remove` 必须在同一 SQL 条件里匹配
  `id + workgroup_id + version + deleted_at IS NULL`；
- 版本不符返回 409 `memory/version-conflict`，不产生部分写入；
- 删除是软删除：`deleted_at` 保留行与审计，FTS 触发器把该行移出索引；
- 创建支持可选 `eventId` 幂等键，重放同一创建请求返回同一 `memoryId` 与 `duplicate: true`。

## 4. 事件与顺序

`memory.proposed / memory.created / memory.corrected / memory.deleted` 加入 `EVENT_TYPES`，
与聊天共用 `workgroups.last_seq` 与既有 WSS 扇出。`READABLE_EVENT_TYPE` 仍只有
`chat.message`，因此记忆事件不计入未读消息。

插件 bridge 收到 `memory.*` 后只调用 `wg.onMemoryEvent` 重读 Hub 并写投影，不在客户端合并
payload；面板收到 `kind === 'memory'` 的 feed 信号后重读 `memory-list`。

## 5. 回顾接缝

`rt.memoryRoomOf(sessionId)` 仅对工作群成员 Session 返回 `workgroupId`，群自己的 relay
Session 返回 `undefined`。`memory.js` 的 `agent/status` 过滤增加这一只读接缝，但不改变
`rt.isBotSession` 语义，也不把工作群成员注册进原版索引。

## 6. 删除归档

`deleteWorkgroup` 在 Hub 删除成功后、释放成员 Session 前调用
`rt.archiveGroupMemory(room)`，与原版 `deleteRoom` 一致。Hub 侧两张表对 `workgroups`
使用 `ON DELETE CASCADE`，因此群删除后条目与审计行一并消失，本地 Markdown 则进入归档目录。

## 7. 容量与格式

沿用 `docs/plans/2026-10-09-context-and-memory.md`：单条 300 字符、`MEMORY.md` 4000、
主题 16000、最多 40 个主题。Hub 侧 V1 内容上限为 4000 字符，凭据样式文本
（`api_key= / password: / secret: / token=`）拒收；本地格式不变。
