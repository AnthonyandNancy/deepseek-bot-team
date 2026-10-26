# 自动门禁结果（G4 水位）

- 日期：2026-10-22
- 环境：Windows，Node v26.7.0，`@deepseek-ai/*` 由 `npm run harness` 安装（DSH 0.2.1-rc.2）
- 原则：AI 不自评；不能自动判定的条目一律不进本表，放入 [`manual-checklist.md`](manual-checklist.md)
- 上一水位的 18 条仍全部通过，见文末「G3 水位」一节

## G4 门禁（判据先写死）

| # | 门禁 | 判定 | 结论 | 证据 |
|---|---|---|---|---|
| 1 | 两台真机实时群聊 | **只能人工** | **待人工（BLOCKED）** | 自动化替身：`hub/test/ws-events.test.js`（双账号真 socket 扇出）+ `ds-bot/test/workgroup-bridge.test.js`（两个 `createRuntime`、两个 `DSH_HOME`、同一 Hub）。替身**不等于**双机验收，见 `manual-checklist.md` G4-1 |
| 2 | 断网/重连/重放/乱序/重复 ACK | 可自动化 | **通过** | Hub 侧 `hub/test/ws-events.test.js` 23 项；插件侧 `ds-bot/test/workgroup-bridge.test.js` 10 项。见「门禁 2 证据」 |
| 3 | 本地群历史不自动上传 | 可自动化 | **通过** | Hub 侧 `hub/test/upgrade-no-history.test.js` 9 项；插件侧 `ds-bot/test/workgroup-upgrade.test.js` 中 3 项。见「门禁 3 证据」 |
| 4 | 升级失败重试不重复建群 | 可自动化 | **通过** | Hub 侧 `hub/test/upgrade-idempotent.test.js` 8 项；插件侧重放/并发/两处失败恢复 4 项。见「门禁 4 证据」 |
| 5 | 「插件」位置保持且「Bot」入口唯一 | 可自动化 + 人工目视 | **结构判定通过；目视待人工** | `ds-bot/test/workgroup-sidebar.test.js` 7 项。目视见 `manual-checklist.md` G4-5 |
| 6 | 工作群交互与原版对照无明显违和 | **只能人工** | **待人工（BLOCKED）** | 对照清单与步骤见 `manual-checklist.md` G4-6；**不写「无违和」** |

> 验收矩阵（§15）中与 G4 相关的 T08/T09/T10/T19/T20 逐条证据见 [`g4/EVIDENCE-MATRIX.md`](g4/EVIDENCE-MATRIX.md)。

## 门禁 2 证据（断网 / 重连 / 重放 / 乱序 / 重复 ACK）

全部走**真实 socket**，Hub 内部不 mock（`createHub` + 真端口 + 真 `fetch`/`WebSocket`）。

| 场景 | 断言 | 文件 |
|---|---|---|
| 双机实时 | A 发送 → B 收到**同一** `eventId` 与 `seq`；发送方**不**收到自己的回显 | `hub/test/ws-events.test.js` |
| 发送方伪造 | 帧里写 `sender.userId = B`，Hub 存的是连接的身份（A） | 同上 |
| 断线补投 | 离线期间两条 → 重连 `sync.request afterSeq=0` 得到 `[1,2]` | 同上 |
| 未 ack 重放 | 已投递未 ack → 新 socket 再拉仍在；ack 后从 `afterSeq=seq` 拉返回空 | 同上 |
| 重复 ACK | 同 `eventId` ack 两次 → `deliveries` 仍 1 行，`ack_at` 不变 | 同上 |
| 重放去重 | 同 `eventId` 重发 → `duplicate: true`、**seq 不变**、Hub 只 1 行、接收方只 1 条 | 同上 |
| 乱序/并发 | 两发送方各 5 条并发 → seq 恰为 1..10，无重无洞 | 同上 |
| 补洞 | 只落后中间一段 → 只返回缺失的两条 | 同上 |
| 分页 | `limit=2` 时 `hasMore: true`，跟游标取完 4 条不重不漏 | 同上 |
| 插件侧重连 | 断 socket → 发消息入队（`pending=1`）→ 重连补发，Hub 侧 1 条且 `eventId` 相同 | `ds-bot/test/workgroup-bridge.test.js` |
| 插件侧重启去重 | `bridge.reset()` 后重拉全部日志，本机日志行数**不变**（去重靠日志的 `hubEventId`，不是内存） | 同上 |
| 身份安全 | 握手 nonce 重放 → `4404`；撤销设备 → `4401` 且不再投递 | `hub/test/ws-events.test.js`、`ws-revoke.test.js` |
| 读游标 | 只前进不后退；同一人其它设备收到镜像，其他人收不到 | `hub/test/ws-events.test.js` |

## 门禁 3 证据（本地群历史不上传）

| 断言 | 值 | 文件 |
|---|---|---|
| 升级请求体**只有**三键 | `['name','notice','upgradeId']`（插件侧逐键断言，请求由 `fetch` 拦截捕获） | `workgroup-upgrade.test.js` |
| 请求体不含 | 群名以外的正文、本地文件名、本地 roomId、`log`、`messages` | 同上 |
| 本地日志仍在 | 升级后 `r1.log` 两条原样保留 | 同上 |
| Hub 侧事件数 | 升级后 `GET /v1/workgroups/:id/events` → `events: []`、`last_seq = 0` | 同上 + `upgrade-no-history.test.js` |
| 历史类键逐个被拒 | `messages/message/log/logs/history/transcript/transcripts/events/turns/rounds/conversation/conversations/body/content/text` 全部 400 `workgroup/history-not-accepted` | `upgrade-no-history.test.js` |
| 未知字段被拒 | `localRoomId/localPath/workDir` 等 400 `workgroup/unsupported-field` | 同上 |
| 群行没有路径列 | `workgroups` 表列名固定 10 个，无 path/cwd/work_dir | 同上 + `db-g4-schema.test.js` |
| 附件表没有路径列 | `attachments` 无 `path/local_path/file_path/absolute_path/cwd/work_dir` | `db-g4-schema.test.js` |

