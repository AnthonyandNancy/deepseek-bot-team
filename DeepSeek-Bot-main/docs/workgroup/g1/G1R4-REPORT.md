> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R4-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1-R4：菜单创建的工作群没有标识 —— 根因与修复

日期：2026-10-21 · 触发：用户实测「点击加号 → 创建工作群 → 没有工作群标识」

---

## 1. 根因：创建出来的其实是**本地群**

不是标识没画出来，而是**那个群根本不是工作群**。

`src/client/new-chat.js` 里，工作群模式曾是**由初始 `mode` 派生的常量**：

```js
const workgroupMode = mode === 'workgroup'          // ← 常量，永远不会变
const [group, setGroup] = useState(mode === 'group' || workgroupMode)
...
// 菜单项只做了这一件事：
run: () => { setGroup(true); setCursor(0); ... }    // ← 没有设置工作群标记
```

从"+"菜单进入时，`mode` 是 `undefined`，所以 `workgroupMode` 恒为 `false`。
菜单项只把面板切进"群聊模式"，`makeGroup()` 里的分支判断：

```js
if (workgroupMode) { ...工作群... }   // 永远进不来
const room = await actions.createRoom(...)   // 于是走了本地群
```

**结果：菜单里的「新建工作群」实际创建了一个本地群**，自然没有工作群标识。

### 为什么之前的测试没抓到

之前的测试断言的是 `mode === 'workgroup'` 这一路径（即从侧栏 action 进入），
那条路径 `mode` 有值，标志为真，一切正常。
**菜单点击是另一条路径**，它不经过 `mode`——测试只覆盖了前者，漏掉了后者。
这正是"测试通过但功能是错的"的典型。

---

## 2. 修复

把标志从常量改成**可切换状态**，并让两个菜单项各自显式设置/清除它：

```js
const [workgroupMode, setWorkgroupMode] = useState(mode === 'workgroup')
const [group, setGroup] = useState(mode === 'group' || mode === 'workgroup')

// 「新建群聊」：清掉标志，避免两种入口互相影响
options.push({ key: 'group',     ... run: () => { setWorkgroupMode(false); setGroup(true); ... } })
// 「新建工作群」：置上标志
options.push({ key: 'workgroup', ... run: () => { setWorkgroupMode(true);  setGroup(true); ... } })
```

对称地清除是必要的：否则先点「新建工作群」再返回点「新建群聊」，
会误建工作群——这是同一个 bug 的镜像。

---

## 3. 标识逻辑核查（用户要求"确认逻辑正确"）

### 3.1 类别来自数据源，不靠名字猜

| 来源 | 渲染 | 标识 |
|---|---|---|
| `roster.rooms`（原版 `state.rooms`） | `RoomRow` | **无** |
| `wg.view()`（`workgroup/state.json`） | `WorkgroupRow` | `◆ 工作群` |

`sidebar.js` 的 order 用不同 `kind` 区分，两条渲染分支互斥：

```js
...roster.rooms.map(room => ({ kind: 'room', item: room, ... })),
...workgroups.map(room  => ({ kind: 'workgroup', item: room, ... })),
```

所以**同名不会误判**——截图里两行都叫 `You, Chief, 阿三大苏打`，判定依据是
数据来自哪个域，不是名字。

### 3.2 实测输出

同名群输入下渲染工作群行：

```
data-workgroup      : true
aria-label          : Workgroup, You, Chief, 阿三大苏打, 2 members
用原版 bt-row 类名  : true
chip 渲染           : true
badge 单独          : "bt-wg-chip"
```

### 3.3 不影响原群聊（负向证据）

对原版 `RoomRow` 函数体逐项检查：

```
RoomRow 含 bt-wg-chip      : false
RoomRow 含 bt-row-workgroup: false
RoomRow 含 data-workgroup  : false
RoomRow 含 WorkgroupBadge  : false
RoomRow 仍用原版类 bt-row  : true
RoomRow 仍调 openSession   : true
```

原群聊行一行未改，不携带任何工作群标识。

---

## 4. 新增护栏测试

`test/new-chat-workgroup.test.js` 增加一例，专门钉住这次的 bug：

```js
test('choosing "Create workgroup" from the menu really marks the pane as a workgroup', () => {
  // 菜单项必须置位，而不只是进群聊模式
  assert.ok(entryLine.includes('setWorkgroupMode(true)'))
  assert.ok(entryLine.includes('setGroup(true)'))
  // 标志必须是 state：常量无法被点击打开
  assert.ok(lines.some(l => l.includes('const [workgroupMode, setWorkgroupMode] = useState')))
  // 「新建群聊」必须清位，防止两种入口互相污染
  assert.ok(groupLine.includes('setWorkgroupMode(false)'))
})
```

**若有人把标志改回常量，或删掉任一方向的置位/清位，此测试立即失败。**

---

## 5. 命令与真实输出

```
--- verify ---
build  ok  0.3s
check  ok  0.3s
test   ok  6.9s
lint   ok  0.4s
all steps passed

npm test:  ℹ tests 689 / ℹ pass 689 / ℹ fail 0
npm run lint 裸跑: Found 13 warnings and 0 errors.
client.js: 881855 B（已重建，--check exit 0）
bundle 内 setWorkgroupMode 出现 3 次
```

---

## 6. 人工复测（请重装插件后重启）

| # | 操作 | 期望 |
|---|---|---|
| 1 | 点「+」→「新建工作群」 | 界面与「新建群聊」一致；创建后**新行带 `◆ 工作群`** |
| 2 | 点「+」→「新建群聊」 | 创建出**本地群**，**不带**标识 |
| 3 | 先点「新建工作群」退回，再点「新建群聊」 | 创建的是本地群（标志已正确清除） |
| 4 | 同屏对照两行 | 工作群有标识、本地群没有 → **请截图** |
| 5 | 深色主题重复第 4 项 | 仍可分辨 |
| 6 | 原版回归 | 本地群收发、右键菜单、改名均正常 |

---

## 7. 遗留

| 级别 | 项 |
|---|---|
| P0 | 上述人工复测未执行 |
| P1 | 工作群成员远端身份随 Hub 在 G4 |
| P2 | 菜单项文案与本地群同为「新建…」，可考虑后续复用原版图标区分视觉 |

---

## 8. 一条反思

这个 bug 的形态值得记住：**同一个动作有两条入口时，只测其中一条等于没测。**
工作群创建有「侧栏 action（带 mode）」和「新建菜单（不带 mode）」两条路径，
我前几轮只验证了前者。此后遇到多入口功能，测试必须逐条入口覆盖。
