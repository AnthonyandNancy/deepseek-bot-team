> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/diff-manifest.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1 差异清单（diff-manifest）

基线：`ds-bot@0.1.7` @ `939a6635830cb5b246e7dd19c67b0e1352ad1c07`，原始快照在 `BotCode/DeepSeek-Bot-main.zip` 解压出的快照。

**核对方法**：对 `ds-bot/src/` 下每个文件与快照做逐字节比较（`diff`）。凡未列在下面两张表里的 `src/` 文件，都与上游**逐字节相同** —— 这条可以用命令随时复核：

```bash
for f in $(cd ds-bot/src && find . -name '*.js'); do
  [ -f "$SNAPSHOT/src/$f" ] && ! diff -q "ds-bot/src/$f" "$SNAPSHOT/src/$f" >/dev/null && echo "MOD $f"
done
```

本清单由 `test/workgroup-ux.test.js` 的两条断言守护：新增/修改文件必须在此登记，且"未修改的原版文件"一节必须保留 `src/host/groups.js`、`turns.js`、`resume.js`、`delivery.js`、`constants.js`。G2 起，G2 自己新增与改动的文件（`src/workgroup/host/tasks.js`、`src/host/tools.js`、`src/host/capabilities.js`）也在这两条断言里 —— 上一次它们没被守护，所以 `tools.js` 被错列在"未修改"里整整一个阶段。

> 本文件在 G1 收口时被重写过一次。上一版把工作群 UI、`/api/workgroup` 路由、升级入口都写成"未做"，而它们早已完成；也没有登记 `src/host/channel.js` 的改动。差异清单本身是 G1 门禁的一条（"准确保存差异清单"），所以那次不准确等同于门禁未过。

---

## 1. 新增文件（上游不存在，共 12 个）

### 1.1 工作群域服务端

| 路径 | 行数 | 作用 | 对应 G0 项 |
|---|---|---|---|
| `src/workgroup/index.js` | 63 | 单次安装入口；二次安装抛错；域安装失败只 warn，不拖垮原版团队 | P0-2、方案 6.2 |
| `src/workgroup/shared/constants.js` | 62 | `WG_SOURCE_KIND='workgroup'`、`WG_TOOLS`（3 个工具名）、`WG_ROUTE`、`WG_DIR`、日志与回合限制 | P0-3、P0-18 |
| `src/workgroup/host/state.js` | 110 | 独立状态文件 `.dsh/bot/workgroup/state.json`；promise 缓存式 load、写盘队列。G2 加入 `tasks` 子树（方案 §6.4 要求任务绑定持久化） | P0-1、方案 12、6.4 |
| `src/workgroup/host/ownership.js` | 212 | `wg.sessionOwners` + `resolveSessionOwnerStrict()`；`domain`/`kind` 分离；双域声明直接抛错。G2 增加 `sessionGroupScope()`（`message_bot` 的群作用域）并扩展 `selfOf`/`groupSessionsOf` 以覆盖工作群成员 Session | P0-1、P0-5、方案 6.1、6.2 |
| `src/workgroup/host/groups.js` | 1648 | 上游 `src/host/groups.js`（877 行）的完整复制：room log、串行回合、@/@all、relay、改名、成员变更、Stop、resume、删除、`read_own_chat`、`reportBack`、附件/图片/引用 | P0-2、P0-3、P0-8、方案 5.1 |
| `src/workgroup/host/tasks.js` | 215 | **G2 新增**：Task Session 注册表。`registerTask`/`taskOf`/`liveTask`/`tasksOf`/`advanceTask`/`releaseTask`；方案 §10.2 状态机只放行它点名的转移；过期在写入与 `RUNNING` 两处分别校验；经同一个 `onStateLoaded` 挂载点（链式，不覆盖）从状态文件重建 | 方案 6.4、10.2、10.3 |
| `src/workgroup/host/channel.js` | 219 | `POST /api/workgroup`：list/room/room-progress/create/update/delete/send/stop-round/stop-member-work/upgrade-room | P0-18、方案 5.4 |

### 1.1b Hub 账号（G3 新增）

