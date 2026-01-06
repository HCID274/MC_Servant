# MC_Servant 系统演进路线图 (System Evolution Roadmap)

## 1. 概述 (Executive Summary)

本文档旨在规划 **MC_Servant** 项目的中长期演进路线。不仅结合了对学术界成熟框架 **VillagerAgent** 的调研成果（强调 RAG 和元动作工具库），更融入了对当前系统 **记忆架构缺陷** 的深度分析（解决“双上下文割裂”和“任务经验缺失”问题）。

我们的核心目标是将 MC_Servant 从一个“健忘的执行脚本”升级为一个 **具身智能体（Embodied Agent）**，具备**持久化记忆**、**自我学习能力**以及**丰富的工具库**。

---

## 2. 关键架构修复 (Priority 1: Architecture Fixes)

### 2.1 统一上下文系统 (Unified Memory System)

*   **当前问题 (The Issue)**: 
    *   存在两套割裂的上下文系统：`RuntimeContext`（`states.py` 使用，仅存于内存，重启即失）与 `ContextManager`（`context_manager.py` 使用，有数据库支持但未被接入）。
    *   导致 Bot "记吃不记打"，重启后无法接续之前的对话和状态。
*   **改进计划 (The Plan)**:
    1.  **建立桥梁**: 修改 `states.py`，在消息写入 `RuntimeContext` 的同时，同步（或异步）调用 `ContextManager` 进行持久化。
    2.  **重启恢复**: 在系统启动时，从 `ContextManager` (L1/L2 存储) 加载最近的对话历史到内存中。
    3.  **统一接口**: 逐步废弃临时的内存列表，让所有状态查询都走统一的 Memory API。

---

## 3. 学习引擎与 RAG (Priority 2: The "Learning" Engine)

### 3.1 任务经验库 (Task Experience Database)

*   **当前问题**: 
    *   Bot 成功完成任务后，并未记录“我是怎么做到的”。
    *   每次遇到相同任务（如“挖铁矿”），都要重新进行昂贵的 LLM 推理和试错。
*   **解决方案**: 构建**经验记忆 (Experience Memory)** 系统，这是 RAG (检索增强生成) 的核心数据源。
    1.  **数据模型**: 创建 `TaskExperience` 表。
        *   **Input**: 任务目标 (Goal, e.g., "obtain 3 iron_ingot").
        *   **Output**: 成功的执行轨迹/计划 (Plan Trace, e.g., `[Locate(iron_ore), NavigateTo, Mine, Smelt]`).
        *   **Metadata**: 环境条件、消耗时间、成功率。
    2.  **自动记录**: 修改 `UniversalRunner`，当任务状态标记为 `SUCCESS` 时，自动将 Input/Output 存入经验库。

### 3.2 适应性规划 (Adaptive Planning)

*   **工作流升级**:
    *   **Old**: User Intent -> LLM Planner -> Action.
    *   **New**: User Intent -> **Retriever (Query Experience DB)** -> 
        *   *If Hit (有经验)*: Retrieve Proven Plan -> LLM Context -> Execute.
        *   *If Miss (无经验)*: Search KB/Wiki -> Generate New Plan -> Execute -> **Save to Experience**.
*   **技术选型**:
    *   引入 `langchain` 或轻量级向量库 (如 Chroma/FAISS) 实现语义检索 (参考 VillagerAgent 的 `retriever.py`)。

---

## 4. 能力扩展 (Priority 3: Capability Expansion)

### 4.1 元动作工具库 (Meta-Action Library)

*   **调研启示**: VillagerAgent 提供了大量中层粒度工具（Meta-Actions），如 `layDirtBeam` (铺路), `erectDirtLadder` (搭梯子)，极大地降低了 LLM 的规划难度。
*   **改进动作**:
    1.  **工具化重构**: 将 `actions.py` 中的硬编码宏命令拆解为独立、可复用的 `@tool`。
    2.  **新增核心工具**:
        *   `ScanEnvironment(radius)`: 生成 LLM 友好的自然语言环境报告。
        *   `BridgeOver(target)`: 自动铺设方块跨越障碍。
        *   `BuildStructure(schematic_name)`: 调用蓝图建造功能。
        *   `RetreatSafe()`: 紧急避险回撤。

### 4.2 分层任务规划 (Hierarchical Planning)

*   **演进方向**:
    *   当前的 `DynamicResolver` 混合了规划和执行，逻辑较重。
    *   建议拆分为 **Planner** (负责生成高层步骤，如 "1.收集资源 2.前往地点 3.建造") 和 **Executor** (负责将单步转化为 ReAct 循环)。

---

## 5. 实施阶段 (Implementation Stages)

1.  **Phase 1: 持久化修复 (Persistence) [Done]**
    *   目标：Bot 重启后记得我是谁。
    *   动作：打通 `RuntimeContext` -> `ContextManager` (已实现 MemoryFacade, Session, BackgroundTaskManager)。

2.  **Phase 2: 经验记录器 (Experience Recorder) [Done]**
    *   目标：Bot 开始做笔记，记录成功案例。
    *   动作：实现 `TaskExperience` 模型、`IExperienceRepository` (Postgres+pgvector) 和 `ExperienceRecorder`。

3.  **Phase 3: RAG 集成 (RAG Integration) [In Progress]**
    *   目标：Bot 学会查阅笔记，变聪明。
    *   动作：实现 Retrieval 模块 (已完成存储与索引)，修改 Prompt 引入历史经验。

4.  **Phase 4: 工具库重构 (Tooling Refactor)**
    *   目标：Bot 的手脚更灵活，能做复杂动作。
    *   动作：参考 VillagerAgent 移植/重写工具函数。
