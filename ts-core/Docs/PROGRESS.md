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

## T-BRAIN-002 | 2026-05-03 | BotWorker（机器人工作线程）任务卡入队与 BrainWorker（大脑工作线程）写入 B 层

- 涉及模块: workers/bot-worker（机器人工作线程）,workers/brain-worker（大脑工作线程）,workers/embedding-client（向量客户端）,app/main（主入口）,app/entrypoint（应用入口）,db/task-events（任务事件持久化）,data/contracts/task-event（任务事件契约）
- A 拆解依据: 用户要求 BotWorker（机器人工作线程）在 success（成功）/failed（失败）/interrupted（中断）终态推送带 task_card（任务卡）的 brain（大脑）队列任务,由 BrainWorker（大脑工作线程）集中调用 embedding API（向量接口）并一次写入 PostgreSQL（关系型数据库） `task_events`（任务事件）;符合 01_ARCHITECTURE.md §3 三队列职责与 05_DATA_SPEC.md §7 BrainWorker（大脑工作线程）数据写入流
- C 审查结论: 曾打回 2 次 (首次真实 embedding API（向量接口）未跑通且任务卡无法落库;二次返修只验证 probe（探测脚本）未接通 main（主入口）环境装配);B（实现代理）补齐主程 `EMBEDDING_*`（向量配置）装配并完成真实主程链路验证后通过
- 关键决策: 选择独立 embedding endpoint（向量端点）配置,不复用 LLM（大语言模型） base_url（基础地址）硬拼路径;BotWorker（机器人工作线程）只产任务卡,BrainWorker（大脑工作线程）独占 embedding（向量嵌入）与落库,app（应用）只做依赖装配
- 架构冲突: 无

## T-BRAIN-003 | 2026-05-03 | A.5 滚动摘要维护与触发式 takeaway（要点）

- 涉及模块: workers/brain-worker（大脑工作线程）,workers/brain-llm（大脑大语言模型客户端）,db/brain-memory（大脑记忆数据库端口）,diagnostics/task-log-reader（任务日志读取器）,app/entrypoint（应用入口）,conversation-worker（对话工作线程）主人消息 activity heartbeat（活跃心跳）
- A 拆解依据: 用户要求按 05_DATA_SPEC.md §7-②/③ 落地 failed takeaway（失败要点）、session silence takeaway（会话静默要点）与 A.5 bot_rolling_summary（滚动摘要）追加/重压;BrainWorker（大脑工作线程）独占 B 层/A.5 写入,app（应用）只做依赖装配,ConversationWorker（对话工作线程）仅提供静默检测所需的主人消息心跳
- C 审查结论: 通过
- 关键决策: 选择注入式 LLM（大语言模型）端口、PostgreSQL（关系型数据库）端口与 JSONL（结构化日志）前 50 行读取器,不让 app（应用）解释 takeaway（要点）业务;失败 takeaway（要点）在 task_events（任务事件）插入后 update（更新）,滚动摘要超过 2000 字才触发同模型重压到 1000 字内,会话静默以主人消息心跳、brain queue（大脑队列）idle（空闲）与 BotActor（机器人执行代理）活跃任务三条件共同判定
- 架构冲突: 无

## T-BRAIN-004 | 2026-05-03 | Rubric（评分规则）候选识别与 bot_memory（长期记忆）自动提拔

- 涉及模块: workers/brain-worker（大脑工作线程）,workers/brain-llm（大脑大语言模型客户端）,workers/brain-memory-safety（长期记忆安全扫描）,workers/contracts（工作线程契约）,workers/bot-worker（机器人工作线程）,workers/conversation-worker（对话工作线程）,db/brain-memory（大脑记忆数据库端口）,data/contracts/bot-memory（长期记忆数据契约）,data/contracts/task-event（任务事件契约）,app/entrypoint（应用入口）
- A 拆解依据: 用户要求按 05_DATA_SPEC.md §7-④/⑤ 落地 C 层 memory_candidates（记忆候选）识别、confidence（置信度）阈值自动提拔到 bot_memory（长期记忆）、容量超限二次 LLM（大语言模型）决策、prompt injection（提示注入）/credential（凭证）安全降级与 memory_audit（记忆审计）;BrainWorker（大脑工作线程）是 C 层唯一业务写入者,app（应用）只做端口装配;返修要求“这里 / 基地”类指示语必须绑定主人发话时 snapshot（快照）坐标而非 BrainWorker（大脑工作线程）消费时 live snapshot（实时快照）
- C 审查结论: 曾打回 1 次 (首次补“这里是家”时只在 BrainWorker（大脑工作线程）测试里硬编码坐标,且生产实现由 BrainWorker（大脑工作线程）延迟读取 live snapshot（实时快照）,异步消费后可能记录主人移动后的错误坐标);B（实现代理）改为在 message ingress（消息接入）/ConversationWorker（对话工作线程） prompt snapshot（提示词快照）捕获 owner_position_at_message（发话时主人坐标）,并经 BotWorkerTask（执行任务）与 BrainTaskCard（任务卡）结构化透传后通过
- 关键决策: 选择 BrainWorker（大脑工作线程）统一编排 rubric（评分规则）识别、候选落库、提拔、容量决策和审计,PostgreSQL（关系型数据库）只通过 db/brain-memory（大脑记忆数据库端口）写入;安全扫描命中时保留 pending（待审核）候选但禁止自动提拔,容量超限交给同一 Brain LLM（大脑大语言模型）端口做 merge（合并）/replace（替换）/delete（删除）决策;“这里 / 这边 / 基地”坐标选择结构化字段透传,不选 live provider（实时提供器）,避免异步延迟污染长期记忆语义
- 架构冲突: 无

