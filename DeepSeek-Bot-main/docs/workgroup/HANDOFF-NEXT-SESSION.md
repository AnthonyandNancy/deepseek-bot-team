# 交接：工作群 adminId 委派 + Hub 登录 404

> 这份文件给**新会话**用。按要求只交接这两件事，其余（G6 群记忆等）不在范围内。
> 写于 2026-10-24，仓库 `D:\code\ai\DeepSeek-Bot\BotCode`，分支 `main`，HEAD `d01f32a`。
>
> **2026-10-25 更新：两项均已在源码中闭环。** 当前阶段仍是 **G5 自动部分完成，未开始 G6**；
> 本轮属于 G4/G5 已交付范围的缺陷修复，没有新开阶段。剩余动作只有：应用安装副本重装并重启
> （用户选择本轮不做，见 §2.6）、人工验收清单、G6。
>
> | 事项 | 源码/测试 | 用户机器生效 |
> |---|---|---|
> | 旧群 `lead_membership_id` 回填 | ✅ `syncRoster` + 5 条测试 | 源码重启后即生效 |
> | 发布包缺 `src/client/` | ✅ `files` + `package-files.test.js` + `npm pack` 复核 | ❌ 需重装 `app/node_modules/ds-bot` 并重启 |
>
> 本轮验证基线：ds-bot **1101 tests / 1100 pass / 1 skip / 0 fail**（串行；并行一次唯一失败为既有
> `work-dir` 2 s 时序用例，单独复跑通过）；hub **263 pass**；`build-client --check` exit 0；
> lint **13 warnings / 0 errors**；`git status --porcelain ds-bot/src/host/` 为空。

## 0. 不变的前提（用户反复强调，别推翻）

> **工作群是复制原版群聊所有代码为基础的新建的工作群聊，保证工作群的功能是在原版群聊复制后的代码上改且因地制宜的修改工作群的代码但是不能脱离。**

由此推出的硬约束：

- 工作群的任何行为，先看**原版群聊怎么做的**，再在复制件上改；原版的做法就是答案。
- 五个原版文件必须保持**字节一致**，不能为了让工作群好用去改它们：
  `src/host/groups.js`、`turns.js`、`delivery.js`、`resume.js`、`constants.js`。
  验收：`git status --porcelain ds-bot/src/host/` 必须为空（当前为空，已确认）。
- 工作群只在 `src/workgroup/` 下改。跨域只允许 `import`（只读引用），不允许反向依赖。
- 用户否掉过 `bot_role` 那种"新造一层权限模型"的做法。原版的权限是两层：
  `bot.permission`（自己的）+ `room.permission`（群覆盖），读取处 `applyPermission`
  是 `room?.permission ?? bot.permission`。工作群照抄这一套，只是值要远程同步。

其它仓库规矩见 `DeepSeek-Bot-main/AGENTS.md`（英文面向用户文案、`client.js` 是生成物要
`npm run build`、不自动提交、不加 AI 作者、PR 进 `dev` 不进 `main`、分支不能叫 `dev/…`）。

---

## 1. 问题一：adminId 该不该交给群主的 Main Bot

### 1.1 用户的问题

> adminId 仍是每台机器按自己的 Main Bot 算——原版就是如此，但是到了跨用户的工作群，群的
> adminId 是不是应该交由群主的 adminId ？确认下

### 1.2 确认结论（已确认，可直接执行）

**该交。而且用户的判断是对的，这不是原版的缺陷，是工作群必须"因地制宜"的地方。**

理由链（已经写进代码注释，见 `src/workgroup/host/groups.js:594-612`）：

- 原版 `defaultAdmin`（`src/host/roster.js:332`）：
  `members.includes(createdBy) ? createdBy : members.find(rt.isMain) ?? null`。
- 原版这么算**是对的**，因为本地群的成员全在**同一个团队**里，`rt.isMain` 只有一个
  `mainBotIds` 可问，答案天然唯一。
