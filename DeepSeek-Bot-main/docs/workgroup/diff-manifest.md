# 差异清单（BotCode 工作群迁移，G3 水位）

- 日期：2026-10-22
- 基线：`BotCode/DeepSeek-Bot-main.zip` 中的原始快照（v0.2.0）
- 核对方法：把快照解压到临时目录，对 `ds-bot/src/**`、`ds-bot/index.js`、`ds-bot/client.js` 逐文件 `diff -q`。凡未列在下面「新增」「修改」两张表里的 `src/` 文件，都与快照**逐字节相同**。

```bash
unzip -q BotCode/DeepSeek-Bot-main.zip -d /tmp/pristine
for f in $(cd ds-bot && find src -name '*.js'); do
  diff -q "ds-bot/$f" "/tmp/pristine/DeepSeek-Bot-main/ds-bot/$f" >/dev/null || echo "MOD $f"
done
```

## 1. 新增文件（15 + 1）

| 路径 | 作用 |
|---|---|
| `src/workgroup/index.js` | 域入口：单次安装，二次安装抛错；安装失败只 warn |
| `src/workgroup/shared/constants.js` | `WG_SOURCE_KIND`、`WG_TOOLS`、`WG_ROUTE`、`WG_DIR`、回合限制 |
| `src/workgroup/host/state.js` | 独立状态文件 `home/workgroup/state.json` |
| `src/workgroup/host/ownership.js` | 域内 Session 归属；跨域声明直接抛错；`roomOf` 只读解析缝 |
| `src/workgroup/host/tasks.js` | Task Session 注册表 |
| `src/workgroup/host/groups.js` | 原版群聊的完整复制（room log、串行回合、`@`、relay、改名、成员、Stop、resume） |
| `src/workgroup/host/hub.js` | Hub HTTP 客户端：注册/登录/refresh/设备 challenge/撤销/健康检查 |
| `src/workgroup/host/hub-store.js` | 凭据落盘：优先 `ctx.credentials`，回退 0600 文件（不是 OS 钥匙串） |
| `src/workgroup/host/hub-format.js` | 脱敏与状态文案的唯一出处 |
| `src/workgroup/host/channel.js` | `POST /api/workgroup`（群、回合、升级、Hub 端点） |
| `src/workgroup/client/api.js` | 只打 `api/workgroup`，永不落回 `api/bot` |
| `src/workgroup/client/index.js` | 「Bot」侧栏入口与面板挂载 |
| `src/workgroup/client/panel.js` | 工作群列表/创建/改名/删除/发送/停止；连接状态 |
| `src/workgroup/client/rows.js` | 工作群行（与原版群行同款） |
| `src/workgroup/client/styles.js` | `bt-wg-*` 样式 |
| `src/workgroup/client/group-settings.js` | **群设置的复制件**（plan §5.1 A 类第 11 项）：成员卡下方「邀请同事」，成员卡之后「等你处理」审批卡 |
| `src/workgroup/client/invite.js` | `WorkgroupInviteRow`：固定显示，不可用时禁用并说明原因 |
| `src/workgroup/client/invite-target.js` | 一个字段区分手机号与 Hub 用户 ID（无 React 依赖，可单独测试） |
| `src/workgroup/client/tasks.js` | `ApprovalCards` 从 `panel.js` 抽出，供面板与群设置共用 |
| `src/client/hub-settings.js` | 「Hub 账号」设置页 |

## 2. 修改文件

