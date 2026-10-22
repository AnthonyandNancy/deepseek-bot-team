> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g2/NEXT-INSTRUCTION.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# 下一条执行指令（G2）

> 用途：把下面「指令正文」整段复制，作为下一轮的启动指令。
> 方案原文：`Workgroup-AI/docs/plans/2026-10-22-workgroup-migration.md` §14 的 G2。
> 上一阶段状态：`docs/workgroup/g1/G1R16-CLOSURE-AUDIT.md`（G1 已 PASS）。

---

## 指令正文（复制以下全部内容）

```
继续本仓库工作，执行方案 §14 的 G2 门禁。先完整阅读：
  - Workgroup-AI/docs/plans/2026-10-22-workgroup-migration.md 的 §14 G2、§9（安全）、§6（Session 归属）
  - docs/workgroup/g1/G1R16-CLOSURE-AUDIT.md   （G1 已完成，门禁已 PASS）
  - docs/workgroup/g1/diff-manifest.md          （哪些文件动过、哪些逐字节未动）
  - docs/workgroup/DEV-CHECKLIST.md             （改完 client 源码必须重建 client.js）

## G2 门禁原文（判据只有这一段，不要自行加码也不要减码）

  **任务**：正式持久化 TaskSessionRegistry 与 resolveSessionOwnerStrict()，实测原生 Bot
  身份、prompt、模型/能力、Session Part、工作目录、权限与撤权。用本地审批模拟链路
  验证隔离 Session。
  **门禁**：原生 B Bot 真正执行，不靠复制提示词模拟；未授权工具拒绝；目录穿越、
  符号链接、run_code、MCP、群外 message_bot 旁路、撤权和恢复均有拒绝用例。
  **G2 未通过不得开展远程真实工具调用。**

## 已确认的事实（不要重复验证，不要推翻）

1. 仓库只有两个一级代码目录：hub/ 与 ds-bot/。**本任务不碰 hub/**（Hub 是 G3）。
2. ds-bot/ = Fei2411/DeepSeek-Bot ds-bot v0.1.7 完整 Fork
   （commit 939a6635830cb5b246e7dd19c67b0e1352ad1c07），原始快照在 `BotCode/DeepSeek-Bot-main.zip` 解压出的快照。
3. 测试基线：`npm run verify` = build/check/test/lint 全过，**729 passed / 0 failed**，lint 0 error。
4. 测试必须用 `node --import ./test/harness-resolve.mjs --test "test/*.test.js"`；
   裸 `node --test` 会 ERR_MODULE_NOT_FOUND。
5. `client.js` 是 esbuild 产物，改了 `src/client/**` 或 `src/workgroup/client/**` 必须 `npm run build`。
   **本任务的拒绝用例基本在主机侧，大概率不需要动 client**；若动了就必须重建并跑 `npm run check`。
6. 插件是按 `link:` 装的：源码改动磁盘可见，但已加载的 ESM 不热重载。
   任何"真机验证"结论都必须先完全退出 DSH Desktop（确认所有 `DeepSeek Harness.exe` 结束）再启动。
   —— 上一轮就是因为没重启，把旧代码的失败误判成"修复无效"，浪费了一整轮。
7. 原版 5 个关键文件当前与上游**逐字节相同**：`src/host/groups.js`、`host/turns.js`、
   `host/resume.js`、`host/delivery.js`、`host/constants.js`。
   本任务**允许**为安全而修改它们，但每改一处都必须在 diff-manifest 登记原因，
   并说明为什么不能在工作群域内解决。

## 本轮已核实的缺口（这是我读代码得到的结论，你要自己复验一遍再动手）

这几条不是猜测，是逐行对照 `BotCode/DeepSeek-Bot-main.zip` 解压出的快照 得到的。**先从 S1 开始**，它最严重。

### S1（P0，安全洞）：群外 message_bot 旁路在工作群里是敞开的

`src/host/tools.js:157` 用**原版**索引判断"这个 Session 是否在群里"：

    const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId)
    if (room !== undefined) return callInGroup(exec, room, sender, target, text.trim())

工作群成员 Session **从不写入 `rt.groupOwners`**（那是 P0-3 明令禁止的跨域声明，见
`src/workgroup/host/ownership.js` 的文件头）。所以 `room` 永远是 `undefined`，
上面那条"工作留在群里"的拒绝**对工作群成员完全不生效** —— 工作群成员可以
`message_bot` 到群里任意一个不在该群的 Bot，直接把工作带出群。这正是门禁点名的
"群外 message_bot 旁路"。

要求：用 `rt.resolveSessionOwnerStrict()` 做单点分流，工作群成员命中时走与
`callInGroup` 等价的拒绝/限定逻辑（成员不在群里 → refuse），并且**本地群行为逐字不变**。
拒绝用例必须有：工作群成员 message_bot 群外 Bot → 拒绝且无投递；
message_bot 群内成员 → 允许，和 `@Name` 一样。

### S2（P0）：工作群成员 Session 完全跳过了权限、模型、能力、简报的装配

原版 `groupSessionFor`（`src/host/groups.js:200-212`）在建立成员 Session 后做了 5 件事：

    rt.groupOwners.set(id, {...})
    delete room.seen[member.id]
    rt.desiredModel(member) → rt.selectSessionModel(id, splitRef(ref))
    rt.applyPermission(member, id, room)
    rt.ensureCapabilities(id)
    return { id, brief: await rt.ownChatBrief(member) }

复制版 `src/workgroup/host/groups.js` 的 `sessionFor()` 这 5 项**一个都没有**
（`grep applyPermission|desiredModel|selectSessionModel|ensureCapabilities|ownChatBrief` 在
该文件里全部为 0）。后果：

- 成员在群里的 Session **没有套用权限预设** → 门禁的"未授权工具拒绝"和"撤权"两条
  在工作群里根本无法成立（没有预设可依）。
- 成员 Session **没有按 Bot 的模型偏好选模型** → 与本地群行为不一致。
- 成员 Session **没有装能力/被禁用工具的收敛**（`hideBotUnusedTools` 依赖
  `rt.isBotSession`，工作群 Session 返回 false）→ 该被藏掉的工具在工作群里仍然可用。
- 新建会话**没有 brief**（`ownChatBrief`）→ 成员的上下文与本地群不同。

要求：把这 5 项按原版顺序补进 `sessionFor()`。

**这里有一个坑，你要先看清楚再动手**：`applyPermission` 的签名是

    async function applyPermission(bot, sessionId, room = roomOfSession(sessionId)) {
      const name = room?.permission ?? bot.permission

而 `roomOfSession = sessionId => rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)`
（`src/host/permissions.js:21, 30-32`）。对工作群成员 Session，`room` 恒为 `undefined`，
于是它**静默回落到 `bot.permission`** —— 也就是说即使你补上了这次调用，只要不显式把
**工作群的**权限预设传进去，工作群的群级权限就永远不会生效，而失败是无声的
（没有报错、没有日志）。

所以 `sessionFor()` 里必须显式传房间：`rt.applyPermission(member, sessionId, <工作群记录>)`，
把工作群记录适配成 `{ permission }` 的形状。这也意味着**先登记归属、再 applyPermission**
的顺序不只是"照抄原版"，而是因为要保证此时能取到房间。

**并且**：工作群记录目前**没有 `permission` 字段**（`grep permission src/workgroup/host/`
为 0），原版本地群记录是有的（`state.rooms[*].permission`）。所以 S2 实际上包含一个小设计：
  1. 给工作群记录加 `permission`（默认 `null`＝各成员用自己的预设，与原版同义）；
  2. `sessionFor()` 显式传进去；
  3. 如果门禁要求"群级预设"，再加一个设置入口——**但没有 UI 入口不算缺口**，
     门禁只要求"未授权工具拒绝"和"撤权"成立，S3 走的都是成员/群级预设的传播。
先做 1+2，够过门禁；3 视 S3 的用例需要再决定，并在报告里写清取舍。

### S3（P0）：撤权不传播到工作群 Session

`src/host/permissions.js:45-54` 的 `setPermission` 通过 `rt.groupSessionsOf(bot.id)` 遍历该
Bot 在所有群里的 Session 逐个改预设。`groupSessionsOf` 只认原版 `groupOwners`。
所以**用户改了某个 Bot 的权限，它在工作群里的 Session 不会跟着变** —— 门禁的"撤权"
在工作群上直接失效。

要求：让撤权同样覆盖工作群成员 Session。两条路，任选其一并在注释里说明理由：
  a) 工作群域提供自己的 `sessionsOfBot(botId)`，`setPermission` 单点调用两个来源；
  b) 在 `setPermission` 里通过 `rt.resolveSessionOwnerStrict` 分流。
拒绝用例：改 Bot 权限 → 它在工作群的成员 Session 预设同步变化；
撤销一个能力 → 工作群成员 Session 也失去该能力。

### S4（P1）：TaskSessionRegistry 完全没有

方案要求"正式持久化 TaskSessionRegistry"。现状：`src/workgroup/host/ownership.js` 里
`kind: 'task'` 这个**枚举值和校验存在**，但没有注册表、没有 API、没有落盘结构。

要求：新建 `src/workgroup/host/tasks.js`（或等价命名），提供
register / lookup / release / 按 owner 列出 / 从状态文件重建，走与 `sessionOwners`
**相同的** `wg.onStateLoaded` 重建机制（否则重启后会丢）。G2 只要求"能持久化 +
能严格解析 + 有拒绝用例"，**不要**在这里实现 Hub 路由或跨用户审批（那是 G4/G5）。

### S5（P1）：门禁点名的其余拒绝用例，逐个确认现状

按门禁原文逐条建用例，把现状写成"已拒绝/未拒绝"。已知的起点：

- 目录穿越、符号链接：看 `src/host/permissions.js` 与 DSH 侧的工作目录约束，
  确认工作群成员 Session 的工作目录与本地群一致，越界路径被拒。
- `run_code`：`src/host/turns.js:46` 的 `PROGRAM_TOOL`；确认工作群成员在 PTC 预设下
  只能经 `run_code` 调工具时，仍然不能绕过 S1/S3 的约束。
- MCP：`src/host/capabilities.js` + `tools.js` 的 `list_capabilities`；确认工作群成员
  不能调用未授权/未批准的 MCP 服务器。

## 执行顺序

S1 → S2 → S3 → S4 → S5。

S1/S2/S3 每条都是"先写失败测试 → 运行确认失败 → 实现 → 确认通过 → 提交"。
**S4 之前先把 S1-S3 做完**，因为 S4 的注册表要复用 S1 建立的分流函数。

## 纪律（不放松）

- 先复制/复用，再改造；不重写原版群业务逻辑。
- 一个原生 DS Bot Runtime；不重复安装、不注册同名工具。
- 工作群与本地群数据/Session/Waiter/记忆严格隔离；**不得**为了省事把工作群 Session
  写进 `rt.groupOwners`（这正是 S1 的成因）。
- 不新增第三个一级目录；不把工作群放进 DSH 一级侧栏。
- 不动 Hub 代码。
- 任何"完成"必须有真实命令输出。**拿不到证据就报 BLOCKED，不要写"应该可以"。**
- 每条安全用例都要做"修复前必失败"的验证（`git stash` 跑一遍），
  否则你不知道这条用例到底在测什么。上一轮每条新测试都是这么验的。
- 改了 `src/host/**` 的文件，必须在 `docs/workgroup/g1/diff-manifest.md` 追加登记
  （现有 §3"未修改的原版文件"里的条目要同步移出）。

## 收尾必须给出

1. `npm run verify` 的真实输出（build/check/test/lint 四行 + 总测试数）。
2. 一张表：门禁 7 条（原生 B Bot 真正执行、未授权工具拒绝、目录穿越、符号链接、
   run_code、MCP、群外 message_bot 旁路、撤权、恢复）逐条 → 用例名 → 通过/未通过。
3. 任何未通过项，必须写清是"未实现"还是"BLOCKED"，以及阻塞原因。
4. 更新 `docs/workgroup/g1/diff-manifest.md`。
5. 若 G2 未全绿，明确写"G2 不通过，不得进入 G3/G4 的远程真实工具调用"。

## 不要做的事

- 不要在 G2 就去做 Hub、OTP、设备绑定（G3）。
- 不要实现跨用户 Bot 委派与本人审批（G5）。
- 不要为了过用例而放宽断言或跳过测试。只变绿但规则失效，等于没通过。
- 不要在没有真实重启的情况下声称真机验证通过。
```

---

## 给指挥者的几句话

**为什么先做 S1**：它不是"缺功能"，是**已经存在的安全洞**。工作群成员现在能把活派给群里没有的 Bot，而这正是 G2 门禁点名要挡的那条。G1 期间它一直开着，因为 G1 只管功能闭环、不管安全。

**S2 和 S3 是同一个根因的两个面**：成员 Session 没有走原版的 5 步装配。少了 `applyPermission`，"未授权工具拒绝"和"撤权"在工作群里就没有基础——不是测不过，是根本没东西可测。所以 S2/S3 必须在写安全用例之前完成。

**S4 是有意做小的**：`TaskSessionRegistry` 只做持久化 + 严格解析 + 拒绝用例。真正的跨机任务在 G4/G5。提前做完会变成两套并发设计。

**验收时请重点看两件事**：一是每条拒绝用例是否真的在"修复前失败"（让他贴 `git stash` 的证据），二是 `src/host/groups.js` / `turns.js` 等原版文件如果被改了，diff-manifest 里有没有登记原因和"为什么不能在域内解决"。这两条是本仓库最容易滑过去的地方。
