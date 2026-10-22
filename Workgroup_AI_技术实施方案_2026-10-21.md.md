# Workgroup AI / DeepSeek-Bot Fork 技术实施方案与 AI 开发交接计划书

> **版本**：V1.0（已确认方案汇编）  
> **编写日期**：2026-10-21  
> **适用对象**：架构负责人、AI 编程代理、测试与验收人员  
> **状态**：产品原则已确认；源码适配和安全能力须按门禁实际验证，**不是已完成实现**  
> **研究基线**：Fei2411/DeepSeek-Bot `v0.1.7`（发行页显示 2026-10-16，提交短 SHA `939a663`）；DSH 版本以第一阶段实测的兼容版本与精确 SHA 为准。

## 0. AI 编程代理须首先阅读的规则

1. **严格只有两个一级代码目录**：`hub/` 与 `bot-plugin/`。不得另建与其平级的 `bridge/`、`protocol/`、`ui/`、`client/`、`shared/` 或其他代码工程。必要文档、测试、脚本分别放到这两个目录内。
2. `bot-plugin/` 是**包含完整原版 DS Bot 的 Fork**，不是仅有工作群 UI 的轻量插件。原版 Chief、Bots、私人聊天、本地群、设置、工具和原生体验不能被替换或破坏。
3. **先完整复制原版群聊功能子系统与所需业务依赖，再隔离改造**；不得通过“只复制 UI + 重写所有群业务”替代既定方案。复制群聊功能不等于复制第二套 DSH Agent Loop/Bot Runtime。
4. 同一 DSH 实例中的 **Bot Runtime 只能创建、安装一次**；不得重复安装原版 Host、注册同名工具，或让两个子系统同时无差别消费同一全局事件。
5. `hub/` 是独立的协调服务；`bot-plugin/` 内含本机 Bridge、BotAdapter、Workgroup Host 与 Workgroup UI。Hub 不直接执行用户电脑的文件/命令工具。
6. **跨用户请求由资源所有者本人审批**。B 的 Chief 可以给出分配建议，但不能代替 B 本人授权。B 可以选择已有下属 Bot、由 Chief 自动选择，或新建 Bot；均在 B 批准后执行。
7. 本地群和工作群**数据、消息、成员、Session、权限及记忆隔离**。私人记忆/旧本地群历史不自动共享。
8. 在 **Bot 原生设置**加入 Hub 账号/注册/登录/连接管理。演示节点是配置目标，**不是编造的可用 URL**；手机号经有效短信验证码验证，才成为 Hub 认证用户。手机号不是跨用户寻址 ID，稳定身份为 `hubUserId`。
9. 原生 DSH 侧栏原位置保留“插件”；在其正下方增加一个 **“Bot”一级入口**。Chief、下属 Bots、私聊、本地群、工作群只能在 Bot 内部展示，不得在 DSH 一级侧栏中逐项展开。工作群视觉/交互必须尽量与原版一致，不重设计聊天 UI。
10. **每一阶段给出源码 diff、构建命令、测试结果、日志和未解决问题。** 若关键门禁未通过，禁止声称完成、禁止用普通 Agent 冒充 B 的原生 Bot、禁止用更宽泛权限绕过安全问题。

---

## 1. 项目目标、范围和验收定义

### 1.1 核心产品目标

让公司每位同事继续在本机使用自己的 DSH + DS Bot 团队，同时通过统一 Hub 账号加入跨用户工作群。人可以与人聊天，@本地或远程 Bot，可以请求其他同事的 Bot 团队完成授权任务。任务始终在**拥有者本地的真实 Bot + DSH Runtime** 中执行，经过本人审批，结果按授权范围回传工作群。

典型业务场景：财务 A 在工作群中向财务 B 的 Chief 请求指定月份的销售费用摘要。Hub 转达请求，B 本人审查资源和权限，选择已有财务 Bot / Chief 自动指派 / 新建 Bot，B 的本机 Agent 执行，B 批准可共享成果，A 在工作群收到结果。双方私人聊天及本机工作目录不向对方开放。

### 1.2 V1 必做

- Bot 设置中的 Hub 演示节点配置、手机号短信认证、设备绑定、登录保持、退出、断线提示和重新连接。
- 本地群原版功能完整保留；独立复制的工作群保持原版风格和主要群聊交互：群列表、创建、改名、删除/退出、成员、@、消息、轮次、进度、停止、历史、设置。
- 用户可**直接新建工作群**，也可从**本地群设置/右键菜单选择“升级为工作群”**；升级是创建关联的新工作群，不改变原群的数据类型。
- 多个真实 Hub 用户、多个设备、真实 Bot 端点、邀请与成员管理；文本消息、已读/未读、附件、在线/离线同步。
- 跨用户 Bot 请求、B 本人审批、三种 Bot 分配模式、进度/结果回传、任务撤销、断线恢复和审计。
- **群记忆 Group Memory 为 V1 必做**：历史检索、长期群知识/规范/决策、来源与权限、纠错/删除/过期、授权 Bot 检索；与私人记忆隔离。
- 两台真实局域网电脑的端到端验证、Electron 冷启动、原版回归、越权测试。

### 1.3 V1 暂不做

- 全互联网 P2P/NAT 穿透、多 Hub 联邦、多活消息主节点、跨企业 SSO、移动端全功能客户端。
- 一次性重写 Bot Runtime/DSH Agent Loop，或为了跨用户通信迁移全部原版 UI 到新框架。
- 未经用户明确授权自动共享本地工作目录、既有群历史、私人 Bot 记忆或全部工具。

### 1.4 成功判据

- 两台实际电脑、两个经短信验证的独立 Hub 用户，可创建/加入同一工作群并可靠收发消息。
- A 的请求在 B 未批准时不触发 B 的模型/工具执行；B 批准后由**B 真正的原生 Bot**在隔离 Session 内执行。
- B 撤销后后续敏感工具调用被拒绝，不能访问非授权路径/网络端点；任务结果不会自动泄漏私人数据。
- 本地群、私聊和原版 Bot 设置回归成功；插件重启和 DSH 上下文切换后不丢 Session 身份。
- 断网、重复投递、Hub 重启、客户端冷启动不会生成重复工作群或重复执行不安全副作用。

## 2. 基线源码、外部依据与证据等级

### 2.1 当前源码锚点

