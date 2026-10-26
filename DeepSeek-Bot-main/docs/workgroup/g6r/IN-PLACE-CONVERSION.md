# G6R 纠偏指令（在 G6 分支上原地改造，不要重做）

> **用法**：新会话第一条消息把「指令正文」整段发出即可。
> **前提**：G6 实施会话已经做完或接近做完，改动都在 `feat/g6-group-memory` 分支上。
> **重要**：本指令**不是**“推倒重来”。G6 里已经有 5 类产物正是 G6R 需要的，必须保留；
> 只有 3 类平行实现要删，2 处要改接。

---

## 一、给用户的说明（3 行）

1. G6 把“群记忆只在本机”误判成“原版没有群记忆”，于是新建了 `group_memories` 表、
   `memory-*` 端点和独立 `MemoryCard`。原版 `ds-bot/src/host/memory.js` 本来就有群记忆：
   `memory/groups/<roomId>/`、成员校验、容量、回顾、面板、删除归档。
2. 所以 G6R 要做的不是“再建一次”，而是**把原版已有的群记忆跨机器同步**：原版引擎不动，
   Hub 只传 `memory.change` 一条事件。
3. 好消息：G6 已经写好的「成员 Session → 群」接缝、删除群归档、`helpers-pair.js` 夹具、
   `memory.change` 的 bridge 分发，**全部可留**。真正要删的只有 Hub 那套平行存储与 UI。

---

## 二、指令正文（复制以下全部内容）

