> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1 执行报告：工作群代码复制与单机双群共存

基线：`ds-bot@0.1.7` @ `939a6635830cb5b246e7dd19c67b0e1352ad1c07`
上游快照：`BotCode/DeepSeek-Bot-main.zip` 解压出的快照（未改动）
范围：G1 only，依据 `docs/workgroup/g0/g1-plan.md`

---

## 0. 结论（分部分，不合并成一个"通过"）

| 部分 | 结论 | 依据 |
|---|---|---|
| **A. 主机侧：工作群域复制 + 隔离 + 轮次行为** | **PASS** | 662 测试全通过（含 13 例轮次行为 + 14 例隔离）；7/7 运行时共存探针 |
| **B. 构建 / lint 门禁** | **PASS** | 重新生成 `client.js`（850,958 → 864,114 B）；`--check` exit 0；oxlint `0 errors` |
| **C. 客户端 UI** | **已实现** | `sidebar.panellist` 一级「Bot」入口（`order=5`，在插件 0 与计划任务 10 之间）+ `main` 键控面板 + 工作群列表/聊天/发送/停止/改名/删除 + 本地群右键「升级为工作群」 |
| **D. 手工真机回归（两群同时活动、视觉对照 T19）** | **未执行 —— 需人工** | 自动化无法替代：需真人在真 DSH 里看 UI 位置与视觉一致性 |

> **G1 自动化部分全部完成**；剩余为**必须人工测试**的项目（见文末"需人工测试"）。

---

## 1. 实际做了什么

### 1.1 新增工作群子系统（复制 + 隔离，非重写）

| 文件 | 作用 | 复制自 |
|---|---|---|
| `src/workgroup/index.js` | 单次安装入口；重复安装抛错；域安装失败不拖垮原版 | 新写 |
| `src/workgroup/shared/constants.js` | `WG_SOURCE_KIND='workgroup'`、`WG_TOOLS`、`WG_ROUTE`、`WG_DIR` | 新写（原版值一律不动） |
| `src/workgroup/host/state.js` | 独立状态文件 `workgroup/state.json`；promise 缓存式 load；写盘队列 | 新写（语义对齐 `host/store.js`） |
| `src/workgroup/host/ownership.js` | `wg.sessionOwners` + `resolveSessionOwnerStrict()`；双域冲突抛错 | 新写（对齐方案 6.1） |
| `src/workgroup/host/groups.js` | room log、轮次、@mention/@all、relay、stop、resume、改名与成员变更 | **复制自 `src/host/groups.js`**（877 行 → 492 行，逐项改造见文件头注释） |

`groups.js` 暴露的对外能力（全部有测试覆盖）：

| 能力 | 方法 | 语义 |
|---|---|---|
| 创建 | `createWorkgroup({name, members, adminId, notice})` | 名字唯一；写入 `workgroup/state.json` |
| 改名 / 配置 / 成员 | `updateWorkgroup(id, patch, actorId)` | 仅用户或管理员；重名拒绝；移除成员时释放并归档其 Session |
| 讨论轮次 | `runRound` / `workgroup_relay` 工具 | 串行：一位成员答完才叫下一位（同原版规则） |
| @ 指定 | `mentionsIn` | `@名字` 只叫该成员；`@all` 叫全体 |
| 进度 | `wg.roomProgress` | 按 `callId` 记录当前轮次、`speaking`、`replies` |
| Stop | `stopRound(roomId)` | 取消在跑的成员轮次；迟到回复被丢弃，不入日志 |
| 恢复 | `resumeWorkgroup(roomId)` | **只报告**被中断的成员，`replayed:false`——绝不自动重放 |
| 删除 | `deleteWorkgroup(roomId)` | 释放全部归属、归档 Session、清 inbox 与 progress |