- DeepSeek-Bot 仓库：<https://github.com/Fei2411/DeepSeek-Bot>
- 已核对发行版：<https://github.com/Fei2411/DeepSeek-Bot/releases/tag/v0.1.7>
- 原版 Host 安装入口：<https://github.com/Fei2411/DeepSeek-Bot/blob/v0.1.7/ds-bot/index.js>
- 群核心：<https://github.com/Fei2411/DeepSeek-Bot/blob/v0.1.7/ds-bot/src/host/groups.js>
- 状态/身份索引：<https://github.com/Fei2411/DeepSeek-Bot/blob/v0.1.7/ds-bot/src/host/store.js>
- 轮次事件：<https://github.com/Fei2411/DeepSeek-Bot/blob/v0.1.7/ds-bot/src/host/turns.js>
- Bot 设置：<https://github.com/Fei2411/DeepSeek-Bot/blob/v0.1.7/ds-bot/src/client/settings.js>
- Bot 客户端入口：<https://github.com/Fei2411/DeepSeek-Bot/blob/v0.1.7/ds-bot/src/client/index.js>
- DSH UI 主面板说明：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-layout/README.md>
- DSH 工具安全管线：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md>

### 2.2 已从源码核对的事实

- `ds-bot/index.js` 暴露 `createRuntime(ctx, config)`，原版按照 `MODULES` 顺序安装模块并返回同一 `rt`。工作群需在唯一 Runtime 中接入，不能原样安装第二套所有模块。
- 原版群聊不仅有 UI，还有 `groups.js` 的群日志、@、Bot Session、轮次、工具和消息回报；其运行依赖 `store/roster/turns/delivery/tools/approvals/parts/resume` 等公共模块。
- 原版 `settings.js` 含 `SETTINGS_PAGES`，可在 Bot 设置体系内新增 Hub 账号入口。
- DSH 客户端支持主面板 Slot（如 `main`、`conversation`，实际调用需由锁版 API 核实）；不能认为所有聊天容器源码都在 DS Bot 仓库。
- DSH `tools.restrict` 和 `tools.guard` 能分别缩小继承工具的可见面与执行前拒绝操作；它们**不等于天然具备 OS 级文件与网络沙箱**，受限作用域自身注册工具和程序化工具传输路径须另外验证。

### 2.3 证据纪律

以下方案中出现的 `wg.*`、`TaskSessionRegistry`、`registerWorkgroupPanel`、`workgroup_*` 工具、Hub API 路径、表结构等均是**建议新增的接口或伪代码**，不是上游已有 API。公开网页源码审计属于“源码级证据”；mock 测试、本机双进程测试、真 DSH/Bot 测试、双机测试属于不同证据等级，不可混称。

首阶段必须在可联网的实际开发机下载完整仓库，锁定 DS Bot/DSH 精确 SHA、Node 与依赖；运行原版测试再开始 Fork。当前计划书不代表已完成这一真实验收。

## 3. 总体架构与责任边界

```text
员工 A 电脑                                       员工 B 电脑
┌────────────────────────┐                   ┌────────────────────────┐
│ DSH Desktop + Fork Bot │                   │ DSH Desktop + Fork Bot │
│ 原版 Chief/Bots/私聊/群 │                   │ 原版 Chief/Bots/私聊/群 │
│ 独立 Workgroup 群系统   │                   │ 独立 Workgroup 群系统   │
│ Bridge A + BotAdapter  │                   │ Bridge B + BotAdapter  │
│ 单一原版 Agent Runtime │                   │ 单一原版 Agent Runtime │
└────────────┬───────────┘                   └────────────┬───────────┘
             │ 主动连接 WSS/HTTPS                          │
             └──────────────┐            ┌─────────────────┘
                            ▼            ▼
                         ┌──────────────────┐
                         │  Hub 服务        │
                         │  手机认证/设备    │
                         │  群/消息/任务     │
                         │  审批/群记忆      │
                         │  同步/审计/附件   │
                         └──────────────────┘
```

**Hub**：身份认证（用户、设备）、Bot 公开端点目录、工作群与 ACL、消息顺序与持久化、事件扇出、投递确认、任务/审批状态、群记忆及授权附件。Hub 不直接持有 DSH Runtime、不能被远程请求直接触发系统命令。

**bot-plugin**：复制后的 Workgroup 群逻辑、独立客户端 UI、Host 侧 Bridge、离线缓存、任务适配和授权执行；继续使用原版真实 Bot 身份、模型、Session、工具基础设施。

**通道拆分**：网络通信通道 `WSS + HTTPS`；本地执行通道 `Bridge -> BotAdapter -> DSH Session`。聊天、审批、任务虽复用消息总线，但采用严格不同的事件和权限类型。

## 4. 严格两目录工程结构

```text
workgroup-ai/
├── hub/                                  # 一级目录一：独立服务
│   ├── package.json
│   ├── README.md
│   ├── .env.example
│   ├── src/
│   │   ├── server.js                     # HTTPS + WSS 入口
│   │   ├── config.js
│   │   ├── auth/                         # 手机注册/登录、短信验证码
│   │   │   ├── phone.js
│   │   │   ├── otp.js
│   │   │   ├── sessions.js
│   │   │   └── devices.js
│   │   ├── connections/                  # 心跳/连接/同步游标
│   │   ├── directory/                    # 公开 Bot Endpoint
│   │   ├── workgroups/                   # 群、成员、邀请、ACL
│   │   ├── messages/                     # 唯一服务端消息序号
│   │   ├── rounds/                       # 调度租约、轮次围栏
│   │   ├── tasks/                        # 任务生命周期
│   │   ├── approvals/                    # 服务端状态核验
│   │   ├── memory/                       # V1 群记忆 + 检索
│   │   ├── artifacts/                    # 已授权附件中转
│   │   ├── audit/
│   │   ├── protocol/                     # 协议定义与校验源
│   │   └── storage/                      # SQLite、迁移、事务
│   ├── migrations/
│   ├── scripts/
│   └── test/
│
└── bot-plugin/                           # 一级目录二：完整 Fork DS Bot
    ├── package.json
    ├── index.js                          # 唯一 Host Runtime 入口
    ├── README.md
    ├── LICENSE                           # 保留上游必要许可
    ├── NOTICE
    ├── src/
    │   ├── host/                         # 原版 Host + 必要精确扩展
    │   ├── client/                       # 原版 Bot 界面与设置
    │   ├── shared/                       # 原版共享模块
    │   └── workgroup/                    # 独立复制和改造的群系统
    │       ├── index.js                  # 工作群单次安装入口
    │       ├── host/
    │       │   ├── groups.js             # 复制群核心，改造隔离
    │       │   ├── roster.js             # 复制群管理
    │       │   ├── turns.js              # 复制轮次/等待/停止
    │       │   ├── delivery.js           # 复制分发，远程投递桥接
    │       │   ├── tools.js              # 复制群工具，独立命名
    │       │   ├── handoffs.js           # 群任务交接
    │       │   ├── approvals.js          # 群内审批展示适配
    │       │   ├── resume.js             # 群任务恢复
    │       │   ├── store.js              # 工作群本地投影/状态
    │       │   ├── channel.js            # 工作群 UI 访问 Host
    │       │   ├── bridge.js             # HTTPS/WSS 客户端
    │       │   ├── auth.js               # 本机 Hub 账号会话
    │       │   ├── device.js             # 设备密钥与绑定
    │       │   ├── session-identity.js   # 持久化工作群归属
    │       │   ├── task-adapter.js        # 原生 Bot Task Session
    │       │   ├── authorization.js      # 本人授权和撤销
    │       │   └── upgrade.js            # 本地群关联升级
    │       ├── client/
    │       │   ├── index.js              # 独立工作群 UI 入口
    │       │   ├── sidebar.js            # 从原版移植的群行
    │       │   ├── group-settings.js
    │       │   ├── at-menu.js
    │       │   ├── context-menu.js
    │       │   ├── cells.js
    │       │   ├── composer.js
    │       │   ├── member-status.js
    │       │   ├── upgrade-dialog.js
    │       │   ├── invite-dialog.js
    │       │   └── hub-account.js         # Bot 设置内 Hub 账号页
    │       └── shared/
    │           ├── mentions.js
    │           └── protocol.js           # 与 Hub 同版本契约
    ├── scripts/
    ├── docs/                             # 本文及核查报告可放这里
    └── test/
```

