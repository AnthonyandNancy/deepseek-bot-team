> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g3/PLAN.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G3 实现计划（待确认，未写任何代码）

> 门禁：`Workgroup-AI/docs/plans/2026-10-22-workgroup-migration.md` §14 G3，认证方式按用户决定
> 改为**手机号 + 密码**（不建 `otp_challenges`、不写任何短信代码、不做找回密码）。
> 判据采用 `docs/workgroup/g3/NEXT-INSTRUCTION.md` 里「替换后的门禁」五条。
>
> 本文件是**计划**。确认前不落代码。

---

## 0. 先说三件当前做不到的事

写在最前，因为它们影响计划的形状，不是事后补的注脚。

| 做不成的 | 原因（已实测，非推测） | 本计划的处理 |
|---|---|---|
| 「设备私钥与 refresh 留在 OS 安全存储」 | 插件宿主进程里 `require('electron')` 解析不到，拿不到 `safeStorage`；Node 无内置钥匙串；接 Windows DPAPI 必须引原生模块，违反"两目录 + 最小依赖"。 | 用 harness 的 `ctx.credentials` 接缝（`$DSH_HOME/.credentials.yaml`，0600，seam 自己拒绝组/其他人可读）。**这是加密边界清晰的 0600 文件，不是 OS 钥匙串**，如实登记为缺口，G6 再议。 |
| `ctx.credentials` 可能不存在 | 在本机 desktop profile 的 `node_modules` 里没检出 `dsh-credentials-local` 被加载。 | 启动时探测 `ctx.get('credentials')`；不存在则回退到 `~/.dsh/bot/hub/device.json`（0600，写入前显式 `chmod`）。两条路径都测。 |
| 找回密码 | 用户明确决定不做；手机号未验证也没有自证通道。 | 按决定不做。记入缺口表并注明 **G4 前必须补**。 |

另外声明一条**不适用**：门禁原文三条 OTP 项失去对象，标"不适用"，由替换后的五条取代。不实现假 OTP。

---

## 1. Hub 目录结构（`hub/`）

```
hub/
  package.json            依赖只有 ws；scripts: start / test / check
  README.md               运行方式、环境变量、TLS 自签步骤、依赖理由、缺口
  .gitignore              .data/
  src/
    index.js              createHub(config) 供测试；直接运行时监听
    config.js             环境变量解析；TLS 判定；拒绝非回环明文
    router.js             method + 路径模式（含 :id）匹配，无框架
    http.js               node:http / node:https 绑定、JSON body、错误封套
    log.js                JSON 行日志 + 脱敏
    audit.js              audit_events 写入
    db/
      index.js            打开、PRAGMA、迁移、版本
      migrations.js       001_init（G3 四张活表）
    auth/
      passwords.js        scrypt PHC 编码/校验/策略/假校验
      tokens.js           不透明 token 生成、sha256、轮换
      service.js          register / login / refresh / logout / me
      limiter.js          进程内滑动窗口
    devices/
      service.js          challenge / register / list / revoke（Ed25519）
    ws.js                 WSS 握手绑定 + 撤销踢线 + 心跳
  test/
    fixtures/test-cert.pem, test-key.pem     自签测试证书（仅测试；默认配置永不加载）
    *.test.js
```

**依赖决策：`ws` 8.x 写进 `hub/package.json`。** 理由：G3 的 WSS 虽然只做"握手 + 踢线 + 心跳"，
但手写帧解析（掩码、分片、close 码、ping/pong）是安全通道上最不该自己发明的东西。除 `ws`
外**不加任何依赖**（无框架、无 ORM、无 JWT 库），SQLite 用内置 `node:sqlite`（已在 DSH 实际
运行的 Node 24.21.0 上验证可用）。

---

## 2. 数据库与迁移

`node:sqlite`，文件位置 `HUB_DATA_DIR`（默认 `hub/.data/hub.db`）。打开时依次执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