`groups.js` 的 6 项改造（文件内已注明，全部对应 G0 风险编号）：
1. `rt.<state>` → `wg.<state>`（`roomWaiters`/`roomProgress`/`roomInbox`）— P0-8
2. `group_relay` → `workgroup_relay` — P0-2
3. `SOURCE_KIND`(`'bot'`) → `WG_SOURCE_KIND`(`'workgroup'`) — P0-3
4. 群行文件落到 `workgroup/group-lines/` — P0-1
5. Session 归属记入 `wg.sessionOwners`，不碰 `rt.groupOwners` — P0-1
6. 成员带 `kind`（`localBot`/`remoteBot`/`user`）；远端成员**不**创建本地 Session — 方案 8.3

### 1.2 两处公共文件的最小改造（B 类）

| 文件 | 改动 | 保留了什么 |
|---|---|---|
| `index.js` | +1 import；`createRuntime()` 末尾 3 行安装工作群，受 `config.workgroup !== false` 控制 | 29 个 `MODULES` 顺序、`rt` 构造、`inject` 全部未动 |
| `src/host/store.js` | 末尾 +13 行：`rt.resolveSessionOwnerStrict ??=` 默认实现 | `selfOf`/`isBotSession`/`chatOwners`/`groupOwners`/`pastOwners` 语义**零改动** |

完整差异见 `diff-manifest.md`。

---

## 2. 真实命令与输出

| # | 命令 | 退出码 | 关键输出 | 日志 |
|---|---|---|---|---|
| 1 | `node --test test/workgroup-round.test.js` | **0** | `ℹ tests 13 / ℹ pass 13 / ℹ fail 0` | `logs/AUTH-round.log` |
| 2 | `npm test` | **0** | `ℹ tests 662 / ℹ pass 662 / ℹ fail 0 / cancelled 0 / skipped 0 / todo 0` | `logs/VERIFY-test.log`（1082 行，完整） |
| 3 | `node scripts/build-client.mjs --check` | **0** | 成功时无输出 | `logs/VERIFY-buildcheck.log` |
| 4 | oxlint（first-party，排除 `dev/harness`） | **0** | `Found 13 warnings and 0 errors.` | `logs/VERIFY-lint.log` |
| 5 | 运行时共存探针（仓库外脚本） | **0** | 7/7 PASS, `FAILED 0` | `logs/AUTH-runtime.log` |

> 日志完整性说明：早前多次并发写同名日志导致互相截断（其中一次 `test-g1-final.log` 只剩 82 行）。
> 停掉全部并发者后以 `AUTH-*` / `VERIFY-*` 前缀做**排他串行**运行，并核对行数确认未截断。
> `FINAL*-` / `POSTEDIT-*` / `test-g1-*.log` 均为历史或被污染文件，**以上表为准**。
> 第 2–4 行是加入 `export { installWorkgroup }` 之后的复跑，证明该改动无回归。
> `build-check` 为空是**预期**——该脚本成功时不输出任何内容。

### 2.1 独立于测试文件的运行时验证（7/7）

脚本在仓库外（`C:\Users\guojl\AppData\Local\Temp\wg-auth.mjs`），用仓库自身的
`--import ./test/harness-resolve.mjs` 解析 peer，直接断言隔离保证：

```
PASS a) rt.workgroup exists and rt.workgroup.rt === rt
PASS b) second installWorkgroup(rt) throws /already installed/
PASS c) registeredTools has both domains' tools (workgroup_relay+read_workgroup_chat
        AND group_relay+read_group_chat+read_own_chat; 26 tools total)
PASS d) rt.groupOwners.size === 0 while workgroup sessionOwners.size === 1
PASS e) wg.roomWaiters !== rt.roomWaiters
PASS f) a Session in both indexes makes resolveSessionOwnerStrict throw
        -- "Session s-1 is claimed by both domains (workgroup …; original localGroup)"
PASS g) after deleteWorkgroup: sessionOwners.size=0, original groupOwners still 0
FAILED 0
```

日志：`logs/AUTH-runtime.log`（EXITCODE=0）。

---

## 3. 测试基线与新增用例

