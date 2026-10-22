> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R2-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1-R2：「Bot」进入 DS Bot 本体 + 新建工作群可选机器人

日期：2026-10-21 · 依据：用户真实 Desktop 反馈两点 + 方案全文复核

---

## 0. 两条反馈与结论

| # | 用户原话 | 结论 |
|---|---|---|
| 1 | 「上方的「Bot」改为进入 ds bot 的界面」 | **成立。之前方向错了。** 方案 §0.9 原文：「在其正下方增加一个 **"Bot" 一级入口**。Chief、下属 Bots、私聊、本地群、工作群只能在 Bot 内部展示」——「Bot」是**进入 Bot 本体的门**，不是工作群面板 |
| 2 | 「菜单里「新建工作群」点击后无法选择机器人」 | **成立。根因是 CSS，不是逻辑。** 表单借用了接收人下拉框的 `.bt-drop`，而它是 `position:absolute; z-index:1` |

---

## 1. 点 1：为什么之前做错了

我上一轮把「Bot」这个一级入口直接当成**工作群面板**（`BotPanel` 注册在 `main[key]`）。
方案复核后确认这是我理解的偏差：

> 方案 §0.9：「原生 DSH 侧栏原位置保留"插件"；在其正下方增加一个 **"Bot" 一级入口**。
> Chief、下属 Bots、私聊、本地群、**工作群只能在 Bot 内部展示**，不得在 DSH 一级侧栏中逐项展开。」

即：`Bot` = 进入 DS Bot 的入口；工作群是 DS Bot **内部**的一个区块。
我做成「Bot = 工作群面板」，等于把工作群提到了与 DS Bot 平级的位置。

### 1.1 改法：门（door）机制

DSH 的 `sidebar.panellist` 点击一定走 `ctx.layout.selectPanel(id)`，
而 `selectPanel` 对未注册的 key 会抛错。所以 `main` 里**必须**有该 key 的条目。
于是把这个条目做成一个**过渡组件**而不是页面：

```
点「Bot」
  → selectPanel('workgroup-bot')        （layout 要求，必须存在）
  → BotDoor 挂载（useEffect）
  → actions.setSurface('bot')           让整个 DS Bot 表面（侧栏/会话/本地群）安装
  → ctx.layout.selectPanel(null)        中间栏交回 conversation
```

两处调用都是**官方公开 API**：`setSurface` 是 ds-bot 自己的动作（Agent 模式返回时用的
就是它），`selectPanel(null)` 就是"打开任意普通聊天"时发生的事。
没有搬 DOM、没有 CSS 藏元素。

### 1.2 工作群去哪了：DS Bot 侧栏内部

按 §0.9「工作群只能在 Bot 内部展示」，工作群列表移到 **DS Bot 侧栏**里：

- 新增 `WorkgroupSection`（`src/client/sidebar.js`），渲染在团队列表下方；
- 每行带 `◆ 工作群` 胶囊 + `data-workgroup-entry`；
- 点击行 → `actions.openWorkgroup(id)` → 切 Bot 表面 + 打开工作群面板。

附带好处：**本地群与工作群现在同屏并列**，这正是 T1 要的"一眼可分辨"，
比之前两个面板分开看更直接。

两个 key 的分工：

| key | 注册位置 | 有无一级图标 | 作用 |
|---|---|---|---|
| `workgroup-bot` | `main` + `sidebar.panellist` | **有**（唯一一个） | 进入 DS Bot 的门 |
| `workgroup-room` | 仅 `main` | **无** | 工作群面板本体 |

测试 `test/workgroup-slot.test.js` 断言：`workgroup-room` **不出现在** `sidebar.panellist`，
且 `workgroup-bot` 只出现一次（方案 §0.9 要求"仅添加一个一级入口"）。

---

## 2. 点 2：为什么选不了机器人

### 根因

`WorkgroupForm` 借用了新聊天接收人下拉框的类名：

```
.bt-drop{position:absolute; top:48px; left:32px; ... z-index:1}
```

