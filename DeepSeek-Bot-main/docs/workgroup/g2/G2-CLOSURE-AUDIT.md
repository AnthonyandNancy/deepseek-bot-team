> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g2/G2-CLOSURE-AUDIT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G2 收口审计：原生 Bot Task Session 与工具级安全 P0

日期：2026-10-22
基线：`ds-bot@0.1.7` @ `939a6635830cb5b246e7dd19c67b0e1352ad1c07`（快照 `BotCode/DeepSeek-Bot-main.zip` 解压出的快照）

**结论：G2 = 有条件 PASS。**

- 门禁九条 + 三个子项中，**除 Session Part 外全部达成**（逐条见 §1，审批链路见 §1b）。
- **Session Part 明确未达成**（§5 注 E），是刻意保留的跨域边界：`parts.js` 全部按
  `rt.isBotSession` 分流，让本域回答该标志会让原版的回合监听接管本域回合（P0-3）。
  **归属 G4**，已有「一旦闭合就会失败」的测试钉住。
- 因此 G2 的判据应读作「G2 通过，Session Part 延后 G4」，而不是「全部完成」。

下一步：`docs/workgroup/g3/NEXT-INSTRUCTION.md`。

`npm run verify` 四步全过，**757 passed / 0 failed**，lint 0 error（13 条既有 warning）。G2 新增 **28 个测试**（`workgroup-messaging` 2、`workgroup-session-setup` 6、`workgroup-revocation` 4、`workgroup-tasks` 9、`workgroup-safety` 7），其中 **24 条在 G1 基线上会失败**——测量方法与被排除的 4 条见 §3。

> **本轮最重要的一件事**：上一轮交接文档里对 S1 的描述是**错的**，本轮用实测推翻了它。详见 §2。如果没有先跑探针，会去修一个不存在的洞，同时把真正的故障留在原地。

---

## 1. 门禁逐条对照

判据原文（方案 §14 G2）：

> **任务**：正式持久化 `TaskSessionRegistry` 与 `resolveSessionOwnerStrict()`，实测原生 Bot 身份、prompt、模型/能力、Session Part、工作目录、权限与撤权。用本地审批模拟链路验证隔离 Session。
> **门禁**：原生 B Bot 真正执行，不靠复制提示词模拟；未授权工具拒绝；目录穿越、符号链接、run_code、MCP、群外 message_bot 旁路、撤权和恢复均有拒绝用例。**G2 未通过不得开展远程真实工具调用。**

