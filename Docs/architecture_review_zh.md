# 架构审核报告 (Architecture Review)

本报告基于"简单接口，深度功能"、"依赖抽象，而非具体"的原则，对当前代码库进行审核，并列出发现的矛盾与改进点。

## 1. 文件结构与冗余 (File Structure & Redundancy)

*   **根目录下的临时文件 (矛盾)**:
    *   `tmp_main.py`: 似乎是 `backend/main.py` 的旧版本或实验版本，存在冗余。
    *   `tmp_universal_runner.py`: 与 `backend/task/universal_runner.py` 高度重复，属于未清理的临时代码。
    *   **建议**: 确认无用后直接删除。

## 2. 接口与实现 (Interface & Implementation)

*   **`UniversalRunner` 的语义解析逻辑 (违反单一职责)**:
    *   在 `UniversalRunner` (backend/task/universal_runner.py) 中，存在 `_is_tree_task`, `_is_give_task` 等基于字符串匹配的硬编码逻辑。
    *   **问题**: Runner 应该只负责执行 `planner` 给出的指令，语义理解（如判断这是个砍树任务）应该属于 Planner 或 Resolver 层。
    *   **建议**: 将语义判断逻辑移至 Planner 或专门的 Intent Resolver。

*   **`UniversalRunner` 内部定义 `KBOnlyResolver` (违反关注点分离)**:
    *   `KBOnlyResolver` 类定义在 `universal_runner.py` 文件内部，并且直接依赖 `get_knowledge_base` (Service Locator 模式)。
    *   **问题**: 这使得 `UniversalRunner` 与具体的 KnowledgeBase 实现耦合，且 Resolver 无法复用。
    *   **建议**: 提取 `KBOnlyResolver` 到独立文件，并通过构造函数注入 `IKnowledgeBase` 接口。

*   **`MineflayerAdapter` 的同步阻塞 (实现细节泄漏)**:
    *   `_do_spin`, `_do_jump` 等方法使用了 `time.sleep`。虽然通过 `run_in_executor` 运行，但这种阻塞式实现若未小心处理，可能影响性能。
    *   **建议**: 长期看应考虑完全异步的 Mineflayer 调用，或确保 Executor 线程池足够大。

## 3. 依赖抽象 (Dependency Inversion)

*   **`UniversalRunner` 对 `KBOnlyResolver` 的具体依赖**:
    *   `UniversalRunner.__init__` 直接实例化了 `KBOnlyResolver` (`self._resolver = KBOnlyResolver()`)。
    *   **问题**: 违反了依赖倒置原则。Runner 应该依赖 `IResolver` 接口，而不是具体类。
    *   **建议**: 在 `__init__` 中接受 `resolver: IActionResolver` 参数。

*   **`main.py` 中的依赖注入**:
    *   虽然使用了 `TaskExecutor` 和 `RunnerFactory`，但在初始化 `BotContext` 时，直接传递了 `MineflayerActions` (具体类) 而非接口。
    *   **建议**: 类型提示和依赖注入应尽可能使用 `IBotActions`。

## 4. 遗留代码与矛盾 (Legacy Code & Contradictions)

*   **`TaskExecutor` 中的废弃逻辑**:
    *   `TaskExecutor` 类中保留了 `_execute_task_tick_loop` 和 `_execute_task_linear_fallback` 方法，并标记为 Deprecated。
    *   **矛盾**: 代码库正处于架构迁移期 (Phase 3)，这些遗留代码增加了维护负担，且容易让后续开发者困惑。
    *   **建议**: 如果 `UniversalRunner` 已经稳定，应尽快移除这些 fallback 逻辑，或将其移至专门的 Legacy Adapter 中。

*   **`BotContext` 的复杂性**:
    *   `BotContext` 似乎承担了过多的职责（全息图更新、聊天消息、状态机运行时、执行器引用）。它正在变成一个 God Object。
    *   **建议**: 重新审视 `BotContext` 的设计，将其拆分为更细粒度的上下文对象。

## 5. 改进清单 (Action Items)

1.  [ ] 删除根目录 `tmp_*.py` 文件。
2.  [ ] 将 `KBOnlyResolver` 提取为独立文件，并提取接口。
3.  [ ] 修改 `UniversalRunner` 以注入 `resolver`，而非内部实例化。
4.  [ ] 清理 `TaskExecutor` 中的 `Deprecated` 代码。
5.  [ ] 将 `UniversalRunner` 中的 `_is_tree_task` 等语义判断逻辑移至 Planner 层。
