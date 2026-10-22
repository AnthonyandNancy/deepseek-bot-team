> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1-R 执行报告：Bot 面板可达 + 新建工作群 + 视觉标识

日期：2026-10-21 · 基线：`ds-bot@0.1.7` @ `939a6635830cb5b246e7dd19c67b0e1352ad1c07`
范围：`TASK-G1R.md` 的 T4 → T5 → T1 → T2 → T3，**不含 G2**

---

## 0. 结论

| 任务 | 结果 | 说明 |
|---|---|---|
| **T4** 点 Bot 进入真面板 | **功能 PASS，视觉待人工** | 根因不是注册失败，是**样式**。详见 `T4-ROOT-CAUSE.md` |
| **T5** 新建菜单加「新建工作群」 | **PASS** | 位于「新建群聊」**正下方**，可用、有 toast、有 i18n |
| **T1** 工作群视觉标识 | **PASS** | 三处标识 + glyph/文字（不靠颜色）+ `aria-label` |
| **T2** `npm run lint` 裸跑为绿 | **PASS** | EXITCODE=0；并已证明门禁仍有效（故意违规 → 1） |
| **T3** 构建流程固化 | **PASS** | `docs/DEV-CHECKLIST.md` + `npm run verify` |

`npm test`：**684 passed / 0 failed**（G1 基线 664，**+20**）
`npm run verify`：build / check / test / lint 四项全绿

---

## 1. T4：为什么"进去是假的"

任务书给的起步方向（"从未注册 `main`"）**不完整**。逐层核实后：

### 1.1 注册其实是成功的

- Desktop `diagnostics.jsonl` 里**没有任何** workgroup 相关报错；
- 用真实 `SlotCore` 断言：`entriesOfSlot('main')` 确实含 `workgroup-bot`；
- 构建产物含 `data-workgroup-panel`。

所以不是"没进去"，而是**进去了但不像一个面板**。

### 1.2 真实根因（两个样式缺陷）

**A. 面板根节点用了右侧抽屉的类名。**
`panel.js` 原来 `className: 'bt-panel'`，而 `styles.js:348` 把它定义为
`position:fixed; right:0; width:320px` —— 贴窗口右边、320px 宽的**抽屉**。
挂进中间栏后变成一条窄条。

**B. 面板布局类名一个都没定义。**
`bt-panel-side`、`bt-panel-main`、`bt-chat`、`bt-chat-log`、`bt-chat-head`、
`bt-composer`、`bt-composer-input`、`bt-row-menu`、`bt-row-avatar`、`bt-row-main`、
`bt-line*` —— **在样式表里定义次数全为 0**。
面板挂载了，但结构零样式，渲染成一串裸文字。用户说"假的"是准确的。

**C. 潜在 P0（人工测试前发现）。**
`SHELL_CSS`（定义 `bt-row`/`bt-input`/`bt-soft`）只在 **Bot 模式**安装，
但「Bot」入口在**普通会话**里也能点。这时那些借用类同样零样式。
→ 面板样式表内以 `.bt-wg` 前缀**重述**它们，作用域隔离。

### 1.3 修法

| 改动 | 是否 hack |
|---|---|
| 面板根类改自有 `bt-wg`，新增 `src/workgroup/client/styles.js` | 否，只给自己的元素加样式 |
| 借用的 `bt-*` 以 `.bt-wg` 前缀重述 | 否，作用域内，不影响原版 |
| 经原版既有 `installStyles()` 装一次样式 | 否，复用原版机制，无新依赖 |
| `var(--bt-*)` 全部带字面 fallback | 否 |

**为什么不是绕道**：`main` 的契约明确支持非会话键 ——
`'main': { kind:'keyed'; scope:'root' }`，注释写明「other keys receive no Session
binding」。`plugin-manager` 与 `conversation` 都用同一形状注册。这是**修好了本该好的东西**。

### 1.4 任务书三个前置问题（先答后改）

| 问题 | 答案 |
|---|---|
| ds-bot 的 Bot 模式是否占用 `main`？替换还是并存？ | **未占用**（它用 `conversation` 键）；**并存**，独立 key 互不覆盖 |
| `renderSlot(entryKey)` 与 `register({key})` 对应关系？ | **确认**：按 `options.key` 严格相等匹配（renderer:1154） |
| 面板渲染时 `shell` 组是否互斥？ | **不互斥**，注册在不同槽 |

### 1.5 验收