| # | 门禁项 | 用例 | 结果 |
|---|---|---|---|
| 1 | 原生 B Bot 真正执行，不靠复制提示词模拟 | G1 已证「成员回合走真实 Session、`llm/stream` 只为群自己的 Session 合成 relay」；G2 补证成员 Session 拿到自己的模型/权限/能力/简报/工作目录：`test/workgroup-session-setup.test.js` 全 8 条 | ✅ PASS |
| 2 | 未授权工具拒绝 | `workgroup-safety.test.js`「the tool restriction runs for a workgroup member exactly as for a local one」（在 `ctx.tools.schemas` 与 `agent.tools.restrict` 两处实测，不是推断） | ✅ PASS |
| 3 | 目录穿越 | `workgroup-safety.test.js`「cannot be given a folder by a path that climbs out」 | ✅ PASS（见 §5 注 A） |
| 4 | 符号链接 | `workgroup-safety.test.js`「a symlink is resolved to its real target before it is judged」 | ✅ PASS（见 §5 注 A） |
| 5 | `run_code` | `workgroup-safety.test.js`「run_code cannot smuggle a call past the Session rules」 | ✅ PASS（见 §5 注 A） |
| 6 | MCP | `workgroup-safety.test.js`「an unapproved stdio MCP server is never mounted into a workgroup member」，断言 `needs-approval` 出现在 `capabilityStatusesView()` —— 该状态只可能在**穿过**挂载闸门时写入，因此它证明路径真的跑过，而不是被跳过 | ✅ PASS |
| 7 | 群外 `message_bot` 旁路 | `workgroup-messaging.test.js` 2 条：群外 Bot 被拒且零投递；群内成员按 `@Name` 语义投进群 Session | ✅ PASS |
| 8 | 撤权 | `workgroup-revocation.test.js` 4 条：改预设到达成员 Session；成员 Session 归属其 Bot；无工作群时原版传播逐字不变；能力挂载能解析到 Bot | ✅ PASS |
| 9 | 恢复 | `workgroup-tasks.test.js`「the registry survives a restart, rebuilt from the state file」（重启后任务与 Session 归属同时重建）；G1 的 `resume` 用例覆盖回合恢复 | ✅ PASS |
| 9a | 身份 prompt（同一 Bot 只有一段身份） | `test/workgroup-prompt.test.js` 3 条：成员恰好一段身份（与本地群成员相同）、群自己的 Session 不被当成 Bot、Bot 被删除后仍有一段 | ✅ PASS（本轮发现并修复） |
| 9d | 本地审批模拟链路（隔离 Session 的审批由群回答，不落到隐藏卡片上） | `workgroup-safety.test.js`「an approval inside a workgroup member Session is answered by the group, not left waiting」：断言请求**没有**落到 `next()`、进了本域待答列表、归属到成员 Bot、可答，且 `yieldRoomTurn` 真的到达本域 | ✅ PASS（本轮发现并修复） |
| 9b | 工作目录（问哪儿都是同一个） | `workgroup-session-setup.test.js`「a workgroup member's working folder is its Bot's, wherever the folder is asked for」 | ✅ PASS |
| 9c | Session Part（分段/压缩/回合中换目录） | `workgroup-session-setup.test.js`「… NOT given the original Session-part machinery (known G2 gap)」 | ⚠️ **未达成，见 §5 注 E** |
| 10 | `TaskSessionRegistry` 正式持久化 | `workgroup-tasks.test.js` 9 条（含状态机、过期、拒绝） | ✅ PASS |
| 11 | `resolveSessionOwnerStrict()` | G1 已建；G2 把它提升为**工具边界**的唯一分流点（`src/host/tools.js` 的 `groupScopeOf`/`speakerOf`） | ✅ PASS |

---

## 1b. 复核（2026-10-22 第二轮）：门禁原文漏掉的一项已补

G1 之后的三轮修复（右键菜单、设置写入、Session 标题/归档）都动了 `src/`，因此**重新逐条对照门禁原文**，而不是沿用上一版结论。方法是：先跑全部六个 G2 套件（34 条，34 passed），再逐条读门禁原文找**没有用例覆盖**的句子。

找到一条：任务原文里的 **「用本地审批模拟链路验证隔离 Session」** 此前没有任何用例——最接近的只有 MCP 的 `needs-approval`，那测的是挂载闸门，不是审批链路。

实测确认它是**真缺陷**，不是缺测试：

- `src/host/approvals.js` 的 `approval/request` 钩子只认 `rt.groupOwners` 与 `rt.chatOwners` 两个**原版**索引；
- 工作群成员的 Session 归属记录在 `wg.sessionOwners`，两个原版索引里都没有；
- 于是 `botId === undefined` → `return next()`，请求交给 DSH 自己的卡片；
- 而工作群成员的 Session 是**隐藏**的，那张卡片没有地方绘制——**该回合就一直等下去**。

这正是 `approvals.js` 文件头注释要防的事（"A member's group Session is hidden, so DSH's approval card never shows there and the turn would wait forever"），只是它没考虑第二个域。

修法沿用 G2 的单点分流原则：`approvals.js` 改问 `rt.resolveSessionOwnerStrict()`，工作群身份由本域回答。同时 `rt.yieldRoomTurn` 也按域分流——它是"这个成员让出回合了"的信号，原版实现只走本地 waiter，工作群成员的 waiter 在本域，不接到这里本域回合永远不知道成员已让步。

