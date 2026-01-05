
import asyncio
import logging
import json
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
from .recovery_interfaces import (
    IRecoveryCoordinator,
    RecoveryLevel,
    RecoveryActionType,
)
from .recovery_planner import (
    RecoveryDecision,
    RecoveryDecisionType,
    RecoveryContext,
)

if TYPE_CHECKING:
    from ..bot.interfaces import IBotActions, ActionResult
    from ..perception.knowledge_base import JsonKnowledgeBase
    from .recovery_planner import IRecoveryPlanner

logger = logging.getLogger(__name__)


class KBOnlyResolver:
    """
    轻量级 Resolver - 仅使用 KB，不需要 bot 实例
    
    用于参数归一化：将 LLM 输出的语义概念映射到具体 Minecraft ID
    不进行实际扫描，只做 KB 查询
    """
    
    def __init__(self, kb: Optional["JsonKnowledgeBase"] = None):
        """
        初始化
        
        Args:
            kb: 知识库实例 (可选，默认使用全局单例)
        """
        if kb is None:
            # 延迟导入以避免循环依赖
            try:
                from ..perception.knowledge_base import get_knowledge_base
                kb = get_knowledge_base()
            except ImportError:
                pass
        self._kb = kb
    
    def resolve_concept(self, concept: str) -> str:
        """
        解析语义概念到标准概念名/候选 ID
        
        Args:
            concept: 语义概念 (如 "tree", "log", "矿")
            
        Returns:
            标准概念名或第一个候选 ID
        """
        if not self._kb:
            return concept
            
        # 1. 尝试解析别名
        resolved = self._kb.resolve_alias(concept)
        
        # 2. 获取候选列表
        candidates = self._kb.get_candidates(resolved)
        
        if candidates:
            # 返回第一个候选 ID
            return candidates[0]
        
        # 3. 如果本身是合法 ID，返回自己
        if self._kb.is_valid_id(resolved):
            return resolved
        
        # 4. 原样返回
        return concept
    
    def get_candidates(self, concept: str) -> List[str]:
        """获取概念对应的全部候选 ID"""
        if not self._kb:
            return []
        resolved = self._kb.resolve_alias(concept)
        return self._kb.get_candidates(resolved)


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
        rules: Optional[BehaviorRules] = None,
        recovery_planner: Optional["IRecoveryPlanner"] = None,
    ):
        """
        初始化 UniversalRunner
        
        Args:
            rules: 行为规则配置
            recovery_planner: LLM 恢复规划器 (可选)
        """
        self._rules = rules or BehaviorRules()
        self._recovery_planner = recovery_planner
        self._resolver = KBOnlyResolver()  # 使用轻量级 KB-only Resolver
    
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

        recovery_snapshot = None
        if isinstance(task.context, dict):
            recovery_snapshot = task.context.pop("recovery_snapshot", None)

        if context.user_reply and recovery_snapshot and self._recovery_planner:
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
        is_tree_intent = self._is_tree_task(task)
        tree_single_goal = is_tree_intent and self._is_single_tree_goal(task.goal or "")
        tree_done = False
        
        # 🔴 修复: 仅当任务是「纯单步」时才启用非LLM完成判据
        # 复合任务 (如 "做点木板给我") 必须依赖 LLM 的 done=true
        is_pure_single_step = self._is_pure_single_step_task(task)
        
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
            bot_state = self._get_bot_state(actions, context, last_scan, last_result, last_find_location)
            
            # 初始化 Inventory Delta (第一个 tick)
            if tick == 1:
                gather_item_id, gather_target_count = self._parse_gather_spec(task)
                if gather_item_id and gather_target_count:
                    inv = bot_state.get("inventory", {})
                    gather_start_count = int(inv.get(gather_item_id, 0) or 0)
            
            # ✅ Q2: Inventory Delta 作为辅助信息注入 (而非直接返回成功)
            if gather_item_id and gather_target_count and gather_start_count is not None:
                inv = bot_state.get("inventory", {})
                current = int(inv.get(gather_item_id, 0) or 0)
                delta = current - gather_start_count
                goal_met = delta >= gather_target_count
                
                # 注入到 bot_state 供 LLM 参考
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
                    logger.error(f"[UniversalRunner] planner.act() failed: {e}")
                    return TaskResult(
                        success=False,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        failed_step=last_result,
                        message=f"决策失败: {str(e)}"
                    )

                # LLM 声明完成
                if done:
                    return TaskResult(
                        success=True,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        message=done_message or "任务完成"
                    )
            
            # 3. Normalize: 参数归一化
            if tree_single_goal and tree_done:
                allow_give_flow = self._is_give_task(task)
                if allow_give_flow:
                    if step.action not in ("goto", "give"):
                        return TaskResult(
                            success=True,
                            task_description=task.goal,
                            completed_steps=completed_steps,
                            message="Single-tree task complete"
                        )
                else:
                    if step.action != "give":
                        return TaskResult(
                            success=True,
                            task_description=task.goal,
                            completed_steps=completed_steps,
                            message="Single-tree task complete"
                        )

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
                    return TaskResult(
                        success=True,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        message="Single-tree task complete"
                    )
                
                # 成功后清空缓存与计数
                cached_action = None
                pending_step = None
                attempt_count = 0
                last_signature = None
                llm_recovery_used = False
                
                # 🔴 修复: 仅对「纯单步」任务启用非LLM完成判据
                # 复合任务必须依赖 LLM done=true，避免提前终止
                if is_pure_single_step and self._is_single_step_task_complete(step, result, task):
                    return TaskResult(
                        success=True,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        message=f"{step.action} 完成"
                    )
                
            else:
                logger.warning(f"[UniversalRunner] Step failed: {result.action} - {result.message}")
                
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
                        task.context["recovery_snapshot"] = {
                            "last_action": cached_action,
                            "last_result": result,
                            "bot_state": bot_state,
                            "completed_steps": completed_steps[-5:],
                            "attempt_count": attempt_count,
                        }
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
    
    def _is_tree_task(self, task: StackTask) -> bool:
        """检测是否是砍树任务"""
        goal = (task.goal or "").lower()
        return ("树" in goal and ("砍" in goal or "伐" in goal)) or \
               ("tree" in goal and ("chop" in goal or "cut" in goal or "mine" in goal))

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

    def _is_give_task(self, task: StackTask) -> bool:
        """检测是否是交付任务"""
        goal = (task.goal or "").lower()
        return "给" in goal or "give" in goal or "交" in goal

    def _is_craft_task(self, task: StackTask) -> bool:
        """检测是否是合成任务"""
        goal = (task.goal or "").lower()
        return "合成" in goal or "做" in goal or "craft" in goal or "make" in goal

    def _is_goto_task(self, task: StackTask) -> bool:
        """检测是否是导航任务"""
        goal = (task.goal or "").lower()
        return "去" in goal or "来" in goal or "过来" in goal or "goto" in goal or "go to" in goal

    def _parse_gather_spec(self, task: StackTask) -> tuple:
        """解析采集规格 (item_id, count)"""
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
            
            if "target" not in params and self._should_anchor_to_owner(task_goal):
                if context.owner_name:
                    params["target"] = f"@{context.owner_name}"
                elif context.owner_position:
                    pos = context.owner_position
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
            if context.owner_position and self._should_anchor_to_owner(task_goal):
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
        if context.owner_position and self._should_anchor_to_owner(task_goal):
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
        
        return False
    
    async def _execute_step(self, actions: "IBotActions", step: ActionStep) -> "ActionResult":
        """执行单个动作步骤"""
        import inspect
        
        try:
            from ..bot.interfaces import ActionResult as _ActionResult, ActionStatus as _ActionStatus
        except ImportError:
            from bot.interfaces import ActionResult as _ActionResult, ActionStatus as _ActionStatus
        
        action_name = step.action
        params = step.params.copy() if step.params else {}
        
        # 处理超时参数
        DEFAULT_TIMEOUTS = {
            "goto": 60.0, "mine": 120.0, "mine_tree": 120.0,
            "craft": 30.0, "place": 10.0, "give": 30.0, "equip": 5.0, "scan": 10.0,
            "chat": 5.0, "look_around": 10.0, "unstuck": 5.0, "pickup": 60.0,
            "find_location": 30.0, "patrol": 90.0,
        }
        if "timeout_sec" in params:
            params["timeout"] = params.pop("timeout_sec")
        elif "timeout" not in params:
            params["timeout"] = DEFAULT_TIMEOUTS.get(action_name, 30.0)
        
        # some actions do not accept timeout
        if action_name in {"scan", "chat", "look_around", "find_location"} and "timeout" in params:
            params.pop("timeout")
        
        # 获取动作方法
        action_method = getattr(actions, action_name, None)
        if action_method is None:
            return _ActionResult(
                success=False,
                action=action_name,
                message=f"未知动作: {action_name}",
                status=_ActionStatus.FAILED,
                error_code="UNKNOWN_ACTION"
            )
        
        # 过滤未知参数
        try:
            sig = inspect.signature(action_method)
            accepted = set(sig.parameters.keys())
            accepted.discard("self")
            has_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
            if not has_var_kw:
                params = {k: v for k, v in params.items() if k in accepted}
        except Exception:
            pass
        
        # 执行
        try:
            result = await action_method(**params)
            return result
        except TypeError as e:
            logger.error(f"Action parameter error: {e}")
            return _ActionResult(
                success=False,
                action=action_name,
                message=f"参数错误: {str(e)}",
                status=_ActionStatus.FAILED,
                error_code="INVALID_PARAMS"
            )
        except Exception as e:
            logger.exception(f"Action execution error: {e}")
            return _ActionResult(
                success=False,
                action=action_name,
                message=str(e),
                status=_ActionStatus.FAILED,
                error_code="EXECUTION_ERROR"
            )
    
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
        # RecoveryContext 已在文件顶部导入
        return RecoveryContext(
            goal=task_goal,
            task_goal=task_goal,
            last_result=result,
            bot_state=bot_state,
            completed_steps=completed_steps,
            cached_action=cached_action,
            attempt=attempt_count,
            max_attempts=max_attempts,
            user_reply=user_reply,
        )

    def _default_clarify_message(self, error_code: str) -> str:
        return f"任务遇到问题 ({error_code})，请指示怎么办喵~"

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

        # Local retry for transient failures (Attempt 2)
        if self._rules.is_transient_error(error_code) and attempt_count < 2:
            logger.info(f"[Recovery] Transient error, retrying same action: {error_code}")
            return {"retry_same": True}

        if llm_recovery_used:
            return {"clarify": True, "message": self._default_clarify_message(error_code)}

        # Hard stop after max attempts
        if attempt_count >= max_attempts:
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

        decision = await self._recovery_planner.recover(recovery_ctx)
        logger.info(
            f"[Recovery] Decision: {decision.decision.value if decision else 'none'} "
            f"(attempt={recovery_ctx.attempt}/{max_attempts})"
        )

        if decision.decision == RecoveryDecisionType.RETRY_SAME:
            if not cached_action:
                return {"clarify": True, "message": self._default_clarify_message(error_code), "llm_used": True}
            return {"retry_same": True, "llm_used": True}

        if decision.decision == RecoveryDecisionType.CLARIFY:
            message = decision.message or self._default_clarify_message(error_code)
            return {"clarify": True, "message": message, "llm_used": True}

        if decision.decision == RecoveryDecisionType.ABORT:
            return {"abort": True, "reason": decision.message or "任务无法继续", "llm_used": True}
        
        if decision.decision == RecoveryDecisionType.NEW_STEP:
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
        recovery_ctx = self._build_recovery_context(
            result=snapshot.get("last_result"),
            bot_state=snapshot.get("bot_state", {}),
            completed_steps=snapshot.get("completed_steps", []),
            cached_action=snapshot.get("last_action"),
            attempt_count=snapshot.get("attempt_count", 99),
            max_attempts=99,
            user_reply=user_reply,
            task_goal=task_goal
        )
        
        decision = await self._recovery_planner.recover(recovery_ctx)
        
        if decision.decision == RecoveryDecisionType.RETRY_SAME:
             if snapshot.get("last_action"):
                 return {"next_step": snapshot["last_action"]}
             return {"clarify": True, "message": "无法重试"}
             
        if decision.decision == RecoveryDecisionType.NEW_STEP:
             return {"next_step": decision.next_step}
             
        if decision.decision == RecoveryDecisionType.ABORT:
             return {"abort": True, "reason": decision.message}
             
        return {"clarify": True, "message": decision.message or "我不理解您的指示"}
