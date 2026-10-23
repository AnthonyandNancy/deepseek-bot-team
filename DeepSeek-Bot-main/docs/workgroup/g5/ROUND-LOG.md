# G5 轮次日志

> 每轮追加一节：日期、本轮目标、改了哪些文件、验证结果、遗留问题。用于换人/中断后接续。

## 2026-10-22 · 起点

- 状态：未开始
- 已完成：G4（自动门禁 2/3/4/5 通过；门禁 1/6 与 T19/T20 待人工）。见 `../gates.md`、[`../g4/EVIDENCE-MATRIX.md`](../g4/EVIDENCE-MATRIX.md)、[`../g4/ROUND-LOG.md`](../g4/ROUND-LOG.md)
- 下一步：按 [`NEXT-INSTRUCTION.md`](NEXT-INSTRUCTION.md) 的「建议顺序」第 1 步开始（Hub 数据模型：迁移 v4 建 `tasks`/`approvals`/`round_leases`/`artifacts`）
- 阻塞：无
- 复制基线（已核对，无需再做）：[`COPY-BASELINE.md`](COPY-BASELINE.md) —— 原版 17 个群函数 17/17 有对应，原版 `src/host/` 零改动
- 已定设计（开工前必读）：[`DESIGN-CHANNEL-AND-SEQ.md`](DESIGN-CHANNEL-AND-SEQ.md)
  1. `task.*`/`approval.*`/`artifact.*` **占群内 `seq`**（连带：未读数改为 `chat.message` 计数）；
  2. 发起任务走 **WSS `task.request`**，批准/撤权走 HTTP（方案 §13.1 只给了这两个）。
- 开工前必读的两个坑（G4 第 4、5 轮）：
  1. 端点写了没有调用方；
  2. 测试自己启动内部组件，套件绿而产品不可用。

## 2026-10-22 · 第 1 轮：Hub 侧（数据模型 + 任务 + 审批 + 产物 + 租约）

- 目标：建议顺序第 1–4 步的 Hub 一半。
- 改了：
  - `hub/src/db/migrations.js`：迁移 v4，`tasks`/`approvals`/`round_leases`/`artifacts`（`LATEST_VERSION` 4）
  - `hub/src/tasks/envelope.js`（新）、`hub/src/tasks/service.js`（新）、`hub/src/artifacts/service.js`（新）、`hub/src/leases/service.js`（新）
  - `hub/src/workgroups/service.js`：`EVENT_TYPES` 5 → 18；`unreadCount` 改按 `chat.message` 计数（列表与单群两处）
  - `hub/src/ws.js`：`task.request`/`task.report`/`task.progress`/`lease.acquire|release|check` 六个 handler
  - `hub/src/server.js`：任务/产物/租约路由
  - `hub/test/`：`db-g5-schema.test.js`、`task-envelope.test.js`、`task-approval.test.js`、`task-artifact.test.js`、`task-lease.test.js`
- 验证：`cd hub && npm test` → **253 pass / 0 fail**（原 190）
- 发现并修的缺陷：
  1. `tasks.decide/report/revoke` 原写成 `async`，抛出的 `HubError` 变成 rejected promise，socket 的同步 `try/catch` 抓不到 → 改成同步
  2. `decide` 直接 `REQUESTED → APPROVED`，被状态机正确拒绝（`REQUESTED → APPROVED` 不在 §10.2 表内）→ 先按合法步骤走到 `PENDING_APPROVAL`
  3. `release` 删行导致 epoch 回到 1 → 改为把 `lease_until` 推到过去、保留 epoch
  4. `artifacts/service.js` 用了未导出的 `MIME_ALIASES` → 在 `attachments/service.js` 上导出（两份会漂移）
  5. 信封签名原本优先读信封自报的 `payloadHash`，签名可被「换 payload、留旧 hash」绕过 → 始终按当前 payload 计算
- 遗留：无（Hub 侧本阶段范围完成）

## 2026-10-22 · 第 2 轮：插件侧（通道 + 真执行 + 审批卡 + UI）