新增用例 `test/workgroup-safety.test.js`「an approval inside a workgroup member Session is answered by the group, not left waiting」（该套件 7→8 条）。**验过修复前必失败**（回退 `approvals.js` 后 1 failed）。

### 1c. 「环境性抖动」这一条，本轮证实是我的判断错了

上一版 §4.2 把 `workgroup-round.test.js` 的 240 秒超时记成"资源争用，不是缺陷"。本轮做了对照实验：

| 条件 | 结果 |
|---|---|
| 未改动，连续 3 次全套 | 第 3 次复现：`a workgroup round runs…` 240440 ms 超时，788/789 |
| 改动后，连续 3 次全套 | 3 次全 789/789 |

根因是**测试自身的竞态**，不是环境：`sessionFor`（创建成员 Session）在 `roomWaiters.set`（挂上监听）**之前**执行，所以"Session 已存在"不等于"有人听着"。固定 `setTimeout(30)` 在两种窗口都可能结束得太早——Session 还没建，或建好了但 waiter 没挂上。后一种情况回答被丢弃，回合等到 `WG_REPLY_TIMEOUT_MS`（240 秒）。

改法是等 **waiter** 而不是等 Session，且用 `setImmediate` 轮询——此前两次用 `setTimeout` 轮询都死锁，因为定时器轮询会饿死回合自己的 promise 链；`setImmediate` 在 check 阶段让出，回合能继续推进。

其余 19 处固定 sleep 仍是同一隐患，但加固它们需要逐个看懂每个测试的时序意图，本轮只改了已证实会超时的那一处，其余保持原样并在此记录，不假装已全部解决。

---

## 2. 上一轮交接文档中被推翻的两条结论

交接文档要求"自己复验一遍再动手"。复验结果有两条与文档不符，两条都改变了做法：

### 2.1 S1 不是"旁路敞开"，而是"工具整个不可用"

文档说：工作群成员可以 `message_bot` 群里任意一个不在该群的 Bot，因为 `room` 恒为 `undefined`，`callInGroup` 的拒绝不生效。

实测（`.probe` 探针，两目标各跑一次）：

```
rt.selfOf(memberSession)      -> undefined
rt.isBotSession(memberSession) -> false
message_bot -> OUTSIDER Outsider : "Only Bots on the team can use message_bot."
message_bot -> IN-GROUP Editor   : "Only Bots on the team can use message_bot."
followups（两次都是）           : 0
```

`message_bot` 在到达 `callInGroup` 之前就由 `callerBot(exec)` 返回了：`callerBot` 走 `rt.selfOf`，而工作群成员 Session 不在 `chatOwners`/`groupOwners`/`pastOwners` 任一索引里。

因此真实故障是：**工作群成员谁都够不到**——既够不到自己群里的成员（原版对本地群成员是支持的），也（凑巧）够不到群外。把"够不到"当成"门禁已过"是错的：它是同一个根因（身份解析只认原版索引）的另一种表现，而且 `callInGroup` 里那条"工作留在群里"的拒绝逻辑，对工作群确实是**死代码**。

修法与文档要求一致（`resolveSessionOwnerStrict` 单点分流），但**动机**从"堵洞"变成了"补回身份 + 顺手让拒绝逻辑真正生效"。测试两条都对：群外拒绝、群内放行。

### 2.2 `applyPermission` 的静默回落，以及 `ensureCapabilities` 的空转

文档对 S2 的"坑"描述正确（默认参数走 `roomOfSession`，静默回落 `bot.permission`），实测确认。但文档没提、实测发现的更严重一条：

`capabilities.js:337` 原本是

```js
const botOfSession = sessionId => (rt.isBotSession(sessionId) ? rt.botOf(rt.selfOf(sessionId)) : undefined)
```

`isBotSession` 对工作群成员恒为 `false`，所以 `botOfSession` 恒为 `undefined`，`ensureCapabilities` 在第二行就 `return`——**一个能力都没挂载过**，无报错、无日志。

