# G5 复制基线：原版群聊能力是否已经复制到位

- 日期：2026-10-22
- 状态：**已核对，复制完整**（G1–G4 完成；G5 不需要先做「复制迁移」）
- 用途：G5 开工前确认「改造的是副本，不是原版」。凡本文标 ✅ 的行，G5 直接改工作群副本；标 ⛔ 的行，先停下。
- 核对方式：逐函数比对源码，不用文档自述。命令附在每节末尾。

- 配套文档：续接指令 [`NEXT-INSTRUCTION.md`](NEXT-INSTRUCTION.md)；通道与序号设计 [`DESIGN-CHANNEL-AND-SEQ.md`](DESIGN-CHANNEL-AND-SEQ.md)；轮次日志 [`ROUND-LOG.md`](ROUND-LOG.md)
---

## 1. 一句话结论

**原版 17 个群函数在工作群侧 17/17 有对应；原版 `src/host/` 零改动。** G5 的租约、审批、任务执行全部落在 `src/workgroup/` 内，无需新增复制。

---

## 2. 原版 `host/groups.js`（909 行，17 个函数）→ 工作群

| 原版函数 | 工作群 | 形态 |
|---|---|---|
| `callMembers` | `callMembers` | 同名复制 |
| `drainRoomInbox` | `drainRoomInbox` | 同名复制 |
| `lateRoomFailure` | `lateRoomFailure` | 同名复制 |
| `lateRoomReply` | `lateRoomReply` | 同名复制 |
| `openingSpeakers` | `openingSpeakers` | 同名复制 |
| `postStep` | `postStep` | 同名复制 |
| `reportRound` | `reportRound` | 同名复制 |
| `roomPrompt` | `roomPrompt` | 同名复制 |
| `roomTurn` | `roomTurn` | 同名复制 |
| `runRound` | `runRound` | 同名复制 |
| `stopMemberWork` | `stopMemberWork` | 同名复制 |
| `dropGroupLine` | `dropLine` | 改名 |
| `dropGroupLines` | `dropLines` | 改名 |
| `keepGroupLine` | `keepLine` | 改名 |
| `greetRoom` | `greetWorkgroup` | 改名 |
| `postToRoom` | `postToGroupSession` | 改名 |
| `groupSessionFor` | `sessionFor` | 改名，且远程成员返回 `undefined`（G4） |

工作群侧另有**本域新增**（不属于复制范围）：`createWorkgroup`、`updateWorkgroup`、`deleteWorkgroup`、`retitleWorkgroup`、`resumeWorkgroup`、`adoptSession`、`adoptOrphans`、`checkMembers`、`stopRound`、`deliver`、`receiveRemote`、`applyRoster`、`syncRoster`、`ensureLinkedGroup`、`deliverRemote`（在 bridge）。

```bash
# 复现
grep -oE "^  (async )?function [a-zA-Z]+" src/host/groups.js | sed 's/.*function //' | sort
grep -oE "^  (async )?function [a-zA-Z]+" src/workgroup/host/groups.js | sed 's/.*function //' | sort
```

---

## 3. 原版 `host/turns.js`（646 行，13 个 `rt.*` 出口）→ 工作群

| 原版出口 | 工作群处理 | 判定 |
|---|---|---|
| `live` | 副本（`const live = new Map()`） | ✅ 已隔离 |
| `liveOf` | 副本（`groups.js:1058`） | ✅ |
| `doingOf` | 副本（`groups.js:1066`） | ✅ |
| `roomWaiters` | `wg.roomWaiters`（13 处引用） | ✅ 已隔离 |
| `roomProgress` | `wg.roomProgress`（8 处） | ✅ |
| `roomInbox` | `wg.roomInbox`（7 处） | ✅ |
| `activityView` | `wg.activityView`（channel.js 投影） | ✅ |
| `workView` / `roomWorkView` | `wg.workView` / `wg.roomWorkView` | ✅ |
| `turnsView` | **不复制，跨域复用**（读全部会话视图，无域语义） | ✅ 合理 |
| `callDetail` | **不复制，跨域复用**（按 sessionId 读一次调用的详情） | ✅ |
| `stopRoomTurn` | **不复制，也不用**：工作群自带 `stopRound`/`stopMemberWork`（走 `wg.roomWaiters` + `agent.cancel`） | ✅ 关键：原版这个函数读的是原版 `live`，**停不掉工作群回合**，所以w g 必须用自己的——它确实有 |
| `releaseBot` | **不复制，跨域复用**（按 botId 释放会话，无域语义） | ✅ |

**为什么 `turns.js` 没有独立副本文件是对的**：这 13 个出口里 9 个是「回合状态」，工作群已经用 `wg.*` 自建了 9 份；剩下 4 个是跨域通用工具，复制反而会造成两份真值。

```bash
# 复现：wg 用的是自己的 map，不读原版。
# 先剥掉注释——源码里有 5 处注释在解释「原版把它放在 rt.live / rt.roomWaiters 里」，
# 那是对照说明，不是调用。
grep -v '^\s*//' src/workgroup/host/groups.js | grep -cE 'rt\.(roomWaiters|live)([^a-zA-Z]|$)'   # 0
grep -v '^\s*//' src/workgroup/host/groups.js | grep -c "wg\.roomWaiters\|wg\.roomProgress\|wg\.roomInbox"  # 28
# 分项：wg.roomWaiters 13、wg.roomProgress 8、wg.roomInbox 7
```

---

## 4. 原版 `host/constants.js`（88 行）→ 工作群