| 路径 | 行数 | 作用 |
|---|---|---|
| `src/workgroup/host/hub.js` | 262 | Hub HTTP 客户端：注册/登录（提交后立即丢弃密码）、refresh 轮换、设备 challenge+签名+注册、设备列表/撤销、健康检查。**access token 只在内存**，refresh token 与设备私钥只进 store。 |
| `src/workgroup/host/hub-store.js` | 128 | 凭据落盘。优先用 Harness 的 `ctx.credentials` 接缝（`$DSH_HOME/.credentials.yaml`，0600，接缝自身拒绝组/他人可读）；该服务不存在时回退到 `~/.dsh/bot/hub/account.json`（0600，写前校正权限）。**不是 OS 钥匙串**——插件宿主进程里没有 `electron`，取不到 `safeStorage`，见 `docs/workgroup/g3/PLAN.md` §0。 |
| `src/workgroup/host/hub-format.js` | 25 | 脱敏与状态文案的唯一出处，host 与页面共用，避免两边对「+86****8000 长什么样」有分歧。 |
| `src/client/hub-settings.js` | 246 | 「Hub 账号」设置页。只用原版 `SetSection`/`SetRow`/`bt-set-*`/`bt-field`/`bt-input`/`bt-soft`，不新造视觉。五个状态：未配置、未登录、已登录、错误、离线。 |

**为什么放在工作群域而不是 `src/host/`**：Hub 连接属于远程域，`src/workgroup/index.js` 里 `wg.bridge` 的占位符和注释从 G1 起就写着 "filled in G3+"。放这里可以不碰原版群聊的任何代码路径；代价只是设置页多一次 import。

### 1.2 工作群域客户端

| 路径 | 行数 | 作用 |
|---|---|---|
| `src/workgroup/client/api.js` | 33 | 只打 `api/workgroup`，永不落回 `api/bot` |
| `src/workgroup/client/index.js` | 130 | 「Bot」侧栏入口与面板挂载 |
| `src/workgroup/client/panel.js` | 328 | 工作群列表/创建/改名/删除/发送/停止；实测连接状态 |
| `src/workgroup/client/rows.js` | 73 | 工作群行（与原版群行同款间距与类型） |
| `src/workgroup/client/styles.js` | 90 | `bt-wg-*` 样式，全部由本文件定义 |

### 1.3 测试与文档

| 路径 | 作用 | 对应门禁 |
|---|---|---|
| `test/workgroup-isolation.test.js` | 两域互不干扰（WG-01…WG-10） | T02 / T03 |
| `test/workgroup-round.test.js` | 回合行为：创建、改名、@、讨论、进度、Stop、删除、恢复、`read_own_chat`、inbox、reportBack | G1「创建、改名、@、讨论、进度、Stop、删除、恢复」 |
| `test/workgroup-files.test.js` | 附件、图片读数、引用进提示词 | G1「原版群功能不回归」 |
| `test/wg-activity.test.js` | 成员工作中出现在图标/输入行/底部卡片（一次轮询的三个视图） | G1「进度」 |
| `test/workgroup-ux.test.js` | 六个交互约束 + 差异清单自身准确性 | 方案 §14 G1 |
| `test/hub-store.test.js` | 凭据落盘：优先接缝、回退 0600 文件、不完整 payload 拒绝、损坏文件读作「无账号」 | G3 指令第 11 条 |
| `test/hub-client.test.js` | 对着**真实 Hub** 跑：注册即注册设备、密码不落盘、换机保持 hubUserId、错误密码与网络错误区分、refresh 轮换、撤销自行登出 | 门禁 2、3 |
| `test/hub-offline.test.js` | **门禁 5**：签出状态下原版 `state`/`create-bot`/`create-room` 全部可用；Hub 指向死端口后仍全部可用 | 门禁 5 |
| `test/hub-account-switch.test.js` | 换账号后旧凭据与旧 deviceId 不残留；页面不出现「已验证」、不含 token/私钥字段、两次密码不一致不发请求 | 指令第 9、12 条 |
| `docs/workgroup/g3/**` | G3 计划与门禁证据 | 方案 16.3 |
| `docs/workgroup/g0/**`、`docs/workgroup/g1/**` | G0/G1 报告与证据 | 方案 16.3 |

