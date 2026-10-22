> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/MANUAL-TESTS.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1 人工测试指南（**DSH Desktop 桌面端** · 已核实路径）

> 你是桌面端用户。本文件已按**你机器上的实际安装**核实，不是通用模板。
> 上一版写成 `dsh web` CLI 流程是错的，已作废。

---

## 0. 先纠正我自己的两个错误

| 我之前说的 | 实际情况（已从 `app.asar` 源码核实） |
|---|---|
| "Desktop 的 DSH_HOME 不是你的 `~/.dsh`" | **错。就是 `C:\Users\guojl\.dsh`**（`DSH_HOME` 可覆盖）。Desktop 的 profile 是 `C:\Users\guojl\.dsh\profiles\desktop` |
| 让你跑 `dsh web --port 8792` | 那是我 G0/G1 的临时 bench，不是你的桌面环境 |

截图里两条报错也都是我的遗留，**已修好**：

| 报错 | 原因 | 现状 |
|---|---|---|
| `EADDRINUSE 127.0.0.1:8792` | 我启动的 bench `dsh web` 进程没退（PID 40704） | 已 kill，端口释放 |
| `[slot-probe] host half loaded` | 我做 Slot 探针留下的实验插件（挂在 `home-021` 的 `dependencies` + `cordis.patch.yml`） | 两处都已删，`cordis.patch.yml` 现为 `[]` |

---

## 1. 你的 Desktop 环境（实测）

| 项 | 值 |
|---|---|
| 可执行文件 | `D:\Program Files\DeepSeek Harness Desktop\DeepSeek Harness.exe` |
| 版本 | `0.2.1-rc.2`（Electron 44.7.0，内置 Node 24.21.0 / pnpm 11.28.5） |
| Harness 数据根 | `C:\Users\guojl\.dsh` |
| **Desktop 的 profile** | `C:\Users\guojl\.dsh\profiles\desktop` |
| Electron 缓存/日志 | `%APPDATA%\@deepseek-ai\dsh-desktop`（**不含** Harness 数据） |