- 目标：建议顺序第 5–8 步，加上客户端能看见的部分。
- 改了：
  - `ds-bot/src/workgroup/host/task-runner.js`（新）：审批卡、三种分配、`verifyBeforeRun`、`runTask`、进度节流、`finishTask`、`cancelTask`、`requestTask`、工具 guard
  - `ds-bot/src/workgroup/host/envelope.js`（新）：Hub 规范化序列化副本
  - `ds-bot/src/workgroup/host/{bridge,hub,channel,state}.js`、`ds-bot/src/workgroup/index.js`
  - `ds-bot/src/workgroup/client/panel.js` + `styles.js`：审批卡
  - `ds-bot/src/client/i18n.js`：`+8` 条
  - 测试：`test/workgroup-task.test.js`（15 条）、`test/workgroup-task-envelope.test.js`（6 条）、`test/workgroup-ux.test.js`（`+4` 条）
- 验证：`cd ds-bot && npm test` → **1019 tests，1018 pass / 1 skip / 0 fail**；`build-client.mjs --check` exit 0；`npm run lint` 0 error / 13 warning（与 G4 基线相同）
- 发现并修的缺陷：
  1. 测试里 `hub.authenticate()` 直接登录 → bridge 从未启动（G4 第 4 轮同一个坑）→ 改为走 `hub-register` 端点
  2. `startTask` 用 `record.version + 1` → 记录原地自增，第二跳版本多 1，Hub 视为陈旧 → 改用返回值
  3. `newBot` 复用新 Bot 的私聊 Session → 被 `registerSessionOwner` 拒绝 → 另建任务 Session
  4. Hub 从帧顶层读 `task.report` 字段，插件把字段放在 `payload` → 报告全丢
  5. `task.request` 事件没带请求范围 → 审批卡看不出要批什么
  6. 缺 `task-finish` 端点 → 完成路径不可达
  7. `state.js` 的 `adopt` 白名单没加新键 → `taskRequests`/`taskOutbox` 重启即丢
- 遗留（都是人工项，已写进 `../gates.md` 的阻塞表）：门禁 2 真机一半、N3 对照、T14 符号链接

## 2026-10-22 · 第 2.5 轮：端点调用方反查（避免重犯 G4 的坑）

- 触发：写完第 2 轮后反查「每个新端点有没有调用方」，这正是 G4 第 4 轮 F5 的缺陷形态。
- 反查结果与处理：
  - **7 个端点零调用方**（`task-start`/`task-cancel`/`task-finish`/`task-list`/`task-artifacts`/`artifact-download`/`group-lease`）→ 审批卡加了「你的任务」区，带开始/完成/停止；`task-requests` 同时返回 `active`（读台账，不读卡片）
  - **租约只有端点没有真实调用方** → `groups.js` 的自动轮次改为先 `holdLeaseFor(room)`：Hub 群取不到租约就不跑（写一行说明），本地群与 Hub 离线时照旧；结束后释放
  - **进度只有端点没有生产者** → 删掉 `task-progress` 端点，改由 `session/event` 的 `tool/call` 产生，复用已有的 2 秒合并
  - `task-share`、`group-lease-acquire/-release` 同样没有调用方 → 删掉（`task-finish` 已带产物；租约取/放走 socket）
- 新增测试：`+3` 条租约围栏（含「围栏是轮次的一部分」的结构断言）、`+1` 条 UI 断言组、进度改由工具调用驱动
- 修的过程中发现的两个测试自身问题：
  1. `fakeContext.emit` 只喂单参数监听器，`session/event` 是 `(session, event)` → 新增 `emitBoth`
  2. i18n 里 `Stop` 已存在，重复键让 esbuild 警告并让构建失败 → 复用已有条目
- 验证：`hub` 253 pass；`ds-bot` 1019 tests（1018 pass / 1 skip）；`--check` exit 0；lint 0 error / 13 warning

## 2026-10-22 · 第 3 轮：门禁与文档

- 目标：建议顺序第 9 步。
- 产出：`g5/EVIDENCE-MATRIX.md`（T11–T17 + N1–N3 + 租约逐行证据）、`gates.md` 的 G5 节与阻塞表、`progress-and-gaps.md` 的 G5 台账与决定记录、`manual-checklist.md` 的 G5-T12/G5-N3/G5-T14、本文件。
- 核对时改正的两处文档不实：
  - EVIDENCE-MATRIX 原写 T14「`checkInsideRoot` 有单元覆盖」——当时其实没有；补了 `a task path outside the approved folder is refused, never redirected` 之后才成立
  - 同表把「未获批的 Bot」标成 PASS——它只有实现路径、没有独立断言，改标「实现已核，无独立断言」
