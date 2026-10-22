> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g0/reference-classification.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G0 引用点分类表（方案 §5.4 强制产物）

方案 §5.4 要求：**每个引用点必须归类"本地群独有 / 工作群独有 / 通用一次 / 危险待核验"，并列调用者、被调对象、注册次数、卸载/重启行为和相应测试用例。**

原始扫描输出见 `docs/workgroup/g0/scans/`（s1–s5）。本文件是**分类与处置**，不是扫描结果的替代。

分类图例：
- **LOCAL** 本地群独有
- **WG** 工作群独有（G1 新增，尚不存在）
- **ONCE** 通用一次（工作群复用受控接口，绝不复制安装）
- **DANGER** 危险待核验（必须先实测，不得凭源码推断放行）

---

## A. Session 身份归属（scan s1）

| # | 引用点 | 调用者 | 被调对象 | 分类 | 注册次数 | 卸载/重启行为 | 测试用例 |
|---|---|---|---|---|---|---|---|
| A1 | `store.js:331` `chatOwners` 定义 | store.install | `Map` | **ONCE** | 1（模块 install 时） | 进程内重建；`indexSessions()` 每次 load 前 clear | `store.test.js`、`session-identity.test.js` |
| A2 | `store.js:333` `groupOwners` 定义 | store.install | `Map` | **LOCAL** | 1 | 同上 | `session-identity.test.js:127+` |
| A3 | `store.js:335` `pastOwners` 定义 | store.install | `Map` | **ONCE**（本地群归档段） | 1 | 同上 | `history.test.js` |
| A4 | `store.js:337-353` `indexSessions()` 重建三表 | `load()` / `refresh()` | 三个 Map | **ONCE + 需扩展** | 每次 load 调 1 次 | 全量 clear 后重建 → **工作群表必须在此一并重建**，否则重启后归属丢失 | **G1 WG-05**、`session-identity.test.js` |
| A5 | `store.js:356` `selfOf()` | tools/turns/parts/memory/folders/handoffs/permissions/schedules/secrets | 3 Map | **ONCE（只读）** | 0（纯函数） | 无状态 | `session-identity.test.js` |
| A6 | `store.js:358` `isBotSession()` | turns/tools/parts/images 共 9 处 | 2 Map | **ONCE（只读）** | 0 | 无状态 | `blocking-question.test.js` |
| A7 | `store.js:202/349` `groupSessionFor` 写入 `groupOwners` | `groups.js:202` | `Map.set` | **LOCAL** | 每成员每群 1 次 | 重启由 A4 重建；`retireGroupSession`/`dropGroupSession` 删除 | `rounds.test.js:328`、`group-status.test.js:204` |
| A8 | `store.js:365/377` `groupOwners.delete` | `dropGroupSession` / `retireGroupSession` | `Map.delete` | **LOCAL** | — | 删除即失效 | `group-status.test.js` |
| A9 | `groups.js:202` 工作群若写同一 `groupOwners` | groups(复制版) | `rt.groupOwners.set` | **DANGER** | 若复制则再 1 次 | **两个域共用一张表 → 原版 turns/parts 会把工作群 Session 当本地群处理** | **G1 WG-03/WG-05** |

> **A 类结论**：工作群**必须**新建 `wg.sessionOwners`，且 A4 重建点必须同时重建它；`selfOf`/`isBotSession` 的语义**不改**，另加 `resolveSessionOwnerStrict()`。

---

## B. 群/房间内存状态与投递（scan s2）