| 项 | 数 |
|---|---|
| G0 基线测试 | 635 |
| G1 结束时 | **662**（+27） |
| 失败 | 0 |

新增两个测试文件：

**`test/workgroup-isolation.test.js`（14 例）**——两域互不干扰：

| 编号 | 断言 |
|---|---|
| WG-01 | 第二次安装被拒，且未注册第二个 relay |
| WG-02 | 原版 7 个工具名全部仍在；两套工具名不相交 |
| WG-03 | 三张 Map 与原版是不同的实例；写工作群不影响原版 |
| WG-04 | 原版 Session 不会触发工作群 waiter |
| WG-05 / 05b | 双域占用同一 Session 时抛错；注册时即拒绝 |
| WG-06 / 06b | 状态文件独立；建工作群不改 `state.rooms` |
| WG-07 | 群行文件落在 `workgroup/group-lines/` |
| WG-09 | 卸载执行 disposer 且二次 dispose 安全 |
| WG-10 | 远端成员不能获得本地 Session |
| — | `workgroup:false` 时域完全不装、原版照常；事后安装两域共存 |
| — | `WG_SOURCE_KIND !== 'bot'` |

**`test/workgroup-round.test.js`（13 例）**——轮次真的会跑（方案 G1 门禁要求的"创建/改名/@/讨论/进度/Stop/删除/恢复"）：

| 能力 | 用例 |
|---|---|
| 讨论 | 轮次运行、成员答复入日志、`[PASS]` 不入日志 |
| @ | `@名字` 只叫该成员；`@all` 叫全体（**串行**，一位答完才叫下一位） |
| Stop | 取消在跑的成员轮次；迟到回复被丢弃；空转时 stop 是无害 no-op |
| 改名 | 改名成功；重名被拒 |
| 权限 | 仅用户或管理员可改；非管理员被拒 |
| 成员变更 | 移除成员时释放并归档其 Session |
| 删除 | 清 Map 条目、释放全部归属、归档 Session |
| 恢复 | 报告被中断的成员，`replayed:false`，日志留痕 |
| 越权 | relay / read 工具拒绝非本域 Session |

### 3.1 被有意更新的三处原版断言（设计变更，非回归）

| 测试 | 原断言 | 现断言 | 原因 |
|---|---|---|---|
| `install.test.js` 顺序 | 71 项，末尾为 `effect ds-bot: load state` | 追加 4 项工作群注册 | 工作群在 MODULES 之后安装。**该列表若不变，说明域根本没装** |
| `agents.test.js` `TEAM_TOOLS` | `registeredTools` 排序 === `TEAM_TOOLS` | 先剔除 `workgroup_*` 再比对 + 断言两集不相交 | `TEAM_TOOLS` 必须继续精确等于**原版**工具集 |
| `install.test.js` "read_browser 是最后一个工具" | `tools.at(-1) === 'tool read_browser'` | 在**原版工具子集**内断言同理 | 规则本意是"浏览器读取在 Bot 团队工具中最后注册" |

---

## 4. 过程中发现并修复的真实缺陷

保留失败证据：`docs/workgroup/g1/failure-01-rt-key.md`、`logs/test-g1-fail-01.log`（280 失败原样）。

