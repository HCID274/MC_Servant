# Python 项目分层架构图 (执行流向标注)

以下层级编号 **[0] ~ [8]** 标注了从 `main` 函数开始，一条指令从进入系统到最终执行的完整生命周期流向。

```text
backend/
│
├── [0] [入口层] (main.py)
│   ├── main.py                              <-- [0] 系统启动点：FastAPI 创建、WS 绑定、原始字节流入口，并初始化 Checkpointer 显式 msgpack 白名单
│   ├── config.py                            [配置] 环境变量读取、Trace DB / 可读 LLM 文本日志 / Checkpoint DB 路径配置，以及全局 LLM Provider 开关、Graph 调用超时与 OpenAI/Gemini 模型参数
│   ├── protocol.py                          [协议] WebSocket 消息模型定义；`npc_response` 同时承载聊天栏文本 `content`、头顶分段聊天 `segments` 与独立状态行 `hologram_text`
│   ├── schemas.py                           [状态] LLM/Graph 结构化数据模型定义（含 EnvSnapshot 标准快照 / ToolContext / 单主意图 RouterOutput / ChatPlannerOutput / 带 reason 与可选 `count` 的 TaskStep / trace_ctx / opening_reply_text / failure_reason）
│   ├── domain_registry.py                   [领域注册表] 统一加载 `target_mappings.json` 与 `resource_profiles.json`，为领域层/翻译层提供单一配置入口
│   └── domain_catalog.py                    [领域工具] 基于 DomainRegistry + `bot/mineflayer/assets/minecraft_data_bridge.js` 组装结构化查询结果，给 Planner 提供确定性任务事实与资源 profile 语义；`resource_profiles.json` 同时承载 cluster 采集目标的掉落映射（success_targets）；`build_tool_context()` 额外汇总工作台上下文（附近是否已有工作台、背包里是否已有工作台、目标/所需工具是否需要 3x3 合成）；其中“附近工作台”优先吃 `env_snapshot` 里的精确近距检测结果，不再只靠 `nearby_blocks` 摘要猜测；木板类配方材料会统一归一为 `planks`，避免把任意木板错误固化成 `oak_planks`
│
├── [1] [websocket 层] (通信基础设施)
│   └── websocket/
│       └── connection_manager.py            <-- [1] 通信中转：维护长连接，处理原始数据的收发与超时清理
│       └── session_runtime.py               [会话调度] 解耦“收包循环”和“业务处理循环”，为每个 client 建立入站队列
│
├── [2] [application 层] (流程编排层)
│   └── application/
│       ├── handlers/
│       │   ├── message_router.py            <-- [2] 路由分发：识别消息类型 (MessageType)，分拨至对应处理器
│       │   ├── player_handler.py            <-- [3] 玩家用例编排：统一经 Graph 决策；task 场景优先回传 Planner 开场白并入队，chat 场景执行轻互动计划后回包；在进入 Graph 前会把当前 `player` 绑定到 Bot，确保后续跟随/交付严格对准本次会话主人；用户可见台词统一走插件 `npc_response`
│       │   ├── servant_handler.py           [管理命令] 处理 claim/release/list/status 等管理员操作
│       │   └── presence_handler.py          [在线态同步] 处理 player_join/quit/login 等在线状态同步
│       ├── services/
│       │   ├── graph_runner.py              [图执行用例] 生成 run_id/thread_id、构造 `GraphRunContext` 后执行 LangGraph，并在入口与 fatal replan 场景下统一生成标准 env_snapshot；Router 即时回复只在 task 路径提前发声，chat 路径交给 Chat Planner 产最终回复
│       │   ├── task_job/                    [任务消费子包] 聚合任务执行主循环、失败策略、摘要调度与重规划辅助逻辑
│       │   │   ├── runner.py                [任务消费入口] 退化为 `TaskJobProcessor` 组装入口；主循环只保留“执行 -> 交给策略/通知/摘要”的扁平编排，并在任务开跑前把 `job.player` 绑定到 Bot，避免多人在线时跟错对象
│       │   │   ├── support.py               [任务策略支撑] 承载 TaskJobReporter / TaskFailurePolicy / StepSummaryScheduler / fatal replan 辅助逻辑；其中 TaskJobReporter 支持对 `speak/say` 步骤强制走 `npc_response`，避免普通 task 任务“只记日志不发声”
│       │   │   └── summary_input_builder.py [摘要预处理] 基于标准 env_snapshot，将 step 执行结果、`reason`、快照与最近摘要裁剪成适合 Summary Agent 理解的结构化输入
│       │   └── trace_dossier_service.py     [卷宗聚合] 基于 summary_id/thread_id 只读聚合摘要、事件、LLM 调用与 run 主档案
│       └── core/
│           ├── context.py                   [上下文] AppRuntime 共享依赖容器（含 checkpointer / trace_repo）
│           ├── bot_runtime.py               [Bot运行时] Bot 名称解析与按需拉起保障
│           └── response_sender.py           [统一回包] npc/error/hologram/init_config 响应封装；`send_npc_response()` 统一下发 `content + segments + hologram_text`
│
├── [3] [graph 层] (决策编排层)
│   └── graph/
│       ├── workflow.py                      <-- [4] 思考流：驱动 LangGraph 状态机；task 路径走 knowledge_loader + Task Planner，chat 路径走 Chat Planner；两条规划链各自独立调用对应 Planner，统一从标准 env_snapshot 读取规划上下文，写回 plan/opening_reply_text 或 chat_reply_text/chat_plan，并在编译时挂载 Checkpointer 与断点配置；工作台策略保持收口为“tool_context 提事实、Planner 出计划”，graph 层不再额外做二次工作台策略判定
│       ├── conditions.py                    [条件分流] 基于 Router 主意图判断进入 task 规划链、chat 规划链或直接结束
│       ├── knowledge_loader.py              [工具上下文装载] 根据 Router 抽取出的 task goal 与 env_snapshot 构造结构化 tool_context，替代旧的 markdown 知识注入
│       └── runtime_context.py               [图运行上下文] `GraphRunContext.to_state()` 统一收口 application -> graph 的共享状态组装
│
├── [4] [tracing 层] (运行留痕层)
│   └── tracing/
│       ├── store.py                         [Trace 门面] 组合 storage / dao / transcript writer，对外暴露稳定 trace 接口
│       ├── storage/                         [存储子包] 下沉 SQLite schema、迁移、自修复、DAO 与文本留痕实现
│       │   ├── schema.py                    [表结构常量] agent_run / llm_call / run_event / step_summary 建表 SQL
│       │   ├── manager.py                   [存储管理] 连接开启、建表、迁移、自修复、外键修复
│       │   ├── repository.py                [纯 DAO] 只负责 SQLite 读写，不再承担 schema 初始化或文本日志输出
│       │   └── transcript_writer.py         [文本留痕] 负责 LLM 输入输出文本转储到本地文件
│       └── __init__.py                      [导出] 暴露 TraceRepository / TraceStore
│
├── [5] [llm_agent 层] (认知层)
│   └── llm_agent/
│       ├── client_factory.py                [模型工厂] 统一创建 Router / Chat Planner / Task Planner / Summary 使用的 LLM 客户端，并按全局开关切换 OpenAI/Gemini；Gemini SDK 调用默认显式关闭 thinking budget，避免额外思考阶段拖慢首包
│       ├── agents/                          [Agent 实现子包] 聚合 Router / Chat Planner / Task Planner / Summary 四类模型调用实现
│       │   ├── router.py                    [意图识别 Agent] 调用 LLM 输出当前单个主意图（task/chat）与即时回复，并记录原始 Prompt / Output
│       │   ├── chat_planner.py              [聊天规划 Agent] 调用 LLM 基于 goal + env_snapshot 生成 grounded 回复与轻互动步骤，只允许 `move_to/look_at/animate/speak`
│       │   ├── planner.py                   [任务拆解 Agent] 调用 LLM 基于 Router goal + env_snapshot + tool_context 将宏观目标细化为带 reason / 可选 `count` 的原子步骤；物品“准备/交付”场景必须规划真实 `drop`
│       │   └── summary.py                   [步骤摘要 Agent] 调用 LLM 将单步执行结果压缩成一句索引摘要
│       ├── structured_output.py             [结构化解析] 从 LLM 原始文本中提取 JSON 并做 Pydantic 校验
│       ├── prompts.py                       [提示词装载] 管理并动态填充提示词模板资源
│       └── prompts/...                      [提示词资源] `*_agent.md` 格式的 Agent 提示词
│
├── [6] [execution 层] (任务调度层)
│   └── execution/
│       ├── task_queue.py                    <-- [6] 任务入队：接收 Planner 产出的步骤序列（含可选 `count`）、trace_ctx 与 `hologram_text` 等展示上下文，按 Bot 维度压入队列
│       ├── task_worker.py                   [消费循环] 开启串行工作线程，逐一从队列中提取并执行任务
│       ├── chat_executor.py                 [轻互动执行器] 执行 Chat Planner 产出的 `move_to/look_at/animate/speak` 轻动作；其中 `speak` 只保留逻辑语义与最终台词，不直接调用 Mineflayer 公屏发言，失败时退化为纯文本回复
│       ├── task_executor.py                 [原子执行器] 通过动作/命令注册表执行原子步骤，原生支持 `speak / mine / craft / drop / pick_up / place` 命令分发，并把 `action + target + count + reason` 一并绑定进 ActionResult；其中 `speak/say` 产出的 `spoken_text` 会被任务主循环强制交给插件 `npc_response` 展示，`mine` 统一走资源簇语义执行，`move_to` 会把业务超时显式传给底层移动阻塞链
│       └── error_translator.py              [错误翻译官] 将 Mineflayer/执行层原始错误归一为 error_code / failure_class / failure_reason；除 `raw_name` 外也会补看 `raw_message` 与 `retryable_hint`，并覆盖 `craft/place/equip/drop` 状态不一致、`craft` 缺工作台、`drop` 数量不足/超时，以及 `mine` 采后未入包等执行后置校验失败
│
├── [7] [grounding 层] (语义对齐层)
│   └── grounding/
│       ├── task_translator.py               <-- [7] 语义映射：将 LLM 的“模糊目标”转换为执行层的“精确参数”，不再把 `craft / drop / pick_up / place` 直接打成 unsupported；`mine / craft / drop` 会透传 `count`，`mine` 另附带资源 profile 与 cluster 选择语义
│       ├── snapshot_builder.py              [环境快照] 聚合 Mineflayer 的 bot/玩家坐标、背包、装备、生命饱食度与资源摘要，并标准化为全链路唯一 env_snapshot 结构
│       ├── cluster_selector.py              [定位算法] 处理 mine 等动作所需的 BFS 聚类与最近目标选择
│       ├── translator.py                    [兼容模块] 既有聊天动作的语义映射实现
│       └── env_client.py                    [环境接口] 预留用于查询游戏世界方块数据的客户端接口
│
└── [8] [bot 层] (物理驱动层)
    └── bot/
        ├── mineflayer_adapter.py            <-- [8] 外观导出：退化为 MineflayerBot 工厂 / Facade 导出层，不再承载重逻辑
        ├── manager.py                       [Bot 管理器] 独立维护 Bot 实例池、spawn/remove/shutdown 生命周期
        ├── runtime_rules.py                 [运行时规则加载] 从 `backend/data/runtime_rules.json` 读取空气方块与脚手架配置
        ├── interfaces.py                    [能力契约] 定义 IBotController/Actions、ActionResult 与 BotActionError 等标准能力规范；交付语义统一收口为 `drop`
        ├── mineflayer/                      [Mineflayer 子包] 聚合 Python mixin 与 JS 伴生脚本
        │   ├── bot.py                       [组装层] 通过多重继承组合 lifecycle / movement / environment / action mixin
        │   ├── base.py                      [共享基类] 承载 MineflayerBot 共享状态与通用工具（坐标转换、JS 异常收口、当前会话 `master_name` 绑定、JS `players` 容器兼容查找）
        │   ├── lifecycle.py                 [生命周期 mixin] 连接、插件装载、AuthMe、事件注册、动作错误缓存；Mineflayer 初始化时会同时装配 collect watchdog 与 stair mining 两类 JS 伴生 helper
        │   ├── movement.py                  [移动交互 mixin] `jump/chat/spin/look_at/navigate_relative/look_at_eyes/animate`；`master_front/master_side/master_eyes` 统一解析为当前绑定主人的实时坐标，而不是任意在线玩家；`navigate_relative` 通过 `pathfinder.goto` 阻塞到真正到达目标半径，外层再用业务超时兜底，避免假移动
        │   ├── environment.py               [环境感知 mixin] 资源缓存快照、cluster 查询、环境快照采集、位置读取；cluster 选块阶段会再用 live `blockAt` 校验缓存坐标是否仍是预期资源，若现场已变 `air` 或被替换，会立即淘汰该坐标并继续选下一个候选，避免刚挖空的旧矿点被重复选回
        │   ├── action.py                    [物理动作 mixin] `mine/craft/drop/pickup/place` 与 post_collect / 掉落补拣闭环；`mine` 支持按 `count` 循环采集，执行前会显式调用 `bot.tool.equipForBlock(requireHarvest=true)` 做强制工具守门，不再单靠当前主手 `canHarvest` 判定放行；缺少合格工具时直接返回 `NoItem`，交给上层重规划补工具链。`mine.precheck` 会把目标方块、当前主手、执行策略与预期掉落写进日志；采集执行现在分成两条物理路径：矿脉资源（`resource_profiles.json` 中 `profile=ore_vein`）或当前目标与 bot 的 Y 轴高度差绝对值大于 3 时，改走 JS 侧 stair mining helper 做 3D BFS 楼梯开路与逐步移动；其余采集继续走 collect watchdog + collectBlock。普通 `goto`/伐木/地表移动不受影响。collectBlock 这条路径仍显式使用 `timeout=None` 避免再被桥接默认 10s 超时误杀；只要 bot 坐标继续变化、背包任意物品计数发生变化，或世界里观测到任意方块被破坏/替换，就允许 collectBlock 长跑；仅当“坐标长时间不变、背包无变化且世界里也没有方块破坏进展”持续 7 秒时，才主动中断并返回 `MineStalledTimeout`。若目标矿块已被挖空但未确认入包，会把该坐标记入 failed block 集合，避免局部重试继续撞同一块空气；而一旦某轮采矿确认成功，执行层会立即刷新一次资源缓存，减少 cluster 继续引用旧矿点快照的窗口。楼梯采矿的搜索预算也会按当前起终点跨度与状态搜索规模动态放大，避免高垂直差矿点过早命中 `max_nodes_reached`。`drop` 调用 `toss/tossStack` 并强校验库存真实减少，且在交付前会优先朝向当前绑定主人；对 `craft/place/equip` 维持阻塞式状态验收、显式 JS 桥接超时和工作台前置校验，其中 `craft` 在需要 3x3 配方时只负责复用附近已有工作台，不再由执行器隐式自动放台；若 Planner 漏掉 `place crafting_table`，执行层会直接返回 `MissingCraftingTable` 进入重规划；当 `recipesFor()` 返回空时，会先做库存刷新，再调用 JS 侧 recipe helper 直接选择并 patch Mineflayer 原生 Recipe，处理任意木板等 family/tag 材料；`craft.precheck` 诊断日志会显式标出本次配方来源是 `direct_without_table / direct_with_table / fallback / none`，避免再把 `recipes_all_count=0` 误读成“没有配方”；`place` 在 equip 成功后会先给服务端一个很短的同步窗口，再以 bot 当前脚下为中心扫描半径 2、上下 3 层的 3D 放置体积，过滤与 bot 脚下/头顶碰撞箱重叠、无支撑面或被水岩浆占据的候选点，并按距离从近到远依次尝试，避免在狭窄矿道里只会反复撞同一个平面落点；同时在检测到 `Timed out accessing` / `BrokenBarrierError` 后熔断库存与实体读取，防止二次崩溃
        │   └── assets/                      [JS 伴生资源] Mineflayer 资源缓存、快照投影、craft recipe helper、collect watchdog、stair mining helper 与 bridge 脚本
        └── README.md                        [文档] 适配器使用说明
```

