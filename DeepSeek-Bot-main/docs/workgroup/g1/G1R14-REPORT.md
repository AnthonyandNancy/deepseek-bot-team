> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R14-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1R14 — 成员 Session 被 relay 钩子截获（"@bot 和对话没回复"的真正根因）

日期：2026-10-21
触发：用户第二次截图，群时间戳 **17:26:43**（晚于 17:23/17:24 的构建）

---

## 一、这次终于抓到了

上一轮（G1R13）我修复了 kickoff 空消息和客户端不认 `workgroup_relay` 两个问题，
用户重启后又试了一次，仍然没有回复。

**群时间戳 17:26:43 晚于我 17:23 的构建** —— 说明新代码确实加载了。
所以问题不在"代码没生效"，是真的还有 bug。

### 读真实运行数据

`$DSH_HOME/bot/workgroup/state.json` 里 17:26:43 那个群：

```
id       session-98c0991d-…  seq = 1
sessions { Chief 的 botId -> session-c527e84a-… }
log      [ { who: 'User', text: '@Chief sadasd', seq: 1 } ]
```

`seq=1` 且成员 Session 已建 → **回合跑了**。但 log 里只有用户自己那句话，没有回复。

### 读两个 Session 的真实日志

**群 Session `session-98c0991d`**（31 个事件）—— 完全正常：

```
user/message  workgroup/kickoff  [Workgroup created]
assistant/message  ['tool-call:workgroup_relay']     ← relay 正常触发
tool/result   ...
turn/end      completed
turn/start    turn 2
user/message  user  @Chief sadasd
assistant/message  ['tool-call:workgroup_relay']     ← 再次正常
```

**成员 Session `session-c527e84a`**（27 个事件）—— 问题在这里：

```
system/message | identity-prompt   ← 提示词已正确（G1R12 修复生效）
user/message  workgroup/room  Members: the user, 阿三大苏打 and you (admin)…
assistant/message  []               ← 空
turn/end  {"reason":{"kind":"completed"}}
```

成员拿到了正确的 `# Your identity` 提示词，拿到了正确的回合 prompt，
然后 `assistant/message` 是**空数组**，`finish` 原因是 `stop`。

**不是模型答了空话，是模型根本没被问。**

---

## 二、根因

`src/workgroup/host/groups.js` 的 `llm/stream` 钩子（`relayStream`）：

```js
const owner = wg.sessionOwners.get(options.sessionId)
if (owner === undefined || owner.kind !== 'workgroup') {
  yield* next()   // 放行给模型
  return
}
// …否则合成 workgroup_relay 工具调用
```

真实 owner 记录（从 state.json 读出）：

| Session | owner 记录 |
|---|---|
| 群自己 | `{kind:'workgroup', workgroupId:'session-98c0…'}` |
| 成员 Chief | `{kind:'workgroup', workgroupId:'session-98c0…', botId:'session-1c54…', name:'Chief'}` |

**两者 `kind` 都是 `'workgroup'`。**

所以 `owner.kind !== 'workgroup'` 这个判断对**成员 Session 也是假** →
成员 Session 被送进 relay 分支 → 钩子给它回了一个合成的 `workgroup_relay` 工具调用，
模型从来没被调用 → `assistant/message` 为空 → 回合判定为 `passed` → 群里什么都没有。

### 这是 G1R12 那个 bug 的孪生兄弟

G1R12 我修的是**提示词**：`systemPrompt` 段按 `owner.botId` 分支，
群 → relay 提示词，成员 → `# Your identity`。

但同一个"`kind` 分不出群和成员"的错误，还留在**另外三处**：

| 位置 | 修了吗 |
|---|---|
| `systemPrompt` 段（479 行） | G1R12 已按 `botId` 分支 ✅ |
| `llm/stream` 钩子（1220 行） | **没修 → 本轮根因** ❌ |
| `session/event` 用户消息入队（1133 行） | **没修** ❌ |

第 1133 行同样危险：成员 Session 里用户发的消息会被误当成"发到群里"。

---

## 三、修复

### 一个判别函数，三处统一使用

`kind` 不能用来区分，因为两者都是 `'workgroup'`。可靠的判据是 **`botId` 是否存在**：
成员的 owner 记录带 `botId`，群自己的记录不带。

```js
// 模块级，三处共用
const isGroupSession = owner => owner !== undefined && owner.botId === undefined
```

三处改为：

1. **`llm/stream` 钩子**（根因）：`if (!isGroupSession(owner)) { yield* next(); return }`
   —— 成员 Session 放行给模型，只有群自己的 Session 才合成 relay。
2. **`session/event` 入队**：`if (!isGroupSession(owner)) return`
   —— 只有群自己的 Session 才把用户输入入队。
3. **`systemPrompt` 段**：改为同一判据，消除歧义。

### 为什么之前没发现

已有的测试 `the group Session relays by itself, without asking the model` 里写的是：

```js
for (const sessionId of ['bot-a', 'some-other-session']) { … }
```

`'bot-a'` 是 **Bot 的 id**，不是 Session id，`sessionOwners` 里查不到 → 走
`owner === undefined` 分支 → 放行。测试通过了，但**真实成员 Session 这条路径从未被覆盖**。

---

## 四、验证

### 新测试先在修复前失败

新增 `a member Session reaches the model, and only the group Session relays`，
用**真实成员 Session id**（从 `room.sessions['bot-a']` 取），断言：

- 成员 Session → `next()` 被调用 1 次（模型被问）
- 群 Session → `next()` 调用 0 次，且合成 `workgroup_relay`

把钩子改回 `kind` 判据后运行：

```
✖ a member Session reaches the model, and only the group Session relays
  AssertionError [ERR_ASSERTION]: the member Session is answered by the model
```

恢复修复后通过。**这个测试确实守住了这个 bug。**

### 全量

```
npm run verify   build ok / check ok / test ok / lint ok
716 passed / 0 failed     lint 0 errors
client.js        888595 B  17:32   sha256 98e92812…
```

---

## 五、根因链完整回顾

用户第一次报告"没有初始化、@bot 和对话没回复"，一共是**四个**独立缺陷叠在一起：

| # | 缺陷 | 症状 | 修复 |
|---|---|---|---|
| 1 | 成员 Session 收到 relay 提示词 | 模型答空 | G1R12：提示词按 `botId` 分支 |
| 2 | relay 只靠提示词，没有事件钩子 | 群完全不动 | G1R11：复制原版 `llm/stream` 合成 |
| 3 | kickoff 被当成空用户消息 | 开场白是空的 | G1R13：复制 `turns.js:446` 的 `{kickoff:true}` |
| 4 | **成员 Session 被 relay 钩子截获** | **提示词对了、模型仍没被问** | **本轮** |

第 4 个之所以最后才发现，是因为它被第 1、2 个挡住了 —— 前两个在的时候，
根本走不到"成员 Session 的模型调用"这一步。而第 4 个又因为测试用错了 id 而漏检。

---

## 六、请这样确认

必须**彻底退出 DSH Desktop**（任务管理器确认无残留 `DeepSeek Harness.exe`）再打开：

1. 新建工作群 → 进入 → **admin 应先开口**（「这个群要做什么？」之类）；
2. 发 `@Chief 你好` → Chief 应正常回复，回复显示在群聊里；
3. 让成员做需要工具的事 → 应先看到过程行，最后看到结果。

如果这次仍不对，请给我：
- 新建群的时间戳（群标题里就有）；
- 诊断表前 12 行（`Host code` / `Host since` / `Client bundle`）；
- 会话日志 zip。

我会直接对比"群时间戳 vs Host code 时间"，确定是代码没加载还是新问题。