---

## 2. 修改文件（相对上游有改动，共 16 个）

### 2.1 服务端（7 个）

| 路径 | 改动 | 原因 | 对应项 |
|---|---|---|---|
| `index.js` | 末尾调用 `installWorkgroup(rt)`，受 `config.workgroup !== false` 控制；`require()` 延迟加载 | 单 Runtime 内接入工作群；加载失败不拖垮原版 | P0-2、方案 5.2 |
| `src/host/store.js` | +16 行：`rt.resolveSessionOwnerStrict ??=` 默认实现 | 让所有调用方都能依赖该函数存在；**不改变** `selfOf`/`isBotSession`/`groupOwners` 任何原语义 | P0-1、P0-5 |
| `src/host/channel.js` | +29 行：`live()` 里把工作群域的 `activity`/`work` 视图**只读合并**进同一次状态应答 | 工作群成员 Session 既不是 Bot 自己的会话、也不是本地群，原版 `turns.js:352` 会丢弃它，所以 `rt.live` 里永远没有它；不合并则工作群没有"思考中"与底部卡片 | P0-3、方案 5.1 |
| `src/host/diagnostics.js` | +45 行：诊断信息里带上工作群状态 | 排障可见性 | 方案 16.3 |
| `src/host/secrets.js` / `src/host/usage.js` | +7 / +8 行 | 过滤与统计不把工作群 Session 当成本地 Bot | P0-3 |
| `src/host/tools.js` | +52 行：`callInGroup` 改为接收"群作用域"；新增 `groupScopeOf()` 与 `speakerOf()`；`hideBotUnusedTools` 的 Bot 判定改用 `selfOf` | **G2 S1**：`message_bot` 原来只查 `rt.groupOwners`，而工作群成员 Session 从不写入该索引（P0-3），于是"群外 `message_bot` 旁路"这条拒绝逻辑对工作群是**死代码**；更严重的是同一个索引还决定"发送者是谁"，工作群成员调用 `message_bot` 会直接返回 "Only Bots on the team"，谁都够不到。改用 `resolveSessionOwnerStrict` 单点分流后，群内成员按 `@Name` 语义调用、群外一律拒绝。**G2 S5**：`hideBotUnusedTools` 用 `isBotSession` 作闸门，该标志同时驱动原版 turn 机制（`turns.js:352`），所以工作群域刻意不为自己的 Session 应答它——改用语义更窄的 `selfOf`，成员才和本地群成员一样被收敛工具 | P0-3、方案 6.2、6.3 |
| `src/host/capabilities.js` | +7 行：`botOfSession` 由 `rt.isBotSession(id) ? rt.botOf(rt.selfOf(id)) : undefined` 改为 `rt.botOf(rt.selfOf(id))` | **G2 S3**：原写法对工作群成员恒为 `undefined`，因此 `ensureCapabilities` **一个能力都没挂载**（工具、MCP 全缺），且无任何报错。`botOf` 仍然兜底，把"不替任何 Bot 说话的 Session"（群自己的 relay Session、普通 DSH Session）判回 `undefined`，原语义不变 | 方案 6.4、10.4 |

### 2.2 客户端（8 个）

| 路径 | 改动 | 原因 |
|---|---|---|
| `src/client/index.js` | +119 行 | 「Bot」入口、工作群行进入侧栏、`roomProgress` 按 id 走正确路由 |
| `src/client/cells.js` | +13 行 | `group_relay` 卡片也画工作群的回合结果 |
| `src/client/text.js` | +11 行 | `toolName()` 把 `workgroup_relay` 归一成 `group_relay`，复用原版渲染 |
| `src/client/sources.js` | +22 行 | 工作群记录适配成原版群组件读取的形状 |
| `src/client/sidebar.js` | +21 行 | 工作群行出现在原版侧栏列表（不新开分区） |
| `src/client/new-chat.js` | +24 行 | 新建群菜单里可选工作群 |
| `src/client/context-menu.js` | +5 行 | 工作群行的右键菜单 |
| `src/client/at-menu.js` | +8 行 | `chatRows()` 的"团队自己的对话"排除集合也包含工作群（见 §6.3c） |
| `src/client/i18n.js` | +29 行（G1）、+33 行（G3） | 工作群文案；并删掉一条已失引用的 key（`A workgroup needs a name`，名字已不再必填）。G3 增加「Hub 账号」页的文案，其中手机号一律说明**未验证**。 |
| `src/client/settings.js` | +6 行 | G3：`SETTINGS_PAGES` 加一条 `['hub','Hub account']`、加一个 `HubIcon`、渲染一行、一个 import。其余分毫未动——这是 Hub 页能复用原版视觉的原因 |