- 工作群跨账号。`rt.isMain` 问的是**本机**的 `mainBotIds`，所以 Alice 的机器选 Alice 的
  Main Bot、Bob 的机器选 Bob 的——同一个群两台机器两个 admin，`mode: 'admin'` 的回合
  问的是不同成员。这就是 defect。
- 用户的原话给了标准答案：「**工作群的 Main Bot 是群主的管理员/Main Bot**」。
- 所以：**哪台机器能回答"群主的 Main Bot 是谁"，就由它算一次，把答案存到 Hub，其余机器读
  回来。** 这个"答案"已经实现为 `workgroups.lead_membership_id`（迁移 v7）。

### 1.3 已经实现的部分（别重复做）

| 环节 | 位置 | 状态 |
|---|---|---|
| 建群时由群主机器选出 Main Bot 并上报 | `src/workgroup/host/channel.js:206-232` | 已实现 |
| `createWorkgroup` 转发 `leadEndpointId` | `host/hub.js:391-401`、`host/bridge.js:563` | 已实现 |
| Hub 落库（v7 迁移，`ON DELETE SET NULL`） | `hub/src/db/migrations.js:453-461` | 已实现 |
| Hub 读回 `leadMembershipId`（永远有键，`?? null`） | `hub/src/workgroups/service.js:195-204` | 已实现 |
| 改设置时上报 `leadMembershipId`（`null` = 清空） | `host/groups.js:1086-1128`、`host/hub.js:426-437` | 已实现 |
| Hub 校验必须是本群 active 的 botEndpoint | `hub/src/workgroups/service.js:574-590` | 已实现 |
| 成员被移除时显式清空 lead | `hub/src/workgroups/service.js:700` | 已实现 |
| 读回后决定 `adminId` | `src/workgroup/host/groups.js:628` | 已实现 |

`adminId` 的完整解析链（`groups.js:628`）：

```js
const adminId = hubLead?.id ?? ownerMember?.id ?? mainBot?.id ?? answerable[0]?.id ?? (room.adminId ?? null)
```

优先 Hub 的答案 → 群主自己的 Bot → 本机 Main Bot → 第一个能答的 → 保持原样。

### 1.4 剩下的真缺口（本次要修的）

> **2026-10-25：已修完，别重复做。** 落点按建议选了 `syncRoster`，没有让 `applyRoster` 背网络请求。
> 实现判据：`answer.leadMembershipId === null` + `answer.ownerUserId === wg.hub.account.hubUserId`
> + `rt.state.mainBotIds[0]` 能由 `endpointBots` 映射到该群一个 `ownerUserId` 匹配的 Bot endpoint；
> 只发一次 `updateGroupSettings({ workgroupId, leadMembershipId })`。写入成功后把同一个 membership
> 传给本次 `applyRoster`，所以一次同步后本地 `adminId` 立刻正确，而不是等下一轮。失败只 warn，
> 名册照常应用。5 条测试见 §1.5。

**`lead_membership_id` 在已有群上是 `null`，永远补不上。**

证据（读的是**正在跑的那个 Hub 库**，`BotCode/hub/hub/.data/hub.db`，schema v7）：

```
wg_6fd8512b47374a5b9964ce2041d929e5  lead_membership_id = null  reply_mode = admin  permission = null
wg_b903469a97ae478db52fe68d020ae91a  lead_membership_id = null  reply_mode = admin  permission = null
```

成因：上报只在两条路径发生——

1. 建群（`channel.js:206-232`）；
2. 设置页改了 admin（`groups.js:1086` 起，`leadTouched` 才发）。

而这两个群都是**这个功能存在之前建的**。`applyRoster` 在 `leadMembershipId === null`
时走回退链（`groups.js:610-612`），于是每台机器继续按**自己的** Main Bot 算 admin——旧的
divergence 原样保留。用户看到的现象就是"adminId 还是每台机器各算各的"。

**修法（在复制件的规则内，最小改动）**：让**群主那台机器**在同步名册时，"发现 Hub 上没
有答案、而我能回答"就补一次。判据与建群时完全一致，不引入新概念：

