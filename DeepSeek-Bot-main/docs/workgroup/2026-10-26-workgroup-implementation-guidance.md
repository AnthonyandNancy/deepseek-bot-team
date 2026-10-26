# Workgroup implementation guidance (2026-10-26)

1. 工作群是原版群聊的复制件：新增行为先改原版，再复制到 `src/workgroup/`；只有 Hub/远程传输可以新写。
2. `src/host/groups.js` 的 relay 上限、`paused`、`continueRoom` 是 0.2.2 原版语义；工作群副本必须保持同义，不另建第二套群记忆/轮次存储。
3. 客户端继续使用原版设置表单字段名（`mode`、`admin`、`name`、`notice`、`permission`、`workDir`），工作群只在 `continue-room` 与 `group.continue` 上有自己的传输层。
4. `client.js` 是生成物：改 `src/client/` 或 `src/workgroup/client/` 后必须运行 `npm run build`，不得手改。
5. 新增可翻译文案必须在 `src/client/i18n.js` 的中文字典中提供中文；英文只作为 key。
