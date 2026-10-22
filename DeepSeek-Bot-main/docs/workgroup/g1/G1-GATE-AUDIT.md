> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1-GATE-AUDIT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1 门禁核查（回应"确认 G1 任务是否全部完成"）

日期：2026-10-21 · 本文件逐条核对方案 §14 G1 门禁，**只用本次实际跑出的命令输出**，
不引用旧报告结论。

---

## 0. 一句话结论

**G1 的自动化门禁全部 PASS；G1 整体仍不能判 PASS**，因为方案 §15 的 T01/T19 与
§16.3 要求的真机人工验收（尤其"工作群交互与原版对照无明显违和"）尚未由人执行。
补齐后的下一版人工清单见 §4。

---

## 1. 方案 §14 G1 门禁逐条核对

| # | 门禁要求 | 结论 | 本次证据 |
|---|---|---|---|
| 1 | 复制原版完整群子系统 | **PASS** | `src/workgroup/host/` 有 `groups.js` `state.js` `ownership.js` `channel.js` |
| 2 | 改为 `wg` 私有状态 | **PASS** | `state.js:19` `sessionOwners`，`:28` 三张表独立初始化 |
| 3 | 消除重复 `install`/监听/工具名 | **PASS** | `workgroup-isolation.test.js` 16/16，含 WG-01 二次安装被拒、WG-02 工具名零阴影 |
| 4 | 本地/工作群两个群列表及页面切换 | **PASS（本轮改造后）** | 工作群作为 `kind:'workgroup'` 进入**原版列表** order（`sidebar.js:273`），与原版 `RoomRow` 同列表渲染 |
| 5 | 两类群各自 创建/改名/@/讨论/进度/Stop/删除/恢复 | **PASS（主机侧）** | `workgroup-round.test.js` 15/15；本地群侧 `groups.test.js` 6/6 |
| 6 | 本地群功能完全不回归 | **PASS** | `groups.test.js` 6/6；原版 `RoomRow` 一行未改（`h(RoomAvatar, { room, roster, size: 36 })` 仍在） |
| 7 | Session 归属、消息、Waiter 不串群 | **PASS** | `workgroup-isolation.test.js` 16/16（WG-03 三张 Map 不同实例、WG-04 归属不串、WG-05 双域冲突抛错） |
| 8 | 热重载/关闭无重复监听 | **PASS** | WG-01 + WG-09（dispose 后二次 dispose 安全）；`workgroup-slot.test.js` 断言注销后无残留注册 |
| 9 | 准确保存差异清单 | **PASS** | `diff-manifest.md` + 本轮 `G1R2/G1R3-REPORT.md` 的负向证据 |
| 10 | 只使用本地测试消息，不联网 | **PASS** | `hub/` 仍为骨架未触碰；工作群路由只落 `workgroup/state.json` |
| 11 | 原「插件」入口保留、其下新增唯一「Bot」入口 | **PASS** | `workgroup-slot.test.js`：`sidebar.panellist` 中 `workgroup-bot` 恰好 1 个，order 在 plugins(0) 与 schedules(10) 之间 |
| 12 | 不使用 DOM/CSS hack | **PASS** | 工作群 UI 只经官方 Slot + `/api/workgroup`；`sidebar.js` 中 `querySelector` 均为原版既有代码（动画测量/插件连接），本轮未新增 |

### 1.1 整体测试

```
npm test:  ℹ tests 688 / ℹ pass 688 / ℹ fail 0
npm run lint 裸跑: Found 13 warnings and 0 errors.  EXITCODE=0
client.js: 已重建，--check exit 0
```

---

## 2. 本轮修复的三点（对应截图反馈）

### 2.1 第 1 点：无法区分工作群与本地群 → 已加标识

截图显示两行都叫 `You, Chief, 阿三大苏打`，看不出区别。

现在工作群行走原版 `bt-row` 结构，并在标题右侧带一个**文字+形状**标识：

```
◆ 工作群        ← .bt-wg-chip（字形 ◆ + 文字）
```

- **不只靠颜色**：有字形 `◆` 和文字「工作群」，灰度/色盲下仍可分辨；
- `aria-label` 含「工作群 / 群名 / 成员数 / 升级自哪个群」，读屏可辨；
- 收起为窄栏时退化为一个小圆点（`.bt-wg-dot`），但 `aria-label` 不变；
- 升级来的工作群还显示「升级自「原群名」」。

### 2.2 第 2 点：红框的创建工作群入口 → 已删除

