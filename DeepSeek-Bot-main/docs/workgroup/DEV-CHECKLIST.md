> **文档来源**：本文件由源仓库 `Workgroup-AI/bot-plugin/docs/DEV-CHECKLIST.md` 转换而来（2026-10-22）。
> **基线**：源仓库 `ds-bot@0.1.7`；本仓库 `ds-bot@0.2.0` / DSH `0.2.1-rc.2`。
> **证据口径**：文中「通过 / 已验证 / 数字」均为**源仓库当时**的结果；本仓库重跑结论以 `docs/workgroup/gates.md` 为准。
> **路径改写**：`bot-plugin/` → `ds-bot/`；`docs/gN/` → `docs/workgroup/gN/`；源方案 → `docs/plans/2026-10-22-workgroup-migration.md`。
> **Hub 位置**：本仓库的 Hub 在 `BotCode/hub/`（相对 `ds-bot/` 为 `../../hub`），文中 `hub/` 均指它。

# 开发检查单（DEV CHECKLIST）

适用：`ds-bot/`（ds-bot 插件本体）。`hub/` 另见 G3。

---

## 0. 一条命令收尾

```bash
cd ds-bot && npm run verify
```

依次执行 **build → check → test → lint**，任一步失败立即停止并返回非 0。
全部通过时最后打印：

```
--- verify ---
build  ok  0.3s
check  ok  0.3s
test   ok  6.8s
lint   ok  0.3s
all steps passed
```

只想验证、不想重新生成 bundle：

```bash
cd ds-bot && node scripts/verify.mjs --check-only
```

> 不要拆开只跑 `npm test`。测试全绿而 `client.js` 是旧的，等于没改（见 §2）。

---

## 1. 规则一：改了 client 源码，必须重建 `client.js`

`client.js` 是**构建产物**，由 `scripts/build-client.mjs` 从下面两处源码打包而来：

| 源码 | 内容 |
|---|---|
| `src/client/**` | 原版团队 UI（Fork 自 ds-bot v0.1.7） |
| `src/workgroup/client/**` | 工作群面板、侧栏入口、样式 |

DSH 加载的是 `client.js`，不是 `src/`。**只改源码不 build，真实环境跑的还是旧代码。**

### 已经真实发生过一次

G1 期间改完 `src/workgroup/client/**` 没跑 build，用户在真实 Desktop 里测的是旧
bundle，结果「Bot」入口根本没有出现。为此排查了很久，最后发现是自己没构建。

所以现在有两道保险：

1. `npm run verify` 的 **build** 步会重新生成；
2. **check** 步（`build-client.mjs --check`）比对 `client.js` 与新鲜构建，
   不一致就非 0 退出 —— 即使手动跑 `npm test` 也会被
   `test/client-bundle.test.js` 抓到，错误信息是
   `client.js is stale: run \`npm run build\` and commit it`。

---

## 2. 规则二：交付前必须让 `npm run lint` 裸跑为绿

```bash
cd ds-bot && npm run lint      # 期望 EXITCODE=0
```

当前基线：**13 warnings / 0 errors**（警告是既有风格问题，不阻断）。

`scripts/lint.mjs` 只扫 ds-bot 自己的源码：`index.js`、`web-search.js`、`src`、
`dev`、`scripts`、`test`，并用 `--ignore-pattern '**/node_modules/**'` 排除
`dev/harness/node_modules`（那是 harness 安装，不是我们的代码）。

> 历史问题：`dev` 作为目录字面传给 oxlint 会递归进去，仅第三方打包产物就有
> 20745 errors，裸跑永远红。**修的是扫描范围，规则一条没放宽。**

### 门禁有效性必须可证明（T2-b）

改 `scripts/lint.mjs` 或 `.oxlintrc.json` 后，必须做这个三步验证：