## 门禁 4 证据（升级失败重试不重复建群）

| 场景 | 结果 | 文件 |
|---|---|---|
| 同 `upgradeId` 串行 10 次 | 1 个群、1 条 membership、恰 1 次 `created: true` | `hub/test/upgrade-idempotent.test.js` |
| 同 `upgradeId` **并发** 10 次 | 1 个群、1 个 id、无 5xx（靠 `upgrade_id UNIQUE` 而非先查后写） | 同上 |
| 插件侧同群重试 10 次 | Hub 1 个群、本地 1 条 link、9 次 `alreadyUpgraded` | `ds-bot/test/workgroup-upgrade.test.js` |
| 插件侧并发 3 次 | 1 个群、1 条 link、同一 id | 同上 |
| 失败在 `PREPARING` | 停在 `PREPARING`（提示可安全重试），Hub 0 群；重试后 `created: true` | 同上 |
| 失败在 `HUB_CREATED` | 停在 `HUB_CREATED`（群已存在）；重试 `created: false`，仍 1 个群 | 同上 |
| 重试不改已建内容 | 第二次带不同名字 → 返回首次的群名 | `upgrade-idempotent.test.js` |
| 别人的 `upgradeId` | 409 `workgroup/upgrade-id-taken`，且未泄露群 id | `upgrade-no-history.test.js` |
| 空 `upgradeId` | 400，避免所有请求塌缩到同一个键 | `upgrade-idempotent.test.js` |

## 门禁 5 证据（侧栏结构）

| 断言 | 值 | 文件 |
|---|---|---|
| Bot 入口 order 严格在两者之间 | `PANEL_ORDER = 5`，`0 < 5 < 10` | `ds-bot/test/workgroup-sidebar.test.js` |
| 不占 `plugins` 的 id/order | `PANEL_ID = 'workgroup-bot' ≠ 'plugins'`；`5 ≠ 0` | 同上 |
| `sidebar.panellist` 注册次数 | 1（剥掉注释后计数：注释里引用的 DSH 示例不算） | 同上 |
| `main` 的 key | `PANEL_ID`、`WG_PANEL_KEY` 各 1 次且互不相同 | 同上 |
| 图标 | `BotPanelIcon` 恰好 2 处（1 定义 + 1 使用） | 同上 |
| 工作群面板无独立一级图标 | 无 `key: WG_PANEL_KEY` 的侧栏注册 | 同上 |

## G4 附带的其余自动门禁

| # | 门禁项 | 判定方式 | 结论 | 证据 |
|---|---|---|---|---|
| G4-A1 | Hub 数据模型 | 迁移 v3 建 9 张表；G5/G6 的 `round_leases/tasks/approvals/artifacts/group_memories` **不存在** | 通过 | `hub/test/db-g4-schema.test.js` 11 项 + `db-migrate.test.js` |
| G4-A2 | 群内序号唯一 | `(workgroup_id, seq)` UNIQUE；同群重复 seq 被拒；不同群可各自从 1 起 | 通过 | `db-g4-schema.test.js` |
| G4-A3 | `event_id` 唯一 | 重复插入被主键拒绝，行数不变 | 通过 | 同上 |
| G4-A4 | 成员唯一性 | 同一人/同一 endpoint 同群只能有一条 active | 通过 | 同上 |
| G4-A5 | 邀请防重 | 同群同人只允许一条 `pending`（partial unique index） | 通过 | 同上 |
| G4-A6 | 级联删除 | 删群 → events/memberships/deliveries 一并清除 | 通过 | 同上 |
| G4-A7 | Bot Endpoint 边界 | 只收 `localBotId/name/visibility/capabilities`；`workDir/cwd/path/root/sessionId/model` 全 400；能力集固定 `chat/files/tools` | 通过 | `hub/test/bot-endpoints.test.js` 12 项 |
| G4-A8 | 端点归属 | 别人的 endpoint 读作 404；`private` 对他人不可见；不能把别人的 Bot 拉进自己群 | 通过 | 同上 |
| G4-A9 | 附件往返 | 上传→票据→下载**字节完全一致**（sha256 比对） | 通过 | `hub/test/attachments.test.js` 15 项 |
| G4-A10 | 附件四道闸 | 大小（解码后 8 MiB）、扩展名+MIME 双检、ACL（离群即刻失效）、过期 sweep 删盘 | 通过 | 同上 |
| G4-A11 | 附件无路径 | 请求体传 `path` 被拒；显示名剥掉路径；`storage_key` 由 Hub 生成 | 通过 | 同上 + `db-g4-schema.test.js` |
| G4-A12 | 通道读写分离 | 新增读端点（`group-members`/`group-invites`/`upgrade-status`/`bridge-state`）在只读宿主可用，写端点被拒 | 通过 | `ds-bot/test/workgroup-g4-api.test.js` 8 项 |
| G4-A13 | 未完成声明移除且不回归 | `panel.js`/`i18n.js` 无「Not finished」渲染文案；由 `HubLine` 的实测状态取代 | 通过 | `workgroup-sidebar.test.js` |
| G4-A14 | 面板调用的端点都存在 | 面板每个 `callWorkgroup('x')` 在 `channel.js` 都有 `case 'x'` | 通过 | 同上 |
| G4-A15 | 中文文案完整 | `src/client/` **和** `src/workgroup/client/` 全部 `t('…')` 都在 `DICTIONARY.zh`（此前只扫前者，漏了 16 条） | 通过 | `ds-bot/test/i18n.test.js` |
| G4-A16 | 远程成员不建本地 Session | `sessionFor` 对非 `localBot` 返回 `undefined`，往返交给 bridge | 通过 | `ds-bot/test/workgroup-isolation.test.js` WG-10/WG-11 |
| G4-A17 | Hub 行落本地日志 | `receiveRemote` 把事件写进群日志（带 `via/hubEventId/hubSeq`），不产生成员 Session | 通过 | 同上 |
| G4-A18 | 本地群核心零改动 | `src/host/{groups,turns,delivery,resume,constants}.js` 与快照逐字节相同 | 通过 | `git status src/host/` 为空；见 `diff-manifest.md` |
| G4-A19 | 不修改 DSH | 无 `deepseek-harness` 补丁；只用插件接口与运行时自带的 `WebSocket` | 通过 | 代码审查 + 无新增依赖 |

