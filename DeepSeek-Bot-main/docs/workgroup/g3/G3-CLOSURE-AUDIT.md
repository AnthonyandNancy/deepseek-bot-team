> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g3/G3-CLOSURE-AUDIT.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G3 门禁证据

> 判据：`docs/workgroup/g3/NEXT-INSTRUCTION.md` 的「替换后的门禁」五条（原三条 OTP 项**不适用**，
> 见下 §0）。计划：`docs/workgroup/g3/PLAN.md`。方案原文：`§14 G3`。
>
> 全部证据来自本机命令输出，不是推断。测试在 `hub/` 与 `ds-bot/` 两侧，均连跑两次。

---

## 0. 原门禁三条 OTP 项：标记「不适用」，不是「通过」

方案 §14 G3 原文以短信 OTP 为前提。用户决定 V1 用手机号 + 密码，因此：

| 原门禁项 | 处置 |
|---|---|
| 两个不同手机号的有效 OTP 分别创建两个 Hub 用户 | **不适用**。无 OTP。由 §1 等价项替代。 |
| 同一手机号换机保持 userId | **不适用**（措辞前提是 OTP 登录）。身份稳定性本身仍是判据，由 §2 覆盖。 |
| 无效/过期/重放验证码被拒 | **不适用**。由 §3（错误密码被拒、不可枚举、限流）替代。 |

**没有实现任何假 OTP。** `otp_challenges` 表不存在，`db-migrate.test.js` 有一条断言守着这一点：

```
✔ the G3 tables exist and the deliberately absent one does not
```

门禁原文最后一句「没有真实短信服务不可标记"手机号认证通过"」——本阶段**没有任何地方**
声称手机号已验证：`users.phone_verified_at` 恒为 NULL，有测试守着：

```
✔ a phone becomes a login name, never a verified identity
```

---

## 1. 门禁 1：两个手机号 → 两个独立用户

**证明**：`hub/test/auth-register.test.js`

```
✔ two phone numbers register two distinct users
✔ a registration response never carries the full phone number
✔ the same phone number cannot register twice
✔ a malformed phone number and a weak password are refused with distinct codes
✔ a phone typed with spaces and dashes is accepted and normalized
```

「独立」不是只数行数：两个 token 各自 `GET /v1/auth/me` 得到各自的 `hubUserId` 与不同的
脱敏号；另有 `two phone numbers never share a device list`（`same-phone-new-device.test.js`）
证明新账号不会继承别账号的设备。

**修复前会不会失败**：会。把 `const id = userId()` 改成固定 `'usr_shared'` 后复测：

```
✖ two phone numbers register two distinct users
ℹ pass 5, fail 1
```

**附加**：把完整手机号加进响应后复测：

```
✖ a registration response never carries the full phone number
ℹ pass 5, fail 1
```

---

## 2. 门禁 2：同一手机号换机 → hubUserId 不变、deviceId 变、旧设备仍在列表

**证明**：`hub/test/same-phone-new-device.test.js`

```
✔ the same phone on a second device keeps the same hubUserId
✔ both devices appear in the account device list
✔ a device registration binds the session to that device
✔ two phone numbers never share a device list
```

端到端（插件侧，对着真实 Hub 进程）：`ds-bot/test/hub-client.test.js`

```
✔ a second machine signing in the same account keeps the same hubUserId
```

这条断言的写法值得说明：它比较 `b.hubUserId === a.hubUserId` 且 `b.deviceId !== a.deviceId`，
再从任一台机器 `GET /v1/devices` 看到两行。

**修复前会不会失败**：会。`bindSession` 曾用原始 token 去比 `access_hash` 列（存的是摘要），
导致 session 永远绑不到设备：

```
✖ a device registration binds the session to that device   （修复前）
✔ a device registration binds the session to that device   （修复后）
```

---

## 3. 门禁 3：密码认证的正确性（拒绝 + 不可枚举 + 限流）

