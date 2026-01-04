# 架构演进：从 "专有 Runner" 到 "通用 Agent" (Phase 3+)

> **日期**: 2026-01-04
> **状态**: 合并文档 (架构设计 + 实施记录 + 诊断报告)
> **说明**: 本文档汇总了 Phase 3 的所有核心信息，包含初始诊断、架构设计共识以及 UniversalRunner 的实装记录。

---

# Part 1: 核心共识与架构设计 (Architecture Roadmap)
*(原文档: 03架构演进_通用Agent之路.md)*

## 1. 核心共识：打破 "Runner 陷阱"

我们一致认为，当前的架构陷入了 **"保姆式设计 (The Runner Trap)"**。我们花了太多精力在 Python 侧编写 "如果A则B，否则C" 的硬逻辑（如 `GatherRunner`），这导致：
1.  **扩展性差**：每增加一种新任务（如杀鸡、巡逻），就需要写一个新的 Runner。
2.  **灵活性低**：Bot 在遇到规则之外的情况时（如找不到路）无法灵活应变，因为逻辑被死板的代码锁死了。
3.  **大材小用**：LLM 仅被用于意图识别，而真正的 "决策"（如找不到树怎么办）却是由 Python 写的死逻辑控制的。

## 2. 目标架构：通用 Tick Loop (Universal Tick Loop)

我们要构建一个 **`UniversalRunner`**，取代各个专用的 Runner。

### 核心理念
*   **Python (身体)**：负责 **感知 (Observe)** 和 **执行 (Act)**。处理精确的坐标、微观的动作循环、协议通信。
*   **LLM (大脑)**：负责 **决策 (Think)**。处理模糊的意图、异常情况的应对、策略的切换。

### 架构图解

```mermaid
graph TD
    subgraph "Macro Loop (LLM 决策层)"
        Status[Bot 状态 / 环境感知] --> LLM
        Goal[当前大目标] --> LLM
        LLM -->|输出指令 JSON| Command["Cmd: {action:'mine', target:'log', count:5}"]
    end

    subgraph "Micro Loop (Python 执行层)"
        Command --> Executor[UniversalRunner]
        Executor -->|1. 解析目标| Resolver[Resolver (Symbolic)]
        Executor -->|2. 执行原子动作| Actions[BotActions]
        Actions -->|持续执行中...| Actions
        Actions -->|完成/失败/中断| Feedback[执行结果]
    end

    Feedback --> Status
```

## 3. 关键机制：微观闭环 (Micro-Loops)

为了解决 LLM API 延迟问题（不能每 50ms 问一次），我们引入 **"指令持续性"**。

*   **LLM 的指令不是瞬间的**，而是一个 **"短期目标 (Sub-Goal)"**。
    *   例如：`{"action": "mine", "target": "iron_ore", "limit": 5}`
*   **Python 接管微观操作**：
    *   只要目标存在且未完成，Python 代码就会在 Tick Loop 中持续驱动 Bot（寻路 -> 挖掘 -> 寻路 -> 挖掘）。
    *   **不打扰 LLM**：除非挖够了、彻底因故卡死、或环境发生剧变（如被打），否则不请求新的指令。

## 4. 资产重组 (Asset Migration)

我们现有的代码资产将进行如下转型：

| 现有组件 | 演进方向 | 说明 |
| :--- | :--- | :--- |
| `GatherRunner` | **废弃/拆解** | 其中的 Tick Loop 逻辑泛化为 `UniversalRunner` 的骨架；特定的采矿流程下沉为 `BotActions` 的原子能力。 |
| `Resolver` (符号层) | **核心保留** | 依然负责由 "语义(tree)" 到 "物理(坐标)" 的精准映射。这是 Neuro-Symbolic 的护城河。 |
| `behavior_rules.json` | **降级为建议 (Hints)** | 不再是代码里的强制 `if/else`。转化为 System Prompt，作为 "经验" 喂给 LLM（"建议：如果找不到路，可以尝试垫高"）。 |
| `BotActions` | **工具箱 (Toolbox)** | 保持不变，作为 LLM 的手脚 (`goto`, `mine`, `scan`, `craft`)。 |

## 5. 实施路线图 (Roadmap)

我们不进行 "大爆炸" 式重写，而是分步迭代：