## 构建与测试总和（G4 水位实测）

| 命令 | 结果 |
|---|---|
| `cd hub && npm test` | **190 pass / 0 fail**（G3 123 + G4 67） |
| `cd ds-bot && npm test` | **990 tests，989 pass / 1 skip / 0 fail**（G3 945 + G4 45） |
| `cd ds-bot && node scripts/build-client.mjs --check` | exit 0（`client.js` 与 `src/client/` 一致） |
| `cd ds-bot && npm run lint` | **0 error / 13 warning**（warning 数与 G3 基线相同） |

> 1 skip 是既有用例（Windows 上带空格的临时目录名），与 G4 无关。

## G4 修复轮：核对发现的产品级缺陷（2026-10-22，第 4 轮）

> 这一节记录一次自查：文档曾把「宿主端点已存在」写成「功能已接通」。以下 5 个缺陷全部由**运行时实测**确认，已修，并有防回归断言。详见 `g4/ROUND-LOG.md` 第 4 轮。

| # | 缺陷（修复前实测） | 结论 | 防回归证据 |
|---|---|---|---|
| F1 | Bridge 在生产代码里从未启动：登录后 `bridge.status() = {connected:false}` | **已修** | `workgroup-e2e.test.js`「signing in is enough」——全程不调用 `start()` |
| F2 | UI 建群不产生 Hub 群：`create-room` 的 `room.hub === null` | **已修** | `workgroup-e2e.test.js`「a message typed after signing in…」+ `workgroup-sidebar.test.js` 的 create-room 断言 |
| F3 | `wg.deliverRemote` 生产代码从未定义，远程成员回合被静默跳过 | **已修** | `workgroup-e2e.test.js`「a remote member's turn is sent to the Hub」 |
| F4 | 远端消息作者丢失（`who: "A member"`）；Hub 行会触发本地 relay 回环 | **已修** | `workgroup-e2e.test.js`「a line from another machine does not start a second round here」+ 名册断言 |
| F5 | 6 个端点无界面（邀请收件箱、附件下载、发布端点等） | **已修** | `workgroup-sidebar.test.js`「the G4 wiring that was missing is present」 |

**为什么原门禁没抓住**：15 处 `bridge.start()` 全在测试里，测试自己启动了 bridge。新增的 `workgroup-e2e.test.js` 规则是**只用 `apiHandle`**（客户端唯一的门），不碰 `bridge.start()`/`bridge.sync()`，所以它失败在用户会失败的那一步。

## G4 第二轮核对：补上仍在范围内、但产品路径缺失的两项（第 5 轮）

> 指令 §5 把「已读/未读游标」、§7 把「成员/邀请/在线状态」明文列入 G4，所以这两项缺失**不算人工豁免**。

| # | 缺口（修复前） | 结论 | 防回归证据 |
|---|---|---|---|
| G1 | 已读/未读游标无调用方：Hub 有表与帧、`bridge.markRead` 也在，但宿主无 `mark-read` 端点，面板不写也不显示 | **已修** | `workgroup-read.test.js` 3 项（清未读、只前进、按人隔离） |
| G2 | 逐成员在线状态不存在 | **已修** | `workgroup-read.test.js`「the Hub reports per-member presence」 |
| G3 | 顺带发现：**发送者看不到自己发的消息**（Hub 不回显 + 插件 ack 时不落本地日志） | **已修** | 同上第 1、3 项断言发送方本地日志有行 |

实测：`unread=2 → mark-read → unread=0`，Hub `read_cursors.last_read_seq=2`；两人在线 `online=2`，一方断桥后 `online=1`。

### 仍存在的限制（如实记录）

| 项 | 说明 |
|---|---|
| 人员显示名 | Hub `users` 表无 `display_name`，成员行只显示打码手机号；Bot endpoint 显示发布名。改动需加列（账号模型变更），属产品决策而非缺陷 |

## G5 门禁（2026-10-22）

方案 §14 的 G5 门禁 5 条 + 本阶段新增 3 条（N1–N3）。逐条结论与证据见
[`g5/EVIDENCE-MATRIX.md`](g5/EVIDENCE-MATRIX.md)。