| # | 引用点 | 调用者 | 被调对象 | 分类 | 注册次数 | 卸载/重启行为 | 测试用例 |
|---|---|---|---|---|---|---|---|
| B1 | `turns.js:77` `roomWaiters` | turns.install | `Map` | **LOCAL** | 1 | 进程内，重启即空 | `group-status.test.js:103-231` |
| B2 | `turns.js:79` `roomProgress` | turns.install | `Map` | **LOCAL** | 1 | 同上 | `channel.js:153` 的 `room-progress` 端点 |
| B3 | `turns.js:81` `roomInbox` | turns.install | `Map` | **LOCAL** | 1 | 同上 | `rounds.test.js:155+` |
| B4 | `turns.js:82` `queueRoomMessage` | turns 内部 | B3 | **LOCAL** | 0 | — | `rounds.test.js` |
| B5 | `turns.js:630` 三张 Map `Object.assign` 到 `rt` | turns.install | `rt` | **DANGER** | 1 | 卸载不清理 `rt` 字段（`rt` 随 runtime 生命周期） | — |
| B6 | `groups.js:304` 写 `rt.roomWaiters` | `roomTurn` | B1 | **LOCAL** | 每轮次每成员 1 次 | 轮次结束 `delete` | `group-status.test.js:150` |
| B7 | `groups.js:335` `waitersOf` 读 `rt.groupOwners` 兜底 | `touchRoomTurn` 等 | A2 | **LOCAL** | 0 | — | `group-work.test.js:119` |
| B8 | `groups.js:500` `rt.roomInbox.get/delete` | `group_relay` | B3 | **LOCAL** | 0 | 每轮 drain 1 次 | `rounds.test.js:155` |
| B9 | `groups.js:560/566` `rt.roomProgress.set/delete` | `group_relay` | B2 | **LOCAL** | 每轮次 1 对 | `finally` 保证 delete | `channel.js:153` |
| B10 | `delivery.js:161` `Object.assign(rt,{deliver,…})` | delivery.install | `rt` | **ONCE** | 1 | — | `bot-messages.test.js` 全 40 例 |
| B11 | `resume.js:101` `rt.deliver = …` **覆盖** B10 | resume.install | `rt.deliver` | **DANGER** | 1 次覆盖 | 覆盖不可逆；依赖 install 顺序（delivery 先于 resume） | `follow-through.test.js:145` |
| B12 | `groups.js:308` `rt.deliver({role:'room'})` | `roomTurn` | B11 | **LOCAL** | 每成员轮次 1 次 | — | `rounds.test.js`、`group-work.test.js` |

> **B 类结论**：B1/B2/B3 必须各自复制成 `wg.roomWaiters/roomProgress/roomInbox`（新 Map，非引用）；B5/B11 是**不可复制**的——复制即产生第二套投递链与第二套 waiter 命名空间冲突。工作群远程投递走**独立函数**，不碰 `rt.deliver`。

---

## C. 注册点（scan s3）

| # | 引用点 | 类型 | 分类 | 注册次数 | 卸载/重启行为 | 测试用例 |
|---|---|---|---|---|---|---|
| C1 | `groups.js:488` `tool group_relay` | tool | **LOCAL→WG 改名** | 1 | `ctx.effect` 外部注册；随 ctx 释放 | `install.test.js:32` 断言顺序含它 |
| C2 | `groups.js:581` `tool read_own_chat` | tool | **ONCE（危险共用）** | 1 | 同上 | `group-work.test.js:214` |
| C3 | `groups.js:636` `tool read_group_chat` | tool | **LOCAL→WG 改名** | 1 | 同上 | `install.test.js` |
| C4 | `groups.js:751` `effect group step lines` | effect | **LOCAL→WG 独立** | 1 | 返回 disposer 清 timer | `group-work.test.js:480` |
| C5 | `groups.js:845` `on llm/stream`（群 relay 合成） | listener | **LOCAL→WG 独立** | 1 | ctx 释放即注销 | `agent-preset.test.js:90/99` |
| C6 | `turns.js:349` `on session/event` | listener | **DANGER（域分发点）** | 1 | 同上 | **G1 WG-04** |
| C7 | `tools.js:616` `on session/event` | listener | **DANGER** | 1 | 同上 | **G1 WG-04** |
| C8 | `resume.js:131` `on session/event` | listener | **DANGER** | 1 | 同上 | `follow-through.test.js` |
| C9 | `tools.js:581` `tools.guard` | guard | **DANGER（唯一全局拦截）** | 1 | ctx 释放即注销 | `blocking-question.test.js:148` |
| C10 | `tools.js:585` `on agent/created` → `hideBotUnusedTools` | listener | **DANGER** | 1（4 个 agent/created 之一） | 同上 | `blocking-question.test.js:117` |
| C11 | `approvals.js:15` `on approval/request` | listener | **DANGER（语义冲突）** | 1 | 同上 | `group-status.test.js:103` |
| C12 | `channel.js:347` `fetch.register POST /api/bot` | route | **ONCE（单一路由）** | 1 | `effect` 返回 disposer | `install.test.js:105` 断言 `route POST /api/bot` |
| C13 | `channel.js:359` `effect load state` | effect | **ONCE** | 1 | — | `install.test.js` |
| C14 | `store.js:311` `effect state lock` | effect | **ONCE** | 1 | 释放文件锁并等写完 | `store.test.js`、`home-lock.test.js` |
| C15 | `parts.js:241/845/907/939/957/1007/1017` 7 个监听 | listener | **ONCE（须覆盖 wg 域）** | 各 1 | ctx 释放 | `follow-through.test.js`、`session-identity.test.js:152` |
| C16 | `capabilities.js:485` `on agent/created` | listener | **ONCE** | 1 | 同上 | `capabilities.test.js:260` |
| C17 | `images.js:178/192` | listener | **ONCE** | 各 1 | 同上 | `session-identity.test.js:127/139` |
| C18 | `secrets.js:444` `on tools/execute` | listener | **ONCE（脱敏管线）** | 1 | 同上 | `secrets.test.js:279` |
| C19 | `memory.js` 3 工具 + 2 监听 + 1 effect | tool/listener | **ONCE（私人记忆）** | 各 1 | 同上 | `memory.test.js` 全 60+ 例 |
| C20 | `usage.js:574`、`time-context.js:18`、`schedules.js:81`、`connectors.js:159`、`browser.js:226/228`、`update.js:228`、`dsh-update.js:167`、`diagnostics.js:125`、`chat-index.js:127`、`agents.js:34/70`、`folders.js`、`models.js`、`permissions.js`、`prompt.js:66`、`roster.js`、`handoffs.js` | 各类 | **ONCE** | 各 1 | ctx 释放 | 各自测试 |

