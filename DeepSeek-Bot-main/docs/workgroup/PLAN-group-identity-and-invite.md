# 修改方案：工作群的 Hub 身份、邀请入口与审批可达（G4 + G5 收口）

- 日期：2026-10-23
- 状态：**待执行**（用户已定口径，方案已核实）
- 前序文档：`PLAN-group-identity-and-invite.md`（初版，本文件取代其 P0-4/P0-5 部分）

---

## 一、用户已定的口径

1. **未登录时禁止建工作群**。本地群入口不变。
2. **建工作群立即散布到 Hub**，同事可被邀请加入。
3. **邀请同事放在「添加成员」下面**，打开后输入手机号或用户 ID。
4. **老群不管**（用户可从头测）——不做 `bridge-link-group`。
5. **能不动原版就不动原版**；确实需要时才动，且要说明。

---

## 二、核实结论（决定方案形态的依据）

### 2.1 方案文件要求复制 `group-settings.js`，但从未执行

`Workgroup_AI_技术实施方案_2026-10-21.md.md` **§5.1**（"必须先复制并保持功能等价"的 A 类，共 13 项）明确列出：

| 原版源码 | 复制目标 | 改造重点 |
|---|---|---|
| `client/group-settings.js` | `workgroup/client/group-settings.js` | 真人角色/**邀请**/Hub/群记忆/退出 |

而实际情况：

```
$ ls src/workgroup/client/
api.js  index.js  panel.js  rows.js  styles.js
$ ls src/workgroup/client/group-settings.js
No such file or directory
```

**这是一处复制缺口**，且"邀请"正是方案为这份复制件指定的改造重点。因此本次需求**不需要改原版**，需要的是补做方案早已要求的复制。

### 2.2 原版文件的改动边界

`docs/workgroup/diff-manifest.md` 与 `git status` 显示本 fork 已改的原版客户端文件：

| 文件 | 改动 | 方案依据 |
|---|---|---|
| `src/client/index.js` | 工作群入口、`workgroupOf` 分流、Hub 动作、roster 索引 | §5.2 允许 ✅ |
| `src/client/settings.js` | 加 `hub` 页与渲染行 | §5.2 允许 ✅ |
| `src/client/group-settings.js` | **零改动** | 不在 §5.2 清单 |
| `src/client/details-drawer.js` | **零改动** | 不在 §5.2 清单 |

### 2.3 `actions` 已按域分流，复制件可沿用同一签名

```js
// src/client/index.js
updateRoom: async (id, patch) => {
  if (workgroupOf(id) === undefined) return localWrites.updateRoom(id, patch)   // 本地群 → 原版
  ...                                                                            // 工作群 → api/workgroup
}
deleteRoom / setFlags / roomProgress 同一形态
```

**含义**：复制件里 `actions.updateRoom(room.id, patch)` 这类调用**不需要改写**，因为 `index.js` 已经按 id 分域。复制件只需改"群语义相关"的部分（邀请、成员显示），这正是 §5.1 的"改造重点"。

### 2.4 邀请入口在界面上为何不可达

| 层 | 事实 | 证据 |
|---|---|---|
| 原版群设置没有邀请 | 成员卡只有「添加成员」（本机 Bot） | `src/client/group-settings.js:84-108` |
| 我写的邀请控件无处可达 | `WG_PANEL_KEY`（`BotPanel`）全仓只出现在注册处 | `src/workgroup/client/index.js:104` |
| 工作群行点击 → 原版会话 | `rows.js:46` → `actions.openWorkgroup` → `openSession(id)` | `src/client/index.js:594` |
| 到达原版「群设置」抽屉 | `details-drawer.js:218` → `GroupSettingsForm` | — |

**结论**：必须让**工作群**走到复制件的群设置，否则邀请仍不可达。

### 2.5 未登录建群的分支

```js
// src/workgroup/host/channel.js  create-room
const account = await wg.hub.restore().catch(() => undefined)
if (account !== undefined) { ...Hub 建群，写 hubWorkgroupId... }
// Signed out: exactly the G3 behaviour, a local workgroup whose members are local Bots.
const room = await wg.createWorkgroup({ name, notice, members })   // ← 不写 hubWorkgroupId
```

这与 §8.1「**登录 Hub 后**可直接创建」冲突，是 G4 修复轮的决定（`g4/ROUND-LOG.md:139`）。用户已定：删除该分支。

### 2.6 Hub 绑定局域网现在无效

