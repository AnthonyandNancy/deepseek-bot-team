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