- 条件：`leadMembershipId == null`（Hub 没有答案）
  **且** 本机是这个群的群主（Hub 返回的 `ownerUserId` === 本机 `hubUserId`）
  **且** 本机 `mainBotIds[0]` 在这个群里（能解析出对应成员的 `membershipId`）。
- 动作：调 `updateGroupSettings({ workgroupId, leadMembershipId })`，**只补一次**，
  不做轮询、不在每次 roster 同步都发。失败就放弃（下次同步再试），绝不能因为补不上就
  让本地名册应用失败。
- 落点：`src/workgroup/host/groups.js` 的 `applyRoster` 尾部（已经有 room 和 next 的地
  方），或 `syncRoster`（`groups.js:740-752`）里——**后者更干净**，因为它是唯一"刚读完
  Hub 答案"的位置，且不会让 `applyRoster` 背网络请求。

注意：`applyRoster` 的 `same` 提前返回必须继续覆盖**每个**字段（`groups.js:646-663`）。
这个坑已经踩过两次（"结构存在" ≠ "接上了"），加字段就要加比较。

### 1.5 这条要配的测试（必须先红后绿）

> **已完成。** `ds-bot/test/workgroup-membership.test.js` 第 18–22 节，全部走 `apiHandle` + 真 Hub；
> 只在测试里包住 `bridge.updateGroupSettings` 计数/注入失败。先红时有 4 条失败（第 4 条当时已绿，
> 说明“无答案不发请求”分支本来就安全，保留作回归钉），实现后 5/5 绿。

- 已有群、Hub 上 lead 为 null、本机是群主 → 一次同步后 Hub 上 lead 变成本机 Main Bot
  对应的 `membershipId`，且 `room.adminId` 指向该成员。
- 同上但**本机不是群主** → Hub 上 lead 仍然 null，`room.adminId` 走回退链，且**没有**发出
  update 请求（用假 Hub 断言请求次数）。
- Hub 已经有 lead → 不发 update（幂等，不覆盖别人选的）。
- 本机 Main Bot 不在该群 → 不发 update。
- 补写失败（Hub 500）→ 本地同步仍然成功，`room.adminId` 用回退链，不抛错。

---

## 2. 问题二：Hub 登录 404

### 2.1 用户的问题

> 检查hub登录，现在404无法等登录。找出原因后，制定修改方案再执行

用户明确：**登录 UI 已经实现了**（"已经实现了，你看代码就知道了"），不要再造一个 Hub 网页
登录页。问的是为什么登录失败并 404。

### 2.2 根因（已定位，有日志硬证据）

**不是地址错、不是路径前缀、不是 Hub 没有页面。是发布包漏文件，导致整个工作群域没装
载，`/api/workgroup` 根本没注册，于是所有 `hub-*` 调用（含登录）404。**

证据一，应用自己的日志（`E:\DSHbot\data\bot\logs\diagnostics.jsonl`，这是用户正在跑的那个
实例的日志，不是测试）：

```json
{"time":1792809288817,"level":"warn","source":"host",
 "text":"the Workgroup domain is unavailable; the local Bot team keeps working:
 Cannot find module 'D:\\code\\ai\\DeepSeek-Bot\\BotCode\\DeepSeek-Bot-main\\app\\node_modules\\ds-bot\\src\\client\\characters.js'
 imported from ...\\app\\node_modules\\ds-bot\\src\\workgroup\\host\\bridge.js"}
```

同一条 warn 在 09:36:32、10:06:09、10:34:48 各出现一次（每次重启都失败）。

**这是 HEAD 那个提交引入的回归，不是老问题。** 时间线正好对上：

- `git log -S"from '../../client/characters.js'"` 显示这一行 `import` 是
  **`d01f32a`（HEAD，「修复六条用户反馈问题并增强跨机器同步功能」）新加的** —— 就是加
  "发布 Bot 外观快照" 那次。