上表表示**目标职责与候选文件名**；AI 开发代理应先审计原版准确文件路径及 exports，再选择最小必要调整。不得生搬未存在的 import。Hub/插件之间保持协议版本一致并实施 contract tests，必要时生成协议代码并将生成物放入各自目录内；禁止新建第三个根工程。

## 5. 原版群聊源码复制、改造、复用矩阵

### 5.1 必须先复制并保持功能等价（A 类）

| 原版源码 | 复制目标 | 保留能力 | 改造重点 |
|---|---|---|---|
| `host/groups.js` | `workgroup/host/groups.js` | 消息日志、@解析、成员轮次、Bot Session、回报/停止 | 独立 `wg` 状态、Hub 权威消息、远端投递、避免同名工具/事件 |
| `host/roster.js` 群相关代码 | `workgroup/host/roster.js` | 群创建、成员/管理员/配置 | Hub 用户、Bot Endpoint、ACL；禁止远端人被当本地 Bot |
| `host/turns.js` 群相关代码 | `workgroup/host/turns.js` | 等待器、进度、异步结束、超时/失败 | 按 Session 域路由；不共用 `roomWaiters`/`roomInbox` |
| `host/delivery.js` 群投递部分 | `workgroup/host/delivery.js` | 真 Bot 投递与任务回执 | 本地仍投原版 Session；远程改走 Bridge/HUB |
| `host/tools.js` 群工具部分 | `workgroup/host/tools.js` | 群创建/发送/转发与读取 | 独立工具名、严格限定 Session 和授权 |
| `host/handoffs.js` 群交接部分 | `workgroup/host/handoffs.js` | Bot 任务交接、结果回报 | 绑定远端 taskId 与本地 Task Session |
| `host/approvals.js` 群显示部分 | `workgroup/host/approvals.js` | 工具审批卡、响应 | 区分本人跨用户授权与 DSH 工具审批 |
| `host/resume.js` 群恢复部分 | `workgroup/host/resume.js` | 中断恢复 | 不自动重放可能具有副作用的远程任务 |
| `host/store.js` 群状态部分 | `workgroup/host/store.js` | 群数据读写与索引方法 | 独立本地投影；Hub 作为公开消息主数据源 |
| `host/channel.js` 群 API 部分 | `workgroup/host/channel.js` | UI/Host 信道语义 | 新命名空间，不能重复同一路径/事件注册 |
| `client/group-settings.js` | `workgroup/client/group-settings.js` | 原版设置形态 | 真人角色/邀请/Hub/群记忆/退出 |
| `client/sidebar.js` 群行与相关依赖 | `workgroup/client/sidebar.js` | 原版群列表、未读、状态、右键 | 状态由 Hub 同步，不调用 `openSession` 伪装真人群 |
| `client/at-menu.js` 等群关联交互 | `workgroup/client/*` | 输入、@、消息、气泡、任务卡、消息状态 | 跨用户成员 ID，Hub 事件投影，风格一致 |

**执行次序**：完整复制来源快照 → 确保复制版能编译 → 抽离重复全局注册 → 单机本地等价测试 → 再接 Hub。`host/tools.js` 等源码包含非群功能时，可先原样保存复制快照用于 diff，但运行时只启用真正的群功能；不能装载重复的全局模块。

### 5.2 只修改一次的公共文件（B 类）

- `index.js`：在**唯一** `createRuntime()` 内安装 `workgroup`，不能二次运行原版 `MODULES`。
- `host/store.js`：统一识别 private/local-group/workgroup/task/history Session，身份索引重建时包含工作群持久映射。
- `host/prompt.js`、`models.js`、`capabilities.js`：让获批工作群 Session 继承真实 Bot 的模型/角色/必要能力，但限制高于原权限的扩大。
- `host/turns.js`、`parts.js`、`resume.js`、`approvals.js`、`folders.js`：对全局事件只做一次正确域分发，恢复、压缩、审批及工作目录验证覆盖工作群 Session。
- `host/permissions.js`、`tools.js`：整合 Workgroup 授权与 DSH 工具执行策略；防止通过 `message_bot`、`read_own_chat`、`run_code`、MCP 绕过。
- `host/channel.js` 与 `client/index.js`：挂接独立 Workgroup Host RPC 和 UI，遵守 DSH 公共 Slot 与生命周期。
- `client/settings.js`：增加 Hub 账号设置页面（使用原版样式和现有导航实现）。
- DSH 侧边栏集成点：保留“插件”原位置，其后添加且仅添加“Bot”一级入口；若官方 Slot 无法满足目标位置，先验证可行的 Fork 接缝，禁止 DOM/CSS hack。

### 5.3 复用且不重复安装（C 类）

DSH `sessionController`、真实 Agent Loop、Bot 注册表、模型工具运行时、MCP/Skills、原生 Session 存储、插件生命周期、原版通用头像/主题/国际化、基础文件处理等。这些功能原版安装一次即可；Workgroup 调用它们的受控适配接口。

### 5.4 必跑的全局调用扫描