| # | 门禁 | 出处 | 结论 |
|---|---|---|---|
| 1 | B 拒绝时 B 无模型/工具执行 | 方案 §14 | **通过（自动化）** |
| 2 | 批准后目标真实 Bot 在 B 本机运行 | 方案 §14 | **自动部分通过（补修轮后）；真机部分待人工** |
| 3 | 出单设备明确 | 方案 §14 | **通过（自动化）** |
| 4 | 伪造批准/过期/撤权/群外访问被拒 | 方案 §14 | **通过（自动化）** |
| 5 | 任务至少一次投递仍不重复执行副作用 | 方案 §14 | **通过（自动化）** |
| N1 | 撤销后新操作失败、可取消作业停止 | 方案 §10.1/§10.4 + T16 | **通过（自动化，guard 级）** |
| N2 | 「插件」位置保持且「Bot」入口唯一 | G4 门禁 5 不得回归 | **通过（自动化）** |
| N3 | G5 交互与原版对照无明显违和 | 方案 §15 T19 同类 | **待人工**（不写 PASS） |

### 补修轮（2026-10-22，G5 结论核对后）

对照实施书逐条核对 G5 时，发现三处"文档记 PASS、运行时不可用"。三处都已修，证据见 [`g5/EVIDENCE-MATRIX.md`](g5/EVIDENCE-MATRIX.md)。

| # | 缺陷 | 怎么发现的 | 修法 |
|---|---|---|---|
| 1 | `runTask` 零调用方：`task-start` 只调 `startTask`，任务能到 `RUNNING`、Hub 有 `task.started`，而 B 的 Bot **一个 token 都没跑** | 探针统计 `followup`/`prompt`：均为 0 | `task-start` 改调 `runTask`；`runTask` 不再自己拼消息，改为调用本域已有的 `wg.deliver` |
| 2 | `wg.deliver` 把 `role` 硬编码为 `'room'`，使它只能用于群回合——这正是缺陷 1 里"另写一份"的起因 | 与原版 `rt.deliver`（`src/host/delivery.js:48`）对比签名 | 给副本补回 `role` 参数（并让 `roomId/note/taskId/senderName` 可选），与原版同形 |
| 3 | `verifyBeforeRun` 的目录检查是死代码：`record.workDirRoot` **只读零赋值**，任何目录都通过 | `grep workDirRoot` 两处全在读取侧 | `cleanGrant` 白名单加 `workDir/workDirRoot`；`decide` 记录 `rt.real` 后的根；`verifyBeforeRun` 用 `rt.sessionFolder` 取 Session 真实目录，两侧都 `realpath` 后比较 |

**这一轮暴露的做事问题**：上一版把"结构存在"记成 PASS。三处都不是没写代码，而是写了却没接上，而证据矩阵只验证了函数本身。补修轮因此给每一条都加了**走产品路径的断言**（`task-start` → Session 收到投递；越界目录被拒；界内目录放行）。

新增/修改的测试（`ds-bot/test/workgroup-task.test.js`，+6 条）：

| 测试 | 钉住什么 |
|---|---|
| `starting a task delivers the approved request into its Session` | 投递恰好一次、落在 `record.sessionId`、正文是请求方原话、`role: 'task'` |
| `a request with nothing in it is refused rather than sent as an empty prompt` | `task/empty`，不投递，状态不前进 |
| `the approved folder is recorded as a real path, so the root exists to check against` | 授权记录确实带 `workDirRoot`（此前恒 `undefined`） |
| `a run whose Session works outside the approved folder is refused, never redirected` | Session 真实 cwd 越界 → `task/bad-workspace`，不投递，不回退团队目录 |
| `a run inside the approved folder is allowed` | 反向：不误拒 |
| `a task path outside the approved folder is refused, never redirected`（保留） | `checkInsideRoot` 纯函数四种情形 |

```
cd ds-bot && npm test          # 1024 tests, 1023 pass / 1 skip / 0 fail
cd ds-bot && npm run lint      # 0 error / 13 warning（与 G4 基线相同）
node scripts/build-client.mjs --check   # exit 0
cd hub && npm test             # 253 pass / 0 fail
git status --porcelain ds-bot/src/host/ # 空
```

### 群内 Bot 交接（2026-10-23）

用户报告「工作群的 Bot 不像原版那样相互流转，用着用着就没响应」。定位为 **G1 复制
缺口**（方案 §5.1 的 `host/handoffs.js` 从未复制），不是 G5 的跨用户委派。四处一并补上：

| # | 缺口 | 证据 |
|---|---|---|
| 1 | `workgroup/host/handoffs.js` 不存在，`reportRound` 却调 `rt.closeWork` | `the workgroup has its own hand-off ledger and the original never sees it` |
| 2 | `session/event` 漏 `role: 'post'`，成员发帖进不了 round | `a member post reaches the round as a member post, not as something the user said` |
| 3 | `turn/end` 无 waiter 就 `return`，round 放手的成员结果永不落地 | `a member that outlives its round slot still posts what its turn ended with` |
| 4 | 无 `post_to_group` 对应物，`sub` 没有产生者 | `a post with report_back opens work under the request it serves, and the round closes it` |
| 5 | `wg.live` 的 `info` 从未赋值 | 同上两条的 `role`/`askedBy` 路由 |

`test/workgroup-handoff.test.js` 5 条，全部走产品路径（真 `workgroup_post`、真
`workgroup_relay`、真 `session/event`）。变异三处各自被抓：停用 post 分支 → 3 条失败；
`reportRound` 不关工 → 2 条；停用 late 分支 → 1 条。

```
cd ds-bot && npm test          # 1077 tests, 1076 pass / 1 skip / 0 fail
cd ds-bot && npm run lint      # 0 error / 13 warning
node scripts/build-client.mjs --check   # exit 0
git status --porcelain ds-bot/src/host/ # 空
```

### 成员进出与群内发言上 Hub（2026-10-23）

