> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R9-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1R9：工作群聊进不去 / 进去是空的 —— 补齐原版群聊的三处机制

用户报告（菜单创建）：

> 创建工作群后进入的是复制原版群聊所有代码为基础的工作群聊，现在无法进入，场景是从菜单上创建的

上一轮（G1R8）修的是「群没有自己的 Session」，让 `openSession(room.id)` 有东西可开。
那一轮确实必要，但**不够**：Session 能打开，只是打开后它不是群聊。

## 排查方法（先确认原版有没有）

按用户反复强调的规则，先读原版群聊代码，找出「一个群 Session 靠什么变成群聊」，再逐条比对本域。

| 原版机制 | 位置 | 本域上一轮 |
|---|---|---|
| 群 Session 的系统提示词：只做中继、每轮调 `group_relay`、不许自己说话 | `src/host/prompt.js:52-61` | **缺失** |
| `user/message` → `roomInbox`：用户打字进群，排队给下一轮 | `src/host/turns.js:471-476` | **缺失** |
| 成员发言回投到群 Session（`role:'post'`） | `src/host/groups.js:687-694` (`postToRoom`) | **缺失** |
| 客户端把 `role:'post'` 画成群消息、并隐藏中继自己的文本 | `src/client/cells.js:389-410`, `:160` | **缺失**（且 `roomsById` 里没有工作群） |

结论：本域只做出了「一个空 Session」，原版把 Session 变成群聊的四件事一件都没复制过来。
所以症状不是「打不开」，而是**打开后什么都没有**——正是用户说的「进去的是复制原版群聊为基础的工作群聊，现在无法进入」。

## 改动（都是复制原版，不是自己设计）

### 1. 中继提示词 `src/workgroup/host/groups.js`

复制 `promptFor` 的 room 分支，注册为 `workgroup-relay`（order 641，紧邻原版 `bot-identity` 640）：

```
# Workgroup relay
This conversation is a workgroup between the user and several Bots. You are only the relay, not a participant.
For every new user message: call workgroup_relay exactly once with no arguments, then end your turn with an empty reply. Never add your own text.
```

只在 `sessionOwners.get(agentId).kind === 'workgroup'`（即群自己的 Session）时返回文本；
成员 Session 和普通 Session 都返回空串，不会把某个 Bot 的工作会话说成中继。

### 2. 用户消息入队 `src/workgroup/host/groups.js`

复制 `turns.js` 的 `user/message` 分支，加在原有的 `session/event` 监听器里。
只对 `kind === 'workgroup'` 的 Session 生效；成员 Session 不参与，避免把 Bot 的轮次当成用户发帖。

### 3. 成员发言回投群 Session `src/workgroup/host/groups.js`

复制 `postToRoom`，新增 `postToGroupSession(room, member, text)`：

- 投递到**群自己的 Session**（`room.id`），不是成员的 Session；
- `source.kind = WG_SOURCE_KIND`（`'workgroup'`），不是原版的 `'bot'`，原版 listener 不会误吃（P0-3）；
- `senderSessionId` 用成员的 Bot id，客户端据此画头像和名字；
- 文本前缀 `[Workgroup post from <name>]`，与原版 `[Group post from …]` 同构。

`runRound` 每投递一条成员发言后调用它；投递失败只记 warn，不中断整轮。

### 4. 客户端把工作群当群聊 `src/client/sources.js`

`indexRoster(value, workgroups)` 新增可选第二参数：工作群**同时**进 `roomsById`，
把成员对象映射成 id 列表、`adminId` 映射成 `admin`（`RoomAvatar` 和 `GroupMessage` 读的就是这两个字段）。

这样原版所有 group-aware 组件**不改一行**就能作用于工作群：表头画 `RoomAvatar` + 名称、
群聊隐藏中继文本、输入框按群聊处理。工作群仍不进 `rooms`（那是本地群列表），所以侧栏不会重复。

### 5. 列表变化即重新索引 `src/client/index.js`

`workgroupStore` 变化（新建/改名/删除）时立刻用上一次的团队数据重新 `index`，
不等下一次 1.5s 轮询——否则刚从菜单创建的工作群会在第一次打开时还不被识别成群聊。

### 6. 渲染 `src/client/cells.js` + `src/client/text.js`

`triggerBody` 增加 `source.kind === 'workgroup'` 分支，`role: 'post'` 走同一个 `GroupMessage`；
`HEADER` 正则增加 `Workgroup post from`，让前缀被剥掉。

### 7. 发送走原版路径 `src/workgroup/host/channel.js`

旧实现只把文本塞进 `roomInbox`，**没有任何东西去提示群 Session**，所以面板发的消息永远不会开始一轮。
现改为复制原版：`wg.postToSession(room, text)` 以普通 `source: { kind: 'user' }` 投进群 Session，
再由第 2 条的监听器排队、由中继工具跑这一轮。

## 验证

```
npm run verify   build ok / check ok / test ok / lint ok
npm test         707 passed / 0 failed   (工作群相关 26 个)
npm run lint     13 warnings / 0 errors
client.js        888071 B  sha256 88a9f8c727d87276
npm pack --dry-run  含 src/workgroup/host/groups.js (35.7kB) 等全部改动文件
```

新增测试（`test/workgroup-round.test.js`）：

- `the group's own Session is told to relay, as an original group Session is`
  —— 群 Session 拿到中继指令，成员 Session 和普通 Session 拿不到。
- `a member's reply is posted into the group's own Session`
  —— 发言投进 `room.id`、`senderSessionId` 正确、`kind === 'workgroup'`。
- `what the user types into a workgroup is queued for the next round`
  —— 群 Session 的用户消息入队，成员 Session 的消息不入队。
- `sending into a workgroup prompts its own Session, the way a group chat does`
  —— 面板发送走提示路径，不再只塞 inbox。

`test/install.test.js` 的固定顺序表加入 `effect ds-bot: workgroup relay section` /
`prompt workgroup-relay 641`，顺序与真实注册一致。

## 仍需人工确认

- 重启 DSH Desktop 后从菜单创建工作群，应能进入并看到群聊界面（表头头像+名称）；
- 在群聊里发一条消息，成员应依次回答，回答出现在群聊里；
- 历史工作群（`wg-` 前缀）首次读取列表时迁移为真实 Session。

若仍有问题，请提供 Console 里 `[ds-bot]` 开头的行。
