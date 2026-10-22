# G0：环境、锁版、完整源码审计（迁移前提）

本目录由源仓库 `Workgroup-AI/bot-plugin/docs/g0/` 全量转换而来（2026-10-22），共 6 份。

- 每份文档顶部有来源、基线与证据口径说明。
- 文中的「通过 / 数字 / 日志」是**源仓库当时**的结果；本仓库的重跑结论见 [`../gates.md`](../gates.md)。
- 路径已按本仓库改写：`bot-plugin/` → `ds-bot/`，`docs/g0/` → `docs/workgroup/g0/`。

| 文档 | 标题 |
|---|---|
| [`G0-REPORT.md`](G0-REPORT.md) | G0 执行报告：环境、锁版、完整源码审计 |
| [`g1-plan.md`](g1-plan.md) | G1 规划：最小代码变更 + 可执行回归测试 |
| [`gates.md`](gates.md) | G0 Verification Gates — ds-bot v0.1.7 fork (`ds-bot/`) |
| [`reference-classification.md`](reference-classification.md) | G0 引用点分类表（方案 §5.4 强制产物） |
| [`source-audit.md`](source-audit.md) | G0 源码审计：groups.js 依赖 / 注册 / 复制范围 |
| [`version-lock.md`](version-lock.md) | G0 版本锁与来源证据（Version lock / provenance） |