**证明**：`hub/test/auth-login.test.js`

```
✔ the correct password signs in
✔ a wrong password and an unknown phone answer identically
✔ an unknown phone spends the same password work as a known one
✔ repeated failures are rate-limited per phone number
✔ a successful login does not spend a rate-limit slot
✔ an invalid token is not accepted as a session
```

三条子判据分别对应：

- **同一句话、同一状态码**：`assert.deepEqual(wrongPassword.body, unknownPhone.body)` —— 整个
  响应体逐字段相等，不是只比 code。
- **同一耗时量级**：存在时不存在的手机号都跑一次 scrypt。断言两条路径均 >10ms 且比值在
  0.25–4 之间。实测约 50ms vs 50ms。
- **限流**：同手机号连续失败 10 次后 429，带 `Retry-After`。

**修复前会不会失败**：

| 破坏 | 结果 |
|---|---|
| 去掉假校验（未知手机号直接返回） | `✖ an unknown phone spends the same password work as a known one` |
| 未知手机号返回不同 code/message | `✖ a wrong password and an unknown phone answer identically` |

```
ℹ pass 5, fail 1   （两次破坏各复测一次）
```

**一处主动的例外并记录在案**：**注册**时重复手机号返回 409 而不是假装成功。理由是否则人
无法知道为什么登不进去；该端点限流并进审计，枚举变得昂贵而非不可能。这个取舍写在
`hub/README.md` 的 "Account enumeration" 一节，不是漏掉的。

---

## 4. 门禁 4：设备撤销即时断线

**证明**：`hub/test/ws-revoke.test.js`（真 WebSocket 客户端 + 真 HTTP 撤销）

```
✔ revoking a device closes its socket at once
✔ every connection of a revoked device is closed
✔ a handshake without a valid session is refused
✔ a signature over different bytes is refused
✔ a stale or replayed handshake is refused
✔ a device id belonging to another account is refused
✔ a revoked device cannot open a new socket
✔ the hub greets a good handshake as the session's own user
✔ a business message is answered as unsupported rather than ignored
```

「即时」是**测出来**的：断言 `close(4401)` 在 1000ms 内到达。可行性验证阶段实测 **2ms**。

**修复前会不会失败**：会。把 `onRevoked` 改成空函数后复测：

```
✖ revoking a device closes its socket at once (3170ms)
✖ every connection of a revoked device is closed (3222ms)
ℹ pass 7, fail 2
```

**一条测试设计上的自我纠正**（值得记录，因为第一版是假的）：最初断言「连接失败」，但 `ws`
库的 HTTP upgrade 在 `connection` 处理器之前就完成了，被拒的握手仍然会 **open 然后 close**。
那样的断言会为错误的理由通过。现在断言的是「以正确 code 关闭、且**从未收到 hello**」——
后者才是「没被认证」的实质证据。

去掉签名校验后复测：

```
✖ a signature over different bytes is refused
ℹ pass 8, fail 1
```

---

## 5. 门禁 5：未登录本地 Bot 仍完整可用

**证明**：`ds-bot/test/hub-offline.test.js`（走两条真实路由，不直接调内部函数）

```
✔ a signed-out domain reports "not signed in" without a Hub
✔ the local team is fully usable with the Hub signed out
✔ a Hub address that does not answer leaves the local team untouched
✔ the workgroup domain keeps answering with the Hub half signed out
✔ the hub endpoints refuse writes on a read-only host, like every other write
```

「完整可用」不是「设置页能渲染」，而是**逐项驱动原版端点**：`state` → `create-bot` ×2 →
`create-room` → 再看 `state` 里群在列表里。Hub 指向死端口（`127.0.0.1:1`）后再跑一遍。

**修复前会不会失败**：会。把原版 `create-room` 改成一律返回失败后复测：

```
✖ the local team is fully usable with the Hub signed out
ℹ pass 4, fail 1
```

