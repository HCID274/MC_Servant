# UniversalRunner Implementation Log & Status
Date: 2026-01-04

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