| # | 检查 | 结果 |
|---|---|---|
| T4-a | 点 Bot 进入面板 | 注册+挂载+样式类已证实；**视觉待人工** |
| T4-b | 能切回 Chief | **PASS**：`openSession` → `replaceMain(…,"reveal")` → `selectPanel(null)` |
| T4-c | 再点 Bot 回来 | **PASS**：key 始终注册，不抛 |
| T4-d | 无 `is not registered` | **PASS**：layout 判据 `key === id` 为 true |
| T4-e | 单测覆盖 key 一致性 | **PASS**：`test/workgroup-slot.test.js` 用**真实 SlotCore** 复现判据 |

---

## 2. T5：新建工作群

- 位置：`src/client/new-chat.js`，`options.push({ key:'workgroup', … })` **紧跟 `group` 之后**。
- 表单：`src/client/workgroup-form.js`（可独立测试的纯函数 + 组件）。
- 创建后：`selectPanel('workgroup-bot')` → 跳转；`showToast('已创建工作群「X」')` → 可见反馈。
- i18n：词条写进 `src/client/i18n.js` 的 `DICTIONARY.zh`。
- **不依赖登录**：G1 只落本地库，菜单项不会因未登录消失。

**顺带修掉一个真实功能缺陷**：成员为空的工作群发消息会永远卡住
（`send` 只塞 `roomInbox`，消费它的 `relay` 需要成员 Session）。
现在 `send` 如实拒绝并说明原因，两个创建入口都要求至少选一个 Bot。
这与用户上次抱怨的"没反应"是同一类问题，一并堵掉。

---

## 3. T1：视觉标识

三处生效，且**不只靠颜色**：

| 位置 | 标识 |
|---|---|
| 列表行 | `◆` glyph + 文字「工作群」胶囊；`aria-label` 含「工作群/名称/成员数/升级自哪个群」 |
| 面板标题 | 同上胶囊 + 名称 + 成员数 |
| 升级来源 | 行内小字「升级自「本地群名」」，数据来自 `wg.view()` 新增的 `linkedLocalName` |

`linkedLocalName` 通过 `rt.roomOf`（升级处理器已在用的只读接缝）读取，
**链接仍按 id**，名字只是展示快照 —— 本地群改名不会改写工作群。

---

## 4. T2：lint 门禁

**T2-a**：`npm run lint` 裸跑 → **EXITCODE=0**，`Found 13 warnings and 0 errors`
（与改前基线一致，13 个是既有风格警告）。

**T2-b**：门禁仍有效的三步证据 ——

```
# 1 写入违规
printf 'export const probe = definitelyNotDefinedAnywhere + 1\n' > src/__t2b_probe.js

# 2 门禁报错
  x eslint(no-undef): 'definitelyNotDefinedAnywhere' is not defined.
   ,-[src/__t2b_probe.js:2:22]
Found 13 warnings and 1 error.
EXITCODE=1

# 3 撤销后回绿
Found 13 warnings and 0 errors.
EXITCODE=0
```

修的是**扫描范围**（`--ignore-pattern '**/node_modules/**'`），**规则一条没放宽**。

---

## 5. T3：流程固化

- `docs/DEV-CHECKLIST.md`：五条规则 + 交付勾选 + 常见误判表。
- `npm run verify`：build → check → test → lint 一次跑完，任一失败即停并非 0。
- 未新增 npm 依赖。

---

## 6. 源文件清单

### 新增

| 文件 | 原因 |
|---|---|
| `src/workgroup/client/styles.js` | 面板自有样式（T4 根因 A/B/C） |
| `src/client/workgroup-form.js` | 创建表单 + 可测流程（T5） |
| `test/workgroup-panel.test.js` | 面板根类/样式类完整性/标识/成员要求（8 例） |
| `test/new-chat-workgroup.test.js` | 菜单顺序/创建流程/拒绝/表单（7 例） |
| `test/workgroup-slot.test.js` | **真实 SlotCore** 上的 key 一致性（3 例） |
| `test/client-render.mjs` | 无浏览器渲染 client 组件的测试助手 |
| `scripts/verify.mjs` | 收尾命令（T3） |
| `docs/DEV-CHECKLIST.md` | 流程规则（T3） |
| `docs/workgroup/g1/T4-ROOT-CAUSE.md` | T4 根因与证据 |
| `docs/workgroup/g1/G1R-REPORT.md` | 本文件 |

### 修改