---

## 指令执行生命周期 (Execution Lifecycle)

1.  **[0] 入口层 (`main.py`)**: WebSocket 收到原始 JSON；`heartbeat` 直接快路径回包，不进入业务队列。
2.  **[1] 会话调度 (`session_runtime.py`)**: 非心跳消息进入每个 `client_id` 的入站队列，由独立 dispatcher 异步消费。
3.  **[2] 路由层 (`message_router.py`)**: 按消息类型分流到 player/servant/presence 处理器。
4.  **[3] 应用编排 (`application/handlers/player_handler.py`)**: 所有玩家自然语言输入统一经 `application/services/graph_runner.py` 调用 LangGraph；任务场景优先向玩家发送 Planner 的 `opening_reply_text`，聊天场景则执行 `execution/chat_executor.py` 产出的轻互动步骤，并回传 grounded 最终回复；进入 Graph 前会把当前 `player` 绑定到 Bot，保证后续 `move_to master_front` / `drop` 指向这次会话的主人；用户可见文本统一从这里走 `send_npc_response()`。
5.  **[4] 运行留痕 (`tracing/store.py`)**: `TraceStore` 组合 StorageManager + Repository + TranscriptWriter；DAO 只负责 DB 读写，迁移/自修复与文本留痕不再混在一个类里；LangGraph Checkpointer 继续负责节点级 State 存档。
6.  **[5] 决策层 (`graph/workflow.py`)**: LangGraph 运转并产出任务队列（或 chat 轻互动计划）；Router 先输出当前主意图，task 分支继续构造 `tool_context` 并调用 Task Planner，chat 分支则把标准 `env_snapshot` 交给 Chat Planner 生成 grounded 回复与轻动作，再把 `plan / opening_reply_text` 或 `chat_reply_text / chat_plan` 写回共享状态。
7.  **[6] 调度层 (`execution/task_queue.py`)**: 快捷动作与规划动作统一按 Bot 维度串行入队，防止同 Bot 并发冲突；LangGraph 状态里的 `task_queue` 在单次运行与 fatal replan 时按整队覆盖，不再把旧计划与新计划错误叠加。
8.  **[6] 任务消费 (`application/services/task_job/runner.py` + `support.py`)**: `TaskJobProcessor` 只保留主循环；执行时会把 Planner 的 `count` 一并透传给执行层；`TaskJobReporter` 负责回包/打点，其中普通 task 的 `speak/say` 成功后也会强制下发 `npc_response`，不再出现“日志成功但游戏内失声”；`TaskFailurePolicy` 负责 recoverable/suspendable/fatal 决策，`StepSummaryScheduler` 负责摘要旁路，`try_fatal_replan()` 负责重规划上下文拼装与重入队。
9.  **[7] 翻译层 (`grounding/task_translator.py`)**: 执行前完成语义到参数的落地转换；`mine` 不再只是“最近一个方块”，而是携带 `resource / count / resource_profile / selection_policy` 进入执行层；涉及真实交付时，`drop` 负责把物品与数量映射到底层命令。
10. **[8] 执行层 (`bot/mineflayer/bot.py`)**: Mineflayer 真实执行仍保持不变，但内部被拆为 lifecycle / movement / environment / action 四个 mixin：连接/AuthMe 与 Mineflayer 事件注册不再和 `mine/craft/drop/pickup/place` 混在一个 God Object 中；`move_to master_front/master_side` 与 `look_at master_eyes` 会在执行当下读取当前绑定主人的实时实体坐标，而不是复用任务开始时的快照，也不再退化成“第一个非 bot 玩家”；底层玩家实体查找兼容 Mineflayer JS 桥对象，不再假设 `bot.players` 一定是 Python `dict` 并提供 `.get()`；移动执行不再 `setGoal()` 后立即返回，而是走 `pathfinder.goto(goal, timeout=None)` 并由 Python 外层业务超时兜底；`mine` 仍保持“挖掉并自动捡入背包”的复合动作语义，并支持按 `count` 循环采集；其中矿脉资源或 Y 轴落差大于 3 的采矿会切换到 JS 侧 stair mining helper，按楼梯路径逐步清障和移动，其余采矿继续使用 collectBlock watchdog；cluster 选块前后会额外校验缓存坐标对应的 live block，采矿成功后还会立即刷新资源缓存，减少旧矿点被重复命中的概率；高垂直差楼梯采矿则会显式放大状态搜索预算，降低 `max_nodes_reached` 误杀。`drop` 通过 `toss/tossStack` 真实丢物，并以库存减少作为唯一成功依据，交付前还会先朝向当前主人；`craft/place/equip` 则显式覆盖 JS 桥默认 10 秒 Barrier 超时，并在 `craft` 前基于 `minecraft-data` 配方维度预判是否必须依赖工作台。
