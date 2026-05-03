# 项目进度记录

> Reviewer C 在审查通过后追加。一条一个任务。
> 历史批次摘要 (T-001 ~ T-040) 见 `PROGRESS_LEGACY.md`。

## 字段格式

```
## T-XXX | YYYY-MM-DD | 一句话功能描述

- 涉及模块: X, Y
- A 拆解依据: 用户需求 + 引用的架构条目
- C 审查结论: 通过 / 曾打回 N 次 (原因)
- 关键决策: 为什么选 X 不选 Y (从 B 交互记录第四段提炼)
- 架构冲突: 无 / [简述]
```

---

## 进行中 (旧系统遗留)

### T-047B | cutTree (砍树) 单技能验收 + 接入

**状态**: 旧 Manager 工作流下规划,未完成。新工作流启用后,可由 Planner A 重新评估或接续。

**目标**: 在线允许的 skill 集合从 `goTo + collect` 扩到 `goTo + collect + cutTree`;`equip` 与 `mine` 仍保持未启用。

**核心约束**:
- probe 先行: `ts-core/scripts/probes/cut-tree-probe.ts`,实服验证后再并入主程序
- 主程序必须通过 ResourceIndex 查询 / 刷新 (16→32→64),不得绕过缓存或临时全图扫描
- 不得硬编码 MC 树木事实(树种 / 原木 / 树叶 / 工具等级);事实源不能识别 `tree` 时返回 `unsupported_resource_key`
- 单技能门禁: `mine` 与 `equip` 仍返回 `skill_not_enabled`
- 触碰 LLM 链路 → 必须真实 LLM 验收

**后续 (T-047B 之后)**:
- T-048: equip 单技能验收 + 接入
- T-049: mine 单技能验收 + 接入
- T-050: 基础 skill 端到端 demo 收口

---

## 已完成 (新工作流下)

(从这里开始,Reviewer C 通过任务后追加)

## T-OPS-001 | 2026-05-01 | Docker（容器引擎）一键启停与开发模式入口

- 涉及模块: 根目录 Compose（编排）与启停脚本,ts-core（TS 单核心） Dockerfile（镜像构建文件）/ README（说明文档）,旧 Python（旧后端）入口
- A 拆解依据: 用户要求保留三端全 Docker（容器）验收模式,新增 PostgreSQL（数据库）+ Redis（缓存）开发模式;边界限定不动 MC（我的世界）服务端、不触 LLM（大语言模型）链路
- C 审查结论: 通过
- 关键决策: 复用同一份 Compose（编排）与 ts-core/.env（环境变量文件）,用 dev-infra.sh 只拉起 infra（基础设施）并移除 Docker（容器）app（应用）,避免第二份配置漂移
- 架构冲突: 无

## T-NET-001 | 2026-05-01 | 受击 knockback（击退）物理反馈诊断与最小修复

- 涉及模块: Mineflayer（Minecraft 协议客户端） transport（传输层）适配,network probe（网络探针）脚本,运行时回归测试
- A 拆解依据: 用户要求诊断并修复 bot（机器人）受击后缺失原版等价 knockback（击退）位移;边界限定可动 Mineflayer（Minecraft 协议客户端）适配层/网络入口/物理桥接,不动 skill（技能）/LLM（大语言模型）/BotActor（机器人执行代理）推理/JAR 插件/server-bridge（服务端桥接）协议,且禁止 fork（分叉）或 monkey-patch（运行时改写） Mineflayer（Minecraft 协议客户端）本体
- C 审查结论: 通过
- 关键决策: 在 Mineflayer（Minecraft 协议客户端）适配层兼容 1.20.3+ `entity_velocity`（实体速度）包的 `velocity: {x,y,z}` 结构,按协议速度单位转换后写回目标实体 velocity（速度）,不修改 Mineflayer（Minecraft 协议客户端）本体也不扩大到服务端协议
- 架构冲突: 无

## T-NET-003 | 2026-05-01 | multiworld（多世界）方块事实可信修复

