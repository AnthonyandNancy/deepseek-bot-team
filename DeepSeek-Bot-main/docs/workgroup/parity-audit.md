# 工作群 vs 原版群聊：复制完整性审计

- 日期：2026-10-22
- 问题起点：工作群「记忆摘要」弹窗报「找不到这个群聊」，右侧「记忆」一直「加载中」
- 结论：**群模块本身复制完整**；缺的是**跨模块的群解析**——原版 `memory.js` 只认 `state.rooms`，工作群房间不在其中。已补一条只读解析缝并加测试。

## 1. 记忆为什么丢

| 层 | 原版行为 | 工作群行为（修复前） |
|---|---|---|
| 客户端 | 记忆面板按 `roomId` 打开 | 工作群已在 `roomsById` 里，入口正常打开 |
| 路由 | `memory-view` / `memory-ask` / `memory-forget` | 同一路由，参数是工作群 id |
| 宿主 | `panelOf` 用 `rt.roomOf(id)` 找房间，找不到抛 `Unknown group chat` | 工作群房间在 `wg.state.workgroups`，`rt.roomOf` 只查 `state.rooms` → 抛错，面板停在「加载中」 |

证据：`src/host/memory.js` 的 `panelOf`；源仓库 `src/workgroup/**` 中**没有任何**记忆相关代码；源仓库的 `host/memory.js` 与上游逐字节相同；源方案把「群记忆」列为 V1 但排在 G6。**所以这不是复制漏文件，而是原版本就没有把群记忆接到工作群域。**

## 2. 修复

| 位置 | 改动 |
|---|---|
| `src/workgroup/host/ownership.js` | 新增 `wg.roomOf(id)` 与 `rt.workgroupRoomOf`：把工作群记录适配成原版群代码读的形状（成员 id、`admin`），只读，不落盘 |
| `src/host/memory.js` | 所有房间查找改走 `roomOf = id => rt.roomOf(id) ?? rt.workgroupRoomOf?.(id)`（10 处） |
| 测试 | `workgroup-round.test.js` 新增：工作群 `memory-view` 不再报错、为空时 `entries: []`、未知 id 仍按原规则拒绝 |

影响面：本地群的记忆查找仍走 `rt.roomOf` 原路径；只在原路径找不到时才问工作群域，两个域不共享存储。

## 3. 群模块复制完整性

宿主群函数面对照（`comm` 差集）：

| 原版 `src/host/groups.js`（17 个） | 工作群 `src/workgroup/host/groups.js`（28 个） |
|---|---|
| `dropGroupLine` / `dropGroupLines` | `dropLine` / `dropLines` |
| `greetRoom` | `greetWorkgroup` |
| `groupSessionFor` | `sessionFor` |
| `keepGroupLine` | `keepLine` |
| `postToRoom` | `postToGroupSession` / `postToSession` |
| `callMembers`、`roomPrompt`、`roomTurn`、`runRound`、`reportRound`、`postStep`、`lateRoomReply`、`lateRoomFailure`、`openingSpeakers`、`drainRoomInbox`、`stopMemberWork` | 同名复制，另有 `createWorkgroup`、`updateWorkgroup`、`deleteWorkgroup`、`retitleWorkgroup`、`resumeWorkgroup`、`adoptSession`、`adoptOrphans`、`checkMembers`、`stopRound`、`deliver`、`workgroupOf`、`sessionOwners` 等 |

结论：原版的每个群函数在工作群侧都有对应实现（改名或拆分），**没有整块缺失**。

## 4. 逐能力对照

| 能力 | 原版实现 | 工作群 | 状态 |
|---|---|---|---|
| 建群、改名、公告、管理员、成员增删 | `host/groups.js` + `roster.js` | 复制版 + `update-room` 端点 | 已复制 |
| 回合、发言顺序、`@`/`@all`、PASS、每轮上限 | `host/turns.js` | 复用原版，域内 `roomWaiters`/`roomProgress`/`roomInbox` | 已接 |
| 投递、结果回报 | `host/delivery.js` | 复用 `rt.deliver`，成员 Session 走本域 | 已接 |
| 停止（整轮 / 单成员） | `stopRound` / `stopMemberWork` | `stop-round` / `stop-member-work` | 已接 |
| 恢复、重开 | `host/resume.js` | `resumeWorkgroup` | 已接 |
| 工具审批卡片 | `host/approvals.js` + `channel.live` | 视图合并进同一次轮询 | 已接 |
| **群记忆** | `host/memory.js` 按 room 查找 | 原缺失，本次补解析缝 | **本次修复** |
| 群设置表单、右键菜单、侧栏行 | `client/group-settings.js` 等 | 索引进 `roomsById` + 域分流 | 已接 |
| `@` 菜单、未读、置顶、隐藏 | `client/at-menu.js`、`set-flags` | 同款 | 已接 |
| 回合卡片渲染 | `cells.js` `group_relay` | `workgroup_relay` 归一 + `kind==='workgroup'` | 已接 |
| 附件、图片、引用 | `host/groups.js` | `workgroup-files` 3 项 | 已接 |
| 升级为工作群 | — | `upgrade-room` + 右键菜单 | 入口已接；**Hub 侧未生效（G4）** |
| 历史分页 `chat` | 只按 Bot id | 群会话走 DSH 自身会话 | 不适用 |
| 运行统计 `run-stats` | 只按 Bot id | 同上 | 不适用 |
| Hub 群/消息持久化 | — | 无 | **G4** |
| 群记忆的跨用户授权与 Hub 存储 | — | 无 | **G6** |
| **Bot 之间的交接与结果回报** | `host/handoffs.js` + `post_to_group` 的 `report_back` | `host/handoffs.js` 复制件 + `workgroup_post`（2026-10-23 补齐） | 已复制 |

## 5. 剩余差异（不是复制问题）

1. **工作群没有自己的 Hub 侧群与消息**：跨用户聊天、升级真正生效属 G4。
2. **群记忆只做到本机面板可用**：跨用户检索、来源与授权属 G6。
3. **工作群的 `run-stats` / `chat`**：原版这两个端点按 Bot id 解析，群从来不用它们（群是 DSH 会话），因此工作群也不使用。

## 6. 已闭环（本轮之前是缺口）

- **工作群没有 Bot 之间的交接**（2026-10-23 修复）：`host/handoffs.js` 的复制件此前
  不存在；成员的 post 进不了 round；round 放手的成员不再发结果。四处一并补上，详见
  `g5/ROUND-LOG.md` 同日条目。
- **成员进出与群内发言上 Hub**（2026-10-23 修复）：接受邀请只加了人、群里加了 Bot 也不带
  `kind`、本机 Bot 的发言从不进 Hub 的 events 表；后续核对时又补上对称的另一半——移除成员
  原本只删本地，Hub 名册不动，下次 `applyRoster` 又读回来。详见 `progress-and-gaps.md` 与
  `gates.md` 的同日条目。`src/host/` 仍零改动。
- **Hub 工作群里发消息不启动回合**（2026-10-23 修复，本轮最终根因）：`send-hub` 只交给 Hub，
  `receiveRemote` 又刻意不写群 Session——两条各自正确的规则叠加，结果是没有任何成员被叫到。
  原版本地群没有 Hub 夹在中间，编辑器直接 prompt 群 Session，所以正常。修法是让本机消息经
  `postToSession` 走本地编辑器同一条路（`apply` 的 `mine`），别台机器的行仍不进 Session。