```js
// src/server.js listen()
const host = config.insecureLoopbackOnly && !isLoopback(config.host) ? '127.0.0.1' : config.host
```

明文模式下 `HUB_HOST=0.0.0.0` 被**静默改回 loopback**。这是多机连不上的直接原因。

---

## 三、改动清单

### C-1 频道层：未登录禁止建工作群

**文件**：`src/workgroup/host/channel.js`（`case 'create-room'`）

```js
const account = await wg.hub.restore().catch(() => undefined)
// 工作群是 Hub 上的群：没有账号就没有可加入的群，也没有同事可邀请（§8.1）。
// 未登录用户要的是「本地群」，那是另一个入口，由原版创建流程负责，行为不变。
if (account === undefined) {
  return fail('Sign in to the Hub first. A workgroup lives on the Hub, so there is nobody to invite without one. Local group chats work without signing in.', 'hub/not-signed-in')
}
// …原已登录分支保持逐字不变
```

**在服务端拒的理由**：客户端提示是体验，服务端拒绝是保证。否则 `apiHandle` 仍能造出无 Hub 身份的工作群。

**测试**（`test/workgroup-hub-identity.test.js`，新）：
- 未登录 `create-room` → `{ ok: false, code: 'hub/not-signed-in' }`，且 `wg.state.workgroups` 未新增键
- 未登录 `state` 里房间数不变
- 已登录 `create-room` → 成功，返回的 room 有 `hubWorkgroupId`（防回归）

---

### C-2 `invite-member` 支持用户 ID

**文件**：`src/workgroup/host/channel.js`

现状只转发 `phone`；而 `wg.hub.invite`（`hub.js:372-378`）与 Hub 服务端（`workgroups.invite()`）都已支持 `hubUserId` 或 `phone`。

```js
const phone = String(body.phone ?? '').trim()
const hubUserId = String(body.hubUserId ?? '').trim()
if (phone === '' && hubUserId === '') throw invalid('Enter a phone number or a Hub user id')
const invite = await wg.bridge.invite({
  workgroupId,
  ...(phone === '' ? {} : { phone }),
  ...(hubUserId === '' ? {} : { hubUserId }),
})
```

**测试**：只传 `hubUserId` 成功；两者都空被拒；`hubUserId` 不存在 → Hub 的 `workgroup/invitee-unknown` 原样透出。

---

### C-3 复制 `group-settings.js` 到工作群域

**新增**：`src/workgroup/client/group-settings.js`

**复制方式**：以 `src/client/group-settings.js`（180 行）为源，逐字复制后做**方案 §5.1 指定范围**的改造：

| 部分 | 处理 |
|---|---|
| `ROOM_MODES` / `shownMode` / `roomSubtitle` | **原样复制**（`details-drawer` 也 import 它们，复制件导出同名可避免改动原版） |
| `NewGroupForm` | **不复制**（只有设置页的 `groups` 页用它，属本地群创建，工作群创建走 `new-chat.js`） |
| `GROUP_SETTINGS_CSS` | **原样复制**（原版已在别处注入；复制件导出同名常量不重复注入时无害，见实现说明） |
| `GroupSettingsForm` | 复制后改造：①成员卡末尾加 `<WorkgroupInviteRow>` ②成员行显示工作群成员（含真人）③其余设置项保持不变（`actions` 已分域） |

**依赖**：复制件复用原版的 `Card/Row/SwitchRow`（`bot-settings.js`）、`BotAvatar/BotMark/RoomAvatar/AdminStar`（`mark.js`）、`Segmented`、`FolderMenu`、`PermissionPicker`、`t`——这些都是 §5.3 的"复用且不重复安装"类（原版通用组件），直接 import 原版即可，不复制。

> 逐个 import 路径核对见实现时的 §六"依赖核对表"。

---

### C-4 新增 `WorkgroupInviteRow`

**新增**：`src/workgroup/client/invite.js`

**接口**：`h(WorkgroupInviteRow, { room })`

**四种状态，控件始终显示**（用户要求）：

| 状态 | 判据 | 输入框 | 按钮 | 说明文案 |
|---|---|---|---|---|
| 可邀请 | `room.hubWorkgroupId` 有值 | 可输入 | 可点 | — |
| 未登录 | `hub-state.loggedIn === false` | 可输入 | 禁用 | 「先登录 Hub 才能邀请同事」+「打开 Hub 账号」 |
| 群未上 Hub | `hubWorkgroupId === undefined` | 可输入 | 禁用 | 「这个群还没连到 Hub」 |
| 提交失败 | Hub 拒绝 | 保留输入 | 可重试 | Hub 原话（如 `workgroup/invitee-unknown`） |

