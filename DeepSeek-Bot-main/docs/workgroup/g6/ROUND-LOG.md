# G6 轮次日志

- 分支：`feat/g6-group-memory`
- 起始：`main` 实际 HEAD `1a022df`（G6 计划文档提交）；用户指令所述基线 `e71119b` 是其父提交
- 结束：本轮文档收口提交之后的分支 HEAD
- 口径优先级：用户需求 > 指令「已定口径」 > 技术方案 > g0–g5 历史文档

## 0. 开工核对

| 项 | 实际 |
|---|---|
| Git 根 | `D:\code\ai\DeepSeek-Bot\BotCode` |
| 起始分支/提交 | `main` / `1a022df docs(workgroup): add the G6 group memory plan and handoff` |
| 指令基线 | `e71119b`；`1a022df` 仅在其上新增计划与交接文档 |
| Hub 基线 | 268 tests / 268 pass / 0 fail |
| ds-bot 基线 | 1132 tests / 1131 pass / 1 skip / 0 fail；首跑一次 Windows 临时目录 EPERM 清理，复跑通过 |
| client check | exit 0 |
| lint | 0 error / 13 warning |
| 冻结 host 文件 | `git diff --name-only e71119b -- ds-bot/src/host` 为空 |
| 既有脏改动 | app 的 3 个 package 文件、Hub 本地 `.data` DB、app shots；全程未纳入 G6 提交 |
| FTS5 trigram | `node:sqlite` 实测可建表并 MATCH |

## 1. 计划偏差（Plan deviation）

1. **ACL 取显式名单**：计划 Task 2 示例写 `acl: []` 后 Bob 仍可见，但同类测试与用户门禁要求
   “`acl` 不含自己时读不到”。实现采用“创建者自动加入、ACL 中仅活跃成员、名单外读不到”，
   测试同时覆盖成员在名单内/外与离群。见 `DESIGN-GROUP-MEMORY.md §2`。
2. **重启测试不使用 `startHub.close()` 重开**：该 helper 的 `close()` 会删自己的 `dataDir`，
   计划示例因此会重开空库。实现保留同一 dataDir，关闭真实 Hub 后重开，并单独清理临时目录。
3. **夹具抽取未删除原文件实现**：为避免一次性大搬迁扩大回归面，`workgroup-realtime.test.js`
   的通用夹具抽到 `helpers-pair.js` 后由原文件回引；原文件仍保留少量只在本文件使用的测试辅助
   函数。规则仍是不复制第二份夹具逻辑。
4. **`memory-create` 幂等**：计划未给创建幂等键，但门禁要求重放同一 `memory.created` 不产生
   第二条。实现接受可选 `eventId`，以审计行主键去重；首次 201，重放 200 + `duplicate: true`。
5. **G5 schema 断言随迁移更新**：`db-g5-schema.test.js` 原断言“G6 表不得提前存在”和
   `LATEST_VERSION = 7`，在 v8 落地后按当前事实更新；历史解释保留在测试注释中。
6. **realtime 清理竞态**：全量并行下 Windows 偶发临时目录 EPERM。测试 teardown 改为有界重试，
   清理失败只警告；产品断言不变。基线首跑也出现过同一环境噪声。

## 2. 任务与提交

| Task | 内容 | 提交 | 证据 |
|---|---|---|---|
| 1 | 迁移 v8、FTS、cascade、触发器 | `9ae7b8b` | `hub/test/db-g6-schema.test.js`、`db-migrate.test.js` |
| 2 | Hub 记忆服务、ACL、版本、软删除、路由 | `8f0305b` | `hub/test/group-memory.test.js`、Hub 全量 277/277 |
| 3 | `memory.*` 封闭集与未读隔离 | `10e80ab` | `ws-events.test.js`；socket 红绿在 Task 2 记录 |
| 4/5 | 插件 Hub 客户端、投影、bridge 分发、五个 apiHandle | `71f02bc` | `test-realtime/workgroup-memory.test.js`、realtime/API 46/46 |
| 6 | `rt.memoryRoomOf` 与回顾门 | `c7e9a10` | `workgroup-memory-review.test.js`、memory 102/102 |
| 7 | 删除工作群归档本地记忆 | `93ec26f` | `workgroup-memory-review.test.js` |
| 8 | 设置记忆区、feed 重读、i18n、构建 | `85e508c` | `workgroup-ux.test.js`、panel 4/4、build check |
| 9 | T18 负例、离群、删除、重启、幂等、跨机修正/删除、隔离 | `ab08b52`、`307982d` | Hub 283/283；ds-bot 1224 tests / 1223 pass / 1 skip / 0 fail |
| 10 | 文档与证据 | 本文档所在提交 | `EVIDENCE-MATRIX.md` |

## 3. 门禁结果

| 命令 | 结果 |
|---|---|
| `cd hub && npm test` | 283 tests / 283 pass / 0 fail |
| `cd ds-bot && npm test` | 1224 tests / 1223 pass / 1 skip / 0 fail / exit 0 |
| `node scripts/build-client.mjs --check` | exit 0 |
| `npm run lint` | 0 error / 13 warning |
| `git diff --name-only e71119b -- ds-bot/src/host` | 仅 `memory.js`（用户允许的回顾接缝）；五个冻结文件无改动 |

## 4. 未解决与人工项

- G6-M1 双真机群记忆验收：**BLOCKED**，步骤见 `manual-checklist.md`。
- G4-1/5/6、G4-T20、G5-T12/N3/T14：**BLOCKED**，本轮不代写 PASS。
- OS 钥匙串：DSH 0.2.1-rc.2 的 `dsh-credentials-local` README 明确 deferred，G6 只记录事实；
  未声称完成，替换路径仍见 `KNOWN-GAPS.md` 第 1 项。
- 人员显示名：Hub `users` 无 `display_name`，成员行仍打码手机号；不在 G6 扩范围。
- 不发版、不改版本号、不打包。