## T-BRAIN-005 | 2026-05-04 | ConversationWorker（对话工作线程）注入 Brain（大脑）上下文与 search（检索）工具

- 涉及模块: workers/conversation-worker（对话工作线程）,workers/brain-worker（大脑工作线程）,workers/bot-worker（机器人工作线程）,conversation/llm（对话大语言模型）,conversation/brain-context（大脑上下文）,db/brain-search（大脑检索数据库端口）,db/task-history（任务历史数据库端口）,diagnostics/brain-log（大脑诊断日志）,app/entrypoint（应用入口）
- A 拆解依据: 用户要求按 04_CONVERSATION_SPEC.md §9 / §10.2 / §12 与 05_DATA_SPEC.md §3 落地 A 层/A.5/C 层上下文注入,Stage 2-Chat（第二阶段闲聊）与 Stage 2-Plan（第二阶段规划）暴露 search()（检索工具）并支持最多 3 轮 tool calling（工具调用）,Stage 1-Triage（第一阶段分诊）不暴露工具;返修要求 Brain fact（大脑事实）只能旁路、task_history（任务历史）先于 task_events（任务事件）建立父子链路、LLM JSONL（大语言模型结构化日志）必须保留最终 assistant（助手）输出
- C 审查结论: 曾打回 3 次 (地点记忆闭环缺测试且误用 Plan（规划）特殊分支;task_events（任务事件）外键父表 task_history（任务历史）缺失;Brain fact（大脑事实）入队和诊断失败仍可能阻断 Chat（闲聊）/Plan（规划）主路径);B（实现代理）补齐三 worker（工作线程）集成测试、task_history（任务历史）生命周期 sink（汇点）、Brain fact（大脑事实）best-effort（尽力而为）旁路与双失败测试后通过
- 关键决策: 选择由 ConversationWorker（对话工作线程）通过注入端口消费 Brain（大脑）上下文和 search()（检索工具）,不直读数据库;选择 BotWorker（机器人工作线程）维护 task_history（任务历史）生命周期、BrainWorker（大脑工作线程）写 task_events（任务事件）与记忆层,app（应用）只做装配;Brain fact（大脑事实）失败只落 runtime event（运行时事件）和诊断,不传播到主路径
- 架构冲突: 无

## T-CONV-005 | 2026-05-04 | Composite Triage（复合分诊）空路由片段从 reply（回复）改名为 chat（闲聊）

- 涉及模块: conversation/contracts（对话契约）,conversation/triage（分诊领域模型）,conversation/llm/prompts/triage（分诊提示词）,conversation/llm/parsers（大语言模型解析器）,workers/conversation-worker/runtime（对话工作线程运行时）,Docs/04_CONVERSATION_SPEC.md（对话规格文档）,相关测试
- A 拆解依据: 用户确认 Stage 1-Triage（第一阶段分诊）中 `reply:{}` 命名容易与已删除的 `reply.content`（回复正文）混淆;要求改为 `chat:{}` 表示进入 Stage 2-Chat（第二阶段闲聊）,Triage（分诊）仍只做路由,严禁恢复回复正文,旧 `reply:{}` 不兼容
- C 审查结论: 通过
- 关键决策: 选择硬拒绝旧 `reply` 字段而不是保留兼容双轨,让 schema（结构）漂移进入 diagnostics（诊断）并暴露;内部派发顺序同步改为 cancel（取消）→chat（闲聊）→action（动作）,真实 LLM（大语言模型）回归确认纯闲聊返回 `{"chat":{}}`
- 架构冲突: 无

## T-052A | 2026-05-04 | BFS（广度优先搜索）资源簇提取与缓存更新

- 涉及模块: world-model（世界模型）资源簇契约与查询实现,ResourceService（资源服务）缓存,app（应用装配）在线 blockUpdate（方块更新）接线,Docs/04_CONVERSATION_SPEC.md（对话规格文档）,相关测试
- A 拆解依据: 用户要求把 ResourceService（资源服务）/world-model（世界模型）资源簇生成从距离聚类改为按具体 blockName（方块名）分组的 BFS（广度优先搜索）连通聚类,树木和矿石统一支持 26 邻域,并在挖掘后的方块变化中按现有 world_key（世界键）隔离更新或删除缓存簇;边界限定不进入 plugin（服务端模组）、正式 cutTree（砍树）/mine（挖矿）技能或 LLM（大语言模型）链路
- C 审查结论: 曾打回 1 次 (首次实现缺少生产 blockUpdate（方块更新）到 ResourceService（资源服务）的自动接线,且混入 plugin（服务端模组）/probe（探针）/WORKFLOW（工作流）越界 diff（差异）);B（实现代理）补齐 app（应用装配）事件接线并移出越界改动后通过
- 关键决策: BFS（广度优先搜索）与断裂重切分保持在 world-model（世界模型）纯函数和 ResourceService（资源服务）内部,生产更新由 app（应用装配）把 Mineflayer（Minecraft 协议客户端） blockUpdate（方块更新）事件转成 ResourceCacheBlockChange（资源缓存方块变化）后调用公共接口;world_key（世界键）仍只通过 transport（传输层）端口读取,不在业务层解析维度或拼接世界名
- 架构冲突: 无

## T-052B | 2026-05-04 | 树木资源簇分类与 cutTree（砍树）目标选择

