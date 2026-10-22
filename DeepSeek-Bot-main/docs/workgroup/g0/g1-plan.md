> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g0/g1-plan.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1 规划：最小代码变更 + 可执行回归测试

前提：G0 门禁状态见 `gates.md`。**本文件不是执行结果，是入场计划。**
冻结约束不变：只有 `hub/` 与 `ds-bot/` 两个一级代码目录；一个原生 DS Bot Runtime；不重写 Agent Loop。

---

## 1. G1 的范围边界（不做什么）

明确**不做**，以免越过门禁：

- 不实现任何 Hub 业务（无 HTTP/WSS 服务、无 OTP、无 SQLite 迁移）。→ G3/G4
- 不做跨用户任务执行、审批、BotAdapter。→ G5
- 不做群记忆检索。→ G6
- 不新增"工作群"之外的任何 UI 页面（唯一例外：为验证 Slot 接缝所必需的**最小**导航项占位）。
- 不重写群聊业务逻辑：全部以"复制 + 改名 + 隔离"完成。

---

## 2. 首要待验证项（Gate G1-A，在写任何业务代码之前）

方案 16.2 第 2 条把"DSH 官方 Slot 无法在规定位置增加 Bot 导航"列为必须立即反馈的阻塞。**目前源码无证据**（见 `source-audit.md` P0-19）。

必须先做一个**一次性探针**，回答 3 个问题：

| 问题 | 验收方式 |
|---|---|
| V1. `sidebar.workspaces` 之外，是否存在可插入"一级导航项"的 Slot？ | 在真 DSH（0.2.1-rc.2 与 0.2.1-rc.2）中枚举 `ctx.slots.entries()` 全部名称并落盘 |
| V2. 原版"插件"入口由谁渲染、是否暴露接缝？ | 定位该入口的 Slot/组件来源；若是 DSH 内置且无 Slot，**记录为阻塞** |
| V3. `freePriority()` 在真实条目集上是否仍能保证不冲突？ | 实测注册不抛错，且原有条目仍渲染 |

**产物**：`docs/workgroup/g1/slot-probe.md` + 原始 `ctx.slots.entries()` 转储。
**若 V1/V2 失败 → G1 阻塞**，按方案 16.2 上报，**不得**改用 DOM/CSS hack。

---

## 3. 最小代码变更清单（按依赖顺序）

### 变更 1：`src/workgroup/shared/constants.js`（新增，~40 行）

只放**新增**常量，不复制原版值：
```js
export const WG_SOURCE_KIND = 'workgroup'      // 独立于 SOURCE_KIND='bot'
export const WG_TOOL_PREFIX = 'workgroup_'
export const WG_ROUTE = '/api/workgroup'       // 独立于 ROUTE='/api/bot'
export const WG_STATE_VERSION = 1
```
**回归**：`constants.js` 原文件**零改动**（断言原值不变）。

### 变更 2：`src/workgroup/host/state.js`（新增，~120 行）

工作群独立状态，**不写入** `state.rooms`：
```js
wg.state = { version, workgroups: {}, links: {}, sessionOwners: {}, tasks: {} }
wg.statePath = join(rt.home, 'workgroup', 'state.json')   // 与 state.json 分离
```
- 读写复用 store.js 的加锁/write-through 语义，但**不同文件**（P0-1）。
- `sessionOwners` 事务持久化（方案 6.4）。

### 变更 3：`src/workgroup/host/groups.js`（复制 + 改造，877 行 → 目标 ~900 行）

复制来源：`src/host/groups.js` @ `939a6635`。逐项改造（每项都必须有测试）：

| 改造 | 原 | 新 | 测试 |
|---|---|---|---|
| 工具名 | `group_relay` / `read_group_chat` | `workgroup_relay` / `read_workgroup_chat` | 注册名唯一 |
| 工具名（共用风险） | `read_own_chat` | **不重复注册**；远程 Session 由 guard 拒绝 | T15 |
| rt 方法 | `rt.postToRoom` 等 9 个 | `wg.postToRoom` 等 | 原版 `rt.postToRoom` 仍存在且行为不变 |
| 三张 Map | `rt.roomWaiters/roomProgress/roomInbox` | `wg.roomWaiters/...`（新建 Map） | 串群测试 |
| 事件 kind | `SOURCE_KIND='bot'` | `WG_SOURCE_KIND='workgroup'` | 原版 turns 不消费工作群事件 |
| 群行目录 | `rt.home/group-lines` | `rt.home/workgroup/group-lines` | 路径断言 |
| 群 Session 归属 | `rt.groupOwners.set` | `wg.sessionOwners.set` | strict 解析 |
| 成员 | `botId` | `{kind:'user'|'localBot'|'remoteBot', id}` | 禁止远端人当本地 Bot |

### 变更 4：`src/host/store.js`（B 类，唯一改动点 ~30 行）

新增（不改原函数语义）：
```js
const resolveSessionOwnerStrict = (id) => {
  const local = groupOwners.get(id) ?? chatOwners.get(id)
  const remote = rt.workgroup?.sessionOwners.get(id)
  if (local !== undefined && remote !== undefined) throw new Error(`ds-bot: session ${id} belongs to two domains`)
  return remote ?? (local ? { kind: 'local' } : undefined)
}
```
- `indexSessions()` 末尾追加从 `wg` 持久映射重建。
- `Object.assign(rt, {...})` 追加 `resolveSessionOwnerStrict`。
- **不改** `selfOf` / `isBotSession` 的现有语义（避免原版回归）。