这条差点被漏掉：S2 我最初把 `ensureCapabilities` 打桩，测试只断言"被调用了"，于是**绿的测试盖在一个空转函数上**。补上真实断言（`rt.botOf(rt.selfOf(member))?.id === 'writer'`）后，该用例在撤销修复时会失败——这才是有效证据。

---

## 3. 五个改动与它们各自的守卫

**统一测量方法**：把 `src/` 下**全部 7 个** G2 改动文件回退到 G1 基线（`git checkout c04515b -- <file>`）、删掉 `tasks.js`，**保留所有 G2 测试**，逐个套件跑，记下仍通过的条数。这比逐个功能回退更严格，也更不容易高估。

| 套件 | 条数 | G1 基线上仍通过 | 随修复移动 |
|---|---|---|---|
| `workgroup-messaging` | 2 | 0 | **2/2** |
| `workgroup-session-setup` | 6 | 0 | **6/6** |
| `workgroup-revocation` | 4 | 1 | **3/4** |
| `workgroup-tasks` | 9 | 0 | **9/9** |
| `workgroup-safety` | 7 | 3 | **4/7** |
| **合计** | **28** | **4** | **24/28** |

那 4 条不移动的用例，都不是断言写松了，而是它们测的东西**在 G1 阶段就已经成立**：

| 用例 | 为什么不移动 |
|---|---|
| `a Bot's own chat and local group Sessions keep their exact propagation` | 它断言的是**原版行为不变**（无工作群时 `groupSessionsOf` 照旧）。回归守卫本来就该在基线上通过，否则它就不是回归守卫 |
| 相对路径被拒 / 受保护目录被拒 / 符号链接 realpath | 走 `cleanWorkDir` 的 `realpath`+`guarded`，这两个函数**与域无关**，同一份代码对两个域都生效 |

审计口径因此是 **24/28 随修复移动**，而不是"每条都失败了"。

复现这次测量（先备份 7 个改动文件与 `tasks.js`，测完再放回）：

```bash
cd ds-bot
for f in src/host/tools.js src/host/capabilities.js src/workgroup/host/ownership.js          src/workgroup/host/groups.js src/workgroup/host/channel.js          src/workgroup/host/state.js src/workgroup/index.js; do
  git checkout c04515b -- "$f"
done
rm -f src/workgroup/host/tasks.js
for f in workgroup-messaging workgroup-session-setup workgroup-revocation          workgroup-tasks workgroup-safety; do
  node --import ./test/harness-resolve.mjs --test "test/$f.test.js" 2>&1 | grep -E "^ℹ (pass|fail)"
done
git checkout HEAD -- src && git status --porcelain   # 必须回到干净
```

---

## 4. 时钟相关：两处已修的竞态，一处环境性抖动

### 4.1 已修的两处竞态

本轮 `npm run verify` 反复跑才发现

单独跑一次是绿的，连跑 6 次才暴露：

- `a task whose grant expired is not handed out`：用 `Date.now() - 1`，而 `expired` 是 `>=` 比较，同一毫秒内注册与查询谁先谁后都能翻转。改为整秒。
- `a group whose name is shared with another cannot have its admin changed`：断言两个自动命名的群**名字相同**，而自动名带**秒级**时间戳，跨秒创建就合法地不同。改为两者都给同名。

两条都只存在于测试里，不是产品缺陷。修完连跑 6 次 `npm run verify` 全绿。

### 4.2 一处**未修**的环境性抖动（如实记录）

本轮 `verify` 有过一次失败：`test/workgroup-round.test.js` 跑了 113 秒，报 `test failed`。单独跑同一个文件是 **39/39，2.2 秒**；紧接着两次完整 `verify` 都是 763/763 全绿。