这是**浮动弹层**，不是表单容器。放进表单后：

1. 成员列表绝对定位，视觉上浮动；
2. 盖住了下方的「创建」按钮与提示；
3. 点击落在浮层而非行上 → 表现为"点了没反应"。

### 改法

表单改用自己的一套类（`bt-wgf-*`，定义在 `src/workgroup/client/styles.js`
的 `WG_FORM_CSS`），走**正常文档流**：头部（群名 + 返回/关闭）、
可滚动的成员区、底部（已选计数 + 创建）。

成员行有明确选中态：左侧方块勾选 + `aria-selected`，不只靠颜色。

### 顺带修掉的第二个问题

成员查找原来写 `roster.byId?.[id]?.name`。但 `roster.byId` 是**多键索引**——
同一个 Bot 还会按 `bot.parts` 里的 Session id 再索引一次（`sources.js:29`）。
用它查名字不仅可能取错，更危险的是会让人误以为成员 id 可以传 Session id。
现在改为**只在 `roster.bots` 里按 `bot.id` 精确查找**，并注释说明原因。

---

## 3. 一个真实的可用性缺陷（上一轮已修，本轮保持）

成员为空的工作群发消息会永远卡住：`send` 只把消息塞进 `wg.roomInbox`，
真正消费它的是 `workgroup_relay`，而那个工具需要一个**成员**的 Session 才能运行。

现在：`channel.js` 的 `send` 对空群如实返回 `bot/invalid` 并说明原因；
两个创建入口都要求至少选一个 Bot。与用户上次抱怨的"没反应"是同一类问题。

---

## 4. 命令与真实输出

```
--- verify ---
build  ok  0.2s
check  ok  0.3s
test   ok  6.7s
lint   ok  0.3s
all steps passed

npm test:  ℹ tests 686 / ℹ pass 686 / ℹ fail 0
npm run lint 裸跑: Found 13 warnings and 0 errors.  EXITCODE=0
client.js: 890648 B, sha256 5b4622be1764b603
```

构建产物核对：`onEnterBot` 出现 6 次、`bt-wgf-member` 9 次、`bt-wgf` 35 次、
`data-workgroup-entry` 1 次 —— 两处修复都进了 bundle。

---

## 5. 测试变化

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `test/workgroup-slot.test.js` | 5（+2） | 门的 key 可选中；**工作群面板无一级图标**；仅一个 Bot 入口 |
| `test/new-chat-workgroup.test.js` | 7 | 菜单顺序；创建流程用 `workgroup-room` key |
| `test/workgroup-panel.test.js` | 8 | 面板根类、样式完整性、标识、成员要求 |

---

## 6. 遗留

| 级别 | 项 | 说明 |
|---|---|---|
| **P0** | 两点修复均需人工验收 | 我改的是架构与样式，最终"点得进去、点得动"必须人眼确认 |
| P1 | 工作群成员只能选本地 Bot | 远端成员随 Hub 在 G4（`wg.deliver` 是预留接缝） |
| P1 | 工作群面板与侧栏区共用 `workgroupStore` | 同源可观察对象，刷新一处两处同更新；G4 接 Hub 后改为服务端推送 |
| P2 | 侧栏工作群区在窄栏（rail）下只显示图标 | 与本地群行行为一致 |

---

## 7. 人工测试（请重装插件后重启 Desktop）

1. 点左下「**Bot**」→ 应进入 **DS Bot 界面**（团队/私聊/本地群都在），
   **不是**空白面板，中间栏是当前会话。
2. 侧栏底部应有「工作群」分区，列出已有工作群；行上有 `◆ 工作群` 胶囊。
3. 新建菜单 →「新建工作群」→ 表单里**能点选机器人**，选中行出现勾选；
   未选时「创建」是灰的。
4. 填名 + 选一个 Bot + 创建 → 跳到该工作群面板，并弹出「已创建工作群「X」」。
5. 在同一屏对照本地群行与工作群行，确认可分辨（**请截图**）。
