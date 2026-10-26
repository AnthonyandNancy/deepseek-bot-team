# 工作群（BotCode 迁移）实施文档

- 日期：2026-10-22（2026-10-26 更新）
- 水位：**G6 原方案已被否决；G6R 自动化已完成，人工项仍 BLOCKED**。原版群记忆引擎是唯一实现，Hub 只传输 `memory.change`。G4/G5 自动门禁已并入 `main`（`e71119b`）；G4-1/5/6、G4-T20、G5-T12/N3/T14、G6-M1 仍待人工。纠偏计划见 `docs/superpowers/plans/2026-10-24-g6r-copy-first-group-memory.md`，续接指令见 `g6r/NEXT-INSTRUCTION.md`
- 需求：`../plans/2026-10-22-workgroup-migration.md`
- 计划：`../plans/2026-10-22-workgroup-migration-implementation-plan.md`
- 技术方案（源基线原文）：`BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md`（换算规则见 `CONVERSION.md`）

## 阅读顺序

1. `diff-manifest.md` — 改了哪些文件、哪些原版文件逐字节未动
2. `parity-audit.md` — 复制完整性、逐能力对照
3. `gates.md` — 自动门禁跑过什么、结论与证据
4. `manual-checklist.md` — 需要人执行的验收（AI 不自评）
5. `progress-and-gaps.md` — 做到哪、缺什么、为什么
6. `g4-entry.md` → `g4/NEXT-INSTRUCTION.md` — 下一阶段从这里开始
7. `g6r/EVIDENCE-MATRIX.md` — **G6R 当前证据**（自动化已完成；`g6/` 是已被否决的旧方案）
8. `g0/`…`g5/` — 需要追溯历史或原始证据时再读（历史口径，见 `CONVERSION.md`）

## 目录

| 文档 | 内容 |
|---|---|
| `diff-manifest.md` | 新增/修改/未修改文件清单与核对方法 |
| `parity-audit.md` | 工作群与原版群聊的复制完整性、逐能力对照、记忆缺口与修复 |
| `gates.md` | G0–G6 可自动化门禁的结论与证据位置 |
| `manual-checklist.md` | 人工验收步骤与判据 |
| `progress-and-gaps.md` | 进度台账、已知缺口、决定记录 |
| `g4-entry.md` | G4 目标、依赖、必读、阻塞 |
| `g4/NEXT-INSTRUCTION.md` | **G4 续接指令**：可整段复制给新会话 |
| `g4/ROUND-LOG.md` | G4 每轮记录（中断/换人后接续用） |
| `CONVERSION.md` | G0–G3 阶段文档的转换规则、证据口径、与手写文档的关系 |
| `g6r/NEXT-INSTRUCTION.md` | **G6R 纠偏续接指令**：复用原版群记忆引擎，Hub 只做跨机传输 |
| `g6r/DESIGN-COPY-FIRST.md` | G6R 设计与取舍、与 G6 的逐项对比 |
| `g6r/IN-PLACE-CONVERSION.md` | **在 G6 分支上原地改造的续接指令**：保留/删除/改接清单 |
| `g6/NEXT-INSTRUCTION.md` | **已被 G6R 取代**：旧 G6 方案（自建 `group_memories`），仅作反例 |
| `g6/EVIDENCE-MATRIX.md` | **历史**：被否决的 G6 证据（自建 `group_memories`） |
| `g6/ROUND-LOG.md` | **历史**：G6 轮次与计划偏差 |
| `g6/DESIGN-GROUP-MEMORY.md` | **历史**：被否决的 G6 设计 |
| `g0/`…`g5/` | 各阶段记录与证据（历史口径） |
| `DEV-CHECKLIST.md`、`KNOWN-GAPS.md` | 源仓库顶层清单的转换版（历史参考） |

## 说明

本次只交付了最小交接集；需求中设想的完整技术拆解文档集（架构、复制矩阵、契约、安全等 15 份）尚未撰写，已记入缺口。
