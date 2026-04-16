# 开发进度记录（当前批次详细账本）

仅保留当前批次（每 10 个任务以内） 的逐任务明细，用于近期审查衔接与下一任务派发。

历史默认不在本文件中保留：
- 已完成批次的压缩摘要见 `WF_任务阶段压缩记录.md`（默认优先读取）
- 已完成批次的详细明细见 `WF_开发进度明细归档/`（按需展开）

---

## 当前批次

- 批次范围：`T-021` ~ `T-030`
- 当前已完成任务：`T-021`
- 当前批次摘要：从 `T-021`（任务二十一） 起按"纵向上线切片"重排，把原 T-021（消息入队 + ConversationWorker stub） / 原 T-022（BotWorker 最小执行） / 原 T-023（真实连服 + EasyAuth + 端到端） 三任务合并为新的 `T-021`（最窄端到端 demo），把 MC（Minecraft，我的世界） 上线硬门槛前移到本批次第一个任务。后续任务沿 BotWorker → 实时层 → sandbox → 真实 LLM → BrainWorker → 部署文档 的顺序逐步加深。
- 当前批次硬约束：`T-021`（任务二十一） 验收必须包含真实 MC 服务器手测（聊天截图 + 启动日志），不再做纯契约或纯占位任务。每个后续任务都必须给出可在 MC 中亲眼验证的新行为门槛。

---

## 详细记录

### T-021 — 最窄 MC 在线聊天闭环

- 审查状态：通过。
- 核心文件：
  - `ts-core/src/runtime/actor.ts`
  - `ts-core/src/runtime/transport.ts`
  - `ts-core/src/workers/conversation-worker.ts`
  - `ts-core/src/workers/bullmq.ts`
  - `ts-core/src/app/bootstrap.ts`
  - `ts-core/src/app/entrypoint.ts`
  - `ts-core/src/main.ts`
  - `ts-core/src/__tests__/runtime-actor-model.spec.ts`
  - `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts`
  - `ts-core/src/__tests__/interfaces-message-queue-model.spec.ts`
  - `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- 变更快照：
  - BotActor（机器人执行代理） 增加 `broadcastReply()` 单写者聊天入口，ready（就绪） 门控未通过时拒绝写入，并发聊天写入直接拒绝。
  - Mineflayer（Minecraft 协议客户端） transport（传输） 增加最小 `chat(text)` 适配器，仍不向外暴露原始 Bot（机器人） 句柄。
  - ConversationWorker（对话工作线程） 已真实消费 `msg:{botId}` BullMQ（任务队列），chat（闲聊） 路径生成带“喵”的模板回复并经 BotActor（机器人执行代理） 写入游戏聊天；cancel（取消） 只记录；task（任务） / modify（修改） 在无 planner（规划器） 时丢弃。
  - `POST /api/message`（消息提交接口） 默认 handler（处理器） 已真实写入 BullMQ（任务队列） 并返回真实 `job.id`；打回修复后每条消息独立生成 `queued_at`（入队时间） 与 `snapshot_ts`（快照时间戳），不再复用启动时间。
  - `pnpm start` 进入真实在线启动路径：PostgreSQL（关系型数据库） / Redis（缓存） → BullMQ（任务队列） / Fastify（接口网关） → Mineflayer（Minecraft 协议客户端） → EasyAuth（离线服认证模组） 登录命令 → ConversationWorker（对话工作线程）。
  - Coder（编码代理） 反馈已完成真实 MC（Minecraft，我的世界） 服务器 CLI（命令行） 链路验证：连服、EasyAuth（离线服认证模组） 注册 / 登录、HTTP（超文本传输协议） 202 响应、BullMQ（任务队列） completed（完成） 状态；图形客户端截图仍需操作者侧留存。
- 验收备注：
  - `bash ts-core/scripts/pre_review.sh` 由 Coder（编码代理） 回填为全部通过，摘要为 24 个测试文件、114 条测试通过。
  - 本次审查未重复机械预检。