用户报三条：「同事同意加入后只有他自己进来，管家 Bot 没跟着」「同事看不到群历史和实时消息」
「建群后再加的 Bot，管家调不动」。三条都属 **G4/G1 已交付部分**的缺口，不是 G5：

| # | 缺口 | 修在哪 | 证据 |
|---|---|---|---|
| 1 | `answerInvite` 只插 `member_type='user'`，被邀请人的 Bot 从不加入 | `bridge.joinWithPrimaryBot`，在 `accept` 之后、首次读名册之前 | `accepting an invitation adds the colleague and their Main Bot` |
| 2 | `addEndpointMember` 只有 admin 能调，刚加入的人（role `member`）连自己的 Bot 都加不了 | `hub/src/workgroups/service.js` 拆成「加自己的」与「加别人的」两条规则 | 同上 |
| 3 | 本机 Bot 的发言从未上 Hub，同事拉到的几乎只有人手打的字 | `groups.js` 的 `mirrorLine`，接在 `postInRound` 与 `postToGroupSession` | `a Bot answering in the group reaches the other machine` |
| 4 | 「添加成员」只传 id，成员记录没有 `kind`，回合按远程处理 | `groups.js` 的 `localMember` + Hub 名册同步 | `a Bot added to an existing group is a local member the round can call` |
| 5 | 名册刷新整体覆盖 `room.members` | 加 Bot 时同步到 Hub，Hub 拒绝则回滚本地 | `a roster refresh keeps a Bot that the Hub accepted` |
| 6 | `publishBotEndpoints` 早于 `rt.load()`／`wg.load()`：发布 0 个 Bot，且 `endpointBots` 被整体替换丢失 | 两处 `await load()` | 第 1、3 条用例在修复前均失败 |
| 7 | 移除成员只删本地，Hub 名册不动，下次 `applyRoster` 又读回来 | `groups.js` 的 `removeFromHub`，Hub 调用先行 | `a Bot removed from the group is removed on the Hub too` |
| 8 | `applyRoster` 的 `same` 只比 id/name/kind，`membershipId` 等字段的变化被判为无变化 | 比较扩到全部名册字段 | `replacing the member list removes the missing Bot on the Hub too` |
| 9 | **Hub 工作群里发消息根本不启动回合**：`send-hub` 只交给 Hub，`receiveRemote` 又刻意不写群 Session，两条规则叠加后没有任何成员被叫到 | `apply` 加 `mine`；本机消息经 `postToSession` 进群 Session | `a message typed into a Hub group starts a round the Bots answer` |

`test/workgroup-membership.test.js` 7 条，只走 `apiHandle`。变异各自被抓：停用接受后加入 →
2 条失败；去掉 `kind` 推断 → 1 条；停用镜像 → 1 条；停用 `removeFromHub` → 2 条；`same`
退回三个字段 → 2 条；停用 `mine` 分支 → 1 条（第 9 项，也就是「谁都没被叫到」）。

```
cd ds-bot && npm test    # 1080 tests, 1079 pass / 1 skip / 0 fail
cd hub && npm test       # 262 tests, 262 pass
```

### 工作群身份与邀请入口（2026-10-23）

用户实际使用时发现「工作群里没有邀请同事的入口」。核对出两个叠加缺陷：**原版群设置本来没有邀请同事**（原版的群是本机概念，没有第二个人可邀请），而我写的邀请控件所在的 `BotPanel` **没有任何导航入口**（`WG_PANEL_KEY` 全仓只出现在注册处）。同时确认方案 **§5.1** 早已要求把 `client/group-settings.js` 复制到工作群域、并把「邀请」列为改造重点——**这份复制件从未存在**。

| # | 结论 | 证据 |
|---|---|---|
| 1 | 未登录不再能建工作群，改为服务端拒绝 `hub/not-signed-in` | `a workgroup cannot be created while signed out: it would have no Hub identity` |
| 2 | 已登录建群即带 Hub 身份，邀请因此可行 | `a workgroup created while signed in carries its Hub identity` |
| 3 | 邀请可用手机号或 Hub 用户 ID | `a colleague can be invited by Hub user id as well as by phone` |
| 4 | 「邀请同事」固定在「添加成员」下方，不可用时禁用并说明原因 | `workgroup-invite.test.js` 6 条 |
| 5 | 工作群走复制件的群设置，本地群走原版 | `a workgroup gets the copy and a local group keeps the original` |
| 6 | 原版 `group-settings.js` 零改动 | 同上用例的 `the original must not learn about workgroups` |
| 7 | Hub 可在局域网明文绑定，但必须显式开启，且不再静默降级 | `tls.test.js` 四条 + 真实绑定断言 |

**推翻的既有决定**：G4 修复轮曾让未登录也能建「工作群」（`g4/ROUND-LOG.md:139`「未登录保持 G3 行为」）。产出的群既没有 Hub 身份也不是本地群，用户无法分辨，而「未登录本地可用」这条 G3 门禁由**本地群**保障即可，不必靠它。已按方案 §8.1 改回。

**补进 §5.2 B 类清单的文件**：`src/client/details-drawer.js`。改动只有一处三元（`room.workgroup === true` 时渲染复制件），原版 room 没有该字段，本地群路径逐字不变。

### G5 新增而未在方案里给定形状的东西（记在这里，不混进门禁）