### Step 1: 泛化验证 (Prototype)
*   **动作**：修改现有的 `GatherRunner`，去除里面硬编码的 `mine` 逻辑，尝试通过参数传入 `action` 和 `target`。
*   **验证**：能否用同一套 Runner 逻辑，既能跑 "挖木头"，也能跑 "去某个坐标"，甚至 "攻击某个实体"（复用寻路）。

### Step 2: 引入 LLM 异常处理 (Exception Handling)
*   **动作**：在 Runner 的 `Reflect` 阶段，当发生 `FAIL` 时，不再直接调用写死的 `recovery_strategy`，而是将错误上下文（“我被方块卡住了”）发给 LLM。
*   **验证**：LLM 是否能给出合理的建议（如 "挖开脚下的方块"），即使代码里没写这条规则。

### Step 3: 构建 UniversalRunner (Full Agent)
*   **动作**：新建 `UniversalRunner`，完全由 LLM 的 JSON 指令驱动。实现 "Micro-Loop" 机制，让 Pyhton 负责维持这个指令的执行周期。
*   **最终形态**：用户输入 "去村庄杀只鸡"，LLM 输出一系列指令，Bot 自主完成，无需编写 `CombatRunner`。

---

# Part 2: UniversalRunner 实装与进度 (Implementation Log)
*(原文档: UniversalRunner_Implementation_Log.md)*

## 1. 目标 (Objective)
实现 `UniversalRunner` 的 MVP 版本，作为 Phase 3 通用 Agent 架构的核心组件。
目标是创建一个统一的任务执行器，能够通过 "Micro-Loop" (Observe-Act-Execute-Reflect) 处理各种类型的任务（采集、合成、导航、交付），逐步替代旧的 `GatherRunner` (Tick Loop) 和 `LinearPlanRunner` (Open Loop)。

## 2. 核心设计原则
1.  **Neuro-Symbolic**:
    *   **Neural (LLM)**: 负责决策下一步做什么 (`planner.act`)。
    *   **Symbolic (Python)**: 负责参数归一化、概念解析 (`EntityResolver`)、执行细节 (`BotActions`) 和基础恢复 (`RecoveryCoordinator`)。
2.  **Composition over Inheritance**:
    *   `UniversalRunner` 不继承自旧 Runner，而是组合现有的组件。
3.  **KB-driven**:
    *   利用知识库 (`mc_knowledge_base.json`) 进行语义概念到具体 ID 的映射。

## 3. 实施过程与阻断点 (Blockers & Feedback)

### 第一阶段：初步方案
**计划**: 直接注册新 Runner，新增 knowledge base 字段。
**User 反馈 (不批准)**:
1.  **Knowledge Base**: `mc_knowledge_base.json` 已有 `aliases` 字段，不能简单新增覆盖。且需注意 `wood` vs `log` 的语义区别（wood指去皮木/木头块，logs指原木），不能随意映射。
2.  **Routing Logic**: 仅仅修改 `RunnerRegistry` 不够，`TaskExecutor` 内部有硬编码的路由逻辑（依赖 `_should_use_tick_loop`），需要修改 Executor 使得 Feature Flag 生效时强制走 UniversalRunner。
3.  **Entity Resolution**: 参数归一化（如 `scan` 的 target）需要接入 `EntityResolver`，否则 "tree" 无法解析为方块 ID。

### 第二阶段：修正与深化
**修正**:
1.  **KB-only Resolver**: 由于 `Resolver` 完整初始化需要 `bot` 实例，导致在 `registry.py` 中初始化困难。决定实现一个轻量级的 `KBOnlyResolver`，只做静态 KB 查询，不依赖 bot 实例。
2.  **mine_tree 逻辑**: 明确了 `mine` -> `mine_tree` 的转换逻辑。必须检查 `count`。如果用户要求 "挖3个木头"，不能转化为 "砍一棵树"（mine_tree通常指整棵），否则会导致过度采集。仅当 count=1 或未指定时转换。
3.  **Completion Criteria**: LLM 对于 craft/give/goto 这类确定性任务，容易在 Act 阶段产生幻觉或死循环。需要在 Python 层增加非 LLM 的完成判据（如 give 动作成功即视为任务完成）。
4.  **Prompt 增强**: `ACT_SYSTEM_PROMPT` 需要扩展，明确支持多步闭环任务（如 "做点木板给我" = check -> mine -> craft -> give）。

