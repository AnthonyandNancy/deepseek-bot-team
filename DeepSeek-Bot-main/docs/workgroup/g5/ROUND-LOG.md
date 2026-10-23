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

## 2026-10-23 · 建工作群报 `The group name must be text.`（用户截图报告）

- 现象：创建工作群聊失败，底部红字 `The group name must be text.`
- **先核对迁移完整性（用户要求）**：命名链路是完整的。
  - 原版 `src/host/roster.js:296` `autoRoomName = members => ['You', ...members.map(id => rt.botOf(id)?.name)].join(', ')`
  - 复制版 `src/workgroup/host/groups.js:217` `autoWorkgroupName(members, createdAt)` 同源，并额外附创建时间戳（有注释说明是有意增强）
  - 复制版 `createWorkgroup` 里 `const title = custom !== '' ? custom : autoWorkgroupName(...)`（`groups.js:309`）——本地房间一直都拿得到名字
  - 原版 `holdName` + `cleanRoomName` 的**重名校验**未迁移，但 `groups.js:308-312` 有明确记载的产品决定：工作群身份是 id（`wg-<uuid>`），名字只是标签，允许同名。**这是有意的，不是漏迁。**
- 真因：**本地名字推导对了，但没传给 Hub**。`channel.js:201` 写的是
  ```js
  name: name.trim() === '' ? undefined : name,     // 旧代码
  ```
  `JSON.stringify` 会把 `undefined` 字段整个丢掉，Hub 的 `text(body.name, 'The group name', ...)`（`hub/src/workgroups/services.js:182`）拿到 `undefined` 就抛 `The group name must be text.`。于是**整个建群失败**，连本地房间都没建出来——用户说的「回到起点」是准确的。
- 为什么测试没抓到：现有 13 个 G4 用例**每一个都传了 `name`**（`{ name: '会议记录' }`），没有一条走"不填名字"这条真实主路径。
- 改动：
  - `ds-bot/src/workgroup/host/groups.js`：导出 `wg.autoNameFor(members)`（不带时间戳——Hub 行是给别人看的，创建时间是噪音）
  - `ds-bot/src/workgroup/host/channel.js`：`name: name.trim() === '' ? wg.autoNameFor?.(members) ?? 'Workgroup' : name.trim()`
  - `ds-bot/test/workgroup-g4-api.test.js`：新增 `a workgroup created without a name still gets one`——完全不传 `name`，断言建群成功、Hub 上有非空名字、且**本地房间名与 Hub 名字一致**
- 验证：`ds-bot` **1039 tests / 1038 pass / 1 skip / 0 fail**；`hub` **257 pass / 0 fail**；lint **0 error / 13 warning**；`--check` exit 0；`src/host/` 零改动；`app/node_modules/ds-bot` 经 junction 已看到新构建

## 2026-10-23 · 建群后没有群头像、没有成员（用户截图报告）

- 现象：工作群建出来了（标题 `You, Chief, 路人甲A, 路人甲B`），但右侧详情「4 位成员」下面是「成员 · 0」，且**没有群头像**
- **先核对迁移完整性（用户要求）**：`GroupOverview` / `MemberPile` / `MemberRow` 是原版 `details-drawer.js` 里的群概览组件，**从未被复制到工作群域**（`src/workgroup/client/` 下只有 `group-settings.js`、`panel.js`、`rows.js`、`invite.js`、`tasks.js`，没有任何概览组件）。工作群是靠 `sources.js` 把记录适配成"原版组件能读的形状"来复用原版组件的——**适配层才是迁移点，而它错了**
- 真因（用探针在真实产品路径上实测，不靠推断）：
  - **Host 完全正确**：`create-room` 后 `room.members` 有 3 条完整记录（2 个 `remoteBot` + 1 个 `user`），Hub 侧 roster 也齐全
  - **客户端适配层错**：`groupRooms()` 把成员**压平成 id**
    ```js
    members: (room.members ?? []).map(member => member.id)   // 旧代码
    ```
    而这些 id 是 Hub 的 `ep_…` / `usr_…`，`roster.byId` 里只有本机 Bot，**全部查不到**。原版组件写的是 `room.members.map(id => roster.byId[id]).filter(Boolean)`，于是：
    - 详情标题读 `room.members.length` →「4 位成员」（对）
    - 成员列表走 `byId` 解析 → 全部落空 →「成员 · 0」（错）
    - `MemberPile`（群头像 = 成员头像堆叠）同样全部落空 → **空白，没有头像**
  - 两处数字自相矛盾，就是同一个数据被两种方式解读的直接证据
