> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R15-CLOSURE-AUDIT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1 闭环审计（G1R15 · 历史）

> 本报告是历史快照，保留当时的判断依据。补齐后的结论见 `G1R16-CLOSURE-AUDIT.md`。

日期：2026-10-21
范围：`Workgroup_AI_技术实施方案_2026-10-21.md` §14 的 G1 门禁，逐项对照现有代码、测试与真实运行。

结论：**代码层面 G1 已闭环**（720 测试全绿、lint 0 error、`client.js` 已重建）。本轮另修掉两个"看起来没做完"的真实缺陷，其中一个是截图报的「没有正在思考提示和底部思考卡片」。

---

## 0. 本轮修复（承接截图报告）

### 缺陷 5：工作群的成员会话根本不在原版 `live` 表里

- **症状**：工作群能建、能对话，但没有原版群聊的「正在输入…」行、没有底部思考卡片（`MemberDock`）、Bot 头像没有「思考中」状态。
- **根因**：这三处都从客户端唯一的一次状态轮询读 `activity[botId]` / `work.bots[botId]` / `work.rooms[roomId]`，而原版用 `rt.live` 算这三张表。原版的事件监听在 `src/host/turns.js:352` 直接丢弃"既不是 Bot 自己会话、也不是本地群会话"的 Session：

  ```js
  if (!rt.isBotSession(id) && !rt.roomOf(id)) { if (live.delete(id)) setActivity(id, undefined); return }
  ```

  工作群成员 Session 正好两边都不属于，所以**从未进入 `rt.live`**。因此本域里三处读 `rt.live` 全部拿到 `undefined`：
  - `workingIn()`（roomPrompt 的"还在忙什么"）
  - `roomTurn()` 的 `busy` 判定（"它还在做上一件事"）
  - 客户端的三张状态表

  把成员 Session 塞进 `rt.groupOwners` 可以"修"这个，但那正是 P0-3 禁止的跨域声明（原版群聊模块会开始操作本域的回合）。
- **修复**：本域自建 `wg.live`（与 `rt.live` 同构、进程内、不落盘），在自己的 `session/event` 里维护；导出 `wg.roomWorkView(roomId)` / `wg.workView()` / `wg.activityView()`（都是原版同名函数的逐行移植）。合并点放在**答案生成处**而不是索引处：`src/host/channel.js` 的 `live()` 只在 `rt.workgroup` 存在时把本域视图并进去（`diagnostics.js:251` 已有同款只读先例）。这样一次轮询同时喂饱两种群，本地群视图不受影响。
- **测试**：`test/wg-activity.test.js`（3 个）。其中第一条在修复前**失败**、修复后通过（已用 `git stash` 实测）；第三条钉住隔离性：`rt.isBotSession(成员会话) === false`、`rt.roomOf(...) === undefined`、`rt.live.get(...) === undefined`、`rt.activityView()[...] === undefined`。

### 缺陷 6：客户端的 `room-progress` 永远拿到 `[]`

- **症状**：即使后端正确报告 `speaking`，工作群里也永远不出现「xxx 正在输入…」。
- **根因**：`src/client/api.js` 的 `call`/`callWorkgroup` **已经把 `value` 解包返回**（失败时抛错），但 `src/client/index.js` 又按 `{ok, value}` 信封取了一次：
  ```js
  callWorkgroup('room-progress', { roomId }).then(result => result.ok ? result.value : [])  // result.ok 恒为 undefined
  ```
  于是每次轮询都返回 `[]`。
- **修复**：`.then(value => value ?? [])`，并把这层契约写进注释，避免第三个调用点再犯。
- **测试**：`test/workgroup-ux.test.js` 新增一条，钉住"不得二次解包"。

> 这两个缺陷是同一现象（"进度不显示"）的两条独立断点，缺一条都仍然不显示，所以两条都修。

---

## 1. G1 门禁逐项对照（§14 line 503）