### 2.3 生成物

| 路径 | 说明 |
|---|---|
| `client.js` | `src/client/**` + `src/workgroup/client/**` 的 esbuild 产物。`npm run build` 重建，`npm run check` 校验与源码一致。**不是手写文件。** |

---

### 2.4 G3 对工作群域已有文件的改动

| 路径 | 改动 | 原因 |
|---|---|---|
| `src/workgroup/index.js` | +2 行 | `hub` 模块加入 `WG_MODULES`（在 `groups` 之后、`channel` 之前：channel 要回答 `hub-*` 端点，需要 `wg.hub` 已存在）。填入的正是 G1 起就留着的 `wg.bridge` 占位符。 |
| `src/workgroup/host/channel.js` | +45 行 | 新增 `hub-state`/`hub-login`/`hub-register`/`hub-logout`/`hub-devices`/`hub-me`/`hub-revoke-device`/`hub-health` 八个端点，以及 `READS` 加上 `hub-state`、`hub-devices`。**与上面所有工作群端点完全分离**：Hub 失败不能干扰工作群调用。 |

---

## 3. 明确**未**修改的原版文件（关键负向证据）

下列文件与上游快照**逐字节相同**（`diff` 无输出）。这是"本地群完全不回归"最直接的证据：

| 路径 | 为什么重要 |
|---|---|
| `src/host/groups.js` | 原版本地群核心**零改动** —— 工作群是复制品，不是改原版 |
| `src/host/turns.js` | `rt.roomWaiters/roomProgress/roomInbox` 语义与注册顺序**零改动** |
| `src/host/resume.js` | `rt.deliver` 的包装**零改动**（P0-9：不在其上再叠一层） |
| `src/host/delivery.js` | 投递语义**零改动** |
| `src/host/constants.js` | `SOURCE_KIND='bot'`、`TEAM_TOOLS`、`ROUTE` **原值未动** |
| `src/host/parts.js`、`src/host/approvals.js`、`src/host/memory.js` | 上下文分段、审批、私人记忆 **零改动** |

> 注 1：`src/host/channel.js` 曾在上一版清单里被列在本节，是**错的** —— 它为了合并工作群的活动视图改了 29 行，现已移入 §2.1。
>
> 注 2：`src/host/tools.js` 也曾在上一版清单里被列在本节，同样**是错的**。G2 为修 "群外 `message_bot` 旁路" 与工具收敛改了它 52 行，现已移入 §2.1。这是本清单第二次因为"登记时没跑 diff"而出错，所以头部的复核命令现在是 G2 收口的必跑项，而不是可选说明。
>
> 注 3：`src/host/capabilities.js` 在 G1 期间确实逐字节相同，G2 改了 7 行（见 §2.1）。

---

## 4. 已知为"设计变更"而非回归的测试断言

| 测试 | 为何必须改 | 反向价值 |
|---|---|---|
| `test/install.test.js` 精确注册顺序 | 工作群新增注册项 | 若该列表在 G1 完成后**没变**，说明工作群模块根本没被安装 |
| `test/agents.test.js` 的 `TEAM_TOOLS` | 新增 3 个 `workgroup_*` 工具 | 改法保留原意：原版工具集仍精确等于 `TEAM_TOOLS`，且两套名字不相交 |

---

## 5. G1 之外仍未做（不属于 G1 门禁）

