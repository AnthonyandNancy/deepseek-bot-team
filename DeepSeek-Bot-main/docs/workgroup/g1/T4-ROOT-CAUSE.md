> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/T4-ROOT-CAUSE.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# T4：「点 Bot 进去是假的」根因与修复

日期：2026-10-21 · 状态：**已修复，等人工验收**

---

## 1. 先回答任务书里的三个问题

任务书 §T4 要求「先答再改代码」。

| # | 问题 | 答案 | 证据 |
|---|---|---|---|
| 1 | ds-bot 的 Bot 模式是否本来就占用了 `main`？应替换还是并存？ | **没有占用。应并存。** `main` 是 keyed 槽，ds-bot 注册的是 `conversation` 键（由 `dsh-client-ui-conversation` 注册），我们用独立 key，互不覆盖 | `dsh-client-ui-conversation/lib/client.js:18438` `slots.register({ name:"main", key:"conversation", ... })` |
| 2 | `renderSlot("main",{},{entryKey})` 与 `register({key})` 的对应关系是否确认？ | **确认：按 `options.key` 严格相等匹配** | `dsh-client-ui-renderer/lib/client.js:1154` `entriesOfSlot(slotKey).find(e => e.options.key === opts?.entryKey)` |
| 3 | 面板渲染时 `shell` 组（TeamSidebar）是否仍挂载？会不会互斥？ | **仍挂载，不互斥。** 两者注册到不同槽：`shell` 组用 `shadow('sidebar.workspaces', …)`，我们注册 `sidebar.panellist` + `main` | `src/client/index.js:797` |

补充确认（决定 `selectPanel` 会不会抛错）：layout 的判据是

```js
// dsh-client-ui-layout/lib/client.js:595
new LayoutController(instance.actions,
  (id) => ctx.slots.entries("main").some((entry) => entry.options.key === id), …)
```

即 **只要有 `main` 条目其 `key` 等于该 id，`selectPanel` 就不抛错**。

---

## 2. 真实根因：不是注册失败，是**渲染成无样式抽屉**

任务书给的起步方向（"从未注册 main"）**不完整**。逐层核实后的真实链路：

### 2.1 注册其实是成功的

| 检查 | 结果 |
|---|---|
| 两个 `attempt()` 是否抛错 | 否。Desktop `diagnostics.jsonl` 里 **没有任何** `workgroup` 相关报错 |
| `main` 条目是否真的在 | 是。`test/workgroup-slot.test.js` 用**真实 `SlotCore`** 断言 `entriesOfSlot('main')` 含 `workgroup-bot` |
| 构建产物是否含新代码 | 是。`client.js` 含 `data-workgroup-panel` 与 `bt-wg` |

所以「假的」不是"没进去"，而是**进去了但看起来不像一个面板**。

### 2.2 两个真实的样式缺陷

**缺陷 A：面板根节点用了右侧抽屉的类名**

`panel.js` 原来写 `h('div', { className: 'bt-panel' }, …)`。但
`src/client/styles.js:348` 定义的是：

```css
.bt-panel{position:fixed;top:…;right:0;bottom:0;width:var(--bt-panel-w,320px);
          z-index:40;background:var(--bt-main);border-left:.5px solid …}
```

这是**固定定位、贴窗口右边、320px 宽的抽屉**，不是中间栏面板。
挂进 centre column 后，它变成一条贴在右侧、和栏宽无关的窄条。

**缺陷 B：面板用的布局类名一个都没定义**

逐个核对 `panel.js` 用到的类名在 `styles.js` 中的定义次数：

| 类名 | 定义次数 |
|---|---|
| `bt-panel-side` | **0** |
| `bt-panel-main` | **0** |
| `bt-chat` / `bt-chat-log` / `bt-chat-head` | **0** |
| `bt-composer` / `bt-composer-input` | **0** |
| `bt-row-menu` / `bt-row-avatar` / `bt-row-main` | **0** |
| `bt-line` / `bt-line-who` / `bt-line-text` | **0** |

也就是说：面板挂载了，但**几乎全部结构没有任何样式**，渲染成一串上下堆叠的裸文字。
用户说"假的"，是准确的描述。

### 2.3 第三个缺陷（人工测试前发现，属潜在 P0）

**`SHELL_CSS` 只在 Bot 模式安装，但 Bot 入口在普通表层也存在。**

