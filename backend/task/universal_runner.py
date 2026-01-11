"""
UniversalRunner - Phase 3+ 通用执行器
------------------------------------
Tick 循环工作流程:
1. Observe  - 获取 Bot 最新状态
2. Act      - 调用 Planner 决策下一步
3. Normalize- 参数归一化 + tree → mine_tree
4. Execute  - 调用 BotActions
5. Reflect  - 判定完成 / 恢复 / 继续
"""

import asyncio
import json
import logging
from typing import List, Optional, Dict, Any, TYPE_CHECKING

from .interfaces import (
    StackTask,
    ActionStep,
    TaskResult,
    TaskType,
    RunContext,
    ITaskRunner,
    ITaskPlanner,
    TaskResultStatus
)
from .behavior_rules import BehaviorRules
from .intent_analyzer import TaskIntentAnalyzer
from .kb_resolver import KBOnlyResolver
from .recovery_planner import (
    RecoveryDecision,
    RecoveryDecisionType,
    RecoveryContext,
)
from .recovery_policy import RecoveryPolicy

if TYPE_CHECKING:
    from ..bot.interfaces import IBotActions, ActionResult
    from ..perception.knowledge_base import JsonKnowledgeBase
    from .recovery_planner import IRecoveryPlanner
    from .dynamic_resolver import DynamicResolver
    from .prerequisite_resolver import PrerequisiteResolver
    from .experience_recorder import ExperienceRecorder

logger = logging.getLogger(__name__)


def _safe_debug_text(payload: Any, limit: int = 600) -> str:
    """
    将复杂对象序列化为简短字符串用于日志。
    避免因为不可序列化对象或超长文本导致日志失败。
    """
    try:
        text = json.dumps(payload, ensure_ascii=False, default=str)
    except Exception:
        text = str(payload)
    if len(text) > limit:
        return text[:limit] + "...(truncated)"
    return text


class _FallbackKBResolver:
    """无 KB 场景下的兜底 Resolver，直接透传概念名。"""

    def resolve_concept(self, concept: str) -> str:
        return concept

    def get_candidates(self, concept: str) -> List[str]:
        return [concept]