| 项 | 归属 | 说明 |
|---|---|---|
| `post_to_group` 不认识工作群 | G4 | 它是原版 `src/host/tools.js:454` 的工具；让工作群域注册自己的发帖工具会再造一套工具名，违反"不重复工具名"，应与 Bridge 和独立 UI 一起做 |
| 本地群"升级为工作群"的完整语义 | G4 | 端点 `upgrade-room` 已有，幂等与归档语义随 Hub 一起验 |
| 改管理员的 UI 入口 | G1 门禁外 | `update-room` 支持 `adminId`，面板上没有按钮；门禁只要求"改名" |
| 工作群群记忆 | G6 | — |
| 远程成员投递 | G4 | `wg.deliver` 是预留的唯一接缝 |
| 真机端到端（两机实时、视觉对照） | G4 | 需 Hub |

---

## 6. G2 追加的差异（§14 G2 门禁）

G2 的改动全部在上表登记过；这一节单独说明**为什么必须改原版文件**，因为方案 5.1 要求修改 A 类原版文件时必须给出理由。

| 文件 | 为什么不能在工作群域内解决 |
|---|---|
| `src/host/tools.js` | `message_bot` 由原版注册，工具名全局唯一（P0-2 禁止注册同名工具）。工作群域**无法**在不重注册该工具的前提下改变它内部"先查 `groupOwners` 得到房间、再由 `selfOf` 得到发送者"这两步。把工作群 Session 写进 `rt.groupOwners` 能让它查到，但那正是 P0-3 禁止的跨域声明，会让原版的 turn 机制开始处理工作群的回合。所以只能在工具边界用 `resolveSessionOwnerStrict` 单点分流——这正是方案 §6.2 规定的做法。 |
| `src/host/capabilities.js` | 能力挂载（工具与 MCP）由原版 `reconcileAgent` 负责，工作群域没有第二套挂载器，也不应有（那会变成两套并发设计）。唯一的接缝是 `botOfSession` 这一个断言：它用 `isBotSession` 当闸门，而工作群域出于 P0-3 刻意不应答该标志。改这一行是让挂载器认识工作群成员的最小改动，`botOf` 仍然兜底。 |

### 6.1 G2 期间新增的原版文件差异（必须与上表一致）

- `src/host/tools.js`：**从"逐字节相同"移出**。上一版清单把它列在 §3，是错的（见 §3 注 2）。
- `src/host/capabilities.js`：**从"逐字节相同"移出**（见 §3 注 3）。

### 6.2 G2 复审（第二轮）追加的两处改动

G2 收口后按要求"重新核对 G2 任务和所有代码"，发现两处**由 G2 自身引入**的缺陷并修掉：

| 文件 | 缺陷 | 原因 |
|---|---|---|
| `src/workgroup/host/groups.js` | 工作群成员 Session 会拿到**两个** `# Your identity` 段（`bot-identity` order 640 与 `workgroup-relay` order 641） | G2 为让能力挂载与撤权传播生效而扩展了 `rt.selfOf`，而 `src/host/prompt.js` 正是用它渲染身份段。于是 `prompt.js` 开始为工作群成员输出身份，本域那段又输出一次——本地群成员只有一段。现改为：身份归 `prompt.js` 独有，本域那段只补"这是工作群"这一句；仅当 Bot 已被删除（`prompt.js` 无内容可渲染）时本域才自己写头，且仍只有一段 |
| `src/host/tools.js`、`src/workgroup/host/ownership.js` | 工作群的拒绝话术让管理员"add it yourself with update_group first"，而 `update_group` 只认本地群，照做会得到 `No group chat called "…" that you can see` | 拒绝里给出的每条建议都必须是**真能执行**的。群作用域新增 `canBeChangedHere`，本地群为 `true`（`update_group` 确实管得到），工作群为 `false`（其成员变更走本域 `update-room`，G4 之前没有 Bot 工具可达）。本地群话术逐字不变 |

两处都有 `test/workgroup-prompt.test.js`（新，3 条）与 `test/workgroup-messaging.test.js` 的第三条守护，且都验过"修复前必失败"。

### 6.3 G1 复制完整性补漏：右键菜单

用户报告「工作群无法重命名群名称，提示找不到该群」和「工作群无法删除…提示找不到该群」。两者同一个根因，且是**G1 复制遗漏**，不是 G2 引入的：