```text
你在 BotCode 工作副本里，继续 G6 之后的一轮纠偏：G6R。

## 0. 先接受这三个结论（不要重新论证）

1. 原版群聊本来就有群记忆。ds-bot/src/host/memory.js 自带：
   - 群作用域 memory/groups/<roomId>/（:463-464）
   - 成员读写校验 writable/writeDenied（:523、:559）
   - 容量 300 / 4000 / 16000 / 40 主题（:40）
   - 回合后群回顾 reviewGroup（:1354）、群面板 panelOf（:1078）
   - 删除群归档 archiveGroupMemory（:705），原版 roster.js:484 会调用它
2. G6 新建的 group_memories 表、hub/src/memories/service.js、五个 memory-* 端点、
   group-settings.js 的 MemoryCard，都是**平行实现**，必须删除。它们不是在“共享群记忆”，
   而是在“新建一个群记忆再共享”。
3. 工作群真正缺的只有“跨机传输”：每台机器各写各的本机 Markdown，没有任何东西把它们连起来。
   G6R 就是把这一层补上，业务语义一律沿用原版。

## 1. 仓库与基线

根目录：D:\code\ai\DeepSeek-Bot\BotCode
- 插件：DeepSeek-Bot-main/ds-bot
- 服务端：hub（相对 ds-bot 是 ../../hub）
- 当前分支：feat/g6-group-memory（G6 的成果都在这条上，不要切到 main 重来）
- 起点：本轮开始时的 HEAD。开工先记录：git rev-parse HEAD

开工先跑一遍，记录真实数字（不要抄文档里的历史数字）：
  cd hub && npm test
  cd ../DeepSeek-Bot-main/ds-bot && npm test
  node scripts/build-client.mjs --check
  npm run lint

不发版、不改版本号、不打包。

## 2. 必读（按顺序）

1. docs/workgroup/g6r/DESIGN-COPY-FIRST.md
   —— 为什么 G6 错、G6R 怎么改、与 G6 的逐项对比
2. docs/superpowers/plans/2026-10-24-g6r-copy-first-group-memory.md
   —— 若要从头做时的完整任务；本轮是“原地改造”，以本指令 §4 为准
3. docs/plans/2026-10-09-context-and-memory.md:80-112
   —— 原版群记忆的存储、权限、回顾、面板、归档
4. docs/workgroup/parity-audit.md §1
   —— 已纠正的口径：原版有引擎，缺的是传输
5. docs/workgroup/diff-manifest.md §3.1
   —— “原版没有 → 新写”登记表，新写模块必须先登记
6. AGENTS.md 第 6 条
   —— 复制优先硬规则

## 3. 保留 / 删除 / 改接（本轮的施工图）

### 3.1 必须保留（G6 已经做对了，不要动）

| 产物 | 位置 | 为什么留 |
|---|---|---|
| rt.memoryRoomOf 接缝 | workgroup/host/ownership.js（新增 memoryRoomOf 函数 + 导出） | 正是原版回顾认识工作群成员所需的只读解析 |
| memory.js 的 roomIdOf 分支 | src/host/memory.js:468 的 `?? rt.memoryRoomOf?.(sessionId)` | 让成员 Session 找得到自己的群 |
| memory.js 的 agent/status 分支 | src/host/memory.js:1476 的 `!rt.memoryRoomOf?.(id)` | 让原版回顾为工作群成员触发 |
| 删除群归档 | workgroup/host/groups.js 的 deleteWorkgroup 调 rt.archiveGroupMemory(room) | 原版 deleteRoom 本来就这么做 |
| 回顾接缝测试 | test/workgroup-memory-review.test.js 的**第一个** test（成员 Session eligible / relay 不是） | 它证明的正是 G6R 要保留的行为 |
| 跨机夹具 | test-realtime/helpers-pair.js（从 workgroup-realtime.test.js 抽出，原文件已回引） | G6R 的两机测试直接复用，不复制第二份 |
| bridge 的 memory 分发骨架 | workgroup/host/bridge.js 里 `event.type.startsWith('memory.')` 那段 | 形状对，只需把事件名从 memory.* 收敛成 memory.change |

### 3.2 必须删除（平行实现）

逐项删除，删完每项跑一次相关测试，看到“预期失败/编译错误”再继续下一项：

1. hub/src/memories/service.js（整文件）
2. hub/src/db/migrations.js 的 migration v8 整块（version: 8 的整个对象），
   并把所有断言 LATEST_VERSION === 8 的地方改回 7
3. hub/src/server.js 里：
   - import { createMemoryService }
   - const memories = createMemoryService({...})
   - 五条 /v1/workgroups/:id/memories 路由（list / search / create / correct / delete）
   - 返回对象里的 memories,
4. hub/test/db-g6-schema.test.js、hub/test/group-memory.test.js（整文件删除）
5. hub/test/db-migrate.test.js、hub/test/db-g5-schema.test.js：把“G6 表必须存在”
   改回“group_memories 不得存在”，LATEST_VERSION 改回 7
6. ds-bot/src/workgroup/host/memories.js（整文件删除，它只是 Hub 记忆的投影缓存）
7. ds-bot/src/workgroup/index.js：去掉 memories import 与模块数组里的 memories
8. ds-bot/src/workgroup/host/state.js：去掉 memories: {} 与 adopt 白名单里的 'memories'
9. ds-bot/src/workgroup/host/hub.js：五个方法 memories / searchMemories / createMemory /
   correctMemory / deleteMemory 整块删除
10. ds-bot/src/workgroup/host/channel.js：READS 里的 'memory-list','memory-search'，
    以及五个 case（memory-list / memory-search / memory-create / memory-correct / memory-delete）
11. ds-bot/src/workgroup/client/group-settings.js：MemoryCard 组件、它的调用处、
    以及为此加的 import { callWorkgroup }
12. ds-bot/src/workgroup/client/panel.js：`payload.kind === 'memory'` 那段 dispatchEvent
13. ds-bot/src/client/i18n.js：G6 新增的 9 条文案（'Search group memory' / 'Add something every
    member should know' / 'Add memory' / 'No group memory yet.' / 'Correct this memory' /
    'Delete memory' / 'Correct' / 'version {version}' / '{count} sources'）
    注意：'Group memory' 与 'Only its members read it' 是**原版已有**的，不要删。
14. ds-bot/test/workgroup-memory-isolation.test.js（整文件删除：它测的是 Hub 投影）
15. ds-bot/test-realtime/workgroup-memory.test.js（整文件删除：它测的是五个 memory-* 端点）
16. ds-bot/test/workgroup-memory-review.test.js：**只删第二个 test**（deleting a workgroup
    archives ... and removes the Hub entries）里关于 Hub 的部分；第一个 test 保留不动。
    更简单且推荐：把第一个 test 挪进新文件 test/workgroup-memory-room.test.js，
    然后删掉整个 workgroup-memory-review.test.js。
17. ds-bot/test/workgroup-ux.test.js：删掉末尾两个 G6 test
    （settings form lists/... group memory、memory signal makes ... re-read）
18. hub/src/workgroups/service.js：EVENT_TYPES 里四个 memory.proposed/created/corrected/deleted
    收敛成一个 'memory.change'（见 §4.1）
19. ds-bot/client.js 是生成物：改完 src/client 后必须 npm run build，不要手改。

### 3.3 必须新增（唯一的新写）

只有两个新文件 + 两处小改：

A. ds-bot/src/workgroup/host/memory-sync.js（新）
   把原版写入转成 Hub 事件、把远端事件喂回原版写入路径。

B. ds-bot/test/workgroup-memory-sync.test.js（新）
   单机：群写入上报、私聊/团队/本地群不上报、远端应用幂等、删除归档。

C. ds-bot/test-realtime/workgroup-memory-sync.test.js（新）
   两机：A 用原版 remember 写，B 的 memory-view 能看到；B 离群后收不到。

D. hub/src/ws.js 新增一个 'memory.change' 帧处理器（约 12 行，照抄 chat.message 的形状）。

E. src/host/memory.js 两处小改（见 §4.2、§4.3）。

## 4. 关键实现（照这个写，不要自己另设计）

### 4.1 Hub：一条事件，一个帧

hub/src/workgroups/service.js 的 EVENT_TYPES：删掉四个 memory.*，加一个：

  // ── group memory (G6R) ──────────────────────────────
  // One change the ORIGINAL memory engine already made on the machine that made it.
  // The Hub stores and orders it; it never interprets the entry, its format or who may write.
  'memory.change',

READABLE_EVENT_TYPE 不动，保持 'chat.message'。

hub/src/ws.js 的 handlers 里，在 'chat.message' 之后加：

  'memory.change'(ws, info, message) {
    const workgroupId = requireGroup(ws, info, message.workgroupId)
    if (workgroupId === undefined) return undefined
    try {
      const { event, duplicate } = events.append({
        workgroupId,
        eventId: message.eventId,
        type: 'memory.change',
        sender: { userId: info.userId, deviceId: info.deviceId },
        payload: message.payload,
      })
      send(ws, { type: 'ack.ok', workgroupId, eventId: event.eventId, seq: event.seq, duplicate })
      if (!duplicate) fanOut(workgroupId, event, { exceptDeviceId: info.deviceId })
      return undefined
    } catch (error) {
      if (error instanceof HubError) return refuse(ws, error.code, error.message)
      throw error
    }
  },

事件载荷（插件定义，Hub 不解释）：

  {
    roomKey: 'wg_hub_1',      // Hub workgroupId，不是本机 roomId
    op: 'add' | 'replace' | 'remove',
    topic: null | 'travel',
    before: null | '- …',
    after: null | '- …',
    actor: { id: 'bot-a', name: 'Writer' },
    at: '2026-10-24T00:00:00.000Z'
  }

不需要新表：events 表载荷上限 16 KiB，原版单条 ≤ 300 字符。

### 4.2 原版写入后发一条纯观测通知

src/host/memory.js 里，在 journal() 附近加：

  function reportWrite(change) {
    try { rt.onMemoryWritten?.(change) } catch (error) {
      rt.warn('ds-bot: memory observer failed: %s', error?.message ?? error)
    }
  }

在 addEntry 的 noteNews(...,'add',...) **之前**：
  reportWrite({ scope, file: target, op: 'add', before: undefined, after: line, actor })

在 replaceEntry 的 noteNews(...,'replace',...) 之前：
  reportWrite({ scope, file: old.file, op: 'replace', before, after: line, actor })

在 removeEntry 的 noteNews(...,'remove',...) 之前：
  reportWrite({ scope, file: old.file, op: 'remove', before, after: undefined, actor })

约束：异常只 warn，绝不影响原版写入；memory.test.js 的**既有断言一条都不许改**。

### 4.3 远端变更走原版写入路径

先把 addEntry / replaceEntry / removeEntry 的函数体原样提取成内层函数
（addEntryInner / replaceEntryInner / removeEntryInner，不含 queued()），外层保留
queued(async () => ...)。这是纯结构提取，提取后立刻跑 node --test test/memory.test.js 确认全绿。

然后加 rt.applyRemoteMemoryChange({ eventId, roomId, op, topic, before, after, actor })：
  - 走同一个 queued() 写队列
  - 先 writable(groupScope(roomId), actor)，失败返回 { changed:false, reason:'not-member' }
  - 用 addEntryInner / replaceEntryInner / removeEntryInner 落地
  - 幂等：<home>/memory/applied.json 存最近 500 个 eventId，重复返回 { changed:false, reason:'duplicate' }
  - 导出：Object.assign(rt, { ..., applyRemoteMemoryChange })

### 4.4 传输适配器 memory-sync.js

  export function install(wg) {
    const { rt } = wg
    const entryOf = (workgroupId) => {
      wg.state.memorySync ??= {}
      wg.state.memorySync[workgroupId] ??= { lastSentAt: 0, lastAppliedAt: 0, applied: 0 }
      return wg.state.memorySync[workgroupId]
    }
    async function onMemoryWritten(change) {
      if (change?.scope?.kind !== 'group') return
      const room = wg.workgroupOf(change.scope.roomId)
      if (room?.hubWorkgroupId === undefined) return
      if (wg.bridge?.status?.().connected !== true) return
      const hubWorkgroupId = room.hubWorkgroupId
      const payload = {
        roomKey: hubWorkgroupId, op: change.op,
        topic: change.file?.topic ?? null,
        before: change.before ?? null, after: change.after ?? null,
        actor: change.actor ?? { id: 'user', name: 'user' },
        at: new Date().toISOString(),
      }
      try {
        await wg.bridge.sendEvent({
          workgroupId: hubWorkgroupId, frameType: 'memory.change', payload,
          eventId: `mev_${randomUUID().replace(/-/g, '')}`,
        })
        entryOf(hubWorkgroupId).lastSentAt = Date.now()
        await wg.save({ workgroupId: hubWorkgroupId, kind: 'memory' })
      } catch (error) {
        rt.warn?.('ds-bot: group memory change for %s not sent: %s', hubWorkgroupId, error?.message ?? error)
      }
    }
    async function onMemoryEvent({ workgroupId, event }) {
      if (event?.type !== 'memory.change') return
      const body = event.payload ?? {}
      if (body.roomKey !== workgroupId) return
      const room = wg.roomOfHubGroup?.(workgroupId)
      if (room === undefined) return
      const result = await rt.applyRemoteMemoryChange({
        eventId: event.eventId, roomId: room.id, op: body.op,
        topic: body.topic, before: body.before, after: body.after, actor: body.actor,
      })
      if (result.changed) {
        const record = entryOf(workgroupId)
        record.applied += 1
        record.lastAppliedAt = Date.now()
        await wg.save({ workgroupId, kind: 'memory' })
      }
    }
    wg.onMemoryWritten = onMemoryWritten
    wg.onMemoryEvent = onMemoryEvent
    wg.memorySyncState = entryOf
  }

state.js：emptyState() 加 memorySync: {}，adopt 白名单加 'memorySync'。
index.js：import * as memorySync，模块数组放在 bridge 之后、upgrade 之前；
安装循环之后挂一次：
  rt.onMemoryWritten = change => { void rt.workgroup?.onMemoryWritten?.(change) }

### 4.5 bridge：分发 + 修掉 ack 的聊天误判（两个都要做）

第一个：apply() 里把 G6 那段 startsWith('memory.') 换成精确匹配：

  if (event.type === 'memory.change') {
    void Promise.resolve(wg.onMemoryEvent?.({ workgroupId, event }))
      .catch(error => logger?.warn?.('ds-bot: memory change %s not applied: %s', event.eventId, error?.message ?? error))
  }

第二个（**很容易漏，漏了会凭空多一条群消息**）：
bridge.js 的 ack.ok 分支里，现在会用 sent.payload 拼一条 chat.message 调 apply(..., {mine:true})。
那是给聊天用的。memory.change 也被 ack 时就会画成一条空聊天行。改成：

  const isChat = sent !== undefined && (sent.frameType === undefined || sent.frameType === 'chat.message')
  if (isChat && Number.isFinite(frame.seq) && frame.duplicate !== true) { ...原来的 apply... }

## 5. 测试

新增三段，全部先写失败再实现：

A. test/workgroup-memory-room.test.js
   把 G6 的 workgroup-memory-review.test.js 第一个 test 挪过来（成员 Session → room.id；
   relay → undefined；rt.isBotSession 仍是 false），再加一条：
   ctx.sections.get('bot-memory').text({ agent: { id: memberSession.id } })
   要匹配 /## Group memory, shared by the members of this group chat/。
   （startRoundFixture() 返回 ctx，见 workgroup-round.test.js）

B. test/workgroup-memory-sync.test.js
   1) 群写入发出一条 memory.change；roomKey 是 Hub id 不是本机 room id
   2) 私聊 / 团队 / 本地群写入 sent 为空
   3) rt.applyRemoteMemoryChange 落进原版 store（用 rt.memoryEndpoint('memory-view',{roomId}) 验证）
      且第二次返回 { changed:false, reason:'duplicate' }
   4) 删除工作群后 memory/groups/<roomId> 消失，memory/archive/group-<roomId>-… 出现一次
   用 startRoundFixture() 返回的 home，不要假设 rt.home。

C. test-realtime/workgroup-memory-sync.test.js
   复用 helpers-pair.js 的 invitedPair / until / roomOf。
   A 用原版 remember 写（成员 Session 内 → 默认群作用域）：
     const session = await alice.wg.sessionFor(aliceRoom, member)
     await alice.ctx.registeredTools.get('remember').execute({ text: '...' }, { agent: { id: session.id } })
   B 用 bob.rt.memoryEndpoint('memory-view', { roomId: bobRoom.id }) 轮询到该条目。
   再补一条：B 离群后 A 再写，B 收不到。

D. hub/test/ws-events.test.js 追加一条：memory.change 扇出、ack.seq 是整数、
   unreadCount 前后相等。

## 6. 硬规则（违反即停）

1. 复制优先：任何“工作群要做到 X”，先找原版群聊的 X 在哪；有就改复制件或走只读接缝。
2. 不新写业务语义：条目格式、容量、谁能读写、回顾规则、面板形态，一律来自原版。
3. 不改 DSH，不打补丁。
4. 冻结文件逐字节不变：src/host/{groups,turns,delivery,resume,constants}.js。
5. src/host/memory.js 只允许 §4.2 与 §4.3 的改动；memory.test.js 既有断言一条不改。
6. rt.isBotSession 语义不变。
7. 只有 scope.kind === 'group' 且该 room 有 hubWorkgroupId 的才上传。
8. 测试只用临时目录，不碰 ~/.dsh。
9. 不发版、不改版本号、不打包。
10. 人工项不得自评 PASS。
11. 遇到会改变需求或架构的问题：停下，写「Plan deviation」。

## 7. 完成定义

- 两机：A 用原版 remember 写，B 的 memory-view 不用刷新就能看到；B 离群后收不到。
- 每台机器的记忆仍在 <home>/memory/groups/<roomId>/MEMORY.md，格式没变。
- 删除工作群后目录进 <home>/memory/archive/group-<roomId>-…。
- 仓库里搜不到 group_memories 表、memories/service.js、memory-list 等五个端点、
  MemoryCard —— 除了 docs/workgroup/g6/ 与 g6r/ 里作为“历史/反例”提到的。
- hub npm test / ds-bot npm test / build-client --check / npm run lint 全绿。
- git diff --name-only main -- ds-bot/src/host 只有 memory.js。
- 每轮报告：改了哪些文件、属于保留/删除/新写哪一类、跑了什么命令、结果如何。

## 8. 人工项（保持 BLOCKED）

G6-M1（两台真机、两个账号：A 写、B 可见、B 离群后不可见）、G4-1/5/6、G4-T20、
G5-T12/N3/T14。步骤见 docs/workgroup/manual-checklist.md。
```

---

## 三、给执行会话的一句提醒

改造顺序建议：**先删**（§3.2 的 1→19），每删一项跑一次测试确认失败点符合预期；
**再补**（§3.3）；**最后跑全量**。先删后补能保证不会新旧两套同时活着。

如果 G6 那个会话还没提交，先在它结束时提交一次，再开 G6R 的改造提交，
这样 `git log` 能清楚看到“G6 交付 → G6R 纠偏”两段。
