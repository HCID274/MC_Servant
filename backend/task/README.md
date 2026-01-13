# Task System (任务系统)

`backend/task/` 模块实现了 MC_Servant 的核心执行引擎。所有的 Bot 行为（除了基础的条件反射）都由本模块驱动。

## 🌟 核心组件

### 1. UniversalRunner (通用运行时)
位于 `universal_runner.py`。
这是任务执行的唯一入口。它摒弃了旧版针对不同任务编写不同 Runner 的模式，采用统一的 **Tick Loop** 流程处理所有任务。

**工作流 (The Tick Loop):**
1.  **Observe (观察)**: 获取 Bot 的物理状态（位置、背包）和环境数据。
2.  **Act (决策)**: 询问 `StackPlanner` 获取下一个子任务。
3.  **Normalize (规范化)**: 使用 `KBOnlyResolver` 结合知识库补全参数（例如将 "木头" 解析为具体的 Block ID）。
4.  **Execute (执行)**: 调度底层的 `MetaAction`。
5.  **Reflect (反思)**: 验证执行结果，处理失败，触发 `Recovery` 机制。

### 2. TaskIntentAnalyzer (意图分析)
位于 `intent_analyzer.py`。
负责分析用户的自然语言指令，将其转化为结构化的 `Task` 对象。它决定了任务的类型（是纯对话任务 `Chat` 还是复杂动作任务 `Build/Gather`）。

### 3. StackPlanner (栈式规划器)
位于 `stack_planner.py`。
实现了基于栈的任务管理。
-   **分解**: 将高层任务（如 "做个工作台"）分解为子任务（"挖木头", "合成木板", "合成工作台"）。
-   **入栈**: 子任务压入栈顶，优先执行。
-   **出栈**: 完成后弹出。
-   **动态规划**: 支持运行时根据环境变化动态调整计划。

### 4. RunnerFactory (工厂)
位于 `runner_factory.py`。
负责实例化 `UniversalRunner` 并注入所有必要的依赖（Context, Actions, Memory 等）。

### 5. LLM Recovery (故障恢复)
位于 `llm_recovery_planner.py`。
当任务失败时（如寻路卡死、缺少材料），该模块会介入，分析错误日志，并生成恢复策略（如 "回退一步", "重新规划", "放弃任务"）。

## 🗑️ 已移除组件
以下旧版组件已被移除，不再支持：
-   `GatherRunner`
-   `LinearPlanRunner`
-   `ClassicRunnerFactory`

## 🔄 开发指南
新增一种任务类型时，通常不需要修改 Runner，只需：
1.  确保 `TaskIntentAnalyzer` 能正确识别。
2.  确保 `StackPlanner` 有相应的提示词或逻辑来分解该任务。
3.  确保底层有支持该任务的 `MetaAction`。
