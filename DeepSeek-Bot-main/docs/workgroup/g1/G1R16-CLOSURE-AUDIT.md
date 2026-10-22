> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R16-CLOSURE-AUDIT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1 闭环审计（G1R16 · 收口）

日期：2026-10-21
范围：`Workgroup_AI_技术实施方案_2026-10-21.md` §14 的 G1 门禁，逐项对照代码、测试与真实运行。

**结论：G1 记 PASS。**

- `npm run verify`：build / check / test / lint 全过，**729 passed / 0 failed**，lint **0 error**。
- `client.js`：888846 B，sha256 `6ff117188486f08f…`，`check` 步确认与源码一致。
- 六处功能缺口已补，差异清单已重写并由测试守护。

---

## 1. 本轮补齐的六处缺口

上一轮（G1R15）以 `BotCode/DeepSeek-Bot-main.zip` 解压出的快照 为基线逐函数对照，核出复制版缺 6 处原版群功能。全部已按"复制而非重写"的方式补上：

| # | 缺口 | 原版位置 | 补齐方式 | 测试 |
|---|---|---|---|---|
| 1 | `read_own_chat` 工具缺失，而回合提示词一直在让成员调用它 | `src/host/groups.js:581` | 新增 `workgroup_read_own_chat`，经 `wg.sessionOwners` 解析成员，查自己的聊天并在群里留一条 `lookup` 行 | `a workgroup member can read its own chat…` / `a session that is not in a workgroup cannot use read_own_chat` |
| 2 | 回合内 inbox 语义丢失：用户在**最后一位发言人**期间补的话会另开一轮 | `src/host/groups.js:373, 390, 415` | 移植 `waitingLines`，`runRound` 循环条件补上 inbox 一半，`drainRoomInbox` 补 `@` 感知的 note 与 `lateRounds` 归零 | `a message typed during the last speaker stays in the same round` |
| 3 | `reportBack` / `reportRound` 整块缺失，发起的 Bot 永远收不到回传 | `src/host/groups.js:824` | 移植 `reportRound`；报告送到**发起者自己的会话**，走原版 `SOURCE_KIND` + `role:'report'` | `a round posted with report_back reports back to the Bot that posted it` |
| 4 | 附件与图片链路缺失：群里发文件/发图成员完全看不到 | `src/host/groups.js:117, 248, 509` | `roomPrompt` 返回 `{text, files}`；`roomTurn`/`wg.deliver` 带 `files`；relay 把图片读数与文件行写进日志；`send` 转发 `files`/`images` | `a file posted into a workgroup reaches the member…` / `a picture posted into a workgroup reaches the member as its reading` |
| 5 | `referenceNote` 缺失：用户引用的对话进不了成员提示词 | `src/host/groups.js:84, 242, 522` | 内联 `referenceNote`，relay 构造 `round.references`，prompt 对未看过的成员注入一次 | `a conversation the user referenced reaches the member in the round prompt` |
| 6 | 差异清单与代码不符 | — | 按逐字节 diff 重写；两条测试守护（改动文件必须登记 / 未改原版必须留证） | `the difference manifest names every file this fork changed` 等 2 条 |

**测试全部经过"修复前必失败"验证**：每条新用例都用 `git stash` 在修复前跑过，确认失败后再实现。

---

## 2. G1 门禁逐项