```bash
rg -n 'groupOwners|chatOwners|pastOwners|selfOf|isBotSession' bot-plugin/src
rg -n 'roomWaiters|roomProgress|roomInbox|postToRoom|deliver' bot-plugin/src
rg -n 'ctx\.on\(|ctx\.tools\.register|ctx\.effect\(' bot-plugin/src/host
rg -n 'state\.rooms|roomOf\(|groupSessionFor|createSession' bot-plugin/src
rg -n 'conversation\.chat|conversation\.input|sidebar\.workspaces|SETTINGS_PAGES' bot-plugin/src/client
```

输出 `source-audit.md`：每个引用点必须归类“本地群独有 / 工作群独有 / 通用一次 / 危险待核验”，并列调用者、被调对象、注册次数、卸载/重启行为和相应测试用例。

## 6. 双群 Runtime、事件、工具和 Session 隔离

### 6.1 独立子域模型

```js
// 伪代码：不是原版现有 API
const wg = {
  runtime: rt,                   // 仅引用唯一原版 Runtime
  rooms: new Map(),              // 群投影/缓存
  sessionOwners: new Map(),      // 工作群/任务 Session 归属
  roomWaiters: new Map(),
  roomInbox: new Map(),
  roomProgress: new Map(),
  tasks: new Map(),
  bridge: null
};
rt.workgroup = wg;
```

原版 `rt.groupOwners`、`rt.roomWaiters`、`rt.postToRoom` 等不被覆盖；工作群新逻辑调用 `wg.*`。所有工作群 ID 应有全局命名空间，所有原版 Session ID 必须通过独立映射保存。若检测到一个 Session 同时归属于两个域，必须报错拒绝执行，而不是“先匹配先使用”。

### 6.2 单次注册与按域分发

```js
// 伪代码：在原版公共事件入口进行严格一次域分发
function dispatchSessionEvent(session, event) {
  const owner = resolveSessionOwnerStrict(session.id);
  if (owner?.kind === 'workgroup' || owner?.kind === 'task') {
    return wg.handleSessionEvent(session, event, owner);
  }
  return originalSessionHandler(session, event);
}
```

开发时必须审查事件传播语义：通用使用量记录可共享一次，群专属 Waiter 和回报只进入一个域；处理器卸载/热重载应注销监听器。对 `llm/stream`、`session/event`、工具审批、上下文 Part 切换建立独立集成测试。

### 6.3 工具命名与授权

原版本地工具保持原名。新增工作群工具采用 `workgroup_*` 命名，例如 `workgroup_relay`、`post_to_workgroup`、`read_workgroup_chat`，不要覆盖 `group_relay`、`post_to_group` 等。名字隔离只是基础；授权必须在执行前的工具边界强制检查。

### 6.4 Task Session 身份生命周期

每个 B 本地执行任务至少绑定：`hubUserId / deviceId / botId / workgroupId / taskId / authorizationId / sessionId / allowedResources / expiry / state`。这些映射需本地**事务持久化**，重启后重建并核对真实 DSH Session 是否存在。必须覆盖：建立、prompt/模型/工具查询、工具调用、上下文压缩产生新 Part、暂停、恢复、取消、清理、Bot 被删除以及授权被撤销。

`store.js` 的索引重建不能只依赖临时 `groupOwners.set()`。`createSession(title,{dir})` 传入工作目录前进行 realpath 和操作系统权限校验；若原版对无效目录回退，事后校验实际 cwd 不符时必须失败关闭（fail closed）。

**首要 P0 阻塞**：实测证明“B 的原生 Bot + 独立 Task Session + 最小工具权限 + 上下文切换 + 重启恢复”成立之前，不允许给跨用户 Agent 功能标记完成，也不得用非原生 Agent 替代。

## 7. Bot 设置中的 Hub 账号与短信认证

### 7.1 UI 要求

原版 Bot 设置新增 **Hub 账号** 页面，包含：当前节点（V1 默认演示节点）、节点地址、TLS 连接状态；手机国家码与号码、获取验证码、验证码登录/注册；登录后显示脱敏手机号、稳定 Hub 用户 ID、当前设备名与在线情况、设备列表、注销/退出、重连与错误说明。使用原版 `settings.js` 的导航、卡片与表单样式。

原版本地功能与 Hub 账号解耦：未登录、断网或主动退出时，Chief、Bots、私聊、本地群仍可用；工作群联网写入、跨用户请求等需要认证的能力禁用或等待重新登录。切换账号必须立即切换缓存命名空间、撤销旧账号的本地任务授权，不能泄漏旧用户的工作群数据。

### 7.2 演示节点策略

- 配置 `HUB_BASE_URL` 与 `HUB_WS_URL`，默认值通过部署配置注入，不填写未经确认的外网域名。
- V1 推荐由演示 Hub 实例承载正式的测试群与认证用户，但只有实际接入短信网关、能验证 OTP，才能声明“已认证”。
- 开发机允许使用隔离的测试短信 Provider（代码记录/注入测试号码），只用于非生产 `NODE_ENV=test`，不得将其身份用于正式 Hub，禁止固定公共验证码或客户端自签“验证通过”。

### 7.3 认证协议（建议）

1. `POST /v1/auth/otp/request`：输入 E.164 标准手机号，服务端限流并发送 OTP；响应不泄漏手机号是否存在。
2. `POST /v1/auth/otp/verify`：一次性验证 OTP，事务内创建或查找用户，返回短期 access token / 受保护的 refresh 机制；手机号唯一映射一个稳定 `hubUserId`。
3. `POST /v1/devices/challenge` 与 `/register`：本机产生设备公私钥（建议 Ed25519），通过已登录会话证明所有权并绑定设备；私钥留在 OS 安全存储。
4. `POST /v1/auth/refresh`、`/logout`：刷新轮换、注销令牌和撤销会话。
5. `GET /v1/auth/me`、`GET /v1/devices`：登录态、设备列表与撤销状态。
6. WSS 握手结合 TLS、短期凭证与设备挑战签名，绑定 `{hubUserId,deviceId}`；任意事件的发送方身份须由服务器认证上下文确定，客户端 payload 中的昵称/ID 不可信。

安全要求：OTP 短有效期（建议 5 分钟）、单次使用、次数上限、按手机号/IP/设备限流、服务端加密存储或不可逆验证摘要、日志脱敏；Token 有效期、设备会话吊销、密钥轮换、短信供应商失败提示可配置。跨群分享只传稳定 ID，不暴露手机号给群成员。

### 7.4 账号和 Bot 关系

`hubUserId` 是真实用户身份主体；`deviceId` 是可吊销设备；`botId` 是该设备上的本地 Bot 标识。对外寻址 `Hub userId + deviceId + botEndpointId`，Bot 名称仅为 UI 标签。用户可以选择发布哪些 Bot 到 Hub 的可邀请端点目录；登录成功绝不意味着自动发布全部 Bot。