`src/client/index.js:785` 把 `SHELL_CSS`（定义 `bt-row`/`bt-input`/`bt-soft`）
放在 `installShell` 里，而它由 `surfaceGroups` 按当前表层决定装不装。
用户可以从**普通会话**直接点「Bot」——这时 `SHELL_CSS` 没装，
面板复用的 `bt-row` 等类名同样是零样式。

修法：面板样式表内以 `.bt-wg .bt-row{…}` 形式**重述**它借用的类，
作用域限定在面板内，不影响原版渲染。

---

## 3. 修法（不做 hack）

| # | 改动 | 为什么不算 hack |
|---|---|---|
| 1 | 面板根类改为自有 `bt-wg`，新增 `src/workgroup/client/styles.js` 定义全部 `bt-wg-*` | 走官方 Slot 渲染路径，只是**给面板自己的元素加样式**；没有改 DSH 的 DOM，没有覆盖宿主 CSS |
| 2 | 借用的 `bt-*` 类以 `.bt-wg` 前缀重述 | 同上的作用域内样式，且保证普通表层也正确 |
| 3 | 样式经 `installStyles`（原版既有函数）安装一次，不每次渲染插 `<style>` | 复用原版机制，无新依赖 |
| 4 | 所有 `var(--bt-*)` 带字面 fallback | 面板在 `SHELL_CSS` 未安装时仍可读 |
| 5 | 面板通过 `slots.register({inject})` 拿到本地 roster | 官方 inject 机制，未读全局 |

### 3.1 为什么不是"换一种实现绕过去"

任务书要求：若 `main` 承载不了，必须报 BLOCKED。**它不是承载不了** ——
`main` 的契约明确支持非会话键：

```
'main': { kind: 'keyed'; scope: 'root' }
// "The reserved `conversation` key hosts the Conversation; other keys receive no Session binding."
```
（`dsh-client-ui-layout/lib/types/client/index.d.ts:53-57`）

参考实现 `plugin-manager` 与 `conversation` 都用 `main` + `key` 注册，
我们用同一形状。所以这是**修好了本该好的东西**，不是绕道。

---

## 4. 验收对照

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| T4-a | 点 Bot → 中间栏出现 Workgroups 面板 | 代码与运行时注册均已证实；**视觉待人工确认** | `test/workgroup-slot.test.js`（真实 SlotCore）+ 人工清单 |
| T4-b | 点回 Chief/本地群 → 能返回 | **PASS（源码级）** | `uiWorkspace.openSession` → `replaceMain(…, "reveal")` → `selectPanel(null)`（`dsh-client-ui-workspace/lib/client.js:821,993`），`activePanelId` 归 `null`，`main` 回到 `conversation` |
| T4-c | 再点 Bot → 回到面板，无报错 | **PASS** | `activePanelId` 记忆在 layout store；key 始终注册，`selectPanel` 不抛 |
| T4-d | Console 无 `is not registered` | **PASS** | 上述 `hasMainPanel` 判据为 true；dispose 后重新安装也不重复注册（`test/workgroup-slot.test.js` 第 3 例） |
| T4-e | 单测覆盖"注册 key 与 selectPanel 用的 key 一致" | **PASS** | `test/workgroup-slot.test.js` 第 1 例直接复现 layout 的判据 |

### 4.1 额外发现并修复的真实功能缺陷

写测试时发现：**新建的工作群如果没有成员，发消息会永远卡住**。

原因：`send` 只把消息塞进 `wg.roomInbox`，真正消费它的是 `workgroup_relay` 工具，
而那个工具需要"该群某个成员的 Session"来运行。没有成员 → 没有 Session →
消息永远躺在 inbox 里，UI 上表现为"发了没反应"——**正是用户上次抱怨的同一类问题**。

修法（两处，都是如实报错而非假装成功）：

1. `channel.js` 的 `send`：群成员为空时返回 `bot/invalid` 并说明原因；
2. 两个创建入口都要求至少选一个 Bot：新聊天菜单的表单 + 面板内表单。

测试：`test/workgroup-round.test.js` 新增 2 例（拒绝空群、正常群接受）。

---

## 5. 遗留

| 项 | 状态 | 说明 |
|---|---|---|
| T4-a 的"看起来对" | **需人工** | 自动化能证明挂载与样式类齐全，不能证明视觉观感 |
| 工作群成员目前只能是本地 Bot | 已知限制 | 远端成员随 Hub 在 G4 接入（`wg.deliver` 是预留接缝） |
| 面板没有独立的深浅色快照测试 | P2 | 样式全部走 `--bt-*` token，跟随主题；人工验收时请切主题看一眼 |