| 门禁项 | 状态 | 落点 | 证据 |
|---|---|---|---|
| 复制原版完整群子系统 | ✅ | `src/workgroup/host/groups.js` 1586 行（上游 877 行 + 补齐项），逐函数 COPY 标注 | `workgroup-round.test.js` 39 条 |
| 改为 `wg` 私有状态 | ✅ | `wg.sessionOwners / roomWaiters / roomProgress / roomInbox / live / tasks`，`.dsh/bot/workgroup/state.json` | `workgroup-isolation.test.js` |
| 消除重复 install / 监听 / 工具名 | ✅ | 二次安装抛错；工具名 `workgroup_relay` / `read_workgroup_chat` / `workgroup_read_own_chat`；路由 `/api/workgroup` | `install.test.js` 精确注册顺序 |
| 两个群列表 + 页面切换 | ✅ | 工作群是原版侧栏的一行（不新开分区）；唯一新入口是「插件」下方的一个「Bot」 | `workgroup-ux.test.js` |
| 两类群各自创建 | ✅ | `createWorkgroup` = 原版 `buildRoom`，id 即群自己的 Session | `a workgroup is a Session` |
| 改名 | ✅ | `updateWorkgroup({name})`，名字不要求唯一 | `names are labels…` |
| @ | ✅ | 复用 `shared/mentions.js` 同一解析器，`@all` 展开 | `@mention` / `@all` |
| 讨论 | ✅ | `runRound` 逐字移植：`limit`、每成员上限、`@Name` 扩容、`drainRoomInbox` | `a workgroup round runs…` |
| 进度 | ✅ | `roomProgress` + `speaking` + step 行 + 活动视图（图标/输入行/底部卡片） | `wg-activity.test.js` |
| Stop | ✅ | `stopRound` / `stopMemberWork`，晚到回复丢弃 | `stopping a round cancels…` / `one member can be stopped…` |
| 删除 | ✅ | `deleteWorkgroup`（归档 Session、释放在册归属） | `workgroup-isolation` / `groups` |
| 恢复 | ✅ | `resumeWorkgroup`、`adoptSession`（旧 `wg-` 群首次读列表时补建 Session） | `a legacy workgroup gets a Session…` |
| 本地群功能完全不回归 | ✅ | 原版 5 个关键文件**逐字节相同**：`host/groups.js`、`host/turns.js`、`host/resume.js`、`host/delivery.js`、`host/constants.js` | `diff` 无输出；原版群测试套件全绿 |
| Session 归属 / 消息 / Waiter 不串群 | ✅ | `resolveSessionOwnerStrict` 双声明直接抛错；`sessionOwners` 独立连接表 | `workgroup-isolation.test.js` |
| 热重载 / 关闭无重复监听 | ✅ | 二次 install 抛错；监听器挂在 `ctx.effect` 上随域卸载 | `install.test.js` |
| 准确保存差异清单 | ✅ | `docs/workgroup/g1/diff-manifest.md` 按逐字节 diff 重写 | 2 条守护测试 |

---

## 3. 一个必要的设计说明（跨域读取）

第 5 处缺口的前置问题（G1R15 已修）值得在此记下，因为它是本域**唯一**允许读取原版域数据的口子：

工作群成员会话既不是 Bot 自己的会话，也不是本地群会话，所以原版 `src/host/turns.js:352` 的事件监听会直接丢弃它 —— `rt.live` 里从来没有工作群成员。因此本域自建 `wg.live`，并**只在答案生成处**把三个只读视图（`activity` / `work.bots` / `work.rooms`）合并进原版 `live()` 的同一次状态应答。

替代方案是把成员会话塞进 `rt.groupOwners`，但那会让原版群聊模块开始操作本域的回合，正是 P0-3 禁止的跨域声明。合并点选择"读数"而非"索引"，所以原版行为不变（`host/channel.js` 的 `rt.activityView()` 等函数零改动，只在其结果上叠加本域视图）。

---

## 4. 剩余缺口（均不在 G1 门禁内）

| 项 | 归属 |
|---|---|
| `post_to_group` 不认识工作群 | G4（与 Bridge/独立 UI 一起做，避免再造一套工具名） |
| 本地群"升级为工作群"的完整幂等/归档语义 | G4 |
| 改管理员的 UI 入口 | G1 门禁外（`update-room` 支持 `adminId`，只是没有按钮） |
| 工作群群记忆 | G6 |
| 远程成员投递、两机实时 | G4 |
| 真机端到端验收 | 见下节 |

---

## 5. 需要人工验收的一步

插件是 `link:` 安装：**源码改动磁盘上立刻可见，但已加载的 ESM 模块不会热重载**。G1R15 那次 17:33 的失败已确认是进程仍跑着 17:26:21 启动的旧代码。

验收步骤：

1. **完全退出** DSH Desktop，确认所有 `DeepSeek Harness.exe` 都结束。
2. 重新启动，新建一个工作群。
3. 逐项对照：
   - 管理员先说第一句（kickoff）；
   - 输入 `@成员` 后出现「xxx 正在输入…」，回复进群；
   - 输入框上方出现成员活动卡片，头像有「思考中」动画；
   - 聊天中发一个文件、发一张图，成员能看到；
   - 群里点 Stop 能停住正在说话的成员；
   - 同时另开一个**本地群**，确认本地群一切照旧。