**成功回执**：显示 Hub 返回的 `inviteePhoneMasked`（打码），与 `InviteInbox` 文案一致。

**输入语义**：一个输入框，接受手机号或用户 ID。判据：以 `+` 或纯数字开头 → `phone`；以 `usr_` 开头 → `hubUserId`。两者都不像时按 `phone` 提交，让 Hub 的校验给出结论（错误信息更准确）。

---

### C-5 `details-drawer.js` 按域择优（**唯一需要动原版的地方**）

**文件**：`src/client/details-drawer.js`

**为什么必须动**：用户实际路径是"工作群 → 齿轮 → 群设置"，这条路径由 `details-drawer.js` 渲染。不动它，复制件在这条路径上仍不可达。

**改动范围（仅一处）**：

```js
// 原
bot ? h(BotSettingsForm, { bot, roster, actions, run })
    : h(GroupSettingsForm, { room, roster, actions, run, onDeleted: close })

// 新
bot ? h(BotSettingsForm, { bot, roster, actions, run })
    : room.workgroup === true
      ? h(WorkgroupGroupSettingsForm, { room, roster, actions, run, onDeleted: close })
      : h(GroupSettingsForm, { room, roster, actions, run, onDeleted: close })
```

`room.workgroup === true` 是 `groupRooms()`（`src/client/sources.js:57`）给工作群副本打上的标记，**原版 room 没有这个字段**，因此本地群走原分支，行为逐字不变。

**需要同时做的合规动作**：把 `src/client/details-drawer.js` 补进方案 §5.2 的 B 类清单（记进 `diff-manifest.md`），并写明改动的唯一理由。

---

### C-6 `settings.js` 同样择优

**文件**：`src/client/settings.js`（§5.2 已允许修改）

```js
// 原（第 246 行）
room ? h('div', {...}, h(GroupSettingsForm, { key: room.id, room, roster, actions, run })) : null

// 新
room ? h('div', {...}, room.workgroup === true
  ? h(WorkgroupGroupSettingsForm, { key: room.id, room, roster, actions, run })
  : h(GroupSettingsForm, { key: room.id, room, roster, actions, run })) : null
```

---

### C-7 审批卡搬进复制件的群设置（G5 收口）

**问题**：`BotPanel` 不可达，意味着 G5 的「等你处理」审批卡在界面上也不可达。G5 门禁 1/2 要求"B 本人审批"，而 B 点不到审批卡。

**改法**：在复制件的群设置里，成员卡之后加一张 `<WorkgroupTaskCards room={room} />`，位置在邀请行下方。

**新增**：`src/workgroup/client/tasks.js` — 把 `panel.js` 里已有的 `ApprovalCards` 逻辑抽成可复用组件，两处共用（`panel.js` 与复制件）。行为不变：只对**本群**的待办、只给本人、批准/拒绝走 `task-decide`。

**为什么归到这里**：用户要的是「建工作群 → 邀请同事 → 同事派任务 → 本人审批」这条闭环。只修邀请，G5 仍只能靠脚本验证。

---

### C-8 Hub 允许局域网绑定（多机前提）

**文件**：`hub/src/config.js`、`hub/src/server.js`

**config.js** 新增：

```js
const allowPlaintextLan = env.HUB_ALLOW_PLAINTEXT_LAN === '1'
// 无 TLS + 非 loopback + 未显式允许 → 启动即报错，并给出两条出路
if (cert === undefined && !isLoopbackHost(host) && !allowPlaintextLan) {
  throw new ConfigError(
    `Refusing to listen on ${host} without TLS: passwords would cross the network in the clear. `
    + 'Set HUB_TLS_CERT and HUB_TLS_KEY, or set HUB_ALLOW_PLAINTEXT_LAN=1 to accept that.',
  )
}
```

**server.js**：删掉静默改写，改为使用 config 已校验的 host；若仍然越界则抛错（不静默降级）。

**启动日志**：明文 + 非 loopback 时打印
`plaintext on 0.0.0.0: passwords cross the network in the clear`。

