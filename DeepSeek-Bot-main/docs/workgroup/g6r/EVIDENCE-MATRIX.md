# G6R 证据矩阵

- 分支：`feat/g6-group-memory`（原地改造；不新建第二条分支）
- 起点：`424ea46`（G6 成果之上做 G6R）
- 状态：**自动化已完成；人工项仍 BLOCKED**。下面的 PASS 只指自动化测试，不代替两台真机的人工验收。
- 自动化口径：产品路径（Hub WSS `memory.change`、插件 `apiHandle` / 原版 `memory-view`、
  两个 `createRuntime` + 真 Hub）。纯函数测试不能替代。

## 1. 设计要点与对应证据

| # | 要证明的事 | 测试文件 | 断言 | 当前 |
|---|---|---|---|---|
| R1 | 原版记忆引擎零行为变化 | `ds-bot/test/memory.test.js` | 原有 59 条既有断言一条未改，全部通过；本文件只追加两个用例 | PASS（自动） |
| R2 | 群写入通知观测者且观测错误不影响写入 | 同文件 | `a write reports what changed to an observer, and an observer failure never changes the write`：add/replace/remove 各通知一次；observer 抛错后仍保存成功 | PASS（自动） |
| R3 | 工作群成员 Session 解析到本机 room | `ds-bot/test/workgroup-memory-room.test.js` | `a workgroup member Session is eligible for a memory review, and the relay is not`：`memoryRoomOf(member) === room.id`，relay 与 undefined 为 `undefined` | PASS（自动） |
| R4 | 成员 Session 提示词含原版群记忆段 | 同文件 | 同文件：`ctx.sections.get('bot-memory').text(...)` 匹配 `## Group memory, shared by the members of this group chat` | PASS（自动） |
| R5 | rt.isBotSession 语义未变 | 同文件 | 同文件：`rt.isBotSession(memberSession.id) === false` | PASS（自动） |
| R6 | 群写入上报为 memory.change | `ds-bot/test/workgroup-memory-sync.test.js` | `a group write becomes one memory.change keyed by the Hub group, not the local room`：frameType、`roomKey === hubWorkgroupId`，以及 op/topic/before/after/actor/at | PASS（自动） |
| R7 | 私聊/团队/本地群不上报 | 同文件 | `private, team and local-group writes are never uploaded`：`sent` 为空；断网写入仍落原版文件 | PASS（自动） |
| R8 | 远端变更走原版写入路径 | 同文件 | `a remote change lands in the original store once, even when the Hub replays it`：`memory-view` 读到条目 | PASS（自动） |
| R9 | 远端变更幂等 | 同文件 | 同文件：第二次返回 `{ changed: false, reason: 'duplicate' }`，条目与 journal 均只有一次 | PASS（自动） |
| R10 | Hub 接受并扇出 memory.change | `hub/test/ws-events.test.js` | `a memory.change fans out on the existing sequence and never counts as unread`：ack.seq 为整数，对端收到同 eventId | PASS（自动） |
| R11 | memory.change 不计未读 | 同文件 | 同文件：前后 `unreadCount` 相等；`EVENT_TYPES` 只含 `memory.change` | PASS（自动） |
| R12 | bridge 分发不写聊天日志 | `ds-bot/test/workgroup-bridge.test.js` | `the ack for a memory change never draws an empty chat line`：`wg.receiveRemote` 调用 0 次，`room.log` 长度不变 | PASS（自动） |
| R13 | ack 不把记忆变更加工成聊天行 | 同文件 | 同文件；临时移除 `isChat` guard 时该断言 RED（2≠0），恢复后 GREEN | PASS（自动） |
| R14 | 删除工作群归档原版记忆 | `ds-bot/test/workgroup-memory-sync.test.js` | `deleting the workgroup archives the original memory folder exactly once`：原目录消失，`archive/group-<roomId>-…` 恰一份 | PASS（自动） |
| R15 | 两机真实传播 | `ds-bot/test-realtime/workgroup-memory-sync.test.js` | `a group entry written with the original remember tool reaches the other machine`：A 原版 `remember`，B 原版 `memory-view` 无手动刷新可见 | PASS（自动） |
| R16 | 离群后不再收到变更 | 同文件 | `a person who leaves stops receiving later group memory changes`：B 本人离群后，A 再写，B 的视图不含新条目 | PASS（自动） |
| R17 | Hub 拒绝非成员或未知组的 memory.change | `hub/test/ws-events.test.js` | `memory.change is refused for a stranger and for a missing group, and writes nothing`：两次 `workgroup/not-found`，events 仍为 0 | PASS（自动） |

## 2. 门禁命令（实施后填写真实输出）

| 命令 | 预期 | 当前 |
|---|---|---|
| `cd hub && npm test` | 全绿 | **PASS** — 270 tests / 270 pass / 0 fail |
| `cd ds-bot && npm test` | 全绿 | **PASS** — 1228 tests / 1227 pass / 1 skip / 0 fail；skip 是 Windows 末尾空格路径用例 |
| `node scripts/build-client.mjs --check` | exit 0 | **PASS** — exit 0 |
| `npm run lint` | 0 error | **PASS** — 0 errors / 13 warnings（均为既有警告） |
| `git diff --name-only main -- ds-bot/src/host` | 只有 `memory.js` | **PASS** — `DeepSeek-Bot-main/ds-bot/src/host/memory.js` |

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