迁移用 `schema_version` 表记录，逐版在一个事务里应用；重复运行必须幂等（测试断言）。

### 2.1 G3 的四张活表（迁移 001）

```sql
CREATE TABLE users (
  id                  TEXT PRIMARY KEY,          -- 'usr_' + 随机
  phone_e164          TEXT NOT NULL UNIQUE,      -- 规范化后的登录名
  phone_verified_at   TEXT,                      -- 恒为 NULL：未做短信验证
  password_phc        TEXT NOT NULL,             -- scrypt$N=..,r=..,p=..$salt$hash（base64url）
  password_version    INTEGER NOT NULL DEFAULT 1,-- 算法升级用
  status              TEXT NOT NULL DEFAULT 'active',
  created_at          TEXT NOT NULL
);

CREATE TABLE auth_sessions (
  id                TEXT PRIMARY KEY,            -- 'ses_' + 随机
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id         TEXT REFERENCES devices(id) ON DELETE SET NULL,
  access_hash       TEXT NOT NULL UNIQUE,        -- sha256(access token)
  access_expires_at TEXT NOT NULL,
  refresh_hash      TEXT NOT NULL UNIQUE,        -- sha256(refresh token)，轮换时整行替换
  refresh_expires_at TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  last_used_at      TEXT,
  revoked_at        TEXT
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE devices (
  id          TEXT PRIMARY KEY,                  -- 'dev_' + 随机
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key  TEXT NOT NULL,                     -- Ed25519 SPKI PEM；私钥永不入库
  name        TEXT NOT NULL,
  platform    TEXT,
  created_at  TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at  TEXT,
  UNIQUE (user_id, public_key)
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE audit_events (
  id        TEXT PRIMARY KEY,
  actor_id  TEXT,
  device_id TEXT,
  action    TEXT NOT NULL,
  target_id TEXT,
  result    TEXT NOT NULL,
  at        TEXT NOT NULL
);                                             -- 不存密码/token/完整手机号
```

### 2.2 需要你拍板的一点：§12 其余表要不要现在建

方案 §12 还有 `bot_endpoints`、`workgroups`、`memberships`、`invites`、`events`、
`deliveries`、`read_cursors`、`round_leases`、`tasks`、`approvals`、`artifacts`、
`group_memories`。指令写的是"**可以**建空表"，不是"必须"。

**我的建议：不建，留到 G4。** 理由：现在写这些列是照着方案猜的，G4 真正写查询时几乎必然
要改，那时仍然要加一次迁移；而空表会让人误以为 G4 已经动工。G4 从 002 开始照样连续。
（如果你更想要"表结构一次到位"，说一声，我按 §12 原样建空表并在 README 标注"未经使用"。）

---

## 3. 端点清单

错误封套统一：`{ "error": { "code": "auth/invalid-credentials", "message": "…" } }` + 对应 HTTP 状态码。
**永不返回完整手机号**，只返回 `phoneMasked`（如 `+86****8000`）。

### 3.1 认证

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| POST | `/v1/auth/register` | `{phone, password}` | 201 `{hubUserId, phoneMasked, accessToken, accessExpiresAt, refreshToken, refreshExpiresAt}` |
| POST | `/v1/auth/login` | `{phone, password}` | 200 同上 |
| POST | `/v1/auth/refresh` | `{refreshToken}` | 200 `{accessToken, accessExpiresAt, refreshToken, refreshExpiresAt}`（refresh 已轮换） |
| POST | `/v1/auth/logout` | `Authorization: Bearer <access>` | 204 |
| GET | `/v1/auth/me` | `Authorization: Bearer <access>` | 200 `{hubUserId, phoneMasked, createdAt, session:{id, deviceId, accessExpiresAt}, devices:[…]}` |

失败码：`auth/invalid-phone`(400)、`auth/weak-password`(400)、`auth/phone-taken`(409)、
`auth/invalid-credentials`(401)、`auth/rate-limited`(429, 带 `Retry-After`)、`auth/invalid-token`(401)。