- 涉及模块: Mineflayer（Minecraft 协议客户端） transport（传输层）适配,block fact probe（方块事实探针）,collect（捡拾）实服回归辅助修复,运行时回归测试
- A 拆解依据: 用户要求修复 `multiworld:resource`（资源世界）下方块事实失真;边界允许 adapter（适配层）/observation（观测层）/transport（传输层）方块路径/server-bridge（服务端桥接）/JAR（Java 插件）,禁止触 LLM（大语言模型）/prompt（提示词）/BotActor（机器人执行代理）/skill（技能）规划层/Mineflayer（Minecraft 协议客户端）本体源码
- C 审查结论: 曾打回 1 次 (代码量与 10 bot（机器人）并发验收约束不满足);用户本轮明确放宽代码量与并发验收,按功能与架构边界改判通过
- 关键决策: 先用 probe（探针）按 H1（假设一）→ H3（假设三）→ H2（假设二）定位根因,确认 H3（假设三）为 Mineflayer（Minecraft 协议客户端） blocks plugin（方块插件）在 dimension switch（维度切换）后 worldName（世界名）恢复失败;修复选择 adapter（适配层）兼容补丁,不进入 JAR（Java 插件）权威 block change（方块变更）推送路径
- 架构冲突: 无

## T-CTX-RES-0 | 2026-05-02 | ResourceService（世界感知资源服务）接口落地与存量补丁收编

- 涉及模块: world-model（世界模型）接口契约与缓存结构,runtime/transport（运行时传输层）世界解析端口与 WorldReader（世界读取器）,app（应用装配）注入路径,conversation-worker（对话工作器）资源摘要消费,运行时与 world-model（世界模型）回归测试
- A 拆解依据: 用户要求把 ResourceIndex（资源索引）升格为 ResourceService（世界感知资源服务）,公共 API（接口）保持 `query(resource_key)` / `refresh(resource_key, radius)` 扁平形态,内部按 `(world_key, resource_key)`（世界键、资源键）二元组路由;边界限定不改 skill（技能）接口、LLM（大语言模型）协议、observation（观测）数据契约或 Mineflayer（Minecraft 协议客户端）本体源码
- C 审查结论: 曾打回 1 次 (缺少跨维度实服回归记录);用户补充确认已在 Nether（下界）与 multiworld（多世界）切换中实测有效,改判通过
- 关键决策: 世界解析唯一实现保留在 transport（传输层）并沿用 `bot.game.dimension`（机器人当前维度）语义;ResourceService（世界感知资源服务）内部持有 `(world_key, resource_key)`（世界键、资源键）缓存桶,业务层只消费扁平 API（接口）;单点方块读取另收敛到极薄 WorldReader（世界读取器）,不把 `blockAt`（方块读取）混入资源聚合服务。未来新功能不得自行处理 `world_key`（世界键）,必须通过 ResourceService（世界感知资源服务）或 transport（传输层）既有端口消费
- 架构冲突: 无

## T-CTX-001 | 2026-05-02 | Planner（规划器） prompt（提示词）注入真实 Bot（机器人）/世界/主人/背包快照

- 涉及模块: conversation/llm（对话大语言模型） prompt（提示词）模板与 planner snapshot context（规划器快照上下文）,app（应用装配）在线 planner（规划器）注入,observation（观测）快照字段,runtime/transport（运行时传输层）只读采样端口/WorldReader（世界读取器）/world-state-reset（世界状态重置）,回归测试
- A 拆解依据: 用户要求用真实 observation（观测）快照替换 `createOnlinePlannerSnapshotContext`（在线规划快照上下文）占位 stub（占位实现）,只落 §7.1 的 `[Bot]`/`[世界]`/`[主人]`/`[装备]`/`[背包]`/`[附近方块]`/`[附近生物]`/`[时间]` 八行,不含 `[背包变化]` 与 `[资源簇]`;边界限定不改 skill（技能）接口、sandbox（沙箱）、LLM（大语言模型）协议结构或 ConversationWorker（对话工作线程）路由,`world_key`（世界键）来源必须走 transport（传输层）端口
- C 审查结论: 曾打回 1 次 (实服切换 world（世界） 后 Mineflayer（Minecraft 协议客户端）实体/玩家/pathfinder（寻路器）状态未刷新);B（实现代理）补充 world-state-reset（世界状态重置）后通过
- 关键决策: planner（规划器）上下文在 app（应用装配）根实时采样,不改 worker（工作线程）路由;`bot.world_key`（机器人世界键）由 transport（传输层）统一读取,observation（观测）只消费字段;主人名取最近 server-bridge（服务端桥接）玩家消息,HTTP（超文本传输协议）直入或无玩家名时按 §7.3 降级为 `[主人] 离线`;世界切换残留通过 transport（传输层）清理 Mineflayer（Minecraft 协议客户端）内部 pathfinder（寻路器）目标、控制状态与旧实体索引,不改 prompt（提示词）或 skill（技能）
- 架构冲突: 无

