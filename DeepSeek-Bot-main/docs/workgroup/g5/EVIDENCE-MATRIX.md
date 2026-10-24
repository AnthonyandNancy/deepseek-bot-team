# G5 验收矩阵证据（§15 的 T11–T17 + 本阶段门禁）

- 日期：2026-10-22
- 环境：Windows 11，Node v26.7.0，DSH `0.2.1-rc.2`，`ds-bot@0.2.0`（未改版本号，未发版），Hub 在同一工作副本
- 证据口径：**自动化结论不等于双机验收**。凡是自动化跑的，都写明跑的是哪个文件、哪条断言；凡是只能人工的，写 **BLOCKED** 并给出步骤。
- 两个测试套件都必须绿才算本表成立：`cd hub && npm test`（**253 pass / 0 fail**）、`cd ds-bot && npm test`（**1024 tests，1023 pass / 1 skip / 0 fail**）。

| 编号 | 场景 | 结论 | 证据 |
|---|---|---|---|
| T11 | A 请求 B，B 未批准 | **通过（自动化）** | 见下 |
| T12 | B 批准三种派单模式 | **自动部分通过；真机部分 BLOCKED** | 见下 |
| T13 | 修改 `senderId`/伪造批准 | **通过（自动化）** | 见下 |
| T14 | 路径穿越/符号链接/非法 cwd | **通过（补修轮后）** | 见下 |
| T15 | `run_code`/MCP/群外 `message_bot` 绕过 | **通过（自动化，接缝级）** | 见下 |
| T16 | 执行中撤权/取消 | **通过（自动化）** | 见下 |
| T17 | 任务副作用后 ACK 丢失 | **通过（自动化）** | 见下 |
| N1 | 撤销后新操作失败、可取消作业停止 | **通过（自动化，guard 级）** | 见下 |
| N2 | 「插件」位置保持且「Bot」入口唯一 | **通过（自动化）** | `ds-bot/test/workgroup-sidebar.test.js` 仍绿 |
| N3 | G5 交互与原版对照无明显违和 | **BLOCKED（只能人工）** | `manual-checklist.md` G5-N3 |

---

## T11 A 请求 B，B 未批准，B 不执行任何任务工具

| 步骤 | 期待 | 实际（自动化） | 结论 |
|---|---|---|---|
| A 发 `task.request`，B 在线 | B 出现审批卡，状态 `PENDING_APPROVAL` | `ds-bot/test/workgroup-task.test.js` → `a request becomes an approval card and nothing else runs`：断言 `card.state === 'PENDING_APPROVAL'`、`card.title` 与请求一致 | PASS |
| 同上 | B 本地无 task 记录、无 Session 归属 | 同一用例断言 `wg.taskOf(taskId) === undefined`、`wg.liveTask(taskId) === undefined`、`sessionOwners.has(taskId) === false` | PASS |
| 同上 | Hub 无 `task.started` | 同一用例读 `hub.events({workgroupId})`，断言无 `task.started`、有 `task.request` | PASS |
| B 拒绝 | 本地仍无记录；再调 `task-start` 被拒 | `a rejection ends the task, and nothing runs on B machine`：`started.error.code === 'task/not-approved'` | PASS |
| B 拒绝 | Hub 记录 `REJECTED`，仍无 `task.started`/`task.completed` | 同一用例断言 `remote.state === 'REJECTED'` 与两个事件都不存在 | PASS |
| B 拒绝后再批准 | 409 `task/not-awaiting-decision` 或 `task/already-finished` | `hub/test/task-approval.test.js` → `B refusing ends the task…`：断言 409 与错误码正则 | PASS |
| 拒绝后 B 的机器上报 `RUNNING` | 拒绝帧 | 同一用例：`task.report` 回 `error`，码匹配 `task/(already-finished|transition-refused)` | PASS |

**为什么这构成门禁 1 的一部分**：插件侧证明"没建 Session、没记台账"；Hub 侧证明"日志里没有 started"。两侧合起来才是"B 没跑东西"，任一侧单独都不够。

---

## T12 B 批准三种派单模式，执行 B 的真实目标 Bot