```bash
# 1. 故意写一个 no-undef 违规
cd ds-bot && printf 'export const probe = definitelyNotDefinedAnywhere + 1\n' > src/__t2b_probe.js

# 2. 确认门禁仍然报错（期望 EXITCODE=1，且输出 no-undef）
npm run lint; echo "EXITCODE=$?"

# 3. 撤销，确认回到绿（期望 EXITCODE=0）
rm src/__t2b_probe.js && npm run lint; echo "EXITCODE=$?"
```

第 2 步的真实输出（2026-10-21）：

```
  x eslint(no-undef): 'definitelyNotDefinedAnywhere' is not defined.
   ,-[src/__t2b_probe.js:2:22]
Found 13 warnings and 1 error.
EXITCODE=1
```

**只让结果变绿但规则失效，不算通过。**

---

## 3. 规则三：工作群与本地群是两个域，不要互相借用状态

| 不要 | 要 |
|---|---|
| 读 `rt.groupOwners` / `rt.rooms` | 读 `wg.sessionOwners` / `wg.state.workgroups` |
| 用 `group_relay` 工具 | 用 `workgroup_relay` |
| 写 `state.json` | 写 `workgroup/state.json` |
| 用 `SOURCE_KIND` (`'bot'`) | 用 `WG_SOURCE_KIND` (`'workgroup'`) |
| 调 `/api/bot` | 调 `/api/workgroup` |

判断依据用 `rt.resolveSessionOwnerStrict()`：一个 Session 同时被两个域占用会抛错，
这是**故意**的，不要 catch 掉。

---

## 4. 规则四：新文案要进 i18n 字典

`test/i18n.test.js` 会扫描 `src/client/*.js` 里所有 `t('…')` 字面量，
缺 `DICTIONARY.zh` 词条即失败。

```js
// src/client/i18n.js 的 ZH 里加一条
'Create workgroup': '新建工作群',
```

注意：该测试**只扫 `src/client/`**，不扫 `src/workgroup/client/`。
工作群面板的文案仍写进同一份字典（便于两处共用），但不会被自动检查 ——
改面板文案时请手动确认词条存在。

---

## 5. 规则五：不动原版群业务

工作群是从原版**复制**再改造的（`src/workgroup/host/groups.js` 复制自
`src/host/groups.js`），不是重写，也不修改原版逻辑。

- 原版 `src/host/**` 保持语义不变；只允许追加（例如
  `store.js` 末尾补一个 `resolveSessionOwnerStrict` 默认实现）。
- 原版测试断言只允许在**设计变更**时调整，且必须在
  `docs/workgroup/g1/G1-REPORT.md` §3.1 记录原因。

---

## 6. 交付前勾选

- [ ] `npm run verify` 全绿（build / check / test / lint 四项都 ok）
- [ ] `client.js` 已重新生成，`--check` 退出 0
- [ ] `npm test` 全绿，用例数**只增不减**
- [ ] `npm run lint` 裸跑 EXITCODE=0
- [ ] 动过 lint 配置的话，做过 §2 的 T2-b 三步验证
- [ ] 新文案有 `DICTIONARY.zh` 词条
- [ ] 没有新增 npm 依赖
- [ ] 没有新增第三个一级目录
- [ ] 工作群没有进入 DSH 一级侧栏（只在 Bot 面板内）
- [ ] 没有 DOM/CSS hack：面板只经官方 Slot 与 `/api/workgroup`
- [ ] 需要人工确认的项已写进人工测试清单，而不是自称"已验证"

---

## 7. 常见误判

| 现象 | 真实原因 |
|---|---|
| `npm test` 全绿但真实环境没变化 | 没跑 `npm run build` |
| 点「Bot」进去是空白/无样式 | 面板根用了 `.bt-panel`（那是右侧抽屉），或用了未定义的 `bt-*` 类 |
| `layout.selectPanel: main panel "…" is not registered` | `sidebar.panellist` 的 `id` 与 `main` 的 `key` 不一致 |
| 裸跑 lint 报 2 万多个错 | 扫到了 `dev/harness/node_modules` |
| 改完 profile 的 `package.json` 后 DSH 起不来 | 不要手改真实 profile，用插件管理器安装 |
