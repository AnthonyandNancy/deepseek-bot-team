
# 进度台账与缺口登记

- 日期：2026-10-22
- 水位：**G6 原方案已被否决；G6R 自动化已完成，人工项仍 BLOCKED**。原版群记忆引擎（`groups/<roomId>/`、成员校验、回顾、面板、归档）是唯一实现，Hub 只传输 `memory.change`。G4-1/5/6、G4-T20、G5-T12/N3/T14、G6-M1 仍待人工，未发版
- 2026-10-23 补：**群内 Bot 交接**（方案 §5.1 的 `host/handoffs.js` 复制件）此前缺失，现已补上；属 G1 复制缺口，非 G5 范围
- 2026-10-25 补：**旧群 lead 回填 + 发布包漏文件** 已闭环，属 G4/G5 已交付范围的缺陷，**不新开阶段**；当时的下一步是 G6，G6 现见 `g6/ROUND-LOG.md`

## 进度台账

| 阶段 | 状态 | 证据 | 备注 |
|---|---|---|---|
| G0 环境与基线 | 通过 | 基线 832 tests 全绿；`docs/plans/...-implementation-plan.md` §8 | 与源 G0 结论一致 |
| G1 域复制与双群共存 | 通过 | `workgroup-isolation`、`workgroup-round`、`workgroup-files` | 复制而非重写；`groups.js` 等原版核心零改动 |
| G2 Task Session 与工具级安全 | 通过 | `workgroup-round`、`capabilities`/`tools` 补丁 | 工具作用域按域分流 |
| G3 Hub 账号与设备 | 通过 | `hub-store`、`hub-client`、`hub-account-switch`、`hub-offline`；Hub 侧 123 测试 | 认证为手机号 + 密码，无 OTP |
| G4 双机实时群聊与升级 | **自动部分通过（含 2 轮自查修复）** | `gates.md` 的门禁 2/3/4/5 + G4-A1..A19 + F1–F5 + G1–G3；hub 190 / ds-bot 990 | 门禁 1/6 与 T20 待人工；不发版 |
| G5 跨用户委派与本人审批 | **自动部分通过（含补修轮）** | `g5/EVIDENCE-MATRIX.md`；hub 256 / ds-bot 1033 | 门禁 2 真机一半、N3 待人工 |
| G4/G5 后补缺陷（lead 回填、发布包） | **已闭环（自动部分）** | `workgroup-membership.test.js` 18–22、`package-files.test.js`；ds-bot 1131 pass / 1 skip / 0 fail，hub 268 pass | app 安装副本重装与重启待维护者执行 |
| G4/G5 修补轮（轮次持久化、对账、设置版本、任务幂等、Stop 持久、全量门禁） | **已闭环（自动部分）** | `docs/workgroup/gates.md` 的「G4/G5 修补轮」；人工项仍 BLOCKED | 不改阶段水位，不虚报人工结论 |
| G6 群记忆（旧方案） | **已否决** | `g6/ROUND-LOG.md`（历史）；新建 `group_memories`、`memory-*` 端点与独立 UI，违反复制优先 | 保留为反例，不 merge |
| G6R 群记忆跨机传输 | **自动化通过；人工 BLOCKED** | `g6r/EVIDENCE-MATRIX.md`、`g6r/ROUND-LOG.md` | 复用原版引擎；G6-M1 待两台真机 |
| 人工验收 | 待执行 | `manual-checklist.md` | 由维护者执行；G6-M1 已加入 |
| 发版 | 未执行 | `ds-bot` 源码 0.2.3；未发版 | 需求明确不发版 |

## G4 做到什么

**Hub（`BotCode/hub/`）**

- 迁移 v3 建 G4 的九张表：`bot_endpoints`、`workgroups`（`last_seq` 计数器、`upgrade_id UNIQUE`）、`memberships`、`invites`、`events`（`event_id` 主键 + `(workgroup_id, seq)` 唯一）、`deliveries`、`read_cursors`、`attachments`、`attachment_tickets`。
- HTTP：`POST/GET /v1/workgroups`、`GET /v1/workgroups/:id`、成员、邀请（`POST /v1/workgroups/:id/invites`、`GET /v1/invites`、`POST /v1/invites/:id/{accept,decline}`）、`GET /v1/workgroups/:id/events?afterSeq`、`POST /v1/workgroups/:id/read`、`GET/POST /v1/bot-endpoints`、附件四端点、`GET /v1/health`。
- WSS `/v1/ws`：`hello/subscribe/chat.message/event.ack/sync.request/read.updated/heartbeat`；`seq` 事务内发放；`event_id` 去重；`deliveries` + `ack_at`；断线补投；按当前成员关系扇出；发送方由连接决定。
- 握手两条路径：`Authorization` 头，或 `?auth=frame` + 首帧 `{type:'auth',accessToken}`（浏览器 `WebSocket` 不能设 header）。两条走的校验完全相同。
- 附件：base64 上传 → 解码后 8 MiB 上限 → 扩展名 + MIME 双检 → Hub 自生成 storage key → 5 分钟下载票据 → 到期 sweep 删盘。**没有任何列能存本地路径**。

**插件（`ds-bot/`）**

- `host/bridge.js`（新）：真实 WSS；重连退避（1s→30s）；离线 outbox（`eventId` 幂等补发）；按 `seq` 应用与补洞；日志级去重（`hubEventId`，跨重启有效）；Hub 群 ↔ 本地房间链接。
- `host/upgrade.js`（新）：`PREPARING → HUB_CREATED → LOCAL_LINKED → ACTIVE`，`upgradeId` 一旦写下不再重新生成；原群归档只读、不删、不上传。
- `host/groups.js`：远程成员不再抛错，交 `wg.deliverRemote`；新增 `receiveRemote`（Hub 行落本地日志并进群 Session）、`ensureLinkedGroup`、`roomOfHubGroup`。
- `host/channel.js`：`upgrade-room` 走四态事务；新增 `upgrade-status`、`bridge-state/-start/-stop/-sync/-create-group`、`send-hub`、`group-members`、`group-invites`、`invite-member`、`answer-invite`、`send-attachment`、`attachment-ticket`、`publish-endpoints`。
- `host/hub.js`：`socketAuth()` 只交出签名闭包（私钥不出模组）；群/邀请/事件/Endpoint/附件方法。
- 客户端：成员列表、邀请表单、附件选择、Hub 连接线与未读进度、`via=hub` 消息标记、归档只读提示；移除 G3 的「未完成」声明；`+16` 条中文文案。

## G5 做到什么

**Hub（`BotCode/hub/`）**

- 迁移 v4 建四张表：`tasks`（`id` 即请求方生成的 `taskId`，主键 → 幂等）、`approvals`（`(task_id)` 上只允许一条 live grant 的 partial unique index）、`round_leases`（`workgroup_id` 为主键 → 一个协调者）、`artifacts`（挂在 `task_id` 上，`blob_path` 为 Hub 内部键）。
- `EVENT_TYPES` 从 5 项扩到 **18 项**：新增方案 §9.3 的任务 7、审批 4、产物 2。仍是封闭集合。`memory.*` 留给 G6。
- **未读数改算法**：`unreadCount` 由「`last_seq - lastReadSeq`」改为「`seq > 游标` 的 `chat.message` 条数」。任务事件占 `seq` 后，旧算法会把审批算成未读。
- 任务服务：§10.2 状态机逐条校验（未批准不可能 `RUNNING`）；`decide` 的 `approved_device_id` 只取自认证会话；`revoke` 只允许任务拥有者；进度写入节流。
- 信封：`canonicalJson`（键排序）+ payload hash + Ed25519；`task.request` 校验「签名有效 ∧ sender 与连接一致 ∧ 未过期 ∧ 未重放」。契约测试覆盖改 payload / 改 target / 改有效期 / 改 sender / 重放 / 未来时间 / 版本不符 / 无签名。
- 产物：仅任务拥有者、且任务有 live approval 时可上传；ACL + 当前成员关系双重校验；撤权即撤产物。
- 租约：epoch 单调递增；`release` 保留 epoch（不删行），否则旧围栏值会重新有效。
- 新端点：`GET /v1/tasks`、`GET /v1/tasks/:id`、`POST /v1/tasks/:id/{decision,revoke}`、`POST /v1/artifacts/uploads`、`GET /v1/tasks/:id/artifacts`、`GET /v1/artifacts/:id/download`、`GET/POST /v1/workgroups/:id/lease`、`POST .../lease/release`。

