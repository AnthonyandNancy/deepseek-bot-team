> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/G1R8-REPORT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1-R8：创建后仍打不开 —— 旧数据迁移

日期：2026-10-21 · 触发：用户第二次报告「创建后还是无法打开」（附 usage 报错截图）

---

## 1. 排查过程（先证明，再改）

| 检查 | 结果 |
|---|---|
| 源码是否已是「群即 Session」 | **是**（`groups.js:172` `const id = await rt.createSession(title, {})`） |
| 安装路径（软链）下的代码 | **是新的**（`readlink -f` → 仓库；含新代码） |
| 插件是否被加载器启用 | **是**（`dsh.profile.bundles` 含 `ds-bot`，共 11 个） |
| 运行中的真实状态文件 | **全是旧格式** |

状态文件里当时有三个工作群：

```
wg-4824d4fd-…  named: undefined
wg-ecf53e6e-…  named: undefined
wg-88a32f01-…  named: undefined
```

**三个都是 `wg-` 前缀，即修复前创建的记录，都没有真实 Session。**
新代码只会打开 Session，而这三个 id 不是 Session，所以点了没反应。

→ 问题不在加载，而在**历史数据没有迁移**。

---

## 2. 修复：旧群就地补建 Session

新增 `wg.adoptSession(room)`：遇到 `wg-` 前缀的旧记录时，

1. 用群名创建一个真实 Session（`rt.createSession(room.name, {})`）；
2. 把群记录重新挂到这个 Session id 上，删掉旧键；
3. 同步更新 `links` 里指向旧 id 的关联；
4. 登记归属并保存。

在 `state` 接口返回列表前自动执行一次，所以**列表永远不会给出一个打不开的 id**。

端到端验证（预置一条旧记录再读列表）：

```
[ds-bot] workgroup "旧工作群" got its own Session (wg-OLD -> session-1)
列出的群 id: [ 'session-1' ]
是否已迁移成 Session: true
能按该 id 打开: true | 名字: 旧工作群
```

**你现有的三个工作群会在下次打开列表时自动获得 Session 并变得可打开，不需要重建。**

---

## 3. 关于截图里的 usage 报错

```
usage could not read session-7570db19-…: RemoteError: Session projection read was cancelled
usage could not read session-d594ce41-…: SessionQueryError: session observation was aborted
```

三条都是 **UUID 形式的 Session**，而我的工作群旧 id 是 `wg-` 前缀 —— 所以它们不是工作群 Session。

核对 `src/host/usage.js:284-300`：`owners` 只来自 `state.bots`、`state.rooms`、`state.agents`，**不包含工作群域**。

结论：这些是更早版本创建过、随后随群删除而失效的成员 Session 残留在 `usage` 扫描表里，属于历史数据噪声，不是本轮缺陷；新代码只在轮次真正运行时才创建成员 Session（`groups.js:382`），不会产生这种孤儿。

---

## 4. 命令与真实输出

```
--- verify ---
build  ok  0.3s
check  ok  0.3s
test   ok  7.2s
lint   ok  0.3s
all steps passed

npm test:  704 passed / 0 failed
client.js: 886544 B, sha256 11d3f8987fa51bcf
打包产物含 rows.js: 是
```

新增测试：
- `a legacy workgroup gets a Session the first time the list is read`

---

## 5. 请这样测

1. **完全退出** DSH Desktop，重新启动
2. 打开 Bot 界面 —— 你可能在 Console 看到一行
   `workgroup "…" got its own Session (wg-… -> session-…)`，这是迁移日志，正常
3. **点击已有的工作群** → 现在应当能打开
4. 新建一个工作群，再点开 → 也能打开

如果第 3 步仍打不开，请把 **Console 里 `[ds-bot]` 开头的行**发我——迁移失败会写明原因。

---

## 6. 本次教训

上一轮我修了"群应当是 Session"，但只改了**新建**路径，没有处理**已存在的记录**，
于是用户手里的旧群仍然打不开。

这类"改了模型却漏了迁移"的问题，以后要在改数据模型时一并考虑：
**新记录怎么建，旧记录怎么过渡。**