## 8. 本地群与工作群的产品关系、升级策略

### 8.1 必须并存的两个入口

- **新建本地群**：保留原版入口与行为；群成员仍是本机 Bots；原版 `state.rooms`/Session 为权威。
- **新建工作群**：登录 Hub 后可直接创建，不要求先有本地群；工作群拥有 Hub `workgroupId`，成员可为真人/本机 Bot/远端 Bot。
- **升级为工作群**：本地群设置和群列表右键菜单提供入口；属于创建**关联的新工作群**，不是修改原版 `room.type` 或强行将远端用户写入原 `room.members`。

### 8.2 升级事务流程

`PREPARING -> HUB_CREATED -> LOCAL_LINKED -> ACTIVE`。升级前冻结原群新派单（若尚有运行任务，要求完成/取消），生成带幂等键的迁移快照；预览选择共享群名、头像、公告及本地 Bot 列表；不共享旧历史、绝对路径、私人记忆及工具权限。Hub 创建新群并给出 ID；本机保存映射后激活工作群。原群归档为可读历史，不删除；升级失败可按 idempotency key 恢复，避免创建两个群。

本地关联键：`{localRoomId, hubUserId, workgroupId, upgradeId, status, createdAt}`。切换账号不允许沿用旧账号关联。回滚只撤销未激活的新群或关联，不修改原版历史；已对外发布的群不能自动删除所有人的数据。

### 8.3 UI 设计

工作群 UI 首先**完整复制**原版群的 UI、相关交互和所需群业务代码到 `bot-plugin/src/workgroup/`；复制后先证明单机功能等价，才将消息源替换为 Hub。因 DSH Conversation 部分容器不在 DS Bot 仓库，主面板容器仍需受控适配；保持原版视觉，不得自行换风格。

本地群打开原生 DSH Conversation；工作群通过经过实测的 DSH Slot/页面机制展示 Hub 消息，不能创建虚假的“远程真人 DSH Session”。真正需要原生 Bot 执行时才建立受限的本地 Bot Session。

## 9. Hub 网络通道与可靠协议

### 9.1 技术选择

V1：Hub 为 Node.js 服务，HTTPS 用于账号、历史同步、群配置和附件，WSS 用于持久双向消息。每个 Bridge **主动连接 Hub**，不暴露本地 DSH HTTP 端口；同一用户允许多设备，Bot 端点精确绑定执行设备。V1 单 Hub 实例，SQLite WAL 用于中心数据，文件系统中转授权附件；上生产级高可用再讨论 MySQL 等替换，不预先建设分布式中间件。

### 9.2 事件信封（建议协议 v1）

```json
{
  "v": 1,
  "eventId": "uuid",
  "type": "task.request",
  "workgroupId": "wg-001",
  "taskId": "task-001",
  "sender": {"userId": "u-a", "deviceId": "d-a", "botEndpointId": "ep-chief-a"},
  "target": {"userId": "u-b", "botEndpointId": "ep-chief-b"},
  "createdAt": "2026-10-21T01:00:00Z",
  "expiresAt": "2026-10-22T01:00:00Z",
  "payload": {"title": "费用汇总", "requestedResources": ["resource:monthly-expenses"], "requestedCapabilities": ["read"]},
  "signature": "device-signature-placeholder"
}
```

署名必须涵盖经过规范化序列化的关键字段、payload hash、目标、有效期、协议版本；Hub 根据已认证连接覆盖/校验发送方 ID。签名、挑战/nonce、防重放窗口和签名失败策略须经 contract tests 证明，不可仅检查 `signature` 字符串存在。

### 9.3 消息类型和语义

- 连接：`hello`、`sync.request`、`sync.batch`、`heartbeat`、`event.ack`。
- 群：`chat.message`、`chat.edited`、`chat.deleted`、`member.changed`、`read.updated`。
- 任务：`task.request`、`task.received`、`task.cancel`、`task.started`、`task.progress`、`task.completed`、`task.failed`。
- 审批：`approval.request`、`approval.granted`、`approval.rejected`、`approval.revoked`。
- 群记忆：`memory.proposed`、`memory.created`、`memory.corrected`、`memory.deleted`。
- 附件：`artifact.available`、`artifact.revoked`。

事件必须严格按 JSON Schema/同等契约做版本、最大长度、允许字段、成员权限和速率限制。`chat.message` 不能直接调用任意系统工具；跨用户任务必须显式 `task.request`，远程 @ 仅是发起请求的交互入口。

### 9.4 投递与离线恢复

区分 `HUB_ACCEPTED`（已写入 Hub）、`DEVICE_DELIVERED`（目标 Bridge 已持久化）、`USER_APPROVED`、`RUNNING`、`COMPLETED`，不能把网络 ACK 当模型完成。所有公开群事件由 Hub 分配单调递增的群内 `seq`；客户端以持久化游标补拉；事件传输采用**至少一次投递 + 接收去重 + 任务幂等控制**。

Hub 与 Bridge 均保存 Inbox/Outbox 与去重键。去重事务原则：先写事件和状态，成功后再 ACK。设备断线自动恢复；任何过期/被撤权事件不得因为补发触发执行。对于写文件、发消息、外部 API 等可能发生副作用的任务，不得在未知结果时盲目自动重试。

### 9.5 轮次调度

保留复制版原有群 Bot 轮次机制，但 V1 一个工作群**同时只允许一个有效调度者**。Hub 管理带 `coordinatorEpoch / leaseUntil` 的租约；轮次提交附 `roundId` 和围栏值，过期租约的回报被拒绝。V1 可以指定群主设备或在线协调设备承担轮次管理；其离线时普通真人聊天继续，自动 Bot 轮次暂停或等待人工重新授予租约。不能在两个客户端并行无限制运行完整 `group_relay`。

## 10. 跨用户任务、审批与真实 Bot 执行

### 10.1 端到端步骤

1. A 在工作群中 `@B 的 Chief` 并**明确发起任务**，提出目标、所需资源和可共享成果；A 的 Bridge 生成 taskId、签名并发给 Hub。
2. Hub 核查 A 身份、群权限、B 目标端点、发送频率和请求类型，事务持久化后投递给 B 的指定设备。
3. B 的 Bridge 校验并持久化请求，显示**给 B 本人的审批卡**；B 的 Chief 仅可提供建议。
4. B 审批：拒绝，或者选择①已有下属 Bot、②Chief 自动选 Bot、③新建 Bot；同时限定文件/工具/网络资源、有效期和结果共享策略。
5. B 的 Bridge 生成本地不可伪造的授权记录，使用 B 的真实 Bot 创建独立 Task Session，验证实际身份/工作目录/可见工具/Guard 已成功安装后才运行。
6. 执行过程中 Bridge 通过 Hub 发进度。B 可撤销，撤销后阻止新工具调用并取消可控作业。
7. 结果在 B 本地检查是否可共享（必要时二次确认），仅授权成果上传 Hub/发送群消息；A 获取已许可摘要或附件。
8. B 的本地任务信息、私聊、历史记忆和未获准文件永不因为一次委派自动成为群公共数据。