（另有一次无效验证：我在 `groups.js` 里加了语法正确的无用常量，反而使整个模块加载失败，
那次结果不算数，已重做。）

---

## 6. 任务要求的四条硬约束

### 6.1 数据库迁移（WAL / 外键 / busy_timeout / 版本号）

`hub/test/db-migrate.test.js`

```
✔ the file is in WAL mode with foreign keys on and a busy timeout
✔ a foreign key violation is actually refused
✔ reopening an up-to-date database changes nothing
✔ the G3 tables exist and the deliberately absent one does not
✔ a phone number and a device key are each unique where they must be
✔ deleting a user takes its sessions and devices with it
✔ an in-memory database works, which is what the quick tests use
```

外键那条特意插入孤儿行证明 pragma **确实生效**，而不是只读回 pragma 的值。

### 6.2 密码存储（scrypt + 显式 maxmem）

`hub/test/primitives.test.js`

```
✔ a password verifies against its own hash and nothing else
✔ the hash carries its parameters and a fresh salt each time
✔ no reversible form of the password is stored
✔ scrypt runs with the explicit memory limit that N=32768 requires
✔ the dummy verification always fails and costs the same as a real one
✔ the password policy is length and not-the-phone, and nothing else
```

`maxmem` 那条是**实测结论**：Node 默认上限对 N=32768 直接抛
`ERR_CRYPTO_INVALID_SCRYPT_PARAMS`，不显式传就每次注册都炸。测试守着这一行。

### 6.3 TLS 强制

`hub/test/tls.test.js`

```
✔ starting without TLS and without the explicit opt-in is refused
✔ a certificate and key are used together or not at all
✔ the loopback opt-in is explicit and yields a loopback-only config
✔ ttl and port values are validated rather than taken on trust
✔ loopback addresses are recognised in every form a listener reports
✔ a plaintext hub refuses a request that did not come from this machine
✔ a TLS hub serves HTTPS and prints no plaintext warning
✔ the test certificate is only ever loaded when it is asked for
✔ login over a trusted TLS connection works end to end
```

三点值得单说：

1. 开关值必须是**精确的 `1`**，`true`/`yes`/`TRUE` 一律不开。打错字不能悄悄起明文服务。
2. 回环检查是**逐请求**的，不是只在启动时。监听器可能因为反代或容器网桥变成外部可达。
3. 测试**不用** `NODE_TLS_REJECT_UNAUTHORIZED=0`，而是把自签证书作为 `ca` 传给客户端，
   信任是真的。

移除回环守卫后复测：

```
✖ a plaintext hub refuses a request that did not come from this machine (108ms)
ℹ pass 8, fail 1
```

（第一版这条在破坏后是**超时 15s** 而非失败——因为 handler 卡在读 body。已改成喂真实 body，
现在快速失败。）

### 6.4 日志脱敏

`hub/test/log-redaction.test.js`

```
✔ a real session leaves no password, token, or full phone number in the log
✔ the audit trail keeps a masked phone, and the access log keeps none at all
✔ every secret-shaped key is replaced, whatever its case
✔ a secret quoted into free text is redacted too
✔ the logger writes one JSON object per line
✔ an error object is logged without its stack or its secret message
✔ a custom stream is the only place lines go
```

跑完 register → login → 设备注册 → refresh → logout 全流程，然后在日志里搜：明文密码、
四个 token 的全部原文、公钥、完整手机号、国内格式手机号——全部不出现。

**修复前会不会失败**：会。把请求体加进日志后复测：

```
✖ a real session leaves no password, token, or full phone number in the log
✖ the audit trail keeps a masked phone, and the access log keeps none at all
ℹ pass 5, fail 2
```

**一处自我纠正**：第一版断言「日志里有脱敏手机号 `8000`」，实测是**假的**——访问日志根本
不含手机号（只记 method/path/status，因为手机号在 body 里而 body 从不记录）。已改为断言真实
事实：访问日志**没有任何**手机号（连脱敏的都没有），脱敏号只出现在 `audit_events`。