### 3.2 设备

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/v1/devices/challenge` | `{deviceName, publicKey}` | 200 `{challengeId, nonce, expiresAt}` |
| POST | `/v1/devices/register` | `{challengeId, signature, listName, platform}` | 200 `{deviceId}` |
| GET | `/v1/devices` | — | 200 `{devices:[{deviceId,name,platform,createdAt,lastSeenAt,revokedAt,current}]}` |
| POST | `/v1/devices/:id/revoke` | — | 204，并**立即断开该设备所有 WSS 连接** |

签名内容：`challengeId + '.' + nonce`，Ed25519 私钥签，服务端用登记的 `publicKey` 验。
challenge 一次性、5 分钟过期、内存存放（重启即失效，登记为已知取舍）。
已撤销的公钥再次注册**拒绝**（`device/key-revoked`），必须换新密钥对。

---

## 4. 密码与令牌

### 4.1 密码（`auth/passwords.js`）

- `scrypt`，参数 `N=32768, r=8, p=1, maxmem=64MiB`，`dkLen=32`，每用户 16 字节随机盐。
  **`maxmem` 必须显式传**：实测在 Node 上默认值会直接抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`。
- 存成 PHC 风格单串：`scrypt$N=32768,r=8,p=1$<salt-b64url>$<hash-b64url>`，
  另存 `password_version` 便于以后换算法。库里**没有** `password_salt` 单独的明文列，
  也没有任何可逆形式。
- 校验用 `timingSafeEqual`，长度不等先比长度再恒定失败。
- 策略：`10 ≤ 字符数 ≤ 128 字节`；拒绝与手机号数字部分完全相同的密码；
  **不强制**大小写/符号组合（强制组合会诱导 `Password1!` 这类更差的密码）。
- 常量时间：`login` 遇到不存在的手机号时，对一把**固定的假 PHC** 跑一次同样参数的 scrypt，
  再返回与"密码错"完全相同的响应。

### 4.2 令牌（`auth/tokens.js`）

- 不透明随机 token，非 JWT：`dsb_at_` / `dsb_rt_` + 32 字节 base64url。
  选不透明而非 JWT 的原因：撤销要**立即**生效（门禁"设备撤销即时断线"依赖它），
  JWT 需要维护吊销名单反而更复杂。
- 库内只存 `sha256(token)`，**DB 里没有任何 token 明文**。
- access 30 分钟、refresh 30 天（`HUB_ACCESS_TTL` / `HUB_REFRESH_TTL` 可覆盖）。
- refresh 轮换：校验旧 refresh → 同一事务内换新 `refresh_hash` 与 `access_hash`；
  旧 token 立刻查不到 → 401。
- `logout` / 设备撤销 → `revoked_at` 置位，access 与 refresh 一起失效。

### 4.3 限流（`auth/limiter.js`）

进程内滑动窗口，键为 `phone` 与 `ip`：

- `login`：15 分钟内同 `phone+ip` 失败 10 次 → 429。
- `register`：1 小时内同 `ip` 5 次 → 429。
- 成功登录清零该键。

重启即清零、多实例不共享——V1 单实例可接受，**登记为已知取舍**。

---

## 5. TLS 与本地例外

`config.js` 的判定顺序（有测试逐条覆盖）：

1. `HUB_TLS_CERT` + `HUB_TLS_KEY` 都在 → **HTTPS/WSS**，正常启动。
2. 否则若 `HUB_ALLOW_INSECURE_LOCALHOST=1` → 明文 HTTP，**但**：
   - 默认只绑 `127.0.0.1`；
   - **每个请求**检查 `req.socket.remoteAddress`，非回环（`127.0.0.1`/`::1`/`::ffff:127.0.0.1`）
     一律 403 `hub/plaintext-refused`；
   - 启动时打一条醒目 WARN。
3. 都没有 → **拒绝启动**，退出码非 0，错误信息说清"密码只允许走 TLS，要么给证书，要么显式开本地例外"。