## 4. 当前状态 (Current Status)

### ✅ 已完成 (Completed)

#### 1. 配置开关 (`backend/config.py`)
- 新增 `use_universal_runner: bool = False` 特性开关。

#### 2. 知识库更新 (`backend/data/mc_knowledge_base.json`)
- 在现有 `aliases` 块中添加了 `"tree": "logs"` 映射。
- *注意*: 避免了创建重复的 key，修正了之前的 lint 错误。

#### 3. UniversalRunner 实现 (`backend/task/universal_runner.py`)
- **KBOnlyResolver**: 实现了不依赖 bot 的轻量解析器。
- **Core Loop**: 实现了 Micro-Loop (Observe -> Act -> Normalize -> Execute -> Reflect)。
- **智能转换**: 实现了 `mine` -> `mine_tree` 的条件转换 (仅当 count <= 1)。
- **完成判据**: 为 Craft/Give/Goto 增加了动作成功即完成的快速判定。
- **恢复机制**: 集成了 `RecoveryCoordinator`，支持 L1/L2 静默恢复，L3 上报阻塞，L4 压栈。

#### 4. 注册表逻辑 (`backend/task/runners/registry.py`)
- 修改 `create_default()`：当 feature flag 开启时，注册 `UniversalRunner` 接管所有任务类型。

#### 5. 执行器路由 (`backend/task/executor.py`)
- 修改 `_execute_task()`：Feature flag 开启时，跳过旧逻辑，强制从 registry 获取 Runner (Default to GATHER/Universal)。

#### 6. Planner Prompt (`backend/task/llm_planner.py`)
- 更新 `ACT_SYSTEM_PROMPT`：
    - 增加了针对 Craft/Give/Goto 的明确决策规则。
    - 增加了多步闭环任务（"做点木板给我"）的分解逻辑说明。
    - 强调了不要编造坐标和必须使用 `owner_name`。

## 5. 已修复问题 (Fixed Issues) - 2026-01-04 16:00

### ✅ 🔴 多步意图提前终止 (Fixed)
**问题**: 非 LLM 完成判据过于宽泛，导致 "做点木板给我" 在 craft 成功后直接返回，跳过 give。

**修复方案**:
1. 新增 `_is_pure_single_step_task()` 方法，通过统计意图数量判断任务是否为「纯单步」
2. 复合任务（意图数 > 1）必须依赖 LLM 的 `done=true` 才能结束
3. 单步任务完成判定改为基于 `task.task_type` 而非关键词

**代码位置**: `universal_runner.py` L161-166, L256-264, L429-458

### ✅ 🟠 强制锚定主人 (Fixed)
**问题**: mine 动作总是注入 `owner_position`，会把远处任务强行拉回主人身边。

**修复方案**:
1. 新增 `_should_anchor_to_owner()` 方法，检测锚定意图关键词
2. 仅当任务包含 "我这边", "我附近", "near me" 等关键词时才锚定

**代码位置**: `universal_runner.py` L417-420, L459-471

### ✅ 🟡 Craft 参数未归一化 (Fixed)
**问题**: `craft` 动作的 `item_name` 没有通过 KB Resolver 解析。

**修复方案**:
1. 在 `_normalize_step()` 中添加 `craft` 动作的处理分支
2. 对 `item` 和 `item_name` 参数都应用 `resolve_concept()`

**代码位置**: `universal_runner.py` L403-412

### ✅ 🟡 RecoveryCoordinator 未注入 (Fixed)
**问题**: `registry.py` 创建 UniversalRunner 时未传入 RecoveryCoordinator。

**修复方案**:
1. 在 `create_default()` 中导入并实例化 `RecoveryCoordinator`
2. 作为构造参数传入 `UniversalRunner`

**代码位置**: `registry.py` L103-107

## 6. 待确认事项 (To Confirm)
1.  ✅ **任务判定**: 已改为结合「意图计数」和 `task.task_type` 进行判断
2.  ✅ **采矿锚定**: 已恢复为仅在明确要求时锚定主人

## 7. 第二轮修复 (2026-01-04 16:30)

### ✅ Hotfix #1: RecoveryCoordinator 初始化缺参 (Critical)
**问题**: `registry.py` 中 `RecoveryCoordinator()` 调用缺少 `rules` 参数。