| 路径 | 改动 | 原因 |
|---|---|---|
| `index.js` | 延迟 `require` 加载工作群域、`config.workgroup` 开关、失败只 warn | 单 Runtime 单次安装；域故障不拖垮本地团队 |
| `src/host/store.js` | 增加 `rt.resolveSessionOwnerStrict ??=` 默认实现 | 让两域共用的归属解析存在，且不改变原查询 |
| `src/host/tools.js` | `groupScopeOf` / `speakerOf`、`callInGroup` 按域分流、工具收敛改用 `selfOf` | 工作群成员不在原版索引里，不补则无工具可调用 |
| `src/host/capabilities.js` | `botOfSession` 改用 `rt.botOf(rt.selfOf(id))` | 工作群成员的能力（工具、MCP）才挂得上 |
| `src/host/channel.js` | `live()` 只读合并工作群 `activity`/`work` 视图 | 工作群才有"思考中"与底部卡片 |
| `src/host/secrets.js` | 监听器加 `redacts` 标记 | 测试按标记选取，不依赖注册顺序 |
| `src/host/usage.js` | 监听器加 `meter` 标记 | 同上 |
| `src/host/feed.js` | 监听器加 `feed` 标记 | 同上 |
| `src/host/memory.js` | 房间查找改走 `rt.roomOf(id) ?? rt.workgroupRoomOf?.(id)` | 工作群房间不在 `state.rooms`，否则记忆面板报「找不到这个群聊」 |
| `src/host/diagnostics.js` | 报告增加 Workgroups 行；记录运行中宿主与 `client.js` 的构建时间 | 排障时能区分「运行的是旧进程」与「真有缺陷」 |
| `src/client/index.js` | 工作群入口 effect；`workgroupOf` 与写操作分流；`roomProgress` 分流；Hub 动作；roster 索引工作群；样式 | 工作群 id 不是本地群 id，写入必须按域分发 |
| `src/client/sources.js` | `indexRoster(value, workgroups)` + `groupRooms()` | 工作群按群组件要求的形状进 `roomsById` |
| `src/client/sidebar.js` | 工作群行进入原版侧栏列表；群行补 `title`；**订阅既有 `/api/bot/feed` 的 `workgroup` 事件并刷新 `workgroupStore`** | 列表内混排，不新开分区；远端设置/成员变化要刷新原版会话头、成员卡与设置抽屉读取的那份 roster |
| `src/workgroup/host/groups.js` | 原版群聊的完整复制；**真实 composer 的 user 行走 `mirrorLine` 上 Hub；跨机 person 行与已匹配的远端 Bot 答复以 `role: 'remote'` 只显示不开轮；普通远端 Bot 发帖保留 `post` + `member`** | 原版没有 Hub：用户行只在本地、同事看不到；匹配答复同时作为 opener 会重复开轮 |
| `src/client/new-chat.js` | 「Create workgroup」入口与创建路径 | 复用原版建群流程，只换目的地 |
| `src/client/details-drawer.js` | **工作群走复制件的群设置**（`room.workgroup === true` 分流，一处三元） | 工作群行的实际路径是「原版会话 → 齿轮 → 群设置」，不改这里复制件不可达。§5.2 需补入本文件 |
| `src/client/settings.js` | 同上，设置页的 `groups` 分支也分流 | §5.2 已列本文件 |
| `src/client/context-menu.js` | 工作群行右键：设置、改名、删除；本地群新增「Upgrade to a workgroup」 | 右键菜单不能用本地群动作处理工作群 id |
| `src/client/cells.js` | `source.kind === 'workgroup'` 用原版群消息卡片渲染 | 工作群回合卡片 |
| `src/client/text.js` | `workgroup_relay` 归一为 `group_relay`；HEADER 增 `Workgroup post from` | 否则工作群回合什么都不画 |
| `src/client/at-menu.js` | `@` 候选排除工作群 | 否则工作群以 id 形式出现在"其他对话"里 |
| `src/client/settings.js` | `hub` 页、图标、渲染行 | Hub 账号页入口 |
| `src/client/i18n.js` | 工作群/Hub 文案与「未完成」声明 | 新增界面文案必须有中文 |
| `src/workgroup/client/panel.js` | 面板顶部「未完成」声明；**导出既有 `listenLive`，供产品侧栏复用同一订阅** | G3 水位必须显式标注；一个浏览器只开一条 workgroup 推送 |
| `client.js` | 生成物重建 | 仓库规则：不得手改 |

## 3. 未修改的原版文件（逐字节相同）

下列文件与快照**逐字节相同**，这是「本地群不回归」最直接的证据：

| 路径 | 为什么重要 |
|---|---|
| `src/host/groups.js` | 本地群核心零改动——工作群是复制品，不是改原版 |
| `src/host/turns.js` | `roomWaiters`/`roomProgress`/`roomInbox` 语义与注册顺序未动 |
| `src/host/delivery.js` | 投递语义未动 |
| `src/host/resume.js` | 恢复语义未动 |
| `src/host/constants.js` | `SOURCE_KIND`、`TEAM_TOOLS`、`ROUTE` 原值未动 |
| `src/host/parts.js`、`src/host/approvals.js`、`src/host/memory.js` | 上下文分段、审批、私人记忆未动 |
| `src/shared/mentions.js`、`src/host/text.js` | 共享解析器原样复用 |

## 3.1 “原版没有 → 新写”登记

任何工作群代码，若声称“原版没有这个能力，所以要新写”，必须先在本表登记，再写代码。
没有登记的新写模块，评审直接拒绝。

| 新写模块 | 原版最接近的实现 | 为什么不能复用或改复制件 | 判定 |
|---|---|---|---|
| `src/workgroup/host/hub.js` | 无（原版没有 Hub） | 跨用户传输在原版不存在，属真正的本域新增 | ✅ 合理 |
| `src/workgroup/host/bridge.js` | 无（原版没有 socket 同步） | 同上 | ✅ 合理 |
| `src/workgroup/host/memory-sync.js` | `src/host/memory.js` 的全套群记忆 | **不新写记忆引擎**：只把原版写入转成事件、把远端事件喂回原版写入路径 | ✅ 传输层新增，引擎复用 |
| `hub/src/ws.js` 的 `memory.change` 处理器 | `hub/src/ws.js` 的 `chat.message` 处理器 | Hub 已有点对点事件流与 `events` 表；只增加一种帧类型，不新增表、解释载荷或记忆语义 | ✅ 传输层新增 |
| `src/workgroup/host/ownership.js` 的 `rt.memoryRoomOf` | `src/host/memory.js:1476` 的 `agent/status` 过滤与 `roomIdOf` | 原版只认 `isBotSession`，工作群成员 Session 不在原版索引；新增只读接缝，不改变 `isBotSession` 或原版记忆行为 | ✅ 只读接缝 |

判定口径：

1. “原版没有”必须给出文件与函数级证据（哪个文件、哪个函数、为什么覆盖不了这个场景）。
2. “不能复用”必须说明复用会破坏什么（例如原版引擎是单进程文件写，跨机需要传输层）。
3. 传输、存储后端、协议适配可以是新写；**业务语义（谁能读写、条目长什么样、容量、回顾规则）不得新写**。

---

## 4. 测试文件

`test/` 下新增 9 个工作群测试与 `client-render.mjs`；20 个既有测试改为按 `options.path === '/api/bot'` 捕获路由，`usage`/`secrets`/`feed` 按监听器标记选取，`install`/`agents` 把工作群自有工具与注册调用纳入断言。这些是夹具适配，不改变产品行为。