测试证书用 `test/fixtures/test-cert.pem`（自签、仅测试、文件名即声明用途），
**默认配置不会加载它**——有一条测试断言 `HUB_TLS_CERT` 未设时不会读 fixtures。

---

## 6. WSS（最小，只为证明门禁）

- 端点 `GET /v1/ws`，握手参数：`?access=&deviceId=&ts=&nonce=&sig=`
- 校验顺序：access 有效 → `deviceId` 属于该 `hubUserId` 且未撤销 → `ts` 在 ±120s 内 →
  `nonce` 未用过（内存 LRU + TTL）→ Ed25519 验 `sig` over `deviceId.ts.nonce`。
- 通过后登记 `connections: Map<deviceId, Set<WebSocket>>`，服务端发 `hello`。
- 心跳：服务端每 30s `ping`，60s 无 `pong` 则 `terminate`。
- `POST /v1/devices/:id/revoke` → 立刻对集合里每个 socket `close(4401, 'device revoked')`。
- **不做消息扇出**（G4）。收到的任何业务消息一律回 `error/unsupported`。

---

## 7. 日志脱敏

`log.js` 输出 JSON 行，字段白名单化：

- 手机号：**只保留末 4 位**，形如 `+86****8000`；原始值永不进日志。
- `password` / `passwordHash` / `token` / `accessToken` / `refreshToken` / `privateKey` /
  `signature` 这些键**直接替换为 `[redacted]`**（按键名，不靠正则猜）。
- 请求体**从不记录**（手机号和密码都在 body 里）。
- 请求行只记 `method`、`path`（`:id` 段用实际值没关系，设备 id 不是机密）、`status`、
  `durationMs`、`ip` 截断。

测试：跑一次完整 register + login + refresh，把日志写到内存流，断言其中不含明文密码、
不含任何 token 原文、不含完整手机号。

---

## 8. 插件侧（`ds-bot/`）

### 8.1 落点

| 文件 | 性质 | 说明 |
|---|---|---|
| `src/workgroup/host/hub.js` | **新增** | Hub HTTP 客户端 + 本地账号/设备存储 + 七个 `hub-*` 端点 |
| `src/workgroup/host/hub-store.js` | **新增** | 凭据落盘：`ctx.credentials` 优先，0600 文件回退 |
| `src/workgroup/client/hub-settings.js` | **新增** | 「Hub 账号」页组件 |
| `src/client/settings.js` | 改（已登记修改） | 加一条 `SETTINGS_PAGES`、一个图标、一行渲染、一个 import |
| `src/client/i18n.js` | 改（已登记修改） | 新文案的中英条目 |
| `src/workgroup/host/channel.js` | 改（已登记修改） | 加 `hub-*` 分发 |
| `src/workgroup/index.js` | 改 | 把 `hub.js` 加入 `WG_MODULES`（`wg.bridge` 这个占位符正是为它留的） |

**为什么放在工作群域而不是原版 `src/host/`**：Hub 连接属于远程域，`wg.bridge` 占位符和
`README` 的注释已经写明"filled in G3+"。放这里可以不碰原版群聊的任何代码路径。
代价是设置页（原版 UI）要 import 工作群的组件——只加 4 行，且在 diff-manifest 里可见。

### 8.2 端点（挂在既有 `WG_ROUTE = 'api/workgroup'` 上，不新开路由）

`hub-state`、`hub-register`、`hub-login`、`hub-logout`、`hub-refresh`、`hub-devices`、
`hub-revoke-device`、`hub-refresh-devices`。

**响应里永不出现**：设备私钥、refresh token、access token、完整手机号。
access token 只留在宿主内存，页面拿不到。

### 8.3 凭据存放（对应指令第 11 条）

