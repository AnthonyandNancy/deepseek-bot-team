> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R6-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1-R6：相同机器人仍报 already exists —— 真正的根因

日期：2026-10-21 · 触发：用户第二次报告同一问题（截图）

---

## 1. 先回答"原版有没有这个功能"

**有。** 原版客户端新建群聊时**根本不传名字**：

```js
// src/client/new-chat.js:90 —— 原版
const room = await actions.createRoom([admin, ...picked], { admin, ...(text ? {} : { greet: true }) })
```

`name` 是 `undefined`，后端 `createRoom` 走 `autoRoomName(members)` 派生
`You, Writer, Editor`，且 `cleanRoomName('')` 因为名字为空**跳过查重**。

我上一轮改的**后端**是对的（空名不查重），但**客户端仍在自己拼名字并传过去**：

```js
// 我上一轮的 src/client/index.js —— 错在这里
const name = ['You', ...members.map(...)].join(', ')
await callWorkgroup('create-room', { name, members, ... })   // ← 传了 name
```

于是后端把它当成**自定义名**，自定义名必须唯一 → 第二个群报错。

**真正根因：客户端越权造了名字。** 上一轮我只改了后端规则，没检查客户端是否传名。

---

## 2. 修复

客户端不再传 `name`，与原版完全一致：

```js
createWorkgroup: async (members, options = {}) => {
  const room = await callWorkgroup('create-room', {
    members: members.map(id => ({ id, name: …, kind: 'localBot' })),
    adminId: options.admin ?? undefined,
  })
  // 名字由主机按 autoRoomName 派生，客户端不参与
```

---

## 3. 端到端验证（真实路由，非仅单测）

用真实 `createRuntime` + 真实 `/api/workgroup` 路由复现你的场景：

```
第一个: You, Chief, 阿三大苏打
第二个: You, Chief, 阿三大苏打
两个都是自动名: true
自定义名仍查重: true true
```

同一批机器人连续建两个成功；自定义名 `财务月报` 第二次仍被拒绝（规则未被放宽）。

---

## 4. 为什么你截到的是**旧提示语**

截图里是 `A workgroup named You, Chief, 阿三大苏打 already exists`，
而当前源码里只有 `Another group chat is already called "…"`，`A workgroup named`
**在整个仓库中已不存在**（只在测试注释里作为历史引用）。

同时核实：`C:\Users\guojl\.dsh\profiles\desktop\node_modules\ds-bot` 是**软链接**，
指向 `D:/code/ai/DeepSeek-Bot/ds-bot` —— 没有"副本过期"问题，
已安装副本的源码里也是新提示语。

**结论：你测的那次运行的是仍在内存里的旧代码**（进程在我改动之前启动）。
插件是 `link:` 安装，文件改动即时可见，但**已加载的模块不会自动重载**。

→ **请在重新构建后完全退出并重启 DSH Desktop**，再测。

---

## 5. 新增护栏测试

```js
test('workgroups are created WITHOUT a client-side name, as the original does', () => {
  assert.ok(!/name:/.test(body…), 'the create call must not pass a `name`')
  assert.ok(!/\.join\(', '\)/.test(body), 'no client-side "You, A, B" is built here')
  // 并断言原版也是不传名字的
  assert.match(composer, /actions\.createRoom\(\[admin, \.\.\.picked\], \{ admin/)
})
```

若有人再把名字塞回客户端，此测试立即失败。

---

## 6. 构建与校验

```
npm run verify:  build ok / check ok / test ok / lint ok  → all steps passed
npm test:        701 passed / 0 failed
npm run lint:    13 warnings / 0 errors
client.js:       886005 B, sha256 ee93c2f8c64560fa, mtime Oct 21 15:14
```

---

## 7. 请这样测

1. **完全退出** DSH Desktop（不是只关窗口）
2. 重新启动
3. 「+」→「新建工作群」→ 选 **Chief + 阿三大苏打** → 创建
4. 再来一次，**同样两个机器人** → 应当**也能创建成功**
5. 两个群都叫 `You, Chief, 阿三大苏打`，都带 `◆ 工作群` 标识

若仍报错，请把**新的错误原文**发我 —— 提示语会告诉我们是哪条规则触发。

---

## 8. 反思（这类错误的模式）

连续两轮在同一处出错，原因相同：**我只改了自己注意到的那一层**。
第一次改后端空名豁免，没查客户端；第二次才顺着"错误文本与源码不符"这条线找到客户端。

以后遇到"后端规则已改但行为没变"，第一件事应当是**核对调用方实际传了什么**，
而不是继续在后端加豁免。
