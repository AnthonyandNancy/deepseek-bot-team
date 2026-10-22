> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R10-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1R10：为什么「从菜单创建工作群仍进不去」—— 运行时仍是旧代码

用户第三次报告同一现象，并附了诊断信息。这一轮不再猜测，先取证。

## 取证

| 事实 | 证据 |
|---|---|
| 正在跑的宿主进程 **15:24:48** 启动 | `state.lock` = `pid 59976, since 1792567495961` → `2026-10-21 15:24:55`；进程 `59976` 的 `StartTime` 也是 15:24:48 |
| 我的修复 **15:31–15:52** 才落盘 | `groups.js` 15:52:04、`channel.js` 15:51:54、`client.js` 15:56:55 |
| 该进程在 **15:59:39** 仍在写旧格式 | `workgroup/state.json` mtime 15:59:39；5 个群 id 全是 `wg-` 前缀；`sessionOwners` 为空 |
| 新代码不可能写出这种记录 | `createWorkgroup` 里 `const id = await rt.createSession(title, {})`，且立刻 `registerSessionOwner` |

结论：**运行中的宿主加载的是修复前的模块**。插件是 `link:` 安装（源码与磁盘同步），
但已加载的 ESM 模块不会热更新——必须让宿主进程真正重启。

`wg-` 前缀的记录 + 空的 `sessionOwners` 是新代码绝不会产生的组合，这条证据足以定论。

## 用真实状态文件复现

把用户真实的 `state.json` 拷进临时 home，用**真实宿主代码**跑一次 `state`：

```
workgroup "You, Chief, 阿三大苏打" got its own Session (wg-4824d4fd-… -> REAL-session-1)
workgroup "… 15:25:15" got its own Session (wg-ecf53e6e-… -> REAL-session-2)
workgroup "… 15:29:16" got its own Session (wg-88a32f01-… -> REAL-session-3)
workgroup "… 15:35:57" got its own Session (wg-f2ae6fc0-… -> REAL-session-4)
workgroup "… 15:59:39" got its own Session (wg-d2572700-… -> REAL-session-5)
迁移后 id: ['REAL-session-1', …, 'REAL-session-5']
  可打开=true  ×5
```

五个群全部迁移成功并可打开。**代码是对的，只是没被加载。**
所以本轮的真正交付不是再改一次缺陷，而是让「跑的是哪份代码」可被证明。

## 本轮改动：诊断能证明运行中的构建

`src/host/diagnostics.js`

- `builtAt()`：报告 `src/workgroup/host/groups.js` 与 `client.js` 的 mtime，以及宿主进程启动时刻；
- `reportWorkgroups()`：报告工作群总数，以及其中多少个**还没有自己的 Session**。

诊断表新增四行：

```
| Workgroups    | 5 total, 5 without their own Session |   ← 旧进程
| Host code     | 2026-10-21T07:52:04.116Z            |
| Host since    | 2026-10-21T08:03:38.980Z            |
| Client bundle | 2026-10-21T07:56:55.082Z            |
```

判定规则，一眼可读：

- `Host since` **早于** `Host code` → 进程加载的是旧代码，重启 DSH Desktop；
- `Host since` 晚于 `Host code` → 跑的是最新代码，若仍有问题才是真缺陷；
- `Workgroups` 出现 `N without their own Session` → 该群尚未迁移。

之前无法区分，是因为 `package.json` 的版本号始终是 `0.1.7`，诊断里没有任何会变的东西。

## 验证

```
npm run verify   build ok / check ok / test ok / lint ok
npm test         707 passed / 0 failed
client.js        888071 B  sha256 88a9f8c727d87276
```

诊断 markdown 实测输出（本地渲染确认四行都在位）。

## 请这样确认

1. **彻底退出** DSH Desktop（任务管理器里 `DeepSeek Harness.exe` 全部结束，
   尤其是 `pid 59976` 那个宿主进程），再启动；
2. 打开 设置 → 反馈，看诊断表：
   - `Host since` 应**晚于** `Host code`；
   - `Workgroups` 应变成 `5 total, all openable`；
3. 再点左侧工作群，应能进入。

若 `Host since` 仍早于 `Host code`，说明进程没真正退出，请把该行发我。