**重要**：你的 `profiles\desktop\package.json` 里已有 **10 个 bundle** 和 8 个第三方插件
（`dsh-shell-selector`、`dsh-skills-manager`、多个 `@dsh-presets/*`、`dsh-claude-style` 等），
并且 `~/.dsh` 里有你真实的 `bot\`、`sessions\`、`skills\` 数据。

**所以：不要直接往这个 profile 里装我们的实验插件。请用第 2 节的隔离方式。**

---

## 2. 用隔离的 DSH_HOME 启动 Desktop（推荐，零风险）

这样你真实团队完全不受影响。

### 步骤

1. **完全退出 DSH Desktop**：关窗口后还要在托盘图标上右键退出，确认任务管理器里没有
   `DeepSeek Harness.exe`。

2. 在 PowerShell 里，**同一个窗口**中先设环境变量再启动 exe：

```powershell
$env:DSH_HOME = 'D:\dsh-g1-test'
& "D:\Program Files\DeepSeek Harness Desktop\DeepSeek Harness.exe"
```

3. 首次启动会当成全新环境（空团队，可能要过一遍欢迎/登录引导）。
   **登录可以跳过**——G1 要验证的是 UI 与本地群/工作群的增删改查，不需要模型调用。

4. 现在这个隔离环境的 profile 在 `D:\dsh-g1-test\profiles\desktop`。

---

## 3. 把插件装进这个隔离 profile

### 路线 A（首选）：用 Desktop 自带的 Plugin Manager

已核实：Desktop 插件管理的安装框 **接受「包名 / Git 地址 / tarball / 绝对本地路径」四种输入**，
并且它和 `dsh plugin` 共用同一把 profile 写锁。

1. 在隔离环境里打开 **插件管理**（侧栏插件入口，或 设置 → Plugins）
2. 选"安装"，输入这个**绝对路径**：
   ```
   D:\code\ai\DeepSeek-Bot\ds-bot
   ```
3. 装完 **重启 Desktop**（Host 改动只有重启生效）。

### 路线 B（次选，路线 A 不接受本地路径时）

先备份，再手工加一条 `link:` 依赖。已核实你的 profile 里 `link:` 是受支持的本地路径形式
（现有 `@dsh-presets/*` 全是 `link:C:/Users/guojl/.dsh/.agent-presets/...`）。

> ⚠️ **这一节只在你新建的隔离 profile（`D:\dsh-g1-test\profiles\desktop`）里做。**
> 你真实的 `C:\Users\guojl\.dsh\profiles\desktop` 已有 **10 个 bundle、8 个第三方插件**
> （`dsh-shell-selector`、`dsh-skills-manager`、6 个 `@dsh-presets/*`、`dsh-claude-style` 等），
> 改错会直接影响你日常使用。而且该 profile 与 CLI 共用，不是 Desktop 专属。

1. 先备份：
   ```powershell
   Copy-Item D:\dsh-g1-test\profiles\desktop\package.json `
             D:\dsh-g1-test\profiles\desktop\package.json.bak-g1
   ```
2. 在 `dependencies` 里加一行（注意是**逗号分隔**的 JSON，别漏逗号）：
   ```json
   "ds-bot": "link:D:/code/ai/DeepSeek-Bot/ds-bot"
   ```
3. 在 `dsh.profile.bundles` 数组**末尾追加** `"ds-bot"`，原有条目一个都不要删：
   ```json
   "bundles": [
     "@deepseek-ai/dsh-base",
     "@deepseek-ai/dsh-web-app",
     ...原有条目保持不动...,
     "ds-bot"
   ]
   ```
4. 在该 profile 目录安装依赖：
   ```powershell
   cd D:\dsh-g1-test\profiles\desktop
   & "D:\Program Files\DeepSeek Harness Desktop\resources\runtime\bin\pnpm.cmd" install
   ```
5. 校验 JSON 没写坏：
   ```powershell
   node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('JSON OK')"
   ```
6. 重启 Desktop。

### 路线 C（打包成 tgz，最贴合"从文件安装"）

```powershell
cd D:\code\ai\DeepSeek-Bot\ds-bot
npm pack
# 得到 ds-bot-0.1.7.tgz，用插件管理的"从文件安装"指向它
```

---

## 4. 最关键的检查：`Bot` 一级入口

这是我唯一无法自动验证的点。

| # | 检查 | 期望 | 通过? |
|---|---|---|---|
| 4.1 | 左侧栏展开，**"插件"图标正下方**出现新的 **"Bot"** 图标？ | 有，紧邻插件下方 | ☐ |
| 4.2 | 原"插件"入口**仍在原位**、仍能点开？ | 是，未被替换 | ☐ |
| 4.3 | 原"计划任务"入口在 **Bot 下方**？（插件 `order=0`、Bot `order=5`、计划任务 `order=10`） | 是 | ☐ |
| 4.4 | 悬停显示 tooltip "Bot"？ | 是 | ☐ |
| 4.5 | 点 "Bot"，主区域切到 **Workgroups** 面板？ | 是 | ☐ |
| 4.6 | 收起侧栏（rail）时 Bot 图标仍可见可点？ | 是 | ☐ |

**若 4.1 失败**：`Ctrl+Shift+I` 打开 DevTools，把 Console 里含 `slots` / `panellist` /
`layout.selectPanel` 的报错整段贴我。**不要**自己改 CSS/DOM —— 那会绕过方案禁止的 hack 路线。

> 代码依据（源码级已核实）：
> `sidebar.panellist` 是 `kind:'list'` 的一级导航槽；「插件」入口由 `dsh-client-ui-plugin-manager`
> 用它注册（`id:"plugins"`, `order:0`），「计划任务」是 `order:10`。
> 我们注册 `id:"workgroup-bot"`, `order:5`，并在 `main` 键控槽注册同名面板。

---

## 5. 工作群基本流程（Bot 面板内）

| # | 操作 | 期望 | 通过? |
|---|---|---|---|
| 5.1 | 面板刚开 | 显示 "No workgroups yet."（或已有群列表） | ☐ |
| 5.2 | 输入 `测试工作群` → Create | 列表出现该群 | ☐ |
| 5.3 | 点该群 | 右侧显示群名、"0 members"、空日志、输入框 | ☐ |
| 5.4 | Rename → `财务协作` → 回车 | 列表与标题都更新 | ☐ |
| 5.5 | Rename → 与另一群重名 → 回车 | 显示 already exists 错误，不静默成功 | ☐ |
| 5.6 | 输入消息 → Send（或 Enter） | 消息进日志；**Shift+Enter 换行不发送** | ☐ |
| 5.7 | Stop | 不报错（无运行轮次时是无害 no-op） | ☐ |
| 5.8 | Delete → 确认 | 群消失 | ☐ |
| 5.9 | 关掉再开 Desktop | 之前建的群仍在（持久化生效） | ☐ |

> 5.6 若消息没进日志：DevTools → Network → 找 `api/workgroup`，把请求体与响应贴我。

---

## 6. 本地群"升级为工作群"

| # | 操作 | 期望 | 通过? |
|---|---|---|---|
| 6.1 | 回到原 Bot 界面，**右键一个本地群** | 菜单出现 **"升级为工作群"** | ☐ |
| 6.2 | 点它 | 不报错；Bot 面板出现同名新工作群 | ☐ |
| 6.3 | 检查原本地群 | **类型、成员、历史全部未变** | ☐ |
| 6.4 | 对同一本地群再点一次 | **不会**建第二个群（幂等） | ☐ |
| 6.5 | 检查新工作群历史 | **为空**（旧历史不上传） | ☐ |

> 6.4 / 6.5 是方案 §8.2 硬要求。若出现两个群或历史被带过来 → **P0**，立刻告诉我。
> 隔离环境里没有本地群，需要先原版建一个本地群再测这一节。

---

## 7. 原版回归

| # | 检查 | 期望 | 通过? |
|---|---|---|---|
| 7.1 | Chief 能打开、历史正常 | 是 | ☐ |
| 7.2 | 本地群：创建、改名、@成员、发消息 | 与改动前一致 | ☐ |
| 7.3 | 设置页（Bots / Group chats / Usage / Secrets…） | 都能开，样式无错乱 | ☐ |
| 7.4 | 断网后打开 Desktop | 本地功能仍可用 | ☐ |

---

## 8. 视觉一致性（方案 T19）

| # | 检查 | 期望 | 通过? |
|---|---|---|---|
| 8.1 | 字体/行高/间距/圆角 | 与原有 UI 同族 | ☐ |
| 8.2 | 深色/浅色主题切换 | 两种下都可读、无错位 | ☐ |
| 8.3 | 中文界面下 | "升级为工作群"显示中文 | ☐ |

> **已知缺口（如实标注）**：面板内部文案（"Workgroups"/"Send"/"Stop"/"Rename"/"Delete"）
> 是英文硬编码，未进 `src/client/i18n.js`；面板也**没有专属 CSS**，只复用原版 `bt-*` 类名。
> 若 8.1/8.2 明显不协调，把截图发我，我补样式表与词典（P1，不影响功能）。

---

## 9. 请回传

1. **截图**：侧栏（插件 / Bot / 计划任务 三者的相对位置）、Bot 面板空态、有消息态、右键菜单"升级为工作群"。
2. DevTools Console 完整报错（若有）+ Network 里 `api/workgroup` 的失败请求。
3. 各表勾选结果；未打勾项写一句"实际看到什么"。

---

## 10. 若全部通过

G1 整体转 PASS，进入 **G2（原生 Bot Task Session 与工具级安全 P0）**。
G2 需要真机 + 真实 API key，届时我会再给清单。

## 11. 收尾

```powershell
# 关掉隔离实例：托盘右键退出，或任务管理器结束 DeepSeek Harness.exe
# 隔离数据在 D:\dsh-g1-test，确认没问题后可整个删掉
# 你的真实 C:\Users\guojl\.dsh 全程未被修改
```
