> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/slot-probe.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1-A Slot 探针：最终结论（V1/V2/V3 全部有答案）

证据等级：**静态源码阅读**（读取已安装的 DSH 0.2.1-rc.2 客户端包），外加 **V3 的运行时观测**。
所有 file:line 均可复现，命令附于文末。

**结论先行**：方案 §16.2 第 2 条列为"必须立即反馈的阻塞"的疑问——「DSH 官方 Slot 无法在规定位置增加 Bot 导航」——**不成立**。存在官方 Slot 可以做到，且**不需要任何 DOM/CSS hack**。

| 问题 | 结论 | 证据等级 |
|---|---|---|
| **V1**：是否存在承载一级侧栏导航项的 Slot | **YES —— `sidebar.panellist`**（`kind: 'list'`） | 静态源码 |
| **V2**：「插件」入口由谁渲染、能否加同级兄弟项 | **SEAM EXISTS** —— 它就是注册进 `sidebar.panellist` 的，第三方用同一方式即可加兄弟项 | 静态源码 |
| **V3**：同格追加注册是否与 ds-bot 的 shadow 冲突 | **SAFE**（不抛错） | 运行时观测 |

---

## V1：`sidebar.panellist` 是官方的一级导航槽

类型声明（`dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts`）：

```ts
43:         * Global panel icons. Each list id addresses the matching main panel;
46:        'sidebar.panellist': {
47:            kind: 'list';
```

- 它是 **`kind: 'list'`**（可多条，不是 single），语义即"全局面板图标清单"。
- 每个条目用 `id` 指定，该 `id` **同时寻址 layout 的 `main` 键控槽**里注册的面板。

官方 README（`dsh-client-ui-sidebar/README.md:38`）原文：

> Plugins add an icon component to the root-scoped `sidebar.panellist` list with an `id`, optional `order`, and a string or locale-aware `label`. The same id addresses the component registered in the layout's root-scoped `main` keyed slot; selecting a missing main entry throws without changing the current selection.

三条硬约束（必须照做，否则会抛错）：
1. `id` 在 `sidebar.panellist` 与 `main` **必须一致**；
2. `main` 里必须真的注册了同 `id` 的面板——**只注册图标不注册面板会 throw**；
3. 无注册时，列表与其间距都不渲染。

layout 侧的 `main` 确为 keyed（`dsh-client-ui-layout/lib/client.js:631-632`）：

```
631:  "main": {
632:    kind: "keyed",
```
并有守卫（同文件 `:469`）：
```
469: if (panelId !== null && !this.hasMainPanel(panelId)) throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`);
```

## V2：「插件」入口就是一个 `sidebar.panellist` 条目

`dsh-client-ui-plugin-manager/lib/client.js`：

```js
1:  /** The id shared by the sidebar entry and the main panel it opens. */
2:  const PANEL_ID = "plugins";
...
6:  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
7:    name: "sidebar.panellist",
8:    id: PANEL_ID,
9:    order: 0,
10:   label: () => t("panel"),
11:   locale: NS
12: }, PluginsPanelIcon));
```

即：**「插件」不是硬编码在壳里的**，它是 plugin-manager 这个包按同一套公开 API 注册进去的。中文文案 `panel: "插件"`（同文件 `:78`）。

第二个已发布条目来自 `dsh-client-ui-schedule/lib/client.js`：`PANEL_ID = "schedules"`、`order: 10`。

**因此「在插件正下方加 Bot 一级入口」= 用同一 API 注册一个 `sidebar.panellist` 条目：**

| 参数 | 取值 | 依据 |
|---|---|---|
| `name` | `'sidebar.panellist'` | 见上 |
| `id` | 如 `'workgroup-bot'` | 自选，须与 `main` 一致 |
| `order` | **`0 < order < 10`**（建议 `1`~`5`） | plugins 是 `0`，schedules 是 `10`，插在两者之间即"插件正下方" |
| `label` | `() => 'Bot'`（可 locale-aware） | 同 plugins 的 `label: () => t('panel')` |
| 组件 | 图标组件 | 同 `PluginsPanelIcon` |

并在 `main` 键控槽注册同 `id` 的面板容器（方案要求 Bot 内部展示 Chief/Bots/私聊/本地群/工作群，故该面板就是原版 `TeamSidebar` 那套团队界面）。

**这同时满足方案第 9 条的完整要求**：原「插件」入口原位保留（我们不动它），其下方**仅**新增一个「Bot」一级入口，Bot 内部再展示全部子功能。

## V3：同格共存是安全的（运行时观测）

在真 DSH 0.2.1-rc.2（隔离 `DSH_HOME`、web profile、本地 `ds-bot` 以 link 安装）中观测到：

- ds-bot 自己的 `sidebar.workspaces` shadow 实际落在优先级 **`-9002`**；
- 探针以相同/相邻优先级注册进同格，**未抛出异常**，两者共存。

机制与源码一致：`client/index.js:728-730` 的 `shadow()` 调 `freePriority()`（`client/surface.js:60-66`），把优先级压到低于该格已有注册。

注意：`sidebar.workspaces` 是 **`kind: 'single'`**（`slots.d.ts:57-58`），ds-bot 用它整格替换团队侧栏内容；这与 `sidebar.panellist` 是**两个不同的格**，互不冲突——所以「Bot 一级入口」用 `panellist`，完全不必碰 `workspaces`。

## 对 G1 的影响（从 BLOCKED 改为可实施）

| 项 | 之前 | 现在 |
|---|---|---|
| 「Bot」一级入口位置 | BLOCKED（无接缝证据） | **可实施**：`sidebar.panellist`，`order` 取 0 与 10 之间 |
| 工作群 UI 容器 | 依赖上面那项 | 注册为 `main` 的 keyed 面板，内部沿用原版团队界面 |
| 是否需要 DOM/CSS hack | 未知 | **不需要**，且禁止 |

仍未做的：客户端代码本身尚未编写（G1 剩余工作），以及真机视觉对照（T19）。

## 复现命令

```bash
# 1) 一级导航槽的类型声明
rg -n "sidebar.panellist|kind: 'list'" \
  D:/code/ai/dsh-g0-bench/dsh021/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts

# 2) 「插件」入口的注册方式
rg -n "PANEL_ID|sidebar.panellist|order: 0|panel:" \
  D:/code/ai/dsh-g0-bench/dsh021/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js

# 3) 第二个官方条目（用于确认 order 语义）
rg -n "PANEL_ID|sidebar.panellist|order: 10" \
  D:/code/ai/dsh-g0-bench/dsh021/node_modules/@deepseek-ai/dsh-client-ui-schedule/lib/client.js

# 4) layout 的 main 是 keyed，且有"面板未注册即抛错"的守卫
rg -n '"main"|kind: "keyed"|is not registered' \
  D:/code/ai/dsh-g0-bench/dsh021/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js

# 5) 官方 README 对 sidebar.panellist 的说明
rg -n "sidebar.panellist" \
  D:/code/ai/dsh-g0-bench/dsh021/node_modules/@deepseek-ai/dsh-client-ui-sidebar/README.md
```

## 完整 Slot 名清单（103 个，来自运行时 `ctx.slots.entries()` 与静态声明去重）

```text
conversation.approval.detail            conversation.chat.commandview
conversation.chat.flow                  conversation.chat.message.images
conversation.chat.node                  conversation.chat.reasoning.body
conversation.chat.turnTail              conversation.chat.user.images
conversation.composer                   conversation.composer.bar
conversation.composer.dock              conversation.header
conversation.header.leading             conversation.hero.agentPreset
conversation.hero.brand.mark            conversation.hero.options
conversation.hero.workspace             conversation.hero.workspace.directoryFlow
conversation.input.activity             conversation.input.attachments
conversation.input.dock                 conversation.input.left
conversation.input.model                conversation.input.model.label
conversation.input.overlay              conversation.input.permission
conversation.input.plan                 conversation.input.right
conversation.session                    conversation.session.header
conversation.session.header.actions     conversation.session.header.corner
conversation.session.header.lineage     conversation.session.header.utilities
conversation.trajectory.images          conversation.user.text.node
conversation.view                       deliverables.file.actions
deliverables.review.file.actions        layout
locale                                  main
main.conversation                       plugins.add.actions
plugins.bundle.activation               plugins.bundle.config
plugins.detail.actions                  plugins.detail.badge
plugins.detail.section                  plugins.item
plugins.row.config                      plugins.tab
rightbar                                rightbar.session
root                                    sessions
settings.action                         settings.close
settings.general.item                   settings.header
settings.launcher                       settings.models.footer
settings.onboarding                     settings.plugins.tab
settings.section                        settings.trigger
shell.bottom                            shell.leading
shell.overlay                           sidebar
sidebar.brand.mark                      sidebar.brand.name
sidebar.chat.conversation               sidebar.footer.action
sidebar.panellist                       sidebar.right.pane.tab
sidebar.right.pane.tab.title            sidebar.right.tab.document
sidebar.right.tab.document.action       sidebar.right.tab.document.actions
sidebar.right.tab.document.office.pdf   sidebar.right.tab.document.unpreviewable
sidebar.right.tab.files.actions         sidebar.right.tab.guide
sidebar.right.tab.guide.entry           sidebar.right.tab.menu.item
sidebar.session.row.hover               sidebar.session.row.leading
sidebar.settings                        sidebar.toggle.badge
sidebar.workspaces                      sidebar.workspaces.directoryFlow
sidebar.workspaces.session.menu.item    sidebar.workspaces.session.row.action
slots                                   theme
timer                                   tool.call.images
tool.call.toolview                      tool.view.cordis
uiWorkspace                             workspace.toast
workspaces
```

侧栏相关的三种格（易混淆，务必分清）：

| Slot | kind | 用途 |
|---|---|---|
| `sidebar.panellist` | **list** | **一级导航图标**（插件、计划任务就是这里） |
| `sidebar.workspaces` | single | 工作区/会话列表整格（ds-bot 用它替换团队侧栏） |
| `sidebar.footer.action` | list | 页脚动作（ds-bot 放了账号/连接/返回） |