## T-LLM-THINK-OFF | 2026-05-03 | LLM（大语言模型） thinking（思考）模式默认关闭

- 涉及模块: conversation/llm（对话大语言模型）配置与 HTTP（超文本传输协议）请求适配,app（应用装配）环境变量装配,`.env.example`（环境变量示例）,LLM（大语言模型）运行时与 app（应用）回归测试
- A 拆解依据: 用户要求关闭 MiMo（小米大模型） thinking（思考）模式,通过统一 LLM（大语言模型）配置表达默认关闭,业务层不直接散落供应商私有参数;边界限定在 LLM（大语言模型）配置/HTTP（超文本传输协议）适配与装配层,不改 prompt（提示词）、skill（技能）、runtime（运行时）或 worker（工作线程）
- C 审查结论: 曾打回 1 次 (非 MiMo（小米大模型） `force_thinking_models`（强制思考模型）命中且 `reasoning_effort=none`（推理强度为无）时会静默不发有效开启字段);B（实现代理）改为配置阶段显式拒绝坏组合并补齐非 MiMo（小米大模型）回归测试后通过
- 关键决策: 业务配置统一使用 `LLM_ENABLE_THINKING=false`（关闭思考）、`LLM_REASONING_EFFORT=none`（无推理强度）与 `LLM_FORCE_THINKING_MODELS`（强制思考模型清单）;HTTP（超文本传输协议）适配层只对 MiMo（小米大模型）下沉 `chat_template_kwargs.enable_thinking=false`（聊天模板参数关闭思考）,非 MiMo（小米大模型）仅在 force（强制）且 effort（强度）非 `none`（无）时发送 `reasoning_effort`（推理强度）,避免配置声称开启但请求体无效
- 架构冲突: 无

## T-CTX-CHAT-1 | 2026-05-03 | Chat（闲聊）路径快照模板与 Stage 2-Chat（第二阶段闲聊）回归

- 涉及模块: conversation/llm（对话大语言模型） prompt（提示词）模板与 snapshot context（快照上下文）渲染,ConversationWorker（对话工作线程） chat（闲聊）/triage（分诊）路由处理,app（应用装配）在线 observation（观测）注入,diagnostics（诊断）本地 JSONL（结构化日志）
- A 拆解依据: 用户要求 Chat（闲聊）路径按 §7.1.2 注入 `[Bot]`/`[世界]`/`[主人]`/`[背包]`/`[背包变化]`/`[最近上下文]`/`[时间]` 子集,只落模板与渲染槽位,`world_key`（世界键）走 transport（传输层）既有端口,不新增 recent_events（最近事件）/对话轮队列/inventory diff cache（背包差异缓存）;后续用户明确要求修正 triage（分诊）直出 reply（回复）导致 Chat（闲聊）阶段不执行的问题,并把每次回复与上下文落本地日志
- C 审查结论: 通过
- 关键决策: Chat（闲聊）快照顺序按 §7.1.2 而不是任务文字列表,空 `[背包变化]` 与 `[最近上下文]` 按规则省略;triage（分诊）保留兼容 `reply.content`（回复正文）字段但运行时统一忽略正文并进入 Stage 2-Chat（第二阶段闲聊）,防止旧模型输出绕过 Chat（闲聊） prompt（提示词）;本地日志通过 worker（工作线程）可选 sink（汇点）旁路写入,失败不阻断实服回复
- 架构冲突: 无