- 为什么测试没抓到：`groupRooms` / `indexRoster` **零测试覆盖**；现有工作群测试都停在 host 侧，没人验证过 `roomsById`/`byId` 里到底有没有成员
- 改动：
  - `ds-bot/src/client/sources.js`：`groupRooms()` 保留成员**记录**而不是压平成 id；`indexRoster()` 把这些成员也登记进 `byId`（放在 bots 之后，本地 Bot 优先；不写进 `bots`，所以 Bots 列表和计数不受影响）
  - `ds-bot/src/client/details-drawer.js`：新增 `memberOf(entry, roster)` 帮手——记录就是它自己，id 才查 `byId`；`GroupOverview` 与 `MemberPile` 两处绘制点改用它
  - `ds-bot/test/workgroup-roster-shape.test.js`（新建，4 条）：成员记录保留、`byId` 能解析、**本地群形状完全不变**（回归保护）、两个绘制点都走 `memberOf` 且能对两种形状给出正确名字
- 说明：群头像 = 成员头像堆叠（原版设计），成员一旦能解析，头像自然出现；远端成员没有自定义头像时，`lookOf()` 按 `id` 生成确定性的角色形象
- 验证：`ds-bot` **1043 tests / 1042 pass / 1 skip / 0 fail**；`hub` **257 pass / 0 fail**；lint **0 error / 13 warning**；`--check` exit 0；`src/host/` 零改动

---

## 2026-10-23 · G5 · 更正上一轮：成员必须是 **id**，缺的是 `byId` 登记

上一轮把 `room.members` 改成了成员**记录**对象，方向错了。用户重启后的截图把它证伪了：群头像仍是一个**黑色 gumdrop**。

- 决定性证据：`lookOf(undefined)` 的结果就是「黑色 gumdrop」（`characters.js:37,67,71`，`FALLBACK_SHAPE='gumdrop'`，无 id 时 `colorOf` 返回 `'black'`）。截图里头像发黑，说明 `RoomAvatar` 解析出来的成员数**是 0**。
- 上一轮为什么也解析不出来：`RoomAvatar` / `GroupSettingsForm` 写的都是 `roster.byId[id]`，把**记录对象**当 key 会变成 `"[object Object]"`，同样查不到。两种写法都掉进同一个坑，只是方向相反。
- 原版组件的契约是明确的：`room.members` 是 **id 列表**，id 通过 `roster.byId` 解析。**不要把记录塞进 members，要让 byId 能回答这些 id。**
- 真因（两半必须同时成立）：
  1. `groupRooms()` 把成员记录压平成 `ep_…` / `usr_…` —— 这一步本来就对，保持不动
  2. `indexRoster()` 从没把这些 id 登记进 `byId` —— 这才是缺的一半
- 修复（单文件 `ds-bot/src/client/sources.js`）：
  - `groupRooms()` **完全恢复原样**（成员压平成 id）
  - `indexRoster()` 在 bots 之后、agents 之前，新增遍历把所有工作群成员的**记录**登记进 `byId`；本地 Bot 优先；**不写进 `roster.bots`**，所以 Bots 列表、成员计数、"@" 菜单全部不受影响
  - 抽出 `workgroupMembers(workgroups)` 帮手：只收有 `id` 的成员记录，无 id 的丢掉而不是索引成 `undefined`
  - `details-drawer.js` 的 `memberOf` 帮手 **撤销**（原是上一轮的错误修复），该文件恢复原版
- 一次登记，所有消费方同时被修好（实测）：成员列表、群头像、`roomSubtitle` 的管理员名、`shownMode`、`at-menu`、`user-message` 的 @ 提及、`member-status` 的成员状态
- 测试重写 `ds-bot/test/workgroup-roster-shape.test.js`（5 条，断言**正确契约**）：members 必须是 id 列表、每个 id 必须能通过 `byId` 解析出可画的名字、登记不污染 `roster.bots`、本地群形状零变化、原版组件（`mark.js` / `group-settings.js`）的 id 查找语句**必须保持原样**
- 变异验证：撤掉修复 → `every member id a workgroup hands out resolves through byId` **失败**；恢复 → 5/5 通过。证明这条测试真的能抓住这个 bug，不是摆设
- 验证：`ds-bot` **1044 tests / 1043 pass / 1 skip / 0 fail**；lint **0 error / 13 warnings**；`--check` exit 0；`src/host/` 零改动
- 顺带修：`app/node_modules/ds-bot` 的 junction 又被 `npm install` 冲成真实副本且已过期；用**绝对路径**重建（相对路径会被 `mklink` 按当前目录解析，第一次重建指错到 `D:\code\ai\DeepSeek-Bot\ds-bot`），已确认 `client.js` 与源构建逐字节相同且含本次修复