**插件（`ds-bot/`）**

- `host/task-runner.js`（新）：审批卡、决定、三种分配、`verifyBeforeRun`（身份/cwd/工具/Guard 四项）、`runTask`、进度节流、`finishTask`、`cancelTask`、`requestTask`。
- **工具 guard 在安装期注册**：每次工具调用都问「这个 Session 是不是任务、它的授权是否仍然有效」。撤销/过期后下一次调用即被拒（N1）。
- `host/envelope.js`（新）：Hub 侧规范化序列化的副本，两边逐字节对照（`test/workgroup-task-envelope.test.js`）。
- `host/bridge.js`：outbox 项带 `frameType`；新增 `sendEvent`；`task.ok`/`task.reported`/`lease.*` 回帧；任务/审批/产物事件转给 `wg.onTaskEvent`。
- `host/hub.js`：任务/产物/租约 HTTP 方法；`socketAuth()` 多给一个 `signPayload` 闭包（私钥仍不出模组）。
- `host/state.js`：新增 `taskRequests`、`taskOutbox` 两个持久键（`adopt` 的白名单同步加上，否则重启即丢）。
- `host/channel.js`：`task-requests`（含 `active`）、`task-decide`、`task-start`、`task-finish`、`task-cancel`、`task-state`、`task-list`、`task-request`、`task-artifacts`、`artifact-download`、`group-lease`。
- **进度无端点**：唯一来源是任务 Session 的 `session/event` → `tool/call`，2 秒窗口内合并。
- **单协调者真的生效**：`groups.js` 的自动轮次先 `holdLeaseFor(room)`，取不到就不跑（本地群与离线不受影响），结束后 `releaseLeaseFor`。
- 客户端：审批卡（显示请求范围、三种分配、批准/拒绝）+ 已批准任务（开始/完成/停止），`+7` 条中文文案。

**本阶段发现并修复的真实缺陷**（都由测试逼出来，不是自查想到的）

| 缺陷 | 后果 | 修法 |
|---|---|---|
| `signedFields` 优先读信封声明的 `payloadHash` | 签名后换 payload 仍验签通过 | 改为始终按当前 payload 计算；`check-envelope` 另查两者是否一致 |
| `release` 删除租约行 | epoch 回到 1，上一任的旧围栏值重新有效 | 保留行，把 `lease_until` 推到过去 |
| `newBot` 复用新 Bot 的私聊 Session | `registerSessionOwner` 拒绝（原版域已持有）；且会把别人的请求写进该 Bot 的私人会话 | 另建任务自己的 Session |
| `startTask` 用 `record.version + 1` 报第二跳 | 记录原地自增，第二跳版本号多算 1，Hub 视为陈旧 | 改用每次 `advanceTask` 的返回值 |
| Hub 只从帧顶层读 `task.report` 字段 | 插件的 outbox 把字段放在 `payload` 里，报告全被丢 | 两处都读，且以 `payload` 为准 |
| `task.request` 事件没带请求范围 | 审批卡显示不出要批什么 | 按方案 §9.2 的字段名 `requestedResources`/`requestedCapabilities` 带上 |
| 缺 `task-finish` 端点 | 完成路径在 UI 上不可达（G4「端点无调用方」同类） | 补端点 + 补 UI 调用断言 |
| `task-start`/`task-cancel`/`task-finish`/`task-list`/`task-artifacts`/`artifact-download`/`group-lease` 都无调用方 | 与 G4 的坑一模一样：端点齐了、屏幕上没有 | 审批卡增加「你的任务」区，带开始/完成/停止；`+4` 条 UI 断言钉住 |
| 租约只有端点、没有真实调用方 | §9.5 的围栏形同虚设 | `groups.js` 的轮次先取租约、结束释放；本地群/离线不受影响；`+3` 条断言 |
| 进度只有端点、没有真实生产者 | 可被用来报告没发生过的进度 | 删端点，改由 `session/event` → `tool/call` 产生 |

## G5 补修轮（结论核对后）

对照实施书核对 G5 时发现三处「文档 PASS、运行时不可用」，均已修复。要点：

- **任务从不真正执行**：`runTask` 零调用方，`task-start` 只改状态。实测状态到 `RUNNING` 而 `followup`/`prompt` 调用数为 0。现由 `task-start` 调 `runTask`，后者复用本域已有的 `wg.deliver`。
- **`wg.deliver` 签名退化**：复制原版 `rt.deliver` 时把 `role` 硬编码成 `'room'`，使它只能服务群回合。已补回 `role` 参数，与原版同形。
- **T14 目录检查是死代码**：`record.workDirRoot` 只读零赋值。已让 `cleanGrant` 接收该字段、`decide` 记录 `rt.real` 后的根、`verifyBeforeRun` 用 `rt.sessionFolder` 取 Session 真实目录并 `realpath` 后比较。

教训记录：**"结构存在"不等于"接上了"**。三处都是写了没接，而证据矩阵只验证函数本身。补修轮给每处都补了走产品路径的断言。

## 工作群身份与邀请入口（2026-10-23）

用户报「工作群里没有邀请同事的入口」。核对出三件事：

1. **原版群设置没有邀请同事**——原版的群是本机概念，成员只能是本机 Bot；
2. **我写的邀请控件不可达**——它在 `BotPanel` 里，而该面板的 slot key 全仓只出现在注册处，没有任何导航；
3. **方案 §5.1 早已要求复制 `group-settings.js`**，并把「邀请」列为改造重点，但这份复制件从未存在。

修法（按方案，不碰原版实现）：

- 补做 §5.1 的复制：`src/workgroup/client/group-settings.js`，成员卡下方加「邀请同事」、其下加「等你处理」审批卡；
- 邀请固定显示，不可用时禁用并说明原因（不再有条件隐藏）；
- `details-drawer.js` 与 `settings.js` 各一处三元：`room.workgroup === true` 走复制件，本地群走原版；
- 未登录建工作群改为服务端拒绝；「未登录本地可用」由本地群保障；
- Hub 明文绑定非 loopback 必须显式 `HUB_ALLOW_PLAINTEXT_LAN=1`，否则启动报错（不再静默改回 loopback）。

## 成员进出与群内发言上 Hub（2026-10-23）

用户报三条，都不是 G5，而是 G4/G1 已交付部分里的缺口：

1. 邀请同事、同事同意后，只有他本人进来，管家 Bot 没跟进来；
2. 同事那边看不到群历史和实时消息；
3. 建群后再加的 Bot，管家调不动、对话没反应。

根因四处，都已修在 `src/workgroup/` 与 `hub/` 内，`src/host/` 零改动：

