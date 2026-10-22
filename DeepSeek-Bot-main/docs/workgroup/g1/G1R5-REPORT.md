> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R5-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1-R5：六项需求实现

日期：2026-10-21 · 依据：用户六条需求 + 「做需求前确认原版功能有没有」的指令

---

## 0. 前置：先核对原版，再动手

用户要求"做需求前确认原版的功能有没有"。第 0 项就是核查结果：

| 需求 | 原版有这个功能吗 | 结论 |
|---|---|---|
| 相同机器人重复建群 | **有**（`autoRoomName` 从成员派生，只有自定义名查重） | 我此前的实现**偏离了原版**，必须对齐 |
| 成员去重 | **有**（`[...new Set(memberIds)]`） | 我漏了，需补 |
| 空名建立 | **有**（空名→自动名，不报错） | 我错误地设为必填 |
| `@` 高亮 | **有**（`src/shared/mentions.js` 的 `mentionSpans`） | 直接复用，不自己写 |
| 悬停显示全名 | **有**（`BotRow` 用 `title:`） | 照同样做法补到群行 |
| 连接状态 | **无** | 新增，但用实测而非硬编码 |
| 同名禁用改管理员 | **无**（这是用户新规则） | 新增 |

---

## 1. 相同机器人可以重复建群（用户报的 bug）

### 1.1 原因：我的实现与原版不一致

原版 `src/host/roster.js`：

```js
const custom = cleanRoomName(roomName ?? '')
// cleanRoomName 内： if (next !== '' && (…重名…)) throw   ← 空名豁免
const title = custom || autoRoomName(members)              // 名字从成员派生
```

**原版只在"自定义名"时查重**；自动名（`You, Writer, Editor`）由成员派生，
两个群用同一批机器人必然同名，原版允许。

我的 `createWorkgroup` 却对一切名字查重，还要求名字必填 → 导致报
`A workgroup named You, Chief, 阿三大苏打 already exists`。

### 1.2 修复

```js
const autoWorkgroupName = members => ['You', ...members.map(m => m.name).filter(Boolean)].join(', ')

// 空名 = 用自动名（与原版一致），且不做查重
const custom = String(name ?? '').trim().slice(0, 60)
if (custom !== '' && …some(room => room.name === custom)) throw new Error(`Another group chat is already called "${custom}"`)

name: custom !== '' ? custom : autoWorkgroupName(unique),
...(custom !== '' ? { named: true } : {}),
```

同时补上原版的**成员去重**：

```js
const unique = []; const seen = new Set()
for (const member of members) {
  if (id == null || seen.has(id)) continue
  seen.add(id); unique.push({ ...member })
}
```

### 1.3 测试

```
✔ the same Bots can make several workgroups: the automatic name may repeat
✔ members are de-duplicated, as the original composer does
✔ a CUSTOM name still may not collide with another custom name
```

---

## 2. `@` 在群内高亮

**复用原版解析器**，不写第二个：

```js
import { mentionSpans } from '../../shared/mentions.js'
// 主机用它决定谁回答，面板用同一函数决定高亮谁 —— 所见即所呼
```

`@名字` 显示为 `.bt-wg-at`（强调色），`@all` 额外带底色 `.bt-wg-at-all`。
样式只用既有 `--bt-accent` / `--bt-tag-bg` token，未引入新色板。

---

## 3. 群聊右侧标题栏显示头像和名字

工作群面板标题栏现在是：**成员头像（`RoomAvatar`，原版组件）+ 群名 + 工作群标识 + 成员数**。
与本地群的会话标题栏（`HeaderPill`）读起来一致。

---

## 4. 悬停显示群名全称

长群名在行内被省略号截断，现在两种群行都带 `title`：

| 文件 | 行 | 改动 |
|---|---|---|
| `src/client/sidebar.js` | 114 | `title: room.name`（本地群行） |
| `src/workgroup/client/rows.js` | 43 | `title: room.name`（工作群行） |

与同文件 `BotRow` 既有的 `title: preview || bot.name` 是同一做法。

---

## 5. 同名群禁止修改管理员

用户规则：「同名的群聊和群聊之间禁止修改管理员，需要修改管理员，先把群名修改了」。

```js
// 统计与当前群同名的群数量
const sameName = Object.values(wg.state.workgroups).filter(other => other.name === room.name).length
if (sameName > 1) {
  throw new Error(`"${room.name}" is also the name of another group; rename this one before changing its admin`)
}
```

判定依据是**名字是否重复**（不是"是否自动命名"）。
名字唯一时可直接改管理员，不受影响。

测试：
```
✔ a group whose name is shared with another cannot have its admin changed
✔ a uniquely-named group may change its admin without renaming
```

---

## 6. 面板底部连接状态

原版没有这个组件，新增 `ConnectionLine`。**关键：它报告的是实测结果，不是装饰。**

```js
const started = Date.now()
await callWorkgroup('state')            // 真实往返本插件自己的路由
setState({ kind: 'ok', ms: Date.now() - started })   // 显示实测延迟
// 失败时显示具体原因，而不是一个笼统的红点
```

- 每 5 秒探测一次，`busy` 标志防止慢响应堆积；
- 面板关闭时 `live = false; clearTimeout(timer)` 停止轮询；
- `role="status"` + `aria-live="polite"`；`data-connection` 便于测试与截图核对。

---

## 7. 命令与真实输出

```
--- verify ---
build  ok  0.3s
check  ok  0.3s
test   ok  7.0s
lint   ok  0.3s
all steps passed

npm test:  ℹ tests 700 / ℹ pass 700 / ℹ fail 0
npm run lint 裸跑: Found 13 warnings and 0 errors.
client.js: 885869 B（已重建，--check exit 0）
```

构建产物核对：`bt-wg-at`×3、`mentionSpans`×4、`ConnectionLine`×2、`data-connection`×1。
`sameName` 属主机侧（`src/workgroup/host/groups.js`），不进 client bundle，已由主机测试覆盖。

过程中 lint 又抓到我一个未使用的 import，已修。

---

## 8. 人工验收

| # | 操作 | 期望 |
|---|---|---|
| 1 | 用**同一批机器人**连续建两个工作群 | **都能建成**，不再报 already exists |
| 2 | 两者名字都应是 `You, Chief, 阿三大苏打` | 自动名允许重复 |
| 3 | 对其中**自定义**命名后再用同名 | 应被拒绝（自定义名唯一） |
| 4 | 发送带 `@Chief` 的消息 | `@Chief` 高亮显示；`@all` 另有底色 |
| 5 | 打开工作群 | 标题栏有成员头像 + 群名 |
| 6 | 悬停任一群行 | 显示完整群名 |
| 7 | 两个同名群时改管理员 | 被拒绝并提示先改名；改名后可改 |
| 8 | 看面板底部 | 显示"连接正常 · N 毫秒"（或如实显示异常原因） |
| 9 | 原版回归 | 本地群收发、右键、改名不受影响 |

---

## 9. 遗留

| 级别 | 项 |
|---|---|
| P0 | 上述 9 项需人工验收 |
| P1 | 「连接正常」目前测的是本地插件路由，不是 Hub 连接；G4 接入 Hub 后应改为反映 WSS 状态 |
| P2 | 管理员变更在 UI 上还没有入口（主机侧已支持并有测试），随群设置页一起做 |
| P2 | `New workgroup name` 等已无引用的 i18n 词条可清理 |
