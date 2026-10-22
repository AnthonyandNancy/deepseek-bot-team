# G1：工作群代码复制与单机双群共存（含 16 轮修复记录）

本目录由源仓库 `Workgroup-AI/bot-plugin/docs/g1/` 全量转换而来（2026-10-22），共 26 份。

- 每份文档顶部有来源、基线与证据口径说明。
- 文中的「通过 / 数字 / 日志」是**源仓库当时**的结果；本仓库的重跑结论见 [`../gates.md`](../gates.md)。
- 路径已按本仓库改写：`bot-plugin/` → `ds-bot/`，`docs/g1/` → `docs/workgroup/g1/`。

| 文档 | 标题 |
|---|---|
| [`G1-GATE-AUDIT.md`](G1-GATE-AUDIT.md) | G1 门禁核查（回应"确认 G1 任务是否全部完成"） |
| [`G1-REPORT.md`](G1-REPORT.md) | G1 执行报告：工作群代码复制与单机双群共存 |
| [`G1R-REPORT.md`](G1R-REPORT.md) | G1-R 执行报告：Bot 面板可达 + 新建工作群 + 视觉标识 |
| [`G1R10-REPORT.md`](G1R10-REPORT.md) | G1R10：为什么「从菜单创建工作群仍进不去」—— 运行时仍是旧代码 |
| [`G1R11-REPORT.md`](G1R11-REPORT.md) | G1R11：先核对「是否完整复制原版群聊」，再修 bug |
| [`G1R12-REPORT.md`](G1R12-REPORT.md) | G1R12：成员被要求「保持沉默」—— 工作群对话无回复的根因 |
| [`G1R13-REPORT.md`](G1R13-REPORT.md) | G1R13 — 工作群"没有初始化、@bot 和对话没回复"的真正根因与完整复制 |
| [`G1R14-REPORT.md`](G1R14-REPORT.md) | G1R14 — 成员 Session 被 relay 钩子截获（"@bot 和对话没回复"的真正根因） |
| [`G1R15-CLOSURE-AUDIT.md`](G1R15-CLOSURE-AUDIT.md) | G1 闭环审计（G1R15 · 历史） |
| [`G1R16-CLOSURE-AUDIT.md`](G1R16-CLOSURE-AUDIT.md) | G1 闭环审计（G1R16 · 收口） |
| [`G1R2-REPORT.md`](G1R2-REPORT.md) | G1-R2：「Bot」进入 DS Bot 本体 + 新建工作群可选机器人 |
| [`G1R3-REPORT.md`](G1R3-REPORT.md) | G1-R3：新建工作群改用原版选人功能 |
| [`G1R4-REPORT.md`](G1R4-REPORT.md) | G1-R4：菜单创建的工作群没有标识 —— 根因与修复 |
| [`G1R5-REPORT.md`](G1R5-REPORT.md) | G1-R5：六项需求实现 |
| [`G1R6-REPORT.md`](G1R6-REPORT.md) | G1-R6：相同机器人仍报 already exists —— 真正的根因 |
| [`G1R7-REPORT.md`](G1R7-REPORT.md) | G1-R7：工作群创建后无法打开 —— 根因与修复 |
| [`G1R8-REPORT.md`](G1R8-REPORT.md) | G1-R8：创建后仍打不开 —— 旧数据迁移 |
| [`G1R9-REPORT.md`](G1R9-REPORT.md) | G1R9：工作群聊进不去 / 进去是空的 —— 补齐原版群聊的三处机制 |
| [`INCIDENT-install-failure.md`](INCIDENT-install-failure.md) | 插件安装失败事件记录（Desktop 无法启动） |
| [`MANUAL-TESTS.md`](MANUAL-TESTS.md) | G1 人工测试指南（**DSH Desktop 桌面端** · 已核实路径） |
| [`NEXT-INSTRUCTION.md`](NEXT-INSTRUCTION.md) | 下一条执行指令（G1-R v2） |
| [`T4-ROOT-CAUSE.md`](T4-ROOT-CAUSE.md) | T4：「点 Bot 进去是假的」根因与修复 |
| [`TASK-G1R.md`](TASK-G1R.md) | G1-R 任务书（v2）：工作群可创建 + Bot 入口可达 + 视觉标识 |
| [`diff-manifest.md`](diff-manifest.md) | G1 差异清单（diff-manifest） |
| [`failure-01-rt-key.md`](failure-01-rt-key.md) | G1 首次运行失败记录（真实的 bug，非设计变更） |
| [`slot-probe.md`](slot-probe.md) | G1-A Slot 探针：最终结论（V1/V2/V3 全部有答案） |