- 加它的时候 `package.json` 的 `files` 没跟着改（`files` 最后一次变更是 `7851e5a`）。
- 日志也印证了：10 月 22 日 15:55 那条 warn 是**另一个**错
  （`Cannot find module './src/workgroup/index.js'`），从 10 月 24 日 09:36 起才变成
  `characters.js` 这个 —— 正是装上 `d01f32a` 之后。

所以"以前能登录、这个版本突然不行了"不是错觉。

证据二，缺失文件确实不在发布包里：

- `src/workgroup/host/bridge.js:32` → `import { lookOf } from '../../client/characters.js'`
- `ds-bot/package.json` 的 `files` 只有：
  `index.js`、`src/host/`、`src/shared/`、`src/workgroup/`、`client.js`、`web-search.js`、
  `cordis.patch.yml`、`README.md`、`LICENSE`
  ——**没有 `src/client/`**。
- 安装后的 `app/node_modules/ds-bot/src/` 只有 `host/`、`shared/`、`workgroup/`，
  没有 `client/`。已确认。

证据二之二，用 `npm pack --dry-run --json` 直接问 npm 会发布什么（在 `ds-bot/` 下跑）：

```
published file count: 73
has src/client/characters.js ? false
has src/client/ at all ?       false
workgroup host bridge present ? true      ← 带了引用方
client.js present ?             true      ← 只带了构建产物
```

即：**发布包里带着"要 import `../../client/characters.js`"的文件，却没有那个文件。**
73 个文件里一个 `src/client/` 都没有。这是打包清单的确定性缺口，不是环境问题。

证据二之三，直接解开 tarball 验证解析结果（已跑过）：

```
npm pack --pack-destination /tmp/packprobe
tar -xzf ds-bot-0.2.3.tgz -C extract
```

在解出来的树里解析 `bridge.js:32` 那条相对 import：

```
bridge.js present: true
resolves to: .../extract/package/src/client/characters.js
target exists: false            ← 解析到了，文件不在
```

而在源码树里同一条解析：

```
source tree target: <ds-bot>/src/client/characters.js  exists: true
```

即：**加上 `"src/client/"` 就是让发布后的目录结构和源码结构一致**，没有别的副作用。

证据三，失败是被**吞掉**的，所以 UI 上只看到 404：

`ds-bot/index.js:78-84`

```js
if (config.workgroup !== false) {
  try { loadWorkgroup(config).installWorkgroup(rt) }
  catch (error) { rt.warn?.('ds-bot: the Workgroup domain is unavailable; the local Bot team keeps working: %s', ...) }
}
```

`channel.js` 是域内最后一个 install，负责 `ctx.connection.fetch.register({ path: WG_ROUTE })`
（`src/workgroup/host/channel.js:875-884`）。install 抛错 → 路由没注册 → DSH 对本机
`POST /api/workgroup` 返回 404 → 客户端 `callWorkgroup` 抛 `HTTP_404`
（`src/workgroup/client/api.js:24`）→ Hub account 页显示失败。而 `/api/bot` 照常工作，
所以本地团队一切正常，只有 Hub 相关的全挂。

### 2.3 为什么先前的几个怀疑都不成立（省得重复走）

| 怀疑 | 实测 | 结论 |
|---|---|---|
| Hub 要有网页登录页，`GET /` 404 | Hub 全站只有 `/v1/*`；`git log --all -S'text/html' -- hub/src` 为空，历史上从来没有 HTML | 不是缺陷，Hub 就是纯 API |
| 尾部斜杠 | `POST /v1/auth/login/` → 401（路由存在） | 正常 |
| 方法不对 | `GET /v1/auth/login` → 405 | 路由存在 |
| baseUrl 带了 `/api` 前缀 | `POST /api/v1/auth/login` → 404 | 能造成 404，但**不是本例**：见下 |
| 存的是旧库账号 | 旧记录在 `~/.dsh`，指向 v1 库；真机用的是 `E:\DSHbot\data`，baseUrl `http://10.1.8.49:7788`，用户 `usr_e12d092…` 在 v7 库里存在 | 不是登录失败原因 |
| Hub 没起来 / 地址不通 | `127.0.0.1:7788`、`10.1.8.49:7788`、`localhost:7788` 的 `/v1/health` 全部 200 | 不是原因 |