| 步骤 | 期待 | 实际（自动化） | 结论 |
|---|---|---|---|
| `mode: 'existingBot'` | 台账写下 B 指定的 Bot、B 的 Hub 用户、B 的设备；Session 归属 `kind: 'task'` | `approving registers a real Bot locally, on B own device, and the Hub records both`：逐项断言，含 `rt.botOf(record.botId).name === 'Writer'` | PASS |
| 同上 | Hub 的 `approvals.approved_device_id` 是 B 的设备，且 ≠ A 的设备 | 同一用例断言 `approvedDeviceId === b.account.deviceId` 且 `!== a.account.deviceId` | PASS |
| `mode: 'chiefPicks'` | 由一个真实存在的本地 Bot 承接 | `the three assignment modes each name the Bot that ran` 三种模式循环，断言 `rt.botOf(record.botId) !== undefined` | PASS |
| `mode: 'newBot'` | 新建 Bot，且用**任务自己的** Session（不是新 Bot 的私聊 Session） | 同一用例；实现见 `task-runner.js` `assign()` 的 `newBot` 分支：`registerSessionOwner` 会拒绝原版域已持有的 Session，所以必须另建 | PASS |
| 批准后开始 | 台账 `RUNNING`，Hub `RUNNING`，日志出现 `task.started`，发送方是 B | `an approved task starts, reports to the Hub, and the Hub shows it running` | PASS |
| 批准后开始**确实把活交给 Bot** | 任务 Session 收到恰好一次投递，内容是请求方原话，来源标记为 `role: 'task'` | `starting a task delivers the approved request into its Session`：断言 `__delivered.length === 1`、`sessionId === record.sessionId`、正文含标题、source 的 role | PASS（补修轮新增） |
| 空请求不得开始 | 以 `task/empty` 拒绝，不投递，状态不前进 | `a request with nothing in it is refused rather than sent as an empty prompt` | PASS（补修轮新增） |
| 执行前验证 | 身份/cwd/工具/Guard 四项都过才跑 | 实现见 `verifyBeforeRun()`；拒绝路径由 T14 的用例覆盖 | PASS（结构） |

### 必须人工的部分（BLOCKED）

- "批准后目标真实 Bot 在 B 本机运行"的**真机**一半：需要两台机器，确认执行发生在 B 的机器上、B 的模型账单上。
- 步骤：`manual-checklist.md` G5-T12。判据：B 的机器上出现该 Bot 的 Session 记录与被调用的工具；A 的机器上没有。

---

## T13 修改 `senderId` / 伪造批准 / 过期 / 撤权 / 群外访问

| 步骤 | 期待 | 实际（自动化） | 结论 |
|---|---|---|---|
| 改 payload 后重放原签名 | 拒绝 | `hub/test/task-envelope.test.js` → `the payload cannot be changed after signing`：`task/bad-signature` 或 `task/payload-hash-mismatch`，且 `tasks.count === 0` | PASS |
| 改 `target` 后重放原签名 | 拒绝 | `the target cannot be changed after signing`：`task/bad-signature` | PASS |
| 改 `expiresAt` 后重放原签名 | 拒绝 | `the lifetime cannot be extended after signing`：`task/bad-signature` | PASS |
| 帧里写别人的 `sender` | 拒绝，且先于签名校验 | `a frame claiming somebody else as the sender…`：`task/sender-mismatch` | PASS |
| 无签名字段 | 拒绝 | `an unsigned request is refused`：`task/unsigned` | PASS |
| 旧信封重放（超出时间窗） | 拒绝 | `a replay of an old envelope is refused on its own timestamp` | PASS |
| 未来时间的信封 | 拒绝 | `an envelope dated in the future is refused…`：`task/envelope-from-future` | PASS |
| 协议版本不符 | 拒绝 | `an envelope for an older protocol version is refused` | PASS |
| A 替 B 批准 | 404（不是 403，避免探测） | `hub/test/task-approval.test.js` → `only the person the task is for may approve it` | PASS |
| 同群第三人批准 | 404 | 同一用例 | PASS |
| 群外成员发起任务 | `workgroup/not-found` | `task-envelope.test.js` → `a non-member cannot request a task in a group at all` | PASS |
| 目标不在群里 | `task/target-not-in-group` | `a task cannot be requested for somebody outside the group` | PASS |
| 请求过期的任务 | 409 `task/expired`，状态转 `EXPIRED`，不写 approval | `an expired request cannot be approved, and is recorded as expired` | PASS |
| 已撤权的任务再启动 | 拒绝 | `revoking stops the task, withdraws the grant, and refuses a later start` | PASS |
| 插件与 Hub 的规范化签名一致 | 逐字节相同 | `ds-bot/test/workgroup-task-envelope.test.js` → 三份对照 + 「插件签、Hub 验」互操作断言 | PASS |