| 项 | 为什么新增 |
|---|---|
| `GET /v1/tasks`、`GET /v1/tasks/:id` | 方案 §13.1 只给 `decision`/`revoke`。没有读端点，客户端只能折整条事件日志才能画任务面板 |
| `GET /v1/tasks/:id/artifacts` | 同上：产物的元数据列表 |
| `GET/POST /v1/workgroups/:id/lease`、`POST .../lease/release` | 方案 §9.5 只给语义（`coordinatorEpoch`/`leaseUntil`），没给路由。没有取得入口，围栏只能对着客户端自己编的值执行。**插件侧取得/释放走 socket**（`lease.acquire`/`lease.release`），因为轮次提交时就在连接上；HTTP 的两个写入口服务于非插件的客户端与运维 |
| WSS 帧：`task.request`、`task.report`、`task.progress`、`lease.acquire`、`lease.release`、`lease.check` | 方案 §9.3 列了事件类型，没列帧名 |
| WSS 回帧：`task.ok`、`task.reported`、`lease.ok`、`lease.released` | 同上 |
| `bridge.sendEvent({ frameType, payload })` | G4 只有 `send()`，且 `flush` 把 `type` 写死为 `chat.message` |
| 未读数从「游标差」改为「`chat.message` 条数」 | **行为变更**。任务事件占 `seq` 后，游标差会把审批和进度也算成未读 |

### 只做了一半、被主动去掉的东西

方向反过来也要防：**不能只有端点没有调用方**（G4 的坑），也不能只有调用方没有产品路径。本阶段有三处写完又删掉：

| 去掉的 | 为什么 |
|---|---|
| 频道端点 `task-progress` | 进度的唯一诚实来源是任务 Session 自己的工具调用（`session/event` → `tool/call`）。留一个「谁都能报告进度」的端点等于允许报告没发生过的进度 |
| 频道端点 `task-share` | `task-finish` 已经携带产物；单独的上传入口没有任何屏幕在用，是同一间屋子的第二扇门 |
| 频道端点 `group-lease-acquire` / `-release` | 轮次通过 socket 取租约（围栏要发生在提交那一刻）。面板只**读**租约（`group-lease`），所以写入的两个 HTTP 方法在插件侧没有调用方 |

`hub/src/...` 的租约 HTTP 写路由**保留**：它们服务于非插件的 Hub 客户端与运维，且 `hub/test/task-lease.test.js` 在用。

### 本阶段改动的既有测试（均属预期，非回归）

| 测试 | 为什么改 |
|---|---|
| `hub/test/db-migrate.test.js`「G4 表存在而 G5/G6 不存在」 | 阶段边界前移：断言 `tasks/approvals/round_leases/artifacts` 存在，`group_memories` 仍不存在 |
| `ds-bot/test/install.test.js` 注册顺序 | 任务 guard 在安装期注册，位置在 `effect ds-bot: workgroup state` 之后、relay section 之前 |
| `ds-bot/test/workgroup-ux.test.js` | 追加 4 条：审批卡真的被渲染、三种分配都在、范围在决策前可见、空卡片不渲染 |

## 复制基线核对（2026-10-22，G5 前）

用户要求「G5 前先确保原版代码和功能已复制迁移好」。逐函数对账结果：

| 核对项 | 结论 | 证据 |
|---|---|---|
| 原版 `host/groups.js` 的 17 个群函数 | **17/17 在工作群侧有对应**（11 同名 + 6 改名） | `g5/COPY-BASELINE.md` §2 |
| 原版 `host/turns.js` 的 13 个 `rt.*` 出口 | 9 个已用 `wg.*` 隔离；4 个（`turnsView`/`callDetail`/`stopRoomTurn`/`releaseBot`）跨域复用，**工作群自带 `stopRound`/`stopMemberWork`** | §3 |
| 原版 `host/constants.js` | 回合限制与日志上限已复制为 `WG_*` | §4 |
| 原版 `host/roster.js` 的群相关部分 | `createRoom`/`updateRoom`/`deleteRoom`/`retitleRoom`/`checkMembers` 已复制 | §5 |
| 原版 `src/host/` 是否被改动 | **零改动**（`git status` 与 `git diff` 均为空） | §7 |
| 结论 | **复制迁移已完成，G5 不需要先做这一步**；改造全部落在 `src/workgroup/` 内 | §7 |

## G3 水位的 18 条自动门禁（2026-10-22）

G4 未改动这些路径的产品行为，全部仍在通过；证据沿用 G3 记录，重跑总数见上表。

| # | 门禁项 | 结论 |
|---|---|---|
| 1 | 构建与生成物一致 | 通过 |
| 2 | 单元测试（ds-bot） | 通过 |
| 3 | Lint | 通过 |
| 4 | Hub 服务端测试 | 通过 |
| 5 | 双域隔离 | 通过 |
| 6 | 回合行为 | 通过 |
| 7 | 附件/图片/引用 | 通过 |
| 8 | 进度视图 | 通过 |
| 9 | 交互六约束 | 通过 |
| 10 | 凭据落盘 | 通过 |
| 11 | Hub 客户端 | 通过 |
| 12 | 未登录本地可用（源 G3 门禁 5） | 通过 |
| 13 | 换账号不残留 | 通过 |
| 14 | 本地群不回归 | 通过 |
| 15 | 路由分离 | 通过 |
| 16 | 不修改 DSH | 通过 |
| 17 | 工作群记忆面板 | 通过 |
| 18 | 诊断报告含工作群 | 通过 |

## 实机启动时发现并修复的问题（沿用 G3）

| 问题 | 现象 | 修复 |
|---|---|---|
| `ds-bot/package.json` 的 `files` 不含 `src/workgroup/` | 桌面端把 `ds-bot` 当包文件复制，运行时报 `the Workgroup domain is unavailable: Cannot find module './src/workgroup/index.js'` | 加入 `src/workgroup/`；G4 新增的 `host/bridge.js`、`host/upgrade.js` 在该目录下，无需再改 |

## 不适用的门禁