---

## 2026-10-23 · G4 回归 · 本机 Bot 在工作群里不回答（初始化与回复）

用户：「建工作群 → 原版群聊那样的初始化逻辑 → 有问候 → 你说话 → 有回复」；「工作群是复制原版群聊
所有代码为基础的新建的工作群聊……因地制宜的修改但是不能脱离」。

### 迁移完整性核对结果

机制**全部已迁移**，逐项核对过：`greetWorkgroup`（`groups.js:354` 由 `createWorkgroup` 调用）、
`session/event` 的 `user/message` 入队（`groups.js:1953`）、`llm/stream` 的 relay（`groups.js:2109`）、
`sessionFor`、`runRound`、`openingSpeakers`。**缺的不是机制，是成员的 `kind`。**

### 真因

`sessionFor`（`groups.js:727`）：`if (member.kind !== 'localBot') return undefined` —— 非本地成员
交给 `deliverRemote` 发上 Hub。而真实创建路径写进来的成员是：

| 步骤 | 结果 |
|---|---|
| 本机 Bot → `publishBotEndpoints()` | Hub 分配 `ep_…` |
| `createWorkgroup({ endpointIds })` | Hub 建群 |
| Hub 返回成员表（只有 `endpointId`） | `applyRoster` 写入 |
| `applyRoster` 写的 `kind` | **`remoteBot` / `user`** |

于是 `sessionFor` 对**每一个**成员都返回 `undefined`，round 把所有人交给 `deliverRemote` → `bridge.send()`。
**本机自己的 Chief 被当成另一台设备的 Bot，消息发上 Hub 等一个永不存在的回答。** 群既没有问候也没有回复。

决定性验证（实测）：

```
路人甲A      -> NO LOCAL SESSION (handed to Hub)
Chief        -> NO LOCAL SESSION (handed to Hub)
+86****2222  -> NO LOCAL SESSION (handed to Hub)
```

第二个真因：`applyRoster` 把 Hub 的 owner（**人**，`usr_…`）直接写成 `adminId`。`mode: 'admin'` 只叫 admin
一个人，于是每轮唯一候选是个本机无法运行 turn 的人。原版的 admin 必然是 Bot。

`kind: 'localBot'` 在生产代码里**从未被写入过**——只有 `twoMembers()` 测试帮手手搓它。13 个 round 测试全绿，
产品是死的。这是「边界测了、主干没测」的第三次复现。

### 修复（选 A：本地映射表）

`endpointId → localBotId` 是**设备本地**事实，同一房间在每台机器上解析结果不同，存 Hub 反而是错的方向；
且只要插件要兼容已部署的 Hub，B 方案最终仍需 A。B 以后可作 fallback：`applyRoster` 已支持
`member.localBotId` 直接读取，无需改结构。

| 文件 | 改动 |
|---|---|
| `src/workgroup/host/state.js` | 新增 `endpointBots`（`endpointId → localBotId`），纳入 `adopt` |
| `src/workgroup/host/bridge.js` | `publishBotEndpoints` 记录映射并保存；新增 `endpointBots()` 读取 |
| `src/workgroup/host/groups.js` | `applyRoster` 查映射：命中且本机有该 Bot → `kind: 'localBot'` + `botId`；admin 必须是**能回答**的成员（人不行，退到第一个本地 Bot）；`same` 比较加入 `kind`，kind 变化会落盘 |

### 测试（3 条，走真实产品路径）

`test/workgroup-g4-api.test.js`，用真 Hub + 真 `create-room` + 真成员：

1. `a workgroup built from this machine's Bots has members that can answer HERE`
   —— 两个本机 Bot 都必须是 `localBot` 且 `botId` 指回 `a`/`b`；admin 必须是其中之一
2. `the person who created the group is a member, but never the one called to answer`
   —— owner 是人，可以入群，但**永不当 admin**；且不新增/丢成员
3. `what the user types in a workgroup is answered by this machine's own Bot`
   —— 端到端：`send` → 入队 → relay → **本机 Bot 的 Session** → 回复进日志，`who: 'Chief'` 且归属该成员