**这一项里发现并修掉的真实缺陷**：`signedFields` 原本优先读信封里声明的 `payloadHash`，于是"签名后改 payload、保留原 hash"仍能通过验签。改成始终按当前 payload 计算后，两边的对照测试与「改 payload 验签失败」才成立。

---

## T14 路径穿越 / 符号链接 / 非法 cwd

| 步骤 | 期待 | 实际（自动化） | 结论 |
|---|---|---|---|
| cwd 指向批准目录之外（含 `..`、绝对路径、以及只是名字前缀相同的兄弟目录） | 拒绝，**不回退到团队目录** | `a task path outside the approved folder is refused, never redirected`：`checkInsideRoot()` 四种情形逐条断言 | PASS（纯函数） |
| **批准目录真的被记下来并被校验** | 授权记录带 `workDirRoot`（realpath 后），`verifyBeforeRun` 用它比对 Session 实际目录 | `the approved folder is recorded as a real path, so the root exists to check against` + `a run whose Session works outside the approved folder is refused, never redirected` | PASS（补修轮新增） |
| 反向：批准的目录内允许运行 | 不误拒 | `a run inside the approved folder is allowed`：断言投递 1 次、状态 RUNNING | PASS（补修轮新增） |
| 未获批的 Bot | `task/bad-bot`，任务转 `FAILED` 并把原因回传 Hub | 实现路径：`verifyBeforeRun()` 返回 `task/bad-bot`，`startTask` 在失败时调 `reportToHub({next:'FAILED'})` 后抛错 | 实现已核，**无独立断言** |
| 符号链接指向目录外 | 拒绝 | 两侧都先 `rt.real` 解析再比较，因此按真实指向判断；由 `a run whose Session works outside…` 覆盖（该用例用 `rt.sessionFolder` 报告的真实 cwd 触发同一条判定） | PASS（补修轮，判定层） |
| 运行时的 Guard 缺失 | 不运行 | `verifyBeforeRun()` 返回 `task/no-guard`，`startTask` 抛错且不上报 `RUNNING` | PASS |

### 补修轮：符号链接从 BLOCKED 变为通过

初版本表把符号链接记为 BLOCKED，理由是"补 `realpath` 需要一次真实 Session 才能证明真的解析了"。补修轮把这一步做了，所以它不再是被阻塞的：

- `decide` 在写授权记录前对批准目录做 `rt.real`（原版 `src/host/folders.js:28` 的 helper，与插件其余部分同一实现），记录里的 `workDirRoot` 因此是规范路径；
- `verifyBeforeRun` 对"这次实际要用的目录"同样先 `rt.real` 再比较，而那个目录来自 `rt.sessionFolder`——DSH 报告的该 Session 真实工作目录，不是调用方顺手传进来的字符串；
- 触发点用 `agent.session.header = { cwd: outside }` 构造，走的是 `runTask → startTask → verifyBeforeRun` 的真实链路。

仍未自动覆盖的只有一件事：在真实文件系统上**创建**一个符号链接、让 DSH 把一个真实 Session 办到那里。判定逻辑已经证明按解析后的路径工作，剩下的是同一逻辑在真机上的复现，步骤保留在 `manual-checklist.md` G5-T14。

---

## T15 `run_code` / MCP / 群外 `message_bot` 绕过