- `state.json` 只写非机密：`{ hubUserId, phoneMasked, deviceId, baseUrl, loggedInAt }`。
- refresh token 与设备私钥写 `ctx.credentials` 记录 `ds-bot/hub-account`；
  无该服务时写 `~/.dsh/bot/hub/device.json`（`chmod 0600`，写前若已存在且权限过宽则先纠正）。
- **密码**：只在提交那一刻存在于内存，不落盘、不建缓存键、不进日志。
- access token：只在宿主内存，进程重启后靠 refresh 重新换。

### 8.4 「Hub 账号」页的五个状态

用原版 `SetSection` / `SetRow` / `bt-set-*` 样式，不新造视觉：

1. **未配置节点**：节点地址输入 + 保存；说明"留空即只用本地功能"。
2. **已配置 / 未登录**：TLS 状态徽标（`TLS 已连接` / `明文·仅本机`）、国家码下拉（默认 +86）、
   手机号、密码；`登录`、`注册` 两个按钮；注册时多一个确认密码框。
3. **已登录**：脱敏手机号、`hubUserId`（可复制）、当前设备名与在线状态、设备列表（每行 `撤销`）、
   `退出`、`重新连接`。
4. **错误**：复用 `bt-error` 行内条，文案来自 Hub 的 `code`，不显示原始响应体。
5. **离线 / Hub 不可达**：顶部一行"未连接 Hub，本地功能不受影响"，其余不变灰。

### 8.5 未登录可用性（对应指令第 10 条）

- `hub.js` 不注册任何 `on()` 监听原版事件，不拦截原版工具，不改 `rt` 上任何原版字段。
- 所有 `hub-*` 端点未登录时返回 `{ok:true, value:{loggedIn:false,…}}`，**不是错误**。
- 验收靠现有 791 条测试全绿 + 新增一条"Hub 完全不可达时原版团队端点仍正常"的测试。

### 8.6 切换账号

`hub-login` 发现 `hubUserId` 与当前不同 → 先删旧凭据记录、清空内存缓存、置
`switchedFrom` → 再写新凭据。测试断言：切换后旧 refresh token 不再被使用，
`hub-state` 不再报告旧 `hubUserId`。
G3 阶段本地没有按用户分区的业务数据（工作群持久化是 G4），所以"命名空间切换"目前
只是清凭据 + 清缓存；**真正的数据分区随 G4 落地时一起做**，登记在缺口表。

---

## 9. 测试清单（每条对应一条门禁或一条硬约束）

### hub/test/

| 文件 | 断言 | 对应 |
|---|---|---|
| `db-migrate.test.js` | WAL / FK / busy_timeout 生效；迁移跑两次幂等；`schema_version` 正确 | 任务第 1 项 |
| `auth-register.test.js` | 两个手机号 → 两个不同 `hubUserId`、互不可见；重复手机号 409；弱密码 400；响应含 `phoneMasked` 不含完整手机号 | **门禁 1** |
| `auth-login.test.js` | 对密码成功；错密码 / 不存在手机号 → **同一 code、同一 message、同一状态码**；两条路径各跑一次 scrypt（注入计数器断言）；连续失败触发 429 | **门禁 3** |
| `auth-refresh.test.js` | 轮换后旧 refresh 401；logout 后 access 立即 401 | 任务第 2 项 |
| `devices.test.js` | challenge→register 成功；错签名拒绝；撤销他人设备 403；撤销后该设备公钥不能再注册 | 任务第 5 项 |
| `ws-revoke.test.js` | 真 `ws` 客户端连上 → 撤销 → 1 秒内收到 close 4401 | **门禁 4** |
| `ws-handshake.test.js` | 无 access / 过期 access / 他人 deviceId / 重放 nonce / 错签名 全部拒绝 | 任务第 6 项 |
| `tls.test.js` | 无证书无例外 → 拒绝启动；`HUB_ALLOW_INSECURE_LOCALHOST=1` + 回环 → 可用；非回环来源 → 403；有证书 → HTTPS 可用；默认不加载 fixtures 证书 | 任务第 7 项 / 指令 TLS 条 |
| `log-redaction.test.js` | 完整流程后日志无明文密码、无 token 原文、无完整手机号 | 任务第 7 项 |
| `same-phone-new-device.test.js` | 同一手机号两套设备密钥分别登录 → **同一 `hubUserId`、不同 `deviceId`**，设备列表两行 | **门禁 2** |

