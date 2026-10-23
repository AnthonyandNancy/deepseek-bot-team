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

## 2026-10-23 · 邀请同事两项缺陷（用户截图报告）

- 目标：修「邀请行样式不美观」与「已登录 Hub 却报 `The refresh token is not valid.`」
- 真因（均已用证据坐实，不是猜）：
  1. **服务端数据丢失，不是 token 逻辑**。运行中的 Hub（`127.0.0.1:7788`，PID 2724，`node src/index.js`，由 `BotCode/hub` 启动）打开的库 `BotCode/hub/hub/.data/hub.db` 里 `users`/`auth_sessions`/`devices`/`audit_events` **全为 0 行**（复制 db+wal 重放验证，`integrity_check: ok`；随后打一次错误密码登录，该库精确多出 1 条 `audit_events`，证明读的就是活动库）。而 `~/.dsh/.credentials.yaml` 自 10-22 14:46 起存着 `usr_b77461…`。根因是 `dataDir` 默认值 `hub/.data` 为**相对路径**：从 `hub/` 启动落到 `hub/hub/.data`，从仓库根启动落到 `hub/.data`，**换目录即换空库**。
  2. **邀请行样式**：根节点复用了 `bt-wg-invite`（`panel.js` 单行邀请框的类），又套在 `bt-set-row`（横向两栏）里，塞进 5 个子元素；且 `.bt-wg-invite-field/-reason/-note` 全项目无 CSS，`WG_CSS` 只在 `panel.js:534` 挂载面板时才安装，而该行住在**设置抽屉**里。
- 改动：
  - `hub/src/config.js`：新增 `DEFAULT_DATA_DIR`；`dataDir: resolve(env.HUB_DATA_DIR ?? DEFAULT_DATA_DIR)`，把相对路径在唯一入口解析一次
  - `hub/src/cli.js`：改为复用同一个 `resolve`（原先重复了一份相对默认值）
  - `hub/src/server.js` / `hub/src/index.js`：`hub.listening` 与 `hub.ready` 都打出 `dataDir`，让「换目录」可被一眼发现
  - `ds-bot/src/workgroup/host/hub.js`：`ensureAccess` 收到 **401** 时 `clearMemory()` + `store.clear()` + 抛 `hub/signed-out`（含说明：401 涵盖无此行/已轮换/已过期/会话已结束，皆永久失效；网络失败等保留记录）
  - `ds-bot/src/workgroup/host/bridge.js`：新增 `sessionRefused` 状态并在 `status()` 暴露 `refused`；`start()` **不抛**（「无 Hub 的团队必须等同 G3 团队」由既有测试钉住）
  - `ds-bot/src/workgroup/host/channel.js`：`create-room` 读 `refused` 返回 `hub/signed-out` 而非误报 `hub/unreachable`；`hub-state` 刷新后**重新**读账号，不再用刷新前的快照报 `loggedIn: true`
  - `ds-bot/src/client/new-chat.js`：`hub/signed-out` 与 `hub/not-signed-in` 同样映射成「先登录再建群」
  - `ds-bot/src/workgroup/client/invite.js`：改为 `bt-bs-stack` 竖排，类名换为 `bt-wg-invset*`，不再复用面板的单行类
  - `ds-bot/src/workgroup/client/rows.js`：`.bt-wg-invset*` 布局写进 `WORKGROUP_ROW_CSS`（它随 shell 安装，抽屉里一定存在）
  - `ds-bot/scripts/build-client.mjs` + `package.json`：新增 `--watch` 与 `npm run dev`（watch 输出与一次性构建**逐字节相同**，已 `cmp` 验证）
  - `app/node_modules/ds-bot`：改为指向 `../../ds-bot` 的 **junction**，`npm run build` 之后无需重装即可生效（已验证 `add` 后通过 junction 立即看到新产物）
- 新增测试：`hub/test/tls.test.js`（dataDir 绝对化）；`ds-bot/test/hub-client.test.js`（被拒 token 丢弃且不误报网络；不可达 Hub 不删记录）；`ds-bot/test/workgroup-g4-api.test.js`（**重启后**过期会话报 `hub/signed-out` 且 `hub-state` 转 false）；`ds-bot/test/workgroup-invite.test.js`（竖排类名 + CSS 归属）
- 验证：`ds-bot` **1037 tests / 1036 pass / 1 skip / 0 fail**；`hub` **257 pass / 0 fail**；lint **0 error / 13 warning**；`--check` exit 0；`git status --porcelain ds-bot/src/host/` **为空**
- 遗留：错误 1 的账户需**用户重新登录**（服务端记录本就不存在，代码无法代其恢复）；修复后界面会如实显示「会话已结束、请重新登录」

## 2026-10-23 · 退出登录不生效（用户截图报告）

- 现象：点「退出登录」后账号页仍显示已登录（`+86****2222`、`usr_b77461…`、`dev_4b5…`），登录表单不再出现，因此无法重新登录
- 真因：**不是 UI**。`hub-settings.js` 的 `signOut` 在 `await run(...)` 后确实重新读了 `hub-state`；错在 `hub-store.js` 的 `clear()`：
  ```js
  await seam.modifyRecord(CREDENTIAL_KEY, async () => undefined)   // 旧代码
  ```
  Harness 的 `modifyRecord` 契约是「`undefined` = **不改动**」，实现里 `if (next === void 0) return current` 直接早返回。**删除只能走 `deleteRecord(key)`**。于是记录一直留在 `~/.dsh/.credentials.yaml` 的 `ds-bot/hub-account`（已核实现场仍在），`restore()` 每次都把它读回来，页面没有别的依据可信。
- 为什么测试没抓到：`test/hub-store.test.js` 的 `fakeSeam` 把 `undefined` 当成删除，**与真实契约相反**。测试双替身一旦背离真实语义，就只能证明「我的假设自洽」。
- 改动：
  - `ds-bot/src/workgroup/host/hub-store.js`：`clear()` 改用 `seam.deleteRecord(CREDENTIAL_KEY)`；无 `deleteRecord` 的旧提供方仍退回 `modifyRecord`（并注明它其实删不掉，只是最接近的降级）
  - `ds-bot/test/hub-store.test.js`：`fakeSeam` 按真实契约重写——`modifyRecord` 的 `undefined` 视为「不改动」，新增 `deleteRecord`；并加注释说明这次背离曾让 bug 漏网
  - `ds-bot/test/workgroup-g4-api.test.js`：新增 `signing out really signs out, and signing in again works`——走产品路径断言 `hub-logout` 后 `hub-state.loggedIn === false`、`hubStore.load() === undefined`，且能再次 `hub-login` 成功
- 验证：`ds-bot` **1038 tests / 1037 pass / 1 skip / 0 fail**；`hub` **257 pass / 0 fail**；lint **0 error / 13 warning**；`--check` exit 0；`src/host/` 零改动
- 用户侧待办：修复后**再点一次「退出登录」**即可清掉 `~/.dsh/.credentials.yaml` 里残留的那条记录（不手工改用户 DSH 数据）