---

---

## 6.5 找回密码（用户追加要求，G3 内闭环）

原计划把「找回密码」标为 G4 前必须补的缺口。用户要求在 G3 补齐，已实现三层并用同一个原则贯穿：
**任何一次找回都结束其他所有会话并撤销所有设备**——找回的语义就是「之前有权限的人必须失去权限」。

| 层 | 需要什么 | 适用 |
|---|---|---|
| `POST /v1/auth/password` | 会话 **且** 当前密码 | 记得密码，只是要换 |
| `POST /v1/auth/recover` | 恢复码 | 机器没了（被偷、重装、硬盘坏） |
| `node src/cli.js reset` | 手机号 **且** 数据库文件 | 用户什么都没有 |

**为什么运维重置不是端点**：它需要手机号 *加上* 数据库文件访问权，等同于直接改库。做成 HTTP
就是一个只靠密码保护的后门，而且是在唯一控制所有密码的端点上。

### 证据

`hub/test/recovery.test.js`（20 条）

```
✔ a signed-in user can change their password with the current one
✔ changing the password ends every other session
✔ changing the password requires the current one
✔ a new password must differ and must pass the policy
✔ a recovery code is shown once and only its digest is stored
✔ an unused code is reported without revealing it
✔ a recovery code recovers the account and returns a working session
✔ a recovery ends every session and revokes every device
✔ a recovery code works exactly once
✔ a wrong code and an unknown phone answer identically
✔ a malformed code is refused as invalid, not as a server error
✔ a weak new password is refused before the code is spent
✔ recovery attempts are rate-limited
✔ the operator can reset a password, ending every session
✔ the operator command refuses an unknown account and a weak password
✔ the operator summary shows no secret
✔ every password change is audited, and no audit row holds a secret
```

`hub/test/cli.test.js`（7 条，以**子进程**跑真实命令，因为「需要数据库文件」这个设计主张
只有这样才能证明）

```
✔ --help explains the two commands
✔ a missing database is refused with a path a person can act on
✔ show reports the account without printing a secret
✔ reset changes the password and kills the sessions the user cannot get out of
✔ reset refuses an unknown account, a weak password, and a national-format number
✔ a missing argument is refused rather than guessed
✔ reset is audited, so a surprise password change is answerable
```

`ds-bot/test/hub-client.test.js` 新增 7 条，含「恢复码不落盘」「恢复会签出旧机器」
「改密码保留本机、结束其他机器」。

**修复前会不会失败**（破坏性复测）：

| 破坏 | 结果 |
|---|---|
| 找回时不结束其他会话 | `✖ changing the password ends every other session`、`✖ a recovery ends every session and revokes every device` |
| 不消耗恢复码（允许重用） | `✖ a recovery code works exactly once` |
| 接受任意恢复码 | `✖ a wrong code and an unknown phone answer identically`、`✖ a malformed code is refused as invalid` |

### 过程中的两处自我纠正

1. **恢复码字母表的注释曾经是错的。** 第一版写「base32 避开 0/O 和 1/I」，但 RFC 4648 的
   `A-Z2-7` 字母表**包含 I 和 O**。改成去掉 `I/O/0/1` 的自定义 32 符号表（24 字母 + 2–9），
   并让测试从导出的常量构造正则，避免两边再次漂移。
2. **测试把 `health` 端点从客户端里挤掉过一次。** 插入恢复方法时替换了相邻的一段，全量测试
   立刻报 `client.health is not a function`。已补回。

### 仍存在的限制

- 恢复码是**持有型**凭据：看到那张纸的人就能接管账号。无发送通道时没有更好的方案。
- 密码被重置**不会通知本人**（没有发送通道），本人只能在下次登录时发现。
- 创建新恢复码**不会作废旧码**，每个码各用一次。这是有意的：否则一次误操作就能作废写好的纸。