**变异验证**（每条都真能抓 bug）：
- 撤掉 kind 解析 → 测试 1 失败
- 只撤掉 admin 规则 → 测试 1、2、3 全部失败
- 恢复 → 17/17 通过

### 验证

`ds-bot` **1047 tests / 1046 pass / 1 skip / 0 fail**；lint **0 error / 13 warnings**；`--check` exit 0；
`src/host/` 零改动（五个原版文件逐字节不变）。`app/node_modules/ds-bot` junction 再次被 `npm install`
冲成目录，已用绝对路径重建为 `<JUNCTION>`。

### 未做（下一轮）

- `usr_…`（本人）仍可能被 `openingSpeakers` 选中并交给 `deliverRemote`；admin 规则已使其不再是默认候选，
  但 `@all` / everyone 模式下的这一路径需要单独钉住。
- 用户第 2 项（邀请同事后能查看群消息）属于 **G4** 范围（`g4/NEXT-INSTRUCTION.md:42,46,48`、T08），
  不在 G5；本轮未改动该路径。

---

## 2026-10-23 · G4 补齐 · 邀请收件箱入口 + 头像身份 + 建群问候

用户三点：①建群后没有原版那样的初始化与介绍；②每个 Bot 的头像不是自己的，是随机的；
③「在图中的搜索图标隔壁新增收信箱，用于接受邀请的 CURD」，按 G4 做。

### ① 建群后没有问候

真因是**建群顺序**：`ensureLinkedGroup` 建本地房间时刻意不带成员（成员归 Hub 所有），于是
`adminId` 为 `null`，`greetWorkgroup` 在 `if ((room.adminId ?? null) === null) return` 直接返回。
成员表随后同步进来，但**再没有任何地方叫过一次问候**。所以登录状态下建的工作群打开是白纸，
而同名本地群正常（本地群建时成员已在，`adminId` 有值）。

修法：把问候挪到**成员表第一次就绪**的时刻（`applyRoster`），那才是 Hub 群第一次真的有人能说话。
加 `room.greeted` 标记并持久化，保证只问候一次——否则每次有成员变更都会重新问「这个群是干什么的」。

### ② 头像随机

真因是成员记录太薄：Hub 回来的成员是 `{id, kind, name}`，而 `lookOf()` 从 **id** 推导形状与颜色。
成员 id 是 Hub 的 `ep_…`，于是每个成员都按端点 id 生成形象——看起来像随机的，永远不是侧栏那个 Bot。

修法：适配层解析到**本机 Bot 记录本身**（`applyRoster` 已记录 `botId`）：

```js
const own = member.botId === undefined ? undefined : byId[member.botId]
if (byId[member.id] === undefined) byId[member.id] = own ?? member
```

远端成员的 Bot 没有本地记录，保持成员记录不变。

### ③ 邀请收件箱（G4）

**归属**：G4，不是 G5。依据 `g4/NEXT-INSTRUCTION.md` §2（「群成员/邀请」列进 G4）与 §3 端点清单
（含 `POST /v1/invites/:id/accept`），验收 T08「双机聊天、附件、成员邀请」。G5 是跨用户任务委派与
审批（同意卡片），与「入群同意」不是同一件事。

**真实缺口**：收件箱组件早就存在（`panel.js` 的 `InviteInbox`），但它挂在 `WG_PANEL_KEY` 那个面板里，
而**全仓没有任何导航指向该面板**。邀请能到 Hub、能到本机，却没有任何地方显示。

新增 `src/workgroup/client/inbox.js`（`useInbox` / `InviteInboxButton` / `InviteInbox` / `INBOX_CSS`），
并在 `src/client/sidebar.js` 的头部按钮行、**搜索图标左侧**挂 `InviteInboxSlot`（折叠态也保留）。
接受后调 `refreshWorkgroups()`，新群立刻出现在列表。

### 验证

- `ds-bot` **1059 tests / 1058 pass / 1 skip / 0 fail**；`hub` **257 pass / 0 fail**
- lint **0 error / 13 warnings**；`--check` exit 0；`src/host/` 零改动
- 新增测试：`workgroup-inbox-entry.test.js` 4 条（入口位置、CURD 能力、接受后刷新、角标与样式）、
  `workgroup-g4-api.test.js` 加 2 条端到端（邀请进收件箱→加入→群出现在列表；拒绝→收件箱清空且不入群）、
  `workgroup-roster-shape.test.js` 加 2 条（本机 Bot 解析到自己的记录、远端成员保持原样）
