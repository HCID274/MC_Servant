# Task 模块文档

`backend/task/` 目录是 Bot 的任务执行中枢，实现了从"自然语言意图"到"具体动作执行"的完整流程。它采用分层架构和神经符号 (Neuro-Symbolic) 方法，结合了 LLM 的灵活性和传统算法的稳定性。

## 目录结构

### 1. 核心架构
-   `executor.py`: **执行器 (TaskExecutor)**。整个任务系统的驱动核心。
    -   管理任务栈 (`StackPlanner`)。
    -   协调 Runner (执行者) 和 Planner (规划者)。
    -   处理任务失败和前置条件解析。
-   `runner_factory.py`: **Runner 工厂**。根据任务类型和 Feature Flags 创建合适的 `ITaskRunner` 实例。
-   `universal_runner.py`: **通用执行者 (UniversalRunner)**。
    -   采用 Tick Loop (Observe-Act-Reflect) 模式。
    -   是大多数复杂任务（如采集、建筑）的默认执行引擎。

### 2. 规划层 (Planning Layer)
-   `llm_planner.py`: **LLM 规划器**。调用 LLM 将模糊目标分解为具体任务序列。
-   `stack_planner.py`: **栈式规划器 (StackPlanner)**。管理任务的父子依赖关系（压栈/出栈），支持中断和恢复。
-   `decomposer.py`: 负责将复杂任务（如 "盖房子"）分解为子任务。
-   `recovery_planner.py`: 故障恢复规划器。当标准流程失败时介入，生成恢复策略。

### 3. 解析层 (Resolver Layer)
-   `intent_analyzer.py`: **意图分析器**。识别用户输入是闲聊还是任务，提取任务目标。
-   `prerequisite_resolver.py`: **符号解析器 (Symbolic)** (Fast Path)。
    -   基于规则解决常见问题（如 "缺木头" -> "砍树"）。
    -   不调用 LLM，速度快且稳定。
-   `dynamic_resolver.py`: **动态解析器 (LLM)** (Slow Path)。
    -   当符号解析失败时，调用 LLM 进行复杂问题的诊断和解决。
-   `kb_resolver.py`: 知识库解析器。查询 `mc_knowledge_base.json` 获取配方和属性。
-   `action_resolver.py`: 动作解析器。将 LLM 输出的 JSON 转换为可执行的 Python 动作对象。

### 4. 经验系统 (RAG)
-   `experience_recorder.py`: 记录任务执行的成败经验。
-   `experience_retriever.py`: 在规划新任务时，检索相似的历史经验注入 Prompt，避免重蹈覆辙。

### 5. 辅助组件
-   `behavior_rules.py`: 定义 Bot 的行为规则（如优先使用已有工具）。
-   `prompts/`: 存储 LLM 的 Prompt 模板。
-   `runners/`: 具体任务的 Runner 实现（如果有特定类型的 Runner）。

## 工作流程

1.  **意图识别**: 用户输入 -> `IntentAnalyzer` -> 任务目标。
2.  **规划/分解**: 任务目标 -> `TaskPlanner` (RAG + LLM) -> 任务栈。
3.  **执行循环**:
    -   `TaskExecutor` 取出栈顶任务。
    -   `RunnerFactory` 创建 `UniversalRunner`。
    -   `UniversalRunner` 启动 Tick Loop:
        -   **Observe**: 获取环境信息。
        -   **Act**: `LLMTaskActor` 决定下一步动作。
        -   **Execute**: 调用 `BotActions` (Mineflayer) 执行。
        -   **Reflect**: 检查结果，决定继续、完成或报错。
4.  **错误处理**:
    -   若执行失败，`TaskExecutor` 尝试 `PrerequisiteResolver` (Symbolic)。
    -   若无法解决，尝试 `LLMRecoveryPlanner`。
    -   生成的新任务压入栈顶，优先执行。

## 设计理念

-   **Neuro-Symbolic (神经符号)**: 结合 LLM 的推理能力（处理未见过的复杂情况）和规则引擎的确定性（处理合成、前置条件等固定逻辑）。
-   **Stack-Based (栈式管理)**: 任务支持无限层级的嵌套分解，天然支持"中断-恢复"模式。
-   **Tick Loop (OODA)**: 模仿人类的"观察-判断-决策-行动"循环，而非一次性生成所有步骤，提高对动态环境的适应性。