顺带排掉的干扰项：端口 `4310`/`9210`/`9410` 属于 **QQ.exe / QQEX.exe**，不是 DSH；
真正的 DSH host 在 `127.0.0.1:59833`（`app/host-port.json`），带 `authenticatedUrl` 的
token 才能访问，`GET /` 无 token 返回 401 —— 那是 DSH 自己的鉴权，与本 bug 无关。

### 2.4 修改方案（按优先级，1 是必须）

> **2026-10-25：已执行 A1 + C，B 未做。**
> - `ds-bot/package.json` 的 `files` 已加 `"src/client/"`。
> - `ds-bot/test/package-files.test.js` 已按实际宿主 import 图自检：修前红（列出
>   `src/client/characters.js`、`src/client/inks.js`），加清单后绿。
> - `npm pack --dry-run --json` 复核：139 files，`characters.js` / `inks.js` /
>   `workgroup/host/bridge.js` 全在。
> - B（把加载失败原因显示到 UI）**没做**：本轮用户只要根因修复，避免为此改原版
>   `index.js` / `src/host/channel.js`；失败原因仍只在 diagnostics warn 里。若以后再做，按下面 B 的落点。
> - **用户机器生效仍差一步**：本轮按用户选择没有重装 `app/node_modules/ds-bot`、没有重启，
>   所以当前正在跑的应用依然会 404。步骤与验收标志见 §2.6。

**方案 A（根因修复，必做）：让发布包带上 host 实际用到的 `src/client/` 文件。**

三个选项，推荐 A1：

- **A1（推荐）**：`ds-bot/package.json` 的 `files` 加 `"src/client/"`。
  代价最小、零重构；`client.js` 已经由 `scripts/build-client.mjs` 从同一份源码生成，
  两份内容天然同源。缺点：包体积增大（`src/client` 约几十个文件）。
- A2：把 `lookOf` / `colorOf` / `hasShape` / `FALLBACK_SHAPE` 及 `characters.js` 依赖的
  `inks.js` 抽到 `src/shared/characters.js`，host 从 shared 引，client 也改从 shared 引
  （`src/client/characters.js` 保留 re-export 以免动一大片 import）。
  更"干净"但改动面大，且 `characters.js` 里还有大量 SVG 绘制代码，得先切干净。
- A3：只把 host 需要的几个纯函数复制到 `src/workgroup/host/`。
  **不推荐**：违反"只读引用原版"的原则，会出现第二份真相（颜色/形状算错就是两份不一致）。

A1 的具体改动：

```jsonc
// ds-bot/package.json
"files": [
  "index.js",
  "src/host/",
  "src/shared/",
  "src/workgroup/",
  "src/client/",      // ← 加这一行
  "client.js",
  ...
]
```

同时要检查还有没有**别的** host→client 引用（已全量扫过，`src/host/`、`src/shared/`、
`src/workgroup/` 里只有 `bridge.js:32` 这一处 `client/characters.js`；其余 `client/`
引用都在 `src/workgroup/client/` 内部，属于浏览器侧，不进 host 加载路径）。

**方案 B（必须配套）：这个失败不能再是静默的。**

现在域加载失败只写一条 warn，用户界面上表现为"登录 404"，查不到原因。至少要：
把 `loadWorkgroup` 的失败原因留在 `rt` 上（例如 `rt.workgroupError`），让
`hub-state` / 设置页能显示"工作群模块未加载：<原因>"，而不是让用户对着 404 猜。
**注意**：这条只在 `channel.js` 里加没有用——域没装载时 `channel.js` 也没跑。
落点应该是 `index.js` 的 catch 里记下来，由原版侧（`src/host/channel.js` 的 state 或
`api/bot` 的一个只读端点）暴露。**这个动 `src/host/` 要小心**——
`channel.js` 不在"五个不可改文件"名单里（名单是 `groups.js`、`turns.js`、`delivery.js`、
`resume.js`、`constants.js`），可以改，但改完必须 `git status` 证明另外五个没动。
如果判断风险大，B 可以只做"warn 里带上完整错误 + 在 `docs/workgroup/KNOWN-GAPS.md` 记
一条"，把 A 先发出去。

