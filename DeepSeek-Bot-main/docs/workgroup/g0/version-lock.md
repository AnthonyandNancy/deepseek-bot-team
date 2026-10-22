> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g0/version-lock.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G0 版本锁与来源证据（Version lock / provenance）

本文件只记录**可直接从本地文件读出**的证据，不依赖网络。凡是无法在本机证明的项，明确标为 UNVERIFIED。

## 1. DS Bot（上游插件）

| 项 | 值 | 证据来源 |
|---|---|---|
| 仓库 | `https://github.com/Fei2411/DeepSeek-Bot.git` | `.g0-work/upstream/.git/config` 的 `remote.origin.url` |
| 标签 | `v0.1.7` | `.g0-work/upstream/.git/packed-refs` 第 22 行 |
| **完整 commit SHA** | **`939a6635830cb5b246e7dd19c67b0e1352ad1c07`** | `.g0-work/upstream/.git/packed-refs`：`939a6635…1c07 refs/tags/v0.1.7`；`.g0-work/upstream/.git/HEAD` 为该 SHA（detached） |
| 短 SHA | `939a663` | 与方案正文所述发行页短 SHA 一致 → 基线核对通过 |
| 包名 / 版本 | `ds-bot` / `0.1.7` | `ds-bot/package.json` |
| 许可证 | Apache-2.0 | `ds-bot/package.json` 的 `license` 字段 + `ds-bot/LICENSE` |
| 包内 `files` 白名单 | `index.js, src/host/, src/shared/, client.js, web-search.js, cordis.patch.yml, README.md, LICENSE` | `ds-bot/package.json` |

### 1.1 许可证与 NOTICE 完整性（已核对）

| 文件 | 位置 | 状态 |
|---|---|---|
| Apache-2.0 全文（201 行） | `ds-bot/LICENSE` | 保留，来自上游 `ds-bot/LICENSE` |
| 同上（仓库根副本） | `ds-bot/LICENSE-REPO-ROOT` | 保留，来自上游 `LICENSE`；与 `ds-bot/LICENSE` 内容一致（同 sha256 前缀 `1eb85fc9…`），故实为同一文件，未丢失任何许可文本 |
| NOTICE（71 行） | `ds-bot/NOTICE` | 保留，来自上游根 `NOTICE`；声明 DS Bot 版权 + DeepSeek Harness MIT + 第三方思路致谢 |
| 包内 `README.md` | `ds-bot/README.md` | 保留 |

> 处置说明：上游 `ds-bot/` 子包自带 `LICENSE`，而仓库根另有 `LICENSE`+`NOTICE`。二者内容相同（LICENSE）且 NOTICE 仅存在于根。为**同时**满足"Fork 保留上游许可"与"不覆盖插件包内许可"，根副本以 `LICENSE-REPO-ROOT` 名义并列保存，`NOTICE` 直接放在 `ds-bot/NOTICE`。三项均未被修改或删除。

### 1.2 复制完整性

| 项 | 数量 | 说明 |
|---|---|---|
| `BotCode/DeepSeek-Bot-main.zip` 解压出的快照 文件数（源码树，不含 node_modules） | 217 | 基线 |
| 复制到 `ds-bot/` 的源文件 | 217 | 逐目录 `Copy-Item -Recurse -Force`，含 `.npmrc`、`.oxlintrc.json`、`.gitattributes` 等 dotfile |
| 追加的许可证文件 | 2 | `LICENSE-REPO-ROOT`、`NOTICE` |
| 追加的 G0 文档/日志 | `docs/workgroup/g0/**` | 本次新增，不覆盖任何上游文件 |
| `ds-bot/node_modules/` | 安装产物 | 由 `npm ci` + `npm run harness` 生成，非源文件 |

`ds-bot/package-lock.json` sha256 = `3b2fcb64e1da7a254fa7368d76196e1844dece285e8dc0c14d2e044b97cbace7`
（见 `docs/workgroup/g0/environment.txt`；与上游 lock 一致，证明依赖树未被改动。）

## 2. DeepSeek Harness（DSH）

### 2.1 两个版本，必须分开陈述

| 版本 | 角色 | 证据 |
|---|---|---|
| `0.2.1-rc.2` | 上游 **声明并测试** 的 DSH 版本 | `ds-bot/dev/harness/package.json` 固定 `"@deepseek-ai/dsh": "0.2.1-rc.2"`；`ds-bot/README.md:7` "Tested with dsh `0.2.1-rc.2` (Web and Desktop) on Linux"；上游 CI 矩阵 `.g0-work/upstream/.github/workflows/test.yml` 主矩阵 `dsh: 0.2.1-rc.2`（另有 `0.2.1-alpha.1` 一条） |
| `0.2.1-rc.2` | 本机 **DSH Desktop 实际携带** 的运行时 | `.g0-work/desktop-runtime.json` 的 `release.version`；`.g0-work/package.json` 中全部 `@deepseek-ai/*` 均为 `0.2.1-rc.2`；`.g0-work/asar-list.txt` 为同版本 asar 清单 |

