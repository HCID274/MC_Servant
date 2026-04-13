# MC 女仆 Agent 全局开发计划

## 1. 文档定位

- 本文是当前项目的总规划文档，负责统一说明目标架构、阶段路线、MVP 范围与工程边界。
- [00Python项目分层架构图.md](./00Python项目分层架构图.md) 继续作为 Python 代码分层基线文档。
- 本文优先描述“接下来怎么做”，而不是复述历史讨论过程。

## 2. 项目目标与优先级

### 2.1 项目定位

- 本项目是用于 AI Agent 实习面试与秋招展示的核心 Demo。
- 核心卖点不是单次对话效果，而是可解释、可控、可扩展的 Agent 工程能力。

### 2.2 优先级排序

1. 高可控工程系统。
2. 可爱女仆体验优先。
3. 为后续蒸馏小模型服务。

### 2.3 第一性原则

- 大模型不负责记忆或猜测游戏事实。
- 游戏内的事实真理源只认 `mineflayer`、`minecraft-data` 与实时 `world_state`。
- LLM 只负责语义理解、意图路由、任务拆解与人格化表达。

## 3. 第一阶段 MVP 定义

### 3.1 MVP 闭环

第一阶段必须打通以下端到端闭环：

`伐木 -> 合成工作台/木镐 -> 挖取 raw_iron -> 走近主人 -> drop -> 聊天汇报`

### 3.2 成功标准

- 成功解析用户任务。
- 成功生成原子动作序列。
- 成功执行 `mine / pick_up / place / craft / drop` 五类核心动作。
- 最终成功将 `raw_iron` 物理交付给主人附近。
- 在关键阶段切换时，女仆必须有明确聊天反馈。

### 3.3 失败标准

- Planner 无法生成合法原子步骤。
- 执行层在局部重试后仍无法完成关键动作。
- 未获得 `raw_iron` 或未完成交付。
- 流程中断后未能在重规划上限内恢复。

### 3.4 第一阶段不做

- 不做向量数据库或策略型 RAG。
- 不做熔炉/冶炼链路。
- 不做箱子、容器与 GUI 交互。
- 不做复杂建筑放置，仅支持放置工作台。
- 不做多实体协作。
- 不做跨回合长期记忆。

## 4. 目标架构

### 4.1 总体分层

系统按以下链路运行：

`world_state -> Router -> Domain Tool Layer -> Planner -> Executor -> Validator -> Replan/Finish`

### 4.2 World State 层

- 由 LangGraph 前置节点统一构造标准化 `world_state`。
- 所有 Agent 与 Tool 只读这一份公共状态，不允许各自重复拼接环境快照。
- `world_state` 至少包含：
  - 玩家输入
  - bot 坐标
  - 玩家坐标
  - 背包物品
  - 当前手持物
  - 血量/饱食度
  - 周边可视方块摘要
  - 当前版本与运行时上下文

### 4.3 Router

- Router 只负责判定当前主意图是 `task` 还是 `chat`。
- Router 输出结构仍保留数组包装，但当前阶段只保留一个主意图，并提取明确目标语义。
- 推荐输出结构：

```json
{
  "intents": [
    {"type": "task", "priority": 1, "goal": "获得并交付 raw_iron"}
  ]
}
```

- 若同一输入同时包含任务与解释需求，统一作为 `task` 进入规划链，由 Planner 在执行过程中的 `speak` 步骤给出解释。

### 4.4 Domain Tool Layer

- Tool Layer 只暴露查询工具，不直接输出完整计划。
- 第一阶段至少需要以下工具能力：
  - `resolve_item`
  - `get_recipe`
  - `check_inventory`
  - `get_block_drop`
  - `get_tool_requirement`
  - `find_nearby_resource`
  - `check_has_crafting_table`
- 若工具查询结果与旧 JSON 规则冲突，以底层实际 API 行为为准，并通过调试修正工具层。

### 4.5 Planner

- Planner 负责把目标与工具查询结果拆成原子动作序列。
- Planner 必须保留任务逻辑推理能力，不允许把整条计划完全下沉到工具层。
- Planner 直接输出 `speak` 动作，不由执行层事后补写。

### 4.6 Executor / Validator

- Executor 负责把 Planner 步骤映射到 Mineflayer 可执行动作。
- 第一阶段必须打通：
  - `mine`
  - `pick_up`
  - `place`
  - `craft`
  - `move_to`
  - `drop`
  - `speak`