| 文件 | 缺陷 | 原因 |
|---|---|---|
| `src/client/context-menu.js` | 工作群行的右键菜单调用 `actions.renameBot` / `actions.deleteRoom` / `actions.setFlags` —— 全是**本地群**的动作，拿工作群 id 去调本地路由 | 菜单按 `roster.byId` / `roster.roomsById` 找条目，而工作群**故意**也索引在 `roomsById` 里（`sources.js` 的 `groupRooms` 打了 `workgroup: true`），所以菜单画得出来；但原版动作只认本地群，`delete-room`/`update-room` 在 `state.rooms` 里找不到该 id，于是 `Unknown group chat`。G1 把侧栏行、面板、输入框都接到了工作群路由，**唯独漏了右键菜单** |
| `src/client/index.js`、`src/workgroup/client/panel.js` | 新增 `renameWorkgroup` / `deleteWorkgroup` / `openWorkgroupSettings`，面板导出可复用的 `renameWorkgroup` / `deleteWorkgroup` / `forgetWorkgroup` | 让菜单与面板共用同一条实现，不复制第二套 |
| `src/workgroup/host/channel.js` | 新增 `set-flags` 端点 | 侧栏行的 Pin / 标为未读 / 从侧栏隐藏 同样打到原版路由，工作群会得到 `Unknown conversation`（找不到这个对话）。这些标志属于本域记录，只有本域路由能写 |
| `src/client/i18n.js` | 新增 `Workgroup settings` 中文 | `test/i18n.test.js` 会抓未翻译的字面量（它确实抓到了一次） |

菜单现在按 `entry.workgroup` 分流，并且**不再给出工作群做不到的条目**（「升级为工作群」只对本地群显示）。

测试：`test/workgroup-menu.test.js`（新，5 条）+ `workgroup-round.test.js` 的 `set-flags` 路由用例。均验过"修复前必失败"。

### 6.3b G1 复制完整性补漏：工作群设置的每一条写入

用户随后报告「工作群的群设置，菜单等等 设置 功能全部无法写入设置，都是 提示无法找到这跟群聊」。同一个复制缺口的**其余部分**——6.3 只修了用户当时点到的两条（右键菜单的重命名、删除），设置面上的其他写入仍然指向本地团队。

根因一句话：工作群被**故意**索引进 `roomsById`（`sources.js` 的 `groupRooms`），所以原版的每个群感知组件都找得到它并渲染出来；它们随后调用**原版动作**，而原版动作只认 `state.rooms`。

| 文件 | 缺陷 | 原因 |
|---|---|---|
| `src/client/index.js` | `updateRoom` / `deleteRoom` / `setFlags` 三个动作现在按 id 所属的域分流（新增 `workgroupOf`） | 信息抽屉的「群设置」、设置页的 `GroupSettingsForm`、菜单、重命名输入框全部经由这三个动作写入。工作群 id 不在 `state.rooms` 里，本地路由答 `Unknown group chat`（找不到该群聊），一个字段都没写进去。**在动作层分流而不是改表单**，是为了让 `group-settings.js` 保持原版拷贝：两个域共用同一份设置界面 |
| `src/client/index.js` | `updateRoom` 把本地字段名译成工作群的：`admin` → `adminId` | 原版表单发的是 `admin`；工作群的管理员是成员记录（将来可能不是本地 Bot），存的是 `adminId` |
| `src/client/index.js` | `openWorkgroupSettings` 打开 `'groups'` 页而不是不存在的 `'workgroups'` 页 | `SETTINGS_PAGES` 里没有 `'workgroups'`，`SettingsDialog` 对未知页**回退到 General**。于是「工作群设置」这一项静默打开了错误的页面，它承诺的设置根本到不了 |
| `src/client/index.js` | roster 重新索引时比较**全部字段**，不再只比 `name` | 设置表单渲染的是 roster 里那份工作群记录。只比名字时，公告 / 回复模式 / 管理员 / 工作目录 / 权限预置的修改写进文件后，打开的表格仍显示被替换掉的旧值——外观上与「设置无法写入」完全一样 |
| `src/workgroup/host/channel.js` | `update-room` 端点接受原版的全部字段：`name`、`notice`、`mode`、`adminId`（兼容 `admin`）、`members`、`add`、`remove`、`workDir`、`permission` | 端点原先只转 5 个。表单发出去的字段被**静默丢弃**，端点照样答 OK |
| `src/workgroup/host/groups.js` | `updateWorkgroup` 补上 `mode`、`workDir`、`members`；`add` 改为接受**成员 id** | `mode` 与 `workDir` 原先完全没有处理器，转发到这一层就消失。`add` 原先读 `member.id`，而原版表单发的是 `update({ add: [bot.id] })` —— 纯 id，于是**一个成员都没加上**，可表单已经把「已添加」的那行画出来了 |
| `src/workgroup/host/ownership.js` | 本域解析自己的 `workDirOf`，其余落回原版 | `folders.js` 的 `workDirOf` 读 `rt.roomOf(roomId)?.workDir`，而 `rt.roomOf` 只认本地群。工作目录写进了记录却**从未被使用**——设置保存成功，成员实际工作目录不变 |
| `src/workgroup/shared/constants.js` | 新增 `WG_ROOM_MODES` | 本域自己校验回复模式，理由与同文件的轮次上限一致：调原版不能改变本域行为 |

