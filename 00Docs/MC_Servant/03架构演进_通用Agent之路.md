# 架构演进：从 "专有 Runner" 到 "通用 Agent" (Phase 3+)

> **日期**: 2026-01-04
> **状态**: 这里的共识将指导后续的代码重构与新功能开发。

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

**确认**：我们已达成共识，将以此路线作为 Phase 3 及之后的开发总纲。