- Validator 负责检查动作结果、库存变化、目标是否达成，以及是否需要进入重规划。

### 4.7 Tracing / Dataset Engine

- 每次用户请求视为一个 Episode。
- 必须完整记录模型输入、模型输出、工具调用、执行结果与重规划信息。
- 该链路不仅用于调试，也直接服务于后续小模型蒸馏。

## 5. 核心数据结构约定

### 5.1 Router 输出

```json
{
  "intents": [
    {
      "type": "task",
      "priority": 1,
      "goal": "获得并交付 raw_iron"
    }
  ]
}
```

### 5.2 Planner Step 输出

Planner 原子动作统一使用以下结构，`reason` 为必填：

```json
{
  "action": "mine",
  "target": "oak_log",
  "reason": "当前背包没有木镐，需要先获取原木以制作木板和木棍"
}
```

第一阶段动作词表固定为：

- `mine`
- `pick_up`
- `place`
- `craft`
- `move_to`
- `drop`
- `speak`

### 5.3 Episode 落盘原则

- 模型输入时喂了什么，就保存什么。
- 模型输出了什么，就保存什么。
- 不额外生成与训练无关的二次加工字段。
- 允许后处理脚本在离线阶段筛选成功样本，但不在运行期改写原始记录。

## 6. 状态机与关键阶段

### 6.1 标准阶段枚举

第一阶段固定使用以下 6 个阶段：

1. `任务开始`
2. `开始准备工具`
3. `开始采集资源`
4. `完成一个里程碑物品`
5. `开始交付`
6. `任务完成/失败`

### 6.2 台词规则

- 每次关键阶段切换时，必须有女仆聊天输出。
- 关键阶段台词由 Planner 直接通过 `speak` 原子动作给出。
- 不允许只在开头回复一次，然后全程沉默执行。

## 7. 执行与重规划策略

### 7.1 执行策略

- Executor 对同类物理动作先做最多 2 次局部重试。
- 局部重试失败后，再将失败现场抛回 Planner 进入 Replan。
- 不依赖大模型处理每一次细碎的物理抖动与寻路波动。

### 7.2 重规划输入

Replan 时提供给 Planner 的上下文固定为：

- 原始目标
- 最近少量成功历史
- 最后失败动作
- 最后失败目标
- 失败原因
- 最新 `world_state`

不将完整 Episode 全量回灌给 Planner，避免上下文污染与重复规划。

### 7.3 交付定义

交付动作在第一阶段按显式多步执行：

`move_to(master_front) -> drop(raw_iron) -> speak(...)`

不引入箱子、容器或复杂交互。

## 8. 模型层约束

### 8.1 LLM Provider 抽象

- 模型选择不得写死在每一个 Agent 文件中。
- 必须抽象统一的 LLM Provider / Config 层。
- 通过配置文件切换当前使用的模型，例如本地模型或 Gemini。

### 8.2 第一阶段模型策略

- 第一阶段允许优先接入更强的模型以验证端到端闭环。
- 模型层抽象必须从一开始就保留，以便后续切换本地小模型或多种 Provider。

## 9. 分阶段推进路线

### P0：统一模型与配置层

- 抽象 Router、Planner、Chat 所使用的模型接口。
- 移除当前各 Agent 文件内写死的模型配置。

### P1：统一 World State 与 Router 升级

- 建立标准化 `world_state`。
- Router 输出主意图的 `type + priority + goal`。

### P2：Domain Tool Layer 落地

- 以 `minecraft-data` 与运行时查询为基础实现查询工具。
- 逐步弱化旧的知识 markdown 装载路径。

### P3：Planner 原子动作化

- 让 Planner 直接输出带 `reason` 的原子动作序列。
- 明确加入 `speak`、`drop` 等动作。

### P4：执行闭环打通

- 打通 `mine / pick_up / place / craft / move_to / drop / speak`。
- 完成 `raw_iron` 交付闭环。

### P5：验证、重规划与数据留痕

- 完成阶段切换校验。
- 完成重试与重规划链路。
- 完成 Episode 全量落盘，为蒸馏做准备。

## 10. 对当前代码的改造方向

当前代码的主要转向要求如下：