- 涉及模块: core-ports/runtime（运行时核心端口）资源刷新契约,runtime/transport（运行时传输层）资源键解析与只读候选事实,world-model（世界模型）ResourceService（资源服务）树木分类/选择实现,Docs/04_CONVERSATION_SPEC.md（对话规格文档）,相关测试
- A 拆解依据: 用户要求在 world-model（世界模型）/ResourceService（资源服务） 中把当前 world_key（世界键）隔离后的原木资源簇分类为可用于 cutTree（砍树） 的 accepted/rejected（接受/拒绝）结构,并按距离优先累计满足 requiredLogCount（所需原木数量）;边界允许 runtime/transport（运行时传输层）只读可达性/候选点能力和设计文档,不进入 plugin（服务端模组）、LLM（大语言模型）或正式 skill（技能）
- C 审查结论: 曾打回 4 次 (首次缺少不可达/不可挖判定且在 world-model（世界模型）按方块名后缀猜原木;二次 `tree` 公共资源键未映射到 Mineflayer（Minecraft 协议客户端）/minecraft-data（Minecraft 数据库） logs tag（原木标签）事实;三次把 Mineflayer `canDigBlock`（能否挖方块）当前 5.1 格距离限制混入 `is_diggable`（可挖）资源事实;其间均未追加进度);B（实现代理）补齐 runtime（运行时） semantic_roles（语义角色）/is_diggable（可挖）/is_reachable（可达）事实、`tree`→`logs` 内部解析别名和 8 格外回归测试后通过
- 关键决策: 保持 TS Core（TypeScript 核心）公共资源键为 `tree`,由 runtime/transport（运行时传输层）内部解析到 Minecraft（我的世界）原木 tag（标签）事实并返回 `resource_keys=["tree"]`;world-model（世界模型）只消费 `cut_tree_log`（砍树原木）语义角色、可挖事实和可达候选事实,不再按方块名猜测;`is_diggable`（可挖）只表达方块事实,不混入当前执行距离
- 架构冲突: 无

## T-052C | 2026-05-04 | plugin（服务端模组）树木/矿石相连连锁掉落

- 涉及模块: plugin（服务端模组） Fabric（模组加载器）入口 `MCServantMod`,chainbreak（连锁破坏） handler（处理器）,服务端日志 diagnostics（诊断）
- A 拆解依据: 用户要求 plugin（服务端模组）在真实方块破坏事件中把一次挖树木/矿石扩展为同类相连资源连锁破坏并生成正常掉落物;边界限定 plugin（服务端模组）与 diagnostics（诊断）,不进入 ResourceService（资源服务）、cutTree（砍树）正式 skill（技能）接入或 LLM（大语言模型）;用户交互中追加普通玩家也应触发,因此触发范围从 bot（机器人）扩展为所有 ServerPlayerEntity（服务端玩家实体）
- C 审查结论: 通过;B（实现代理）交互中曾处理 bot（机器人）名称过滤、旧 jar（归档包）部署和树叶不自然凋零疑问,最终实现走 `PlayerBlockBreakEvents.AFTER`（破坏后事件）与 `ServerPlayerInteractionManager.tryBreakBlock`（服务端玩家破坏入口）,并由用户实服确认连锁掉落后树叶可按 vanilla（原版）机制自然凋零
- 关键决策: 树木/矿石识别消费服务端 registry/tag（注册表/标签）事实,不判断自然树或用户需求数量;连锁破坏逐块调用玩家破坏入口而不是手动 drop（掉落）+ setBlockState（设置方块状态）,保留掉落、工具耐久、邻居更新、统计与 Fabric（模组框架） break hook（破坏钩子）等原版副作用;用 ThreadLocal（线程局部变量）递归保护避免 handler（处理器）再次触发自身,并记录 destroyed（破坏数）、scanned（扫描数）、truncated（截断）和 failure reasons（失败原因）
- 架构冲突: 无

## T-053 | 2026-05-04 | cutTree（砍树）技能接入资源簇执行链

- 涉及模块: skills（技能） `cutTree`（砍树）执行器,sandbox（沙箱）/BotActor（机器人执行代理）技能入口,runtime/transport（运行时传输层）按坐标挖掘与 Mineflayer（Minecraft 协议客户端）资源事实兜底,ResourceService（资源服务）树木簇选择,collect（捡拾）复用,conversation/llm（对话大语言模型） prompt（提示词）与技能计划表,diagnostics（诊断）recent event（近期事件）,Docs/04_CONVERSATION_SPEC.md（对话规格文档）
- A 拆解依据: 用户要求“砍 N 块木头”只由 LLM（大语言模型）输出高层 `cutTree(count)` skill call（技能调用）,执行层按当前 `world_key`（世界键）消费 T-052B（任务）树木簇推荐目标,挖一个原木触发 T-052C（任务） plugin（服务端模组）连锁掉落,collect（捡拾）后以真实 inventory diff（背包增量）判断是否继续;边界允许 skills（技能）、sandbox（沙箱）、runtime/transport（运行时传输层）、BotActor（机器人执行代理）、ResourceService（资源服务）、collect（捡拾）、conversation/llm（对话大语言模型）与 diagnostics（诊断）,明确不启用 mine（挖矿）或 equip（装备）
- C 审查结论: 通过;B（实现代理）曾因“砍 5 块木头无反应”返修真实链路,补齐 `tree` 资源事实兜底、triage（分诊） prompt（提示词）动作指向、GoalNear（近距离目标）加载与 Vec3（三维向量）坐标对象;用户追加禁止 regex（正则表达式）语义捕获后,B（实现代理）撤掉新增 regex（正则表达式）兜底并用 prompt（提示词）约束;C（审查代理）确认当前 diff（差异）未启用 mine（挖矿）/equip（装备）、未进入 plugin（服务端模组）,`bash scripts/pre_review.sh` 全绿
- 关键决策: 选择在 `cutTree`（砍树）确定性执行器中循环消费 ResourceService（资源服务）当前世界树木簇,优先单个足量近簇、否则累计多个小簇;每轮只挖推荐原木并复用 collect（捡拾）,以背包真实增量而非簇预估数量作为完成标准;LLM（大语言模型）只负责输出 `cutTree({count})`,不输出坐标、簇、循环或挖掘目标;资源事实兜底仍放 runtime/transport（运行时传输层）并消费 Mineflayer（Minecraft 协议客户端）/minecraft-data（Minecraft 数据库）事实,不在 world-model（世界模型）按方块名猜测
- 架构冲突: 无