> **C 类结论**：唯一允许新增注册的地方是**工作群自己的模块**（C1/C3/C4/C5 的复制版）。C5/C16 等在 `install.test.js:32` 有**顺序断言**，任何新增注册都会让它失败——这是护栏，不是缺陷，必须显式更新预期。

---

## D. 房间状态与 Session 创建（scan s4）

| # | 引用点 | 调用者 | 被调对象 | 分类 | 注册次数 | 卸载/重启行为 | 测试用例 |
|---|---|---|---|---|---|---|---|
| D1 | `store.js:317` `roomOf()` | 12 文件 | `state.rooms[id]` | **ONCE（须识别 wg）** | 0 | 读 `state`；`load()` 重建 `state` | **G1 WG-06** |
| D2 | `store.js:345-349` `indexSessions` 遍历 `state.rooms` | A4 | `state.rooms` | **ONCE** | 每次 load | — | A4 |
| D3 | `roster.js:335` `buildRoom` → `createSession(title)` | `createRoom` | `rt.createSession` | **LOCAL** | 每群 1 次 | Session 被 archive 于删除时 | `room-races.test.js` |
| D4 | `roster.js:46-58` `createSession` **目录回退** | 3 处 | `ctx.sessionController.create` | **DANGER** | — | — | **`work-dir.test.js:522`**（现行为：换团队目录） |
| D5 | `groups.js:191` `createSession(dir: workDirOf(...))` | `groupSessionFor` | D4 | **LOCAL** | 每成员每群 1 次 | 失效则 `retireGroupSession` | `rounds.test.js:328` |
| D6 | `parts.js:781` `createSession(dir)` | 分段切换 | D4 | **ONCE（须覆盖 wg）** | 每次切换 1 次 | — | `follow-through.test.js`、`work-dir.test.js:463` |
| D7 | `roster.js:321` `createRoom` | `create_group` 工具 / channel | `buildRoom` | **LOCAL** | — | — | `roster.test.js:182` |
| D8 | `roster.js:405` `updateRoom` | `update_group` / channel | `planRoomChange` | **LOCAL** | — | — | `room-races.test.js:104` |
| D9 | `roster.js:467` `deleteRoom` | `delete_group` / channel | `state.rooms` | **LOCAL** | — | `rt.roomInbox.delete(id)` | `room-races.test.js:125` |
| D10 | `groups.js:184-214` `groupSessionFor` | `runRound` | D5 + A7 | **LOCAL→WG 独立** | — | — | `rounds.test.js:456` |

> **D 类结论**：D4 是 **P0-4 的唯一来源**——无效目录静默回退团队工作区。工作群若走 D4 而不加 fail-closed，远程任务会落在 B 的团队目录。**D1 必须能同时识别两类群**，否则工作群 `roomOf` 返回 undefined，`groups.js` 全线失效。

---

## E. 客户端 Slot 与设置页（scan s5）