| 门禁项 | 代码落点 | 验证 |
|---|---|---|
| 复制原版完整群子系统 | `src/workgroup/host/groups.js` 1405 行（原版 `src/host/groups.js` 877 行，含扩展）；`channel.js` 213（原版 376，去掉本域不需要的端点）；逐函数 COPY 标注 | `workgroup-round.test.js` 35 条 |
| `wg` 私有状态 | `wg.sessionOwners / roomWaiters / roomProgress / roomInbox / tasks / live`，状态文件 `.dsh/bot/workgroup/state.json` | `workgroup-isolation.test.js` |
| 消除重复 install / 监听 / 工具名 | `installWorkgroup` 二次安装抛错；本域工具名 `workgroup_relay` / `read_workgroup_chat` | `install.test.js` 注册顺序断言 |
| 两个群列表 + 页面切换 | 工作群就是原版侧栏的一行（不做独立分区），唯一新入口是「插件」下方的「Bot」 | `workgroup-ux.test.js`、`sidebar` 相关测试 |
| 两类群各自创建 | `createWorkgroup` ↔ 原版 `buildRoom`，**id 就是群自己的 Session** | `a workgroup is a Session` |
| 改名 | `updateWorkgroup({name})`，名字不要求唯一 | `names are labels` |
| @ | 复用 `shared/mentions.js` 同一解析器，`@all` 展开 | `@mention` / `@all` 两条 |
| 讨论（多轮） | `runRound` 逐字移植：`limit` / 每成员上限 / `@Name` 扩容 / `drainRoomInbox` | `a round names only the member...` |
| 进度 | `roomProgress` + `speaking` + 本轮 step 行 + **本轮新修的活动视图** | `wg-activity.test.js` |
| Stop | `stopRound` / `stopMemberWork`，晚到的回复丢弃（`stoppedExchanges`） | `stopping a round cancels...`、`one member can be stopped...` |
| 删除 | `deleteWorkgroup`（归档 Session、释放在册归属） | `workgroup-isolation` / `groups` |
| 恢复 | `resumeWorkgroup`、`adoptSession`（旧 `wg-` 群在首次读列表时补建 Session） | `a legacy workgroup gets a Session...` |
| 本地群不回归 | 原版 4 个群测试套件 | `groups/group-work/group-status/member-status/tool-cells` 全绿 |
| Session 归属 / 消息 / Waiter 不串群 | `resolveSessionOwnerStrict` 双声明直接抛错；`sessionOwners` 连表 | `workgroup-isolation.test.js` |
| 热重载无重复监听 | 二次 install 抛错；监听器挂在模块级 `ctx.on`，随 `ctx.effect` 释放 | `install.test.js` |
| 准确保存差异清单 | `docs/workgroup/g1/diff-manifest.md` | — |

**本轮实测**：`npm run verify` → build/check/test/lint 全过；720 passed / 0 failed；lint 13 warnings / **0 errors**；`client.js` 888846 B，sha256 `6ff117188486f08f…`（三次连续 `npm run verify` 全绿）。

---

## 2. 仍然存在的缺口（不影响 G1 门禁，但需登记）

1. **未接线的 i18n key**：`'A workgroup needs a name'` 已无引用（名字不再必填），待删。
2. **改管理员没有 UI 入口**：`update-room` 支持 `adminId`，面板上没有按钮。门禁只要求"改名"，故未做。
3. **`kind:'workgroup'` 一值两义仍是本域的结构性隐患**：群自己的 Session 和每个成员 Session 都是这个 `kind`，只能靠 `owner.botId === undefined` 区分。已抽成 `isGroupSession()` 一处判定、三个门禁用它，但**任何新代码只要再写一次 `kind` 判断就会复发**（G1R12/G1R14 两次都是这个形状）。
4. **G2 未开始**：需要真机 + 真 API key。

---

## 3. 需要人工验收的一步

本轮修的两个缺陷都只在真实 DSH 进程里可见，而**插件是按 `link:` 装的：源码改动磁盘上立刻可见，但已加载的 ESM 模块不会热重载**。上一轮 17:33 的失败已确认是进程仍跑着 17:26:21 启动的旧代码（`ps -W` 五个 `DeepSeek Harness.exe` 全部早于 17:32 的重建）。

验收步骤：

1. 完全退出 DSH Desktop（确认所有 `DeepSeek Harness.exe` 都结束）。
2. 重新启动，新建一个工作群。
3. 期待看到：管理员先说第一句（kickoff）→ 输入 `@成员` 后出现「xxx 正在输入…」→ 回复出现在群里 → 输入框上方出现成员活动卡片 → 头像呈「思考中」动画。