## T-053-DBG | 2026-05-04 | cutTree（砍树）长程任务目标选择与捡拾修复

- 涉及模块: world-model（世界模型）树木簇推荐目标,skills（技能） `cutTree`（砍树）执行器,collect（捡拾）公共参数契约,runtime/transport（运行时传输层）collect（捡拾）适配,Docs/04_CONVERSATION_SPEC.md（对话规格文档）,相关测试
- A 拆解依据: 用户实服发现长程 `cutTree`（砍树）中推荐目标可能选到高处原木导致 pathfinder（寻路器）贴近树冠超时,且砍完一簇后的 collect（捡拾）失败会被吞掉后继续下一棵;用户明确要求默认选最低原木,砍完等待 0.5 秒后以树簇中心半径 8 捡拾全部掉落物,collect（捡拾）默认仍为 32 但显式调用可小于 32
- C 审查结论: 曾打回 1 次 (首次返修仍吞掉 collect（捡拾）异常,且公共 `collect`（捡拾）参数校验仍拒绝 `radius: 8`);B（实现代理）移除吞错逻辑、区分规划建议最小半径 32 与显式调用最小半径 1,并补齐失败回归测试后通过
- 关键决策: 树木簇推荐目标改为最低合法原木,避免 `GoalNear`（近距离目标）要求 Bot（机器人）靠近高处树冠;`cutTree`（砍树）每轮挖掘后强制调用无 `itemName`（物品名）过滤的 collect（捡拾）,以树簇中心和半径 8 清扫范围内全部掉落物,collect（捡拾）失败直接让任务失败并暴露原始错误
- 架构冲突: 无

## T-055 | 2026-05-04 | 最小 CraftService（合成服务）与 Mineflayer（Minecraft 客户端库）合成适配

- 涉及模块: domain（领域） CraftService（合成服务）,core-ports（核心端口）工具链失败码,runtime/transport（运行时传输层） Mineflayer（Minecraft 客户端库）合成适配,运行时与技能契约测试
- A 拆解依据: 用户要求实现 Phase 1（第一阶段）最小合成能力,支持 planks（木板）、stick/sticks（木棍）、crafting_table（工作台）、wooden_pickaxe（木镐）、stone_pickaxe（石镐）;配方、材料数量、是否需要工作台必须来自 Mineflayer（Minecraft 客户端库）/minecraft-data（Minecraft 数据库）/runtime（运行时）校验;边界限定 Domain（领域服务）、Runtime（运行时）、Skills（技能基础能力）、Inventory（背包状态）,不做通用 RecipeService（配方服务）、不做熔炼、不碰 LLM（大语言模型） prompt（提示词）
- C 审查结论: 通过
- 关键决策: CraftService（合成服务）只做 allowlist（白名单）目标边界与 `sticks`（木棍复数）别名归一化,不写材料数量或配方形状;实际 recipe（配方）选择、材料检查、crafting table（工作台）需求判断和 craft（合成）执行下沉到 runtime/transport（运行时传输层）消费 Mineflayer（Minecraft 客户端库）/minecraft-data（Minecraft 数据库）事实;planks（木板）泛化目标通过注册表事实候选收敛,拿不到事实时结构化失败
- 架构冲突: 无

## T-056 | 2026-05-04 | 最小 PlacementService（放置服务）与 crafting table（工作台）放置执行链

- 涉及模块: domain（领域） PlacementService（放置服务）,core-ports（核心端口）工具链能力契约,sandbox（沙箱） Facade API（门面接口） 与失败冒泡,BotActor（机器人执行代理）单写者接线,runtime/transport（运行时传输层） Mineflayer（Minecraft 客户端库）放置/合成/工作台缓存适配,conversation/llm（对话大语言模型）规划提示词,相关测试
- A 拆解依据: 用户要求实现只服务工具链的 crafting table（工作台）放置能力,能在附近选择有支撑、目标空间为空、Bot（机器人）可接近且可点击的位置放置,成功后缓存工作台位置并供后续 craft（合成）复用;不得扩展为通用 placeBlock（放方块）建筑系统;实服返修追加要求背包无工作台时先合成,缺 planks（木板）但有原木时按运行时配方尝试合成木板,失败必须结构化冒泡
- C 审查结论: 通过;曾打回 1 次 (`lookAt`（看向目标） 与 pathfinder goals（寻路目标） 真实库类型契约未收口,仍可能重复 `point.minus is not a function` 与 `GoalNear`（近距离目标）导出形态问题);B（实现代理）将 `lookAt`（看向目标）端口改为 `Vec3`（三维向量） 实例,并新增集中 `pathfinder-goals`（寻路目标解析器）后通过
- 关键决策: `place`（放置） 作为 sandbox（沙箱）工具链能力暴露,不升级为正式 skill（技能）且只允许 `crafting_table`（工作台）;真实 Mineflayer（Minecraft 客户端库）动作仍经 BotActor（机器人执行代理）串行进入 runtime/transport（运行时传输层）;放置前复用 T-055（任务） craft（合成）适配,候选位置最多尝试 3 个并把失败 attempts（尝试记录）结构化透传;Mineflayer（Minecraft 客户端库）真实对象类型与 pathfinder（寻路器）导出解析收敛到 runtime/transport（运行时传输层）契约和 helper（辅助函数）
- 架构冲突: 无

