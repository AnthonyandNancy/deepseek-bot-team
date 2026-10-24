
# 进度台账与缺口登记

- 日期：2026-10-22
- 水位：**G5 完成**（方案 §14 的 5 条门禁有自动化证据；新增 N1/N2 通过；N3 与门禁 2 的真机一半待人工），未发版
- 2026-10-23 补：**群内 Bot 交接**（方案 §5.1 的 `host/handoffs.js` 复制件）此前缺失，现已补上；属 G1 复制缺口，非 G5 范围

## 进度台账

| 阶段 | 状态 | 证据 | 备注 |
|---|---|---|---|
| G0 环境与基线 | 通过 | 基线 832 tests 全绿；`docs/plans/...-implementation-plan.md` §8 | 与源 G0 结论一致 |
| G1 域复制与双群共存 | 通过 | `workgroup-isolation`、`workgroup-round`、`workgroup-files` | 复制而非重写；`groups.js` 等原版核心零改动 |
| G2 Task Session 与工具级安全 | 通过 | `workgroup-round`、`capabilities`/`tools` 补丁 | 工具作用域按域分流 |
| G3 Hub 账号与设备 | 通过 | `hub-store`、`hub-client`、`hub-account-switch`、`hub-offline`；Hub 侧 123 测试 | 认证为手机号 + 密码，无 OTP |
| G4 双机实时群聊与升级 | **自动部分通过（含 2 轮自查修复）** | `gates.md` 的门禁 2/3/4/5 + G4-A1..A19 + F1–F5 + G1–G3；hub 190 / ds-bot 990 | 门禁 1/6 与 T20 待人工；不发版 |
| G5 跨用户委派与本人审批 | **自动部分通过（含补修轮）** | `g5/EVIDENCE-MATRIX.md`；hub 256 / ds-bot 1033 | 门禁 2 真机一半、N3 待人工 |
| 人工验收 | 待执行 | `manual-checklist.md` | 由维护者执行 |
| 发版 | 未执行 | 版本仍 0.2.0 | 需求明确不发版 |

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
| 11 | ~~跨用户 Bot 委派/审批、`round_leases`~~ **已做**（G5）；**群记忆跨用户检索（G6）仍未做** | 委派与审批在 G5 完成 | 已定 | G6 |
| 12 | ~~`workgroup_deliverRemote` 的 Bot 侧执行未接~~ **已做**：`task.request` 到达后由 B 本机 `task-runner.js` 承接，经 B 本人的审批 | G5 门禁 1/2 的核心 | 已定 | 已关闭 |
| 13 | 面板的成员列表在 Hub 离线时为空（不缓存） | 避免把过期名单当成事实；离线仍可看日志 | 本轮决定 | 需要时加缓存 |
| 14 | 附件选择用浏览器 `FileReader`，只在客户端可用；宿主侧无独立上传入口 | 与 G3 一样，文件由 UI 提供 | 本轮决定 | 需要 CLI 上传时 |
| 15 | `dev/bench.sh smoke` 未跑 | 沿用 G3 阻塞 | 待定 | 有环境时 |
| 16 | **人员没有显示名**：Hub `users` 表无 `display_name`，成员行显示打码手机号 | 加列属账号模型变更，且要处理两台机器一致 | 待定 | 需要「显示真实姓名」时 |
| 17 | ~~已读游标客户端未写~~ | — | — | **已闭环（第 5 轮）** |
| 18 | ~~成员在线状态未做~~ | — | — | **已闭环（第 5 轮）** |

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

## 下一步：G5

- 续接指令：[`g5/NEXT-INSTRUCTION.md`](g5/NEXT-INSTRUCTION.md)（自足，可直接整段复制给新会话）
- 轮次日志：[`g5/ROUND-LOG.md`](g5/ROUND-LOG.md)
- **复制基线（已核对）**：[`g5/COPY-BASELINE.md`](g5/COPY-BASELINE.md) —— 原版 17 个群函数在工作群侧 17/17 有对应；原版 `src/host/` 零改动；G5 改造全部落在 `src/workgroup/` 内，**不需要先做复制迁移**
- **设计决定（已定）**：[`g5/DESIGN-CHANNEL-AND-SEQ.md`](g5/DESIGN-CHANNEL-AND-SEQ.md) —— 任务事件占群 `seq`；发起走 WSS `task.request`
- G5 范围：跨用户 Bot 委派与本人审批、三种分配、真实 Task Session 执行、租约、任务产物（`artifacts`）。

## 下一步

1. 人工执行 `manual-checklist.md`：门禁 1（两台真机）、门禁 5 目视、门禁 6 对照、T20 冷启动、**G5 门禁 2 真机一半、G5-N3、G5-T14 符号链接**。
2. G6：群记忆（`group_memories`）、重启恢复、完整验收与交付。
3. 缺口 16–18（人员显示名、已读游标 UI、成员在线状态）按需排期。
4. 有 DSH checkout 时补跑 `dev/bench.sh smoke`。