### 10.2 状态机

`REQUESTED -> DELIVERED -> PENDING_APPROVAL -> APPROVED -> ASSIGNED -> RUNNING -> RESULT_REVIEW -> COMPLETED`；分支为 `REJECTED`、`EXPIRED`、`CANCEL_REQUESTED`、`CANCELLED`、`FAILED`、`INTERRUPTED`。只有经过预定义来源和版本检查的转换允许入库，例如未批准绝对不能 `RUNNING`，已 `REVOKED` 不能再次开始。

### 10.3 任务权责与本地授予

Hub 记录任务和审批事件，但**最终能否调用本地工具以 B 的本地授权账本为准**。审批凭证绑定 `taskId, ownerUserId, botId, sessionId, resources, capabilities, expiresAt, version`；签发和撤销必须经 B 本人的认证 UI 交互。Hub 的“批准”事件不能独立激活 B 的工具权限。

### 10.4 最小权限与强制安全

统一判定：`可执行 = 原 DSH 权限允许 ∧ B 本地授权有效 ∧ 路径/端点在范围内 ∧ 操作系统隔离允许`。

- `ctx.tools.restrict()` 用来减少可见工具，`ctx.tools.guard()`、`tools/pre-execute` 在实际调用前执行强制拒绝；同时检查作用域自己注册的工具、PTC/`run_code` 子调用和 MCP 转发。
- 所有真实路径先 `realpath`、校验符号链接/目录穿越、文件权限，并在必要时采用独立 OS 用户/容器/受限进程实现文件/网络边界；仅 prompt 禁止越权不合格。
- 远程任务默认不允许读取 `read_own_chat`、非批准的群历史和私人记忆；原有 `message_bot` 不得成为向无关 Bot 派单的旁路。
- 撤销必须阻止新的调用，取消正在运行的 Agent 和可取消的子进程/网络操作；对不可中断副作用记录并显示人工确认，不伪称 100% 已回滚。
- 机密不因 UI 消息脱敏而安全：工具返回的结构化值、文件和日志均要做分享范围控制。

## 11. 群记忆 V1 设计

群记忆与原生 Bot 记忆、私人历史和 Task Session 记忆完全分离。Hub 保留原始群消息与经过批准的长期条目，条目必须具备 `memoryId/workgroupId/type/content/sourceRefs/createdBy/ACL/version/expiresAt/deletedAt`；支持规范、决定、FAQ、项目事实、任务产物的人工或受控 Bot 提议。

提供消息检索、群知识全文检索、来源引用、修正/撤回、权限变化即时生效；V1 可用 SQLite FTS5 + ACL 过滤，避免未经测试引入向量服务。Bot 只能在当前群和授权范围内检索，原本地群历史默认不导入。群被删除/成员离群/资源授权取消后，索引与下载权限同时收敛，保存必要的审计记录但不得继续向离群成员暴露内容。

## 12. Hub 数据模型建议

V1 默认 SQLite WAL（单实例），启用外键、合理 `busy_timeout`、迁移版本号，使用事务保证状态与 outbox 一致。关键表及唯一约束如下：

| 表 | 关键字段 | 核心约束 |
|---|---|---|
| `users` | `id, phone_e164, phone_verified_at, status` | 手机号唯一，ID 不因昵称/换机变化 |
| `otp_challenges` | `id, phone_hash, code_verifier, expires_at, attempts, consumed_at` | OTP 一次有效，限流 |
| `auth_sessions` | `id, user_id, refresh_hash, expires_at, revoked_at` | 凭证轮换 |
| `devices` | `id, user_id, public_key, name, revoked_at` | 用户绑定设备 |
| `bot_endpoints` | `id, owner_id, device_id, local_bot_id, visibility, status` | 端点归属和发布授权 |
| `workgroups` | `id, owner_user_id, name, config_version` | Hub 权威群标识 |
| `memberships` | `workgroup_id, member_type, user_id, endpoint_id, role, status` | 区分真人/本地/远程 Bot |
| `invites` | `id, workgroup_id, invited_by, invitee_id, expires_at, status` | 授权邀请、防重复 |
| `events` | `event_id, workgroup_id, seq, sender_id, type, payload, created_at` | `event_id` 唯一；群内 `(workgroup_id,seq)` 唯一 |
| `deliveries` | `event_id, device_id, delivered_at, ack_at` | 接收方断线补发 |
| `read_cursors` | `workgroup_id, user_id, last_read_seq` | 已读/未读 |
| `round_leases` | `workgroup_id, epoch, holder_device_id, lease_until` | 单协调者围栏 |
| `tasks` | `id, workgroup_id, requester_id, owner_id, endpoint_id, state, version` | 状态机、并发控制 |
| `approvals` | `id, task_id, approved_by, scope, state, expires_at, version` | B 本人权限范围与撤权 |
| `artifacts` | `id, task_id, owner_id, blob_path, hash, size, acl, expires_at` | 仅授权产物 |
| `group_memories` | `id, workgroup_id, text, source_refs, acl, version, deleted_at` | 来源与纠错/删除 |
| `audit_events` | `id, actor_id, device_id, action, target_id, result, at` | 不存 OTP/token/完整机密 |

Bot 插件本地单独保存 `hubAccount`（不含明文持久 token）、`deviceIdentity`、`workgroupLinks`、`workgroupSessionOwners`、`taskGrants`、`inbox/outbox`，按 `hubUserId` 分开目录或逻辑加密命名空间。OS 密钥链保存私钥/刷新凭证，客户端页面不能直接拿到长期私钥。

## 13. API、消息契约与文件中转

### 13.1 HTTPS 端点草案