- 逐步移除“任务知识主要靠 markdown 文本装载”的路径。
- 将 `Router` 收口为单主意图输出，并把解释性表达留给 Planner 的 `speak` 步骤。
- 将 `Planner` 从旧版任务拆解器升级为“工具查询结果驱动的原子动作规划器”。
- 将执行层的 `craft / pick_up / place / drop` 从占位符改为真实动作。
- 将 `world_state` 提升为统一公共底座。
- 将日志系统从单纯追踪增强为面向蒸馏的数据引擎。

## 11. 统一资源搜索与资源缓存长期边界

### 11.1 资源搜索总体原则

- 世界中的树木、矿石、石头、砂砾等资源，统一纳入同一套资源搜索框架。
- 不再允许按资源种类在 Python 执行层继续新增 `_find_nearest_xxx` 式散装接口。
- 统一链路固定为：

`中文输入 -> target_mappings -> canonical id -> minecraft-data 提供候选块/规则 -> JS/Mineflayer 侧执行空间扫描与聚类 -> Python 消费结构化结果 -> Executor 执行`

### 11.2 单一事实源与词汇层

- `minecraft-data` 与 `mineflayer` 是资源事实真源。
- 中文映射表只负责“中文词汇 -> 标准英文 id”的翻译，不承载配方、掉落、工具等级等事实。
- 若直接使用 `minecraft-data` / `mineflayer` 可以解决问题，默认不增加额外兼容层。

### 11.3 目标分类

统一只允许三类资源/空间目标：

1. `point_target`
例如 `crafting_table`、`furnace`、`chest`、`master_front`。

2. `cluster_target`
例如 `any_log`、`iron_ore`、`coal_ore`、`stone`、`sand`。

3. `structure_target`
多方块结构目标；当前可以先保留占位，但边界必须先定义。

### 11.4 资源缓存与环境快照一体化

- 资源簇扫描结果优先常驻在 JS/Mineflayer 侧内存中。
- `env_snapshot` 只读取资源缓存的稳定摘要，不再自行维护另一套资源扫描主链。
- `env_snapshot` 中禁止保留资源的 `distance`、`nearest`、最近坐标等瞬时几何字段。
- 资源缓存中也不持久保存“最近点”；执行器需要时，应基于当前 bot 位置对目标 cluster 现算最近候选方块。

### 11.5 统一搜索 profile

- `cluster_target` 必须通过统一 profile 扩展，而不是通过资源特例函数扩展。
- profile 只描述搜索策略，不承载配方、掉落、工具等级等事实。
- profile 至少允许配置：
  - 候选块集合来源
  - 连通规则
  - 搜索锚点
  - 搜索半径
  - 选簇策略
  - 簇内排序策略
  - 小簇完整清理阈值

### 11.6 统一性能策略

- 资源粗筛优先使用 Mineflayer 的高效查询能力，例如 `bot.findBlocks(...)`。
- 邻接判断、体素聚类、矿脉/树簇识别、候选块排序默认都放在 JavaScript / Mineflayer 一侧。
- 聚类算法优先使用 JS 侧迭代 BFS 或并查集，并优先采用整数坐标哈希。
- Python 不负责通过三重循环或大量 bridge 调用扫描世界。

### 11.7 刷新与重试策略

- Bot 上线后应立即完成一次附近资源缓存初始化。
- 当 bot 相对最近一次资源扫描锚点的位移超过约定阈值时，应异步触发局部刷新。
- 重试策略必须是“换策略重试”，而不是机械重复同一次查询。
- 对于小型 `cluster_target`，若当前锁定 cluster 的超额不大，应优先整簇采完，避免留下半棵树或半截矿脉。

### 11.8 旧接口淘汰原则

- 当统一资源搜索框架落地后，旧的 `_find_nearest_xxx`、单点资源特判、临时 fallback 主路径应直接删除，不做兼容保留。
- 若确有极小范围 fallback，必须显式声明其非主路径身份，并说明为什么不能直接使用统一框架。

## 12. 文档维护规则

- [00Python项目分层架构图.md](./00Python项目分层架构图.md) 继续作为代码分层基准。
- 本文作为当前阶段的总规划文档，后续优先维护本文，不再新增分散的同主题方案文档。
- 阶段性实施步骤、待办和临时占位细节，可放入同主题的实施文档；但长期保留的系统边界、核心数据流和架构原则，应优先维护在本文。
- 若后续修改 `backend` 下的 Python 分层或模块职责，仍需同步更新架构图文档。
