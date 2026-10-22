> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R13-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1R13 — 工作群"没有初始化、@bot 和对话没回复"的真正根因与完整复制

日期：2026-10-21
触发：用户第二次报告同一现象 + 提供真实会话日志
`dsh-session-session-15d83279-16a0-4f65-8504-2f0b8bb7d3cd.zip`

---

## 一、上次判断错了一半：日志证明是**三个**缺陷

上一轮（G1R12）我认为根因是"成员 Session 被当成 relay Session"。日志证明**那个修复是对的，但不够**。
用户再次报告，说明还有别的东西在坏。

我把日志解压后逐个事件读完，得到的事实：

### 会话 `session-15d83279`（群自己的 Session）

| 事件 | 内容 |
|---|---|
| `user/message` seq 9 | `[Workgroup created]`，`source.role='kickoff'` |
| `tool/call` seq 16 | `workgroup_relay {}` ← relay **已经跑起来了** |
| `tool/result` seq 17 | `{"replies":[],"passed":["Chief"]}` |
| 同上 × 3 轮 | 用户发 `@Chief` → 同样空结果；再发中文 → 同样空结果 |

**关键：relay 是通的，`workgroup_relay` 被调用了 3 次。**
所以 G1R11 的 `llm/stream` 合成修复有效 —— 问题不在 relay，在 relay **里面**。

### 成员 Session `session-8c0d0aab`（Chief 的 Session）

| 事件 | 内容 |
|---|---|
| `system/message` | `# Workgroup relay … You are only the relay … Never add your own text.` |
| `user/message` | `Members: … This round so far (oldest first):\nUser: ` ← **冒号后面是空的** |
| `assistant/message` | `content: []` ← 空回复 |
| 同上 × 3 轮 | 每轮都空 |

由此得到三个**独立**缺陷：

---

## 二、三个根因

### 根因 1（G1R12 已修）成员 Session 收到 relay 提示词

`createWorkgroup` 和 `sessionFor` 都写 `kind:'workgroup'`，提示词只按 `kind` 分支，
于是成员 Session 也被告诉"你只是 relay，不要加自己的话"。它照做了 —— 回复为空。

**G1R12 已改为按 `owner.botId` 分支**：成员 → `# Your identity`，群 → relay。
本日志是 16:52:39 的，修复提交在 16:54:18，所以这份日志**早于修复**。
成员 owner 记录里没有 `name` 字段，而 `name` 只有修复后的代码才写 —— 这一点独立证明了
日志跑的是旧代码。

### 根因 2（本轮新发现，此前从未修过）kickoff 被当成空消息

原版是怎么做的（`src/host/turns.js:446`）：

```js
} else if (source?.kind === SOURCE_KIND && source.role === 'kickoff' && rt.roomOf(id)) {
  queueRoomMessage(id, { text: '', kickoff: true })
}
```

原版队列里放的是 **`{ kickoff: true }`**，然后 `openingSpeakers` 看到 `opener.kickoff`
就把 admin 叫上来，`roomPrompt` 看到 `round.kickoff` 就整段换成 `roomKickoff()`：

> The user just created this group and has not written yet. Greet the user in one short
> message and ask what they want this group to work on…

**我们这边**：`session/event` 监听器只认 `source.kind === 'user' || 'schedule'`，
kickoff（`kind: 'workgroup'`）被直接忽略 → 队列空 → relay 用 `[{ text: '' }]` 兜底 →
log 里写进一条 `User: `（空）→ prompt 变成 `This round so far: User: `（空）→
成员看到"用户发了一条空消息"，合理地什么都不说。

**这就是"没有像原版群聊那样初始化"的字面含义。** 群开了，但开场白机制没复制。

### 根因 3（本轮新发现）客户端不认 `workgroup_relay`

`src/client/cells.js:753` 只有 `case 'group_relay'`。我们的工具叫 `workgroup_relay`，
落进 default 分支 → **什么也不画**。即使每轮都成功，群聊界面也是空的。

同理 `actions.roomProgress` 走的是原版 `/api/bot` 路由，只读 `rt.roomProgress`；
工作群的回合在 `wg.roomProgress` 里，所以"谁正在说话"那一行永远是空的。

---

## 三、本轮做了什么：完整复制，而不是打补丁

用户的长期要求是"先确认原版有没有，有则复制全部代码再自定义"。所以这一轮不是修补，
是把 `src/host/groups.js` 里**整块回合机制**逐行搬过来。

### `src/workgroup/host/groups.js`（848 → 1273 行）