源方案 G3 的 3 条 OTP 门禁**不适用**：认证是手机号 + 密码，没有短信 OTP，代码里也不存在 `otp` 端点与表。G4 同样不引入 OTP，手机号**不写成已验证**（`phone_verified_at` 恒为 NULL）。

## 阻塞（不是通过）

| 项 | 状态 | 需要谁 |
|---|---|---|
| 门禁 1：两台真机实时群聊 | **待人工** | 维护者两台机器 + 一个可达 Hub |
| G5 门禁 2 的真机一半：执行确实发生在 B 的机器上 | **待人工** | 两台机器；A 的机器上不应出现该 Bot 的 Session |
| G5 N3：任务交互与原版对照无明显违和 | **待人工** | 按 `manual-checklist.md` G5-N3 |
| G5 T14：符号链接指向批准目录之外 | **待人工** | 需真实符号链接 + 一次真实 Session |
| 门禁 5 的目视部分：「插件」仍在顶部、Bot 只有一个 | **待人工** | 启动桌面端看一眼 |
| 门禁 6：交互与原版对照 | **待人工** | 维护者按 `manual-checklist.md` 步骤 |
| T20：Windows/macOS Electron 冷启动 | **待人工** | 需重装 `app/` 包文件后启动 |
| `dev/bench.sh smoke` | 阻塞（沿用 G3） | 需 `../deepseek-harness` checkout |

## G4/G5 修补轮（2026-10-25，按 `docs/superpowers/plans/2026-10-25-g4-g5-completion-repair.md`）

本轮修复的是**已交付范围里仍会丢失/重复的行为**，不是新阶段。工作群仍是原版群聊的复制件，
Hub 仍是唯一有序源；`src/host/` 仍是零改动。