| # | 根因 | 位置 | 修法 |
|---|---|---|---|
| 1 | 接受邀请只插 `member_type='user'` 一行，从不加入对方的 Bot | `hub/src/workgroups/service.js` `answerInvite` | 新增 `bridge.joinWithPrimaryBot`：接受后发布并加入 `mainBotIds[0]`（团队的管家），只加一个，符合方案 §7.4「登录不等于发布全部 Bot」 |
| 2 | `addEndpointMember` 只允许 admin，刚加入的人 role 是 `member`，连自己的 Bot 都加不了 | 同上 | 拆成两条规则：加**自己的** Bot 只需是成员；加**别人的** Bot 才要 admin。与 `removeMember` 一贯的写法一致 |
| 3 | 本机 Bot 的发言从来没上过 Hub——`appendLine` 14 个调用点无一发送，Hub 的 events 表里只有人手打的字，同事拉历史自然几乎空白 | `src/workgroup/host/groups.js` | 新增 `mirrorLine`，在 `postInRound` 与 `postToGroupSession`（含 late 分支）三个真实发言点镜像；带 `hubEventId` 去重，`via:'hub'` 的行不回传，不会成环 |
| 4 | 群设置「添加成员」只发 id，`updateWorkgroup` 存成 `{id,name}`，**没有 `kind`**；`sessionFor` 与回合判定都按 `kind !== 'localBot'` 当远程处理，回合只往 Hub 发一句「你被点名了」，没人应答 | 同上 | 新增 `localMember(id, given)` 统一补齐 `kind`/`botId`/`name`；Hub 群同时把 Bot 加进 Hub 名册，Hub 拒绝则回滚本地并报错 |
| 5 | 移除成员只删本地；Hub 端点从 G4 就有却无调用方，下次 `applyRoster` 把成员读回来 | 同上 + `hub.js` | 新增 `leaveMember` 与 `removeFromHub`，`remove`/`members` 两条路径共用；**先调 Hub 再删本地**，拒绝则不删并报错 |
| 6 | `applyRoster` 的 `same` 只比 id/name/kind：同一成员这次才拿到 `membershipId` 时判为无变化，记录里始终缺这个字段，移除时无 id 可发 | 同上 | 比较扩到全部名册字段（`botId`/`endpointId`/`membershipId`/`role`/`hubUserId`） |
| 7 | **Hub 工作群里发消息根本不启动回合**：`send-hub` 只交给 Hub 就返回，`receiveRemote` 又刻意不写群 Session（防另一台机器重复开回合），两条都对，叠起来没有任何成员被叫到 | `bridge.js` + `groups.js` | `apply` 加 `mine`；本机消息经 `postToSession` 走本地编辑器同一条路进群 Session；别台机器的行保持不进 |

附带修掉的两个隐性缺陷（不修则第 1 条不生效）：

- `publishBotEndpoints` 直接读 `rt.state.bots`，而 `rt.state` 要 `rt.load()` 之后才有内容——登录瞬间发布遍历到 0 个 Bot，什么都没发布；
- 同函数写 `wg.state.endpointBots`，但 `wg.load()` 会把 `wg.state` **整体替换**，先写的条目被丢弃（实测 `b` 丢失、`b2` 保留）。

`receiveRemote` 同时改为优先按 `sender.botEndpointId` 归属成员：原先只按 `userId` 匹配，同事的管家 Bot 说的话被画成同事本人的名字，@ 它还得不到人。

**一处有意的行为差异**：Hub 群里加 Bot 失败时**回滚并报错**，不是静默保留。保留下来只会活到下一次名册同步然后消失，那正是「加了 Bot 但管家还是叫不动」且毫无提示的成因。

证据：`ds-bot/test/workgroup-membership.test.js` 7 条（全走 `apiHandle`、真 `workgroup_relay`、真 `session/event`）；六处变异各自被抓（停用接受后加入→2 红；去掉 `kind` 推断→1 红；停用镜像→1 红；停用 `removeFromHub`→2 红；`same` 退回三字段→2 红；停用 `mine`→1 红）。`ds-bot` 1080 tests / 1079 pass / 1 skip / 0 fail，Hub 262 全通过，lint 0 error，`--check` 通过。

> 第 7 项是这一轮真正的根因。前六项修的是「成员怎么进群」，第 7 项是「进群之后谁被叫到」——后者缺了，前者全都不起作用。

## 跨用户对话、工具集、成员自愈、设置回写与工作动效（2026-10-25）

用户问六条。前五条是核对，第六条是新缺陷。核对结论写在下面的表里——**凡是「已复制」的都以原版同名函数为对照逐项比对**，不以「看起来能跑」为准。

### 1. 跨用户工作群的远程对话方式

链路（两端都在 `src/workgroup/host/`，`src/host/` 零改动）：

```
A 机：用户打字 → send-hub → 本机 round（relay）
      ├─ 本地 Bot           → sessionFor → 本机 Session 跑回合
      └─ 他机 Bot（remoteBot）→ deliverRemote → Hub chat.message{call:{endpointId,note,fromName}}
B 机：Hub event → bridge.apply → receiveRemote → payload.call 存在 → receiveCall
      ├─ endpointId 对自己发布的 endpoint → 是 → runCall → sessionFor → 跑该 Bot 回合
      └─ 不是自己的                       → 否 → 直接返回（同群多机只由属主机执行）
B 机回答 → postInRound → mirrorLine → Hub → A 机 receiveRemote → 日志行
```

**本轮找到并修掉的根因**：`deliverRemote` 以前发的是纯文本「「某某」, you were called in this round」，而 `receiveRemote` 刻意**不**把 Hub 来的行写进群 Session（防另一台机器重复开回合）。两条规则各自都对，叠起来就是：**指令被当成发言丢掉，被叫的 Bot 从不开跑**。原版本地群没有这个问题，因为它的回合自己调用每个成员的 Session。

修法是按**归属**拆开，而不是加特例：发言是「别人说的话」，本机无法再生成，所以只进日志；`call` 不是任何人的发言，它是**这台机器自己的回合**，所以由 `receiveCall` 变成 turn。`runCall` 不进 Hub 的调用路径（`void` 跑），否则一次模型回合会把群游标阻塞住。

### 2. 工作群 Bot 的相互对话与工具使用：是否全部复制

逐项对照原版（`src/host/groups.js` / `tools.js`）：

| 能力 | 原版 | 工作群 | 结论 |
|---|---|---|---|
| 回合循环、`@Name` 扩展、每成员回合上限 | `runRound` | `runRound` | 已复制 |
| 成员逐个发言、等待、超时、`[PASS]` | `roomTurn` | `roomTurn` | 已复制 |
| 工作中发言（step）、迟到结果、审批挂起 | `postStep`/`lateRoomReply` | 同名 | 已复制 |
| 交接（`report_back`、`sub`、工作闭环） | `handoffs.js` | `handoffs.js` | 已复制 |
| 群工具集 | `group_relay`/`read_group_chat`/`read_own_chat`/`post_to_group` | `workgroup_relay`/`read_workgroup_chat`/`workgroup_read_own_chat`/`workgroup_post` | 4/4 已复制（改名避免冲突） |
| 成员自身的全部工具（`message_bot`、`create_bot`、文件、搜索、能力…） | 共享同一运行时 | 同一运行时，无裁剪 | 已复制 |
| 群里 @ 人、被叫后接话 | `mentionsIn`/`callMembers` | 同名 | 已复制 |
| **工具是否算「开始干活」** | `QUICK_TOOLS = TEAM_TOOLS` | **原来也只有 `TEAM_TOOLS`** | **本轮修** |

最后一行是本轮第二个真缺陷。`TEAM_TOOLS` 列的是**原版**的群工具名，工作群一个都没注册（它注册 `WG_TOOLS`）。用 `TEAM_TOOLS` 判定「这个工具很快、不算开始干活」时，工作群自己的 4 个群工具全被判成「开始干活」，于是成员一调 `workgroup_relay` / `read_workgroup_chat` / `workgroup_post`，回合就认为它在忙、不再等它的回答。原版里同样三个调用是「快的」，成员保持自己的发言位。这就是用户说的「工作群 bot 的工具使用没有原版全」——不是工具少了，是**判定把它们当成了另一类**。修法：`QUICK_TOOLS = new Set([...TEAM_TOOLS, ...Object.values(WG_TOOLS)])`。

