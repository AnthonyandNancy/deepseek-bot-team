> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/TASK-G1R.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1-R 任务书（v2）：工作群可创建 + Bot 入口可达 + 视觉标识

创建：2026-10-21 · 修订：2026-10-21（用户真实 Desktop 验收后追加 T4/T5）
前置：G1 主机侧与门禁 PASS；`sidebar.panellist` 的「Bot」图标已在真实 Desktop 出现

---

## 0. 用户在实际 Desktop 中发现的问题（原文）

| # | 用户原话 | 我的核实结论 |
|---|---|---|
| 1 | 「差点上方这个入口，进去是假的」 | **成立**。见 §T4 |
| 2 | 「需要在图二的这个创建群聊下方有一个创建工作群的选项用于创建工作群」 | **成立**。见 §T5 |
| 3 | 「工作群需要有标识区别下与普通群聊的」 | **成立**。见 §T1（上一版已写入） |

截图确认：侧栏「插件 / Bot / 自动化任务」三个入口并存，**Bot 图标已正确出现在插件下方** ——
说明 `sidebar.panellist` 的 `order=5` 生效，Slot 接缝问题彻底解决。

---

## T4（用户提出，P0）：点「Bot」进去是空的/假的

### 核实到的事实（源码级，非推断）
`dsh-client-ui-layout` 的 `MainPanel`（`lib/client.js:118-120`）：

```js
function MainPanel({ usePanelInfo, renderSlot }) {
  return renderSlot("main", {}, { entryKey: usePanelInfo(info => info.activePanelId) ?? "conversation" })
}
```

即：**中间栏只渲染 `main` 槽里 `key === activePanelId` 的那一个条目**。
点面板图标时 `selectPanel(id)` 只改 `activePanelId`（`lib/client.js:407-411, 468-471`），
而 `selectPanel` 对未注册的 key 会**抛错**：

```js
if (panelId !== null && !this.hasMainPanel(panelId)) throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
```

ds-bot 在 Bot 模式下通过 `surfaceGroups` 接管 `shell` 与 `conversation` 两组，
并把 `sidebar.workspaces` **整格替换**为自己的 `TeamSidebar`。它**从未注册过 `main`**。

所以现象是：点 Bot → `activePanelId` 变成我们的 key → 但 ds-bot 的 Bot 模式壳层
与中间栏的渲染路径不匹配 → 用户看到的是"没有真正进入一个独立面板"。
用户描述为"假的"是准确的。

### 要求
点「Bot」必须进入一个**真正可用的面板**，且：
1. 面板内容 = 工作群列表 + 选中群的聊天区（现有 `BotPanel` 已实现，需要被正确挂载）。
2. 进入后侧栏仍可见、可切回原团队/会话，不陷入死路。
3. 从 Bot 面板点回原会话（Chief/本地群）必须能正常返回。
4. 再次点 Bot 图标应回到上次的 Bot 面板状态（`activePanelId` 记忆），不报错。
5. **不得**用 DOM/CSS hack 伪装；必须走官方 Slot 机制。
6. 若该 DSH 版本的 `main` 槽无法承载（诚实地）承载不了这种"非会话面板"，**必须报告 BLOCKED
   并给出日志证据**，不得静默改成另一种实现然后声称完成。

### 待回答的关键问题（先答再改代码）
- ds-bot 的 Bot 模式是否本来就占用了 `main`？若是，我们的条目应**替换**它还是**并存**？
- `renderSlot("main", {}, {entryKey})` 的 `entryKey` 与 `register({ key })` 的对应关系是否已确认？
- 面板被渲染时，`shell` 组（ds-bot 的 TeamSidebar）是否仍然挂载？会不会互相排斥？

### 验收
| # | 检查 | 期望 |
|---|---|---|
| T4-a | 点 Bot | 中间栏出现 Workgroups 面板，**不是**原会话 |
| T4-b | 点回 Chief | 正常回到 Chief 会话 |
| T4-c | 再点 Bot | 回到 Bot 面板，无报错 |
| T4-d | Console | 无 `layout.selectPanel ... is not registered` |
| T4-e | 单元测试 | 至少覆盖"注册的 key 与 selectPanel 使用的 key 一致" |

---

## T5（用户提出，P0）：新建菜单里缺「新建工作群」

### 核实到的事实
新建聊天菜单在 `src/client/new-chat.js:95-103` 构造 `options`：

```js
options.push({ key: 'new',   icon: PlusIcon,   label: t('Create new Bot'),     run: createBot })
options.push({ key: 'group', icon: PeopleIcon, label: t('Create group chat'),  run: () => setGroup(true) })
if (roster.agents.length === 0) options.push({ key: 'agent', ... label: t('Add DSH Agent') })
```

用户截图显示的顺序正是：**新建 Bot / 新建群聊 / Chief / 阿三大苏打**。
确认：**没有「新建工作群」**。当前只能靠右键本地群「升级为工作群」，
无法从零直接建一个工作群 —— 而方案 §8.1 明确要求两个入口都必须有：

> - **新建本地群**：保留原版入口与行为
> - **新建工作群**：登录 Hub 后可直接创建，**不要求先有本地群**

### 要求
1. 在「新建群聊」**正下方**插入一项「新建工作群」。
2. 放在该位置而不是菜单末尾，是因为用户明确要求在"创建群聊下方"。
3. 点击后进入创建流程：至少能输入群名 → 创建 → 跳到该工作群面板。
4. 创建成功后给出可见反馈（toast 或直接跳转），不能像上次升级那样"没反应"。
5. G1 阶段工作群只在本地落库（`workgroup/state.json`），不联网、不要求 Hub 登录；
   Hub 校验留到 G3。**但菜单项不应因为未登录而消失** —— 与本地群对等。
