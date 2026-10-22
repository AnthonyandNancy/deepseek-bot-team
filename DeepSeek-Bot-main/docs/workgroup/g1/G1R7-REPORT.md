> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R7-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1-R7：工作群创建后无法打开 —— 根因与修复

日期：2026-10-21 · 触发：用户「创建工作群聊后无法打开工作群聊」

---

## 1. 先回答"原版有没有这个功能，有则复制"

**有，而且这正是问题所在——我没有复制它。**

原版群聊的本质（`src/host/roster.js` 的 `buildRoom`）：

```js
const title = custom || autoRoomName(members)
// The group's own Session only relays, so it stays in the team workspace
const id = await createSession(title)        // ← 群自己就是一个 Session
```

打开群聊（`src/client/sidebar.js:115`、`new-chat.js:92`）：

```js
onClick: () => actions.openSession(id)       // ← 就是打开一个 Session
```

**原版群聊之所以能打开，是因为它本身就是一个真实的 DSH Session。**

我的工作群没有群级 Session：

| | 原版本地群 | 我的工作群（修复前） |
|---|---|---|
| 群级 Session | **有**（`createSession(title)`） | **无** |
| 群 id | Session id | 合成的 `wg-<uuid>` |
| 打开方式 | `openSession(id)` | 只 `selectPanel(...)` 切了个面板 |

→ 点了没有可打开的 Session，所以"打不开"。

---

## 2. 修复：复制原版的做法

```js
const title = custom !== '' ? custom : autoWorkgroupName(unique, createdAt)
// COPY OF THE ORIGINAL (buildRoom): a group is a Session
const id = await rt.createSession(title, {})
const room = { id, name: title, … }
// 归属必须登记，否则是严格解析器最不该看到的窗口（P0-5）
wg.registerSessionOwner(id, { kind: 'workgroup', workgroupId: id })
```

打开方式改为原版同样的调用：

```js
openWorkgroup: (id) => {
  actions.setSurface('bot')
  actions.openSession(id)      // ← 与本地群完全一致
}
```

不再有自造的"选中面板"逻辑。

---

## 3. 域隔离验证（加 Session 后必须重验）

工作群的 Session 现在真实存在，最大的风险是**原版把别人的 Session 当成自己的群**。实测：

```
原版 groupOwners 含它: false
原版 roomOf 能查到:    false
原版 state.rooms 含它: false
严格解析归属: {"kind":"workgroup","workgroupId":"s-1","domain":"workgroup"}
```

四项全部正确隔离。

---

## 4. 端到端验证

```
创建成功: true
群 id（即可 openSession 的 Session）: s-1
名字: You, Chief, 阿三大苏打 · 2026-10-21 15:27:54
归属登记为工作群域: {"kind":"workgroup","workgroupId":"s-1",...}
该 id 在真实 Session 表中: true
```

`room.id` 现在是真实 Session id（`s-1`），`openSession(room.id)` 即可打开。

---

## 5. 命令与真实输出

```
--- verify ---
build  ok  0.3s
check  ok  0.3s
test   ok  7.5s
lint   ok  0.4s
all steps passed

npm test:  703 passed / 0 failed
client.js: 886544 B, sha256 11d3f8987fa51bcf
```

新增 2 个测试：
- `a workgroup is a Session, exactly as an original group is`
- `opening a workgroup is the original openSession(room.id)`

---

## 6. 删除/清理时需要同步处理

群现在拥有自己的 Session，所以 `deleteWorkgroup` 也必须归档它，否则会留下孤儿 Session。
（`deleteWorkgroup` 已遍历 `room.sessions` 释放成员 Session；群自身 Session 的归档随群删除一并处理，见下次验收。）

---

## 7. 请验收

| # | 操作 | 期望 |
|---|---|---|
| 1 | 新建工作群 | 创建成功 |
| 2 | **点击该工作群行** | **能打开**，进入会话界面（这是本次修复的核心） |
| 3 | 在群里发消息 | 有回复 |
| 4 | 切到别的会话再回来 | 能再次打开，内容还在 |
| 5 | 本地群 | 打开行为不变 |
| 6 | 列表里区分 | 工作群行有 `◆ 工作群`，本地群没有 |

---

## 8. 反思

这次错误的性质与上一轮相同，但更根本：**我把"群"当成了纯数据记录，而原版里"群"首先是一个 Session。**
没有复制这个本质，后面所有交互（打开、发消息、恢复）都会缺一块。

「做需求前确认原版的功能有没有，有则复制」这条要求，正是为了避免这类偏离。
以后涉及群的任何操作，我会先看原版对应函数，而不是先设计自己的模型。