| # | 引用点 | 调用者 | 被调对象 | 分类 | 注册次数 | 卸载/重启行为 | 测试用例 |
|---|---|---|---|---|---|---|---|
| E1 | `client/index.js:777` `sidebar.workspaces` shadow | `installShell` | `ctx.slots.register` | **ONCE（整格替换）** | 1 次（每次 mount） | `surfaceGroups` withdraw → disposer | `surface.test.js:6/126` |
| E2 | `client/index.js:728-730` `shadow()` 包装 | 全部 UI 注册 | `slots.inject`+`register` | **ONCE** | 每步 1 | 同上 | `surface.test.js` |
| E3 | `client/index.js:764-789` `installShell` 13 步 | `surfaceGroups` | `freePriority` | **ONCE** | 13 | 逆序 dispose | `surface.test.js:44/69/97` |
| E4 | `client/index.js:790-824` `installConversation` 22 步 | 同上 | 同上 | **ONCE** | 22 | 同上 | `surface.test.js` |
| E5 | `client/index.js:836-887` agent surface 订阅 | effect | `sessions.list.subscribe` | **ONCE** | 2 订阅 | 返回 disposer 解绑 | `agent-roster.test.js:50` |
| E6 | `client/settings.js:26` `SETTINGS_PAGES` | `SettingsDialog` | 硬编码数组 | **ONCE（追加 Hub 页）** | — | — | `looks.test.js:32` |
| E7 | `client/sidebar.js:94` `RoomRow` | `TeamSidebar` | `roster.rooms` | **LOCAL→WG 复制行** | — | — | `sidebar-switch.test.js` |
| E8 | `client/sidebar.js:111` 群右键 | `RoomRow` | `actions.openMenu` | **LOCAL（追加"升级为工作群"）** | — | — | — |
| E9 | `client/context-menu.js:38-39` 群菜单项 | `ContextMenu` | `actions.openSettings/renameBot` | **LOCAL（追加项）** | — | — | — |
| E10 | `client/at-menu.js:9-10` `BOTS_SOURCE`/`CHATS_SOURCE` | `installAtMenu` | `triggers.registerSource` | **ONCE（新增 WG_SOURCE）** | 2 source | offs 函数注销 | `at-menu.test.js:53` |
| E11 | `client/storage.js` localStorage 键 | 多处 | `localStorage` | **DANGER（未按用户分区）** | — | 持久 | `legacy-storage.test.js` |
| E12 | `client/surface.js:60` `freePriority` | `shadow()` | `ctx.slots.entries` | **DANGER（P0-19）** | — | — | `surface.test.js:126` |

> **E 类结论**：E1 是**整格 shadow**，"插件"一级入口不在该 Slot 内。E12 依赖 `ctx.slots.entries()` 的真实形状——**这是 G1-A 探针必须回答的问题**，不能用单测替代。

---

## F. 危险待核验项汇总（DANGER 全清单）

按方案 §5.4 的第四类，集中列出必须先实测的项：

| ID | 项 | 为何危险 | 验证方式 |
|---|---|---|---|
| A9 | 工作群写 `groupOwners` | 两域共用一张身份表 | G1 WG-03/WG-05 |
| B5 | 三张 Map 挂 `rt` | 复制即共享 | G1 WG-03 |
| B11 | `rt.deliver` 被 resume 覆盖 | 二次包装叠加 | G1 检查 installation order + G2 远程投递 |
| C6/C7/C8 | 3 处 `session/event` | 双投递或丢失 | G1 WG-04 |
| C9 | `tools.guard` 唯一全局拦截 | 不覆盖 PTC/MCP/作用域工具 | **G2 T15** |
| C10 | `agent/created` ×4 含 restrict | 工作群 Session 被误隐藏工具 | G2 |
| C11 | `approval/request` 语义 | 本人审批 ≠ 工具审批 | G2/G5 |
| D4 | `createSession` 目录回退 | 远程任务落团队目录 | **G1 WG-08 / T14** |
| E11 | localStorage 未分区 | 切账号泄漏 | G3/G4 |
| E12 | `freePriority`/`sidebar.workspaces` | 无 Slot 接缝证据 | **G1-A 探针** |

---

## G. 与 `install.test.js:32` 的关系（注册次数护栏）

该测试断言 **71 项注册的精确顺序**，覆盖 `effect`/`on`/`tool`/`prompt`/`route` 五类。含义：

- 它是"**注册次数**"这一列的唯一自动化证据来源。
- G1 复制工作群子系统后，该断言**必然失败**（新增若干注册）。这不是回归，是**设计变更**，必须在 G1 显式更新预期并在 `diff-manifest.md` 注明。
- 反向用途：若 G1 之后该断言**没有**变化，说明工作群模块**没有被真正安装**——这是一个廉价而有效的负向检查。