**方案 C（可选，防回归）：加一个打包自检测试。**

新增/扩展 `test/`（不是 `test/files.test.js`，那个是文件替换工具的测试，名字撞了而已；
建议 `test/package-files.test.js`）：遍历 host 侧实际加载的模块图（从 `index.js` 与
`src/workgroup/index.js` 出发），把每个相对 import 解析成路径，断言每个路径都落在
`package.json` 的 `files` 覆盖范围内。这个测试在修 A 之前必须**红**（`characters.js`
落在 `src/client/` 不被覆盖），修完变绿——正好符合"先红后绿"。

**执行完 A 之后必须做的事（否则用户还是 404）**：
装进 app 并重启。`app/node_modules/ds-bot` 是 `file:../ds-bot` 的拷贝，改了源不重装不
生效。**2026-10-25 核对：该副本仍缺 `src/client/`，用户选择本轮不重装、不重启，所以这一步尚未执行。**
步骤：

```sh
cd DeepSeek-Bot-main/app
rm -rf node_modules/ds-bot        # 或 npm install ds-bot 重新链接
npm install                       # 重新从 ../ds-bot 拷一份
# 然后完全退出 DeepSeek Bot 应用再启动
```

验证成功的标志：`app/node_modules/ds-bot/src/client/characters.js` 存在；重启后
`diagnostics.jsonl` 不再出现 "the Workgroup domain is unavailable"；`POST
/api/workgroup` 返回 JSON 而不是 404（要用带 token 的 URL，见 §2.3 尾注）。

**重装之前先做一个 30 秒的快速验证**（证明改 `files` 真的够，不用重装也能确认）：
直接把 `ds-bot/src/client/` 手工拷进 `app/node_modules/ds-bot/src/`，重启 app，看日志里
那条 warn 是否消失、登录是否恢复。恢复了就说明 A1 方案正确，再回头改 `package.json`
并正式重装。这一步能把"我猜是漏文件"变成"我验证过是漏文件"。

### 2.6 本轮结束时的安装状态（2026-10-25）

| 位置 | `src/client/` | 结论 |
|---|---|---|
| 源码树 `ds-bot/` | 有 | `npm pack` 也已包含，发布缺陷已修 |
| `app/node_modules/ds-bot/` | **没有** | 正在跑的应用仍会工作群域加载失败 → 登录 404 |

用户明确选择“暂不动 app，仅交付源码”。因此本轮的交付边界是：**源码、测试、发布清单已修好并可验证；
正在使用的应用要等维护者重装并重启后才获得修复。** 不要把“测试绿”说成“用户现在能登录”。

### 2.5 一个容易误判的点

Hub account 页打开时调的 `hub-state`（`src/client/index.js:671`）也走
`api/workgroup`。所以"域没装载"时，**页面连登录表单都是靠 `actions.hubState()` 失败后
的 catch 兜底渲染的**（`hub-settings.js:44-47`：`.catch(() => setHub({ loggedIn: false,
unreachable: true }))`）。表单能显示，但点"Sign in"必然失败。这解释了用户为什么"能看到
登录界面但登录不了"。

---

## 3. 现场信息（新会话直接用，别重查）

**仓库**：`D:\code\ai\DeepSeek-Bot\BotCode`，`main`，HEAD `d01f32a`。
版本：`ds-bot` 0.2.3；`hub` package.json 写的是 0.0.0。

**历史记录（2026-10-25；已提交，见提交范围 `22c2767..e71119b`）**。下面这段描述的是当时的未提交改动，不再代表当前工作区；G6 工作另见 `g6/ROUND-LOG.md`。

