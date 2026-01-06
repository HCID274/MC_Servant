# Experience Recorder - Task Experience Recording Facade
#
# 经验记录器 - 将成功任务记录到经验库的门面类
#
# 设计原则: 简单的接口，深度的功能
#
# 集成点: UniversalRunner.run() 成功后调用

import asyncio
import logging
from typing import Optional, List, Dict, Any, TYPE_CHECKING

if TYPE_CHECKING:
    from .interfaces import TaskResult, StackTask, ActionStep
    from ..db.experience_repository import IExperienceRepository, EnvironmentFingerprint

logger = logging.getLogger(__name__)


class ExperienceRecorder:
    """
    经验记录器 - 将成功任务记录到经验库
    
    职责:
    1. 判断任务是否值得记录
    2. 提取语义化动作链 (去除坐标)
    3. 提取环境指纹
    4. 计算完成度和效率
    5. 调用 Repository 持久化
    
    集成点:
    - UniversalRunner.run() 成功/部分成功后调用
    """
    
    # 最小有效步骤数 (少于此数的任务不记录)
    MIN_STEPS_TO_RECORD = 1
    
    # 部分成功的最小完成度 (低于此值不记录)
    MIN_PARTIAL_COMPLETION = 0.3
    
    def __init__(self, repository: "IExperienceRepository"):
        """
        初始化记录器
        
        Args:
            repository: 经验仓库实现
        """
        self._repo = repository
        logger.info("[ExperienceRecorder] Initialized")
    
    async def record(
        self,
        task: "StackTask",
        result: "TaskResult",
        bot_state: Dict[str, Any],
        duration_sec: float,
        parent_experience_id: Optional[str] = None,
    ) -> Optional[str]:
        """
        记录任务经验
        
        Args:
            task: 任务定义
            result: 执行结果
            bot_state: 执行结束时的 Bot 状态
            duration_sec: 执行耗时
            parent_experience_id: 父经验 ID (用于分层记录)
        
        Returns:
            experience_id: 成功时返回经验 ID，否则 None
        """
        from ..db.experience_repository import EnvironmentFingerprint
        
        # 1. 判断是否值得记录
        if not self._is_worth_recording(result):
            logger.debug(f"[ExperienceRecorder] Skipping: not worth recording (success={result.success})")
            return None
        
        # 2. 提取语义化动作链
        plan_trace = self._extract_plan_trace(result.completed_steps)
        
        if len(plan_trace) < self.MIN_STEPS_TO_RECORD:
            logger.debug(f"[ExperienceRecorder] Skipping: too few steps ({len(plan_trace)})")
            return None
        
        # 3. 提取环境指纹
        fingerprint = EnvironmentFingerprint.from_bot_state(bot_state)
        
        # 4. 计算结果状态和完成度
        outcome = "success" if result.success else "partial"
        completion_ratio = self._compute_completion_ratio(task, result, bot_state)
        efficiency_score = self._compute_efficiency_score(task, duration_sec)
        
        # 5. 提取前置条件
        preconditions = self._extract_preconditions(task, bot_state)
        
        # 6. 持久化
        try:
            exp_id = await self._repo.save(
                goal_text=task.goal or task.name,
                plan_trace=plan_trace,
                outcome=outcome,
                fingerprint=fingerprint,
                preconditions=preconditions,
                completion_ratio=completion_ratio,
                efficiency_score=efficiency_score,
                duration_sec=duration_sec,
                parent_id=parent_experience_id,
            )
            logger.info(
                f"[ExperienceRecorder] Saved experience: {exp_id[:8]}... "
                f"for goal: '{task.goal or task.name}' (outcome={outcome}, steps={len(plan_trace)})"
            )
            return exp_id
        except Exception as e:
            logger.error(f"[ExperienceRecorder] Failed to save experience: {e}")
            return None
    
    def _is_worth_recording(self, result: "TaskResult") -> bool:
        """
        判断任务是否值得记录
        
        记录条件:
        - 完全成功 (success=True)
        - 部分成功 (有完成的步骤，且不是纯失败)
        """
        if result.success:
            return True
        
        # 部分成功: 有完成的步骤
        if result.completed_steps and len(result.completed_steps) >= self.MIN_STEPS_TO_RECORD:
            # 检查是否有实质性进展
            success_steps = sum(1 for s in result.completed_steps if getattr(s, "success", True))
            return success_steps >= self.MIN_STEPS_TO_RECORD
        
        return False
    
    def _extract_plan_trace(self, completed_steps: List) -> List[Dict[str, Any]]:
        """
        将 ActionResult 列表转换为语义化轨迹
        
        关键: 去除绝对坐标，保留语义信息
        """
        trace = []
        
        for step in completed_steps:
            if not hasattr(step, "action"):
                continue
            
            action = getattr(step, "action", "unknown")
            params = getattr(step, "params", {}) or {}
            success = getattr(step, "success", True)
            
            # 语义化参数 (去除坐标)
            sanitized_params = self._sanitize_params(params)
            
            trace.append({
                "action": action,
                "params": sanitized_params,
                "success": success,
            })
        
        return trace
    
    def _sanitize_params(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        清理参数 - 移除绝对坐标，保留语义信息
        
        Minecraft 经验不能包含绝对坐标，否则换个地方就废了
        """
        import re

        coord_pattern = re.compile(r"^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$")

        # 需要移除的坐标类参数
        coordinate_keys = {
            "x", "y", "z", 
            "position", "target_position", "near_position",
            "from_pos", "to_pos", "start_pos", "end_pos",
        }
        
        sanitized = {}
        for k, v in params.items():
            # 跳过坐标类参数
            if k.lower() in coordinate_keys:
                continue
            
            # 跳过包含坐标的字典
            if isinstance(v, dict) and any(coord in v for coord in ["x", "y", "z"]):
                continue

            # 跳过坐标类列表/元组
            if isinstance(v, (list, tuple)) and len(v) == 3 and all(isinstance(n, (int, float)) for n in v):
                continue

            # 跳过坐标字符串 (e.g., "123,64,-200")
            if isinstance(v, str) and coord_pattern.match(v.strip()):
                continue
            
            # 保留其他参数
            sanitized[k] = v
        
        return sanitized
    
    def _compute_completion_ratio(
        self,
        task: "StackTask",
        result: "TaskResult",
        bot_state: Optional[Dict[str, Any]] = None,
    ) -> float:
        """
        计算完成比例
        
        对于 gather 类任务，基于实际采集数量 / 目标数量
        对于其他任务，基于成功步骤数 / 总步骤数
        """
        if result.success:
            return 1.0
        
        # Prefer progress from bot_state (injected by UniversalRunner), fall back to task context.
        progress = None
        if isinstance(bot_state, dict):
            progress = bot_state.get("gather_progress")
        if progress is None:
            context = task.context or {}
            if isinstance(context, dict):
                progress = context.get("gather_progress")
        if isinstance(progress, dict):
            target = progress.get("target", 1)
            collected = progress.get("collected", 0)
            if isinstance(target, (int, float)) and target > 0:
                return min(1.0, float(collected) / float(target))
        
        # 基于步骤数估算
        completed = len(result.completed_steps) if result.completed_steps else 0
        if completed == 0:
            return 0.0
        
        # 假设平均任务需要 5 步
        return min(1.0, completed / 5.0)
    
    def _compute_efficiency_score(self, task: "StackTask", duration_sec: float) -> float:
        """
        计算效率评分
        
        基于 预期耗时 / 实际耗时
        """
        # 预估不同任务类型的预期耗时
        from .interfaces import TaskType
        
        expected_durations = {
            TaskType.GOTO: 30.0,
            TaskType.GATHER: 120.0,
            TaskType.CRAFT: 15.0,
            TaskType.BUILD: 60.0,
            TaskType.GIVE: 10.0,
        }
        
        task_type = task.task_type
        expected = expected_durations.get(task_type, 60.0)
        
        if duration_sec <= 0:
            return 1.0
        
        # 效率 = 预期 / 实际 (最大1.0)
        return min(1.0, expected / duration_sec)
    
    def _extract_preconditions(
        self, 
        task: "StackTask", 
        bot_state: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        提取前置条件
        
        记录执行任务所需的关键状态
        """
        preconditions = {}
        
        # 1. 工具等级
        inventory = bot_state.get("inventory", {})
        if inventory:
            tool_tier = self._infer_tool_tier(inventory)
            if tool_tier:
                preconditions["tool_tier"] = tool_tier
            
            # 关键物品
            if any("bucket" in item.lower() for item in inventory.keys()):
                preconditions["has_bucket"] = True
            if any("torch" in item.lower() for item in inventory.keys()):
                preconditions["has_torch"] = True
        
        # 2. Y 层级要求 (从任务目标推断)
        goal = (task.goal or "").lower()
        if "iron" in goal or "diamond" in goal or "gold" in goal:
            preconditions["y_level"] = "underground"
        if "netherite" in goal or "ancient_debris" in goal:
            preconditions["y_level"] = "deep_slate"
        
        return preconditions
    
    @staticmethod
    def _infer_tool_tier(inventory: Dict[str, int]) -> Optional[str]:
        """从背包推断最高工具等级"""
        tiers = ["netherite", "diamond", "iron", "stone", "wooden"]
        tool_keywords = ["pickaxe", "axe", "shovel", "sword", "hoe"]
        
        for tier in tiers:
            for item in inventory.keys():
                item_lower = item.lower()
                if tier in item_lower and any(tool in item_lower for tool in tool_keywords):
                    return tier
        return None


# ============================================================================
# Factory Function
# ============================================================================

def create_experience_recorder(
    repository: Optional["IExperienceRepository"] = None,
    db_manager = None,
    embedding_service = None,
) -> Optional[ExperienceRecorder]:
    """
    创建 ExperienceRecorder 实例
    
    Args:
        repository: 直接提供 Repository (优先)
        db_manager: 数据库管理器 (用于创建 PostgresExperienceRepository)
        embedding_service: Embedding 服务
    
    Returns:
        ExperienceRecorder 实例或 None
    """
    if repository:
        return ExperienceRecorder(repository)
    
    if db_manager:
        from ..db.experience_repository import PostgresExperienceRepository
        repo = PostgresExperienceRepository(db_manager, embedding_service)
        return ExperienceRecorder(repo)
    
    logger.warning("[ExperienceRecorder] No repository provided, recorder disabled")
    return None
