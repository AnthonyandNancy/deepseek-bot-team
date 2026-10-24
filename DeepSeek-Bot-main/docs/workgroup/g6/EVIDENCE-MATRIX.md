# G6 证据矩阵

- 分支：`feat/g6-group-memory`
- 自动化证据口径：产品路径（Hub HTTP/WSS、插件 `apiHandle`、两 `createRuntime` + 真 Hub）；
  纯 schema/迁移测试直接开真实临时数据库。
- 人工项：未由维护者执行，统一写 **BLOCKED**，不写 PASS。

## 1. §14 G6 门禁

| 门禁 | 判定 | 证据 |
|---|---|---|
| V1 群记忆可用且与私人记忆隔离 | **通过（自动）** | 群条目经 Hub `group_memories` 读写：`hub/test/group-memory.test.js`「a non-member cannot read or search…」「group memory search never returns another group or a local private/team marker」；本地视图隔离：`ds-bot/test/workgroup-memory-isolation.test.js`「group memory is not mixed into a Bot view…」；投影持久化且不作为权威：同文件「the memory projection survives a local state reload and is never the authority」 |
| 断网重启不泄漏、不乱序、不误恢复 | **通过（自动）** | 同库重开：`hub/test/group-memory.test.js`「the same memory is readable after reopening the same database file…」；重放同一 `memory.created`：同文件「replaying the same memory.created event does not create a second entry」；离群后 list/search 404：同文件「a member who left stops reading and searching immediately」；`seq` 无洞与事件重放：既有 `hub/test/ws-events.test.js`，G6 事件类型断言「the four memory events are accepted by the closed set but never counted as readable」 |
| 关键安全用例通过 | **通过（自动）** | 非成员/ACL 外/旧版本/删除审计/凭据样式：`hub/test/group-memory.test.js` 的 ACL、`stale`、`deleted`、`credential-shaped` 用例；`memory-correct` 缺版本：`ds-bot/test-realtime/workgroup-memory.test.js`「the five memory endpoints…」 |
| 代码/测试/迁移/配置只在两个目录 | **通过（结构）** | 所有 G6 改动在 `hub/` 与 `ds-bot/`；无新增一级目录；无新增运行时依赖；迁移 v8 仅用 `node:sqlite` FTS5 |
| 最终验收报告 | **本文件** | 每行指向测试文件与断言；人工项 BLOCKED |

## 2. T18 子项

| 子项 | 必须观察到 | 测试与断言 |
|---|---|---|
| 按角色/成员读 | 成员在 ACL 内可 list/search；ACL 外成员得到空列表 | `hub/test/group-memory.test.js`「a non-member cannot read or search…」：`ownerList` 含条目，`bobList`/`bobSearch` 深等于 `[]` |
| 非成员不可读写 | 外部账号 list/search 404，不能探测群 id | 同上：`outsider.status === 404`、`error.code === 'workgroup/not-found'`；`outsiderSearch` 同 |
| 离群即时失效 | 离群后 list 与 search 都 404 | `hub/test/group-memory.test.js`「a member who left stops reading and searching immediately」：`list.status === 404`、`search.status === 404`；重启后再次离群同样拒绝在同文件「the same memory is readable after reopening…」 |
| 修正与版本 | 旧 `expectedVersion` 被 409 拒绝，不覆盖新内容 | 同文件「a correction based on an old version is refused and changes nothing」：`stale.status === 409`、`memory/version-conflict`、list 仍是 v2 内容；审计 `[['created',1],['corrected',2]]` |
| 删除与来源完整 | 软删除后 list/search 为空，审计行与版本保留 | 同文件「a deleted memory disappears from search but keeps its audit row and version」：`found.body.memories` 深等于 `[]`、`deleted_at !== null`、审计 `[['created',1],['deleted',2]]` |
| 来源引用 | `sourceRefs` 的消息必须属于同群 | 同文件「credential-shaped content is refused and source refs must point into this group」：越界消息 400 `memory/source-not-in-group` |
| 凭据样式 | 疑似凭据内容被拒 | 同上：`memory/credential-like` |
| 群删除 | Hub 群删除后条目与审计级联消失，成员再读 404 | `hub/test/group-memory.test.js`「group deletion removes the Hub memory and audit rows…」：两表 count 为 0，GET 404 |
| 重启恢复 | 同一 DB 文件重开后条目、检索、离群拒绝仍正确 | `hub/test/group-memory.test.js`「the same memory is readable after reopening the same database file…」：Bob list 含 `memoryId`、search 命中、离群后两读均 404 |
| 重放幂等 | 同一幂等键不产生第二条 | 同文件「replaying the same memory.created event does not create a second entry」：第二次 200 + `duplicate: true`，行数与审计行数均为 1 |
| 跨机事件 | 一台机器创建/修正/删除，另一台投影自动重读 | `ds-bot/test-realtime/workgroup-memory.test.js`「a memory created on one machine…」：Bob 缓存出现 `memoryId`；「a correction and a deletion…」：Bob 版本 2，删除后 Alice 缓存无该条 |
| 回顾触发 | 成员 Session 可被回顾，relay 不可 | `ds-bot/test/workgroup-memory-review.test.js`「a workgroup member Session is eligible…」：`memoryRoomOf(memberSession.id)` 等于 room id，`memoryRoomOf(room.id)` 为 undefined，`rt.isBotSession` 仍 false |
| 删除归档 | 删除工作群调用本地记忆归档 | 同文件「deleting a workgroup archives its local memory…」：`archived === [room.id]`，本地记录已删除 |
| UI 读写 | 五个 `memory-*` 都走 `callWorkgroup`，写后重读，不本地合并；feed 触发重读 | `ds-bot/test/workgroup-ux.test.js`「the workgroup settings form lists, searches, adds, corrects and deletes…」：五个端点包含断言、`expectedVersion`、`await readMemories()`、无 `setMemories([...memories`；「a memory signal…」：`kind === 'memory'` |

## 3. 门禁命令

| 命令 | 当前结果 |
|---|---|
| `cd hub && npm test` | 283 tests / 283 pass / 0 fail |
| `cd ds-bot && npm test` | 1224 tests / 1223 pass / 1 skip / 0 fail / exit 0 |
| `node scripts/build-client.mjs --check` | exit 0 |
| `npm run lint` | 0 error / 13 warning |
| `git diff --name-only e71119b -- ds-bot/src/host` | 仅 `memory.js`（允许的回顾接缝）；`groups/turns/delivery/resume/constants.js` 空 |

## 4. 人工项（全部 BLOCKED）

| 编号 | 项 | 状态 | 步骤位置 |
|---|---|---|---|
| G4-1 | 两台真机实时群聊 | **BLOCKED** | `manual-checklist.md` G4-1 |
| G4-5 | Bot 入口目视 | **BLOCKED** | 同上 G4-5 |
| G4-6 | 工作群与原版观感对照 | **BLOCKED** | 同上 G4-6 |
| G4-T20 | Windows/macOS Electron 冷启动 | **BLOCKED** | 同上 G4-T20 |
| G5-T12 | B 机器真实执行 | **BLOCKED** | 同上 G5-T12 |
| G5-N3 | 审批卡视觉对照 | **BLOCKED** | 同上 G5-N3 |
| G5-T14 | 真符号链接越界 | **BLOCKED** | 同上 G5-T14 |
| G6-M1 | 两台真机读同一群记忆，离群后不可读 | **BLOCKED** | 同上 G6-M1（本轮新增） |

> 本文件不把任何人工项写成 PASS。自动化替身不等于双机验收。