测试：`test/workgroup-settings.test.js`（新，10 条）。其中 9 条在修复前失败，第 10 条「表单仍是原版、未被污染」是守卫（本该通过）。

### 6.3c G1 复制完整性补漏：工作群自己的 Session

用户报告「@的时候，显示的群名称不对」和「右键菜单删除的群聊，@的时候还存在」。两条都是同一个遗漏：**工作群是一个 Session，但复制时漏掉了原版保持两者同步的两步**。

| 文件 | 缺陷 | 原因 |
|---|---|---|
| `src/workgroup/host/groups.js` | 新增 `retitleWorkgroup(room)`，`updateWorkgroup` 在名字变化后调用 | COPY OF `retitleRoom`（`src/host/roster.js:292`）。原版 `updateRoom` 每次改名都 `await retitleRoom(room)`（`roster.js:461`），把群的 Session 标题改成群名。本域只复制了 `createSession(title)`，没复制后续同步，于是 Session 标题永远停在创建时——截图里群叫「阿松大」，@ 菜单显示的却是「You, Chief, 阿三大苏打」 |
| `src/workgroup/host/groups.js` | `updateWorkgroup` 对**未命名**群跟随成员自动改名（COPY `followMemberNames`，`roster.js:303`） | 原版规则 `if (room.named) continue`：用户起过名的群不因成员变化而改名。这条同时保护「用户命名的群不被悄悄改掉」 |
| `src/workgroup/host/groups.js` | `deleteWorkgroup` 归档群**自己**的 Session | COPY `deleteRoom`（`roster.js:477`）。原先只归档 `room.sessions`（成员们）的 Session，群自己的 Session 留了下来，而 @ 菜单的"对话"列表正是从 Session 列表来的——于是删掉的群还在 @ 里 |
| `src/workgroup/host/groups.js` | 新增 `adoptOrphans()`：清理旧版本删群时留下的孤儿 Session | 用户已经用旧版本删过群，那些 Session 已经孤立在磁盘上；只修删除路径的话，它们要等到用户再删一次才会消失——可群已经没了，删不了。`state` 读取时清理一次 |
| `src/workgroup/host/channel.js` | `state` 端点调用 `adoptOrphans()` | 挂在已有的 state 轮询上，不需要新端点、不需要用户操作 |
| `src/client/at-menu.js` | `chatRows()` 的团队排除集合加上工作群 | 原版排除 `roster.rooms`（本地群），而工作群**不在** `rooms` 里（`sources.js` 刻意只放 `roomsById`，避免侧栏画两遍），于是每个工作群都留在"可引用对话"列表里 |

`adoptOrphans` 只挑 `owner.botId === undefined` 的 Session——那是"群自己的 Session"与"成员 Session"的唯一区分点；成员 Session 一律不碰，否则会归档正在使用中的会话。

