> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R3-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1-R3：新建工作群改用原版选人功能

日期：2026-10-21 · 依据：用户反馈「要用原版的功能不要自己做」

---

## 0. 反馈与结论

| 用户原话 | 结论 |
|---|---|
| 「菜单里「新建工作群」点击后选择机器人，要用**原版的功能**不要自己做，因为这本身是原来的功能，只是入口时进入工作群的」 | **成立，且我违反了方案的冻结约束。** 已把自己造的选人表单整体删除，改为复用原版群聊流程 |

### 为什么这是必须改的

方案 §5 明确写着：

> **先完整复制原版群聊功能子系统与所需业务依赖，再隔离改造**；
> 不得通过「只复制 UI + 重写所有群业务」替代既定方案。

我上一轮写的 `WorkgroupForm`（自己做的成员勾选列表）正是"重写原版已有功能"——
选人、命名、管理员判定，原版全都有。用户这句话点出的不是一个 UI 问题，
而是一个**架构原则问题**。

---

## 1. 原版是怎么做的（读源码确认，不是我猜）

`src/host/roster.js` 的 `createRoom`：

```js
async function createRoom({ members: memberIds = [], name: roomName, notice, mode, admin, createdBy } = {}) {
  const members = [...new Set(memberIds)].filter(id => rt.botOf(id))
  checkMembers(members)                                   // 至少 2 个 Bot，至多 ROOM_MAX_MEMBERS
  const custom = cleanRoomName(roomName ?? '')            // 重名检查
  const adminId = admin !== undefined ? admin : defaultAdmin(members, createdBy)
  ...
  return holdName('room', custom, () => buildRoom({...}))
}
```

关键事实：

| 事实 | 含义 |
|---|---|
| `const title = custom \|\| autoRoomName(members)` | **群名是自动生成的**，不是用户输入 |
| `autoRoomName = members => ['You', ...names].join(', ')` | 名字形如 `You, Writer, Editor` |
| `checkMembers`: `members.length < 2` 抛错 | 至少两个 Bot |
| `defaultAdmin` | 用户建群时由主 Bot 当管理员 |

所以原版新建群聊**根本没有"输入群名"这一步**。我上一轮加的「工作群名称」输入框
不但重复，而且与原版语义不符——这也解释了为什么原版界面在选完管理员后
直接就能建群。

---

## 2. 改法：同一套流程，只换目的地

```
原版「新建群聊」                          「新建工作群」
  NewChat{ mode:'group' }        →        NewChat{ mode:'workgroup' }
    ↓ group = true                          ↓ group = true（同一个流程）
  选管理员（原版）                          选管理员（原版）
  多选成员（原版）                          多选成员（原版）
  键盘导航/动画/自动命名（原版）             同上（原版）
    ↓ makeGroup()                           ↓ makeGroup()
  actions.createRoom(...)                 actions.createWorkgroup(...)
    ↓                                       ↓
  本地群                                   工作群（/api/workgroup）
```

`src/client/new-chat.js` 的改动只有两处：

```js
// 1) 工作群模式就是群聊模式
const workgroupMode = mode === 'workgroup'
const [group, setGroup] = useState(mode === 'group' || workgroupMode)

// 2) 同一个 makeGroup，只按模式分流目的地
if (workgroupMode) {
  const created = await actions.createWorkgroup([admin, ...picked], { admin, ...(text ? { text } : {}) })
  actions.openWorkgroup?.(created.id)
  close()
  return
}
const room = await actions.createRoom([admin, ...picked], { admin, ...(text ? {} : { greet: true }) })
```

**原版的选人 UI 一行未改**：`choosingAdmin`、`Make admin`、`Add to group chat`、
`bt-token` 管理员标记、`AdminStar` 全部原样保留。

### 2.1 群名也回归原版

工作群的命名现在也用原版规则（`src/client/index.js`）：

```js
const name = ['You', ...members.map(id => roster.byId?.[id]?.name).filter(Boolean)].join(', ')
```

即 `You, Writer, Editor` —— 与本地群完全一致，用户之后可自行改名。

---

## 3. 删除了什么（负向证据）

| 文件 | 处置 | 原因 |
|---|---|---|
| `src/client/workgroup-form.js` | **删除整个文件** | 我自造的选人 + 命名表单，违反 §5 |
| `src/workgroup/client/styles.js` 的 `WG_FORM_CSS` | **删除整段** | 仅供上述表单使用的 20 条 CSS |
| `test/new-chat-workgroup.test.js` 中 3 例 | 删除并重写 | 原为测试自造表单，现改为测试"复用原版" |

构建产物核对：`bt-wgf` 出现 **0 次**（自造表单的类名已彻底消失），
`New workgroup name` 的自造字段也只剩 i18n 词条（无害但可后续清理）。

---

## 4. 新增的护栏测试

`test/new-chat-workgroup.test.js`（4 例）现在专门防回归：

| 用例 | 断言 |
|---|---|
| 菜单顺序 | 「新建工作群」紧跟「新建群聊」 |
| **只有一个选人器** | `workgroup-form.js` **必须不存在**；`workgroup` 模式复用 `group` 流程 |
| **不是自造表单** | 界面里不能出现 `New workgroup name` / `Workgroup name`；必须是原版 `To:` 构图 |
| 目的地正确 | `createWorkgroup([admin, ...picked])` 且本地群仍走 `createRoom` |

第 2 条是硬护栏：**若有人再引入第二个选人器，这个测试立刻失败。**

---

## 5. 命令与真实输出

```
--- verify ---
build  ok  0.5s
check  ok  0.3s
test   ok  9.3s
lint   ok  0.4s
all steps passed

npm test:  ℹ tests 683 / ℹ pass 683 / ℹ fail 0
npm run lint 裸跑: Found 13 warnings and 0 errors.  EXITCODE=0
client.js: 885228 B, sha256 5de423764604a7dc
```

用例数 686 → 683 是**预期减少**：删掉了 3 个测试自造表单的用例，新增 1 个复用的，
净减 3。

连续三次 `npm test` 与两次 `npm run verify` 均通过（排除偶发误报）。

---

## 6. 一处需要说明的判断

删掉自造表单后，**工作群不再有"起名"步骤**——这看起来像是功能减少，
但那是原版的真实行为，而用户的要求正是"用原版"。

如果后续确实需要自定义群名，正确做法是**给原版 `NewChat` 加一个可选名字输入**
（一次改动，本地群与工作群同时受益），而不是给工作群单独做一套。
这一点记入遗留，不在本轮擅自加。

---

## 7. 遗留

| 级别 | 项 | 说明 |
|---|---|---|
| **P0** | 需人工验收 | 点「新建工作群」→ 应看到**与原版新建群聊完全相同**的选人界面 |
| P1 | 工作群无可选群名 | 与原版一致；如需自定义，应为原版 `NewChat` 加共用字段 |
| P2 | i18n 中残留 `New workgroup name` 等词条 | 已无 UI 引用，可随下次清理删除 |
| P2 | 工作群成员仍限本地 Bot | 远端成员随 Hub 在 G4 |

---

## 8. 人工测试

1. 新建菜单 →「新建工作群」→ 界面应与「新建群聊」**一模一样**（先选管理员，再选成员）。
2. 选一个管理员 + 至少一个成员 → 出现「创建群聊」样式的按钮（工作群模式下走工作群创建）。
3. 创建后跳到该工作群面板，并弹出「已创建工作群「You, Writer」」。
4. 对照：用「新建群聊」做同样操作，两个界面应无差别。