| 步骤 | 期待 | 实际（自动化） | 结论 |
|---|---|---|---|
| 任务 Session 调 `read_own_chat` | 拒绝 | `workgroup-task.test.js` → `a task may never use the tools that would reach past its scope`：逐个断言拒绝文案 | PASS |
| 调 `message_bot`（群外派单旁路） | 拒绝 | 同一用例（`DENIED_TOOLS` 含 `message_bot`） | PASS |
| 调 `create_bot`/`update_bot`/`delete_bot` | 拒绝 | 同一用例 | PASS |
| 批准范围外的工具 | 拒绝 | `a live task may use a tool its approval covered, and not one it did not`：`read_file` 放行、`write_file` 拒绝 | PASS |
| 批准范围内的工具 | 放行 | 同一用例前半段 | PASS |
| 非任务 Session（本地群、Bot 私聊） | 不受影响 | `a task Session is not confused with a local group or a Bot chat`：非任务 Session 调用原版也会拒绝的 `read_own_chat` 时，本 guard 返回 `undefined` | PASS |
| `run_code` 子调用 | 拒绝 | **接缝级**：`ctx.tools.guard` 是原版 `src/host/tools.js:745` 的那个 seam，DSH 对 PTC/`run_code` 的每次实际工具调用都会走它。没有为它另建一条路径 | PASS（接缝级） |
| MCP 转发 | 同 `run_code` | 同上：MCP 工具的每次调用同样经过 `tools/execute` | PASS（接缝级） |

**口径说明**：这一项证明的是"边界存在且按批准范围拒绝"。真实 `run_code` 内触发一次工具调用、真实 MCP server 的往返，需要真机与一次真实模型回合，归入 N3 的人工清单。

---

## T16 执行中撤权 / 取消

| 步骤 | 期待 | 实际（自动化） | 结论 |
|---|---|---|---|
| 运行中取消 | 台账离开 `RUNNING`，`liveTask` 为 `undefined` | `revoking stops the next tool call, which is gate N1`：断言 `liveTask(taskId) === undefined` | PASS |
| 取消后下一个工具调用 | 被 guard 拒绝 | 同一用例：`runGuard(...)` 返回含 `no longer authorized` 的字符串 | PASS |
| B 撤权 | 授权记录 `revokedAt` 有值，任务转 `CANCELLED`/`CANCEL_REQUESTED` | `hub/test/task-approval.test.js` → `revoking stops the task…` | PASS |
| 撤权后 Hub 拒绝 `RUNNING` | 拒绝帧 | 同一用例 | PASS |
| 撤权后已分享的产物 | 立即不可下载 | `hub/test/task-artifact.test.js` → `revoking the approval withdraws the artifact that was already shared`：撤权前 200、撤权后 404，且日志有 `artifact.revoked` | PASS |
| 授权过期后继续运行 | 下一个工具调用被拒 | `an expired grant stops a run rather than letting it continue` | PASS |

---

## T17 任务副作用后 ACK 丢失

| 步骤 | 期待 | 实际（自动化） | 结论 |
|---|---|---|---|
| 同一 `taskId` 重投 4 次（模拟 ack 丢失后的 outbox 重发） | 1 个任务，后 3 次 `duplicate: true` | `task-envelope.test.js` → `the same task id is one task, however many times the outbox resends it`：`tasks.count === 1` | PASS |
| 同一 `taskId` 换一个群使用 | 拒绝（主键冲突） | `db-g5-schema.test.js` → `the same task id in another group is still the same task` | PASS |
| 进度事件被节流 | 2 秒窗口内五次工具调用只落 1 条事件 | `workgroup-task.test.js` → `the progress report is merged…`：向 `session/event` 发 5 次 `tool/call`，断言 `task.progress` 事件数为 1、`payload.note` 为工具名 | PASS |
| 未知结果时不盲目重跑 | 由 `taskId` 幂等 + 状态机共同保证：`duplicate` 不重复 append、不重复 fan-out | Hub `tasks.request()` 的 `existing` 分支直接返回已存行；`task-approval.test.js` 断言重复批准不新增 grant | PASS |
| 副作用后 ack 丢失再重连 | 拉回的是同一条事件（`eventId` 主键），不是新的一条 | G4 已证（`ws-events.test.js`）；G5 的任务事件复用它同一条链路 | PASS |
| **任务已开始并产生副作用后，start 重放** | 第二次 `runTask` 不再次提示 Bot；同一 `runId` | `workgroup-task.test.js` → `starting the same approved task twice delivers it once`：两次调用后 `__delivered.length === 1`，`state === 'RUNNING'`，`runId` 相同 | PASS（2026-10-25 补） |
| **进程重启时任务仍为 RUNNING** | 重建索引即 `INTERRUPTED`，不自动重放；只有用户显式 start 才开启新 run | `workgroup-task.test.js` → `a restart while RUNNING marks the task interrupted and never replays it`：`indexTasks()` 后状态为 `INTERRUPTED`，投递数不变；显式 start 产生新 `runId` 且仅一次新投递 | PASS（2026-10-25 补） |
| **同一 `RUNNING` 报告因 ACK 丢失重发** | 幂等接受，不新增版本、不重复写 `task.started` | `hub/test/task-approval.test.js` → `a replayed RUNNING report is an idempotent acknowledgement` | PASS（2026-10-25 补） |
| **同态报告携带旧版本** | 仍拒绝，不能借同态绕过 compare-and-apply | `hub/test/task-approval.test.js` → `a same-state report still cannot use a stale version`：返回 `task/version-conflict` | PASS（2026-10-25 补） |