### 3. 同步群成员 + 管家 Bot 串联

新增三件事：

- **`ensureOwnBotIsIn(workgroupId)`**：连上 Hub 时对每个群执行；若该群**一个本账号的 Bot 都没有**，把自己的管家（`mainBotIds[0]`）加回去。这道闸门是刻意的——只在「一个都没有」时动手，所以**不会撤销有意的移除**（人主动移掉管家时，通常群里还有他的别的 Bot；即便没有，那也是他要的结果）。
- **`resync-members`**：同一修复的手动入口，让已经处在坏状态的群不必等重连。
- **`butler()` / `group-members` 回 `butler`**：直接回答「这是我的哪一个 Bot」。

为什么必须有自愈：`joinWithPrimaryBot` 只在 `answerInvite` 一条路径上跑。用户真实库里 `wg_6fd8512b…` 的邀请已是 `accepted`、同事的 `bot_endpoints` 是 **0 行**——那条路径永远不会再跑，名册也永远不会出现一个从没被加进去的 Bot。**这个群不会自己好**。

### 4. 群设置是否全量同步

**不是全量，本轮修了能修的那一半。** Hub 只存 `name` 和 `notice` 两个设置，其余（回复模式、管理员、工作目录、权限预设）Hub 没有列，`CREATE_FIELDS` 也按名字拒绝——它们**设计上就是本地的**。

原来的问题比「不同步」更糟：`name`/`notice` 是**单向**的。`ensureLinkedGroup` 每次把 Hub 的值抄到本地，却没人往 Hub 写；本机改名后，下一次名册读取把旧名按回去。这就是「设置改了又变回去」。修法：新增 `POST /v1/workgroups/:id/settings`（closed allow-list 只有 `name`/`notice`，owner/admin 才可改，`config_version` +1），`updateWorkgroup` 在改名/改公告后回写，Hub 拒绝则**报错而不是静默**。

### 5. 「工作群更像微信那种群聊」

这一条是判断，不是缺陷，但对齐了方向：微信式群聊 = 成员进出可见、发言人带身份、@ 有反馈、历史共享、谁在看得到、静默的人不打扰。按这个标准看当前实现：进出与身份已具备（本轮第 3 项），`@` 有反馈（本轮第 1 项），历史共享已具备（上一轮的 `mirrorLine`），在线态在名册里（`online` 字段，UI 未画——见已知缺口 18）。**还差的两点**：群内「正在输入/正在干活」的可见性（第 6 项），以及「真人可以选择不回」——现在 `openingSpeakers` 已确保真人永不被当成要回答的成员，这与微信一致。

### 6. 缺少原版那种「工作中的动效」

`src/workgroup/client/panel.js` 的聊天区只有静态日志行，**没有任何活的部件**。宿主侧其实一直是齐的：`roomWorkView` / `activityView` / `workView` 都返回原版一模一样的结构，原版的 state 路由也已经把它们并进来了（`src/host/channel.js:85`）。缺的只是工作群面板**从来没去要**。

修法：新增 `LocalWorking`，轮询本域自己的 `state` 路由（`work.rooms[roomId]`），用**原版的** `Shimmer` / `Elapsed` / `workPhrase` 渲染，位置与原版一致（日志与输入框之间）。有人干活时 700ms 一轮、没人时 2s；当前发言人用 `data-speaking` 加深；`prefers-reduced-motion` 下关闭入场动画。

### 证据

- `ds-bot/test/workgroup-membership.test.js` 13 条（新增 6 条），全走 `apiHandle` + 真 `workgroup_relay` + 真 `session/event` + 真 Hub 进程：
  - 跨用户调用往返（第 8 条）：Bob 的机器真的跑起被叫 Bot 的回合，回答经 Hub 回到 Alice 的日志；
  - 管家自愈（第 9 条）、幂等不叠加（第 10 条）、`butler` 身份（第 11 条）；
  - 改名/公告回写且不复活（第 12 条）、Hub 拒绝非设置字段与越权（第 13 条）。
- `ds-bot/test/workgroup-working.test.js` 3 条：面板真的挂载了指示器、位置正确、用了原版原语与样式、模块能加载。
- 变异验证：停用 `receiveCall` → 跨用户用例 10.7s 内红；`present.length >= 0` → 自愈用例红；`if (false)` 关掉设置回写 → 改名用例红；删掉 `h(LocalWorking…)` → 动效用例红。
- `ds-bot` 1089 tests / 1088 pass / 1 skip / 0 fail；`npm run lint` 0 error / 13 warning；`build-client.mjs --check` 通过；`git status --porcelain ds-bot/src/host/` **为空**。

### 一处需要知道的现场状况

`hub/hub/.data/hub.db-shm` 在 `git status` 里有改动，但那是 SQLite 的共享内存文件，用户自己的桌面端（Electron）正开着并持有它，`git checkout` 无法覆盖（`Device or resource busy`）。**我没有强行动它**，也没有跑任何会写这个库的东西。`hub.db` 与 `hub.db-wal` 的改动是仓库里原本就有的（staged），不是本轮产生的。

## 六条新报告的定位与修复（2026-10-25 第二轮）

用户报六条，问「确认是 G几 的任务」。结论：**全部落在 G4/G5 已交付范围内的缺陷，没有一条需要新阶段**；
六条都已修在 `src/workgroup/` 与 `hub/` 内，`src/host/` 零改动（`git status --porcelain ds-bot/src/host/` 为空）。

| # | 用户所述 | 归属 | 为什么是缺陷而不是新需求 |
|---|---|---|---|
| 1 | 邀请同事后消息没有实时更新 | **G4**（门禁 2 的另一半） | 消息确实到了本机磁盘，但 `openWorkgroup` 只读一次房间，此后没有任何东西再读 |
| 2 | 每个 Bot 要有归属标识 | **G4**（成员模型） | 成员行只有 `endpointId`，没有 owner，两台机器都画不出「谁家的」 |
| 3 | Bot 头像不能变 | **G4**（成员模型） | `lookOf()` 按 id 派生形象，名册给的是 `ep_…`，于是同一个 Bot 换个机器换个脸 |
| 4 | 不 @ 就由管理员接待 | **G4**（群设置） | `openingSpeakers` 早就是原版复制件，缺的是 `mode` 从没离开过设置它的那台机器 |
| 5 | 去掉强制带管家入群 | **G4**（成员模型） | 是我上一轮**加**的自动修复，用户不要这个行为 |
| 6 | 群设置要实时同步 | **G4**（群设置） | `name`/`notice` 上一轮已回写；`replyMode` 仍只在本地，且改了不刷新界面 |

### 逐条根因与修法

**1. 消息不实时更新（两个独立原因，都在显示侧）**

- 面板读一次就再也不读：`openWorkgroup` 调 `callWorkgroup('room')` 后就没人再读，Hub 的新行写进了
  `state.json`，屏幕上没有。修法：新增 `useLiveRoom(roomId)`，由既有的 `/api/bot/feed` push 触发重读，保留 5 s 兜底轮询（历史实现曾每 1.2 s 轮询）。
  **只在 `roomSignature` 真的变了才写 store**（否则每 tick 重建一次 transcript），离开群即停。
