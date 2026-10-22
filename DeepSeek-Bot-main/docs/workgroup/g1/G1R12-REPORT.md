> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R12-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1R12：成员被要求「保持沉默」—— 工作群对话无回复的根因

用户新增反馈：

> 是可以创建了，但是没有像原版群聊那样初始化，@bot 和对话也没回复

并附上了成员 Session 的真实日志
（`dsh-session-session-3a9e992a-b487-4382-9041-bba671ec1b08.zip`）。

## 一、日志给出的确凿证据

解压后共 35 个事件，三轮完整的 `turn/start → assistant/message → turn/end`：

```
 6 turn/start
10 user/message  src=workgroup/room  'Members: the user, 阿三大苏打 and you (admin)…User: @Chief…'
16 assistant/message  []            ← 空
18 turn/end
20 …24 assistant/message []          ← 空
26 turn/end
28 …32 assistant/message []          ← 空
34 turn/end
```

成员**确实收到了正确的轮次提示**（`User: @Chief`、`User: 12dscddsad`），但每次都回复空消息。

事件 9 的系统提示揭示了原因：

```
# Workgroup relay
This conversation is a workgroup between the user and several Bots.
You are only the relay, not a participant.
For every new user message: call workgroup_relay exactly once …, then end your turn with
an empty reply. Never add your own text.
```

**这是发给「群的 Session」的中继指令，却被追加到了成员 Session 上。**
Bot 严格照做——"never add your own text"——于是永远返回空。所以"没初始化、@bot 没回复"
是同一个根因，不是两个问题。

## 二、为什么会串

`createWorkgroup` 与 `sessionFor` 都把 owner 记为 `kind: 'workgroup'`：

| Session | 记录 |
|---|---|
| 群自己的 Session | `{kind:'workgroup', workgroupId: id}` |
| 成员的 Session | `{kind:'workgroup', workgroupId: room.id, botId: member.id}` |

而提示词只判断 `owner.kind === 'workgroup'`，两者都被命中。

原版不是这样：原版成员 Session 渲染**该成员 Bot 自己的身份与工具**
（`room.sessions[botId]` 与 Bot 私聊共用同一套 system prompt），只有群 Session 才是中继
（`src/host/prompt.js:52-61`）。

## 三、修复

`src/workgroup/host/groups.js` — `workgroup-relay` section 现在按 owner 形态分流：

- **群自己的 Session**（`workgroupId === 自身 id` 且无 `botId`）→ 中继指令，保持原样；
- **成员 Session**（有 `botId`）→ Bot 身份：

```
# Your identity
You are Chief, a Bot on the user's team in DS Bot.

You are answering in a workgroup: the user and several Bots talk there, one at a time.
Answer with your message for the group.
```

明确**不再**告诉成员"保持沉默"。轮次提示本身已有 "Reply [PASS] to stay silent"，
需要沉默时成员仍可 `[PASS]`。

`src/workgroup/host/ownership.js` + `sessionFor` — owner 记录新增 `name`（成员创建
Session 时的名字）。Bot 记录被删时仍能给出身份，而不是退回空提示词——空提示词等于
"回答空消息"，与群坏掉无法区分。

## 四、验证

```
npm run verify   build ok / check ok / test ok / lint ok
npm test         711 passed / 0 failed
client.js        888071 B  16:46:35   sha256 88a9f8c7…
安装路径已含     Your identity / owner.name
```

实测两种 Session 拿到的提示词（探针输出）：

```
=== 群 Session (relay):
# Workgroup relay
… You are only the relay, not a participant. … Never add your own text.

=== 成员 Session (identity):
# Your identity
You are Chief, a Bot on the user's team in DS Bot.
…
You are answering in a workgroup: the user and several Bots talk there, one at a time.
Answer with your message for the group.
```

新增测试 `a member Session carries its Bot identity, and only the group Session is the relay`：
断言群 Session 有中继指令、成员 Session 有身份**且不含** "Never add your own text"。

## 五、请这样确认

彻底退出 DSH Desktop 后重启，然后：

1. 新建工作群 → admin 应先开口问这个群要做什么（kickoff）；
2. `@某个Bot` → 该 Bot 应真正回答，回答出现在群聊里；
3. 直接发一句话 → 成员依次回答。

若仍无回复，请再导出一份成员 Session 日志（导出方式同这次），
重点看该 Session 的 `system/message` 事件第一段是不是 `# Your identity`。