| 任务 | 自动证据 | 结论 |
|---|---|---|
| Task 1 远端槽位跨协调者重启仍为开放义务 | `workgroup-realtime.test.js`「a remote slot survives a coordinator restart as an open obligation」`+「a remote call writes its exchange to disk before it can reach the Hub」 | 通过（自动化） |
| Task 2 恢复槽位由 Hub 答复继续，恰好一次、无 relay 副作用 | `workgroup-realtime.test.js`「a recovered waiting slot is continued by the matching Hub answer, once」；断言自动重连、1 行、`exchangeId`/`hubEventId`、slot posted、`deliverRemote === 0`、relay 执行 0 次 | 通过（自动化） |
| Task 3 设置按 `configVersion` 比较并拒绝旧快照 | `hub/test/workgroup-settings.test.js` 3 项；`workgroup-realtime.test.js`「an older settings snapshot cannot overwrite a newer room」 | 通过（自动化） |
| Task 4 已开始任务副作用只执行一次 | `workgroup-task.test.js`「starting the same approved task twice delivers it once」`+「a restart while RUNNING marks the task interrupted and never replays it」；Hub `task-approval.test.js`「a replayed RUNNING report is an idempotent acknowledgement」 | 通过（自动化） |
| Task 5 Stop 跨重启仍生效 | `workgroup-realtime.test.js`「stopping a round while a remote call is out keeps it stopped」`+「a stopped round stays stopped after a coordinator restart」 | 通过（自动化） |
| Task 6 全量测试确定性 | 连续 3 次 `test/feed.test.js` 5/5；`npm test` 1132 tests / 1131 pass / 0 fail / 1 skip / exit 0 | 通过（自动化） |

### 本轮仍为人工（BLOCKED，不写 PASS）

- G4-1：两台真机实时聊天、断网重连、附件哈希。
- G4-5：冷启动侧栏目视。
- G4-6：八项原版对照，每项截图。
- G4-T20：`npm ci` + `npm run pack` 后重装、冷启动。
- G5-T12：执行确实只发生在 B 的物理机器上。
- G5-N3：审批卡视觉对照。
- G5-T14：真实文件系统符号链接复现。

### 本轮最终自动门禁

| 命令 | 结果 |
|---|---|
| `cd hub && npm test` | **268 pass / 0 fail** |
| `cd ds-bot && npm test` | **1132 tests，1131 pass / 0 fail / 1 skip**（全量两次均 exit 0） |
| `cd ds-bot && node scripts/build-client.mjs --check` | exit 0 |
| `cd ds-bot && npm run lint` | 0 error / 13 warning（与基线相同） |
| `git diff --name-only ... -- ds-bot/src/host` | 空 |

---

## G6 自动门禁（2026-10-26，`feat/g6-group-memory`）— **已被 G6R 否决**

> **⚠️ 本节记录的是被否决的 G6 方案。** 它测的是自建 `group_memories` 存储、`memory-*` 端点与
> 独立 `MemoryCard` 的行为；这些都不应存在，因为原版 `memory.js` 已有群记忆。
> 下方“通过（自动）”只说明那套平行实现在自己的测试里自洽，**不表示 G6 门禁有效**。
> 现行门禁见本文末尾「G6R 群记忆跨机传输」。

> 历史数字保留在上文各节，不作为当前基线。G6 当时基线见本节与 `g6/EVIDENCE-MATRIX.md`。

| # | 门禁 | 判定 | 结论 | 证据 |
|---|---|---|---|---|
| G6-1 | V1 群记忆可用且与私人/团队记忆隔离 | 可自动化 | **通过（自动）** | `hub/test/group-memory.test.js` 的 ACL/跨群/搜索用例；`ds-bot/test/workgroup-memory-isolation.test.js` 的本地视图隔离与“投影非权威” |
| G6-2 | 断网重启不泄漏、不乱序、不误恢复 | 可自动化 | **通过（自动）** | `hub/test/group-memory.test.js` 的同库重开、离群后 404、重放幂等；`ws-events.test.js` 的 seq/重放既有证据 |
| G6-3 | 关键安全用例（非成员、ACL、旧版本、删除审计、凭据） | 可自动化 | **通过（自动）** | `hub/test/group-memory.test.js` 的 ACL、`version-conflict`、软删除审计、`credential-like`、`source-not-in-group` |
| G6-4 | 代码/测试/迁移/配置在两个目录内 | 结构审查 | **通过** | 改动均在 `hub/`、`ds-bot/`；无新一级目录/运行时依赖；迁移 v8 使用 `node:sqlite` FTS5 |
| G6-5 | 最终验收报告 | 文档 | **本文件 + `g6/EVIDENCE-MATRIX.md`** | 人工项标 BLOCKED，未自评 PASS |
| G6-M1 | 两台真机读同一群记忆，离群后不可读 | 只能人工 | **BLOCKED** | 步骤见 `manual-checklist.md` G6-M1 |

### G6 当前命令结果

| 命令 | 结果 |
|---|---|
| `cd hub && npm test` | **283 tests / 283 pass / 0 fail** |
| `cd ds-bot && npm test` | **1225 tests / 1224 pass / 1 skip / 0 fail / exit 0** |
| `cd ds-bot && node scripts/build-client.mjs --check` | exit 0 |
| `cd ds-bot && npm run lint` | 0 error / 13 warning |
| `git diff --name-only e71119b -- ds-bot/src/host` | 仅 `memory.js`（允许的回顾接缝）；冻结五文件为空 |

### G6 证据细节

| 断言 | 文件 |
|---|---|
| `group_memories` / `group_memory_events` / FTS trigram / 三触发器 / 群删除级联 | `hub/test/db-g6-schema.test.js` |
| 成员检查先于记忆读取；ACL 显式名单；创建者自动入 ACL；ACL 只能是活跃成员 | `hub/test/group-memory.test.js` |
| 旧版本修正 409 且不覆盖；删除软删、FTS 移出、审计保留 | 同上 |
| 重放同一创建幂等（200 + `duplicate: true`，行数 1） | 同上 |
| 同一 DB 文件重开后可检索；离群后 list/search 404 | 同上 |
| `memory.*` 四类型在封闭集、未读只认 `chat.message`；事件走既有 seq | `hub/test/ws-events.test.js`、`hub/test/group-memory.test.js` |
| 两 Runtime 创建/修正/删除经 WSS 传播并重读投影 | `ds-bot/test-realtime/workgroup-memory.test.js` |
| 五个 `apiHandle` 端点、缺版本拒绝、写后重读 | `ds-bot/test-realtime/workgroup-memory.test.js` |
| 成员 Session 回顾接缝；relay 不回顾；`isBotSession` 语义不变 | `ds-bot/test/workgroup-memory-review.test.js` |
| 删除工作群归档本地记忆 | 同上 |
| 设置表单五个动作走 `callWorkgroup`，写后重读，feed 触发重读 | `ds-bot/test/workgroup-ux.test.js` |
| 本地私人/团队记忆与群记忆视图隔离；投影持久化但不作权威 | `ds-bot/test/workgroup-memory-isolation.test.js` |

> 1 skip 是既有 Windows 临时目录用例，与 G6 无关。人工项保持 BLOCKED。

---

## G6R 群记忆跨机传输（2026-10-24）

- 状态：**未开工**。本节在实施完成后才填写自动化证据；现在只登记口径，不写 PASS。
- 现行计划：`docs/superpowers/plans/2026-10-24-g6r-copy-first-group-memory.md`
- 设计：`g6r/DESIGN-COPY-FIRST.md`
- 被否决的旧方案：`feat/g6-group-memory` 分支与 `docs/superpowers/plans/2026-10-26-g6-group-memory.md`

### 为什么重做

旧 G6 把“原版群记忆没有跨机传输”误判成“原版没有群记忆”，新建了 `group_memories` 表、
`memory-*` 端点和独立 `MemoryCard`。原版 `memory.js` 本身已有群作用域、成员校验、容量、回顾、
面板与归档；工作群缺的只是跨机传输。详见 `parity-audit.md` §1 与 `g6r/DESIGN-COPY-FIRST.md` §2。

### G6R 门禁（待实施）

| # | 门禁 | 判定方式 | 当前结论 |
|---|---|---|---|
| G6R-1 | 原版记忆引擎零行为变化 | `memory.test.js` 既有断言未改且全绿 | **未开工** |
| G6R-2 | 工作群成员 Session 能读群记忆段并被回顾 | `workgroup-memory-room.test.js` | **未开工** |
| G6R-3 | 群写入上报、私聊/团队/本地群不上报 | `workgroup-memory-sync.test.js` | **未开工** |
| G6R-4 | 远端变更走原版写入路径且幂等 | `workgroup-memory-sync.test.js` | **未开工** |
| G6R-5 | `memory.change` 扇出且不计未读 | `hub/test/ws-events.test.js` | **未开工** |
| G6R-6 | ack 不把记忆变更加工成聊天行 | `ds-bot/test/workgroup-bridge.test.js` | **未开工** |
| G6R-7 | 删除工作群归档原版记忆 | `workgroup-memory-sync.test.js` | **未开工** |
| G6R-8 | 两机真实传播、离群失效 | `test-realtime/workgroup-memory-sync.test.js` | **未开工** |
| G6-M1 | 两台真机、两个账号 | 只能人工 | **BLOCKED** |

> 本节不得在实施前填写“通过”。G6-M1 与 G4/G5 人工项一样，只有维护者能写 PASS。