| 文件 | 改动 | 为什么安全 |
|---|---|---|
| `src/workgroup/client/panel.js` | 重写为 `bt-wg-*`；标识；成员列表；`useSource` | 工作群域自有文件 |
| `src/workgroup/client/index.js` | 传 `roster` 给面板；`inject` 官方机制 | 同上 |
| `src/workgroup/host/channel.js` | `send` 对空群如实拒绝 | 只加一个前置判断 |
| `src/workgroup/host/groups.js` | `wg.view()` 增 `linkedLocalName` | 只增字段，不动原有逻辑 |
| `src/client/new-chat.js` | 菜单插入 `workgroup` 项 + 表单分支 | 原三项**未动**，只插一项 |
| `src/client/i18n.js` | +22 条工作群词条 | 只增键 |
| `src/client/index.js` | `showToast` 动作；传 `roster` | 只增，不改原有动作 |
| `scripts/lint.mjs` | 扫描范围 | 规则未动 |
| `package.json` | +`verify` 脚本 | 无新依赖 |
| `client.js` | **重新构建**（882,558 B，sha256 `5e39c7d4…`） | 构建产物 |

### 关键未改动（负向证据）

| 文件 | 证明 |
|---|---|
| `src/host/groups.js` | 原版群轮次逻辑零改动 |
| `src/host/store.js` | `chatOwners`/`groupOwners`/`pastOwners` 语义零改动 |
| `src/host/channel.js` | `/api/bot` 未动 |
| `src/client/styles.js` | 原版样式表**一行未改**（工作群样式在独立文件） |
| `src/client/sidebar.js` | TeamSidebar 未动 |
| `src/client/context-menu.js` | G1 已有的「升级为工作群」未动 |
| `hub/` | 完全未触碰 |
| 一级目录 | 仍只有 `hub/` + `ds-bot/` |

---

## 7. 遗留问题

| 级别 | 项 | 说明 |
|---|---|---|
| **P0** | T4/T5/T1 的视觉与交互需人工验收 | 自动化能证明挂载、样式类齐全、流程正确，**不能**证明"看起来对" |
| P1 | 工作群成员只能是本地 Bot | 远端成员随 Hub 在 G4 接入（`wg.deliver` 是预留接缝） |
| P1 | 面板内部文案虽已进 `DICTIONARY.zh`，但 `test/i18n.test.js` 只扫 `src/client/` | 面板在 `src/workgroup/client/`，不受该测试保护；已在 DEV-CHECKLIST 注明 |
| P2 | 面板无深浅主题快照测试 | 全部走 `--bt-*` token，跟随主题；人工验收时请切主题看 |
| P2 | lint 仍有 13 条既有警告 | 不影响退出码，非本次范围 |

---

## 8. 人工测试清单（需在真实 Desktop 验收）

启动前：**重装插件**（`client.js` 已重建），再重启 DSH Desktop。

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 点左下「Bot」图标 | 中间出现**两栏面板**：左「工作群」列表，右聊天区。**不是**原会话，也**不是**空白/裸文字 |
| 2 | 点左侧任意本地群/Chief | 正常回到该会话 |
| 3 | 再点「Bot」 | 回到面板，Console **无** `main panel "…" is not registered` |
| 4 | 新建菜单（⊕/新建聊天） | 「新建 Bot / 新建群聊 / **新建工作群** / 添加 DSH Agent」——工作群在**群聊正下方** |
| 5 | 点「新建工作群」 | 出现表单：群名 + 可选成员；未选成员时「创建」是灰的 |
| 6 | 填名、选一个 Bot、创建 | 自动跳到 Bot 面板并打开该群；弹出「已创建工作群「X」」 |
| 7 | 在面板列表里发一条消息 | 有回复（或明确报错），**不能**出现"发了没反应" |
| 8 | 在面板内改名/删除 | 生效，无残留 |
| 9 | 右键本地群 →「升级为工作群」 | 生成工作群；**原群历史未上传**；面板里该行显示「升级自「原群名」」 |
| 10 | **同屏对照**本地群与工作群 | 一眼可分：工作群带 `◆ 工作群` 胶囊；**请截图** |
| 11 | 切深色/浅色主题 | 胶囊与文字均清晰（不靠颜色也能分辨） |
| 12 | 原版回归 | Chief、私聊、本地群、设置页、插件页均正常 |

> 第 10 项请务必截图 —— 这是 T1 唯一无法自动化的判据。

---

## 9. 停止点

T4/T5/T1/T2/T3 的自动化判据已全部满足。

**未开始 G2**（G2 需要真机 + 真实 API key）。等人工验收结果回来后再继续。