**测试**（`hub/test/config.test.js` 追加）：
- 无 TLS + `0.0.0.0` + 无开关 → `ConfigError`（消息含两种出路）
- 有开关 → 通过，`insecureLoopbackOnly === false`
- 有 TLS + `0.0.0.0` → 通过（开关无关）
- `server.test.js`：明文 + `0.0.0.0` + 开关 → `server.address().address === '0.0.0.0'`

---

### C-9 客户端提示：未登录建工作群时给可操作入口

**文件**：`src/client/new-chat.js`（`makeGroup`）——已确认 `run()` 会 `setError(failure?.message)`，所以 C-1 的文案会自动显示。

**补充**：工作群模式下未登录时，在新建面板显示「登录 Hub」按钮（调已有动作打开设置页 Hub 账号页）。不隐藏「新建工作群」选项——按用户要求控件固定显示。

---

## 四、执行顺序

| 步 | 内容 | 依赖 |
|---|---|---|
| 1 | C-1 未登录拒绝 + 测试 | — |
| 2 | C-2 `hubUserId` 转发 + 测试 | — |
| 3 | C-8 Hub 绑定（独立，可并行） | — |
| 4 | C-3 复制 `group-settings.js`（先原样复制能编译，再改造） | — |
| 5 | C-4 `WorkgroupInviteRow` + 测试 | 4 |
| 6 | C-7 抽 `tasks.js`，复制件接入审批卡 | 4 |
| 7 | C-5 / C-6 两处择优渲染（触及原版两文件） | 4,5,6 |
| 8 | C-9 客户端提示 | 1 |
| 9 | 文档：`diff-manifest.md` 补 B 类、`gates.md`、`progress-and-gaps.md`、`g4/ROUND-LOG.md`（记录推翻未登录决定）、`manual-checklist.md` 多机步骤 | 全部 |

---

## 五、验证口径

```
cd ds-bot && npm test                                # 期望 1024 + 新增全绿
cd ds-bot && node scripts/build-client.mjs --check    # exit 0（复制件参与构建）
cd ds-bot && npm run lint                            # 0 error
cd hub && npm test                                   # 253 + 新增全绿
git status --porcelain ds-bot/src/host/              # 必须为空
```

**新增测试清单**

| 文件 | 断言 |
|---|---|
| `test/workgroup-hub-identity.test.js`（新） | 未登录建群被拒且无残留；已登录建群带 `hubWorkgroupId` |
| `test/workgroup-invite.test.js`（新） | 四种状态都渲染输入框；未登录时按钮禁用；提交手机号/用户 ID 各一条；失败显示 Hub 原话 |
| `test/workgroup-ux.test.js`（追加） | 「邀请同事」出现在「添加成员」之后；复制件被两处渲染点引用 |
| `test/install.test.js`（如顺序变化则改） | 注册顺序 |
| `hub/test/config.test.js`（追加） | 四种绑定组合 |

**多机验收步骤（改写后）**

1. Hub：`HUB_HOST=0.0.0.0 HUB_ALLOW_PLAINTEXT_LAN=1 npm start`（或配 TLS）
2. A、B 各自登录不同手机号（B 须先注册）
3. A 新建工作群 → 群已在 Hub 上
4. A 打开该群 → 齿轮 → 群设置 → 「添加成员」下方「邀请同事」→ 填 B 的手机号或用户 ID
5. B 登录后在 Bot 面板看到邀请 → 加入
6. 双向聊天；A 派任务 → B 在「群设置 → 等你处理」看到审批卡

---

## 六、风险与回退

| 风险 | 处理 |
|---|---|
| 复制件与原版漂移 | 复制时逐字，仅改方案 §5.1 指定的部分；`diff-manifest.md` 记录差异；一条测试断言复制件导出与原版同名常量一致 |
| `details-drawer.js` / `settings.js` 改动 | 仅一处三元分支，`room.workgroup === true` 判据原版不存在；本地群路径行为不变，由现有 `group-*` 测试守 |
| 未登录建群被拒影响既有测试 | 检查所有依赖 `create-room` 未登录分支的测试，逐一改为"先登录"或改为断言拒绝 |
| Hub 绑定变更影响现有测试 | 现有测试用 `127.0.0.1`，不受影响；新增四种组合测试 |

---

## 七、明确不做

- **`bridge-link-group`（老群补挂 Hub）**：用户可从头测，不做。
- **不修改**：`src/host/{groups,turns,delivery,resume,constants}.js`（硬规则 2，逐字节不变）。
- **不改** `src/client/group-settings.js`（本次改为复制，原版零改动）。
- 不发版、不改版本号、不打包。