## T-CTX-DLG-1 | 2026-05-03 | [最近上下文] 双 owner（所有者）时间线全链路

- 涉及模块: conversation/llm（对话大语言模型） Chat（闲聊）/Plan（规划）/Modify（修改） prompt（提示词）渲染,conversation（对话） recent context（最近上下文） store（存储）,ConversationWorker（对话工作线程）共享上下文构建与 BotWorker（机器人工作线程） action sink（动作汇点）,BotActor（机器人执行代理） recent_events（最近事件）投影,skills（技能）/sandbox（沙盒） deterministic formatter（确定性格式化器）,diagnostics（诊断）本地 JSONL（结构化日志）
- A 拆解依据: 用户要求按 §7.6 落地双 owner（所有者）时间线,ConversationWorker（对话工作线程）写主人原文 / Bot reply（机器人回复）原文 / sandbox TS（沙盒 TypeScript）原文 / sandbox error.message（沙盒错误消息）,BotActor（机器人执行代理）写 skill（技能）/sandbox（沙盒）执行结果单行;Chat（闲聊）/Plan（规划）/Modify（修改）三路消费同一时间线;不改 LLM protocol（大语言模型协议）结构、不改 observation（观测）数据契约、不进入 §8 异步通路
- C 审查结论: 曾打回 1 次 (BotActor（机器人执行代理）直接 import（导入） skills（技能）/sandbox（沙盒） formatter（格式化器）,app（应用）解析 recent context（最近上下文）业务 payload（载荷）);B（实现代理）改为 RuntimeRecentEventFormatter（运行时最近事件格式化器）端口注入,并把 sandbox finalize（沙盒终态）消费收敛到 conversation-worker（对话工作线程） sink（汇点） 后通过
- 关键决策: recent context（最近上下文）使用进程内 round store（轮次存储）按 message_id（消息标识）聚合,10 整轮 LRU（最近最少使用）淘汰,渲染从旧到新且当前 user message（用户消息）不重复注入;超长 sandbox TS（沙盒 TypeScript）只截断代码块并保留同轮报错 / 执行结果;泛指捡拾 prompt（提示词）明确走无 itemName（物品名）的 collect（捡拾）,避免把 item/unknown（未知物）误当目标名
- 架构冲突: 无

## T-CTX-002 | 2026-05-03 | inventory diff cache（背包差异缓存）三路共享

- 涉及模块: conversation（对话） inventory diff cache（背包差异缓存）,conversation/llm（对话大语言模型） Chat（闲聊）/Plan（规划）/Modify（修改） prompt（提示词）渲染,ConversationWorker（对话工作线程） shared context（共享上下文）构建层,app（应用） environment snapshot provider（环境快照提供器）装配,runtime/transport（运行时传输） collect（捡拾）半径执行修复
- A 拆解依据: 用户要求按 §7.5 落地 bot_id（机器人标识）维度进程内 baseline（基线）缓存,Chat（闲聊）/Plan（规划）/Modify（修改） 三路在 prompt（提示词）构建时取当前 inventory（背包） 与 baseline（基线）计算 `[背包变化]`,prompt（提示词）渲染后、路径返回前立即推进 baseline（基线）;Cancel（取消）/Triage（分诊）不读写;不改 observation（观测）数据契约、不改 LLM protocol（大语言模型协议）、不动 Mineflayer（Minecraft 协议客户端）本体
- C 审查结论: 通过;B（实现代理）交互中曾因实服 collect（捡拾）未执行有效动作返修,后续按用户补充边界把 collect（捡拾）默认半径调为 32、最大 64,并把 32 未命中后扩到 64 的搜索收敛在 runtime transport（运行时传输）执行层
- 关键决策: inventory diff（背包差异）不放 observation（观测）事件时钟,而由 ConversationWorker（对话工作线程）共享上下文在 LLM（大语言模型）路径出口推进 baseline（基线）;`[背包变化]` 只渲染单 delta（增量）文本如 `oak_log+5, cobblestone-2`;泛指捡拾默认以主人坐标为 center（圆心）,执行层负责扩半径,避免让 LLM（大语言模型）编排二次 collect（捡拾）
- 架构冲突: 无