回合限制与日志上限已复制到 `src/workgroup/shared/constants.js`，并改名 `WG_*`（`WG_LOG_MAX`/`WG_FIRST_LOOK`/`WG_DELTA_MAX`/`WG_LINE_READ`/`WG_TEXT_KEPT`/`WG_READ_MAX`/`WG_REPLY_TIMEOUT_MS`/`WG_WORK_GRACE_MS`/`WG_LATE_ROUNDS`/`WG_STEP_GAP_MS`/`WG_EXTRA_TURNS`/`WG_ADMIN_EXTRA_TURNS`/`WG_TURNS_EACH`/`WG_ADMIN_TURNS_EACH`/`WG_ROOM_MODES`/`WG_ROOM_MIN_MEMBERS`/`WG_ROOM_MAX_MEMBERS`）。

`SOURCE_KIND`/`TEAM_TOOLS` 是从原版 `constants.js` **导入**（不是复制）——这两个是全局身份常量，复制会导致两套真值。

✅ 已复制到位。

---

## 5. 原版 `host/roster.js`（598 行）→ 工作群

`createRoom` → `createWorkgroup`、`updateRoom` → `updateWorkgroup`、`deleteRoom` → `deleteWorkgroup`、`retitleRoom` → `retitleWorkgroup`、`checkMembers` → `checkMembers`（在副本内）、`planRoomChange` 的规则并入 `updateWorkgroup`。

`roster.js` 其余部分（Bot 的增删改、Main Bot、预设）**不属于群聊能力**，工作群不复制，通过 `rt.*`（`botOf`/`addAgent`/`createAgentSession` 等）复用。

✅ 群聊相关部分已复制。

---

## 6. 原版其余模块：**有意不复制**（通过 `rt.*` 复用）

工作群实际调用的原版能力（按引用次数）：

```
warn(21) roomOf(8) resolveAgent(8) groupOwners(6) live(5) botOf(4) home(3)
createSession(3) clock(3) yieldRoomTurn(2) workDirOf(2) selfOf(2) searchOwnChat(2)
readOnly(2) partsOf(2) partIndex(2) noteText(2) latestOwnChat(2) isBotSession(2)
imagesForGroup(2) ensureCapabilities(2) deliver(2) aroundOwnChat(2) 等
```

这些是**能力**（工具、权限、会话、图片、记忆检索），不是**群逻辑**。复制它们会造出第二份 Bot 身份与会话索引，正是 P0-1/P0-3 禁止的。

| 模块 | 与群聊的关系 | 判定 |
|---|---|---|
| `delivery.js`（162） | 投递到会话，无群语义 | ✅ 复用 |
| `resume.js`（252） | 恢复，无群语义 | ✅ 复用 |
| `approvals.js`（69） | 工具审批卡片，无群语义 | ✅ 复用 |
| `memory.js`（1512） | 群记忆面板已补只读解析缝（G3 闭环） | ✅ 复用 + 缝 |
| `parts.js`（1285） | 会话分段，无群语义 | ✅ 复用 |
| `images.js`（212） | `imagesForGroup` 按群查图 | ✅ 复用 |
| `chat-index.js` | `searchOwnChat` 等，按 Bot 查 | ✅ 复用 |
| `tools.js`（887） | `pickRoom`/`hideBotUnusedTools` | ✅ 复用（已按域分流） |
| `permissions.js`（80） | `applyPermission`/`setRoomPermission` | ✅ 复用（副本显式传 room） |

---

## 7. G5 的改造边界（据本文）

| G5 要做的事 | 落点 | 性质 |
|---|---|---|
| 单协调者租约、`roundId` + 围栏值 | `workgroup/host/groups.js` 的 `runRound`/`callMembers` | ✅ 改副本 |
| 任务进度/事件节流 | 同上 + `workgroup/host/bridge.js` | ✅ 改副本 |
| 状态机接 Hub | `workgroup/host/tasks.js`（已存在）+ 新 Hub 端点 | ✅ 本域 |
| 审批卡 UI | `workgroup/client/panel.js` | ✅ 本域 |
| 任务历史 | Hub `tasks` 表 | ✅ 新写；原版 `run-stats`/`chat` 按 Bot id 解析，群从不用（`parity-audit.md` 标「不适用」） |

**⛔ 若 G5 发现必须修改 `src/host/` 下任何文件**：立即停下，写「Plan 偏差」。正确做法是把那一小段复制进 `src/workgroup/host/groups.js`，不是改原版。

```bash
# 每次交付前必跑，输出必须为空
git status --porcelain ds-bot/src/host/
git diff --stat ds-bot/src/host/
```

---

## 8. 已知的、不属于「复制缺口」的差异

| 项 | 说明 | 出处 |
|---|---|---|
| `run-stats` / `chat` 端点 | 原版按 Bot id 解析，群是 DSH 会话，从不用 | `parity-audit.md` §5 |
| 群记忆跨用户检索 | 原版没有，属 G6 | `progress-and-gaps.md` 缺口 11 |
| `stopRoomTurn` 不适用 | 读原版 `live`，工作群有自己的停止路径 | 本文 §3 |
| 人员显示名 | Hub `users` 无 `display_name` | `gates.md`「仍存在的限制」 |

以上都不是「原版某块功能没复制过来」，而是**原版本来就没有**或**跨域复用更正确**。

---

## 9. 开工前核对（G5 会话照做）

- [ ] `git status --porcelain ds-bot/src/host/` 输出为空
- [ ] 本文 §2 的 17 个函数，工作群侧都能找到（改名表在 §2）
- [ ] 本文 §3 的 9 个回合状态方法，工作群用的是 `wg.*` 而非 `rt.*`（剥注释后计数应为 0；注释里提到 `rt.*` 是对照说明，不算）
- [ ] 若发现要改原版：停，写「Plan 偏差」，把那段复制进副本