原因是**资源争用，不是缺陷**：`verify` 用一次 `node --test` 跑全部 86 个测试文件，它会并行；而这个文件里有大量固定 `setTimeout(30/40ms)`（138 处）用来"等回合起来再回答"。CPU 被 86 个文件占满时这些等待不够长，于是超时而不是断言失败。另有 37 个文件同时建临时目录，加剧了压力。

**记录而不是默默容忍**，因为这两种情况从外面看一模一样：

| 现象 | 结论 |
|---|---|
| 单独跑该文件，快，全绿 | 正常 |
| 单独跑该文件，也慢或挂住 | **真缺陷**，要查 |
| 只有 `verify` 满载时才慢 | 就是这个抖动；重跑即可；若反复出现，应把固定 sleep 换成等待条件 |

**本轮没有修**：把 138 处固定 sleep 改成等待条件是一次独立改动，和行为修复混在同一个提交里会让两边都难审。已在 §5 记为待办（G4 前处理）。

### 4.3 已修：`workgroup-tasks.test.js` 的临时目录清理（Windows `EPERM`）

同一次复核还抓到一个**真会失败**的问题，不是抖动：`workgroup-tasks.test.js` 的 `t.after` 直接 `rmSync(home)`，而工作群状态写入队列此时还握着临时文件。Windows 上删除先于写入落地就是 `EPERM: operation not permitted, rm`，于是 `verify` 在 test 步直接失败。

`maxRetries: 5` 挡不住它——重试在写入完成**之前**就开始了。正确做法是**先 `ctx.dispose()`**（`wg` 的 effect 会 flush 写队列），再删目录。9 个用例统一改成共享的 `cleanup(ctx, home)`；重启那个用例自己管理两个 runtime，单独处理。

修完连跑 3 次 `npm run verify` 全绿（763/763）。

---

## 5. 未通过 / 需标注的项

### 注 A：S5 的 7 条里 4 条随修复移动，3 条不移动（如实标注）

`workgroup-safety.test.js` 的 7 条中，**3 条在 G1 基线上仍然通过**：相对路径、受保护目录、符号链接 realpath。原因不是断言太松，而是它们走的校验（`cleanWorkDir` 的 `realpath` + `guarded`）**本来就与域无关**，同一个函数对两个域都生效 —— 这三条在 G1 阶段就已经成立。

这 3 条保留为工作群路径的回归覆盖，但**不冒充**"修复前必失败"的证据。提供证据的是另外 4 条：成员 Session 解析到 Bot、工具收敛真的跑到、MCP 被挂载闸门拒、`run_code` 与 Session 作用域。

### 项 B：`post_to_group` 不认识工作群 — **BLOCKED，归属 G4**

原版 `src/host/tools.js` 的 `post_to_group` 仍只认本地群。让工作群域注册自己的发帖工具会违反"不重复工具名"（P0-2），应与 Bridge 和独立 UI 一起做。G2 门禁未点名此项。

### 项 C：真机验证未做 — **BLOCKED（需要一次完整重启 + 真实 API key）**

G2 的"原生 B Bot 真正执行"在**单元层**已证（真实 Session、真实模型选择、真实能力挂载路径）。但"真机跑一轮、凭证引擎真的调用模型"需要：

1. 完全退出 DSH Desktop（`ps -W` 确认没有 `DeepSeek Harness.exe`）；
2. 启动后在工作群里 `@` 一个成员；
3. 观察成员回复、底部思考卡片、Stop。

本轮**没有**执行这一步，因此**不声称真机通过**。这正是上一轮踩过的坑：插件按 `link:` 装，源码改了但已加载的 ESM 不热重载，不重启看到的失败是旧代码。上一轮已把它写成纪律，本轮继续遵守。

### 注 E：Session Part（分段 / 压缩 / 回合中换目录）在工作群成员上未达成 — **G2 未满足的一份项**

门禁原文点名要实测「Session Part」。实测结论：**工作群成员 Session 拿不到原版的 part 机制**，因为 `src/host/parts.js` 的每一个 part 决策都以 `rt.isBotSession` 为闸门，而本域**刻意**不为自己的 Session 应答该标志：