```text
POST   /v1/auth/otp/request
POST   /v1/auth/otp/verify
POST   /v1/auth/refresh
POST   /v1/auth/logout
GET    /v1/auth/me
POST   /v1/devices/challenge
POST   /v1/devices/register
GET    /v1/devices
POST   /v1/devices/:id/revoke
GET    /v1/bot-endpoints
POST   /v1/bot-endpoints
POST   /v1/workgroups
GET    /v1/workgroups
POST   /v1/workgroups/:id/invites
POST   /v1/invites/:id/accept
GET    /v1/workgroups/:id/events?afterSeq=...
POST   /v1/tasks/:id/decision
POST   /v1/tasks/:id/revoke
POST   /v1/artifacts/uploads
GET    /v1/artifacts/:id/download
GET    /v1/workgroups/:id/memories
POST   /v1/workgroups/:id/memories
PATCH  /v1/workgroups/:id/memories/:memoryId
DELETE /v1/workgroups/:id/memories/:memoryId
GET    /v1/health
WS     /v1/ws
```

以上是待实现的契约草案：开发前先形成 OpenAPI/JSON Schema，覆盖登录状态、异常码、分页、成员权限与幂等。敏感决策端点不能仅靠 Hub 接收到同意就替代 B 本地审批；B 的设备端还须具有匹配的本地授权记录。

### 13.2 文件中转

绝不传可直接访问本地目录的绝对路径。流程：`B 本地生成 -> 授权审查 -> 哈希/大小/类型检查 -> 上传 Hub 私有存储 -> ACL 校验 -> A 下载`。至少实现附件大小上限、MIME/后缀双检查、路径安全、短期下载权限和过期清理。若要求 Hub 管理员也不能看内容，增加端到端加密设计与多设备密钥管理；V1 默认 TLS 只保护链路，**不声称 Hub 无法访问其存储的明文**。

## 14. 详细实施阶段、任务拆分与交付门禁

> 时间不按“几天就能做完”承诺。以每个门禁真实验收通过为进度依据；未通过即停在该阶段排查。

### G0：环境、锁版、完整源码审计（先执行）

**任务**：克隆 DeepSeek-Bot v0.1.7 与锁定的 DSH；记录完整 SHA、Node/pnpm、依赖锁文件、插件装载方式、许可证；在真实开发机原样构建、跑测试、启动 DSH Bot，保存视频/日志。执行第 5.4 节所有 `rg`，输出完整调用图、安装/清理注册表、UI Slot 清单。

**门禁**：原版可运行、测试/构建有证据、两目录骨架建立、复制清单与未确认私有 API 标记清楚。若下载/Node/依赖阻塞，标记 **BLOCKED，不能记 PASS**。

### G1：工作群代码复制与单机双群共存

**任务**：复制原版完整群子系统；改为 `wg` 私有状态；消除重复 `install`/监听/工具名；完成本地/工作群两个群列表及页面切换的最小实现。此时只使用本地测试消息，不联网。

**门禁**：两类群各自创建、改名、@、讨论、进度、Stop、删除、恢复；本地群功能完全不回归；Session 归属、消息和 Waiter 不串群；热重载/关闭无重复监听；准确保存差异清单。

### G2：原生 Bot Task Session 与工具级安全 P0

**任务**：正式持久化 `TaskSessionRegistry` 与 `resolveSessionOwnerStrict()`，实测原生 Bot 身份、prompt、模型/能力、Session Part、工作目录、权限与撤权。用本地审批模拟链路验证隔离 Session。

**门禁**：原生 B Bot 真正执行，不靠复制提示词模拟；未授权工具拒绝；目录穿越、符号链接、`run_code`、MCP、群外 `message_bot` 旁路、撤权和恢复均有拒绝用例。**G2 未通过不得开展远程真实工具调用。**

### G3：Hub 认证、设备与演示节点

**任务**：Hub HTTP/WSS 最小服务与数据库迁移；接入真实短信供应商；注册/登录/刷新/登出、设备密钥、凭证安全存储；Bot 设置 Hub 账号页；证书配置与访问日志脱敏。

**门禁**：两个不同手机号的有效 OTP 分别创建两个 Hub 用户；同一手机号换机保持 userId；无效/过期/重放验证码被拒；设备撤销即时断线；未登录本地 Bot 仍完整可用。没有真实短信服务不可标记“手机号认证通过”。

### G4：双机实时群聊与升级

**任务**：Bridge 保持 WSS；Hub 群/成员/邀请/消息持久化；Bot Endpoint 发布；独立工作群 UI；本地群“升级为工作群”的幂等关联与原群归档。

**门禁**：两台真机实时群聊；断网/重连/重放/乱序/重复 ACK 正常；本地群历史不自动上传；升级失败重试不重复建群；DSH 菜单“插件”位置保持且 “Bot”入口唯一；工作群交互与原版对照无明显违和。

### G5：跨用户 Bot 委派与本人审批

**任务**：请求、Hub 路由、B 本人审批三种分配、BotAdapter 执行、进度/成果、取消、附件授权分享；单协调者租约与事件围栏。

**门禁**：A 请求 B，B 拒绝时 B 无模型/工具执行；批准后目标真实 Bot 在 B 本机运行；出单设备明确；伪造批准/过期/撤权/群外访问被拒；任务至少一次投递仍不重复执行副作用。

### G6：群记忆、恢复、完整验收和交付

**任务**：Group Memory 检索、来源/版本/ACL/纠错/删除；整合附件、审计、重启恢复、性能与安全；Electron Windows/macOS 冷启动和插件安装卸载回归；整理运行手册和 Demo。

**门禁**：V1 群记忆可用且与私人记忆隔离；断网重启不泄漏、不乱序、不误恢复；关键安全用例通过；所有代码/测试/迁移/配置示例在两个目录内；交付最终验收报告。

## 15. 测试与验收矩阵（须生成真实证据）

| 编号 | 场景 | 必须观察到的结果 | 优先级 |
|---|---|---|---|
| T01 | 原版 Chief、Bots、私聊、本地群回归 | 原行为保持 | P0 |
| T02 | 双群同时活动、同 Bot 参与两个群 | Session 与轮次独立，无串群 | P0 |
| T03 | 复制版注册/卸载/热重载 | 没有同名工具、双事件 | P0 |
| T04 | Session 上下文压缩/Part 切换 | 真实 Bot 身份/授权仍正确 | P0 |
| T05 | Hub 手机 OTP 错误/过期/重复 | 拒绝，限流，正常日志脱敏 | P0 |
| T06 | 同一手机号第二设备登录、吊销 | 稳定用户，设备可独立撤销 | P0 |
| T07 | Hub 离线，本地 Bot 正常使用 | 本地功能不受影响 | P0 |
| T08 | 双机聊天、附件、成员邀请 | 权限正确，事件顺序一致 | P0 |
| T09 | Hub/Bridge 断电重启 | 未 ACK 重传，幂等去重 | P0 |
| T10 | 本地群升级，失败重试 | 一个工作群、旧历史保留不上传 | P0 |
| T11 | A 请求 B，B 未批准 | B 不执行任何任务工具 | P0 |
| T12 | B 批准三种派单模式 | 执行 B 的真实目标 Bot | P0 |
| T13 | 修改请求 `senderId`/伪造批准 | 无法越权或冒充 B | P0 |
| T14 | 路径穿越/符号链接/非法 cwd | 拒绝且不回退到团队目录 | P0 |
| T15 | `run_code`/MCP/群外 `message_bot` 绕过 | 实际工具边界拒绝 | P0 |
| T16 | 执行中撤权/取消 | 新操作失败、可取消作业停止 | P0 |
| T17 | 任务副作用后 ACK 丢失 | 无盲目重复执行 | P0 |
| T18 | 群记忆按角色/离群/删除 | 未授权不可检索，引用与纠错完整 | P0 |
| T19 | Bot UI 与原版视觉对照 | 布局/输入/@/菜单/消息主要行为一致 | P1 |
| T20 | Windows/macOS Electron 冷启动 | 插件与 Hub 设置正常，原版功能正常 | P0 |