- 别家 Bot 的发言从不进群 Session：`receiveRemote` 有一条正确规则「Hub 来的行不写群 Session」，因为它
  会触发第二次回合。但这条规则同时把同事 Bot 的话挡在了用户阅读的那个聊天面之外。修法：按**角色**拆开而不
  是按来源——这条行以 `role: 'remote'` 写进群 Session，`cells.js` 照常画它，`relayStream` 的 `opens`
  判定里没有 `remote`，所以它只是历史，不是回合的引子。

**2. Bot 归属标识**

Hub 的 `publicMember` 补 `ownerUserId` / `botRole`，群详情再补 `ownerIsYou`（**在 Hub 侧按认证连接算**，
客户端不能自称）。本地成员记录补 `ownerUserId` / `mine` / `botRole`，成员列表画「你的 / 同事的」。

**3. 头像会变**

`bot_endpoints` 加 `avatar` 列，发布时带上 `lookOf(bot)` 的结果（形状名 + 调色板名 + 可选照片 data URL），
名册把它还原到成员记录上。**必须按 `lookOf()` 读取的方式拆开**：形状和照片在 `avatar`，颜色在记录本身的
`color`——三项全塞进 `avatar` 会让颜色继续按 `ep_…` 派生，等于换个地方犯同一个错。本机自己的 Bot 仍然用
`roster.byId` 里的活记录，快照不会覆盖它。

**4. 管理员接待（不 @ 时）**

Hub `workgroups` 加 `reply_mode`（默认 `'admin'`，与原版 `buildRoom` 一致），`SETTINGS_FIELDS` 从
`{name, notice}` 扩到 `{name, notice, replyMode}`。`updateWorkgroup` 在 `mode` 真的变了时回写；`applyRoster`
读回并写进 `room.mode`——**在 `same` 提前返回之前读**，否则「只有设置变了、成员没变」这一种情况恰好被
提前返回吃掉。回合本身不用改：`openingSpeakers` 一直是原版的复制件。

**5. 去掉强制管家入群**

删掉两处自动添加：`answerInvite` 接受邀请后不再 `joinWithPrimaryBot`；连接时的 `ensureOwnBotIsIn` 不再
补人（方法保留，因为 `channel.js` 与测试按名字调用它，现在只报告不再修改）。加 Bot 的能力没有消失，只是
**决定权回到人**：`joinWithPrimaryBot` 仍是添加端点用的那一个，从群成员列表调用。

至于「每个 bot 的权限由群设置」，**我第一版做错了**：给 `memberships` 加了一个 `bot_role`
（`lead` / `member`），那是原版没有的概念，而且它没有写入方，恒为 `'member'`。用户指出方向：
「原版群聊是如何做的，那么工作群和工作群跨用户 bot 也是这么做，只是工作群需要远程同步」。核对原版
`src/host/permissions.js` 后确认原版是**两层的、没有「每个 Bot 的角色」**：

```
bot.permission     Bot 自己的预设
room.permission    整个群共用一个预设，覆盖每个成员的
缺席               各成员用自己的（applyPermission：room?.permission ?? bot.permission）
```

工作群早就复制了这一整套（`updateWorkgroup` 调 `rt.setRoomPermission`，`sessionFor` 调
`rt.applyPermission(…, { permission: room.permission })`，设置页有「Same for every member」那张卡）。
缺的只有**远程同步**。所以改为：`workgroups.permission`（原版字段的远程副本，NULL = 各用各的），
并用迁移 v6 **删掉** `bot_role`。

**6. 群设置实时同步**

`replyMode` 现在与 `name`/`notice` 走同一条回写路径（`POST /v1/workgroups/:id/settings`），Hub 广播
`member.changed`，各机器 `syncRoster` 时连同 `replyMode` 一起读回。界面侧的新读靠第 1 条的 `useLiveRoom`。

### 证据

Hub 迁移 **v5**（三条 `ALTER TABLE ... ADD COLUMN`，全部带默认值，G5 Hub 原地升级）：

```
-- v5（做成员归属、头像、谁先答）
ALTER TABLE workgroups   ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'admin'
ALTER TABLE bot_endpoints ADD COLUMN avatar TEXT
ALTER TABLE memberships  ADD COLUMN bot_role TEXT NOT NULL DEFAULT 'member'   ← 自造，v6 删除

-- v6（Bot 权限改用原版模型，并清掉 v5 的自造字段）
ALTER TABLE workgroups   ADD COLUMN permission TEXT                            -- 原版 room.permission
ALTER TABLE memberships  DROP COLUMN bot_role

-- v7（管理员是「群主的 Main Bot」，由群主机器指定一次）
ALTER TABLE workgroups   ADD COLUMN lead_membership_id TEXT
  REFERENCES memberships(id) ON DELETE SET NULL
```

- `hub`：262 tests / 262 pass / 0 fail。三条锁定列清单的旧断言更新为新契约
  （`db-g5-schema`、`bot-endpoints`、`upgrade-no-history`），因为它们钉的是「第 4 版是最后一版」。
- `ds-bot`：1092 tests / 1091 pass / 1 skip / 0 fail；`lint` 0 error / 13 warning；`build-client.mjs --check` 通过。
- `test/workgroup-membership.test.js` 14 项，其中新增/改写 5 项，全部走 `apiHandle` + 真 Hub 进程：
  - 「接受邀请只加人，Bot 由人自己加」——`resync-members` 现在返回 `added: []`；
  - 「每个 Bot 名册里带归属，只有主人被告知 `yours`」（同时断言本地成员记录的 `mine`）；
  - 「远端的 Bot 保留主人发布的头像」——用主人本机加载后的记录算期望值，不是 fixture 字面量；
  - 「回复模式在一台机器改了，另一台读回同一个值」，并断言未知值被拒；
  - 旧的「Hub 拒绝 `mode`」改为「Hub 拒绝 `permission`」，因为 `replyMode` 已经不是被拒字段。
- `test/workgroup-working.test.js` 新增 1 项：`useLiveRoom` **被挂载**（匹配调用行，不是同名函数定义）、
  只重读 `room`、靠 `roomSignature` 决定是否写 store、且只写仍在屏上的那个群。
- 变异验证（改完立刻还原）：
  - `modeChanged = false` → 回复模式用例红；
  - 删掉 `useLiveRoom(roomId)` 调用 → 实时用例红（**第一次变异没红**，因为断言匹配到了
    `export function useLiveRoom(`；改成 `^\s+useLiveRoom\(roomId\)$` 多行匹配后才真正守住）；
  - 丢掉头像快照 → 头像用例红；
  - 丢掉 `mine: true` → 归属用例红（**第一次也没红**，因为当时只断言了 Hub 的 `ownerIsYou`；
    补上本地成员记录的断言后才守住）。

### 这一轮学到的（已落成断言）

**断言必须钉住「接通」而不是「存在」。** 两处变异第一次都没红，都是因为断言匹配到的是注释、定义或
Hub 字段，而不是产品路径上真正生效的那一行。和 G5 补修轮的教训同一条：结构存在不等于接上了。

## 管理员归属：工作群的 Main Bot 是群主的（2026-10-25 第三轮）

用户指出：「工作群的 Main Bot 是群主的管理员/Main Bot」。这一条推翻了我上一轮「这是原版模型的固有局限、
待定」的判断——它是个真缺陷，而且底下还压着一个死代码。

### 三处根因

**1. `ownerMember` 是死代码（真正的 bug）**

```js
const owner = roster.find(member => member.role === 'owner')
const ownerMember = owner === undefined || owner.memberType !== 'botEndpoint'
  ? undefined
  : answerable.find(member => member.endpointId === owner.endpointId)
```

`owner` 是名册里**人**的那一行（`role === 'owner'`），它的 `memberType` 永远是 `'user'`。所以
`owner.memberType !== 'botEndpoint'` **恒为真**，`ownerMember` 永远是 `undefined`——「群主的 Bot 领队」
这条规则从写下那天起就从未执行过。群主的 Bot 是**另一行**（`memberType === 'botEndpoint'`，带
`ownerUserId`），要按 `ownerUserId` 找。

