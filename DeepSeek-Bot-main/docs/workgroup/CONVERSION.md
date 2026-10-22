# 阶段文档转换记录（G0–G3 全量）

- 日期：2026-10-22
- 来源：`Workgroup-AI/bot-plugin/docs/`（g0 6 份、g1 26 份、g2 3 份、g3 4 份，另加顶层 `DEV-CHECKLIST.md`、`KNOWN-GAPS.md`）
- 目标：`docs/workgroup/`（同名阶段目录，共 **41 份**，合计约 7,400 行）

## 改写规则

| 原 | 现 | 说明 |
|---|---|---|
| `bot-plugin/`、`bot-plugin` | `ds-bot/`、`ds-bot` | 本仓库的插件目录名 |
| `docs/g0/` … `docs/g3/` | `docs/workgroup/g0/` … `docs/workgroup/g3/` | 文档位置 |
| `Workgroup_AI_技术实施方案_2026-10-21.md.md` | `docs/plans/2026-10-22-workgroup-migration.md` | 本仓库的需求文档 |
| `.g0-work/upstream/ds-bot/` | `BotCode/DeepSeek-Bot-main.zip` 解压出的快照 | 基准快照的获取方式 |
| DSH `0.2.0-rc.2` | DSH `0.2.1-rc.2` | 本仓库锁定的 DSH 版本 |
| `v0.1.7` / `939a663` | **保留原样** | 它是源仓库的历史事实，不能改写成 v0.2.0 |

每份文件顶部统一加了 5 行说明：来源、源基线 / 本仓库基线、证据口径、路径改写、Hub 位置。

## 证据口径（重要）

- 文中「通过 / 已验证 / 耗时 / 匹配数」是**源仓库在 v0.1.7 基线上**的结果，不是本仓库的重跑结果。
- 本仓库的重跑结论只有一处权威来源：`gates.md`（自动门禁）与 `manual-checklist.md`（人工）。
- 转换**没有**逐条重跑源文档里的每个数字；凡是「源仓库说通过、本仓库没重跑」的，以 `progress-and-gaps.md` 的缺口表为准。

## 与手写文档的关系

| 手写文档 | 与原文档的关系 |
|---|---|
| `diff-manifest.md` | 重写版：记录**本仓库**相对 v0.2.0 快照的增删改与逐字节未改清单。`g1/diff-manifest.md` 是**源仓库**当年的版本，仅作历史记录。 |
| `gates.md` | 本仓库重跑的 18 条自动门禁；取代 `g0/gates.md`、`g1/G1-GATE-AUDIT.md`、`g2/G2-CLOSURE-AUDIT.md`、`g3/G3-CLOSURE-AUDIT.md` 作为**当前有效**结论。 |
| `manual-checklist.md` | 本仓库的人工验收清单；源 `g1/MANUAL-TESTS.md`、`g2/MANUAL-VERIFICATION.md`、`g3/MANUAL-VERIFICATION.md` 保留为历史步骤参考。 |
| `progress-and-gaps.md` | 本仓库台账与缺口；`KNOWN-GAPS.md` 是源仓库当年的缺口表。 |
| `parity-audit.md` | 新增：工作群与原版群聊的复制完整性对照，源仓库没有这份。 |

## 未转换的内容

- 源 `docs/g0/logs/`、`docs/g0/scans/`、`docs/g1/logs/` 等日志与扫描原始产物（体积大、且绑定源仓库环境）。需要时可从源仓库取。
- 源仓库根目录的技术实施方案（18 节）：已**原样复制**到 `BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md`（与源文件逐字节相同，未改写路径与版本）。读它时按本文的「改写规则」换算；它与需求文档、`parity-audit.md` 的分工是：方案讲怎么做，需求讲做到什么程度，审计讲复制得全不全。

## 目录

| 阶段 | 目录 | 份数 | 内容 |
|---|---|---|---|
| G0 | [`g0/`](g0/README.md) | 6 | 环境、锁版、源码审计、引用分类 |
| G1 | [`g1/`](g1/README.md) | 26 | 复制与双群共存、16 轮修复、门禁审计、槽位探测、事故复盘 |
| G2 | [`g2/`](g2/README.md) | 3 | Task Session、工具级安全 P0 |
| G3 | [`g3/`](g3/README.md) | 4 | Hub 账号、设备、认证与收口 |
| 顶层 | `DEV-CHECKLIST.md`、`KNOWN-GAPS.md` | 2 | 源仓库的开发检查清单与缺口表 |
