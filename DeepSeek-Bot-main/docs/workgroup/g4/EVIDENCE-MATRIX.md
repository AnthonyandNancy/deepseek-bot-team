# G4 验收矩阵证据（§15 中与 G4 相关的用例）

- 日期：2026-10-22
- 环境：Windows 11，Node v26.7.0，DSH `0.2.1-rc.2`，`ds-bot@0.2.0`（未改版本号，未发版），Hub 同工作副本
- 证据口径：**自动化结论不等于双机验收**。凡是自动化跑的，都写明跑的是什么；凡是只能人工的，写 **BLOCKED** 并给出步骤。

| 编号 | 场景 | 结论 | 证据 |
|---|---|---|---|
| T08 | 双机聊天、附件、成员邀请 | **自动部分通过；双机部分 BLOCKED** | 见下 |
| T09 | Hub/Bridge 断电重启 | **通过（自动化）** | 见下 |
| T10 | 本地群升级，失败重试 | **通过（自动化）** | 见下 |
| T19 | Bot UI 与原版视觉对照 | **BLOCKED（只能人工）** | `manual-checklist.md` G4-6 |
| T20 | Windows/macOS Electron 冷启动 | **BLOCKED（只能人工）** | `manual-checklist.md` G4-T20 |

---

## T08 双机聊天、附件、成员邀请

### 自动化跑到的部分

| 步骤 | 期待 | 实际 | 结论 |
|---|---|---|---|
| A、B 两个账号各注册一台设备，A 建群、A 邀请 B、B 接受 | 两台都在群里 | `hub/test/ws-events.test.js`、`ds-bot/test/workgroup-bridge.test.js` 均断言通过 | PASS |
| A 通过 socket 发一条 | B 收到同一 `eventId` 与同一 `seq`；A 不收到自己的回显 | 断言 `received.event.eventId === sent.eventId`、`seq` 相同、`a.all('event').length === 0` | PASS |
| A 上传 PNG，B 取票据下载 | 字节完全一致（sha256 比对） | `hub/test/attachments.test.js`：`createHash('sha256')` 比对 + `content-type`/`nosniff`/`content-disposition` 校验 | PASS |
| 非成员上传/列表/取票据 | 一律 404 | 三项分别断言 | PASS |
| 成员离群后仍持未过期票据 | 下载 404 | 断言通过 | PASS |
| 附件事件里不含磁盘路径 | 只有 `attachmentId/name/mime/size/sha256/createdAt/expiresAt/workgroupId` | 逐键 `deepEqual` + 字符串里不含 `storage_key` | PASS |
| 邀请一个不存在的手机号 | 404 `workgroup/invitee-unknown` | `workgroup-g4-api.test.js` 断言 | PASS |
| 邀请返回只含打码手机号 | `+86****9000`，不含全号 | 断言 `includes('13900139000') === false` | PASS |
| 同群同人重复邀请 | 409（partial unique index） | `db-g4-schema.test.js` + 服务层 | PASS |

### 必须人工的部分（BLOCKED）

- 两台**真实机器**上的实时聊天与附件往返。
- 步骤与判据：`manual-checklist.md` G4-1 第 1–6 步。
- 为什么自动化不能代替：替身是同一台机器上的两个进程，共享同一个内核时钟与文件系统；真机的时钟偏差、NAT、防火墙、休眠唤醒、TLS 证书信任都只有真机才会暴露。

---

## T09 Hub/Bridge 断电重启

| 步骤 | 期待 | 实际（自动化） | 结论 |
|---|---|---|---|
| B 的 socket 收到事件但不 ack，然后断开（模拟断电） | 新 socket 从同一游标再拉，事件仍在 | `a unacknowledged event is replayed even though it was already delivered`：`again.events.map(id) === [first.eventId]` | PASS |
| B ack 后从 `afterSeq = seq` 再拉 | 返回空 | 同一用例断言 `empty.events` 为 `[]` | PASS |
| 同一 `eventId` ack 两次 | `deliveries` 仍 1 行、`ack_at` 不变 | `a replayed ack is harmless…`：`SELECT count(*)` 为 1 | PASS |
| 同一 `eventId` **重发**（ack 丢失后客户端重试） | `duplicate: true`、seq 不变、Hub 只 1 行、接收方只 1 条 | `a resent event keeps its original seq…` | PASS |
| 插件进程重启（`bridge.reset()` 丢掉内存游标与 seen 集合）后重拉全量 | 本机日志行数不变 | `a redelivered event is applied once…`：`countLines()` 仍为 1（去重靠日志行 `hubEventId`） | PASS |
| 插件断 socket 期间发消息 | 入队（`pending=1`），重连后用**同一** `eventId` 补发，Hub 侧 1 条 | `a message queued while offline is sent on reconnect…` | PASS |
| 两个发送方各 5 条并发 | seq 恰为 1..10，无重无洞 | `seq is per group and strictly increasing…`：`deepEqual(seqs, [1..10])` | PASS |
| 乱序：客户端只落后中间一段 | 只返回缺失的两条 | `a client that missed the middle…`：`[second.seq, third.seq]` | PASS |
| 长追赶分页 | `hasMore: true`，跟游标取完不重不漏 | `a long catch-up is paged…`：`seen === [1,2,3,4]` | PASS |