**新增：原版的常量与文本（模块级）**
- `ROOM_REPLY` / `ROOM_CALLS` —— 原版 88-91 行，逐字复制。这两句是让成员
  "真的去做，而不是承诺以后做"以及让 `@Name` 叫人的关键。
- `slotLabel`（91）、`adminNote`（103）、`roomKickoff`（110）—— 逐字复制。
- `lineText` 补齐 `lookup` / `resumed` / `cut` / `stopped` / `done` 五种行类型。
- `transcript`、`failureLine`（`failureLine` 就地复制，避免引入 `turns.js` 的
  整条投递栈依赖）。

**新增：原版的回合函数**
| 原版 | 位置 | 本轮 |
|---|---|---|
| `roomPrompt` | 219 | 逐行复制：members/notice/adminNote/kickoff/earlier/current/references/still-at-work/说话顺序/第几位/`ROOM_REPLY` |
| `roomTurn` | 274 | 逐行复制：`touch`/`work`/`say`/`approval`/`fail` 五路 waiter，`missed`（240s 无动静）、`working`（15s 宽限）、busy 判定、失败分类、丢失 Session 退役 |
| `postInRound` | — | 复制 |
| `waitersOf` / `touchRoomTurn` / `failRoomTurn` / `yieldRoomTurn` / `workRoomTurn` | 330-354 | 复制，键改为 `wg.roomWaiters` |
| `callMembers` | 355 | 逐字复制：被叫成员提前、插在 `index` 之后、`cap` 限次 |
| `openingSpeakers` | 670 | 逐字复制：kickoff/quiet/done/progress/late/admin 六条规则 |
| `drainRoomInbox` | 390 | 复制：回合中用户再发言并入本回合 |
| `runRound` | 410 | 复制：`limit` 预算、`turns` 计数、`@Name` 展开、per-member cap |
| `group_relay` 工具体 | 488 | 复制：kickoff 回合、事件 post、round 全字段、`reportRound` 钩子 |
| `postStep` / `flushSteps` / `takeRoomSteps` / `withRoomSteps` | 731-782 | 复制：过程行合并与节流 |
| `lateRoomReply` / `lateRoomFailure` | 703 / 799 | 复制：回合之后才结束的工作 |

**`session/event` 监听器重写**（对应 `turns.js:349-620`）
- kickoff 入队为 `{ kickoff: true }`（根因 2）
- `turn/start` 重置本回合文本；`assistant/message` 累积 + 按 `showSteps` 规则发过程行
- `tool/call` / `tool/ptc-dispatch-start` → `workRoomTurn`（真在工作就放行回合）
- `turn/end` 才解析 waiter（原版语义），`aborted` 解析为 `null`
- 每个事件 `touchRoomTurn`，工作中的成员不会被 240s 超时切断

**`src/workgroup/shared/constants.js`** 新增 `WG_REPLY_TIMEOUT_MS`(240s)、
`WG_WORK_GRACE_MS`(15s)、`WG_LATE_ROUNDS`(10)、`WG_STEP_GAP_MS`(30s)、
`WG_EXTRA_TURNS`/`WG_ADMIN_EXTRA_TURNS`/`WG_TURNS_EACH`/`WG_ADMIN_TURNS_EACH`。

### `src/workgroup/host/channel.js`
新增 `room-progress` 端点（原版 `channel.js:152` 的对应物），从 `wg.roomProgress` 读。

### `src/client/text.js`
`toolName()` 把 `workgroup_relay` 归一成 `group_relay`，让**原版所有渲染分支**直接复用 ——
卡片、文案、`GroupReplies` 回复栈，一个都不用重写（根因 3）。

### `src/client/index.js`
`roomProgress` 按群的下域路由：工作群 → `/api/workgroup`，本地群 → `/api/bot`。

### 一个重要修正：不再把回合内的回复投进群 Session
上一轮我加了 `postToGroupSession`，在每轮回复后往群 Session 里再发一条。
**这是错的**：原版不这么做。原版 `group_relay` 把 replies 作为工具结果返回，
客户端 `GroupReplies` 从结果里画。我那种做法会让每条回复**显示两遍**。
已把该测试改为断言"回复经由 relay 结果返回"，与原版一致。
（`postToGroupSession` 保留，但现在只用于 `postStep` / `lateRoomReply` / `lateRoomFailure`
—— 也就是原版 `postToRoom` 真正会被调用的那三处。）

---

## 四、验证

```
npm run verify
  build  ok  0.3s
  check  ok  0.3s
  test   ok  7.2s    714 passed / 0 failed
  lint   ok  0.4s    0 errors（12 条 warning 为既有）
client.js   888595 B  sha256 98e92812f9955dac…  17:23
```