**修复方案**:
1. 在 `create_default()` 中共享 `rules = BehaviorRules()` 实例
2. 正确传入 `RecoveryCoordinator(rules=rules)`

**代码位置**: `registry.py` L103-108

### ✅ Hotfix #2: 砍树锚定逻辑 (High)
**问题**: `_convert_to_mine_tree` 强行锚定主人坐标。

**修复方案**:
1. 新增 `_resolve_search_center()` 通用搜索中心解析逻辑
2. 修改 `_convert_to_mine_tree(search_center)` 接收搜索中心参数
3. 优先级: LLM 指定坐标 > 锚定意图 > bot 自主决定

**代码位置**: `universal_runner.py` L246-249, L454-467, L490-519

### ✅ Q3: L1 RETRY_SAME 微重试 (Architectural)
**问题**: L1 RETRY_SAME 没有在 Runner 内部真正复执行。

**修复方案**:
1. 引入 `cached_action` 缓存当前动作
2. 当 `recovery_result.retry_same == True` 时，跳过 LLM 调用
3. 直接使用缓存动作重新执行

**代码位置**: `universal_runner.py` L163-167, L215-220, L267-270, L295-301

### ✅ Q2: Inventory Delta 作为辅助信息 (Architectural)
**问题**: Inventory Delta 直接导致任务返回成功，会使复合任务提前终止。

**修复方案**:
1. 不再直接返回 `TaskResult(success=True)`
2. 将进度信息注入 `bot_state["gather_progress"]`
3. 由 LLM 根据进度信息决定是否输出 `done=true`

**代码位置**: `universal_runner.py` L198-212

## 8. 测试覆盖 (2026-01-04 16:40)

新增 `backend/tests/test_universal_runner.py`，包含 10 个测试用例：

| 测试类 | 测试用例 | 验证内容 |
|--------|----------|----------|
| TestGatherWithRetry | test_mine_with_first_failure_then_success | L1 微重试机制 |
| TestAnchoringLogic | test_should_anchor_to_owner_with_keywords | 锚定关键词检测 (正例) |
| TestAnchoringLogic | test_should_not_anchor_without_keywords | 锚定关键词检测 (反例) |
| TestAnchoringLogic | test_resolve_search_center_with_llm_position | LLM 指定坐标优先 |
| TestAnchoringLogic | test_resolve_search_center_with_anchor_intent | 锚定意图使用主人坐标 |
| TestAnchoringLogic | test_resolve_search_center_without_anchor_intent | 无锚定返回 None |
| TestCompositeTaskFlow | test_is_pure_single_step_detects_composite | 复合任务检测 |
| TestCompositeTaskFlow | test_is_pure_single_step_detects_single | 单步任务检测 |
| TestCompositeTaskFlow | test_composite_task_does_not_terminate_early | 复合任务不提前终止 |
| TestInventoryDeltaHint | test_parse_gather_spec | 采集规格解析 |

**运行结果**: ✅ 10 passed

---

# Part 3: 背景回顾与架构诊断 (Appendix: Architectural Diagnosis)
*(原文档: 目前的发现.md)*

## 1. 核心问题诊断：为什么感觉"每加一个任务都要写代码"？

经过对代码库（特别是 `backend/task/executor.py` 和 `backend/task/runners/`）的深度分析，你感觉 bot "不够灵活" 且需要 "手动写代码" 的根本原因在于当前架构采用了 **"策略模式 (Strategy Pattern) + 强规则驱动"** 的设计路线，而非完全通用的 Agent 代理模式。

### 现状分析
*   **过度特化的 Runner 设计**:
    *   目前系统通过 `RunnerRegistry` 将任务分发给特定的 Runner（如 `GatherRunner`）。
    *   `GatherRunner.py` (28KB+) 极其复杂，内部手动编码了大量的**状态流转、异常处理、参照系逻辑、Tick Loop**。
    *   **后果**: 当你想要让 Bot 做一件新事情（比如 "比如去巡逻" 或 "去种田"）时，如果它不符合 `gather` 的模式，你就必须写一个新的 `PatrolRunner` 或 `FarmRunner`，或者被迫修改 `GatherRunner` 来兼容。这就是你感到 "手动写代码" 的直接来源。