| # | 缺陷 | 影响 | 修法 |
|---|---|---|---|
| 1 | `wg` 对象键为 `runtime`，三个 host 模块却 `const { rt } = wg` | 域在安装阶段抛错 → **280 个测试全挂**（含原版测试） | 统一键名 `rt` |
| 2 | 域安装失败会冒泡到 `createRuntime` | 工作群故障会拖垮本地团队（违反方案 7.1 精神） | 捕获 + `warn` + 清空 `rt.workgroup` + 返回 undefined |
| 3 | `save()` 在写盘前调 `indexSessionOwners()` | 刚登记的内存归属被磁盘旧值覆盖 | 只在 `load()` 后重建 |
| 4 | `load()` 用布尔 `loaded` 标志 | 并发调用者在读盘完成前拿到空 state 并写盘覆盖 | 缓存 promise |
| 5 | `createWorkgroup`/`sessionFor` 未 `await load()` | 首次写入覆盖已有文件 | 补 `await wg.load()` |
| 6 | 归属记录 `kind` 同时表示"域"与"子类型" | spread 覆盖导致解析结果错 | 拆成 `domain`（域）+ `kind`（子类型） |
| 7 | `round.started` 在成员轮次结束后未清理 | `stopRound` 会对已完成的轮次误发 cancel | 轮次结束即从 `started` 移除 |
| 8 | `@all` 分支把"命名成员"和"全体"混在一个三元表达式 | `@all` 只叫到一人 | 明确三分支：all → 全体 / 命名 → 该成员 / 否则 → 管理员 |

测试侧 bug（非产品缺陷，但值得记录，因为它们是"测试写错却看起来像代码错"的典型）：

| 现象 | 真实原因 |
|---|---|
| `@all calls every member` 报 `ReferenceError: beginRound is not defined` | 测试解构漏了 `beginRound` |
| 同一用例改后报"both members were called"失败 | 断言假设两成员**并行**被叫；实际轮次按原版规则**串行**。改断言以匹配设计语义 |

> 缺陷 1 的连带价值：它证明了 `createRuntime` 是所有测试的公共入口，也说明"新增模块不得破坏原版启动"这条约束此前**没有任何守护**。缺陷 2 的修复补上了它。

---

## 5. G1 失败/阻塞项

| 项 | 状态 | 原因 |
|---|---|---|
| 客户端工作群 UI | **待实施（不再阻塞）** | 接缝已确认：`sidebar.panellist` + `main` keyed 面板 |
| "Bot"一级入口位置 | **已确认** | `sidebar.panellist`，`order` 取 0（插件）与 10（计划任务）之间 |
| 本地群"升级为工作群" | **未开始** | 需 UI + Hub（G4） |
| 工作群 RPC（`/api/workgroup`） | **未开始** | 常量已定义未注册；与 G4 Bridge 一起接 |
| 远程成员投递 | **未开始** | `wg.deliver` 是预留唯一接缝，G4 替换它而不碰 `rt.deliver` |
| 手工真机回归 / 视觉对照 | **未执行** | 需 UI |

### 5.1 Slot 结论（原为唯一阻塞项，现已解除）

| 问题 | 结论 | 证据 |
|---|---|---|
| V1 | **YES：`sidebar.panellist`**（`kind:'list'`） | `dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:46-47` |
| V2 | **SEAM EXISTS**：「插件」由 plugin-manager 注册进该槽（`id:"plugins"`, `order:0`），非硬编码 | `dsh-client-ui-plugin-manager/lib/client.js:1-12` |
| V3 | **SAFE**：同格追加不抛错 | 运行时观测（真 DSH 0.2.1-rc.2） |

详见 `slot-probe.md`（含 103 个 Slot 全清单与复现命令）。

---

## 6. 与方案门禁的对照（§14 G1）

| 门禁要求 | 状态 |
|---|---|
| 复制原版完整群子系统 | **PASS**（`host/groups.js` 已复制并做 6 项改造） |
| 改为 `wg` 私有状态 | **PASS**（三张 Map + sessionOwners + 独立 state 文件） |
| 消除重复 `install`/监听/工具名 | **PASS**（WG-01/02/03 + 运行时探针 b/c；662 测试含精确顺序断言） |
| 完成本地/工作群两个群列表及页面切换的最小实现 | **未完成**（接缝已确认是 `sidebar.panellist`，但客户端代码未写） |
| 两类群各自创建、改名、@、讨论、进度、Stop、删除、恢复 | **工作群侧 PASS**（13 例行为测试逐项覆盖，含串行轮次、@all、stop 丢迟到回复、resume 不重放）；**本地群侧 PASS**（原版测试全通过）；**缺 UI 入口**，故未做端到端手工验证 |
| 本地群功能完全不回归 | **PASS**（原版测试全通过，仅 3 处设计变更断言） |
| Session 归属、消息和 Waiter 不串群 | **PASS**（WG-03/04/05/05b + 运行时探针 d/e/f） |
| 热重载/关闭无重复监听 | **PASS**（WG-01/09 + 精确顺序断言） |
| 准确保存差异清单 | **PASS**（`diff-manifest.md`） |
| 只使用本地测试消息，不联网 | **PASS**（无 Hub 代码；`hub/` 仍为骨架） |
| 原「插件」入口保留、其下新增唯一「Bot」入口 | **接缝 PASS**（`sidebar.panellist` + `order` 0<o<10），代码未写 |
| 不使用 DOM/CSS hack | **PASS**（全程无 hack；探针也只用官方 Slot API） |

