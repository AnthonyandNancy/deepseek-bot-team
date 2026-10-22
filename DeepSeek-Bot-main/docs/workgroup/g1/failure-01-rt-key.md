> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/g1/failure-01-rt-key.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# G1 首次运行失败记录（真实的 bug，非设计变更）

目的：保留一次**真实失败**的证据，避免"只保留通过记录"的假象。

## 运行

```
> ds-bot@0.1.7 test
> node --import ./test/harness-resolve.mjs --test "test/*.test.js"

ℹ tests 648
ℹ pass 368
ℹ fail 280
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5999.4631
EXITCODE=1
```

原始日志：`docs/workgroup/g1/logs/test-g1-fail-01.log`（本次失败的原样输出，未编辑）。

## 根因（单一）

280 个失败全部是**同一个**错误、同一个 2 帧抛出点：

```
TypeError: Cannot read properties of undefined (reading 'home')
    at Module.install (...\src\workgroup\host\state.js:37:24)
    at installWorkgroup (...\src\workgroup\index.js:44:45)
    at createRuntime (...\index.js:70:35)
```

`src/workgroup/index.js` 构造域对象时用的键是 **`runtime`**：

```js
const wg = { runtime: rt, ctx: rt.ctx, ... }
```

而 `host/state.js` 与 `host/ownership.js` 都用 `const { rt } = wg` 解构 → `undefined`
→ `join(rt.home, WG_DIR)` 抛错。

## 为什么它让 280 个测试一起失败

`createRuntime()` 是测试的公共入口（各测试文件的 `start()` 第一步）。域在**安装阶段**就抛错，
于是 `createRuntime` 整体失败，**连原版的测试也一起挂**。这不是原版回归，而是：
新模块的安装路径错误地变成了原版可用性的前置条件。

这本身说明了一条设计约束值得记下来：
**工作群域的安装失败不应让原版不可用**。当前实现是先 `rt.workgroup = wg` 再逐模块 install，
失败时 `delete rt.workgroup` 并抛错——抛错会冒泡到 `createRuntime`。这是一个需要决定的行为：
- 方案 6.2 要求"单次注册、按域分发"，并未要求域加载失败必须致命；
- 但静默吞掉会使"工作群明明没装上"难以发现。

处置：修复本 bug 后，把这一决策显式记录在 `docs/workgroup/g1/` 并加一个测试覆盖（见下文"待决策"）。

## 修复

`src/workgroup/index.js`：`runtime: rt` → `rt`（与两个 host 模块的解构一致）。

## 同时修复的另外两个真实缺陷（自查发现，非测试报告）

| 缺陷 | 位置 | 后果 | 修法 |
|---|---|---|---|
| `save()` 在写盘前调用 `indexSessionOwners()`，用磁盘旧值覆盖内存中的新注册 | `host/state.js` + `host/ownership.js` | 刚登记的 Session 归属在写盘瞬间丢失 | 改为只在 `load()` 后重建索引（`wg.onStateLoaded`） |
| `save()` / `workgroupOf` 读的是闭包局部 `state`，而域其余部分改的是 `wg.state` | `host/state.js` | `load()` 替换对象后写盘内容与内存不一致 | 统一以 `wg.state` 为唯一真源 |

## 待决策（记录，尚未实现）

域安装失败时的行为：

- **选项 A（当前）**：抛错上浮 → 原版也不可用。便于发现，但违反"未登录/断网时本地功能仍可用"的精神。
- **选项 B**：捕获并 `rt.warn`，`rt.workgroup` 保持 undefined，原版继续工作。更符合方案 7.1，但需要额外护栏避免静默失效。

倾向 **B**，并加一条测试：注入一个必然失败的域模块，断言原版工具仍注册且 `rt.workgroup === undefined`。
此项在 G1 门禁前必须定论，故列入待办，不在此处偷偷决定。