class UniversalRunner(ITaskRunner):
    """
    通用任务执行器 - Phase 3 MVP
    
    核心设计:
    1. 宏动作分发: 根据 LLM 输出的 action 调用现有 BotActions
    2. 智能转换: tree 意图自动转换为 mine_tree (除非指定了 count > 1)
    3. 完成判据:
       - gather: Inventory Delta (Python 检测)
       - craft: 动作成功即完成
       - give: 动作成功即完成
       - goto: 动作成功即完成
    4. 失败恢复: 瞬态错误本地重试，持久错误交给 LLM
    """
    
    def __init__(
        self,
        resolver: Optional[KBOnlyResolver] = None,
        rules: Optional[BehaviorRules] = None,
        recovery_planner: Optional["IRecoveryPlanner"] = None,
        dynamic_resolver: Optional["DynamicResolver"] = None,
        prerequisite_resolver: Optional["PrerequisiteResolver"] = None,
        experience_recorder: Optional["ExperienceRecorder"] = None,
        recovery_policy: Optional[RecoveryPolicy] = None,
    ):
        """
        初始化 UniversalRunner
        
        Args:
            resolver: KBOnlyResolver，用于概念归一化
            rules: 行为规则配置
            recovery_planner: LLM 恢复规划器 (可选)
            dynamic_resolver: LLM 动态任务解析器 (Slow Path)
            prerequisite_resolver: 符号层前置任务解析器 (Fast Path)
            experience_recorder: 经验记录器 (可选，用于 RAG)
        """
        self._rules = rules or BehaviorRules()
        self._recovery_planner = recovery_planner
        self._dynamic_resolver = dynamic_resolver
        self._prerequisite_resolver = prerequisite_resolver
        self._experience_recorder = experience_recorder
        self._recovery_policy = recovery_policy or RecoveryPolicy()
        self._resolver = resolver or self._create_default_resolver()

    def _create_default_resolver(self) -> Any:
        """
        当外部未注入 Resolver 时，尝试获取全局 KB 构建一个。
        如果无法获取 KB，则退化为简单透传 Resolver。
        """
        kb = None
        try:
            from ..perception.knowledge_base import get_knowledge_base

            kb = get_knowledge_base()
        except Exception as exc:  # pragma: no cover - 仅兜底
            logger.warning("KnowledgeBase not available, fallback resolver in use: %s", exc)

        if kb is not None:
            try:
                return KBOnlyResolver(kb=kb)
            except Exception as exc:  # pragma: no cover
                logger.warning("Failed to init KBOnlyResolver with KB, fallback to noop: %s", exc)

        return _FallbackKBResolver()
    
    @property
    def supported_types(self) -> List[TaskType]:
        """支持的任务类型 - MVP 覆盖全部"""
        return [
            TaskType.GATHER,
            TaskType.CRAFT,
            TaskType.GOTO,
            TaskType.GIVE,
            TaskType.BUILD,
            TaskType.COMBAT,
            TaskType.FOLLOW,
        ]
    
    async def run(
        self,
        task: StackTask,
        actions: "IBotActions",
        planner: ITaskPlanner,
        context: RunContext
    ) -> TaskResult:
        """
        执行任务 (Tick Loop 模式)
        
        Tick Loop:
        1. Observe: 获取 bot 状态
        2. Act: 通过 planner.act() 决策单步动作
        3. Normalize: 参数归一化 + tree → mine_tree 转换
        4. Execute: 调用 BotActions
        5. Reflect: 检查完成判据 / 失败恢复
        """
        completed_steps: List["ActionResult"] = []
        last_result: Optional["ActionResult"] = None
        last_scan: Optional[dict] = None
        last_find_location: Optional[dict] = None  # 语义感知结果
        
        # Inventory Delta 追踪 (用于辅助 LLM 判断)
        gather_item_id: Optional[str] = None
        gather_target_count: Optional[int] = None
        gather_start_count: Optional[int] = None
        
        # Recovery state (per-action signature)
        cached_action: Optional[ActionStep] = None
        pending_step: Optional[ActionStep] = None
        last_signature: Optional[str] = None
        attempt_count: int = 0
        llm_recovery_used: bool = False
        
        # Stuck Monitor (位移检测)
        last_pos: Optional[dict] = None
        stuck_ticks: int = 0
        STUCK_THRESHOLD = 0.1  # 位移阈值
        STUCK_MAX_TICKS = 3    # 容忍的最大原地踏步次数

        recovery_snapshot = None
        # 安全获取上下文，防止 task.context 为 None
        task_context = task.context or {}
        if isinstance(task_context, dict):
            recovery_snapshot = task_context.pop("recovery_snapshot", None)

        if context.user_reply and recovery_snapshot and self._recovery_planner:
            if actions is None:
                return TaskResult(
                    success=False,
                    task_description=task.goal,
                    completed_steps=completed_steps,
                    failed_step=last_result,
                    message="未连接到 Minecraft，无法执行动作"
                )
            recovery_result = await self._recover_from_user_reply(
                task_goal=task.goal or "",
                user_reply=context.user_reply,
                snapshot=recovery_snapshot,
            )
            if recovery_result.get("clarify"):
                message = recovery_result.get("message", "需要澄清")
                if message:
                    await actions.chat(message)
                return TaskResult(
                    success=False,
                    task_description=task.goal,
                    completed_steps=completed_steps,
                    failed_step=last_result,
                    message=message,
                    status=TaskResultStatus.WAITING_FOR_USER,
                )
            if recovery_result.get("abort"):
                return TaskResult(
                    success=False,
                    task_description=task.goal,
                    completed_steps=completed_steps,
                    failed_step=last_result,
                    message=recovery_result.get("reason", "任务终止")
                )
            if recovery_result.get("next_step"):
                pending_step = recovery_result["next_step"]
        
        # 任务类型检测
        # 确保 task.goal 不为 None
        safe_goal = task.goal or ""
        is_tree_intent = TaskIntentAnalyzer.is_tree_task(task)
        tree_single_goal = is_tree_intent and self._is_single_tree_goal(safe_goal)
        tree_done = False
        
        # 🔴 修复: 仅当任务是「纯单步」时才启用非 LLM 完成判据
        # 复合任务 (如 "做点木板给我") 必须依赖 LLM 的 done=true
        is_pure_single_step = TaskIntentAnalyzer.is_pure_single_step_task(task)
        
        max_ticks = context.max_ticks
        start_time = asyncio.get_event_loop().time()
        overall_timeout = context.overall_timeout
        
        for tick in range(1, max_ticks + 1):
            # 超时检查
            if asyncio.get_event_loop().time() - start_time > overall_timeout:
                return TaskResult(
                    success=False,
                    task_description=task.goal,
                    completed_steps=completed_steps,
                    failed_step=last_result,
                    message="任务超时"
                )
            
            # 1. Observe: 获取 Bot 状态
            if actions is None:
                return TaskResult(
                    success=False,
                    task_description=task.goal,
                    completed_steps=completed_steps,
                    failed_step=last_result,
                    message="未连接到 Minecraft，无法执行动作"
                )
            
            bot_state = self._get_bot_state(actions, context, last_scan, last_result, last_find_location)
            
            # 初始化 Inventory Delta (第一个 tick)
            if tick == 1:
                gather_item_id, gather_target_count = TaskIntentAnalyzer.parse_gather_spec(task)
                if gather_item_id and gather_target_count:
                    inv = bot_state.get("inventory", {})
                    gather_start_count = int(inv.get(gather_item_id, 0) or 0)
            
            # Stuck Monitor 逻辑
            current_pos = bot_state.get("position", {})
            if last_pos and current_pos:
                dist = (
                    (current_pos.get("x", 0) - last_pos.get("x", 0))**2 +
                    (current_pos.get("z", 0) - last_pos.get("z", 0))**2
                )**0.5
                if dist < STUCK_THRESHOLD:
                    stuck_ticks += 1
                    logger.warning(f"[StuckMonitor] Bot seems stuck, ticks: {stuck_ticks}/{STUCK_MAX_TICKS}")
                else:
                    stuck_ticks = 0
            last_pos = current_pos

            # 紧急触发脱困：仅依赖位移检测 (不再依赖硬编码高度)
            if self._recovery_policy and self._recovery_policy.should_emergency_recover(
                stuck_ticks, STUCK_MAX_TICKS, cached_action
            ):
                logger.warning(f"[StuckMonitor] Triggering emergency recovery: stuck={stuck_ticks}")
                climb_step = self._recovery_policy.emergency_step(timeout=60.0)
                climb_res = await self._execute_step(actions, climb_step)
                last_result = climb_res
                if climb_res.success:
                    completed_steps.append(climb_res)
                    stuck_ticks = 0  # ??????
                    # ???????????????????
                    bot_state = self._get_bot_state(actions, context, last_scan, last_result, last_find_location)
                else:
                    logger.error(f"[StuckMonitor] Climb to surface failed: {climb_res.message}")

                bot_state["gather_progress"] = {
                    "item": gather_item_id,
                    "collected": delta,
                    "target": gather_target_count,
                    "goal_met": goal_met,
                    "hint": f"Inventory: {gather_item_id} +{delta} " + ("(Goal met!)" if goal_met else f"(Need {gather_target_count - delta} more)")
                }
            
            # 2. Act: 通过 planner.act() 决策
            if pending_step is not None:
                step = pending_step
                pending_step = None
                done = False
                done_message = ""
            else:
                try:
                    step, done, done_message = await planner.act(
                        task_description=task.goal,
                        bot_state=bot_state,
                        completed_steps=completed_steps[-8:],
                    )
                except Exception as e:
                    err_msg = str(e).strip() or e.__class__.__name__
                    logger.exception(
                        "[UniversalRunner] planner.act() failed | context=%s",
                        _safe_debug_text({
                            "task": task.goal,
                            "bot_state_keys": list(bot_state.keys()),
                            "gather_progress": bot_state.get("gather_progress"),
                            "completed_step_actions": [s.action for s in completed_steps[-8:] if hasattr(s, 'action')],
                            "tick": tick,
                        })
                    )
                    return TaskResult(
                        success=False,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        failed_step=last_result,
                        message=f"决策失败: {err_msg}"
                    )

                # planner 返回值校验：避免出现“无异常但 step 为空/结构不合法”导致上层报空白错误
                # 常见于：LLM 返回空 JSON / schema 解析失败被吞 / act 实现返回 (None, False, None)
                if not isinstance(done, bool):
                    logger.error(
                        "[UniversalRunner] planner.act() invalid return: done is not bool | ret=%s",
                        _safe_debug_text({"step": step, "done": done, "done_message": done_message})
                    )
                    return TaskResult(
                        success=False,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        failed_step=last_result,
                        message="决策失败: PLANNER_INVALID_RETURN(done)"
                    )

                if step is None and not done:
                    logger.error(
                        "[UniversalRunner] planner.act() empty step | context=%s ret=%s",
                        _safe_debug_text({"task": task.goal, "tick": tick}),
                        _safe_debug_text({"step": step, "done": done, "done_message": done_message})
                    )
                    return TaskResult(
                        success=False,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        failed_step=last_result,
                        message="决策失败: PLANNER_EMPTY_RESPONSE"
                    )

                if step is not None and (not hasattr(step, "action") or not getattr(step, "action", None)):
                    logger.error(
                        "[UniversalRunner] planner.act() invalid step (missing action) | step=%s",
                        _safe_debug_text(step)
                    )
                    return TaskResult(
                        success=False,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        failed_step=last_result,
                        message="决策失败: PLANNER_INVALID_STEP(action)"
                    )

                # LLM 声明完成
                if done:
                    # 🔴 关键校验: BUILD 类型任务必须有 place 动作才能真正完成
                    # 防止 LLM "出工不出力"，只走了 goto 就说任务完成
                    if task.task_type == TaskType.BUILD or TaskIntentAnalyzer.is_build_task(task):
                        has_place = any(
                            s.action == "place" and s.success 
                            for s in completed_steps
                        )
                        if not has_place:
                            logger.warning(
                                f"[UniversalRunner] BUILD task declared done but no 'place' action found! "
                                f"completed_steps: {[s.action for s in completed_steps]}. "
                                f"Forcing LLM to generate place step."
                            )
                            # 不接受 done=true，让循环继续
                            # LLM 可能在下一轮给出正确的 place 步骤
                            continue
                    
                    # 🆕 记录成功经验到 RAG 库
                    success_result = TaskResult(
                        success=True,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        message=done_message or "任务完成"
                    )
                    await self._record_experience(task, success_result, bot_state, start_time)
                    return success_result
            
            # 3. Normalize: 参数归一化
            if tree_single_goal and tree_done:
                allow_give_flow = TaskIntentAnalyzer.is_give_task(task)
                if allow_give_flow:
                    if step.action not in ("goto", "give"):
                        tree_result = TaskResult(
                            success=True,
                            task_description=task.goal,
                            completed_steps=completed_steps,
                            message="Single-tree task complete"
                        )
                        await self._record_experience(task, tree_result, bot_state, start_time)
                        return tree_result
                else:
                    if step.action != "give":
                        tree_result = TaskResult(
                            success=True,
                            task_description=task.goal,
                            completed_steps=completed_steps,
                            message="Single-tree task complete"
                        )
                        await self._record_experience(task, tree_result, bot_state, start_time)
                        return tree_result

            step = self._normalize_step(step, context, task.goal or "")
            
            # 4. 智能转换: tree → mine_tree (仅当没有指定 count 或 count == 1)
            if is_tree_intent and step.action == "mine":
                count = step.params.get("count", 1)
                if count <= 1:
                    # ✅ Hotfix #2: 复用通用的搜索中心解析逻辑
                    search_center = self._resolve_search_center(step, context, task.goal or "")
                    step = self._convert_to_mine_tree(step, context, search_center)
            
            # 4.5 计算动作签名 (归一化参数后)
            signature = self._compute_action_signature(step)
            if signature != last_signature:
                last_signature = signature
                attempt_count = 0
                llm_recovery_used = False

            # 缓存当前动作供重试
            cached_action = step

            # 记录本次尝试
            attempt_count += 1
            
            # 报告进度
            if context.on_progress:
                try:
                    await context.on_progress(step.description or f"执行: {step.action} (tick {tick}/{max_ticks})")
                except Exception as e:
                    logger.warning(f"Progress callback failed: {e}")
            
            # 5. Execute: 调用 BotActions
            result = await self._execute_step(actions, step)
            last_result = result
            
            # 保存 scan 结果
            if result.action in ("scan", "look_around") and result.success and isinstance(result.data, dict):
                last_scan = result.data
            
            # 保存 find_location 结果 (供 LLM 下一步使用)
            if result.action == "find_location" and result.success and isinstance(result.data, dict):
                last_find_location = result.data
            
            # 6. Reflect: 处理结果
            if result.success:
                completed_steps.append(result)
                
                if tree_single_goal and is_tree_intent and step.action in ("mine_tree", "mine"):
                    tree_done = True
                if tree_single_goal and tree_done and step.action == "give":
                    give_result = TaskResult(
                        success=True,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        message="Single-tree task complete"
                    )
                    await self._record_experience(task, give_result, bot_state, start_time)
                    return give_result
                
                # 成功后清空缓存与计数
                cached_action = None
                pending_step = None
                attempt_count = 0
                last_signature = None
                llm_recovery_used = False
                
                # 🔴 修复: 仅对「纯单步」任务启用非LLM完成判据
                # 复合任务必须依赖 LLM done=true，避免提前终止
                if is_pure_single_step and self._is_single_step_task_complete(step, result, task):
                    single_result = TaskResult(
                        success=True,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        message=f"{step.action} 完成"
                    )
                    await self._record_experience(task, single_result, bot_state, start_time)
                    return single_result
                
            else:
                logger.warning(f"[UniversalRunner] Step failed: {result.action} - {result.message}")
                
                try:
                    recovery_result = await self._handle_failure(
                        result=result,
                        tick=tick,
                        actions=actions,
                        context=context,
                        cached_action=cached_action,
                        bot_state=bot_state,
                        completed_steps=completed_steps,
                        attempt_count=attempt_count,
                        task_goal=task.goal or "",
                        llm_recovery_used=llm_recovery_used,
                    )
                except Exception as e:
                    # Recovery 失败，降级为 clarify
                    logger.error(f"[UniversalRunner] Recovery failed with exception: {e}")
                    recovery_result = {"clarify": True, "message": f"恢复失败: {e}"}

                if recovery_result.get("llm_used"):
                    llm_recovery_used = True

                if recovery_result.get("retry_same"):
                    pending_step = cached_action
                    continue

                if recovery_result.get("next_step"):
                    pending_step = recovery_result["next_step"]
                    continue

                if recovery_result.get("clarify"):
                    message = recovery_result.get("message", "需要澄清")
                    if isinstance(task.context, dict):
                        snapshot = recovery_result.get("recovery_snapshot")
                        if not snapshot:
                            snapshot = self._build_recovery_snapshot(
                                last_action=cached_action,
                                last_result=result,
                                bot_state=bot_state,
                                completed_steps=completed_steps,
                                attempt_count=attempt_count,
                            )
                        task.context["recovery_snapshot"] = snapshot
                    if message:
                        await actions.chat(message)
                    return TaskResult(
                        success=False,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        failed_step=result,
                        message=message,
                        status=TaskResultStatus.WAITING_FOR_USER,
                    )

                # 🔴 新增: 前置条件错误传递给 TaskExecutor 处理
                if recovery_result.get("propagate_to_executor"):
                    # 返回失败结果，让 TaskExecutor._handle_task_failure() 
                    # 有机会调用 PrerequisiteResolver 或处理 dynamic_tasks
                    return TaskResult(
                        success=False,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        failed_step=result,
                        message=recovery_result.get("reason", "前置条件不足"),
                        dynamic_tasks=recovery_result.get("dynamic_tasks"),  # 🆕 传递 LLM 生成的任务
                    )

                if recovery_result.get("abort"):
                    return TaskResult(
                        success=False,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        failed_step=result,
                        message=recovery_result.get("reason", "任务终止")
                    )
        
        return TaskResult(
            success=False,
            task_description=task.goal,
            completed_steps=completed_steps,
            failed_step=last_result,
            message="任务未在步数上限内完成"
        )
    
    # ========================================================================
    # Helper Methods
    # ========================================================================
    
    async def _record_experience(
        self,
        task: StackTask,
        result: TaskResult,
        bot_state: Dict[str, Any],
        start_time: float,
    ) -> None:
        """
        记录任务经验到经验库
        
        在任务成功或部分成功时调用，用于 RAG 检索
        """
        if not self._experience_recorder:
            return
        
        try:
            duration = asyncio.get_event_loop().time() - start_time
            await self._experience_recorder.record(
                task=task,
                result=result,
                bot_state=bot_state,
                duration_sec=duration,
            )
        except Exception as e:
            # 记录失败不应影响主流程
            logger.warning(f"[UniversalRunner] Failed to record experience: {e}")
    
    def _get_bot_state(
        self,
        actions: "IBotActions",
        context: RunContext,
        last_scan: Optional[dict],
        last_result: Optional["ActionResult"],
        last_find_location: Optional[dict] = None
    ) -> dict:
        """获取 Bot 状态，注入上下文"""
        bot_state = actions.get_state()
        
        if context.owner_name:
            bot_state["owner_name"] = context.owner_name
        if context.owner_position:
            bot_state["owner_position"] = context.owner_position
        if last_scan:
            bot_state["last_scan"] = last_scan
        if last_find_location:
            bot_state["last_find_location"] = last_find_location
        if last_result:
            bot_state["last_result"] = {
                "action": last_result.action,
                "success": last_result.success,
                "status": getattr(last_result.status, "value", str(last_result.status)),
                "message": last_result.message,
                "error_code": last_result.error_code,
                "data": last_result.data,
            }
        
        return bot_state

    def _serialize_action_step(self, step: Optional[ActionStep]) -> Optional[Dict[str, Any]]:
        if step is None:
            return None
        if isinstance(step, dict):
            return step
        if hasattr(step, "action"):
            return {
                "action": step.action,
                "params": step.params or {},
                "description": step.description or "",
            }
        return {"raw": str(step)}

    def _deserialize_action_step(self, payload: Any) -> Optional[ActionStep]:
        if payload is None:
            return None
        if isinstance(payload, ActionStep):
            return payload
        if isinstance(payload, dict):
            action = payload.get("action")
            if action:
                return ActionStep(
                    action=action,
                    params=payload.get("params", {}) or {},
                    description=payload.get("description", "") or "",
                )
        return None

    def _serialize_action_result(self, result: Any) -> Optional[Dict[str, Any]]:
        if result is None:
            return None
        if isinstance(result, dict):
            return result
        if hasattr(result, "action"):
            return {
                "action": result.action,
                "success": result.success,
                "status": getattr(result.status, "value", str(result.status)),
                "message": result.message,
                "error_code": result.error_code,
                "data": result.data,
            }
        return {"raw": str(result)}

    def _build_recovery_snapshot(
        self,
        last_action: Optional[ActionStep],
        last_result: Any,
        bot_state: Optional[dict],
        completed_steps: List[Any],
        attempt_count: int,
    ) -> Dict[str, Any]:
        return {
            "last_action": self._serialize_action_step(last_action),
            "last_result": self._serialize_action_result(last_result),
            "bot_state": bot_state if isinstance(bot_state, dict) else {},
            "completed_steps": [
                self._serialize_action_result(step) for step in (completed_steps or [])[-5:]
            ],
            "attempt_count": attempt_count,
        }
    
    def _is_single_tree_goal(self, task_goal: str) -> bool:
        """Heuristic: user wants exactly one tree."""
        goal = (task_goal or "").lower()
        if not goal:
            return False
        single_keywords = [
            "一棵", "这棵", "那棵", "1棵",
            "个树", "颗树", "single tree", "this tree", "that tree", "one tree"
        ]
        if any(kw in goal for kw in single_keywords):
            return True
        multi_keywords = [
            "些树", "片树", "林", "多树",
            "砍光", "清理",
            "2棵", "3棵", "4棵", "5棵", "many trees", "forest"
        ]
        if any(kw in goal for kw in multi_keywords):
            return False
        return False

    def _parse_gather_spec(self, task: StackTask) -> tuple:
        """
        兼容测试的 gather 规格解析入口。
        底层使用 TaskIntentAnalyzer.parse_gather_spec，方便未来替换实现。
        """
        return TaskIntentAnalyzer.parse_gather_spec(task)

    def _compute_action_signature(self, step: ActionStep) -> str:
        """动作签名: action + resolved params (sorted JSON)"""
        params = step.params if isinstance(step.params, dict) else {}
        try:
            params_json = json.dumps(params, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        except Exception:
            params_json = str(params)
        return f"{step.action}:{params_json}"
    
    def _normalize_step(self, step: ActionStep, context: RunContext, task_goal: str = "") -> ActionStep:
        """
        参数归一化: LLM schema → BotActions 签名
        
        处理:
        - scan: target → target_type (接入 KB Resolver)
        - give: player, item → player_name, item_name
        - mine: target → block_type (接入 KB Resolver)
        - craft: item → item_name (接入 KB Resolver)  # 🟡 新增
        """
        params = step.params.copy() if step.params else {}
        action = step.action
        
        if action == "scan":
            # LLM 可能输出 {"target": "log"}
            if "target" in params and "target_type" not in params:
                concept = params.pop("target")
                params["target_type"] = self._resolver.resolve_concept(concept)
        
        elif action == "give":
            # LLM: {"player": "xxx"} → {"player_name": "xxx"}
            if "player" in params and "player_name" not in params:
                params["player_name"] = params.pop("player")
            if "item" in params and "item_name" not in params:
                params["item_name"] = params.pop("item")
        
        elif action == "craft":
            # 🟡 修复: craft 动作也需要 KB 归一化
            # LLM: {"item": "wood"} → {"item_name": "oak_planks"}
            if "item" in params and "item_name" not in params:
                concept = params.pop("item")
                params["item_name"] = self._resolver.resolve_concept(concept)
            elif "item_name" in params:
                # 即使已有 item_name，也尝试解析（以防 LLM 输出概念名）
                params["item_name"] = self._resolver.resolve_concept(params["item_name"])
        
        elif action == "goto":
            if "target" not in params:
                if "target_position" in params:
                    params["target"] = params.pop("target_position")
                elif "position" in params:
                    params["target"] = params.pop("position")
                elif "pos" in params:
                    params["target"] = params.pop("pos")
                elif "player" in params:
                    params["target"] = f"@{params.pop('player')}"
                elif "player_name" in params:
                    params["target"] = f"@{params.pop('player_name')}"
            
            if "target" in params:
                target = params["target"]
                if isinstance(target, dict):
                    if all(k in target for k in ("x", "y", "z")):
                        params["target"] = f"{int(target['x'])},{int(target['y'])},{int(target['z'])}"
                elif isinstance(target, (list, tuple)) and len(target) == 3:
                    try:
                        params["target"] = f"{int(target[0])},{int(target[1])},{int(target[2])}"
                    except Exception:
                        pass
                elif isinstance(target, str):
                    lowered = target.strip().lower()
                    if lowered in {"player", "owner", "me", "self", "@owner"}:
                        if context.owner_name:
                            params["target"] = f"@{context.owner_name}"
                        elif context.owner_position:
                            pos = context.owner_position
                            params["target"] = f"{int(pos['x'])},{int(pos['y'])},{int(pos['z'])}"
            
            if "target" not in params and TaskIntentAnalyzer.should_anchor_to_owner(task_goal):
                if context.owner_name:
                    params["target"] = f"@{context.owner_name}"
                elif context.owner_position:
                    pos = context.owner_position
                    # 确保 pos 不为 None 且包含坐标
                    if pos and all(k in pos for k in ("x", "y", "z")):
                        params["target"] = f"{int(pos['x'])},{int(pos['y'])},{int(pos['z'])}"
        
        elif action == "mine":
            # LLM: {"target": "log"} → {"block_type": "oak_log"}
            if "target" in params and "block_type" not in params:
                concept = params.pop("target")
                params["block_type"] = self._resolver.resolve_concept(concept)
            elif "block" in params and "block_type" not in params:
                params["block_type"] = params.pop("block")
            
            # 🟠 修复: 仅当任务明确要求锚定主人时才注入 owner_position
            # 避免改变非锚定采矿任务的行为
            if context.owner_position and TaskIntentAnalyzer.should_anchor_to_owner(task_goal):
                params.setdefault("near_position", context.owner_position)
                params.setdefault("search_radius", int(self._rules.thresholds.default_search_radius))
        
        elif action == "pickup":
            # LLM: {"target": "apple"} → {"target": "apple"}
            # pickup 动作的 target 参数已经是正确的格式，无需转换
            # 但可以接受 item/item_name 别名
            if "item" in params and "target" not in params:
                params["target"] = params.pop("item")
            elif "item_name" in params and "target" not in params:
                params["target"] = params.pop("item_name")
        
        return ActionStep(action=action, params=params, description=step.description)
    
    def _convert_to_mine_tree(
        self,
        step: ActionStep,
        context: RunContext,
        search_center: Optional[Dict[str, float]] = None
    ) -> ActionStep:
        """
        将 mine log 转换为 mine_tree (宏动作)
        
        ✅ Hotfix #2: 不再强制锚定主人，而是使用传入的 search_center
        """
        params = {}
        
        # 使用传入的搜索中心（可能是主人位置、LLM指定位置或 None）
        if search_center:
            params["near_position"] = search_center
            params["search_radius"] = int(self._rules.thresholds.default_search_radius)
        
        return ActionStep(
            action="mine_tree",
            params=params,
            description="砍掉附近的一棵树"
        )
    
    def _resolve_search_center(
        self,
        step: ActionStep,
        context: RunContext,
        task_goal: str
    ) -> Optional[Dict[str, float]]:
        """
        ✅ Hotfix #2: 通用搜索中心解析逻辑
        
        优先级:
        1. LLM 指定的坐标 (step.params 中的 near_position/target_position)
        2. 明确的锚定意图关键词 -> owner_position
        3. 否则返回 None (由 bot 自己决定)
        """
        params = step.params or {}
        
        # 1. LLM 显式指定的位置
        if "near_position" in params:
            return params["near_position"]
        if "target_position" in params:
            return params["target_position"]
        
        # 2. 任务要求锚定主人
        if context.owner_position and TaskIntentAnalyzer.should_anchor_to_owner(task_goal):
            return context.owner_position
        
        # 3. 否则让 bot 自己决定 (基于当前位置)
        return None
    
    def _is_pure_single_step_task(self, task: StackTask) -> bool:
        """
        🔴 修复: 判断是否是「纯单步」任务
        
        纯单步任务 = 任务只包含一个动作意图，如:
        - "过来" (仅 goto)
        - "合成木板" (仅 craft，不含 give)
        - "给我木头" (仅 give，假设已有物品)
        
        复合任务 = 包含多个动作意图，如:
        - "做点木板给我" (craft + give)
        - "砍棵树给我木头" (mine + give)
        """
        goal = (task.goal or "").lower()
        
        # 检测复合意图关键词
        has_give_intent = "给" in goal or "give" in goal or "交" in goal
        has_craft_intent = "合成" in goal or "做" in goal or "craft" in goal or "make" in goal
        has_gather_intent = "挖" in goal or "砍" in goal or "采" in goal or "mine" in goal or "gather" in goal or "chop" in goal
        has_goto_intent = "来" in goal or "过来" in goal or "goto" in goal or "go to" in goal
        
        # 统计意图数量
        intent_count = sum([has_give_intent, has_craft_intent, has_gather_intent, has_goto_intent])
        
        # 仅当只有一个意图时才视为纯单步任务
        return intent_count == 1
    
    def _should_anchor_to_owner(self, task_goal: str) -> bool:
        """
        🟠 修复: 判断是否应该锚定到主人位置
        
        仅当任务明确要求在主人附近时才返回 True
        """
        goal = task_goal.lower()
        anchor_keywords = [
            "我这边", "我附近", "我旁边", "来我这",
            "near me", "closest to me", "around me", "next to me",
            "nearby", "close by", "come here", "over here"
        ]
        return any(kw in goal for kw in anchor_keywords)
    
    def _is_single_step_task_complete(
        self,
        step: ActionStep,
        result: "ActionResult",
        task: StackTask
    ) -> bool:
        """
        判断纯单步任务是否完成
        
        仅在 _is_pure_single_step_task() 返回 True 时才会调用
        
        🔴 重要: BUILD 类型任务只有 place 成功才算完成
        绝不能因为 goto 成功就提前终止！
        """
        if not result.success:
            return False
        
        # 动作类型匹配即完成
        task_type = task.task_type
        if task_type == TaskType.GIVE and step.action == "give":
            return True
        if task_type == TaskType.CRAFT and step.action == "craft":
            return True
        if task_type == TaskType.GOTO and step.action == "goto":
            return True
        # 🔴 BUILD 类型任务必须执行 place 才算完成
        if task_type == TaskType.BUILD and step.action == "place":
            return True
        
        return False
    
    async def _execute_step(self, actions: "IBotActions", step: ActionStep) -> "ActionResult":
        """
        执行单个动作步骤
        
        使用 MetaActionDispatcher 作为主分发层:
        1. 尝试 MetaAction (navigate, gather_block, smelt_item 等)
        2. Fallback 到 BotActions 原生方法
        """
        try:
            from ..bot.meta_actions import MetaActionDispatcher
        except ImportError:
            from bot.meta_actions import MetaActionDispatcher
        
        action_name = step.action
        params = step.params.copy() if step.params else {}
        
        # 使用 MetaActionDispatcher 统一分发
        dispatcher = MetaActionDispatcher()
        return await dispatcher.dispatch(action_name, params, actions)
    
    # ========================================================================
    # Recovery Methods
    # ========================================================================
    
    def _build_recovery_context(
        self,
        result: "ActionResult",
        bot_state: dict,
        completed_steps: List["ActionResult"],
        cached_action: Optional[ActionStep],
        attempt_count: int,
        max_attempts: int,
        user_reply: Optional[str],
        task_goal: str,
    ) -> Any:
        # 恢复阶段允许的动作列表
        RECOVERY_ALLOWED_ACTIONS = [
            "goto", "mine", "mine_tree", "scan", "craft",
            "equip", "give", "pickup", "find_location", "patrol",
            "place", "climb_to_surface",
        ]

        last_action = self._serialize_action_step(cached_action)
        
        # RecoveryContext 已在文件顶部导入
        return RecoveryContext(
            goal=task_goal,
            task_goal=task_goal,
            last_action=last_action,
            last_result=result,
            bot_state=bot_state,
            completed_steps=completed_steps,
            cached_action=cached_action,
            attempt=attempt_count,
            max_attempts=max_attempts,
            is_final_attempt=attempt_count >= max_attempts,
            user_reply=user_reply,
            allowed_actions=RECOVERY_ALLOWED_ACTIONS,
        )

    def _default_clarify_message(self, error_code: str) -> str:
        return f"任务遇到问题 ({error_code})，请指示怎么办喵~"

    def _estimate_height_gap(
        self,
        cached_action: Optional[ActionStep],
        bot_state: Optional[dict],
        context: RunContext,
    ) -> Optional[int]:
        try:
            current_y = int((bot_state or {}).get("position", {}).get("y"))
        except Exception:
            current_y = None

        target_y = None
        params = cached_action.params if cached_action and hasattr(cached_action, "params") else {}

        for key in ("target_position", "near_position", "position"):
            pos = params.get(key)
            if isinstance(pos, dict) and "y" in pos:
                try:
                    target_y = int(pos.get("y"))
                    break
                except Exception:
                    pass

        if target_y is None and isinstance(params.get("target"), str):
            target = params.get("target", "")
            if "," in target:
                parts = target.replace(" ", "").split(",")
                if len(parts) == 3:
                    try:
                        target_y = int(parts[1])
                    except Exception:
                        pass
            elif target.startswith("@"):
                owner_pos = (bot_state or {}).get("owner_position") or getattr(context, "owner_position", None)
                if isinstance(owner_pos, dict) and "y" in owner_pos:
                    try:
                        target_y = int(owner_pos.get("y"))
                    except Exception:
                        pass

        if target_y is None or current_y is None:
            return None
        return target_y - current_y

    async def _handle_failure(
        self,
        result: "ActionResult",
        tick: int,
        actions: "IBotActions",
        context: RunContext,
        cached_action: Optional[ActionStep] = None,
        bot_state: Optional[dict] = None,
        completed_steps: Optional[List["ActionResult"]] = None,
        attempt_count: int = 0,
        task_goal: str = "",
        llm_recovery_used: bool = False,
    ) -> Dict[str, Any]:
        """
        处理动作失败，使用 LLM Recovery Planner
        """
        error_code = result.error_code or "UNKNOWN"
        max_attempts = self._rules.max_retries_per_action
        inventory = (bot_state or {}).get("inventory", {})

        # ============================================================
        # Phase 0: 紧急脱困 (Symbolic Fast Track)
        # ============================================================
        # 如果寻路/移动失败，无论高度如何，优先尝试垂直脱困
        if error_code != "SUCCESS" and attempt_count >= 1:
            move_errors = ["PATH_BLOCKED", "TARGET_NOT_FOUND", "TIMEOUT", "RECOVERY_FAILED", "EXECUTION_ERROR"]
            height_gap = self._estimate_height_gap(cached_action, bot_state or {}, context)
            step = self._recovery_policy.move_error_step(
                error_code=error_code,
                height_gap=height_gap,
                attempt_count=attempt_count,
            ) if self._recovery_policy else None
            if step:
                logger.info("[Recovery] %s", step.description or "Triggering climb_to_surface")
                return {"next_step": step}
            if error_code in move_errors:
                logger.info(
                    f"[Recovery] Move error without vertical gap (error: {error_code}, gap={height_gap}), "
                    "skipping climb_to_surface"
                )
        # Local retry for transient failures (Attempt 2)
        if self._rules.is_transient_error(error_code) and attempt_count < 2:
            logger.info(f"[Recovery] Transient error, retrying same action: {error_code}")
            return {"retry_same": True}
        
        # ============================================================
        # Phase 1: Fast Path - 符号层处理确定性错误
        # ============================================================
        if error_code in ("NO_TOOL", "INSUFFICIENT_MATERIALS", "STATION_NOT_PLACED"):
            if self._prerequisite_resolver:
                try:
                    prereq_context = {
                        "action": cached_action.action if cached_action else "",
                        "message": result.message,
                        **(result.data if isinstance(result.data, dict) else {})
                    }
                    prereq_task = self._prerequisite_resolver.resolve(
                        error_code=error_code,
                        context=prereq_context,
                        inventory=inventory
                    )
                    if prereq_task:
                        logger.info(f"[Recovery] Fast Path resolved: {prereq_task.goal}")
                        return {
                            "propagate_to_executor": True,
                            "error_code": error_code,
                            "reason": f"需要前置任务: {prereq_task.goal}",
                            "prerequisite_task": prereq_task,
                        }
                except Exception as e:
                    logger.warning(f"[Recovery] PrerequisiteResolver failed: {e}")
            
            # 符号层无法处理，传给 TaskExecutor 处理
            logger.info(f"[Recovery] Fast Path cannot resolve {error_code}, propagating to executor")
            return {
                "propagate_to_executor": True,
                "error_code": error_code,
                "reason": f"前置条件不足 ({error_code})"
            }

        # ============================================================
        # Phase 2: Slow Path - LLM DynamicResolver (模糊错误)
        # ============================================================
        if self._dynamic_resolver and not llm_recovery_used:
            # 排除简单瞬态错误（不值得调 LLM）
            if not self._rules.is_transient_error(error_code) or attempt_count >= 2:
                try:
                    from .dynamic_resolver import StrategyType
                    
                    decision = await self._dynamic_resolver.resolve(
                        error_code=error_code,
                        context={
                            "action": cached_action.action if cached_action else "",
                            "message": result.message,
                            **(result.data if isinstance(result.data, dict) else {})
                        },
                        inventory=inventory,
                        bot_state=bot_state or {},
                        original_goal=task_goal,
                        attempt_count=attempt_count,
                    )
                    
                    if decision:
                        logger.info(f"[Recovery] Slow Path decision: {decision}")
                        
                        if decision.strategy == StrategyType.RETRY:
                            return {"retry_same": True, "llm_used": True}
                        
                        if decision.strategy == StrategyType.INSERT and decision.tasks:
                            return {
                                "propagate_to_executor": True,
                                "error_code": error_code,
                                "reason": decision.reason,
                                "dynamic_tasks": decision.tasks,
                                "llm_used": True,
                            }
                        
                        if decision.strategy == StrategyType.REPLAN and decision.tasks:
                            # REPLAN: 用 INSERT 方式处理（换一种方法）
                            return {
                                "propagate_to_executor": True,
                                "error_code": error_code,
                                "reason": decision.reason,
                                "dynamic_tasks": decision.tasks,
                                "llm_used": True,
                            }
                        
                        if decision.strategy == StrategyType.ESCALATE:
                            return {
                                "clarify": True,
                                "message": decision.reason or self._default_clarify_message(error_code),
                                "llm_used": True
                            }
                        
                        if decision.strategy == StrategyType.DECOMPOSE and decision.tasks:
                            return {
                                "propagate_to_executor": True,
                                "error_code": "TASK_TOO_COMPLEX",
                                "reason": decision.reason,
                                "dynamic_tasks": decision.tasks,
                                "llm_used": True,
                            }
                
                except Exception as e:
                    logger.warning(f"[Recovery] DynamicResolver failed: {e}")
        
        # ============================================================
        # Phase 3: 原有逻辑 - 瞬态重试 + LLM Recovery Planner
        # ============================================================
        
        if llm_recovery_used:
            return {"clarify": True, "message": self._default_clarify_message(error_code)}

        if not self._recovery_planner:
            return {"abort": True, "reason": f"恢复规划器不可用 ({error_code})"}

        recovery_ctx = self._build_recovery_context(
            result=result,
            bot_state=bot_state or {},
            completed_steps=completed_steps or [],
            cached_action=cached_action,
            attempt_count=attempt_count,
            max_attempts=max_attempts,
            user_reply=getattr(context, "user_reply", None),
            task_goal=task_goal,
        )

        try:
            decision = await self._recovery_planner.recover(recovery_ctx)
        except Exception as e:
            logger.error(f"[Recovery] Planner error: {e}")
            # 恢复规划器自身故障时：不要直接崩任务（避免“物理路径受阻→恢复解析崩溃→任务结束”链式灾难）
            # 改为进入澄清模式，等待用户一句话指示，同时保留快照用于后续恢复。
            snapshot = self._build_recovery_snapshot(
                last_action=cached_action,
                last_result=result,
                bot_state=bot_state or {},
                completed_steps=completed_steps or [],
                attempt_count=attempt_count,
            )
            return {
                "clarify": True,
                "message": "我遇到点麻烦（恢复模块故障）。你希望我怎么做：1) 站远一点再给 2) 你走近我来拿 3) 换个地方放下？",
                "llm_used": False,
                "recovery_snapshot": snapshot,
            }
        logger.info(
            f"[Recovery] Decision: {decision.decision.value if decision else 'none'} "
            f"(attempt={recovery_ctx.attempt}/{max_attempts})"
        )

        if decision.decision == RecoveryDecisionType.RETRY_SAME:
            if attempt_count >= max_attempts:
                return {
                    "clarify": True,
                    "message": self._default_clarify_message(error_code),
                    "llm_used": True
                }
            if not cached_action:
                return {"clarify": True, "message": self._default_clarify_message(error_code), "llm_used": True}
            return {"retry_same": True, "llm_used": True}

        if decision.decision == RecoveryDecisionType.CLARIFY:
            message = decision.message or self._default_clarify_message(error_code)
            return {"clarify": True, "message": message, "llm_used": True}

        if decision.decision == RecoveryDecisionType.ABORT:
            return {"abort": True, "reason": decision.message or "任务无法继续", "llm_used": True}
        
        if decision.decision in (RecoveryDecisionType.NEW_STEP, RecoveryDecisionType.ACT):
            step = decision.next_step
            # Normalize new step
            step = self._normalize_step(step, context, task_goal)
            return {"next_step": step, "llm_used": True}
        
        return {"clarify": True, "message": self._default_clarify_message(error_code), "llm_used": True}
    
    async def _recover_from_user_reply(
        self,
        task_goal: str,
        user_reply: str,
        snapshot: dict,
    ) -> Dict[str, Any]:
        """User replied context, ask planner for new step"""
        last_action = self._deserialize_action_step(snapshot.get("last_action"))
        recovery_ctx = self._build_recovery_context(
            result=snapshot.get("last_result"),
            bot_state=snapshot.get("bot_state", {}),
            completed_steps=snapshot.get("completed_steps", []),
            cached_action=last_action,
            attempt_count=snapshot.get("attempt_count", 99),
            max_attempts=99,
            user_reply=user_reply,
            task_goal=task_goal
        )
        
        try:
            decision = await self._recovery_planner.recover(recovery_ctx)
        except Exception as e:
            logger.error(f"[Recovery] Planner error (user_reply): {e}")
            return {"clarify": True, "message": "我还是没能理解/恢复成功。你可以直接告诉我：重试 / 你来接我 / 我把东西放地上？"}
        
        if decision.decision == RecoveryDecisionType.RETRY_SAME:
             if last_action:
                 return {"next_step": last_action}
             return {"clarify": True, "message": "无法重试"}
             
        if decision.decision in (RecoveryDecisionType.NEW_STEP, RecoveryDecisionType.ACT):
             return {"next_step": decision.next_step}
             
        if decision.decision == RecoveryDecisionType.ABORT:
             return {"abort": True, "reason": decision.message}
             
        return {"clarify": True, "message": decision.message or "我不理解您的指示"}
