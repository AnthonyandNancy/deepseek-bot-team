> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/INCIDENT-install-failure.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# 插件安装失败事件记录（Desktop 无法启动）

日期：2026-10-21 · 影响：用户的**真实** DSH Desktop `0.2.1-rc.2` 连续 5 次无法启动
状态：**已修复并验证**（见 §5）

---

## 1. 现象

用户安装 `ds-bot` 后，DSH Desktop 弹出：

```
应用无法启动或已意外停止。
web boot: 1 entry did not activate
ds-bot: failed
诊断报告： ...\crash-2026-10-21T04-28-07-849Z-web-boot.log
```

崩溃日志（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\`，5 次内容完全相同，仅 `time`/`shell pid` 不同）：

```
--- error ---
Error: web boot: 1 entry did not activate
ds-bot: failed
    at .../app.asar/lib/main.js:12437:15
--- renderer console ---
Error: web boot: 1 entry did not activate
ds-bot: failed
```

## 2. 两个独立的根因

### 根因 A：`package.json` 的 `files` 白名单漏了新增目录

`package.json`：

```json
"files": ["index.js", "src/host/", "src/shared/", "client.js", "web-search.js", ...]
```

G1 新增的 `src/workgroup/` **不在白名单里**，而 `index.js` 顶层静态 `import` 了它：

```js
import { installWorkgroup } from './src/workgroup/index.js'   // ← 打包后文件不存在
```

以 tarball / 包方式安装时，`src/workgroup/` 被排除 → 静态 import 解析失败 →
整个插件模块加载失败 → DSH 报 `1 entry did not activate`。

**这类失败无法被单元测试发现**，因为本地跑测试时目录存在，只有**打包后**才缺。

证据：`npm pack` 出的 tarball 共 51 个文件，`src/workgroup/**` 一个都没有（修复前）。

### 根因 B：域是静态 import，失败即全局失败

即使目录存在，只要 Workgroup 半个模块有任何加载错误，`index.js` 的静态 import 就会让
**整个插件**加载失败。而方案 §7.1 要求：本地功能必须在网络型功能不可用时仍然可用。
原版 635 个测试里的 `install.test.js` 也守不住这条——它测的是注册顺序，不是"域挂了原版还在"。

### 附带问题 C：安装动作只写了 `bundles`，没写 `dependencies`

用户在 Desktop 插件界面安装时，`profiles/desktop/package.json` 被改成：

```json
"dependencies": { ...原有 13 个... },          // 没有 ds-bot
"dsh": { "profile": { "bundles": [ ..., "ds-bot" ] } }   // 有 ds-bot
```

`bundles` 引用了一个没有声明的包 → 解析失败 → 同样的 `1 entry did not activate`。
（这也意味着该安装入口的行为需要 DSH 上游确认；我们不依赖它。）

## 3. 修复

| # | 文件 | 改动 |
|---|---|---|
| 1 | `package.json` | `files` 增加 `"src/workgroup/"` |
| 2 | `index.js` | 移除静态 import；改为 `createRequire` + `loadWorkgroup(config)`，用 `try/catch` 包住安装，失败只 `rt.warn` 并继续；**保持 `createRuntime` 同步**（662 个测试依赖） |
| 3 | `index.js` | 新增测试专用 seam `config.workgroupModule`，用于真正触发 catch 分支 |
| 4 | `src/client/index.js` | `installWorkgroupClient(ctx)` 包 try/catch，失败只报错不阻断原版 surface |
| 5 | `test/workgroup-isolation.test.js` | 新增 2 个测试证明 catch 分支：注入一个 `installWorkgroup` 会抛错的模块，断言原版工具仍全部注册 |

关键代码（`index.js`）：

```js
if (config.workgroup !== false) {
  try {
    loadWorkgroup(config).installWorkgroup(rt)
  } catch (error) {
    rt.warn?.('ds-bot: the Workgroup domain is unavailable; the local Bot team keeps working: %s', ...)
  }
}
```

## 4. 为什么必须先打包验证

修复前后的对比实验（`npm pack` → 解包 → 真正 `import` 一次）：

| | 修复前 | 修复后 |
|---|---|---|
| tarball 内 `src/workgroup/**` | **0 个文件** | **9 个文件** |
| tarball 总文件数 | 51 | 51（`src/workgroup/` 已计入） |
| 解包后 `import index.js` | 失败（模块缺失） | `LOAD OK [COLORS, apply, createRuntime, inject, installWorkgroup, name]` |
| `client.js` sha256 与仓库一致 | — | 一致（`f45d2d7c…`） |

结论：**"本地测试全绿"不足以证明可安装**。以后每次改 `index.js` 的 import 图或新增目录，
都必须跑一次 `npm pack` + 解包加载，否则会重复这次事故。

## 5. 验证结果

见 `logs/FIX3-*.log` 与 `logs/FAILSAFE.log`：

| 项 | 结果 |
|---|---|
| `createRuntime` 仍为同步 `Function` | 通过 |
| 容错契约（`workgroup:false` 与注入抛错模块） | 9/9 + 2 个新测试通过 |
| `npm test` | 见 `FIX3-test.log` |
| `build` / `--check` | 通过 |
| oxlint | 0 errors |
| tarball 含 `src/workgroup/**` | 通过 |

## 6. 责任与教训

- **根因 A 是我的错**：新增了 `src/workgroup/` 却忘了同步 `package.json` 的 `files` 白名单。
  这个错误只会在"打包安装"时暴露，而我在 G0/G1 全程只跑 `link:` 方式的 bench，没跑过 `npm pack`。
- **根因 B 是设计缺陷**：把一个可选域做成静态强依赖，违反方案 §7.1 的容错要求。
- **流程缺口**：我把"手工改 profile 的 package.json"写进了给用户的指南，而不是只用
  插件管理界面。已从 `MANUAL-TESTS.md` 移除该做法。

## 7. 对用户真实环境的处理

- `C:\Users\guojl\.dsh\profiles\desktop\package.json` 已被恢复为原状（10 个 bundle、13 个依赖、无 `ds-bot`），
  并留有备份 `package.json.bak-g1-restored`。
- `pnpm-lock.yaml` 中无 `ds-bot` 残留。
- 未改动 `sessions/`、`bot/`、`skills/` 等任何用户数据。
