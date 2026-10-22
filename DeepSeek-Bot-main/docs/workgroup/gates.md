# 自动门禁结果（G3 水位）

- 日期：2026-10-22
- 环境：Windows，Node，`@deepseek-ai/*` 由 `npm run harness` 安装（DSH 0.2.1-rc.2）
- 原则：AI 不自评；不能自动判定的条目一律不进本表，放入 `manual-checklist.md`

| # | 门禁项 | 判定方式 | 结论 | 证据 |
|---|---|---|---|---|
| 1 | 构建与生成物一致 | `node scripts/build-client.mjs --check` | 通过 | 无输出即一致；`client.js` 已重建 |
| 2 | 单元测试（ds-bot） | `npm test` | 通过 | 944 项：943 pass / 1 skip（Windows 空格目录名）/ 0 fail |
| 3 | Lint | `npm run lint` | 通过 | 0 error；11 warning（与迁移前基线相同） |
| 4 | Hub 服务端测试 | `cd hub && npm test` | 通过 | 111 pass / 0 fail |
| 5 | 双域隔离 | `workgroup-isolation.test.js` | 通过 | 16 pass：工具名不相交、二次安装抛错、归属解析互斥 |
| 6 | 回合行为 | `workgroup-round.test.js` | 通过 | 40 pass：创建、改名、`@`、进度、Stop、删除、恢复 |
| 7 | 附件/图片/引用 | `workgroup-files.test.js` | 通过 | 3 pass |
| 8 | 进度视图 | `wg-activity.test.js` | 通过 | 3 pass |
| 9 | 交互六约束 | `workgroup-ux.test.js` | 通过 | 9 pass |
| 10 | 凭据落盘 | `hub-store.test.js` | 通过 | 7 pass：优先接缝、回退 0600 文件、损坏文件读作无账号 |
| 11 | Hub 客户端 | `hub-client.test.js` | 通过 | 21 pass：注册即注册设备、密码不落盘、refresh 轮换、撤销登出 |
| 12 | 未登录本地可用（源 G3 门禁 5） | `hub-offline.test.js` | 通过 | 5 pass：签出状态与 Hub 死端口下本地团队全部可用 |
| 13 | 换账号不残留 | `hub-account-switch.test.js` | 通过 | 7 pass |
| 14 | 本地群不回归 | 既有 831 项测试 + 逐字节比对 | 通过 | `docs/workgroup/diff-manifest.md` §3 |
| 15 | 路由分离 | 冒烟脚本 | 通过 | `/api/bot`、`/api/bot/feed`、`/api/workgroup` 同时注册；工作群 `state` 与 `hub-state` 正常应答 |
| 16 | 不修改 DSH | 代码审查 | 通过 | 无 `deepseek-harness` 补丁；只用插件接口 |
| 17 | 工作群记忆面板 | `workgroup-round.test.js` 新增用例 | 通过 | `memory-view` 返回该工作群、`entries: []`、无错误；未知 id 仍拒绝 |
| 18 | 诊断报告含工作群 | `diagnostics.test.js` | 通过 | 13 项通过；报告增加 Workgroups 行与构建时间 |

## 实机启动时发现并修复的问题

| 问题 | 现象 | 修复 |
|---|---|---|
| `ds-bot/package.json` 的 `files` 不含 `src/workgroup/` | 桌面端把 `ds-bot` 当包文件复制，运行时报 `the Workgroup domain is unavailable: Cannot find module './src/workgroup/index.js'` | 加入 `src/workgroup/`，并在 `app/` 重跑 `npm ci`；重启后域正常加载 |

## 不适用的门禁

源方案 G3 的 3 条 OTP 门禁（错误码、过期、重复）**不适用**：认证方式已定为手机号 + 密码，没有短信 OTP，代码中也不存在 `otp` 端点与表。

## 阻塞（不是通过）

- **冒烟测试**：`dev/bench.sh smoke` 需要 DSH checkout（`../deepseek-harness`），本环境不具备 → 记为阻塞，待有环境时补跑。
