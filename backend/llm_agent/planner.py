from schemas import PlannerOutput


def plan_complex_task(_: str) -> PlannerOutput:
    """
    复杂任务拆解节点（骨架占位）。

    输入：高层任务描述
    输出：PlannerOutput（任务序列）
    """
    raise NotImplementedError("TODO: 在思考层接入 LLM Planner")