## 7. 插件侧：凭据存储（指令第 11 条）

`ds-bot/test/hub-store.test.js`

```
✔ with no credential service the account is kept in an owner-only file
✔ with the credential service present, the seam is used and no file is written
✔ a seam that fails to read falls back instead of locking the user out
✔ clearing removes the record from both stores
✔ an incomplete payload is refused rather than half-written
✔ a corrupt file reads as "no account" rather than throwing
✔ the store says where it keeps things, so the page can tell the truth
```

`ds-bot/test/hub-client.test.js` 里另有三条：

```
✔ the password never reaches the stored record
✔ the account view never carries a token or a private key
✔ signing out clears the local record even when the Hub cannot be reached
```

「密码不落盘」是读文件全文断言的，不是检查字段名。

---

## 8. 明确未达成 / 已知缺口

| 缺口 | 为什么 | 归属 |
|---|---|---|
| **「凭证存 OS 安全存储」只做到 0600 凭据文件** | 插件宿主进程里 `require('electron')` 解析不到，取不到 `safeStorage`；Node 无内置钥匙串；引原生模块违反「两目录 + 最小依赖」。这是计划 §0 事先登记的，不是事后发现 | G6 |
| ~~无找回密码~~ **已补齐** | 用户要求后实现三层：恢复码（登录后按需生成，一次性，scrypt 存储）、登录态改密码（需当前密码）、运维命令行重置（需数据库文件）。三者都结束其他所有会话并撤销所有设备 | G3 内已闭环 |
| 恢复码是持有型凭据：看到纸的人就能接管账号 | 无短信/无邮件前提下无更好选择；这是设计固有的，不是缺陷 | 固有 |
| 密码被重置时不通知本人 | 没有发送通道；只能在本人下次登录时发现 | G4（需通道） |
| 手机号未验证（`phone_verified_at` 恒 NULL） | 用户决定不做短信 | 长期 |
| 限流在进程内存，重启清零、多实例不共享 | V1 单实例可接受；数据库限流会给每次失败登录加一次写 | 生产化前 |
| 无 refresh token 家族撤销（旧 refresh 被复用时只作废该行，不作废整族） | 需要家族标识列 | G4 前评估 |
| 设备 challenge 存内存，Hub 重启即失效 | 客户端重试即可 | 可接受 |
| WSS 无消息扇出、无 seq/游标/投递确认 | G4 范围 | G4 |
| §12 其余 12 张表未建 | 空表会让人误以为 G4 已动工；列名在 G4 写查询前是猜的 | G4 |
| 按 `hubUserId` 的本地数据分区 | G3 本地无按用户分区的业务数据 | G4 |

---

## 9. 汇总

| 项 | 结果 |
|---|---|
| 门禁 1（两手机号两用户） | **通过** |
| 门禁 2（换机保持 userId） | **通过** |
| 门禁 3（密码正确性/不可枚举/限流） | **通过** |
| 门禁 4（撤销即时断线） | **通过**（实测 2ms） |
| 门禁 5（未登录本地可用） | **通过** |
| 原三条 OTP 门禁 | **不适用**（用户决定，未实现假 OTP） |
| 数据库迁移 | 通过 |
| TLS | 通过 |
| 日志脱敏 | 通过 |
| 凭据存储 | **有条件**：0600 凭据文件，非 OS 钥匙串（用户已接受，记 G6） |
| 找回密码 | **通过**（三层 + 34 条测试） |

```
hub:        ℹ tests 111, pass 111, fail 0
ds-bot: ℹ tests 831, pass 831, fail 0
            verify = build → check → test → lint 全绿
            lint 14 warnings / 0 errors
```

**结论：G3 = 有条件 PASS。** 五条替换后的门禁全部达成；找回密码已按用户要求在 G3 内补齐；
凭据存储一项低于方案原文的「OS 密钥链」要求，用户已明确接受并记入 G6。