**这不是矛盾，而是一个必须记录的兼容性缺口**：上游从未声明测试过 `0.2.1-rc.2`。方案要求"以第一阶段实测的兼容版本与精确 SHA 为准"，因此 G0 必须**两个都实测**（见 `gates.md`）。

### 2.2 DSH 精确版本信息

| 项 | 值 | 证据 |
|---|---|---|
| `release.version` | `0.2.1-rc.2` | `desktop-runtime.json` |
| `hostProtocolVersion` | `4` | 同上 |
| `release.nodeVersion` | `24.21.0` | 同上（**DSH 期望的 Node**） |
| `release.pnpmVersion` | `11.28.5` | 同上（**DSH 期望的 pnpm**） |
| `platform` / `arch` | `win32` / `x64` | 同上 |
| `sharedPackages` 条目数 | 约 300 个 `@deepseek-ai/*` 等 | 同上，全部 `0.2.1-rc.2`，`cordis` `4.0.5`、`schemastery` `3.18.5`、`node-addon-system` `0.1.2` |
| 逐文件 sha256 清单 | 见 `desktop-runtime.json` 的 `files[]` | 可用于日后校验运行时是否被替换 |
| DSH 自身 commit SHA | **UNVERIFIED** | `@deepseek-ai/dsh` 以 npm tarball 分发，`.g0-work/` 中无其 `.git`，网络受限无法查 registry provenance。故只能锁 **npm 版本号 `0.2.1-rc.2`**，不能声称锁定了 commit SHA |

> 结论（须如实写入门禁）：DS Bot 侧可锁到 commit SHA；DSH 侧只能锁到**发布版本号** `0.2.1-rc.2`（测试基线）与 `0.2.1-rc.2`（桌面运行时）。方案 17 节要求"DSH 兼容 commit SHA"作为实施前必须落地的运行参数，本项因此为 **部分未完成 / 需上游 source 或 registry 访问**。

## 3. 本机环境（实测）

来源：`docs/workgroup/g0/environment.txt`

| 项 | 值 |
|---|---|
| Node | `v26.7.0` |
| npm | `11.19.0` |
| pnpm | `10.34.5` |
| git | `2.55.0.windows.2` |
| PowerShell | `5.1.26100.8457` |
| OS | `Microsoft Windows NT 10.0.26100.0` / `Microsoft Windows 10.0.26100` |
| 记录时间 | `2026-10-21T03:11:07Z` |

### 3.1 环境偏差（必须显式声明，不得掩盖）

| 项 | DSH 期望 | 本机实测 | 影响 |
|---|---|---|---|
| Node | `24.21.0` | `v26.7.0` | **重大版本差 2 个 major**。上游 CI 测的是 Node 22/24，**从未测过 26**。635 个测试在 26 上通过是好消息，但不能据此断言原生模块（`node-pty`、`koffi`、`node-addon-system`）在 Desktop 内同样正常。 |
| pnpm | `11.28.5` | `10.34.5` | 本仓库用 npm 构建/测试，pnpm 仅用于 DSH Desktop 自身；差异不影响 G0 结论，但影响"以 Desktop 方式安装插件"的复现。 |
| OS | 上游 CI：ubuntu + windows-latest | Windows 10.0.26100 | 与 `windows-latest` 同族，**Windows 桌面路径已被上游 CI 覆盖一次**，但那次是 `dsh 0.2.1-rc.2` + Node 24。 |

**这三点必须在门禁中体现为风险，而不是被"测试通过"掩盖。**

## 4. 插件装载方式（机制，源码级）

| 机制 | 证据 |
|---|---|
| Host 入口 | `ds-bot/index.js`：`export const name = 'ds-bot'`、`export const inject = ['llm','tools','systemPrompt','sessionController','sessions','sessionTitle','workspaceRegistry','connection']`、`export function apply(ctx, config)` → `createRuntime(ctx, config)` |
| 单一 Runtime | `createRuntime()` 内 `for (const module of MODULES) module.install(rt)`，`MODULES` 共 **29** 项，顺序见 `index.js:44` |
| 客户端入口 | `ds-bot/client.js`（**生成物**）经 `window.__ModuleLoader__.load({ id: 'ds-bot', factory })` 注册；`inject = ['sessions','uiWorkspace','uiConversation','slots','theme','layout']` |
| 打包声明 | `package.json` → `dsh.bundle.patch: ./cordis.patch.yml`、`dsh.client.platform: web` |
| 补丁内容 | `cordis.patch.yml` 以 `insert` 注入两条：`id: bot / name: ds-bot` 与 `id: web-search-auto / name: ds-bot/web-search`；并把 `web.searchProvider` 设为 `auto` |
| HTTP 路由 | `ctx.connection.fetch.register({ path: '/api/bot', methods: ['POST'] })`（`channel.js:347`，`ROUTE` 定义于 `constants.js:22`） |
| 数据目录 | `home = config.home ?? join(dshHome, 'bot')`；`statePath = home/state.json`（`index.js:51-58`） |
