# G6R 证据矩阵

- 分支：`feat/g6r-group-memory-sync`（待创建）
- 起点：`main` = `1a022df`
- 状态：**未开工**。本文件在实施前只登记“要证明什么、用哪条测试证明”，不写任何 PASS。
- 自动化口径：产品路径（Hub WSS `memory.change`、插件 `apiHandle` / 原版 `memory-view`、
  两个 `createRuntime` + 真 Hub）。纯函数测试不能替代。

## 1. 设计要点与对应证据

| # | 要证明的事 | 测试文件 | 断言（实施后填写精确名称） | 当前 |
|---|---|---|---|---|
| R1 | 原版记忆引擎零行为变化 | `ds-bot/test/memory.test.js` | 既有断言未改，全部通过 | 未开工 |
| R2 | 群写入会通知观测者，且观测者抛错不影响写入 | `ds-bot/test/memory.test.js` | 新用例：`seen.length === 1`；抛错后仍 `Saved to your memory` | 未开工 |
| R3 | 工作群成员 Session 解析到本机群 room | `ds-bot/test/workgroup-memory-room.test.js` | `rt.memoryRoomOf(memberSession.id) === room.id`；relay 为 `undefined` | 未开工 |
| R4 | 工作群成员 Session 的提示词含群记忆段 | 同上 | `ctx.sections.get('bot-memory').text(...)` 匹配 `## Group memory` | 未开工 |
| R5 | `rt.isBotSession` 语义未变 | 同上 | `rt.isBotSession(memberSession.id) === false` | 未开工 |
| R6 | 群记忆写入会上报为 `memory.change` | `ds-bot/test/workgroup-memory-sync.test.js` | `sent[0].frameType === 'memory.change'`；`payload.roomKey === hubWorkgroupId` | 未开工 |
| R7 | 私聊、团队、本地群写入不上报 | 同上 | `assert.deepEqual(sent, [])` | 未开工 |
| R8 | 远端变更走原版写入路径 | 同上 | `rt.memoryEndpoint('memory-view', { roomId })` 能读到该条目 | 未开工 |
| R9 | 远端变更幂等 | 同上 | 第二次 `applyRemoteMemoryChange` 返回 `{ changed: false, reason: 'duplicate' }` | 未开工 |
| R10 | Hub 接受 `memory.change` 并扇出 | `hub/test/ws-events.test.js` | 发送方 `ack.ok` 带 `seq`；接收方收到同 `eventId` 的 `event` | 未开工 |
| R11 | `memory.change` 不计未读 | 同上 | 前后 `unreadCount` 相等 | 未开工 |
| R12 | bridge 分发不写聊天日志 | `ds-bot/test/workgroup-bridge.test.js` | `wg.onMemoryEvent` 收到一次；`room.log.length` 不变 | 未开工 |
| R13 | ack 不把记忆变更加工成聊天行 | 同上 | 发送方 `room.log.length` 不变 | 未开工 |
| R14 | 删除工作群归档原版记忆 | `ds-bot/test/workgroup-memory-sync.test.js` | `memory/groups/<roomId>` 消失；`memory/archive/group-<roomId>-…` 出现一次 | 未开工 |
| R15 | 两机真实传播 | `ds-bot/test-realtime/workgroup-memory-sync.test.js` | B 的 `memory-view` 出现 A 写的条目 | 未开工 |
| R16 | 离群后不再收到变更 | 同上 | B 的视图不含离群后 A 写的条目 | 未开工 |

## 2. 门禁命令（实施后填写真实输出）

| 命令 | 预期 | 当前 |
|---|---|---|
| `cd hub && npm test` | 全绿 | 未开工 |
| `cd ds-bot && npm test` | 全绿 | 未开工 |
| `node scripts/build-client.mjs --check` | exit 0 | 未开工 |
| `npm run lint` | 0 error | 未开工 |
| `git diff --name-only main -- ds-bot/src/host` | 只有 `memory.js` | 未开工 |

## 3. 人工项（保持 BLOCKED）

| 编号 | 项 | 状态 | 步骤 |
|---|---|---|---|
| G6-M1 | 两台真机读同一份群记忆，离群后不可读 | **BLOCKED** | `manual-checklist.md` G6-M1 |
| G4-1 | 两台真机实时群聊 | **BLOCKED** | `manual-checklist.md` |
| G4-5 | Bot 入口目视 | **BLOCKED** | 同上 |
| G4-6 | 工作群与原版观感对照 | **BLOCKED** | 同上 |
| G4-T20 | Windows/macOS Electron 冷启动 | **BLOCKED** | 同上 |
| G5-T12 | B 机器真实执行 | **BLOCKED** | 同上 |
| G5-N3 | 审批卡视觉对照 | **BLOCKED** | 同上 |
| G5-T14 | 真符号链接越界 | **BLOCKED** | 同上 |

> 自动化替身不等于双机验收。本文件在任何时候都不把人工项写成 PASS。