- 同一个标志也是 `src/host/turns.js:352` 的过滤器，应答它会让原版的 turn 机制开始管理本域的回合 —— P0-3 明令禁止，而且正是这个坑在 G1 期间让每个成员回合变成空消息；
- `parts.js` 换新分段时经 `room.sessions[botId]` / `bot.segments` 回写，那是**原版记录形状**，本域不用也不该用。

所以一个很长的成员 Session 目前**不会**轮转成新分段，也不会产出 checkpoint 摘要。这是真实缺口，不是"看着像"。

**为什么不就地补**：要正确地做，需要把 part 机制按域抽象（本域自己的 `sessionFor`/分段记录/交接包），也就是给工作群域再实现一套 part 生命周期。那是独立工作量，塞进 G2 会变成第二套并发设计——与方案 §10 分阶段的本意相反。

**建议归属**：G4（工作群独立 UI 与轮次调度一起做），或单独开一项。已用 `workgroup-session-setup.test.js` 的「… NOT given the original Session-part machinery (known G2 gap)」把它**固定为失败可见**：将来补上时这条会红，提醒同时更新审计。

**这一项不影响 G2 其余判据**，但按"没有证据就不算通过"的规矩，它是 G2 里唯一一个**明确未达成**的份项，必须写在这里而不是含糊带过。

### 项 F：`workgroup-round.test.js` 的 138 处固定 sleep — 待办，G4 前处理

见 §4.2。它只在 `verify` 满载时暴露，不影响任何结论，但会让 `verify` 偶尔变红、浪费一次排查。其他套件用的是"等到条件成立"的写法（`waitFor` 轮询），这个文件还是固定毫秒。

**建议**：单独一个提交，只改这一件事。

### 项 D：`TaskSessionRegistry` 的 Hub 侧未做 — 按方案本就不属 G2

方案 §10 的 Hub 路由、签名、跨用户审批、审批 UI 属 G4/G5。G2 只做本地持久化那一半，且在 `tasks.js` 文件头写明。提前做会造出第二套并发设计。

---

## 6. 复现命令

```bash
cd ds-bot
npm run verify                                   # build / check / test / lint

# 本次新增的五个套件
node --import ./test/harness-resolve.mjs --test "test/workgroup-messaging.test.js"
node --import ./test/harness-resolve.mjs --test "test/workgroup-session-setup.test.js"
node --import ./test/harness-resolve.mjs --test "test/workgroup-revocation.test.js"
node --import ./test/harness-resolve.mjs --test "test/workgroup-tasks.test.js"
node --import ./test/harness-resolve.mjs --test "test/workgroup-safety.test.js"

# 差异复核（manifest §头部）
cd .. && for f in $(cd ds-bot/src && find . -name '*.js'); do
  [ -f "$SNAPSHOTsrc/$f" ] && ! diff -q "ds-bot/src/$f" "$SNAPSHOTsrc/$f" >/dev/null && echo "MOD $f"
done
```

---

## 7. G2 结论

**G2 通过**，但**不是每一项都满**。逐条说清楚：

- 门禁点名的 **9 类拒绝用例全部存在且有真实断言**（撤权、恢复、群外 `message_bot`、目录穿越、符号链接、`run_code`、MCP、未授权工具、原生执行）；
- `TaskSessionRegistry` 与 `resolveSessionOwnerStrict()` 均已持久化并有重启重建用例；
- **唯一未达成的份项是「Session Part」**（§5 注 E）：工作群成员拿不到原版的分段/压缩机制，因为该机制以 `isBotSession` 为闸门，而本域为守住 P0-3 刻意不应答它。已固定为一条会失败的测试，归属 G4。

**可以进入 G3（Hub 认证、设备与演示节点）。**

**在项 C 的真机验证完成前，仍不得开展远程真实工具调用**——这是方案 G2 门禁最后一句的原文要求，本轮没有任何改动足以取消它。
