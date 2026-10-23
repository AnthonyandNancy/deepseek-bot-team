# G4 入口

- **状态：G4 自动部分完成**（2026-10-22）。门禁 2/3/4/5 有自动化证据；门禁 1/6 与 T19/T20 待人工。
  见 [`../gates.md`](../gates.md)、[`EVIDENCE-MATRIX.md`](EVIDENCE-MATRIX.md)、[`ROUND-LOG.md`](ROUND-LOG.md)。
- 前置：G3 迁移完成（`gates.md` 18 条自动门禁通过；人工清单待执行）
- **续接指令：[`g4/NEXT-INSTRUCTION.md`](g4/NEXT-INSTRUCTION.md)（可直接整段复制给新会话；自足，不需要打开源仓库）**
- 本文件只写入口与依赖，不含 G4 设计

## G4 目标

Bridge 保持 WSS；Hub 群/成员/邀请/消息持久化；Bot Endpoint 发布；工作群群聊真正可用；本地群「升级为工作群」的幂等关联与原群归档。

本阶段不做：跨用户 Bot 委派与审批（G5）、群记忆的跨用户检索与授权（G6）、单协调者租约 / `round_leases`（G5）、P2P、多 Hub 联邦、移动端、短信 OTP、发版。

## 依赖

- Hub：`BotCode/hub/src/{http,router,ws}.js` 目前只有认证与设备；群与消息表、事件扇出、`seq` 与投递确认都不存在。
- bot 侧：`src/workgroup/host/{channel,groups,hub}.js` 已有端点与回合，但 Hub 端没有群可同步。
- 已完成的 G3 事实：认证为手机号 + 密码，无 OTP；`/v1/auth/otp/*` 不存在也不应存在。

## 必读（全部在本仓库）

1. `BotCode/Workgroup_AI_技术实施方案_2026-10-21.md.md`（技术方案；源基线写法，路径按 `CONVERSION.md` 换算）
2. `../plans/2026-10-22-workgroup-migration.md`（需求与 17 项决策）
3. `diff-manifest.md`（改了哪些文件、哪些原版文件逐字节未动）
4. `gates.md`（已通过的 18 条证据，避免重复劳动）
5. `parity-audit.md`（工作群与原版群聊的复制完整性）
6. `progress-and-gaps.md`（台账与缺口；缺口 1 已闭环，缺口 2 为完整技术拆解文档集）
7. `g4/NEXT-INSTRUCTION.md`（指令正文 + 已定口径）

## 已知阻塞

- **双机实时群聊**：源码级推断与模拟不能代替双电脑验收，AI 只能给双进程模拟，必须由人工判定。
- **观感对照**：工作群与原版群的交互一致性只能人工确认。

## 需要在 G4 重新验证的结论

- G1–G3 的复制结论基于 v0.2.0 快照；G4 若改动 `src/host/{groups,turns,channel}.js`，必须重跑 `workgroup-isolation` 与本地群回归。
- 消息持久化引入后，`hub-offline` 的「未登录本地可用」必须仍然成立。