## T-057 | 2026-05-04 | 最小 equip（装备）技能启用与主手切换

- 涉及模块: core-ports（核心端口）技能契约,runtime/transport（运行时传输层） Mineflayer（Minecraft 客户端库）装备适配,BotActor（机器人执行代理）与 BotWorker（机器人工作线程）单写技能入口,conversation/llm（对话大语言模型）规划门禁与提示词,plugin（服务端模组） `/svs`（服务端桥接命令）成功回显,相关测试
- A 拆解依据: 用户要求实现最小 equip（装备）能力,至少支持 wooden_pickaxe（木镐）和 stone_pickaxe（石镐）,检查当前手持物、背包目标物并调用 runtime（运行时）装备;不得做 armor（护甲）、武器策略或自动最佳工具选择;返修中用户明确指出“装备就是拿在手上”且需要支持装备 bread（面包）到主手,并要求 `/svs`（服务端桥接命令）游戏内回显玩家原始输入而非固定“已转发”
- C 审查结论: 通过;`bash scripts/pre_review.sh`（评审前预检脚本） 全绿,33 个 test file（测试文件）/340 个 test（测试）通过;`plugin`（服务端模组） `./gradlew build` 通过;用户已实服确认 bread（面包）可装备到主手
- 关键决策: `equip`（装备） 语义收敛为“把背包目标物品拿到主手”,`destination`（目标槽位） 只开放 `hand`（主手）,不扩展护甲/武器/最佳工具系统;执行层先比较 `heldItem`（当前手持物） 返回 `already_equipped`（已装备）,再从 inventory（背包） 查找目标物并调用 Mineflayer `equip`（装备）,失败以 `missing_item`（缺目标物品） 或 `runtime_equip_failed`（运行时装备失败） 结构化冒泡;`/svs`（服务端桥接命令） 只改成功回显文本,不改变 player_message（玩家消息）协议帧或 TS Core（TypeScript 单核心）入口
- 架构冲突: 无

## T-058 | 2026-05-04 | StairBFSPlanner（阶梯广度优先规划器）采矿核心

- 涉及模块: domain（领域） StairBFSPlanner（阶梯广度优先规划器）/WorldScanner（世界扫描器）/SafetyChecker（安全检查器）/OreHandler（矿石处理器）契约,domain（领域）导出边界,领域模型测试
- A 拆解依据: 用户要求实现采矿规划核心,以“玩家脚下位置”为 BFS（广度优先搜索）节点,状态包含 pos（位置）、dir（方向）、mode down/up（下降/上升模式）、usedFill（已用填充数）,先不填方块规划、失败后才允许低价值方块补路;边界限定 WorldScanner（世界扫描器）、SafetyChecker（安全检查器）、StairBFSPlanner（阶梯规划器）、OreHandler（矿石处理器）与 Executor（执行器）规划部分,明确不接 LLM（大语言模型）、不把 stone（石头）加入资源簇、不做大型洞穴探索或火把系统
- C 审查结论: 通过;`bash scripts/pre_review.sh`（评审前预检脚本） 全绿,34 个 test file（测试文件）/347 个 test（测试）通过;`git diff --check`（差异空白检查）通过
- 关键决策: 规划器保持纯 domain（领域）核心,只消费 scanner（扫描器）预分类 block role（方块角色）,不在业务逻辑中硬编码 Mineflayer（Minecraft 客户端库）/minecraft-data（Minecraft 数据库）事实;默认第一阶段只找无填充安全路线,调用方给出 fill budget（填充预算）后才运行第二阶段;step（步骤）输出只包含 nextFoot（下一脚部空间）/nextHead（下一头部空间）挖掘与 nextFloor（下一地板）填充计划,执行动作留给后续任务
- 架构冲突: 无

## T-059 | 2026-05-05 | mine（挖掘）技能接入 StairBFSPlanner（阶梯广度优先规划器）