- 状态：G5 自动化部分完成。

## 2026-10-22 · 第 4 轮：结论核对与补修

- 触发：用户要求「核对实施书和相关文档、代码，确认 G5 是否全部完成」。逐条核对后发现三处文档记 PASS 而运行时不可用。
- 缺陷与修法（详见 `../gates.md` 的补修轮一节）：
  1. `runTask` 零调用方 → `task-start` 改调 `runTask`
  2. `wg.deliver` 的 `role` 硬编码 `'room'` → 补回 `role` 参数（与原版 `rt.deliver` 同形），`runTask` 复用它
  3. `verifyBeforeRun` 的目录检查是死代码 → `cleanGrant` 收 `workDir/workDirRoot`、`decide` 记录 realpath 根、检查改用 `rt.sessionFolder`
- 改动文件：`src/workgroup/host/task-runner.js`、`src/workgroup/host/groups.js`（`deliver` 签名）、`src/workgroup/host/tasks.js`（`cleanGrant` 白名单）、`src/workgroup/host/channel.js`（`task-start`）、`test/workgroup-task.test.js`（+6）
- 验证：`ds-bot` 1024 tests / 1023 pass / 1 skip；`hub` 253 pass；lint 0 error / 13 warning；`--check` exit 0；`src/host/` 零改动
- 反向验证：重跑第 1 轮的探针，`followup calls: 1`、prompt 含请求原文 —— 缺陷 1 确已修复
- 文档：`EVIDENCE-MATRIX.md` 的 T12/T14 增补走产品路径的断言并撤掉符号链接的 BLOCKED；`gates.md` 补修轮一节；`progress-and-gaps.md` 缺口 19 关闭

## 2026-10-23 · 第 5 轮：工作群身份与邀请入口（用户实测发现）

- 触发：用户实际使用时问「工作群里没有邀请同事的入口」，并指出「工作群是以复制原版为基础新建的，先确认是否完整复制迁移」。
- 核对出的缺口（第 3 条最要紧）：
  1. 原版群设置本来就没有邀请同事——原版的群是本机概念，成员只能是本机 Bot；
  2. 我写的邀请控件在 `BotPanel` 里，而 `WG_PANEL_KEY` **全仓只出现在注册处**，没有任何导航入口，因此完全不可达；
  3. **方案 §5.1 早已要求复制 `client/group-settings.js` 到工作群域，并把「邀请」列为改造重点，而这份复制件从未存在。**
- 改动（按 C-1 → C-9）：
  - `C-1` `create-room` 删除未登录分支 → 服务端拒绝 `hub/not-signed-in`（推翻 G4 的「未登录保持 G3 行为」，理由见 `gates.md`）
  - `C-2` `invite-member` 转发 `hubUserId`（下层早已支持，路由没转发）
  - `C-3` **补做 §5.1 的复制**：`src/workgroup/client/group-settings.js`（146 行，导出 4 项；不复制 `NewGroupForm`，不重复导出 `GROUP_SETTINGS_CSS`）
  - `C-4` 新增 `invite.js` / `invite-target.js`：控件固定显示，未登录或群未上 Hub 时禁用并写原因
  - `C-5`/`C-6` `details-drawer.js`、`settings.js` 各一处三元，按 `room.workgroup === true` 择优
  - `C-7` `ApprovalCards` 从 `panel.js` 抽到 `tasks.js`，复制件的群设置也显示审批卡
  - `C-8` Hub 明文非 loopback 需 `HUB_ALLOW_PLAINTEXT_LAN=1`，否则启动报错；不再静默改回 loopback
  - `C-9` 未登录建工作群时给出可操作文案
- 验证：`ds-bot` 1033 tests / 1032 pass / 1 skip；`hub` 256 pass；lint 0 error / 13 warning；`--check` exit 0；`src/host/` 零改动
- 原版文件改动：`details-drawer.js`（新增 1 处三元，已补进 §5.2 B 类）、`settings.js`（§5.2 已允许）、`new-chat.js`（§5.2 已列）、`i18n.js`（文案）。**`src/client/group-settings.js` 零改动。**