```
M DeepSeek-Bot-main/app/engine/package.json
M DeepSeek-Bot-main/app/package-lock.json
M DeepSeek-Bot-main/app/package.json
M DeepSeek-Bot-main/docs/workgroup/HANDOFF-NEXT-SESSION.md
M DeepSeek-Bot-main/docs/workgroup/progress-and-gaps.md
M DeepSeek-Bot-main/ds-bot/package-lock.json
M DeepSeek-Bot-main/ds-bot/package.json
M DeepSeek-Bot-main/ds-bot/src/workgroup/host/bridge.js
M DeepSeek-Bot-main/ds-bot/src/workgroup/host/channel.js
M DeepSeek-Bot-main/ds-bot/src/workgroup/host/groups.js
M DeepSeek-Bot-main/ds-bot/src/workgroup/host/hub.js
M DeepSeek-Bot-main/ds-bot/test/workgroup-membership.test.js
M hub/hub/.data/hub.db-shm
M hub/hub/.data/hub.db-wal
M hub/src/db/migrations.js
M hub/src/workgroups/service.js
?? DeepSeek-Bot-main/app/dist-pack-old/
?? DeepSeek-Bot-main/app/shots/packed-0.2.3.png
?? DeepSeek-Bot-main/ds-bot/test/package-files.test.js
```

**运行时**：

- 用户正在跑的 Hub：`node src/index.js`，监听 `0.0.0.0:7788`，
  数据目录 `BotCode/hub/hub/.data/hub.db`（schema **v7**）。**别杀这个进程。**
- 那两个 `hub.db-shm` / `hub.db-wal` 被它锁着，**故意没动**。只读查询可以，写会冲突。
- 用户正在跑的 app：electron，数据目录 `E:\DSHbot\data`，host 端口 `59833`，
  访问必须带 `authenticatedUrl` 的 token（无 token 一律 401）。
- 该 Hub 库里的账号：`usr_e12d092df15d47d3818fc06dc05af305`（+8613222222222）、
  `usr_6daffc00cb6248c2a1bb4095c00ac659`（+8613233333333）。
- **两个群都已存在**，见 §1.4 的 id。

**基线（2026-10-25 实跑）**：`ds-bot` **1101 tests / 1100 pass / 1 skip / 0 fail**（串行全量）；
并行一次为 1099 pass / 1 fail，唯一失败是既有 `work-dir.test.js` 的 2 s 时序断言，单独与串行均通过；
`hub` **263 pass / 0 fail**；lint **13 warnings / 0 errors**；`build-client.mjs --check` exit 0；
`npm pack --dry-run` 139 files 且含 `src/client/characters.js`。已知 flaky 1 条：
`a [PASS] reply stays out of the room log`（并行负载下偶发超时，单独跑必过）。

---

## 4. 建议的执行顺序

> **2026-10-25：1–4 已完成，见顶部的验证基线。**
> 1. §2 方案 A（`files` 加 `src/client/`）— 已做；app 重装/重启未做，用户选择暂不执行。
> 2. §2.4-C 打包自检 — 已做，先红后绿。
> 3. §1.4 lead 回填 + §1.5 的 5 条测试 — 已做，先红后绿。
> 4. 全量测试 / build check / lint / 原版只读检查 — 已通过。
> 5. 未提交，按 AGENTS.md 处理。

1. **（剩余，用户机器生效）** 在 `DeepSeek-Bot-main/app/` 重装 `ds-bot` 并完全重启应用；
   验收见 §2.6。
2. **（剩余，G6）** 群记忆 `group_memories`、重启恢复、完整验收与交付。
3. **（剩余，人工）** 执行 `manual-checklist.md` 的门禁 1/5/6、T20 冷启动、G5 门禁 2 真机一半、
   G5-N3、G5-T14 符号链接。
4. 不自动提交；要提交时按 AGENTS.md（英文祈使句 subject、PR 进 `dev`、分支不许
   `dev/…`、不加 AI 作者）。

**每一步改完都要过真实产品路径验证**（`apiHandle` + 真 Hub 进程），不要只跑单测。
