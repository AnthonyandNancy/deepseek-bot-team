> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R11-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1R11：先核对「是否完整复制原版群聊」，再修 bug

用户的指示：

> 做需求前确认原版的功能有没有，有则不要自己做先复制全部代码再自定义。
> 你应该先确认好工作群聊的代码是否已经完整复制了原版群聊的全部代码，再去找这个 bug。

## 一、先核对复制完成度（这是本轮最重要的产出）

上一轮（G1R10）我判断「代码是对的，只是没加载」。本轮诊断证明**那个判断错了**：
迁移真的跑了，7 个群都有真实 Session，`sessionOwners: 7`，Session 文件都在磁盘上。
所以「进不去」是**真实缺陷**，不是缓存。

完整比对 `src/host/groups.js`（原版 877 行 / 17 个函数）与
`src/workgroup/host/groups.js`（690 行 / 15 个函数），缺口如下。

### 已经补齐的（本轮）

| 原版函数 | 作用 | 状态 |
|---|---|---|
| `llm/stream` 合成 relay | **群 Session 从不让模型决定**，直接合成 `group_relay` 工具调用 | 本轮补上 |
| `greetRoom` | 建群时投 kickoff，让 admin 开口 | 本轮补上 `greetWorkgroup` |
| `postToRoom` | 成员发言回投群 Session | 上一轮补上 `postToGroupSession` |
| `stopMemberWork` | 停单个成员 | 本轮补上 |
| `user/message → roomInbox` | 用户打字进群，排队下一轮 | 上一轮补上 |

**`llm/stream` 是这次「进不去」的真正根因。** 原版不靠提示词要求模型调 relay——它
在 `llm/stream` 里合成工具调用并作为模型回答返回。我此前只加了一段系统提示词，
模型不照做时群就永远没有反应。提示词无法保证行为，事件钩子可以。

### 仍然缺失的（如实记录，未在 G1 实现）

| 原版函数 | 作用 | 影响 |
|---|---|---|
| `openingSpeakers` / `callMembers` | 完整选人规则（kickoff/quiet/done/late/progress/references） | 本域用简化版：@all / @名字 / admin |
| `roomTurn` / `postStep` / `flushSteps` | 成员轮次的过程行与步进 | 无过程行，只有最终发言 |
| `lateRoomReply` / `lateRoomFailure` | 迟到回复、模型调用失败上报 | 迟到回复被丢弃，失败不告知 |
| `reportRound` | 向发帖 Bot 汇报本轮结果 | 无 |
| `drainRoomInbox` / `groupSessionFor` / `waitersOf` | 内部取队列/取 Session 的薄封装 | 本域内联，行为等价 |
| `keepGroupLine` / `dropGroupLine(s)` | 长行落盘 | 已改名为 `keepLine`/`dropLine(s)`，行为等价 |
| `transcript` / `short` / `memberIn` / `callsIn` / `slotLabel` / `spokeThisRound` / `quiet` / `say` / `work` / `touch` / `finish` / `ensureRoomLog` / `appendRoom` / `postInRound` | 细粒度辅助函数 | 本域内联为 `appendLine`/`runRound` |

**结论（诚实版）**：核心链路（建群→kickoff→用户发言→relay→逐个成员回答→回投群聊→停止）
已与原版一一对应；**过程行、迟到回复、失败上报、完整选人规则尚未复制**。
这些不是「进不去」的原因，但确实是原版有、本域没有的能力，属于 G1 未完成项。

## 二、本轮代码改动

`src/workgroup/host/groups.js`

1. **`relayStream`（`llm/stream` 钩子）** — 逐行对照原版 843-877 行。只在
   `sessionOwners.get(id).kind === 'workgroup'` 时生效；成员 Session 与普通 Session 一律
   走模型。当最后一条是用户/定时/成员 post/kickoff 时合成 relay 工具调用，否则 `stop`。
   带 `.relay` 标记，测试可按语义取用而不依赖注册顺序。
2. **`greetWorkgroup`** — 建群后异步投 kickoff，失败只 warn，不影响建群结果。
3. **`stopMemberWork`** — 以 `wg.roomWaiters`（谁正在等）为准，而非 `round.started`
   （会提前 splice），停止后把该成员回复丢弃。

`src/workgroup/host/channel.js` — 新增 `stop-member-work` 端点。

`src/host/usage.js` / `src/host/secrets.js` — 给 `llm/stream` 的两个监听器加标记
（`.meter` / `.redacts`），并把 `usage.test.js`、`secrets.test.js` 从「按位置 `.at(-1)`」
改为按标记查找。位置从来不是契约，新增监听器不应该让无关测试失败。

`test/install.test.js` — 注册顺序表补 `on llm/stream`，位置按真实注册顺序。

## 三、验证

```
npm run verify   build ok / check ok / test ok / lint ok
npm test         710 passed / 0 failed
client.js        888071 B  16:36:34   sha256 88a9f8c7…
安装路径已含      relayStream / greetWorkgroup / stopMemberWork / postToGroupSession
```

新增测试：

- `the group Session relays by itself, without asking the model` — 模型不被调用，
  合成 `workgroup_relay`；成员 Session 与普通 Session 仍走模型。
- `a new workgroup posts a kickoff, so its chat is never a blank page`。
- `one member can be stopped while the round goes on` — 停止后迟到的回复不入 log。
- `sending into a workgroup prompts its own Session, the way a group chat does`。

## 四、请这样确认

1. 彻底退出 DSH Desktop（含后台宿主进程）后重启；
2. 设置 → 反馈：`Host since` 应晚于 `Host code`；
3. 从菜单新建工作群 → 应能进入，且 admin 会先问「这个群要做什么」；
4. 在群里发言 → 成员依次回答，回答出现在群聊里。

若仍失败，请提供 Console 中 `[ds-bot]` 开头的行与诊断表前 12 行。