- 变异验证：撤掉问候触发 → 问候测试失败；撤掉 `botId` 解析 → 头像测试失败
- `app/node_modules/ds-bot` junction 再次被 `npm install` 冲成目录，已用绝对路径重建，`client.js` 与源构建一致

---

## 2026-02-14 — 群主/管理员归属 + 权限档位（用户截图两条）

**用户报告**：①「新建的工作群，群主应该是我，管理员是管家 bot，目前不知道为什么变成群主是其他 BOT，
管理员没了」②「新建的工作群，权限不知道选中哪个」

三处根因都在 `applyRoster` / `createWorkgroup` 这两个适配边界上，不是功能缺失。

### ① 管理员给了「列表里第一个」而不是主 Bot

`applyRoster` 用 `answerable[0]?.id` 选管理员。Hub 的成员按
`memberships ORDER BY joined_at` 返回，所以**先入群的普通 Bot** 拿走了管理员角色，
主 Bot（管家）反而没有。原版 `src/host/roster.js:332` 的 `defaultAdmin` 是：

```js
const defaultAdmin = (members, createdBy) =>
  (members.includes(createdBy) ? createdBy : members.find(rt.isMain) ?? null)
```

即**成员里的主 Bot** 领导群。这正是用户说的「群主是我，管理员是管家 bot」：
用户是群主（Hub 的 `role === 'owner'`，roster 显示为「群主」），主 Bot 是管理员。

改为原版顺序：owner 发布的 Bot → 主 Bot → 第一个可应答成员 → 保留原管理员。
owner 的 Bot 按 `endpointId` 匹配（**不是** `id`，见下条）。

### ② 管理员标签消失：成员 id 的语义错了

原版群的成员是 **Bot id**（`src/host/roster.js` `createRoom`），所有原版组件都通过
`roster.byId[id]` 找成员：管理员标签是 `room.admin === member.id`，设置行 `openBot(member.id)`，
头像画那条记录。

工作群把成员 id 写成了 Hub 的 `ep_…`。上一轮的头像修复让 `byId[ep_…]` 返回**Bot 记录本身**，
而那条记录的 `id` 是 Bot id —— 于是 `room.admin === member.id` 变成 `ep_…` vs Bot id，
**永远不成立**，所有管理员标签一起消失。群其实有管理员，只是没有一个组件画得出来。

修法：本机 Bot 成员直接用**自己的 Bot id**，和原版群完全一致：

```js
id: local ? localBotId : member.memberType === 'botEndpoint' ? member.endpointId : member.userId,
```

Hub 的端点 id 仍然保留在 `member.endpointId` 上（寻址端点需要它）。远端成员不受影响。

**连带迁移**：`room.sessions[member.id]` 和 `room.seen[member.id]` 都以成员 id 为键。id 变了之后，
旧键会留下一个「有人拥有、却没人指向」的 Session（`registerSessionOwner` 还列着，回收不了），
而成员下一轮会开第二个、丢掉已读位置。`applyRoster` 里按 `endpointId`（跨两种形状唯一稳定的字段）
把两个映射搬到新键上。

### ③ 权限「不知道选中哪个」：写入了 `null` 而这个字段该缺席

`createWorkgroup` 写入 `permission: null`。原版只在用户打开「全员统一」时才写这个键，
且**两个读者都测 `!== undefined`**：

- `GroupPermission` 算 `shared = room.permission !== undefined` → `null` 让开关画成**开**
- `PermissionPicker` 收到 `saved: null` → **三个档位一个都不高亮**

所以屏幕上是「开关开着，但没有任何一档被选中」。`setRoomPermission` 清除时是
`delete room.permission`（`src/host/permissions.js:64`），`null` 是原版这个字段从不持有的值。

改为**不写这个键**。另在 `state.js` 的 `adopt()` 里把旧文件里的 `permission: null` 丢掉，
使已经建好的群在加载时自愈，不必让用户把开关关了再开。

### 验证

- `ds-bot` **1063 tests / 1062 pass / 1 skip / 0 fail**；`hub` **257 pass / 0 fail**
- lint **0 error / 13 warnings**；`build-client.mjs --check` exit 0；`src/host/` 零改动
- `workgroup-g4-api.test.js` 由 23 增至 27：主 Bot 领导且群主仍是「我」、成员按 Bot id 键控、
  新群不谎称设置了共享权限、成员 id 变更后 Session/已读游标跟随、旧文件 `permission: null` 自愈