您指出该入口"创建的是自定义的工作群功能和 UI"，这是对的，属违反核心守则。已删除：

| 删除项 | 说明 |
|---|---|
| `WorkgroupSection`（`sidebar.js`） | 自造的「工作群」分区块，含独立标题、计数、`+` 按钮 |
| `.bt-wg-section*` / `.bt-wg-add` CSS | 上述分区的样式（12 条） |
| `CreateForm`（`panel.js`） | 面板里自造的第二套创建表单 |
| `src/client/workgroup-form.js` | 上一轮已删的自造选人表单 |
| `WG_FORM_CSS` | 上表表单的 20 条 CSS |

**现在的唯一创建入口**：原版「新建群聊」那条流程（`NewChat` 的 group 模式）。
工作群只是把它的目的地换成工作群路由，选人/自动命名/管理员判定全部复用原版。

验证（`test/workgroup-rows.test.js`）：

```js
for (const gone of ['bt-wg-section', 'bt-wg-add', 'WorkgroupSection'])
  assert.equal(sidebar.includes(gone), false, ...)
```

并对源码断言：`kind: 'workgroup'` 在原版 order 中、且经 `h(WorkgroupRow, …)` 渲染。

### 2.3 工作群回到原版群列表

改动只在原版 `sidebar.js` 加 4 处（**只增不改**）：

| 行 | 改动 |
|---|---|
| 14–15 | 2 行 import |
| 273 | 向 order 注入 `kind:'workgroup'`，与本地群同一排序规则（置顶优先 → 最近活跃） |
| 308 | 渲染分支 `h(WorkgroupRow, ...)` |

原版 `RoomRow` 未动（`bt-row` / `RoomAvatar` / `bt-row-body` / `bt-row-title` 全部保留）。

---

## 3. 仍不能判 G1 PASS 的原因（诚实标注）

| 项 | 状态 | 为什么不能自动化 |
|---|---|---|
| T01 原版回归（Chief/Bots/私聊/本地群/设置） | **未执行** | 需人眼对照改动前 |
| T19 UI 与原版视觉对照 | **未执行** | 纯主观判断 |
| §16.3 真机/模拟等级标注 | **部分** | 自动化=单元级；UI 可操作性未经真人验证 |
| G1 门禁"两群页面切换"的**端到端** | **部分** | 代码与单测已覆盖，未真人点击验证 |

> 方案 §15 明确：「源码级推断和模拟结果不能代替双电脑验收。」
> 因此我把自动化部分标 PASS，把需要人眼的项标"未执行"，不合并成一个"通过"。

---

## 4. 人工验收清单（本轮修复后需重新确认）

请重装插件并重启 DSH Desktop，然后：

| # | 操作 | 期望 |
|---|---|---|
| 1 | 点左下「Bot」 | 进入 **DS Bot 界面**（团队/私聊/本地群都在） |
| 2 | 看群列表 | 工作群与本地群**在同一列表**里，按同样规则排序 |
| 3 | 对照同名群 | 工作群行右侧有 `◆ 工作群` 标识；本地群没有 → **请截图** |
| 4 | 切换到深色主题 | 标识仍清晰、可分辨 |
| 5 | 新建菜单 | 「新建工作群」在「新建群聊」**正下方** |
| 6 | 点「新建工作群」 | 界面与「新建群聊」**完全一致**（先选管理员、再选成员），**无**「输入群名」框 |
| 7 | 创建完成 | 跳到该工作群，列表中新行带 `◆ 工作群` |
| 8 | 确认红框入口已消失 | 侧栏底部**不再有**独立的「工作群」分区与 `+` 按钮 |
| 9 | 右键本地群 →「升级为工作群」 | 生成工作群；该行显示「升级自「原群名」」；**原群历史未上传** |
| 10 | 原版回归 | Chief、私聊、本地群收发、设置页、插件页均正常 |

第 3 项是这次反馈的核心，**请务必截图**。

---

## 5. 遗留

| 级别 | 项 |
|---|---|
| P0 | §4 的人工验收未执行 |
| P1 | 工作群成员的远端身份随 Hub 在 G4；G1 阶段仅本地 Bot |
| P1 | 群记忆（方案要求 V1 必做）尚未开始，属 G6 |
| P2 | i18n 中残留 `New workgroup name` 等已无引用的词条，可随下次清理删除 |
| P2 | 若需自定义群名，应给原版 `NewChat` 加共用字段（本地群与工作群同时受益），不在工作群单独做 |