## T-CONV-001 | 2026-05-03 | Triage（分诊）净化与 composite schema（复合结构）收敛

- 涉及模块: conversation（对话） triage（分诊）/contracts（契约）/parsers（解析器）,conversation/llm（对话大语言模型） client（客户端）与 triage prompt（分诊提示词）,ConversationWorker（对话工作线程） composite dispatch（复合派发）,diagnostics（诊断） LLM JSONL（大语言模型结构化日志）本地落盘,app（应用）在线 LLM（大语言模型）装配
- A 拆解依据: 用户要求 Stage 1-Triage（第一阶段分诊）只做路由,统一为唯一 composite schema（复合结构）,删除旧 `{intent, priority, reason}` 单层兼容与 `reply.content`（回复正文）,LLM（大语言模型）解析失败必须写 diagnostics JSONL（诊断结构化日志）,不再静默回退为 `{reply:{}}`;覆盖 A1/A2/A5 且需真实 LLM（大语言模型）验证
- C 审查结论: 曾打回 1 次 (解析失败 diagnostics（诊断）只在内存回调与测试数组中存在,没有由在线主程写入本地 `logs/llm/...jsonl`);B（实现代理）补充 `createLocalLlmDiagnosticLogSink`（本地大语言模型诊断日志汇点）并由 app（应用）在线入口按 `record.log_ref`（记录日志引用）落盘后通过
- 关键决策: 选择严格拒绝旧 schema（结构）与 `reply.content`（回复正文）,由 `ConversationLlmTriageError`（对话大语言模型分诊错误）携带 diagnostics（诊断）向上暴露;本地日志按 diagnostics（诊断）层校验后的 `log_ref`（日志引用）写 `record.lines`（记录行）,不在 app（应用）散落路径拼接,并复用统一脱敏 helper（辅助函数）
- 架构冲突: 无

## T-CONV-002 | 2026-05-03 | 删除 Modify（修改）路径并将修改语义降级为 cancel（取消）+ task（任务）

- 涉及模块: conversation（对话） contracts（契约）/triage prompt（分诊提示词）/route factory（路由工厂）,ConversationWorker（对话工作线程） composite dispatch（复合派发）与 plan-exec handler（规划执行处理器）,Docs（文档） 01_ARCHITECTURE（架构）/04_CONVERSATION_SPEC（对话规范）,BotActor（机器人执行代理） interrupt（中断）,runtime/transport（运行时传输） Mineflayer（Minecraft 协议客户端）动作停止端口
- A 拆解依据: 用户要求删除 `modify_interrupt_then_plan`（修改后中断再规划）专属路由,修改诉求统一由 composite triage（复合分诊） 的 `cancel + action(task)`（取消加任务动作）承载;ConversationWorker（对话工作线程） 不再有 modify（修改） handler（处理器）或 plan prompt（规划提示词）注入分支;文档同步删除 modify（修改）独立语义,且需实服验证先取消再下新任务
- C 审查结论: 通过;用户实服曾打回 1 次 (喊停/取消后 Bot（机器人）状态变为空闲但 Mineflayer pathfinder（寻路器）仍继续移动);B（实现代理）新增 `stopCurrentAction()`（停止当前动作） transport port（传输端口）并由 BotActor（机器人执行代理） interrupt（中断）时调用,用户确认手测通过
- 关键决策: ConversationWorker（对话工作线程） 按 cancel（取消）→reply（回复）→action（动作） 顺序串联 composite（复合）片段,不新增 modify（修改）专用 handler（处理器）;停止物理动作收敛在 runtime transport（运行时传输）端口内调用 pathfinder（寻路器）停止与控制键清理,不让 ConversationWorker（对话工作线程）直接接触 Mineflayer（Minecraft 协议客户端）实现
- 架构冲突: 无

## T-CONV-003 | 2026-05-03 | control fast-path（控制快路径）入口接入与取消词去重