- 涉及模块: skills（技能） mine（挖掘）执行器,ResourceService（资源服务）矿石候选,runtime/transport（运行时传输层） mine（挖掘）适配与队列构建,domain（领域） StairBFSPlanner（阶梯广度优先规划器）安全规则,core-ports（核心端口）技能契约,BotActor（机器人执行代理）/sandbox（沙箱）入口,conversation/llm（对话大语言模型） mine（挖掘）门禁,相关测试
- A 拆解依据: 用户要求 mine（挖掘） 能用 T-058（任务） StairBFSPlanner（阶梯规划器）安全采集 stone（石头）和 ore（矿石）;stone（石头）不进 ResourceService（资源服务）资源簇,从 bot（机器人）当前位置先规划完整阶梯 dig queue（挖掘队列）再执行到底;ore（矿石）必须消费 ResourceService（资源服务）按具体 blockName（方块名）给出的目标候选;执行前检查工具,执行后用 inventory diff（背包增量）判断掉落,世界定位只走既有 worldKey（世界键）接口;不碰 plugin（服务端模组）
- C 审查结论: 曾打回 2 次 (首次实现让 ore（矿石）在 runtime（运行时）重新 findBlocks（查找方块）、自行读取 bot.game.dimension（机器人维度）、硬编码掉落/工具事实且 mine.ts（挖掘文件）过大;二次审查发现 stone（石头）仍偏向短段重规划/边挖边看,unknown block（未知方块）邻近风险被乐观放行,已有洞复用未按总 walking distance（行走距离）丢弃);B（实现代理）拆分事实/工具/队列模块,改为完整预规划队列、矿石相邻站位、unknown（未知）保守拒绝、反向下降硬拒绝与已有洞 32 步总距离限制后通过
- 关键决策: 普通资源采集以 StairBFSPlanner（阶梯广度优先规划器）从当前脚位生成完整 dig queue（挖掘队列）,不先全局扫描最近 stone（石头）,也不在执行阶段按掉落结果二次重规划;矿石路径保留 ResourceService（资源服务）作为候选真源,runtime（运行时）只规划到安全相邻 standingPos（站位）再挖目标方块;MC（Minecraft,我的世界）掉落、工具与方块角色事实由 Mineflayer（Minecraft 客户端库）/minecraft-data（Minecraft 数据库） registry（注册表）读取;已有 air（空气）阶梯靠低挖掘代价自然胜出,但不引入 tunnel memory（隧道记忆）
- 架构冲突: 无;LLM（大语言模型）失败 retry（重试）闭环已标记为需 Planner A（规划代理）确认/另拆的范围项,不作为本条 runtime（运行时） mine（挖掘）验收条件

## T-060 | 2026-05-05 | Toolchain ensure（工具链确保）函数组

- 涉及模块: skills（技能） toolchain-ensure（工具链确保）编排器,core-ports（核心端口）工具链能力契约,sandbox（沙箱） Facade API（门面接口） 与执行器,BotActor（机器人执行代理）工具链分发,runtime/transport（运行时传输层）背包语义计数,app（应用装配）生产注入,conversation/llm（对话大语言模型） planner prompt（规划提示词）,Docs/03_SANDBOX_SPEC.md（沙箱规格文档）/Docs/04_CONVERSATION_SPEC.md（对话规格文档）,相关测试
- A 拆解依据: 用户要求实现可复用 ensure（确保）函数组 `ensureLogs(count)`（确保原木）、`ensureCraftingTablePlaced()`（确保工作台已放置）、`ensureWoodenPickaxeEquipped()`（确保木镐已装备）、`ensureCobblestone(count)`（确保圆石）、`ensureStonePickaxeEquipped()`（确保石镐已装备）,只能组合 cutTree（砍树）/collect（捡拾）/craft（合成）/place（放置）/equip（装备）/mine（挖掘）等底层通用能力,不得新增 `demoMineIron()`（演示挖铁） 或绕过 BotActor（机器人执行代理）直接操作 runtime（运行时）
- C 审查结论: 曾打回 1 次 (首次实现把 `ensureCobblestone(count)`（确保圆石） 的目标总数语义与缺口数量混用,导致已有 2 个 cobblestone（圆石）且缺 1 个时不挖 stone（石头）;真实 app（应用）装配未注入 runtime（运行时）语义原木计数,背包已有原木仍触发 cutTree（砍树）;ensure（确保）结果丢弃底层 world_key（世界键）);B（实现代理）补齐目标总数转换、`countInventoryItemsBySemanticRole("cut_tree_log")`（按砍树原木语义角色统计背包）与 ToolchainActionSummary（动作摘要）世界键透传后通过
- 关键决策: ensure（确保） 层保持高层编排,不写配方/掉落/工具等级等 MC（Minecraft,我的世界）事实;缺料恢复先把 runtime craft（运行时合成）返回的 missing（缺口）换算为 ensure（确保）目标总数,再调用普通能力补齐;原木识别下沉到 runtime/transport（运行时传输层）基于 Mineflayer（Minecraft 客户端库）/minecraft-data（Minecraft 数据库） registry（注册表）与 `cut_tree_log`（砍树原木）语义角色统计,不在 ensure（确保）里按名称后缀猜测;planner prompt（规划提示词）只暴露可读的 `api.bot.ensureStonePickaxeEquipped()`（确保石镐已装备）等通用函数,不隐藏整条挖铁 demo（演示）链
- 架构冲突: 无

## T-061 | 2026-05-05 | sandbox TS（沙箱 TypeScript）可编程 API（接口）与失败上下文

- 涉及模块: core-ports（核心端口）工具链能力契约,sandbox（沙箱） contracts（契约）/Facade API（门面接口）/execution（执行器）,BotActor（机器人执行代理）工具链分发与 FacadeCallError（门面调用错误）包装,Docs/03_SANDBOX_SPEC.md（沙箱规格文档）/Docs/04_CONVERSATION_SPEC.md（对话规格文档）,相关测试
- A 拆解依据: 用户要求暴露 sandbox TS（沙箱 TypeScript） 可编程 API（接口）,补齐 `placeCraftingTable()`（放置工作台） 受控入口,并让 craft（合成）/place（放置）/equip（装备）/mine（挖掘）/ensure*（确保函数） 失败时保留 `failure_stage`（失败阶段）、`current_position`（当前位置）、`inventory_summary`（背包摘要）、`equipment_summary`（装备摘要） 与 `target_progress`（目标进度） 等结构化上下文;边界限定 sandbox（沙箱）、skills（技能注册/契约）、runtime（运行时）、diagnostics（诊断） 与 BotActor（机器人执行代理）,不改 Plan LLM（规划大语言模型） prompt（提示词）,不做自动挖铁
- C 审查结论: 通过;`git diff --check`（差异空白检查）通过,定向 Vitest（测试框架） 命令实际跑全量 34 个 test file（测试文件）/377 个 test（测试）通过,`bash scripts/pre_review.sh`（评审前预检脚本） 全绿;未发现 Plan LLM（规划大语言模型）源码改动、plugin（服务端模组）越界或 `demoMineIron()`（演示挖铁）隐藏链路
- 关键决策: `placeCraftingTable()`（放置工作台） 只作为 `place({blockName:"crafting_table"})`（放置工作台参数）的零参数别名,不封装合成/装备/挖矿等额外链路;失败上下文在 BotActor（机器人执行代理）统一读取 observation（观测）快照并注入 FacadeCallError.details（门面调用错误细节）,保证 skill（技能）路径和 toolchain（工具链）路径诊断形态一致,同时不让 sandbox（沙箱） 直接读取 runtime（运行时）内部状态
- 架构冲突: 无