### 变更 5：`src/host/turns.js`（B 类，单点域分发 ~25 行）

`ctx.on('session/event')` 开头插入：
```js
const owner = rt.resolveSessionOwnerStrict(id)
if (owner?.kind === 'workgroup') return rt.workgroup.handleSessionEvent(session, event, owner)
```
**关键**：必须放在 `if (!rt.isBotSession(id) && !rt.roomOf(id)) return` **之前**，否则工作群 Session 被当无关 Session 丢弃。

### 变更 6：`src/workgroup/index.js`（新增，~60 行）

```js
export function installWorkgroup(rt) {
  if (rt.workgroup !== undefined) throw new Error('ds-bot: workgroup installed twice')  // 单次安装护栏
  const wg = { runtime: rt, state: null, sessionOwners: new Map(), roomWaiters: new Map(), roomProgress: new Map(), roomInbox: new Map(), tasks: new Map(), bridge: null }
  rt.workgroup = wg
  for (const m of WG_MODULES) m.install(wg)   // 只装工作群模块，绝不重跑 MODULES
}
```
`index.js` 仅在 `createRuntime()` **末尾**追加一行 `workgroup.installWorkgroup(rt)`。
**回归**：`test/install.test.js` 的 71 项顺序断言需追加新项——这是**预期差异**，必须显式更新并注明原因。

### 变更 7：`src/client/workgroup/*`（新增 UI，最小）

仅 4 个文件，全部沿用原版组件与样式：
- `sidebar.js`：`WorkgroupRow`（复制 `RoomRow`）+ 右键"升级为工作群"（占位，不联网）
- `group-settings.js`：复制 `GroupSettingsForm`，成员区改为 `{kind,id}` 渲染
- `context-menu.js`：在原版菜单 groups 数组追加一项
- `index.js`：装配（依赖 G1-A 结论）

**不做**：不新设计样式，不新增主题，不改消息气泡视觉。

---

## 4. 回归测试（可执行，全部基于现有 635 例）

### 4.1 必须继续全绿（不允许修改断言）

| 命令 | 期望 |
|---|---|
| `npm test` | 635 通过；**仅 `install.test.js` 顺序断言允许按设计更新** |
| `node scripts/build-client.mjs --check` | exit 0 |
| oxlint（scoped） | 0 errors |

### 4.2 G1 新增用例（写在新文件 `test/workgroup-isolation.test.js`）

| 编号 | 用例 | 期望 | 对应方案 |
|---|---|---|---|
| WG-01 | 安装两次 | 第二次抛错，未产生第二套工具 | T03 |
| WG-02 | 工具名集合 | 无重名；原版 25 个工具名全部保留 | T03 |
| WG-03 | 同一 Bot 同时在本地群与工作群发言 | 两条 waiter 互不触碰（原 `roomWaiters` 无工作群条目） | T02 |
| WG-04 | 工作群事件经 `session/event` | 只进 `wg.handleSessionEvent`，原版 live 不新增工作群条目 | T02/T03 |
| WG-05 | 一个 Session 同时登记两域 | `resolveSessionOwnerStrict` 抛错，拒绝执行 | 方案 6.1 |
| WG-06 | 工作群 state 与 `state.json` | 互不写入；删除工作群不动原版 rooms | P0-1 |
| WG-07 | 群行文件路径 | 落在 `home/workgroup/group-lines/**` | P0-4 |
| WG-08 | 无效工作目录 | `createSession` **失败关闭**，不回退团队目录 | T14 |
| WG-09 | 卸载插件 | 所有 wg disposer 执行；无残留监听 | T03 |
| WG-10 | 远端成员渲染 | `remoteBot` 不调用 `openSession`，不创建本地 Session | 方案 8.3 |

### 4.3 手工验收（G1 结束前）

1. 真 DSH 冷启动，本地群全功能回归：创建/改名/@/讨论/进度/Stop/删除/恢复。
2. 工作群（本地测试消息，不联网）同样 7 项。
3. 两个群同时活动，观察无串群、无重复消息。
4. 重载插件（不重启 DSH），确认无重复监听、无同名工具。
5. 截图对照原版视觉（T19 雏形）。

---

## 5. G1 成功标准（门禁）

全部满足才可进入 G2：

| # | 标准 | 证据形式 |
|---|---|---|
| 1 | G1-A probe 结论明确（V1/V2/V3 均有答案） | `docs/workgroup/g1/slot-probe.md` |
| 2 | 原版 635 测试全绿（仅顺序断言按设计更新并注明） | `docs/workgroup/g1/logs/test.log` |
| 3 | build + `--check` + scoped lint 全 exit 0 | 三个日志 |
| 4 | WG-01…WG-10 全通过 | `docs/workgroup/g1/logs/workgroup-isolation.log` |
| 5 | 本地群手工回归 7 项通过 | 截图 + 录屏 |
| 6 | 工作群手工 7 项通过（仅本地消息） | 截图 + 录屏 |
| 7 | 无任何 Hub/网络代码合入 | `git`-free 目录清单比对 |
| 8 | 差异清单完整（每个改动文件：上游 SHA、改动行数、原因） | `docs/workgroup/g1/diff-manifest.md` |

**任一不满足 → G1 不通过，停止并向人类上报，不得进入 G2。**