### ds-bot/test/

| 文件 | 断言 | 对应 |
|---|---|---|
| `hub-store.test.js` | `state.json` 全文不含 token 与私钥；优先走 `ctx.credentials`；无该服务时文件 0600；权限过宽会被纠正 | 指令 11 |
| `hub-client.test.js` | 用桩 Hub 跑登录/刷新/撤销；网络失败时抛可读错误不崩；`hub-*` 响应不含 token/私钥/完整手机号 | 指令 10、11 |
| `hub-page.test.js` | 五个状态各渲染出预期控件（用既有 `client-render.mjs` + fake React）；不含"已验证"字样 | 指令 9 / 禁称条 |
| `hub-account-switch.test.js` | 换账号后旧 refresh 不再使用、旧 `hubUserId` 不再上报 | 指令 12 |
| `hub-offline.test.js` | Hub 地址不可达时，原版团队端点（`state`、`send`、群聊）仍正常返回 | **门禁 5** |
| 既有 791 条 | 全绿，两条连跑 | 不回归 |

### 反"假绿"要求

每新增测试在提交前逐条确认：**把实现改回原样，这条测试会不会红**。不会红的一律重写。
G2 里抓到过 3 条假绿（`at-menu` 早退、`untilWaiter` 定义了没用），这次不重复。

---

## 10. 已知缺口（交付时原样进表）

| 缺口 | 归属 |
|---|---|
| 找回密码缺失。**G3 阶段 Hub 内无业务数据，忘记密码=重注册，代价近零；G4 存了真实工作群之后，忘记密码就是丢群，必须在 G4 之前补上。** | G4 前 |
| 手机号未经验证（`phone_verified_at` 恒 NULL），任何输出不得称"已验证" | 长期（用户决定） |
| 设备私钥存 `$DSH_HOME/.credentials.yaml` 或 0600 文件，**不是 OS 钥匙串**（插件拿不到 `safeStorage`） | G6 |
| 限流在进程内存，重启清零、多实例不共享 | 生产化前 |
| refresh 重放家族撤销（检测到旧 refresh 被复用则整族作废）未做 | G4 前评估 |
| 设备 challenge 存内存，Hub 重启即失效（客户端重试即可） | 可接受 |
| 按 `hubUserId` 的本地数据分区随 G4 的持久化一起落地 | G4 |
| §12 其余 12 张表未建（本计划建议推迟） | G4 |
| WSS 无消息扇出 | G4 |

---

## 11. 提交方式

分四次提交，每次都能独立验证：

1. `hub/` 骨架 + 配置 + 日志 + DB 迁移 + `db-migrate` 测试
2. 认证（register/login/refresh/logout/me）+ 限流 + 密码 + 四个认证测试
3. 设备 + WSS + 撤销踢线 + 五个设备/WS 测试
4. 插件侧（hub 客户端 + 存储 + 页面）+ 五个插件测试 + diff-manifest 登记

每次提交前 `hub: npm test` 与 `ds-bot: npm run verify` 双绿，插件侧连跑两次。

---

## 12. 需要你决定的四件事

1. **§12 其余 12 张表现在建空表吗？**（我建议不建，理由见 §2.2）
2. **Hub 数据目录放哪？**（建议 `hub/.data/`，已加 `.gitignore`；也可改 `$DSH_HOME/hub`）
3. **access/refresh 有效期**？（建议 30 分钟 / 30 天）
4. **「OS 安全存储」这条我按 0600 凭据文件交付并登记缺口，可以吗？** 若不可接受，唯一
   替代是让用户每次启动手输口令，我不建议。