**2. `rt.isMain` 问的是「这台机器」**

`mainBot = answerable.find(member => rt.isMain(member.botId))`，而 `answerable` 只含 `localBot`。
`rt.isMain(id)` = `state.mainBotIds.includes(id)`——**本机**的 Main Bot 列表。于是：

| 机器 | 选中的人 |
|---|---|
| Alice（群主） | Alice 的 Main Bot ✅ |
| Bob（同事） | **Bob 的** Main Bot ❌ |

同一个群在两台机器上有两个管理员，`mode: 'admin'` 的回合于是问了不同的人。

**3. Hub 从来不知道谁是 Main Bot**

`mainBotIds` 是每台机器自己的概念，从没上传过。Hub 只知道账号和 endpoint。

### 修法（v7）

由**群主那台机器**——唯一知道答案的机器——在建群时把答案告诉 Hub：

```sql
ALTER TABLE workgroups ADD COLUMN lead_membership_id TEXT
  REFERENCES memberships(id) ON DELETE SET NULL
```

- 建群：`POST /v1/workgroups` 带 `leadEndpointId`（群主 `mainBotIds[0]` 对应的 endpoint），Hub 存成
  `memberships.id`。**用 membership 而不是 endpoint id**：同一个 Bot 在主人机器上是本地 id、在别人机器上
  是 `ep_…`，而 membership 是「这个人在这一个群里的身份」，两台机器都认。
- 读名册：`applyRoster` 优先用 `leadMembershipId` 命中的成员，**两台机器解析到同一个 membership**。
- 改设置：`POST /v1/workgroups/:id/settings` 接受 `leadMembershipId`（`null` = 清空），只接受本群的、
  在籍的 Bot endpoint。
- 回退链保留且**仍然必要**：没有 lead（老群、或 lead 已退出）→ 群主自己的 Bot → 本机 Main Bot →
  第一个可答成员 → 原 adminId。老群不会因为没这个字段就选不出人。

### 一个必须显式处理的边界

`ON DELETE SET NULL` **不会在成员退出时触发**——退出是 `status='left'`，行还在（审计要留名字）。所以
`removeMember` 里显式清空；否则群一直指着一个已经不在群里的人，每次回合都去问一个退出的 Bot。

清空之后 `adminId` 不能被留成 `null`：`applyRoster` 只在「名册变了」时重算，而清空 lead 的群成员一个没变。
所以 `updateWorkgroup` 当场按本地规则重新解析（本机 Main Bot → 第一个可答成员），而不是等下一次读。

### 证据

- `ds-bot` **1101 tests / 1100 pass / 1 skip / 0 fail**（串行全量；并行一次为 1099/1/1，唯一失败是既有
  `work-dir.test.js` 的 2 s 时序断言，单独与串行均通过）
- `hub` 263 tests / 263 pass
- `test/workgroup-membership.test.js` 新增 2 项（lead 主链路），全走 `apiHandle` + 真 Hub：
  - 「群管理员是群主的 Main Bot，两台机器一致」：断言 Hub 记录了 lead、**Bob 的机器解析到同一个
    `membershipId`** 且该成员在那边是 `remoteBot`；再断言移除 lead 后 Hub 列被清空。
  - 「Hub 上没有 lead 时，群主自己的 Bot 仍然领队」：先把第二个 Bot 设成 lead，再清空，断言回到 Chief
    而不是刚被取消的那个——这条也钉住了「清空 = 回到规则，不是没有人」。
- 变异验证（改完立刻还原）：
  - 去掉 `leadCleared` 的显式清空意图 → 用例红；
  - 把 `hubLead` 从回退链首位挪走 → 用例红。
- 真实库副本升级检查：`before v7 → applied (none)`，列齐全，2 个群 / 14 个成员数据完整。

### 旧群回填：v7 字段存在，但老群永远是 null（2026-10-25 第四轮）

建群与改设置会写 lead，可**字段出现之前建的群**两条路径都没走过，`lead_membership_id` 永远是 `null`，
每次读名册仍退回本机 `rt.isMain`——也就是 v7 本要消灭的分歧，在老群上原样保留。

修法仍按原版的责任划分，不新增概念：**群主那台机器**在 `syncRoster` 读到
「Hub 无 lead + 本机是群主 + 本机 `mainBotIds[0]` 是该群一个 active Bot endpoint」时，补写一次
`leadMembershipId`。条件与建群完全相同；不做轮询，成功后 Hub 已有答案，条件自然为假。失败只 warn，
名册照常应用并走原回退链。`applyRoster` 不背网络写请求。

`test/workgroup-membership.test.js` 18–22 共 5 项，覆盖：

1. 群主机器补写一次，Hub 与本地 `adminId` 都指向本机 Main Bot，第二次同步不再写；
2. 非群主机器不发请求，Hub 仍为 null，本地走回退链；
3. Hub 已有 lead（别人的选择）时绝不覆盖；
4. 本机 Main Bot 不在群内时不发请求；
5. 补写失败不阻断名册读取，本地仍有可答的 admin。

本轮另行做了一次“先红后绿”：未改 `syncRoster` 时第 1/2/3/5 项即失败；第 4 项当时就绿，是既有的安全
分支，保留作回归钉。

### 仍然如此的部分

`mainBotIds` 依旧不上传——它是每台机器自己的事实，不该上 Hub。上 Hub 的只是「本群由哪个成员领队」这一个
决定的结果。原版的 `defaultAdmin` 规则在**本地群**里仍然逐字未改。群主机器若长期离线，老群的 lead
会等到它下一次同步才补上；在此之前各机器仍用原回退链，不会因此不可用。

## 发布包：host 引用了没被打包的 client 源（2026-10-25 第四轮）

`src/workgroup/host/bridge.js` 为“发布 Bot 外观快照”引用 `../../client/characters.js`，但
`ds-bot/package.json` 的 `files` 没有 `src/client/`。源码树里能跑，发布包里缺文件；工作群域 install
抛错并被 `index.js` 兜住，于是 **`/api/workgroup` 根本没注册，所有 Hub 调用（含登录）404**，本地 Bot
团队却一切正常。

- 修法：`files` 增 `"src/client/"`，让发布目录与源码一致；不复制函数、不造第二份真相。
- `test/package-files.test.js`：从 `index.js` 与 `src/workgroup/index.js` 遍历**宿主实际加载的相对 import
  图**，断言每个文件都被 `files` 覆盖。先红（缺 `characters.js`、`inks.js`），加清单后转绿。
- `npm pack --dry-run --json` 复核：139 files；`src/client/characters.js`、`src/client/inks.js`、
  `src/workgroup/host/bridge.js` 全部存在。
- **尚未生效的最后一公里**：正在使用的 `app/node_modules/ds-bot` 是安装副本，仍缺 `src/client/`。
  按约定本轮**未动 app 依赖、未重启**；维护者需在 `app/` 重装后重启应用，登录 404 才会真正消失。
  验收标志：该副本出现 `src/client/characters.js`；日志不再有 `the Workgroup domain is unavailable`；
  带 token 的 `POST /api/workgroup` 返回 JSON 而非 404。

## 已知缺口