## T-062 | 2026-05-05 | TaskResultReporter（任务结果汇报器）终态主动汇报

- 涉及模块: core-ports（核心端口）任务结果摘要契约,BotWorker（机器人工作线程）终态动作与中断识别,TaskResultReporter（任务结果汇报器）模板渲染,app（应用装配）双端同步接线,realtime（实时推送）/game chat（游戏聊天）输出,task history（任务历史）任务卡,result summary（结果摘要）,runtime/transport（运行时传输层） collect（捡拾）返修,skills（技能） cutTree（砍树）捡拾中心与等待策略,Docs/02_RUNTIME_SPEC.md（运行时规格文档）/Docs/03_SANDBOX_SPEC.md（沙箱规格文档）/Docs/04_CONVERSATION_SPEC.md（对话规格文档）,相关测试
- A 拆解依据: 用户要求每个任务 completed（完成）/failed（失败）/interrupted（中断）后由确定性 TaskResultReporter（任务结果汇报器）主动同步游戏聊天与网页端,成功汇报任务类型、完成数量、关键背包增量、耗时和世界摘要,失败汇报失败码、阶段、可恢复性与下一步建议,中断不得误报成功;边界限定 BotWorker（机器人工作线程）、任务生命周期事件、realtime（实时推送）、game chat（游戏聊天输出）、task history（任务历史）、diagnostics（诊断） 与 core-ports（核心端口）摘要契约,明确不改 Plan prompt（规划提示词）、不让 BotActor（机器人执行代理）决定文案、不用 LLM（大语言模型）总结
- C 审查结论: 曾打回 1 次 (sandbox（沙箱） 前置步骤成功、后续步骤失败时,result summary（结果摘要） 会误取最后成功 step（步骤） 导致用户看到错误操作名;Docs/04_CONVERSATION_SPEC.md（对话规格文档） 仍写旧的 0.5 秒与树簇中心 collect（捡拾）语义);B（实现代理）改为失败/中断摘要优先取失败 step（步骤） action（动作）/FacadeCallError.method（门面调用错误方法）/failure_stage（失败阶段）,并同步文档到 1 秒等待、最低原木中心、半径 8 与 3 格高度带后通过;`git diff --check`（差异空白检查）通过,`pnpm typecheck`（类型检查）通过,`pnpm test -- app-entrypoint-model.spec.ts`（入口模型测试）实际跑全量 34 个 test file（测试文件）/384 个 test（测试）通过,`bash scripts/pre_review.sh`（评审前预检脚本） 全绿
- 关键决策: TaskResultReporter（任务结果汇报器）只消费 BotWorker（机器人工作线程）产出的终态任务卡,在 app（应用装配）层统一调用 `broadcastReply`（广播回复） 与 realtime（实时推送） `chat.reply`,不把汇报决策塞进 BotActor（机器人执行代理）;result summary（结果摘要）作为跨 game chat（游戏聊天）/web UI（网页界面）/task history（任务历史）的轻量事实契约,skill_call（技能调用）和 sandbox_code（沙箱代码）共用模板;collect（捡拾）返修保留严格“同高度带内可见掉落物清空”语义,但忽略树冠高处滞留掉落物并把拾取靠近范围收紧到 0.75,避免部分捡拾误报完成或被树叶滞留物拖死
- 架构冲突: 无

## T-063 | 2026-05-05 | SkillResultSummary（技能结果摘要）统一契约