对每个用例存储：测试环境/版本 SHA、步骤、期待值、实际值、日志文件、截图或录屏、失败复现路径、结论 PASS/FAIL/BLOCKED。源码级推断和模拟结果不能代替双电脑验收。

## 16. AI 实施策略与每轮交付格式

### 16.1 AI 允许自主处理的设计细节

在不违反冻结架构情况下，可自行选择 Hub SQLite 驱动、React 数据适配方式、SMS Provider 抽象、API 校验库等；优先选择成熟、最简单、最少依赖方案。任何版本或不稳定私有 API 均应从源代码确认，不允许编造调用签名。

### 16.2 需要立即反馈的阻塞问题

- DSH 真实版本没有稳定的 Bot Task Session 身份延续接口，且经 Fork 最小扩展仍无法保证权限或恢复。
- DSH 官方 Slot 无法在规定位置增加 Bot 导航，或无法承载原版风格工作群 UI。
- DSH Tool Guard 无法覆盖具体被允许的执行工具、PTC、MCP、文件或网络操作。
- 演示 Hub 无法取得有效 TLS 证书或真实短信服务。

出现阻塞时须给出源码/日志证据、最小替代选择、对既定架构的影响；**不要静默改成另一种产品路线，也不要未经同意扩展上游完整 Runtime**。

### 16.3 每阶段必须提交

1. `变更摘要`：做了什么、没做什么、风险。
2. `源文件清单`：复制来源版本、复制目标、必要改动、与上游差异。
3. `命令与输出`：构建、测试、启动/运行、Lint。
4. `证据`：日志、真机/模拟等级、截图、验收用例编号。
5. `遗留问题`：按 P0/P1/P2，明确阻塞与否。
6. `下一阶段入场判据`：前一门禁 PASS 后才继续。

### 16.4 AI 的第一条执行指令（可直接复制）

> 阅读本方案全文。首先只执行 G0：在仓库中建立且仅建立 `hub/` 和 `bot-plugin/` 两个一级目录；将 DeepSeek-Bot v0.1.7 的 `ds-bot` 插件完整 Fork 到 `bot-plugin/`，保留许可证与 NOTICE；核验适配的 DSH 版本和完整源码，真实执行原版构建/测试；以 `groups.js` 为中心生成跨文件依赖与注册审计报告，列出精确复制范围、共享 Runtime 入口、重复工具/事件/Session 风险及测试设计。**不要先写 Hub 业务或工作群新 UI，不要声称任何 G1–G6 已通过。** G0 完成后输出运行证据和明确的 G1 任务清单。

## 17. 风险、决策与变更管理

| 风险 | 严重性 | 处理原则 |
|---|---|---|
| Task Session 无法安全保持原生 Bot 身份 | 阻塞 | 先最小 Fork 扩展和真实测试，不用普通 Agent 冒充 |
| 重复模块安装导致本地群回归 | 阻塞 | 单 Runtime；注册审计、域分发和回归 |
| DSH Slot 实际版本不同 | 高 | 锁版验证，保持 Bot 内部导航；不靠 DOM/CSS hack |
| Hub 管理员可见明文 | 高 | 明确 V1 TLS 与存储信任模型；敏感成果默认 B 审核 |
| SMS 供应商或内网 DNS/TLS 不可用 | 高 | 正式短信接入为认证门禁；不以模拟通过冒充 |
| 跨设备任务重复执行 | 阻塞 | 幂等状态机、日志、人工检查未知副作用 |
| 用户切换账号导致缓存泄漏 | 阻塞 | 分区存储、注销吊销、切换前停止远程任务 |
| 上游 DS Bot 继续更新 | 中 | 保留复制来源 SHA、差异清单；定期回归而非盲目合并 |
| 群记忆泄漏已撤销权限内容 | 阻塞 | ACL+来源+权限变更后的重新过滤与删除 |

**已确定、不再反复讨论的架构决策**：两目录；Fork DS Bot；原版 Bot UI 和功能作为主体；复制完整群业务形成独立 Workgroup；Hub 协调、本机原生 Runtime 执行；Bot 设置 Hub 手机认证；本人审批；本地/工作群/记忆隔离；V1 群记忆。

**实施前仍须落地的运行参数**：演示 Hub 真实地址和证书、短信服务商凭证、DSH 兼容 commit SHA、目标操作系统实际测试设备和授权文件目录。这些是部署输入，不是允许重新选择另一套架构的理由。

## 18. 交付清单与最终完成定义

- `hub/`：可启动 Hub、数据库迁移、正式 OTP、HTTPS/WSS、群消息/任务/审批/群记忆/附件、权限检查、合同测试和运行说明。
- `bot-plugin/`：完整原版 Fork、独立复制工作群、Bot 设置 Hub 认证、导航、Bridge、BotAdapter、审批、升级、独立群记忆访问及原版回归。
- 可重现的双电脑演示：A/B 各认证用户、建群/邀请、真人聊天、@远端 Chief、B 本人批准/拒绝、真实 Bot 任务、结果回传、撤权和恢复。
- 真实测试报告、负向安全测试、源代码差异/许可证说明和运行部署手册。
- 只有全部 P0 门禁通过并提供证据，V1 才能宣布验收。**本计划书交付本身不代表任何开发门禁已通过。**

---

**版本与来源说明**：本文是 2026-10-21 已确认需求的实施蓝图；引用公开 GitHub 代码与官方文档。任何用户要求明确确认后才可变更上述冻结产品/技术约束。遇到源码与本文的接口示意不一致时，以实际锁版源码为准，先记录差异，再做最小安全适配。