`client.js` 已含 `name === "workgroup_relay"`。

### 新增回归测试（直接把日志里的三个现象钉住）
1. `the kickoff opens a round with the admin and the original kickoff prompt`
   —— 断言队列里是 `{ kickoff: true }`、admin 被叫、prompt 含
   `created this group and has not written yet`。**根因 2 的护栏。**
2. `an @mention in the first message calls that member and it answers`
   —— **"@bot 没回复"的护栏。**
3. `a member at work posts what it says before its final answer`
   —— **"对话没回复/没有进度"的护栏**：带 tool-call 的文本立即进群。
4. `a round's answers reach the client the original way: through the relay result`
   —— 锁定"回复走 relay 结果"，防止再退回重复投递。

---

## 五、G1 门禁逐条状态

方案 §14 G1 门禁：两类群各自 **创建、改名、@、讨论、进度、Stop、删除、恢复**；
本地群功能完全不回归；Session 归属、消息和 Waiter 不串群；热重载无重复监听；准确保存差异清单。

| 门禁项 | 代码 | 测试 | 状态 |
|---|---|---|---|
| 工作群 创建 | `createWorkgroup` + kickoff | `a workgroup is a Session` / kickoff 测试 | ✅ 代码完备 |
| 工作群 改名 | `updateWorkgroup` | 自定义名可重复 / 同名禁改 admin / 空名复原 | ✅ |
| 工作群 @ | `mentionsIn` + `openingSpeakers` + `callMembers` | `an @mention in the first message calls that member` | ✅ |
| 工作群 讨论 | `runRound` 全量复制 | `a workgroup round runs, posts each answer`、`@all calls every member`、`[PASS]` | ✅ |
| 工作群 进度 | `postStep`/`flushSteps` + `room-progress` + 客户端归一 | `a member at work posts what it says...` | ✅ |
| 工作群 Stop | `stopRound` + `stopMemberWork` | `stopping a round cancels...`、`one member can be stopped...` | ✅ |
| 工作群 删除 | `deleteWorkgroup` | `deleting a workgroup clears its map entries...` | ✅ |
| 工作群 恢复 | `resumeWorkgroup`（报告不重放） | `resume reports interrupted work but never replays` | ✅ |
| 本地群不回归 | 未改动原版 | 原版 `rounds.test.js` 等全套 714 项 | ✅ |
| Session 不串群 | `wg.sessionOwners` + `resolveSessionOwnerStrict` | `workgroup-isolation.test.js` 16 项 | ✅ |
| 无重复监听 | `installWorkgroup` 单次 + `install.test.js` 精确顺序表 | ✅ | ✅ |
| 差异清单 | 本文件 + `G1R11-REPORT.md` | ✅ | ✅ |

**结论：G1 的代码与自动化测试已全部落地。** 剩下的是**真机人工验收**（见下）。

### 与原版仍存在的差异（如实列出，均为有意）
1. `openingSpeakers` 的 `references`（引用会话）分支未接 —— G1 不涉及引用，留给后续。
2. `drainRoomInbox` 简化为"整批并入"，原版还会检查 `agent.inbox` 的图片/引用消息并
   决定是否留到下轮；G1 只有文本消息。
3. `reportRound`（把回合结果回报给发起的 Bot）未接 —— 需要 `post.sub`/`closeWork`，
   属 Bot 间协作，G2/G5 范畴。
4. `roomKickoff` 的 `rt.uiLanguage()` 已接；`rt.roomOf` 换成 `wg.workgroupOf`。

---

## 六、请这样确认（真机）

**必须彻底重启** —— 插件是 `link:` 安装，源码改了但 ESM 模块不会热重载：

1. 完全退出 DSH Desktop（任务管理器里确认没有残留 `DeepSeek Harness.exe`）；
2. 重新打开 → 设置 → 反馈：`Host since` 应**晚于** `Host code`（当前 `Host code` 应为 17:23 之后）；
3. 菜单新建工作群 → 进入 → **admin 应先开口问"这个群要做什么"**；
4. 发 `@Chief 你好` → Chief 应回复，且回复出现在群聊里；
5. 让一个成员做需要工具的事 → 应先看到"我先看一下…"这类过程行，最后看到结果。

若仍失败，请提供：
- 设置 → 反馈里诊断表前 12 行（尤其 `Host code` / `Host since` / `Client bundle`）；
- Console 中 `[ds-bot]` 开头的行；
- 新的会话日志 zip（和这次一样即可）。