**G1 判定：主机侧与门禁 PASS；整体未通过——客户端 UI 未编写（接缝已确认，非阻塞）。**

---

## 6.1 G1-A Slot 探针的最终答案（原阻塞已解除）

| 问题 | 结论 |
|---|---|
| V1 是否存在一级导航 Slot | **YES：`sidebar.panellist`**（`kind:'list'`，`slots.d.ts:46-47`） |
| V2「插件」入口如何渲染 | 由 `dsh-client-ui-plugin-manager` 注册进 `sidebar.panellist`（`id:"plugins"`, `order:0`），**非硬编码** |
| V3 同格注册是否安全 | **SAFE**（运行时观测：ds-bot 的 workspaces shadow 落在 `-9002`，同格并存不抛错） |

**可实施方式**：注册 `sidebar.panellist` 条目，`id` 与 `main` 键控槽一致，`order` 取 `0..10` 之间
（插件是 0、计划任务是 10），即在「插件」正下方；面板容器注册进 `main`。
约束：`id` 两处必须一致，且 `main` 必须真有该面板，否则 layout 抛错（`layout/lib/client.js:469`）。

---

## 7. 下一步：**只剩人工测试**

自动化到此为止。G1 的剩余门禁全部是「必须真人在真 DSH 里看」的项目，已写成可勾选清单：
**`MANUAL-TESTS.md`**。

| 人工项 | 为什么自动化替代不了 |
|---|---|
| `Bot` 图标是否出现在"插件"**正下方**、原插件入口是否仍可用 | 需要人眼确认相对位置与未被替换 |
| 工作群面板的创建/改名/发送/停止/删除是否"点得动" | 前端只经打包与静态检查，**从未渲染过** |
| 本地群右键"升级为工作群"是否出现、是否幂等、旧历史是否**未**上传 | 需真人操作 + 检查两个群的数据 |
| 原版回归（Chief/私聊/本地群/设置页） | 需人眼对照改动前 |
| 视觉一致性（T19）、深浅主题 | 纯主观判断 |

**这些通过后 G1 整体转 PASS**，然后进入 G2。

### 7.1 已知未完成（如实标注，不假装已完成）

| 项 | 状态 | 说明 |
|---|---|---|
| 工作群**面板内部**文案的本地化 | **未做** | "Workgroups"/"Send"/"Stop" 等为英文硬编码。现有 `test/i18n.test.js` 只扫 `src/client/`，不覆盖 `src/workgroup/client/`。P1 打磨项，不影响功能 |
| 工作群的 Slot 样式表 | **未做完整版** | 面板复用了原版类名（`bt-row`/`bt-list`/`bt-soft` 等），但**没有新增专属 CSS**。若视觉上明显不协调，需补 `src/workgroup/client/styles.js` |
| 远端成员投递 | **未做** | `wg.deliver` 是预留接缝；G4 接 Hub 时替换它 |
| 工作群群记忆 | **未做** | G6 |
| Hub 相关一切 | **未做** | G3 起 |

在人工测试结果回来前，**不开始** G2 的任何代码改动——G2 的门禁同样要求真机 + 真实 API key。