| # | 缺口 | 为什么现在不做 | 谁决定 | 何时回看 |
|---|---|---|---|---|
| 1 | ~~诊断页不显示工作群状态~~ | — | — | 已闭环（G3） |
| 2 | 完整技术拆解文档集（15 份）未撰写 | 优先把代码与门禁做实 | 待定 | G5 前 |
| 3 | ~~`workgroup-ux` 的清单断言指向~~ | — | — | 已闭环（G3） |
| 4 | ~~工作群记忆只读缝~~ | — | — | 已闭环（G3） |
| 5 | 冒烟测试未跑（需 DSH checkout） | 本环境不具备 | 待定 | 有环境时 |
| 6 | 桌面应用未实机验证（T20） | 需重装 `app/` 包文件并启动窗口 | 维护者 | 人工验收时 |
| 7 | 凭据只做到 0600 文件，不是 OS 钥匙串 | 插件宿主取不到 `safeStorage`，与最小依赖冲突 | 源仓库已决定 | G6 |
| 8 | 手机号未经验证，只是登录名 | 认证方式定为手机号 + 密码，无短信 | 源仓库已决定 | 长期 |
| 9 | **门禁 1（两台真机）与门禁 6（观感对照）无自动化证据** | 只能人工判定 | 维护者 | 交付前 |
| 10 | ~~附件只到「聊天附件」~~ **已做**：`artifacts` 表 + `/v1/artifacts/uploads`、`/v1/artifacts/:id/download`、`/v1/tasks/:id/artifacts` | G5 完成；与 G4 的 `attachments` 并存不合并 | 已定 | 已关闭 |
| 11 | ~~跨用户 Bot 委派/审批、`round_leases`~~ **已做**（G5）；**群记忆跨机传输自动化已做**：原版引擎 + `memory.change`，人工项 G6-M1 仍 BLOCKED | 原版有引擎、无传输 | 已定 | G6R |
| 12 | ~~`workgroup_deliverRemote` 的 Bot 侧执行未接~~ **已做**：`task.request` 到达后由 B 本机 `task-runner.js` 承接，经 B 本人的审批 | G5 门禁 1/2 的核心 | 已定 | 已关闭 |
| 13 | 面板的成员列表在 Hub 离线时为空（不缓存） | 避免把过期名单当成事实；离线仍可看日志 | 本轮决定 | 需要时加缓存 |
| 14 | 附件选择用浏览器 `FileReader`，只在客户端可用；宿主侧无独立上传入口 | 与 G3 一样，文件由 UI 提供 | 本轮决定 | 需要 CLI 上传时 |
| 15 | `dev/bench.sh smoke` 未跑 | 沿用 G3 阻塞 | 待定 | 有环境时 |
| 16 | **人员没有显示名**：Hub `users` 表无 `display_name`，成员行显示打码手机号 | 加列属账号模型变更，且要处理两台机器一致 | 待定 | 需要「显示真实姓名」时 |
| 17 | ~~已读游标客户端未写~~ | — | — | **已闭环（第 5 轮）** |
| 18 | ~~成员在线状态未做~~ | — | — | **已闭环（第 5 轮）** |
| 22 | ~~回复模式不同步到其他机器~~ **已做（2026-10-25）**：`workgroups.reply_mode` + `SETTINGS_FIELDS` 加 `replyMode`，两台机器读同一个值 | — | — | 已闭环。权限预设也已同步（`workgroups.permission`）；**工作目录仍只在本机**，它是本机路径，不能上 Hub |
| 23 | 群内「谁正在看」未画（Hub 名册有 `online`，UI 未用） | 微信式群聊会显示，但需要一条成员级订阅而非每次拉名册 | 待定 | 第 5 项跟进时 |
| 24 | 动效只在「本机在跑」时可见；别的机器上的成员干活，本机看不到 | `roomWorkView` 是**本进程**的 `live` 表，跨机活动态要新的事件类型（`presence.working`） | 待定 | 第 6 项跟进时 |
| 25 | ~~管理员每台机器自己算~~ **已解决（v7）**：`workgroups.lead_membership_id`，由群主机器建群或改设置时指定；**老群由群主机器在 `syncRoster` 幂等回填**，各机器读同一个答案 | — | — | 已闭环（含老群回填） |
| 26 | 成员列表由 feed push 触发重读，5 s 兜底轮询 | 复用既有 `/api/bot/feed`；不新造浏览器传输 | G4 后续实现 | 若兜底轮询成为瓶颈再评估 |
| 27 | **app 安装副本仍缺 `src/client/`**：源码与发布清单已修，但 `app/node_modules/ds-bot` 未重装，正在跑的应用仍会工作群域加载失败→登录 404 | 用户选择本轮不动 app 依赖、不重启 | 用户，2026-10-25 | 下次启动应用前，在 `app/` 重装并重启 |

## 第 4 轮自查修复（2026-10-22）

核对「G4 是否全部完成」时发现 5 个**产品级**缺陷：文档把「宿主端点存在」当成了「功能接通」。全部由运行时实测确认并修复，详见 `g4/ROUND-LOG.md` 第 4 轮与 `gates.md` 的 F1–F5 一节。

| # | 缺陷 | 现状 |
|---|---|---|
| F1 | Bridge 生产代码从未启动 | 已修：登录/注册/`hub-state` 自动连接；`connect()` 等 `hello` 才返回 |
| F2 | UI 建群不产生 Hub 群 | 已修：`create-room` 已登录时走 Hub（发布 endpoint + 建群 + 同步名册） |
| F3 | `wg.deliverRemote` 未定义，远程成员被静默跳过 | 已修：`bridge.deliverRemote` 定义并挂载 |
| F4 | 远端消息作者丢失；Hub 行触发本地 relay 回环 | 已修：`applyRoster`/`syncRoster` 同步名册；`receiveRemote` 不再写群 Session |
| F5 | 6 个端点无界面 | 已修：邀请收件箱、附件下载、发布端点按钮 |

**教训（已落成断言）**：原测试全部自己调用 `bridge.start()`，所以「测试绿」不能证明「产品可用」。新增 `workgroup-e2e.test.js` 只用 `apiHandle`（客户端唯一的门）。

## 第 5 轮核对（2026-10-22）

再次核对指令 §2/§5/§7 与代码，发现两项**属 G4 明文范围**但产品路径缺失，按缺陷处理并修复：

| # | 缺口 | 现状 |
|---|---|---|
| G1 | 已读/未读游标无调用方（Hub 有表与帧，宿主无端点，面板不写不显示） | 已修：`mark-read` 端点 + 面板徽标 + 打开群即写游标；Hub `read_cursors` 落库 |
| G2 | 逐成员在线状态不存在 | 已修：`ws.onlineUsers()` + 群详情 `online`；面板在线点 |
| G3 | **发送者看不到自己发的消息**（Hub 不回显 + 插件 ack 不落本地日志） | 已修：`ack.ok` 时应用本机事件，按 `eventId` 去重 |

证据：`test/workgroup-read.test.js` 4 项。实测 `unread 2 → 0`、Hub `last_read_seq=2`、在线 `2 → 1`。

| 19 | ~~符号链接指向批准目录之外未被自动验证~~ **已解决**：`decide` 与 `verifyBeforeRun` 两侧都走 `rt.real`，判定按解析后路径 | 补修轮完成；真实文件系统上建链接的复现仍在 `manual-checklist.md` G5-T14 | 已定 | 已关闭 |
| 20 | **任务审批卡不显示请求方手机号**（只显示名册里的名字，没有则留空）：Hub 的 `users` 表无 `display_name` | 与缺口 16 同源；不引入 OTP/昵称 | 已定 | G6 |
| 21 | **真机执行归属未验**：自动化证明「B 本机建了任务 Session、装上了 guard」，但「确实在 B 的物理机器上跑模型」只能人工 | 需两台机器 | 已定 | 人工 |

## 决定记录