测试：`test/workgroup-title.test.js`（新，9 条）。7 条在修复前失败，2 条是守卫（"命名的群不因成员变化改名"、"孤儿清理不碰成员 Session"）。

### 6.3d 复制完整性核查：函数清单逐个比对

用户要求"确认所有任务都是复制原版群聊代码后改的"。做法不是读文档，而是**比对两个域的函数清单**：

```bash
grep '^  \(async \)\?function [a-zA-Z]' src/host/groups.js      | sed 's/(.*//' | awk '{print $NF}' | sort
grep '^  \(async \)\?function [a-zA-Z]' src/workgroup/host/groups.js | sed 's/(.*//' | awk '{print $NF}' | sort
```

原版 `groups.js` 877 行、`workgroup/host/groups.js` 1798 行。**共有的 12 个函数**（`callMembers`、`drainRoomInbox`、`lateRoomFailure`、`lateRoomReply`、`openingSpeakers`、`postStep`、`reportRound`、`roomPrompt`、`roomTurn`、`runRound`、`stopMemberWork` 等）**控制流逐行相同**，差异只有三类本域改造：`room.admin` → `room.adminId`、`rt.botOf(id)` → 本域成员记录、`groupSessionFor` → `sessionFor`。`round.replies.push` 两边各 10 处，四类 reply kind（`missed`/`lookup`/`approval`/`working`）各 5 处，结构完整对应。

原版独有的 6 个函数都只是**改名**，不是没复制：`keepGroupLine`→`keepLine`、`dropGroupLines`→`dropLines`、`greetRoom`→`greetWorkgroup`、`groupSessionFor`→`sessionFor`、`postToRoom`→`postToGroupSession`、`dropGroupLine`→`dropLine`。

但比对 `roster.js` 时发现**一个真的没复制**：

| 缺失 | 原版位置 | 后果 |
|---|---|---|
| `checkMembers`（群至少 2 人、最多 12 人） | `src/host/roster.js:312`，在 3 处调用（创建、写盘前复查、任何成员变更） | 工作群能建出**只有 1 个成员**、甚至**0 个成员**的群，而本地群直接拒绝。单成员群没有别人能回答用户，正是"没有响应"的来源 |

实测证据（探针，非推测）：

```
WORKGROUP one member: CREATED (no checkMembers) -> Solo
WORKGROUP zero members: CREATED -> Empty
LOCAL one member: refused -> A group chat needs at least two Bots
```

已补 `WG_ROOM_MIN_MEMBERS`/`WG_ROOM_MAX_MEMBERS` 与 `checkMembers`，并在原版同样的三处调用；更新路径先算目标名单再校验（COPY `planRoomChange` 的做法），所以被拒绝的变更不会半写入。

这一条同时迫使 6 个既有测试改用合法群（它们原先都靠单成员群搭脚手架），并按原版规则修正：`remove` 不能再把 2 人群删到 1 人，需要 3 人才允许离群。

### 6.3e 已知未覆盖（记录，不假装完成）

| 项 | 现状 | 归属 |
|---|---|---|
| 成员 `color` 字段 | 原版 9 处 `round.replies.push` 都带 `member.color`，本域 0 处。客户端有回落（`reply.color ?? 'gray'`），所以是**颜色退化**，不影响功能 | 外观，非门禁项 |
| 记忆审核 | `memory.js` 的 `agent/status` 触发器要求 `rt.isBotSession(id)`，工作群成员为 false，所以**成员的私人记忆审核完全不会启动**（连 `ownerOf` 都到不了） | 方案把群记忆放在 G6；此项属"成员个人记忆"，需在 G6 一并评估 |
| Session Part | 见 §6.3b 与 G2 审计 §5 注 E | G4 |

### 6.4 五个关键原版文件仍然逐字节相同

G2 之后重新复核，结论未变（`diff` 无输出）：

```bash
for f in src/host/groups.js src/host/turns.js src/host/resume.js src/host/delivery.js src/host/constants.js; do
  diff -q "ds-bot/$f" "$SNAPSHOT$f" >/dev/null && echo "IDENTICAL $f" || echo "DIFFERS $f"
done
```
