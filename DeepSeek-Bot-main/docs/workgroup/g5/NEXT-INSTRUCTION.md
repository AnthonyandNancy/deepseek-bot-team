# G5 续接指令（BotCode · 自足版）

- 用法：新建会话后，把下面「指令正文」整段作为第一条消息发出。
- 适用范围：**只在本仓库工作**。`Workgroup-AI` 已冻结：不读、不改、不引用。技术方案已复制到 `BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md`，读这份副本。
- 前置：G4 已交付（自动门禁 2/3/4/5 通过；门禁 1/6 与 T19/T20 待人工）。见 `docs/workgroup/gates.md`、`docs/workgroup/g4/EVIDENCE-MATRIX.md`、`docs/workgroup/g4/ROUND-LOG.md`。
- **本文件不含 G5 设计**，只写范围、判据、口径、依赖与既有事实。
- **状态：G5 已执行完毕（2026-10-22）。** 本指令保留作为记录与实际执行依据；结果见 [`EVIDENCE-MATRIX.md`](EVIDENCE-MATRIX.md) 与 [`ROUND-LOG.md`](ROUND-LOG.md)。下面「指令正文」保持原样，不改写，以免执行记录与要求脱节。

---

## 指令正文（复制以下全部内容）

```text
你在 BotCode 工作副本里继续「工作群」项目，执行 G5。所有代码、测试、文档都写在这里。

## 0. 仓库与基线

1. 根目录：D:\code\ai\DeepSeek-Bot\BotCode
   - 插件：DeepSeek-Bot-main/ds-bot
   - 服务端：hub（相对 ds-bot 是 ../../hub）
2. 基线：ds-bot@0.2.0、DSH 0.2.1-rc.2。本阶段不发版、不改版本号、不打包。
3. 另一个目录 Workgroup-AI 是已冻结的源仓库：不要读它，也不要引用它的路径或结论。
4. 技术方案在本仓库根目录：`BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md`（18 节）。它是**源基线**写成的，读时必须换算：
   - 方案里的 `bot-plugin/` = 本仓库 `ds-bot/`；方案里的 `hub/` = 本仓库 `BotCode/hub/`。
   - **方案 §0 和 §4 的「严格只有 hub/ 与 bot-plugin/ 两个一级目录」不适用于本仓库**：本仓库是 `DeepSeek-Bot-main/{ds-bot,app}` + `hub`。
   - 方案里的 DSH `0.2.0-rc.2` = 本仓库 `0.2.1-rc.2`；`v0.1.7` 是源基线，本仓库是 `v0.2.0`。
   - 其余换算规则见 `docs/workgroup/CONVERSION.md`。
5. 口径优先级：需求文档（`docs/plans/2026-10-22-workgroup-migration.md` 的 17 项决策）> 本指令的「已定口径」> 技术方案 > g0–g4 历史阶段文档。冲突时按这个顺序取，并在轮次日志记一笔。

## 1. 必读（全部在本仓库）

- `BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md`  G5 看 §10（跨用户任务、审批、真实执行）、§12（Hub 数据模型）、§13（API）、§14 G5 门禁、§15 验收矩阵 T11–T17；其余按需查
- `docs/workgroup/gates.md`                 G4 自动门禁与 F1–F5/G1–G3 的自查修复记录
- `docs/workgroup/progress-and-gaps.md`     台账、15 条缺口、决定记录
- `docs/workgroup/g4/ROUND-LOG.md`          G4 五轮的过程与踩过的坑（**尤其第 4、5 轮**：两条「测试绿但产品不可用」的教训）
- `docs/workgroup/g4/EVIDENCE-MATRIX.md`    T08/T09/T10 的证据形态，G5 要照这个格式写 T11–T17
- **`docs/workgroup/g5/DESIGN-CHANNEL-AND-SEQ.md`  已定的两个设计决定（通道与序号）+ 可行性核实 + 落地清单；开工前必读**
- **`docs/workgroup/g5/COPY-BASELINE.md`  复制基线：原版群聊能力是否已迁移到位（已核对完成）+ 改造边界**
- `docs/workgroup/parity-audit.md`          工作群与原版群聊的逐能力对照
- `docs/workgroup/manual-checklist.md`      人工项清单（G5 不动它，但要知道哪些仍待人工）
- 代码：
  - `ds-bot/src/workgroup/host/tasks.js`    **G2 已建**：状态机 + 授权绑定（`registerTask`/`taskOf`/`advanceTask`/`releaseTask`）
  - `ds-bot/src/workgroup/host/{bridge,groups,channel,upgrade,ownership}.js`
  - `ds-bot/src/host/{tools,capabilities}.js`  工具收敛与 `ctx.tools.guard`/`restrict` 接缝
  - `hub/src/{server,ws,router,http}.js`、`hub/src/db/migrations.js`、`hub/src/{workgroups,events,endpoints,attachments}/service.js`

## 2. G5 范围（本阶段只做这些）

**Hub 侧**

- 新增四张表，**字段照方案 §12 抄**（表名与列名都以方案为准，不要自己改名）：

  | 表 | 方案 §12 的关键字段 | 方案 §12 的核心约束 |
  |---|---|---|
  | `tasks` | `id, workgroup_id, requester_id, owner_id, endpoint_id, state, version` | 状态机、并发控制 |
  | `approvals` | `id, task_id, approved_by, scope, state, expires_at, version` | B 本人权限范围与撤权 |
  | `round_leases` | `workgroup_id, epoch, holder_device_id, lease_until` | 单协调者围栏 |
  | `artifacts` | `id, task_id, owner_id, blob_path, hash, size, acl, expires_at` | 仅授权产物 |

  四点必须注意：
  - `artifacts.blob_path` 是方案给的名字，**它是 Hub 自己存储目录内的键**，不是本机路径。落地时按 G4 `attachments.storage_key` 的做法：路径由 Hub 自己生成，端到端不回传、不接受客户端提供。若沿用 `blob_path` 这个列名，请在迁移注释里写明「Hub 内部键，非客户端路径」。
  - `artifacts` 带 `task_id`，**G5 的产物必须挂在一个任务上**；G4 的 `attachments` 是任务无关的聊天附件，两者并存、不合并、不互相顶替。
  - `round_leases` 是 §9.5 的 `coordinatorEpoch / leaseUntil` 的落库；G4 刻意没建，本阶段才生效。
  - `tasks.version` 与 `approvals.version` 是方案明文要求的**并发控制**列，不要省。
- 端点。**只有两个在方案 §13.1 的草案里**，其余是 G5 必须自行设计并记录的：
  - 方案 §13.1 已给出：`POST /v1/tasks/:id/decision`（B 本人批准/拒绝 + 三种分配方式）、`POST /v1/tasks/:id/revoke`（B 撤权；也接受 A 取消）、`POST /v1/artifacts/uploads`、`GET /v1/artifacts/:id/download`。
  - 方案 §13.1 **没有**、需要自行定义并写进轮次日志与 `gates.md` 的：
    - **发起任务：WSS 的 `task.request`，不设 `POST /v1/tasks`**（已定，见 §4 与 `DESIGN-CHANNEL-AND-SEQ.md`）。
    - 读任务（A 侧看进度/结果；B 侧看自己的待办）：方案未定义，**本阶段新增 `GET`**。
    - 租约（§9.5 的 `coordinatorEpoch / leaseUntil`）：方案只描述语义，未给端点，本阶段新增。
  - 结论：**不要把上面这些写成「对齐 §13.1」**。写「方案未定义，本阶段新增」，并把形状记进 `gates.md`。
- 事件类型：方案 §9.3 已给出完整清单，照抄，不要增删——
  - 任务：`task.request`、`task.received`、`task.cancel`、`task.started`、`task.progress`、`task.completed`、`task.failed`
  - 审批：`approval.request`、`approval.granted`、`approval.rejected`、`approval.revoked`
  - 附件：`artifact.available`、`artifact.revoked`
  - G4 的 `EVENT_TYPES` 是封闭集合（当前 5 项），本阶段扩充；扩充时**逐个加入**并保持「未知类型被拒」的行为。

**插件侧**

- **Task Session 真实执行（方案称 `BotAdapter`）**：把 G2 的 `tasks.js` 接到真通道上——`REQUESTED → … → RUNNING` 的每一次迁移都要经 Hub 持久化，且本地授权账本与 Hub 记录**双写且可对账**。
  - 状态机**已经存在，不要另写一套**：`tasks.js` 的 `TASK_STATES`/`TRANSITIONS` 就是方案 §10.2 那张表（8 个主态 + 6 个分支态，转移表逐条对应）。G5 要做的是让这些迁移在 Hub 上也有记录，而不是改状态机。
  - 「BotAdapter」在方案里没有给出接口形状，只要求「执行 B 的真实目标 Bot」。落地时按 DSH 现有接缝（`rt.createSession`/`rt.resolveAgent`/`ctx.tools.*`）实现，**不要为这个名字新造一层抽象**；若确实需要一层，写清它解决什么问题。
- **审批 UI**：只给**被请求方 B 本人**看。B 的 Chief 只能**建议**，不能替人批准。
- **三种分配**（方案 §10.1 第 4 步原文）：①已有下属 Bot ②Chief 自动选 Bot ③新建 Bot。三种都要能跑通（T12），且选择结果写进 `tasks.endpoint_id`/`owner_id`。
- **执行前验证**：真实 Bot 身份、工作目录、可见工具集、Guard 是否装上——**验证不过就不运行**，并把失败原因回传。
- **进度/成果/取消**：进度经 Hub 走 `task.progress`；结果在 B 本地检查是否可分享（必要时二次确认）；撤权后阻止新工具调用并取消可控作业。
- **单协调者**：一个工作群同一时刻只有一个有效调度者；轮次提交带 `roundId` 与围栏值，过期租约的回报被拒绝。
- **附件分享**：仅授权成果上传为 `artifacts`；A 通过 ACL 取已许可的摘要或附件。

**明确不做（不要顺手做）**

- 群记忆的跨用户检索与授权（G6）、移动端、短信 OTP（永不做）、P2P、多 Hub 联邦、发版。
- 不要把 `chat.message` 当成派单通道：跨用户任务必须显式 `task.request`（方案 §9.3）。

## 3. 门禁（判据先写死，不许自评）

**方案 §14 G5 原文的 5 条门禁**（判据不可改，逐字对照）：

> A 请求 B，B 拒绝时 B 无模型/工具执行；批准后目标真实 Bot 在 B 本机运行；出单设备明确；伪造批准/过期/撤权/群外访问被拒；任务至少一次投递仍不重复执行副作用。

| # | 门禁（方案原文） | 判定 | 你能给的证据 |
|---|---|---|---|
| 1 | A 请求 B，B **拒绝**时 B 无模型/工具执行 | 可自动化 | `REJECTED` 后 B 的 Session 从未被创建、从未被 prompt；B 侧工具调用计数为 0；Hub 记录里没有 `task.started` |
| 2 | 批准后**目标真实 Bot 在 B 本机运行** | 可自动化 + 人工看一次 | 跑到的是 B 指定的 Bot id（不是 A 的、不是复制提示词模拟）；`ctx.tools.guard` 实际装上；人工确认执行在 B 的机器上（T12） |
| 3 | **出单设备明确** | 可自动化 | 任务与审批记录里 `device_id` 始终是 B 的设备；A 的设备不能代 B 批准 |
| 4 | 伪造批准/过期/撤权/群外访问**被拒** | 可自动化 | 改 `senderId`、重放旧 `approval`、用过期授权、非成员发起——每种都要有拒绝断言（T13） |
| 5 | 任务至少一次投递**不重复执行副作用** | 可自动化 | 同一 `taskId` 重投 N 次，实际执行恰好 1 次；副作用后 ack 丢失也不盲目重跑（T17） |

**本阶段新增的 3 条**（方案没写，但 G5 任务描述里有对应要求，或 G4 已立下且不得回归；**标注为新增，不要混进「方案门禁」**）：

| # | 门禁（新增） | 依据 | 你能给的证据 |
|---|---|---|---|
| N1 | 撤销后**新操作失败**、可取消作业停止 | 方案 §10.1 第 6 步与 §10.4「撤销必须阻止新的调用」；T16 | `revoked` 后新工具调用被 `guard` 拒绝；可控作业收到停止 |
| N2 | 「插件」位置保持且「Bot」入口唯一 | G4 门禁 5，不得回归 | 沿用 `ds-bot/test/workgroup-sidebar.test.js` |
| N3 | G5 交互与原版对照无明显违和 | 方案 §15 T19 的同类要求 | **只能人工**：只出并列对照清单与步骤，**不写「无违和」** |

### 验收矩阵里与 G5 相关的用例（§15，必须留证据）

| 编号 | 场景 | 必须观察到 |
|---|---|---|
| T11 | A 请求 B，B 未批准 | B 不执行任何任务工具 |
| T12 | B 批准三种派单模式 | 执行 B 的真实目标 Bot |
| T13 | 修改请求 `senderId` / 伪造批准 | 无法越权或冒充 B |
| T14 | 路径穿越 / 符号链接 / 非法 cwd | 拒绝且不回退到团队目录 |
| T15 | `run_code` / MCP / 群外 `message_bot` 绕过 | 实际工具边界拒绝 |
| T16 | 执行中撤权 / 取消 | 新操作失败、可取消作业停止 |
| T17 | 任务副作用后 ACK 丢失 | 无盲目重复执行 |

每个用例记录：环境与版本、步骤、期待值、实际值、日志、截图/录屏、结论 PASS/FAIL/BLOCKED。**源码级推断和模拟不能代替双机验收。**

## 4. 已定口径（这些不用再问）

> 下列两条是**已定的设计决定**，理由与可行性核实见 [`DESIGN-CHANNEL-AND-SEQ.md`](DESIGN-CHANNEL-AND-SEQ.md)。不要重新论证、不要改成另一种做法。

- **任务/审批/产物事件占用群内 `seq`**，与 `chat.message` 共用同一顺序，走 G4 的 `deliveries` + `ack_at` + 游标补拉。依据：方案 §9.4「所有公开群事件由 Hub 分配群内 `seq`」；且 B 可能离线时被请求，审批请求必须能补投。
  - 判据（与 `member.changed` 的区别，不是双标）：**重连会权威重读的状态走提示帧；离线必须补投的可执行内容走 `seq`**。
  - **连带改动（不做就错）**：未读数从「游标差」改为「`seq > 游标` 的 `chat.message` 条数」——两处：`hub/src/workgroups/service.js` 的 `unreadCount`、`ds-bot/src/workgroup/host/channel.js` 的房间视图 `unread`。这会让 G4 的两个未读测试期望值变化，属预期。
  - `task.progress` 必须节流（建议插件侧 2 秒内合并），`events` 是无限增长的表。
- **发起任务走 WSS 的 `task.request`，不设 `POST /v1/tasks`**；批准/拒绝走 `POST /v1/tasks/:id/decision`、撤权走 `POST /v1/tasks/:id/revoke`（方案 §13.1 只给了这两个）；读任务是本阶段新增的 `GET`。
  - 这个「请求走 WSS、决策走 HTTP」的不对称是**方案自己的形状**，不是笔误。
  - 复用 outbox 需要一处小改：`bridge.js` 的 `flush` 现在把 `type` 写死成 `'chat.message'`，outbox 项要带 `frameType`；建议新增 `bridge.sendEvent({ workgroupId, frameType, payload })`，`send()` 保持只发聊天。
  - 握手签名**不覆盖 payload**：`task.request` 需要独立的信封签名字段（规范化序列化 → 哈希 → 设备私钥签），Hub 校验「签名有效 ∧ sender 与连接身份一致 ∧ 未过期 ∧ 未重放」。
  - 这条必须有**契约测试**：改 payload 后签名失效、改 sender 被拒、重放被拒。方案 §9.2 明文要求不可只检查 `signature` 字段存在。

- 测试数字以**实际运行结果**为准；文档里的旧数字是快照，发现不一致就回填文档，不要停下来问。
- **G4 的附件与 G5 的产物是两套东西**：`attachments`（聊天文件，任务无关）继续存在，`artifacts`（任务产物，带 ACL 与 `task_id`）新建，不要合并、不要互相顶替。
- **Hub 记录不等于授权**：Hub 上的 `approval.granted` 不能独立激活 B 的工具权限；最终判定是 `可执行 = 原 DSH 权限允许 ∧ B 本地授权有效 ∧ 路径/端点在范围内 ∧ OS 隔离允许`（方案 §10.4）。
- 手机号未验证（`phone_verified_at` 恒 NULL）；不引入 OTP。
- N3（观感对照）只能人工：不要写 PASS，也不要写「已代为确认」。
- 不发版、不改版本号、不打包。

## 5. 建议顺序（按依赖）

1. **Hub 数据模型**：迁移 v4 建 `tasks`、`approvals`、`round_leases`、`artifacts`，字段照方案 §12（见 §2 的表）。附唯一约束：`taskId` 幂等、`(task_id, version)` 并发控制、租约 `(workgroup_id, epoch)`。先写表与约束测试（照 `hub/test/db-g4-schema.test.js` 的写法）。
2. **未读数改算法 + `EVENT_TYPES` 扩容**：先做这两处，否则任务事件一进来未读数就错、新类型就被拒（见 §4 的连带改动）。
3. **任务状态机的 Hub 落库**：`task.request` 的 WSS handler + `decision`/`revoke` 端点 + 新增的读任务 `GET`，只接受方案 §10.2 允许的迁移；未批准绝不能 `RUNNING`。
4. **签名与防重放**：请求信封的规范化序列化 + 签名校验 + 防重放窗口，用契约测试证明（T13，方案 §9.2 要求「不可仅检查 signature 字段存在」）。
5. **插件侧 Task Session 真执行**：把 `tasks.js` 的授权账本与真通道对齐；执行前验证身份/cwd/工具/Guard（T12、T14、T15）。
6. **审批卡与三种分配**：只给 B 本人；Chief 仅建议（T11）。
7. **进度、成果、取消、附件授权分享**（T16、T17）。
8. **单协调者租约**：`round_leases` + 围栏值；过期回报被拒（§9.5）。
9. **门禁与文档**：跑方案 5 条 + 新增 3 条门禁；写 T11–T17 证据；更新台账。

## 6. 每轮必须交付

- 改了哪些文件（diff 或摘要）
- 执行的命令与结果（构建、测试、lint）
- 新增/修改的测试，以及它们证明哪条门禁
- 未解决的问题与阻塞（谁需要做什么）
- 文档更新：`docs/workgroup/gates.md`、`progress-and-gaps.md`，并在 `docs/workgroup/g5/ROUND-LOG.md` 追加本轮记录

## 7. 硬规则（违反即停）

1. 不修改 DSH，不打补丁，不依赖 DSH 安装目录内的文件。缺能力就停下说明。
2. 不改本地群语义：`src/host/groups.js`、`turns.js`、`delivery.js`、`resume.js`、`constants.js` 必须逐字节不变；需要动它们时先停下问。
   - **已核对（`g5/COPY-BASELINE.md`）：原版 17 个群函数在工作群侧 17/17 有对应，原版 `src/host/` 零改动，G5 的改造全部落在 `src/workgroup/` 内。不需要先做「复制迁移」。**
   - 若 G5 发现必须改 `src/host/` 下任何文件：**停下，写「Plan 偏差」**。正确做法是把那一小段复制进 `src/workgroup/host/groups.js`，不是改原版。
   - 每次交付前跑 `git status --porcelain ds-bot/src/host/`，输出必须为空。
3. 一个 Runtime 只安装一次工作群域；二次安装必须抛错；域故障不能拖垮本地团队。
4. 本地群与工作群数据、会话、权限、记忆隔离；本地群历史不上传。
5. 不发版、不改版本号、不打包。
6. 测试不得指向 ~/.dsh 或用户自己的 DSH 数据；用临时目录。
7. 不读、不改、不引用 Workgroup-AI。
8. **测试必须走产品路径**：这是 G4 第 4/5 轮踩到的坑——15 处测试自己调 `bridge.start()`，套件全绿而产品里 bridge 从未启动。新测试只用客户端唯一的门（`apiHandle`），不显式启动内部组件。若必须测内部，另写一条端到端用例覆盖同样的用户步骤。
9. 遇到会改变需求或架构的问题：停下，写「Plan 偏差」，等人确认。

## 8. 完成定义

- 方案 §14 G5 的 **5 条门禁**全部有自动化证据并通过；新增的 N1/N2 通过；**N3（观感对照）标「待人工」**，附可执行步骤，不写 PASS。
- `npm test`、`node scripts/build-client.mjs --check`、`npm run lint` 全绿；`hub` 的 `npm test` 全绿。
- T11–T17 每条都能在 `docs/workgroup/g5/EVIDENCE-MATRIX.md` 里指到「哪条测试、哪条断言」。
- 文档能回答：G5 做到哪、缺什么、下一步是什么、哪些必须人来验。

## 附录 A：当前事实（写指令时核对过）

**Hub 已有的表**：迁移 v1–v3 共 **15 张**（G3 六张 + G4 九张）——
`users`、`auth_sessions`、`devices`、`audit_events`、`recovery_codes`、`password_resets`（G3）、
`bot_endpoints`、`workgroups`、`memberships`、`invites`、`events`、`deliveries`、`read_cursors`、`attachments`、`attachment_tickets`（G4）。
另有 `schema_version`（迁移记账）与 `otp_challenges`**刻意不存在**（无短信 OTP）。

**尚未建**：`tasks`、`approvals`、`round_leases`、`artifacts`（G5）、`group_memories`（G6）。

**Hub 已有的路由**（G4 交付，勿重复实现）：
`/v1/auth/{register,login,refresh,logout,me,recover,password,recovery-code}`
`/v1/devices/{challenge,register}`、`/v1/devices`、`/v1/devices/:id/revoke`
`/v1/workgroups`(GET/POST)、`/v1/workgroups/:id`、`/v1/workgroups/:id/{members,invites,events,read,attachments}`
`/v1/invites`、`/v1/invites/:id/{accept,decline}`
`/v1/bot-endpoints`(GET/POST)、`/v1/bot-endpoints/:id/revoke`
`/v1/attachments/:id/{ticket,download}`、`/v1/health`、WS `/v1/ws`

**WSS 协议 v1**（G4，已实测）：
- 客户端→Hub：`auth`（仅首帧，握手用）、`subscribe`、`chat.message`、`event.ack`、`sync.request`、`read.updated`、`heartbeat`
- Hub→客户端：`hello`、`event`、`sync.batch`、`ack.ok`、`read.ok`、`read.updated`、`member.changed`、`subscribed`、`heartbeat`、`error`
- 握手两条路径：`Authorization` 头，或 `?auth=frame` + 首帧 `{type:'auth',accessToken}`（浏览器 `WebSocket` 不能设 header）。
- 未知帧类型回 `error` 帧（`frame/unsupported`），不断连接。G5 加新帧时保持这个行为。
- **`member.changed` 是 G4 的决定：成员变更走独立帧，不占群 `seq`、不写 `events`。** G5 的 `task.*`/`approval.*` **相反：占 `seq`**（已定，见 §4）。两者判据是「重连会权威重读的状态走提示帧；离线必须补投的可执行内容走 `seq`」。

**插件侧已存在、G5 要复用的接缝**：
- `wg.tasks`（Map）、`wg.registerTask`/`taskOf`/`liveTask`/`tasksOf`/`advanceTask`/`releaseTask`/`indexTasks` —— G2 建好，状态机就是方案 §10.2 那张表。
- `wg.deliver`、`wg.deliverRemote`（G4）、`wg.receiveRemote`、`wg.applyRoster`/`syncRoster`。
- `wg.bridge`：`start/stop/reset/status/createWorkgroup/sync/send/sendAttachment/downloadAttachment/markRead/invite/answerInvite/publishBotEndpoints/on/groupState/readCursor`。
- `ctx.tools.restrict()`（`src/host/tools.js:736` 已有用法）、`ctx.tools.guard()`（`:745` 已有用法）。
- 桌面端把 `ds-bot` 当包文件复制，`package.json` 的 `files` 已含 `src/workgroup/`。

**G4 交付时踩过、G5 必须避开的坑**（详见 `g4/ROUND-LOG.md` 第 4、5 轮）：
1. 端点写了但**没有调用方**（6 个端点客户端调用数为 0）。
2. 测试**自己启动内部组件**，套件绿而产品不可用。
3. 事件写进 `chat.message` 的 `seq` 流，使「升级后事件数为 0」失真——G5 的 `task.*`/`approval.*` 要想清楚**是否占用群 seq**，并在文档里写明理由。
4. Hub 不回显给发送方设备，插件若不在 ack 时落本地日志，发送者看不到自己的消息。
5. 远端消息作者归属依赖 Hub 名册同步；`users` 表**没有 `display_name`**，人员只能显示打码手机号。

## 附录 B：自足性说明（每条结论在本仓库的位置）

| 结论 | 依据 |
|---|---|
| 认证是手机号 + 密码，无 OTP | `hub/src/auth/service.js`、`docs/workgroup/g3/PLAN.md` §0 |
| G4 九张表与路由清单 | `hub/src/db/migrations.js`（迁移 v3）、`hub/src/server.js` |
| WSS 协议与两条握手路径 | `hub/src/ws.js` |
| 任务状态机是方案 §10.2 那张表 | `ds-bot/src/workgroup/host/tasks.js` 的 `TRANSITIONS` |
| 工具强制拒绝的接缝 | `ds-bot/src/host/tools.js:736`、`:745` |
| G4 的门禁与修复记录 | `docs/workgroup/gates.md`、`g4/ROUND-LOG.md`、`g4/EVIDENCE-MATRIX.md` |
| 缺口与决定 | `docs/workgroup/progress-and-gaps.md` |

## 附录 C：G5 期间要守住的既有结论

- **本地群零回归**：`src/host/{groups,turns,delivery,resume,constants}.js` 逐字节不变。
- **未登录可用**：Hub 不可达时本地 Chief/Bots/私聊/本地群全部可用；`ds-bot/test/hub-offline.test.js` 必须仍绿。
- **单次安装**：`workgroup-isolation` 的 WG-01/WG-02 不得回归。
- **不上传历史**：升级请求体仍只有 `{name, notice, upgradeId, endpointIds}`；G5 引入任务后，任务内容也不得把本地群历史带上 Hub。
- **两套附件体系并存**：`attachments` 与 `artifacts` 各自独立。

## 附录 D：开工前清单（逐条打勾）

- [ ] 跑过 `cd hub && npm test`（应为 190 pass）与 `cd ds-bot && npm test`（应为 990 tests，989 pass / 1 skip / 0 fail）
- [ ] 跑过 `node scripts/build-client.mjs --check` 与 `npm run lint`（0 error / 13 warning）
- [ ] 读过 `g4/ROUND-LOG.md` 第 4、5 轮，知道「测试自证」这个坑
- [ ] 读过 `tasks.js` 的 `TRANSITIONS`，确认 G5 不私自加状态
- [ ] 跑过 `g5/COPY-BASELINE.md` §9 的复制基线核对：原版 17 个群函数都有工作群对应，原版 `src/host/` 零改动，`wg.*` 回合状态未读原版 map
- [ ] 确认要动的文件不在「硬规则 2」的五个逐字节不变文件里
- [ ] 建好 `docs/workgroup/g5/ROUND-LOG.md`（首行写日期与本轮目标）
```