*   **线性规划的局限性**:
    *   对于没有特定 Runner 的任务，系统回退到 `LinearPlanRunner`。这是一个 "Plan Once, Execute All" 的模式。
    *   **后果**: 在 Minecraft 这种动态环境中，一次性计划极易失败（如走路被挡住、怪打断）。线性 Runner 缺乏 `GatherRunner` 那种精细的 Tick Loop 反馈机制，导致 Bot 表现得 "很蠢"（撞墙不回头，遇到意外就报错）。

### 与 VillagerAgent 的对比
*   **VillagerAgent 的做法** (推测基于通用 Agent 范式):
    *   通常采用统一的 `ReAct` (Reasoning + Acting) 循环或 DAG 动态调整。
    *   它可能没有为 "挖矿" 写一个单独的 300 行死循环，而是依赖 LLM 每一步都观察环境并选择工具（Function Calling）。
    *   **灵活度**: 高。遇到未见过的任务，LLM 可能会尝试组合现有工具。
    *   **稳定性**: 可能不如你的 `GatherRunner` 稳定（你的方案在特定任务上肯定更强），但通用性更好。

## 2. 架构矛盾与技术债

### 代码中的 "补丁" 痕迹
*   **`executor.py` 中的逻辑分裂**:
    *   `TaskExecutor` 类中保留了大量被标记为 `Deprecated` 的代码（如 `_execute_task_tick_loop`）。
    *   虽然引入了 `RunnerRegistry`，但在 `_execute_task` 方法中仍然保留了对 `task_type == "mine"` 的硬编码判断 (`_should_use_tick_loop`)，这违反了策略模式的 "开闭原则"。
    *   **风险**: 新的 `GatherRunner` 和旧的 `_execute_task_tick_loop` 逻辑并存，维护时容易改了这头忘了那头。

### 神经-符号架构的双刃剑
*   **优势**: `Neuro-Symbolic` (LLM出意图 + Python落地) 确实极大地降低了幻觉。Bot 不会对着空气挖矿，因为它必须通过 `Resolver` 找到实体。
*   **劣势 (僵化来源)**:
    *   所有的 "Symbolic" 部分（规则、阈值、恢复策略）都需要**人去定义**。
    *   你现在的 `behavior_rules.json` 和 Python 代码中的 `if dist > fallback` 逻辑，实际上是**把你的智慧硬编码进去**，而不是让 LLM 学习处理。
    *   当环境出现你规则库之外的情况时，Bot 就没有任何应变能力（因为它被你的规则锁死了），只能报错或挂起。

## 3. 为什么 Bot 看起来"有点蠢"？

1.  **缺乏通用恢复机制**:
    *   目前的恢复策略（L1/L2/L3）主要集中在 `GatherRunner` 里。
    *   如果是 `LinearPlanRunner` 执行的任务（比如 "把东西放到箱子里"），一旦寻路失败或箱子被挡住，它可能就没有那么智能的 "挪一挪再试" 或 "找另一个箱子" 的逻辑，因为它没走那个高智商的 Tick Loop。
2.  **状态机割裂**:
    *   Bot 的状态（Idle, Working）与 Runner 的内部状态（Tick 1...N）有时是割裂的。LLM 无法在 Runner 执行过程中通过自然语言 "插嘴" 或微调，除非 Runner 显式地抛出控制权。

## 4. 改进建议 (不改代码，仅供参考)

如果想让 Bot 更灵活，未来需要打破 "Runner 筒仓"：

1.  **通用 Tick Loop**: 将 `GatherRunner` 中优秀的 `Observe -> Act -> Reflect` 循环抽取出来，作为所有任务的**默认执行模式**，而不仅仅是采集任务。
2.  **LLM 驱动的恢复**: 减少硬编码的 `strategy="random_move"`，在错误发生时，将错误信息喂回给 LLM (Replan)，让 LLM 决定是 "随机走" 还是 "换个目标"。
3.  **原子技能标准化**: 确保 `interface` 中的 `goto`, `mine` 等动作足够原子化且返回值丰富，这样 LLM 才能像搭积木一样组合它们，而不是依赖 Python 脚本把积木粘死。

---
**总结**: 你的代码写得很棒，工程化程度很高（比一般的 Demo 强很多），但目前的痛点来自于**过度的工程封装限制了 LLM 的泛化能力**。你用 Python 代码替 LLM 做了太多决定。