| 日期 | 决定 | 来源 |
|---|---|---|
| 2026-10-22 | 交付水位 G3，G4+ 不在本次 | 需求文档决策 11 |
| 2026-10-22 | Hub 作为独立服务端放在 `BotCode/hub/` | 需求文档决策 12 |
| 2026-10-22 | 不发版，版本保持 0.2.0 | 需求文档决策 14 |
| 2026-10-22 | 客户端按 `team-actions.js` 架构适配 | 实施计划 §7 调整 1 |
| 2026-10-22 | 源文档冻结，本仓库文档为唯一真相 | 需求文档决策 5 |
| 2026-10-22 | G4 附件另建任务无关的 `attachments`/`attachment_tickets`，`/v1/artifacts/*` 留给 G5 | 本轮口径（指令 §2 与 §5 冲突时的取舍，已确认） |
| 2026-10-22 | 建群/升级**不写**合成事件，让「升级后事件数为 0」保持可测 | 本轮决定 |
| 2026-10-22 | 握手支持首帧认证（`?auth=frame`），不引入 `ws` 依赖 | 本轮决定：插件只有 `esbuild` 一个构建依赖 |
| 2026-10-22 | 消息去重以日志行的 `hubEventId` 为准，内存集合只是加速 | 本轮决定：跨重启必须仍去重 |
| 2026-10-22 | 远程成员 `sessionFor` 返回 `undefined`（不抛错），回合交 bridge | 本轮决定：抛错会被 UI 报成「Bot 失败」 |
| 2026-10-22 | 升级四态记录在 `wg.state.links` 的同一行（加字段），不新建存储 | 本轮决定：G1 的 state 格式保持可读 |
| 2026-10-22 | G5：任务/审批/产物事件**占用群内 `seq`**，与 `chat.message` 共序 | `g5/DESIGN-CHANNEL-AND-SEQ.md` 决定 1；B 可能离线，审批请求必须能补投 |
| 2026-10-22 | G5：未读数由「游标差」改为「`chat.message` 条数」 | 决定 1 的连带改动；否则审批与进度会被算成未读 |
| 2026-10-22 | G5：发起任务走 WSS `task.request`，不设 `POST /v1/tasks` | 决定 2；方案 §13.1 只给 `decision`/`revoke`，复用 G4 outbox 幂等 |
| 2026-10-22 | G5：`task.request` 的信封签名覆盖 payload hash、target、有效期、协议版本；sender 由连接决定 | 方案 §9.2 明文要求，不可只检查字段存在 |
| 2026-10-22 | G5：Hub 记录**不等于**授权；可执行 = DSH 权限 ∧ B 本地授权 ∧ 路径/范围 ∧ OS 隔离 | 方案 §10.3/§10.4 |
| 2026-10-22 | G5：租约 `release` 保留 epoch，不删行 | 本轮发现：删行会让旧围栏值重新有效 |
| 2026-10-22 | G5：`newBot` 模式另建任务 Session，不复用新 Bot 的私聊 Session | 本轮发现：复用会被 `registerSessionOwner` 拒绝，且会污染该 Bot 的私人会话 |
| 2026-10-22 | G5：任务进度在插件侧 2 秒窗口内合并 | `events` 是每个客户端都要补拉的表，不节流会无限增长 |
| 2026-10-25 | 接受邀请只加人，**不再**自动带管家 Bot 入群；加哪个 Bot 由人决定 | 用户口径：去掉强制要求携带管家 bot 入群的限制，每个 bot 的权限由群设置 |
| 2026-10-25 | `replyMode` 与 `permission` 上 Hub；**工作目录仍留在每台机器** | 群的运作方式必须两台一致；工作目录是本机路径，Hub 绝不能知道（方案 §13.2） |
| 2026-10-25 | Bot 的 `avatar` 以**快照**形式上 Hub，而不是让对方按 id 派生 | 原版 `lookOf()` 按 id 派生；名册给的是 `ep_…`，只能传快照 |
| 2026-10-25 | ~~`memberships.bot_role`~~ **已废弃（v6 删除）**，Bot 权限改用原版 `room.permission` 的远程副本 | 用户口径：原版怎么做的，工作群就怎么做，只加远程同步。原版没有「每个 Bot 在群里的角色」，权限是两层模型 |
| 2026-10-25 | 管理员（`workgroups.lead_membership_id`）由**群主机器**建群时指定一次，各机器读同一个答案 | 用户口径：「工作群的 Main Bot 是群主的管理员/Main Bot」。`rt.isMain` 问的是本机 `mainBotIds`，两台机器各算各的必然分歧 |
| 2026-10-25 | 老群 lead 由群主机器在 `syncRoster` 幂等回填，不轮询、不阻塞名册 | 否则字段出现之前建的群永远为 null，v7 的修复对它们不生效；回填判据与建群完全相同 |
| 2026-10-25 | lead 存的是 `memberships.id`，不是 endpoint id | 同一个 Bot 在主人机器上是本地 id、在别人机器上是 `ep_…`；membership 是「这个人在这一个群里的身份」，两边都认 |
| 2026-10-25 | `mainBotIds` 仍然不上传 | 它是每台机器自己的事实；上 Hub 的只是「本群由哪个成员领队」这个决定的**结果** |
| 2026-10-25 | `workgroups.permission` 的 `null` 是**值**不是缺省 | 原版「各用各的」就是删掉 `room.permission`；Hub 永远返回该键，`null` 才可区分「这台机器上关掉了」与「你的 Hub 没有这个设置」 |
| 2026-10-25 | 发布包加 `src/client/`，并用宿主 import 图自检 | host 的 `bridge.js` 实际 import `src/client/characters.js`；只改源码不改清单会让发布包工作群域加载失败、Hub 登录 404 |
| 2026-10-25 | 本轮不动 `app/node_modules`、不重启应用 | 用户选择先交付源码；生效步骤与验收标志已记入缺口 27 |
| 2026-10-25 | 面板刷新改用既有 `/api/bot/feed` 推送；5 s 轮询只作断流兜底，不再新增浏览器传输 | 同一宿主已有一条 SSE；工作群保存发 `workgroup` 事件，重读仍走 `apiHandle`，Hub 仍是唯一数据源 |

## 下一步：G5

- 续接指令：[`g5/NEXT-INSTRUCTION.md`](g5/NEXT-INSTRUCTION.md)（自足，可直接整段复制给新会话）
- 轮次日志：[`g5/ROUND-LOG.md`](g5/ROUND-LOG.md)
- **复制基线（已核对）**：[`g5/COPY-BASELINE.md`](g5/COPY-BASELINE.md) —— 原版 17 个群函数在工作群侧 17/17 有对应；原版 `src/host/` 零改动；G5 改造全部落在 `src/workgroup/` 内，**不需要先做复制迁移**
- **设计决定（已定）**：[`g5/DESIGN-CHANNEL-AND-SEQ.md`](g5/DESIGN-CHANNEL-AND-SEQ.md) —— 任务事件占群 `seq`；发起走 WSS `task.request`
- G5 范围：跨用户 Bot 委派与本人审批、三种分配、真实 Task Session 执行、租约、任务产物（`artifacts`）。

## 下一步

1. **让发布修复在用户机器上生效**：在 `DeepSeek-Bot-main/app/` 重装依赖并重启应用。验收：`app/node_modules/ds-bot/src/client/characters.js` 存在；日志不再出现 `the Workgroup domain is unavailable`；带 token 的 `POST /api/workgroup` 返回 JSON 而非 404。
2. 人工执行 `manual-checklist.md`：门禁 1（两台真机）、门禁 5 目视、门禁 6 对照、T20 冷启动、**G5 门禁 2 真机一半、G5-N3、G5-T14 符号链接**。
3. G6：群记忆（`group_memories`）、重启恢复、完整验收与交付。
4. 缺口 16、23、24（人员显示名、谁正在看、跨机工作态）按需排期。
5. 有 DSH checkout 时补跑 `dev/bench.sh smoke`。