> **口径修正（2026-10-25）**：此前 T17 只证明了「同一 `taskId` 重投不重复建任务」，那是**请求幂等**；本表上面新增的行才覆盖**已开始任务的副作用幂等**。两者不是同一件事，不能互相替代。

---

## gate 4：伪造批准 / 过期 / 撤权 / 群外访问被拒（§14 原文 5 条中的第 4 条）

由 T13 全部行 + T16 的撤权行 + `hub/test/task-lease.test.js` 的围栏行共同构成。逐条对照：

| §14 G5 门禁 | 对应断言 |
|---|---|
| B 拒绝时 B 无模型/工具执行 | T11 全部行 |
| 批准后目标真实 Bot 在 B 本机运行 | T12（自动化一半 + 真机 BLOCKED） |
| 出单设备明确 | `approvedDeviceId === b.deviceId && !== a.deviceId`；事件 `sender.deviceId === b.deviceId` |
| 伪造批准/过期/撤权/群外访问被拒 | T13 + T16 |
| 至少一次投递不重复执行副作用 | T17 |

## 单协调者租约（§9.5，属 §14 G5「事件围栏」）

| 步骤 | 期待 | 实际 | 结论 |
|---|---|---|---|
| **插件真的取租约**（不是只有端点） | 通过 `bridge.acquireLease` 取到 epoch 1，持有者是本机 | `workgroup-task.test.js` → `a group lease is acquired through the product path, and a second machine is refused` | PASS |
| **围栏是轮次的一部分** | `groups.js` 的自动轮次先取租约、取不到不跑、结束释放；本地群与离线不受影响 | `the coordinator fence is part of the round, not only an endpoint`（结构断言四条） | PASS |
| 首个 acquire | epoch 1 | `hub/test/task-lease.test.js` → `a group starts with no lease…` | PASS |
| 第二台设备在租约内 acquire | 409 `lease/held`，并说出到期时间 | `a second device cannot take a live lease…` | PASS |
| 同一人另一台机器 | 409（同一人也不行） | `the same person on two machines is two coordinators, not one` | PASS |
| 租约过期后被他人取得 | epoch 前进，旧持有者的 `lease.check` 被拒 | `a lease that expired can be taken, and the epoch moves…` | PASS |
| 过期租约仍自称协调者 | `lease/expired` | `an expired lease is not a licence to commit` | PASS |
| 主动 release 后 epoch | 仍前进（不回退到 1） | `only the holder may release…`：`epoch === 2`；插件侧对应 `releasing the lease lets the other machine take it…` | PASS |
| 非成员持租 | 404 | `a lease cannot be taken in a group the caller is not in` | PASS |

**这里发现并修掉的真实缺陷**：`release` 原本 `DELETE` 那一行，导致 epoch 重新从 1 开始，上一任协调者手里的旧围栏值会重新变有效。改成把 `lease_until` 推到过去、保留 epoch。