6. 文案需要 i18n 词条（`src/client/i18n.js` 的 `DICTIONARY.zh`），因为该文件在
   `test/i18n.test.js` 的扫描范围内（只扫 `src/client/`）。

### 验收
| # | 检查 | 期望 |
|---|---|---|
| T5-a | 打开新建菜单 | 「新建群聊」下方有「新建工作群」 |
| T5-b | 点击它 | 出现创建界面，可输入群名 |
| T5-c | 创建成功 | 跳转到该工作群面板；Bot 面板列表里能看到 |
| T5-d | 重复；取消 | 空名被拒；取消不残留半成品 |
| T5-e | 单元测试 | 菜单 options 顺序断言：group 之后紧跟 workgroup |
| T5-f | 中文界面 | 显示「新建工作群」 |

---

## T1（用户提出，P1）：工作群与普通群聊必须有视觉区别

### 问题
用户截图显示：工作群行与普通群聊行**外观完全一致**，无法一眼分辨。

### 为什么必须修（不只是美观）
工作群与本地群是**两个不同的域**：不同数据源、不同 Session 归属、不同成员语义、
不同权限与记忆边界。外观相同会导致误操作：
- 以为在本地群发言，实际发进会同步到 Hub 的工作群
- 误删工作群，以为删的是本地群

### 要求
1. 标识在三处生效：工作群列表行、聊天面板标题、"关联自哪个本地群"（升级来源）。
2. **不能只靠颜色**区分（色觉障碍可达），必须含形状或文字维度。
3. 沿用原版 `bt-*` 类名与既有 ink/token，不引入新风格体系。
4. 带 `aria-label`，行可访问名称包含标识语义。

### 验收
| # | 检查 | 期望 |
|---|---|---|
| T1-a | 单元测试 | 行节点含工作群标识，`aria-label` 含「工作群」 |
| T1-b | 单元测试 | 升级来源的工作群显示关联的本地群名 |
| T1-c | 人工 | 同屏对照本地群/工作群，一眼可分辨 |
| T1-d | 人工 | 深色/浅色主题下均清晰 |

---

## T2（我自查发现）：`npm run lint` 门禁是坏的

`npm run lint` 裸跑退出码 1：`scripts/lint.mjs` 把字面目录 `dev` 传给 oxlint，
递归进 `dev/harness/node_modules`，报 29206 warnings / 20745 errors，
**全部来自第三方压缩代码**。加 `--ignore-pattern` 后是 13 warnings / 0 errors。

### 要求
修**扫描范围**（不是放宽规则），使裸跑为绿。

### 验收
| # | 检查 | 期望 |
|---|---|---|
| T2-a | `npm run lint` 裸跑 | EXITCODE=0 |
| T2-b | **故意写一个 `no-undef` 违规** | EXITCODE=1，门禁仍报错 |

> T2-b 是硬要求：只变绿但规则失效，不算通过。这条会亲自复核。

---

## T3（我自查发现）：client 源码改动后漏构建

上一轮我改完 `src/workgroup/client/**` 没跑 `build`，导致用户在真实环境测的是旧 bundle。

### 要求
1. 新增 `docs/workgroup/DEV-CHECKLIST.md`，写死流程规则。
2. 提供**一条可复制的收尾命令**，一次跑完 build / --check / test / lint。
3. 不新增 npm 依赖。

### 验收
| # | 检查 | 期望 |
|---|---|---|
| T3-a | 检查单存在，含规则与收尾命令 | 存在且可执行 |
| T3-b | 收尾命令本地跑通 | 全绿 |

---

## 执行顺序（有依赖关系，不可调换）

```
T4  ← 先修，否则 T5 创建完也没有可用面板可跳
T5  ← 依赖 T4 的面板能真正显示
T1  ← 标识加在已可用的面板上
T2  ← 独立，可并行
T3  ← 收尾流程，最后
```

---

## G1-R 完成判据

| # | 判据 |
|---|---|
| 1 | T4：点 Bot 真正进入面板，能来回切换，无 `not registered` 报错 |
| 2 | T4：若官方 Slot 承载不了，给出 BLOCKED + 日志证据（而非静默绕道） |
| 3 | T5：「新建群聊」下方有「新建工作群」，可用、有反馈、有 i18n |
| 4 | T1：三处标识 + aria-label + 不靠颜色 |
| 5 | T2：裸跑 lint 为绿，且故意违规仍报错 |
| 6 | T3：检查单 + 收尾命令跑通 |
| 7 | `npm test` 全绿（基线 664，只增不减） |
| 8 | `client.js` 已重建，`--check` = 0 |
| 9 | 人工：Bot 面板可操作、两类群一眼可分 |

全部满足后才可 G1 整体转 PASS，进入 G2。

---

## 明确不做

- 不重设计聊天 UI，不改气泡/输入框视觉（方案 §9）。
- 不把工作群放进 DSH 一级侧栏（方案 §0.9：只在 Bot 内部展示）。
- 不引入新主题/新色板。
- 不动 Hub 代码（G3 起）。
- 不为让 lint 变绿而删规则（见 T2-b）。
- **不为了让 T4 "看起来能用" 而使用 DOM/CSS hack 或伪造面板。**