- 涉及模块: core-ports（核心端口） SkillResultSummary（技能结果摘要）/TaskResultSummary（任务结果摘要）契约,BotWorker（机器人工作线程）终态摘要生成,TaskResultReporter（任务结果汇报器）消费路径,sandbox（沙箱）成功/失败摘要转换,Docs/02_RUNTIME_SPEC.md（运行时规格文档）/Docs/03_SANDBOX_SPEC.md（沙箱规格文档）,app entrypoint（应用入口）回归测试
- A 拆解依据: 用户要求统一 cutTree（砍树）/mine（挖掘）/collect（捡拾）/craft（合成）/place（放置）/equip（装备）/ensure（确保） 的结果摘要,成功摘要统一包含 `skill_name`（技能名）、`status`（状态）、`target`（目标）、`completed_count`（完成数量）、`inventory_delta`（背包增量）、`world_key`（世界键）、`duration_ms`（耗时） 与 diagnostics（诊断）,失败摘要统一包含 `failure_code`（失败码）、`failure_stage`（失败阶段）、`recoverable`（是否可恢复）、`current_position`（当前位置）、`inventory_summary`（背包摘要）、`equipment_summary`（装备摘要） 与 `target_progress`（目标进度）;边界限定 core-ports（核心端口）、skills（技能）、sandbox（沙箱）、BotWorker（机器人工作线程） 与 diagnostics（诊断）,不碰 LLM（大语言模型） prompt（提示词）,不改变执行语义
- C 审查结论: 曾打回 1 次 (直接 skill_call（技能调用） 失败路径仍从普通 Error（错误对象）生成不完整 failure（失败摘要）,例如 `mine(stone,5)` 未装备时 `failure_stage`（失败阶段） 变成 `executeSkill`（执行技能）、`recoverable`（可恢复性） 为 null 且缺 `target_progress`（目标进度）/上下文);B（实现代理）补齐 job（任务）参数到失败摘要的转换,无 runtime observation（运行时观测）时显式填 null 上下文,并让 recoverable（可恢复性） 基于最终 failure code（失败码）推断后通过;`git diff --check`（差异空白检查）通过,`pnpm typecheck`（类型检查）通过,`pnpm test -- app-entrypoint-model.spec.ts`（入口模型测试）实际跑全量 34 个 test file（测试文件）/387 个 test（测试）通过,`bash scripts/pre_review.sh`（评审前预检脚本） 全绿;审查时用 `pnpm tsx`（TypeScript 执行器） 直接复现 `not_equipped:stone:main_hand_empty` 摘要,确认 failure（失败摘要） 已包含 `mine` 阶段、`recoverable:true`、目标进度与 null 上下文
- 关键决策: 保留历史 `operation`（操作名） 兼容字段,但新消费方统一优先读 `skill_name`（技能名） 与 `failure`（失败摘要）,避免 TaskResultReporter（任务结果汇报器）继续按各 skill（技能）私有字段猜测;world_key（世界键） 只透传上游 currentWorld（当前世界）/ResourceService（资源服务）/runtime transport（运行时传输层） 结果,不在摘要层重新解析维度;直接 skill_call（技能调用） 失败没有 observation（观测） 时用显式 null 表达“未知”,保证契约形态稳定,把真实快照注入留给已有 sandbox（沙箱） FacadeCallError（门面调用错误）路径
- 架构冲突: 无

## T-064 | 2026-05-05 | LLM（大语言模型）调用分段 metrics（指标）诊断

- 涉及模块: conversation/llm（对话大语言模型） client（客户端）/stage（阶段执行器）/diagnostics（诊断）,diagnostics（诊断） contracts（契约）/JSONL（结构化日志）工厂,BrainWorker（大脑工作线程） LLM（大语言模型）调用,ConversationWorker（对话工作线程） LLM（大语言模型）事件,app entrypoint（应用入口） `/api/status`（状态接口）摘要装配,Docs/04_CONVERSATION_SPEC.md（对话规格文档）/Docs/05_DATA_SPEC.md（数据规格文档）,相关测试
- A 拆解依据: 用户要求记录每次 LLM（大语言模型）调用完整分段性能指标,包括 `queue_wait_ms`（队列等待）、`prompt_build_ms`（提示词构建）、`request_total_ms`（请求总耗时）、`response_parse_ms`（响应解析）、`tool_round_count`/`tool_round_ms`（工具轮次/耗时）、`diagnostics_write_ms`（诊断写入）、tokens（令牌） 与非流式 `ttft_ms:null`（首字延迟不可得）;边界限定 conversation/llm（对话大语言模型）、diagnostics（诊断）、conversation-worker（对话工作线程）、BrainWorker（大脑工作线程） 与 app diagnostics（应用诊断）,不得阻塞 BotWorker（机器人工作线程） 或暴露 prompt（提示词）全文
- C 审查结论: 通过;改动未进入 BotWorker（机器人工作线程）物理动作链路,BrainWorker（大脑工作线程）复用 `executeStage`（阶段执行器） 统一产出 `brain` 阶段诊断,`/api/status`（状态接口） 只暴露 `LlmDiagnosticSummary`（LLM 诊断摘要）中的 metrics（指标）与 `log_ref`（日志引用）,未暴露 prompt（提示词）全文或密钥;`git diff --check`（差异空白检查）通过,定向 Vitest（测试框架） 命令实际跑全量 34 个 test file（测试文件）/389 个 test（测试）通过,`bash scripts/pre_review.sh`（评审前预检脚本） 全绿;审查时额外用 `pnpm tsx`（TypeScript 执行器） 构造 0 值 metrics（指标）通过 `createLlmLogLine`（LLM 日志行工厂） 与 `createLlmDiagnosticSummary`（LLM 诊断摘要工厂） 校验,确认非负耗时和 `ttft_ms:null` 形态可落库/出状态;真实本地 OpenAI compatible API（OpenAI 兼容接口） 调用返回 `T064 review metrics ok喵~`,并产出 `request_total_ms=5539`、`input_tokens=134`、`output_tokens=168`、`ttft_ms=null`
- 关键决策: 用统一 `LlmCallMetrics`（LLM 调用指标） 契约挂在诊断记录和 JSONL meta（元信息） 上,而不是在 triage（分诊）/chat（闲聊）/plan（规划）/brain（大脑） 各自维护私有字段;非 streaming（非流式）链路明确 `ttft_ms:null` 且带 `ttft_unavailable:"non_streaming"`（首字延迟不可得原因）,不以总耗时伪造首字延迟;`diagnostics_write_ms`（诊断写入耗时） 在 app（应用装配）本地日志写入后回填到摘要和 JSONL meta（元信息）,同时保持完整 transcript（原始对话记录） 只写入脱敏后的 llm JSONL（LLM 结构化日志）,状态接口只读摘要
- 架构冲突: 无