**说明**：以上是「Hub 与 Bridge 都重启」的**逻辑等价**（进程内状态被清空、连接被关闭、按游标重建）。**真实断电**（操作系统级进程被杀、SQLite WAL 未落盘）需要人工在真机执行；SQLite 的 `synchronous = NORMAL` + WAL 由 `db-migrate.test.js` 断言配置，但「断电后数据完好」本身没有自动化证据 —— 这一条记在 `manual-checklist.md` 的人工项里，不算 PASS。

---

## T10 本地群升级，失败重试

| 步骤 | 期待 | 实际（自动化） | 结论 |
|---|---|---|---|
| 升级一个有两行历史的本地群 | 四态齐全、原群保留、Hub 侧 0 事件 | `workgroup-upgrade.test.js`：`states === ['PREPARING','HUB_CREATED','LOCAL_LINKED','ACTIVE']`；`local.log.length === 2`；Hub `events.length === 0`、`last_seq === 0` | PASS |
| 同一升级重试 10 次 | Hub 1 个群、本地 1 条 link、9 次 `alreadyUpgraded` | 断言 `count(workgroups) === 1`、`Object.keys(links).length === 1` | PASS |
| 三个对话框同时点（并发） | 仍 1 个群、1 条 link、同一 id | 断言通过 | PASS |
| Hub 拒绝时（`PREPARING` 失败） | 停在 `PREPARING`、提示可安全重试、Hub 0 群；重试后 `created: true` | 断言通过 | PASS |
| 群已建但本地写入失败（`HUB_CREATED` 失败） | 停在 `HUB_CREATED`；重试 `created: false`、仍 1 个群 | 断言通过 | PASS |
| 升级请求体 | 恰为 `{name, notice, upgradeId}`，不含正文/路径/本地 id | `Object.keys().sort()` 断言 + 字符串不含 `finance`/roomId/`log`/`messages` | PASS |
| 升级后原群 | 仍在 `state.rooms`、日志完整、标记为 archived | `rt.roomOf(local.id) !== undefined`、`log.length === 2`、`isArchived === true` | PASS |

---

## G4 修补轮（2026-10-25）：协调者重启与设置版本

这两项属于 G4 已交付范围的可靠性缺口，不是新阶段。

| 步骤 | 期待 | 实际（自动化） | 结论 |
|---|---|---|---|
| 远端调用已发出，协调者进程被替换 | 远端槽位仍以开放义务存在，exchange 不变 | `ds-bot/test-realtime/workgroup-realtime.test.js` → `a remote slot survives a coordinator restart as an open obligation`：真实 relay + 同 home 新 runtime，`roundOf(...).state === 'open'`，槽位 exchange 保留 | PASS |
| 进程在「调用已可被 Hub 看到」与「本地记录 exchange」之间死亡 | exchange 必须已落盘 | 同一文件 → `a remote call writes its exchange to disk before it can reach the Hub`：在 `deliverRemote` 缝内同步读 `state.json`，槽位已有 exchange | PASS |
| 重启后同事的 Bot 在旧 exchange 下答复 | 答复只出现一次，槽位变 `posted`，不启动第二个 relay、不重派成员 | 同一文件 → `a recovered waiting slot is continued by the matching Hub answer, once`：自动 `hello`/`sync.batch` 触发；断言 1 行、`exchangeId`/`hubEventId`、`post`、`deliverRemote` 0 次、relay 执行 0 次 | PASS |
| 两台机器并发保存群设置，其中一台基于旧版本 | 旧写入被 Hub 409 拒绝；旧响应也不能覆盖新房间 | `hub/test/workgroup-settings.test.js` 3 项 + 同文件 → `an older settings snapshot cannot overwrite a newer room` | PASS |
| 用户 Stop 后协调者重启 | 记录仍为 `stopped`；迟到答复只记日志，不继续轮次 | 同一文件 → `a stopped round stays stopped after a coordinator restart` | PASS |

**未改变的水位**：双机实时、视觉对照、Electron 冷启动仍是人工 BLOCKED，见 `manual-checklist.md`。

---

## T19 Bot UI 与原版视觉对照

- 结论：**BLOCKED**，只能人工。
- 步骤：`manual-checklist.md` G4-6 的 8 行对照表，每行至少一张截图。
- 本轮**没有**做任何「无违和」的判断，也没有替代判断。

## T20 Windows/macOS Electron 冷启动

- 结论：**BLOCKED**，只能人工。
- 步骤：`manual-checklist.md` G4-T20（必须先 `npm ci` + `npm run pack` 重装包文件）。
- 自动化能保证的部分：`ds-bot/package.json` 的 `files` 已含 `src/workgroup/`，G4 新增的 `bridge.js`/`upgrade.js` 在该目录下，因此包文件会带上它们。
