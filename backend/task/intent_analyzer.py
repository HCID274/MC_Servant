# Task Intent Analyzer
# 任务意图分析器
#
# 职责：
# - 基于 StackTask 的 goal 和 params 分析任务意图
# - 判断任务类型（砍树、交付、合成、导航等）
# - 判断是否是纯单步任务
# - 提取采集规格 (item_id, count)
#
# 从 UniversalRunner 中提取，解耦语义判断逻辑。

import logging
from typing import Optional, Dict, Any, Tuple
from .interfaces import StackTask, TaskType

logger = logging.getLogger(__name__)


class TaskIntentAnalyzer:
    """
    任务意图分析器
    """

    @staticmethod
    def is_tree_task(task: StackTask) -> bool:
        """检测是否是砍树任务"""
        goal = (task.goal or "").lower()
        return ("树" in goal and ("砍" in goal or "伐" in goal)) or \
               ("tree" in goal and ("chop" in goal or "cut" in goal or "mine" in goal))

    @staticmethod
    def is_give_task(task: StackTask) -> bool:
        """检测是否是交付任务"""
        goal = (task.goal or "").lower()
        return "给" in goal or "give" in goal or "交" in goal

    @staticmethod
    def is_craft_task(task: StackTask) -> bool:
        """检测是否是合成任务"""
        goal = (task.goal or "").lower()
        return "合成" in goal or "做" in goal or "craft" in goal or "make" in goal

    @staticmethod
    def is_goto_task(task: StackTask) -> bool:
        """检测是否是导航任务"""
        goal = (task.goal or "").lower()
        return "来" in goal or "过来" in goal or "goto" in goal or "go to" in goal

    @staticmethod
    def is_build_task(task: StackTask) -> bool:
        """检测是否是建造/放置任务"""
        goal = (task.goal or "").lower()
        # 检测放置意图
        place_keywords = [
            "放", "摆", "放下", "摆放", "放地上", "放在", "放到",
            "place", "put", "build", "set down", "lay down"
        ]
        return any(kw in goal for kw in place_keywords)

    @staticmethod
    def is_place_task(task: StackTask) -> bool:
        """检测是否是放置方块任务（比 build 更具体）"""
        goal = (task.goal or "").lower()
        from .interfaces import TaskType
        # 任务类型是 BUILD 或者目标包含放置关键词
        if task.task_type == TaskType.BUILD:
            return True
        place_keywords = [
            "放一个", "摆一个", "放个", "摆个", "放地上", "放在地上",
            "place", "put down"
        ]
        return any(kw in goal for kw in place_keywords)

    @staticmethod
    def should_anchor_to_owner(task_goal: str) -> bool:
        """
        判断是否应该锚定到主人位置

        仅当任务明确要求在主人附近时才返回 True
        """
        goal = task_goal.lower()
        anchor_keywords = [
            "我这边", "我附近", "我旁边", "来我这",
            "near me", "closest to me", "around me", "next to me",
            "nearby", "close by", "come here", "over here"
        ]
        return any(kw in goal for kw in anchor_keywords)

    @staticmethod
    def is_pure_single_step_task(task: StackTask) -> bool:
        """
        判断是否是「纯单步」任务

        纯单步任务 = 任务只包含一个动作意图，如:
        - "过来" (仅 goto)
        - "合成木板" (仅 craft，不含 give)
        - "给我木头" (仅 give，假设已有物品)

        复合任务 = 包含多个动作意图，如:
        - "做点木板给我" (craft + give)
        - "砍棵树给我木头" (mine + give)
        - "地上放一个工作台" (可能需要 craft + goto + place)
        
        🔴 重要: build/place 类型任务永远不是纯单步任务！
        因为这类任务必须包含实际的 place 动作，不能仅靠 goto 完成。
        """
        goal = (task.goal or "").lower()
        
        # 🔴 关键: build/place 任务永远不是纯单步任务
        # 避免 goto 成功就提前终止，必须等待 LLM done=true
        from .interfaces import TaskType
        if task.task_type == TaskType.BUILD:
            return False
        
        # 检测放置意图 - 这类任务也不是纯单步
        place_keywords = [
            "放", "摆", "放下", "摆放", "放地上", "放在", "放到",
            "place", "put", "build", "set down"
        ]
        if any(kw in goal for kw in place_keywords):
            return False

        # 检测复合意图关键词
        has_give_intent = "给" in goal or "give" in goal or "交" in goal
        has_craft_intent = "合成" in goal or "做" in goal or "craft" in goal or "make" in goal
        has_gather_intent = "挖" in goal or "砍" in goal or "采" in goal or "mine" in goal or "gather" in goal or "chop" in goal
        has_goto_intent = "来" in goal or "过来" in goal or "goto" in goal or "go to" in goal

        # 统计意图数量
        intent_count = sum([has_give_intent, has_craft_intent, has_gather_intent, has_goto_intent])

        # 仅当只有一个意图时才视为纯单步任务
        return intent_count == 1

    @staticmethod
    def parse_gather_spec(task: StackTask) -> Tuple[Optional[str], Optional[int]]:
        """
        解析采集规格 (item_id, count)

        Returns:
            (item_id, count) 或 (None, None)
        """
        # 从 context 读取
        ctx = task.context or {}
        gather_spec = ctx.get("gather") if isinstance(ctx, dict) else None
        if isinstance(gather_spec, dict):
            gi = gather_spec.get("item_id") or gather_spec.get("block_id")
            gc = gather_spec.get("target_count")
            if isinstance(gi, str) and isinstance(gc, int) and gc > 0:
                return gi, gc

        # 解析 goal: "mine oak_log 3"
        if isinstance(task.goal, str):
            parts = task.goal.strip().split()
            if len(parts) == 3 and parts[0].lower() in ("mine", "gather"):
                try:
                    return parts[1], int(parts[2])
                except ValueError:
                    pass

        return None, None
