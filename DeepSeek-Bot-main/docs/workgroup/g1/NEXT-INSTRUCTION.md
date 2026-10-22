> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/NEXT-INSTRUCTION.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# 下一条执行指令（G1-R v2）

> 用途：把下面「指令正文」整段复制，作为下一轮的启动指令。
> 任务正文在 `TASK-G1R.md`，本文件只交代上下文与纪律。

---

## 指令正文（复制以下全部内容）

```
继续本仓库工作。先完整阅读：
  - docs/workgroup/g1/TASK-G1R.md   （任务正文，5 个任务）
  - docs/workgroup/g1/G1-REPORT.md  （上一阶段状态）

## 已确认的事实（不要重复验证，不要推翻）

1. 仓库只有两个一级代码目录：hub/ 与 ds-bot/。hub/ 仍是骨架，本任务不碰。
2. ds-bot/ = Fei2411/DeepSeek-Bot ds-bot v0.1.7 完整 Fork
   （commit 939a6635830cb5b246e7dd19c67b0e1352ad1c07）。
3. G1 主机侧已完成：src/workgroup/ 独立状态/归属/串行轮次/stop/resume//api/workgroup 路由。
4. **sidebar.panellist 接缝已证实可行**：真实 DSH Desktop 0.2.1-rc.2 里
   「插件 / Bot / 自动化任务」三个入口并存，Bot 在插件正下方（order=5 生效）。
   —— 不要再怀疑 Slot 接缝，也不要再改 order。
5. 测试基线：npm test = 664 passed / 0 failed。
6. client.js 是构建产物。改动 src/client/** 或 src/workgroup/client/** 后**必须**重建。
   上一轮就是漏了这一步，让用户在真实环境测了旧 bundle。
7. 工作群升级已能工作：C:\Users\guojl\.dsh\bot\workgroup\state.json 里已有真实记录。

## 本任务只做 TASK-G1R.md 里的 5 件事，按此顺序

T4 → T5 → T1 → T2 → T3

### T4（P0，最重要）：点 Bot 进去是"假的"
用户原话：「差点上方这个入口，进去是假的」。
已核实根因方向（源码级，供你起步，但你要自己再确认一遍）：
  dsh-client-ui-layout lib/client.js:118-120
    MainPanel => renderSlot("main", {}, { entryKey: usePanelInfo(i => i.activePanelId) ?? "conversation" })
  lib/client.js:468-471  selectPanel 对未注册的 key 会 THROW
  ds-bot 在 Bot 模式接管 shell/conversation 两组并整格替换 sidebar.workspaces，
  但**从未注册 main**。
所以点 Bot 只改了 activePanelId，中间栏并没有换成我们的面板。
要求：真正进入可用面板；能来回切换不陷入死路；再次点 Bot 回到上次状态且不报错；
不得用 DOM/CSS hack 伪装。
**如果这个 DSH 版本的 main 槽承载不了非会话面板，就诚实报 BLOCKED 并给日志证据，
不要静默换实现然后声称完成。**

### T5（P0）：新建菜单缺「新建工作群」
用户原话：「需要在图二的这个创建群聊下方有一个创建工作群的选项」。
已核实：src/client/new-chat.js:95-103 只 push 了
  Create new Bot / Create group chat / Add DSH Agent
确认没有工作群项。要求插在「新建群聊」正下方（不是菜单末尾），可用、有可见反馈、
带 i18n 词条（该文件在 test/i18n.test.js 扫描范围内）。
G1 阶段只本地落库，不联网、不要求 Hub 登录，但菜单项不因未登录而消失。

### T1（P1）：工作群与普通群聊要有视觉区别
用户原话：「工作群需要有标识区别下与普通群聊的」。
三处标识（列表行/面板标题/升级来源）；不能只靠颜色；aria-label；沿用 bt-* 类名。

### T2：npm run lint 裸跑是坏的
scripts/lint.mjs 把字面目录 dev 传给 oxlint，递归进 dev/harness/node_modules，
20745 个第三方错误。修扫描范围，不是放宽规则。
**必须额外证明门禁仍有效**：故意写 no-undef 违规 → 确认仍报错退出 1 → 撤销。
只变绿但规则失效，不算通过。

### T3：把"改 client 源码后必须 build"固化成流程
新增 docs/DEV-CHECKLIST.md + 一条收尾命令（build/--check/test/lint 一起跑）。
不新增 npm 依赖。

## 纪律（不放松）

- 先复制/复用，再改造；不重写原版群业务逻辑。
- 一个原生 DS Bot Runtime；不重复安装、不注册同名工具。
- 工作群与本地群数据/Session/Waiter/记忆严格隔离。
- 不新增第三个一级目录；不把工作群放进 DSH 一级侧栏。
- 不引入新主题/新色板；不改消息气泡与输入框视觉。
- 不动 Hub 代码。
- 任何"完成"必须有真实命令输出；拿不到证据就报 BLOCKED，不要说"应该可以"。
- 改完 client 源码必须重建 client.js 并跑 --check。

## 收尾必须给出

1. 变更摘要（做了什么、没做什么、风险）
2. 源文件清单（改动文件+原因；关键未改动文件也列出作为负向证据）
3. 命令与真实输出：npm run build、--check、npm test、**npm run lint 裸跑**
4. T2-b 证据：故意违规 → 门禁报错 → 撤销（三步都要贴输出）
5. T4 若 BLOCKED：日志/源码证据 + 最小替代方案 + 对架构的影响
6. 遗留问题（P0/P1/P2）
7. 人工测试清单：让用户在真实 Desktop 验收
   - 点 Bot 能进面板、能切回 Chief
   - 新建菜单里有「新建工作群」，能建成并跳转
   - 本地群与工作群同屏可分辨（要截图）

## 停止点

T4/T5/T1/T2/T3 全部满足 TASK-G1R.md 的完成判据后停止，交人工验收。
**不要**在此之前开始 G2（G2 需要真机 + 真实 API key）。
```

---

## 给用户的一句话摘要

Bot 图标已经对了（在插件正下方）。现在缺的是**点进去之后没有真正的内容页**、
以及**新建菜单里没有「新建工作群」**。这两条已作为 P0 写入任务书，
连同工作群视觉标识（P1）和我自查的两个流程缺陷，一共 5 项，按依赖顺序排好了。