- 涉及模块: interfaces（接口） control fast-path（控制快路径）匹配,app/bootstrap（应用装配） HTTP（超文本传输协议）消息入口,app/entrypoint（应用入口） server-bridge（服务端桥接）消息入口,BotActor（机器人执行代理） interrupt（中断）端口,ConversationWorker（对话工作线程） triage（分诊）创建器
- A 拆解依据: 用户要求按 01_ARCHITECTURE.md §3.2/§3.3/§4.2 把“停 / 别动 / 取消”等精确 control（控制）词前移到 API gateway（接口网关）/消息接入层,命中后不入 `msg:{botId}` 队列,直接调用 BotActor.interrupt（机器人执行代理中断）并广播模板回复返回 202;同时删除 ConversationWorker（对话工作线程） triage（分诊）创建器里的重复取消词数组
- C 审查结论: 通过
- 关键决策: control（控制）词只在 interfaces（接口）边界做精确匹配,HTTP（超文本传输协议）与 server-bridge（服务端桥接）入口共享同一 matcher（匹配器）;命中后只走 BotActor（机器人执行代理）中断、模板 reply（回复）与 realtime/replay（实时/补拉）事件,不再让 triage（分诊）兜底短路或生成回复
- 架构冲突: 无

## T-CONV-004 | 2026-05-03 | intent_epoch（意图纪元）Redis INCR（缓存自增命令）单调源接入

- 涉及模块: db（数据库/缓存） Redis（缓存） key（键）与 IntentEpochStore（意图纪元存储）端口,app/bootstrap（应用装配） HTTP（超文本传输协议）消息入口,app/entrypoint（应用入口） server-bridge（服务端桥接）入队,BotWorker（机器人工作线程） epoch（纪元）校验,BotActor（机器人执行代理） interrupt（中断）信号,status（状态）投影
- A 拆解依据: 用户要求 `intent_epoch`（意图纪元）以 `Redis INCR bot:{botId}:intent_epoch`（缓存自增键）作为唯一单调源,贯穿消息接入层取号、ConversationMessageContext（对话消息上下文）装配、BotWorker（机器人工作线程）过期任务丢弃与 BotActor（机器人执行代理）中断信号;覆盖 01_ARCHITECTURE.md §9.2 中的 epoch（纪元）闸门
- C 审查结论: 通过
- 关键决策: 真实路径默认由 Redis INCR（缓存自增命令）取号、Redis GET（缓存读取命令）读当前 epoch（纪元）,测试路径通过同一 IntentEpochStore（意图纪元存储）端口注入内存实现;BotWorker（机器人工作线程）改为异步读取当前 epoch（纪元）,使 `job.intent_epoch < currentEpoch`（任务纪元小于当前纪元）丢弃闸门接上真实单调源
- 架构冲突: 无

## T-BRAIN-001 | 2026-05-03 | PG schema（PostgreSQL 数据库模式）与 Drizzle（数据库 ORM）模型落地

- 涉及模块: data（数据） schema（模式）与 table contracts（表契约）,db migrations（数据库迁移）,PostgreSQL（关系型数据库） extension（扩展）依赖,数据模型与迁移运行测试
- A 拆解依据: 用户要求按 05_DATA_SPEC.md §2.3 落地 `task_events` / `bot_rolling_summary` / `bot_memory` / `memory_candidates` / `memory_audit` 五张 Brain（长期记忆）表,包含索引、约束、复合主键、`tsvector`（全文检索向量）生成列、`pg_trgm`（三元组索引扩展） GIN（倒排索引）和 HNSW（近邻搜索）向量索引;边界限定为 schema（模式）与 migration（迁移）,不触 LLM（大语言模型）或运行时业务链路
- C 审查结论: 曾打回 1 次 (`0000` 初始 migration（迁移）只创建五张新表但外键引用旧九表,空库不可重放);B（实现代理）补齐完整初始 migration（迁移）后通过
- 关键决策: 选择把仓库首个 `0000` migration（迁移）做成空库可重放的完整当前 schema（模式）,而不是伪装成五表增量;高级索引用原始 SQL（结构化查询语言）落在 migration（迁移）中,Drizzle（数据库 ORM）模型只声明可类型化结构,避免把 ORM（对象关系映射）不完整支持包装成业务抽象
- 架构冲突: 无
