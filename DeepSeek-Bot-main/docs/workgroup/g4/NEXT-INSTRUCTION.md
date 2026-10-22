# G4 续接指令（BotCode · 自足版）

- 用法：新建会话后，把下面「指令正文」整段作为第一条消息发出。
- 适用范围：**只在本仓库工作**。`Workgroup-AI` 已冻结：不读、不改、不引用。技术方案已复制到 `BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md`，读这份副本。
- 前置：G3 已交付（`docs/workgroup/gates.md` 18 条自动门禁通过；人工清单待执行）

---

## 指令正文（复制以下全部内容）

```text
你在 BotCode 工作副本里继续「工作群」项目，执行 G4。所有代码、测试、文档都写在这里。

## 0. 仓库与基线

1. 根目录：D:\code\ai\DeepSeek-Bot\BotCode
   - 插件：DeepSeek-Bot-main/ds-bot
   - 服务端：hub（相对 ds-bot 是 ../../hub）
2. 基线：ds-bot@0.2.0、DSH 0.2.1-rc.2。本阶段不发版、不改版本号。
3. 另一个目录 Workgroup-AI 是已冻结的源仓库：不要读它，也不要引用它的路径或结论。
4. 技术方案已复制到 BotCode 根目录：`BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md`（18 节；相对本文件是 `../../../../`）。它是**源基线**写成的，读的时候必须换算：
   - 方案里的 `bot-plugin/` = 本仓库 `ds-bot/`；方案里的 `hub/` = 本仓库 `BotCode/hub/`。
   - **方案 §0 和 §4 的「严格只有 hub/ 与 bot-plugin/ 两个一级目录」不适用于本仓库**：本仓库是 `DeepSeek-Bot-main/{ds-bot,app}` + `hub`。照抄这条会把结构做错。
   - 方案里的 DSH `0.2.0-rc.2` = 本仓库 `0.2.1-rc.2`；`v0.1.7` 是源基线，本仓库是 `v0.2.0`。
   - 其余换算规则见 `docs/workgroup/CONVERSION.md`。
5. 口径优先级：需求文档 > 本指令的「已定口径」 > 技术方案 > g0–g3 历史阶段文档。冲突时按这个顺序取，并在轮次日志记一笔。

## 1. 必读（全部在本仓库）

- `BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md`  G4 看 §8（升级）、§9（通道与投递）、§12（Hub 数据模型）、§13（API）、§14 G4、§15 验收矩阵；其余按需查
- docs/workgroup/gates.md                  G3 已通过的 18 条门禁（别重复劳动）
- docs/workgroup/parity-audit.md           工作群与原版群聊的复制完整性、逐能力对照
- docs/workgroup/diff-manifest.md          本仓库改了什么、哪些原版文件逐字节未动
- docs/workgroup/progress-and-gaps.md      台账与缺口
- docs/workgroup/g4-entry.md               G4 目标与已知阻塞
- docs/workgroup/g1/slot-probe.md          DSH 侧栏槽位的实测结论
- docs/workgroup/g3/PLAN.md、g3/G3-CLOSURE-AUDIT.md    Hub 认证与设备的既有事实
- 代码：ds-bot/src/workgroup/{index.js,host/*.js,client/*.js}；服务端 BotCode/hub/src/**

## 2. G4 范围（本阶段只做这些）

- Hub：从「只有账号/设备」长成「有群、成员、邀请、消息、事件」的服务端。
- 插件：把 wg.bridge = wg.hub 的占位、以及 groups.js 里对远程成员直接拒绝的缝，换成真实 WSS 通道。
- 升级：PREPARING → HUB_CREATED → LOCAL_LINKED → ACTIVE 的幂等事务；原群归档为只读历史，不删除、不上传历史。
- Bot Endpoint：只登记「身份 + 能力（最小集合）+ 所属设备」，不登记工作目录、不登记任何本地路径、不上传文件。
- 消息可靠性：群内序号（seq）、ack 后交付、事件去重（event_id）、重放、乱序容忍、断线补投、已读/未读游标。
- 附件中转（T08 要求）：只走「本地生成 → 哈希/大小/类型检查 → 上传 Hub 私有存储 → ACL 校验 → 下载」；**绝不传可直接访问本地目录的绝对路径**；有大小上限、MIME/后缀双检查、短期下载权限与过期清理。
- 客户端：群成员/邀请/在线状态/消息状态，沿用原版群样式。

明确不做（不要顺手做）：跨用户 Bot 委派与审批（G5）、群记忆的跨用户检索与授权（G6）、单协调者租约 / round_leases（G5）、P2P、多 Hub 联邦、移动端、短信 OTP、发版。

## 3. 门禁（判据先写死，不许自评）

| # | 门禁 | 判定 | 你能给的证据 |
|---|---|---|---|
| 1 | 两台真机实时群聊 | 只能人工 | 双进程 + 双 DSH_HOME + 同一 Hub 的自动化模拟；标 BLOCKED（等人工），不得记 PASS |
| 2 | 断网/重连/重放/乱序/重复 ACK 正常 | 可自动化 | Hub 侧 seq、event_id 去重、ack 后交付，Bridge 重连补拉；用真实 socket 的集成测试，不 mock 内部 |
| 3 | 本地群历史不自动上传 | 可自动化 + 人工看一眼 | 断言升级请求体只有群名/公告/成员 id，不含 log/正文；升级后该群 Hub 侧事件数为 0 |
| 4 | 升级失败重试不重复建群 | 可自动化 | 同一 upgradeId 重放 N 次，Hub 只有一个群，本地只有一条关联 |
| 5 | 「插件」位置保持且「Bot」入口唯一 | 可自动化 + 人工目视 | 侧栏结构断言：plugins 的 order 0 仍在；Bot 入口 order 在 0 与 10 之间且只注册一次 |
| 6 | 工作群交互与原版对照无明显违和 | 只能人工 | 只出并列对照清单与步骤，不写「无违和」 |

### 验收矩阵里与 G4 相关的用例（§15，必须留证据）

| 编号 | 场景 | 必须观察到 |
|---|---|---|
| T08 | 双机聊天、附件、成员邀请 | 权限正确，事件顺序一致 |
| T09 | Hub/Bridge 断电重启 | 未 ACK 重传，幂等去重 |
| T10 | 本地群升级，失败重试 | 一个工作群，旧历史保留不上传 |
| T19 | Bot UI 与原版视觉对照 | 布局/输入/@/菜单/消息主要行为一致（人工） |
| T20 | Windows/macOS Electron 冷启动 | 插件与 Hub 设置正常，原版功能正常 |

每个用例记录：环境与版本、步骤、期待值、实际值、日志、截图/录屏、结论 PASS/FAIL/BLOCKED。源码级推断和模拟不能代替双机验收。

## 4. 已定口径（这些不用再问）

- 测试数字以**实际运行结果**为准；文档里的数字只是当时的快照，发现不一致就回填文档，不要停下来问。
- 租约 / round_leases 属于 G5，G4 只做扇出、seq、ack、补投。技术方案 §9.5 提到租约，那是后续阶段，不在 G4。
- Bot Endpoint 的登记内容就是「身份 + 最小能力集合 + 设备」；能力用最小集合（可用即标），不猜字段、不登记本地目录。
- 升级四态、upgradeId 幂等、原群归档只读、历史不上传：均已确定。
- 门禁 1 与 6 只能人工：不要写 PASS，也不要写「已代为确认」。
- 不发版、不改版本、不引入 OTP、手机号不得写成「已验证」。

## 5. 建议顺序（按依赖）

1. Hub 数据模型与迁移（现只有 users/auth_sessions/devices/audit_events/recovery_codes/password_resets）。G4 只建这些（名字沿用技术方案 §12）：`workgroups`、`memberships`、`invites`、`events`（含群内 `seq` 与 `event_id` 唯一）、`deliveries`、`read_cursors`、`bot_endpoints`。`round_leases`、`tasks`、`approvals`、`artifacts`、`group_memories` 属 G5/G6，别现在建。
2. Hub HTTP API（对齐技术方案 §13.1 里属于 G4 的部分）：`POST/GET /v1/workgroups`、`POST /v1/workgroups/:id/invites`、`POST /v1/invites/:id/accept`、`GET /v1/workgroups/:id/events?afterSeq=…`、`GET/POST /v1/bot-endpoints`、`GET /v1/health`；WS `/v1/ws`。发消息走 WS 或与 events 共用同一套 seq 生成；升级走幂等键。`/v1/auth/otp/*`、`/v1/tasks/*`、`/v1/artifacts/*`、`/v1/workgroups/:id/memories*` 不在 G4：OTP 永不做，其余属 G5/G6。
3. 事件扇出与 WSS：seq、ack、去重、重放、乱序、断线补投。现有 ws.js 只有握手与撤销踢线。
4. 插件 Bridge：替换 wg.bridge 占位与 deliver 的远程拒绝缝；重连、离线队列、幂等发送。
5. 升级事务：四态 + upgradeId 幂等 + 原群归档。
6. Bot Endpoint 发布。
7. 客户端接通（成员/邀请/在线/消息状态/附件）；G4 可用后，移除面板顶部的「未完成：工作群聊天与消息尚未提供」声明（它只为 G3 水位存在），并补一条断言防止文案与能力再次不一致。
8. 桌面端冷启动（T20）：Electron 里插件与 Hub 设置正常、原版功能正常；改动 `ds-bot` 后必须重装应用包文件再验。
9. 门禁与文档：跑 6 条门禁 + 5 条矩阵用例，更新台账。

## 6. 每轮必须交付

- 改了哪些文件（diff 或摘要）
- 执行的命令与结果（构建、测试、lint）
- 新增/修改的测试，以及它们证明哪条门禁
- 未解决的问题与阻塞（谁需要做什么）
- 文档更新：docs/workgroup/gates.md、progress-and-gaps.md，并在 docs/workgroup/g4/ROUND-LOG.md 追加本轮记录

## 7. 硬规则（违反即停）

1. 不修改 DSH，不打补丁，不依赖 DSH 安装目录内的文件。缺能力就停下说明。
2. 不改本地群语义：src/host/groups.js、turns.js、delivery.js、resume.js、constants.js 必须逐字节不变；需要动它们时先停下问。
3. 一个 Runtime 只安装一次工作群域；二次安装必须抛错；域故障不能拖垮本地团队。
4. 本地群与工作群数据、会话、权限、记忆隔离；本地群历史不上传。
5. 不发版、不改版本号、不打包。
6. 测试不得指向 ~/.dsh 或用户自己的 DSH 数据；用临时目录。
7. 不读、不改、不引用 Workgroup-AI（已冻结）。
8. 遇到会改变需求或架构的问题：停下，写「Plan 偏差」，等人确认。

## 8. 完成定义

- 门禁 2/3/4/5 有自动化证据并通过；门禁 1/6 标「待人工」，附可执行步骤。
- npm test、node scripts/build-client.mjs --check、npm run lint 全绿；hub 的 npm test 全绿。
- 文档能回答：G4 做到哪、缺什么、下一步是什么、哪些必须人来验。

现在开始：先读「1. 必读」，然后用不超过 20 行说明你对 G4 范围与 6 条门禁的理解、你打算先做哪一步及原因。等我确认后再动代码。
```

---

## 附录 A：当前事实（写指令时核对过）

| 项 | 事实 |
|---|---|
| 插件入口 | `ds-bot/index.js`：`MODULES` 顺序安装后 `loadWorkgroup(config).installWorkgroup(rt)`，失败只 warn |
| 工作群域 | `ds-bot/src/workgroup/`，15 文件、约 4052 行；`WG_MODULES = [state, ownership, tasks, groups, hub, channel]` |
| 路由 | `/api/bot`、`/api/bot/feed`、`/api/workgroup` 三条并存 |
| Hub 现有表 | `users`、`auth_sessions`、`devices`、`audit_events`、`recovery_codes`、`password_resets` |
| Hub 现有端点 | `/v1/auth/*`、`/v1/devices*`、`/v1/health`，WSS 握手 |
| 插件 Hub 客户端 | `src/workgroup/host/hub.js`：注册/登录/refresh/设备 challenge/撤销/找回/改密/健康检查 |
| 桥占位 | `wg.bridge = wg.hub`（`host/hub.js` 末尾）；`groups.js` 的 `deliver` 对远程目标直接拒绝 |
| 记忆 | `memory.js` 经 `rt.workgroupRoomOf` 解析工作群房间（G3 补充） |
| 测试 | 运行结果 **944 项：943 pass / 1 skip / 0 fail**；Hub **111 项**（与 `gates.md` 第 2 条一致） |
| 版本 | `ds-bot` 与 `app` 均为 0.2.0 |
| 技术方案 | 已复制到 `BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md`，与源仓库同名文件逐字节相同 |

## 附录 B：自足性说明（每条结论在本仓库的位置）

| 需要的结论 | 位置 |
|---|---|
| 需求、17 项决策、硬规则 | `docs/plans/2026-10-22-workgroup-migration.md` |
| 技术方案（架构、隔离、升级、通道、数据模型、API、门禁矩阵） | `BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md` |
| 水位与已通过门禁 | `docs/workgroup/gates.md` |
| 复制完整性与函数对照 | `docs/workgroup/parity-audit.md` |
| 改动面、原版零改动证据 | `docs/workgroup/diff-manifest.md` |
| 侧栏槽位实测 | `docs/workgroup/g1/slot-probe.md` |
| Hub 认证/设备的既有事实 | `docs/workgroup/g3/PLAN.md`、`g3/G3-CLOSURE-AUDIT.md` |
| 台账、缺口、决定 | `docs/workgroup/progress-and-gaps.md` |
| 历史阶段过程（按需查，不必通读） | `docs/workgroup/g0/`…`g3/` |
| 源文档转换规则与口径 | `docs/workgroup/CONVERSION.md` |

## 附录 C：G4 期间要守住的既有结论

1. 工作群行为以源实现为准；本仓库基底是 v0.2.0 群聊代码（完整对照见 `parity-audit.md`）。
2. 本地群零回退的证据是逐字节相同的 5 个文件（`diff-manifest.md` §3）。
3. 侧栏「Bot」入口唯一、位置在「插件」之后（`g1/slot-probe.md`）。
4. 未登录 Hub 时本地团队必须完整可用（`gates.md` 第 12 条）。
5. 手机号只是登录名，不是已验证身份。

## 附录 D：开工前清单（逐条打勾）

- [ ] 读过「1. 必读」的 9 个条目（含技术方案，全在 BotCode）
- [ ] 跑过 `cd ds-bot && npm test`、`node scripts/build-client.mjs --check`、`npm run lint`
- [ ] 跑过 `cd hub && npm test`
- [ ] 能说出 G4 的 6 条门禁里哪两条只能人工
- [ ] 能说出 `wg.bridge` 与 `deliver` 现在为什么拒绝远程目标
- [ ] 确认过本指令没有要求你打开 Workgroup-AI
- [ ] 打开过 `BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md`，知道它是源基线写法、路径要按本仓库换算
- [ ] 已在 `docs/workgroup/g4/ROUND-LOG.md` 写下本轮计划
