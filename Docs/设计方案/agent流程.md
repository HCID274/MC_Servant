# MC 女仆 Agent 流程设计（重构版）

## 1. 目标与边界

### 1.1 文档目标
- 统一 LangGraph 主流程、分支流程和异常流程。
- 明确哪些工作由 LLM 做，哪些工作由 Mineflayer/规则代码做。
- 作为 MVP 到可扩展版本的实现基线。

### 1.2 关键边界
- LLM 负责语义理解、任务拆解、对话生成。
- 执行层负责物理世界计算与动作落地。
- 禁止让 LLM 直接输出绝对坐标。

推荐输出形态：

```json
{"action": "move_to", "target": "master", "offset": "front_1_block"}
```

执行层再根据实时 `Yaw/Pitch + position` 计算目标 `XYZ` 并调用 `pathfinder`。

## 2. 架构分层（按职责分类）

### 2.1 L0 快反射层（规则引擎）
- 由 Mineflayer 事件驱动，毫秒级响应。
- 典型事件：`damage`、`path_reset`、窒息、掉落、低血量。
- 作用：触发中断，不做长链路 LLM 思考。

### 2.2 L1 调度层（LangGraph Orchestrator）
- 维护 `task_queue` 与当前执行状态。
- 处理路由、循环执行、异常跳转。
- 中断采用“队头抢占”而不是挂起栈：高优任务直接插入队头，完成后自然回到原任务。

### 2.3 L2 规划层（LLM Planner）
- 负责意图分类、任务拆解、对话/动作语义生成。
- 输出必须为结构化 JSON（Pydantic Schema）。

### 2.4 L3 执行层（Grounder + Executor）
- 把语义动作转为可执行动作。
- 在任务真正执行前做 JIT 感知与坐标具象化。

## 3. 状态与数据结构（按对象分类）

### 3.1 全局状态 `MaidState`

```python
from typing import Annotated, Any, Dict, List, Literal, TypedDict
import operator

class MaidState(TypedDict):
    user_input: str
    intent: Literal["chat", "task", "interrupt"]
    entities: Dict[str, Any]
    # LangGraph reducer: 新增任务时自动拼接而不是覆盖
    task_queue: Annotated[List[Dict[str, Any]], operator.add]
    current_task: Dict[str, Any] | None
    # Chat 路由秒回通道（仅在需要时由 Router 产出）
    quick_reply_text: str | None
    env_snapshot: Dict[str, Any]
    execution_result: Dict[str, Any] | None
    fail_count: int
```

### 3.2 队列策略（Deque 语义）
- 新任务：追加到队尾。
- 复杂任务拆解：将子任务逆序插回队头。
- 中断任务：最高优先级插队到队头。
- 中断结束：弹出已完成中断任务后，队头自动回到原任务（无需 `suspended_queue_stack`）。

中断插队示例：

```python
task_queue.insert(0, {"action": "escape", "target": "safe_zone"})
```

## 4. 主流程（按时序重排）

### 4.1 标准循环
1. `Start`：接收 `user_input` 或系统事件。
2. `Intent Router`：输出 `chat/task/interrupt`。
3. `Enqueue`：将任务入队。
4. `Task Unroller`：若队头任务复杂则拆解。
5. `Context Grounder`：仅对当前任务做环境感知与参数具象化。
6. `Executor`：执行 Mineflayer 动作。
7. `Verifier`：成功则取下一个任务，失败则重试或回到 Planner。
8. `End/Idle`：队列空则待机。

### 4.2 LangGraph 边定义
- `START -> Router`
- `Router(chat + quick_reply_text) -> FastReplyEmitter`（旁路秒回）
- `Router(chat) -> Chat Planner -> Enqueue`
- `Router(task) -> Task Planner -> Enqueue`
- `Enqueue -> Task Unroller -> Grounder -> Executor -> Verifier`
- `Verifier(success + queue_not_empty) -> Task Unroller`
- `Verifier(success + queue_empty) -> END`
- `Verifier(retryable_fail + fail_count < 3) -> Grounder`
- `Verifier(retryable_fail + fail_count >= 3) -> Task Planner 或 Abort`
- `Verifier(plan_fail) -> Task Planner`

## 5. 分支流程（按业务类型分类）

### 5.1 Chat 分支
- 输出短动作序列（move/look/emote/speak）。
- 以沉浸体验为目标，动作链短、可中断。

### 5.2 Task 分支
- 目标导向任务拆解（例如 `get:iron` -> `craft:pickaxe` -> `mine:iron_ore`）。
- 执行时只处理当前队头任务，避免超前规划失效。

## 6. 异常与中断流程（按优先级分类）

### 6.1 触发源
- 受伤、卡路、目标远离、夜晚风险、路径不可达。

### 6.2 中断机制
1. 快反射层产生 `interrupt_event`。
2. 调度层将中断任务（如 `escape`/`combat`）插入 `task_queue` 队头。
3. 执行器立即消费新的队头任务，完成中断处理。
4. 中断任务完成后弹出队头，流程自然回到原任务。

### 6.3 失败处理策略
- `retryable`：同任务局部重试（`fail_count < 3`）。
- `replan`：回 Planner 生成替代方案。
- `abort`：当 `fail_count >= 3` 且重规划仍失败时，通知主人并安全待机。

## 7. 关键工程原则（按实现约束分类）

### 7.1 结构化输出优先
- 使用 `.with_structured_output(PydanticModel)`。
- 禁止自由文本协议 + 正则解析。

### 7.2 增量状态更新
- 节点只更新必要字段（Delta Update）。
- Router 节点只看 `user_input`，不喂无关历史坐标。
- 对 `task_queue` 使用 `Annotated[..., operator.add]`，避免列表被整段覆盖。

### 7.3 JIT 具象化
- 高层计划保持语义，不提前固化坐标。
- 当前任务执行前再读取环境并落地参数。

### 7.4 低成本上下文
- 环境信息先本地摘要，再传 LLM。
- 不直接上传原始 NBT 或大体积方块矩阵。

## 8. 典型流程示例（按场景分类）

### 8.1 指令：`去给我挖点煤`
1. Router -> `intent=task`
2. Task Planner -> 产出 `{"action":"mine","target":"coal_ore"}`
3. 入队后执行 JIT 感知：定位可达煤矿
4. 执行挖掘并验证结果

### 8.2 指令：`快过来让我看看你`
1. Router -> `intent=chat`
2. Router 立刻产出 `quick_reply_text`，旁路秒回给主人
3. Chat Planner -> `move -> look -> sneak -> speak`
4. 顺序执行，任一步可被高优先级中断

## 9. MVP 分阶段落地建议

### 阶段 1（纯文本脑）
- 仅跑 Router + Queue，不连接 Mineflayer。
- 验收：输入 `去给我挖点煤`，得到 `intent=task` 且队列含 `mine coal_ore`。

### 阶段 2（单步执行）
- 接入 `Grounder + Executor`，先支持 `move/look/speak/mine`。

### 阶段 3（中断恢复）
- 接入事件驱动中断、队头抢占与自动回到原任务。

### 阶段 4（扩展能力）
- 增加 crafting、inventory 管理、多目标策略与人设对话增强。