- 变异验证（逐个撤掉修复，确认对应测试各自失败）：
  - `answerable[0]` 还原 → 「Main Bot leads」「has members that can answer HERE」2 条失败
  - 成员 id 还原为 `ep_…` → 同上 2 条失败
  - 恢复 `permission: null` → 「does not claim a shared permission」失败
  - 撤掉 Session 键迁移 → 「keeps its group Session」失败
  - 撤掉 `adopt()` 自愈 → 「stored permission: null」失败

---

## 2026-02-14 — 侧栏选中态 + 删除工作群后复活

**用户报告**：①「左侧操作栏，选中工作群，没有选中的样式」②「删除工作群，采取本应用后又出现了，反而本地群不会」

### ① 选中态：行复制了，选中逻辑没复制

原版用 `.bt-row[aria-current=page]{background:var(--bt-active)}` 画选中态，本地群有高亮，
因为它调 `useSessionRetainInfo(room.id, …)`。工作群行缺两处：

1. `WorkgroupRow` 里**完全没有** `aria-current`
2. `sidebar.js` 渲染它时手工拼 props，**漏传** `useSessionRetainInfo`
   （本地群行经 `...rowProps` 自动带上）

即典型「复制后漏掉一半」。修法是把原版那套照搬：同一个 hook、同一个属性、同一条样式规则，
不新增任何工作群专属选中样式（有测试禁止 `[data-selected]` 这类第二条路径）。
side bar 改为 `...rowProps`，顺带补上 `marked` 未读标记。

### ② 删除后复活：只删了本地，Hub 上还在

实测证据：

```
after delete, local room: GONE
hub still lists: 1 ["wg_de2cc5…"]
AFTER RESTART, rooms with that hub id: 1
adopted back? YES (BUG)
```

根因两层：

1. `delete-room` 只删本地记录，**从未通知 Hub**
2. `adoptHubGroups` 每次启动扫描 Hub 群列表，本地缺就重建 → 刚删的群被拉回

本地群不复发，因为它只存在本机，没有外部来源能把它拉回来。

**测试漏洞（这轮一并修）**：先前写的该测试是**假通过**——`reopenDomain` 的假 ctx 缺
`workspaceRegistry`，采纳时抛错被自身 `catch` 吞掉。补全 ctx 后测试立即真实失败。

**产品决策（用户定）**：删除 = **真正解散**（Hub 上删除，所有成员都失去它）；
群主**可以退出**，所有权转交给下一位真人同事。

Hub 侧新增：

- `POST /v1/workgroups/:id/delete` → `dissolve()`，仅群主，`DELETE FROM workgroups`
  一条语句完成——所有相关表都是 `ON DELETE CASCADE` 且 `PRAGMA foreign_keys = ON`
- `removeMember` 不再用 `owner-cannot-leave` 硬拒：群主离开时 `handOverOwner()` 转交给
  下一位 `member_type = 'user'` 的成员（**不转交 Bot**：`role` 决定谁能邀请，
  转给 Bot 等于把该权限交给它主人的机器）；只剩一人时返回 `workgroup/last-member`，
  提示「改为删除群」，避免出现无主群

ds-bot 侧：`deleteWorkgroup` **先通知 Hub，成功后再删本地**。顺序理由写在代码里：
Hub 拒绝时本地未动，群仍可用；Hub 成功而本地保存失败，下次启动只是重新采纳一个
Hub 上已删除的群，可见且不丢数据。反过来则会在群仍存在时丢掉本地记录。

### 验证

- `ds-bot` **1068 tests / 1067 pass / 1 skip / 0 fail**；`hub` **262 pass / 0 fail**
- lint **0 error / 13 warnings**；`build-client.mjs --check` exit 0；`src/host/` 零改动
- 新增 `test/workgroup-row-selected.test.js` 3 条；`workgroup-g4-api.test.js` 增至 29 条
  （删除后重启不复活、未删除的仍会被采纳）；`hub/test/workgroup-delete.test.js` 5 条
  （全成员列表移除、仅群主可删、不存在报 404 而非 403、群主退出并转交、最后一人不可退出）
- 变异验证：
  - 撤掉 `aria-current` → 「selected workgroup row is marked」失败
  - 撤掉 `...rowProps` → 「same "am I selected" source」失败
  - 撤掉 Hub 删除调用 → 「deleted workgroup stays deleted after a restart」失败
