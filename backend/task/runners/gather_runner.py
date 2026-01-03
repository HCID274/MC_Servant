# GatherRunner - Tick Loop 执行策略
# 用于采集类任务 (非确定性任务)
#
# 从 executor.py 的 _execute_task_tick_loop() 提取
# 升级: 支持 ITaskActor + IActionResolver + RecoveryCoordinator 架构

import asyncio
import logging
import random
from typing import List, Optional, Dict, Any, Tuple, TYPE_CHECKING

from ..interfaces import (
    StackTask,
    ActionStep,
    TaskResult,
    TaskType,
    RunContext,
    ITaskRunner,
    ITaskPlanner,
)
from ..behavior_rules import BehaviorRules
from ..actor_interfaces import ITaskActor, IActionResolver, ActorDecision, GroundedAction
from ..recovery_interfaces import (
    IRecoveryCoordinator,
    RecoveryDecision,
    RecoveryLevel,
    RecoveryActionType,
)

if TYPE_CHECKING:
    from ...bot.interfaces import IBotActions, ActionResult

logger = logging.getLogger(__name__)


class GatherRunner(ITaskRunner):
    """
    采集任务执行器 - Tick Loop 模式
    
    每个 tick：
    1) Observe: bot_state + last_scan + last_result
    2) Act: LLM 只输出 1 个动作（或 done=true）
    3) Execute: 执行动作
    4) Reflect: 检查完成条件 (Inventory Delta)
    
    适用于：采集、战斗、跟随等非确定性任务
    """
    
    def __init__(
        self, 
        rules: Optional[BehaviorRules] = None,
        actor: Optional[ITaskActor] = None,
        resolver: Optional[IActionResolver] = None,
        recovery: Optional[IRecoveryCoordinator] = None
    ):
        """
        初始化 GatherRunner
        
        Args:
            rules: 行为规则配置，控制阈值/关键词/策略
            actor: 任务决策者 (可选，新架构)
            resolver: 动作解析器 (可选，新架构)
            recovery: 恢复协调器 (可选，处理失败恢复)
        """
        self._rules = rules or BehaviorRules()
        self._actor = actor
        self._resolver = resolver
        self._recovery = recovery
        self._use_new_architecture = (actor is not None) and (resolver is not None)
    
    @property
    def supported_types(self) -> List[TaskType]:
        """支持的任务类型"""
        return [TaskType.GATHER, TaskType.COMBAT, TaskType.FOLLOW]
    
    async def run(
        self,
        task: StackTask,
        actions: "IBotActions",
        planner: ITaskPlanner,
        context: RunContext
    ) -> TaskResult:
        """
        执行采集任务 (Tick Loop)
        
        提取自 TaskExecutor._execute_task_tick_loop()
        """
        completed_steps: List["ActionResult"] = []
        last_result: Optional["ActionResult"] = None
        last_scan: Optional[dict] = None
        
        # Inventory Delta 完成判据
        gather_item_id: Optional[str] = None
        gather_target_count: Optional[int] = None
        gather_start_count: Optional[int] = None
        
        # 总体安全上限
        max_ticks = context.max_ticks
        start_time = asyncio.get_event_loop().time()
        overall_timeout = context.overall_timeout
        
        # 检测树木意图和主人锚点意图
        tree_intent = ("树" in task.goal) and (("砍" in task.goal) or ("伐" in task.goal))
        owner_anchor_intent = self._rules.is_owner_anchor_intent(task.goal or "")
        navigated_to_owner = False
        
        for tick in range(1, max_ticks + 1):
            # 检查取消 (通过 context 上的标志或其他机制)
            # 这里简化处理，实际需要从 context 获取取消信号
            
            if asyncio.get_event_loop().time() - start_time > overall_timeout:
                return TaskResult(
                    success=False,
                    task_description=task.goal,
                    completed_steps=completed_steps,
                    failed_step=last_result,
                    message="采集任务超时（Tick Loop）"
                )
            
            # Observe: 获取 Bot 状态
            bot_state = actions.get_state()
            if context.owner_name:
                bot_state["owner_name"] = context.owner_name
                if context.owner_position:
                    bot_state["owner_position"] = context.owner_position
            
            if last_scan is not None:
                bot_state["last_scan"] = last_scan
            if last_result is not None:
                bot_state["last_result"] = {
                    "action": last_result.action,
                    "success": last_result.success,
                    "status": getattr(last_result.status, "value", str(last_result.status)),
                    "message": last_result.message,
                    "error_code": last_result.error_code,
                    "data": last_result.data,
                }
            
            owner_pos = bot_state.get("owner_position")
            has_owner_pos = isinstance(owner_pos, dict) and all(k in owner_pos for k in ("x", "y", "z"))
            
            # 初始化 Inventory Delta（第一个 tick）
            if tick == 1:
                gather_item_id, gather_target_count = self._parse_gather_spec(task)
                if gather_item_id and gather_target_count:
                    inv = bot_state.get("inventory") if isinstance(bot_state, dict) else None
                    if isinstance(inv, dict):
                        gather_start_count = int(inv.get(gather_item_id, 0) or 0)
            
            # 每 tick 检查 Inventory Delta 完成判据
            if gather_item_id and gather_target_count and gather_start_count is not None:
                inv = bot_state.get("inventory") if isinstance(bot_state, dict) else None
                if isinstance(inv, dict):
                    current = int(inv.get(gather_item_id, 0) or 0)
                    if current >= gather_start_count + gather_target_count:
                        return TaskResult(
                            success=True,
                            task_description=task.goal,
                            completed_steps=completed_steps,
                            message=f"采集完成：{gather_item_id} 增量达到 {gather_target_count}（{gather_start_count} -> {current}）",
                        )
            
            # 决策：选择下一步动作
            step, done, done_message = await self._decide_next_step(
                task=task,
                bot_state=bot_state,
                planner=planner,
                completed_steps=completed_steps,
                tree_intent=tree_intent,
                owner_anchor_intent=owner_anchor_intent,
                navigated_to_owner=navigated_to_owner,
                has_owner_pos=has_owner_pos,
                owner_pos=owner_pos,
                last_scan=last_scan,
                tick=tick,
            )
            
            if done:
                return TaskResult(
                    success=True,
                    task_description=task.goal,
                    completed_steps=completed_steps,
                    message=done_message or "任务完成"
                )
            
            # 对采集类动作注入 owner_position 作为搜索原点
            if owner_anchor_intent and has_owner_pos:
                self._inject_owner_position(step, owner_pos)
            
            # 报告进度
            if context.on_progress:
                try:
                    await context.on_progress(step.description or f"执行: {step.action} (tick {tick}/{max_ticks})")
                except Exception as e:
                    logger.warning(f"Progress callback failed: {e}")
            
            # Execute: 执行动作
            result = await self._execute_step(actions, step)
            last_result = result
            
            # 检查是否到达主人身边
            if step.action == "goto" and result.success and owner_anchor_intent and has_owner_pos:
                navigated_to_owner = True
            
            # 保存 scan 结果供下一 tick 使用
            if result.action == "scan" and result.success and isinstance(result.data, dict):
                last_scan = result.data
            
            # 收集历史 + 恢复处理
            if result.success:
                completed_steps.append(result)
                # 成功时重置 recovery 计数器
                if self._recovery:
                    self._recovery.reset()
            else:
                logger.warning(f"[TickLoop] Step failed: {result.action} - {result.message}")
                
                # 使用 RecoveryCoordinator 处理失败
                if self._recovery:
                    recovery_result = await self._handle_failure(
                        result=result,
                        tick=tick,
                        actions=actions,
                        context=context
                    )
                    
                    # L3: 报告并阻塞 -> 返回失败
                    if recovery_result.get("blocked"):
                        return TaskResult(
                            success=False,
                            task_description=task.goal,
                            completed_steps=completed_steps,
                            failed_step=result,
                            message=recovery_result.get("reason", "任务被阻塞")
                        )
                    
                    # L4: 压栈执行 -> 返回特殊状态让上层处理
                    if recovery_result.get("push_stack"):
                        # 这里返回需要上层 (TaskExecutor) 压栈的信号
                        return TaskResult(
                            success=False,
                            task_description=task.goal,
                            completed_steps=completed_steps,
                            failed_step=result,
                            message=f"PUSH_STACK:{recovery_result.get('stack_task_goal', 'goto_owner')}"
                        )
        
        return TaskResult(
            success=False,
            task_description=task.goal,
            completed_steps=completed_steps,
            failed_step=last_result,
            message="采集任务未在步数上限内完成（Tick Loop）"
        )
    
    def _parse_gather_spec(self, task: StackTask) -> tuple:
        """解析采集规格（物品ID和数量）"""
        gather_item_id = None
        gather_target_count = None
        
        # 优先从 task.context 读取
        ctx = task.context or {}
        gather_spec = ctx.get("gather") if isinstance(ctx, dict) else None
        if isinstance(gather_spec, dict):
            gi = gather_spec.get("item_id") or gather_spec.get("block_id")
            gc = gather_spec.get("target_count")
            if isinstance(gi, str) and isinstance(gc, int) and gc > 0:
                return gi, gc
        
        # 兼容旧 goal 形式：`mine <item_id> <count>` 或 `gather <item_id> <count>`
        if isinstance(task.goal, str):
            parts = task.goal.strip().split()
            if len(parts) == 3 and parts[0].lower() in ("mine", "gather"):
                maybe_id = parts[1]
                try:
                    maybe_count = int(parts[2])
                except Exception:
                    maybe_count = None
                if isinstance(maybe_id, str) and isinstance(maybe_count, int) and maybe_count > 0:
                    return maybe_id, maybe_count
        
        return None, None
    
    async def _decide_next_step(
        self,
        task: StackTask,
        bot_state: dict,
        planner: ITaskPlanner,
        completed_steps: list,
        tree_intent: bool,
        owner_anchor_intent: bool,
        navigated_to_owner: bool,
        has_owner_pos: bool,
        owner_pos: Optional[dict],
        last_scan: Optional[dict],
        tick: int,
    ) -> tuple:
        """
        决策下一步动作
        
        返回: (ActionStep, done: bool, done_message: str)
        """
        # 符号层强约束：用户说"我这边/我附近"时，先到主人身边再采集
        if owner_anchor_intent and has_owner_pos and not navigated_to_owner:
            bot_pos = (bot_state or {}).get("position") or {}
            try:
                dx = float(bot_pos.get("x", 0)) - float(owner_pos["x"])
                dy = float(bot_pos.get("y", 0)) - float(owner_pos["y"])
                dz = float(bot_pos.get("z", 0)) - float(owner_pos["z"])
                dist2 = dx * dx + dy * dy + dz * dz
            except Exception:
                dist2 = 999999.0
            
            reached = float(self._rules.thresholds.goto_owner_reached_distance)
            if dist2 <= reached * reached:
                # 已到达，不需要 goto
                pass
            else:
                step = ActionStep(
                    action="goto",
                    params={"target": f'{int(owner_pos["x"])},{int(owner_pos["y"])},{int(owner_pos["z"])}'},
                    description="先走到主人身边（以主人的坐标为参照系）",
                )
                return step, False, ""
        
        # Fast Path：砍树类任务优先 mine_tree
        if tree_intent and (tick == 1 or owner_anchor_intent):
            sr = int(self._rules.thresholds.default_search_radius)
            if has_owner_pos:
                step = ActionStep(
                    action="mine_tree",
                    params={"near_position": owner_pos, "search_radius": sr},
                    description="砍掉主人附近的一棵树",
                )
            else:
                step = ActionStep(
                    action="mine_tree",
                    params={"search_radius": sr},
                    description="砍掉附近的一棵树",
                )
            return step, False, ""
        
        # 混合参照系策略：扫描为空且离主人太远时，隐式回主人
        if (not owner_anchor_intent) and has_owner_pos and last_scan is not None:
            try:
                targets = last_scan.get("targets") if isinstance(last_scan, dict) else None
                scan_empty = (not targets) or (isinstance(targets, list) and len(targets) == 0)
            except Exception:
                scan_empty = False
            
            if scan_empty:
                bot_pos = (bot_state or {}).get("position") or {}
                try:
                    dx = float(bot_pos.get("x", 0)) - float(owner_pos["x"])
                    dy = float(bot_pos.get("y", 0)) - float(owner_pos["y"])
                    dz = float(bot_pos.get("z", 0)) - float(owner_pos["z"])
                    dist2 = dx * dx + dy * dy + dz * dz
                except Exception:
                    dist2 = 0.0
                
                fallback = float(self._rules.thresholds.owner_fallback_distance)
                if dist2 > (fallback * fallback):
                    step = ActionStep(
                        action="goto",
                        params={"target": f'{int(owner_pos["x"])},{int(owner_pos["y"])},{int(owner_pos["z"])}'},
                        description="扫描不到目标且离主人太远：先向主人区域移动",
                    )
                    return step, False, ""
        
        # 新架构: 使用 Actor + Resolver
        if self._use_new_architecture:
            try:
                return await self._decide_with_actor(
                    task=task,
                    bot_state=bot_state,
                    last_result=completed_steps[-1] if completed_steps else None,
                    context=RunContext(
                        owner_name=bot_state.get("owner_name"),
                        owner_position=owner_pos,
                        max_ticks=self._rules.thresholds.default_max_ticks,
                    )
                )
            except Exception as e:
                logger.error(f"Actor decision failed, falling back to planner: {e}")
        
        # Fallback: 调用旧的 LLM Planner
        try:
            step, done, done_message = await planner.act(
                task_description=task.goal,
                bot_state=bot_state,
                completed_steps=completed_steps[-8:],  # 只给最近几步，控 token
            )
            return step, done, done_message
        except Exception as e:
            logger.error(f"Tick Loop act() failed: {e}")
            # 返回一个空操作，让循环继续
            return ActionStep(action="scan", params={"target_type": "block", "radius": 32}, description="扫描周围"), False, ""
    
    def _inject_owner_position(self, step: ActionStep, owner_pos: dict) -> None:
        """为采集动作注入主人位置作为搜索原点"""
        if step.action in ("mine", "mine_tree"):
            step.params = step.params or {}
            step.params.setdefault("near_position", owner_pos)
            step.params.setdefault("search_radius", int(self._rules.thresholds.default_search_radius))
    
    async def _execute_step(self, actions: "IBotActions", step: ActionStep) -> "ActionResult":
        """执行单个动作步骤"""
        import inspect
        
        # 动态导入以避免循环依赖
        try:
            from ...bot.interfaces import ActionResult as _ActionResult, ActionStatus as _ActionStatus
        except ImportError:
            from bot.interfaces import ActionResult as _ActionResult, ActionStatus as _ActionStatus
        
        action_name = step.action
        params = step.params.copy() if step.params else {}
        
        # 参数归一化
        if action_name == "mine":
            if "block_type" not in params and "block" in params:
                params["block_type"] = params.pop("block")
            if "block_type" not in params and "target" in params and isinstance(params["target"], str):
                params["block_type"] = params.pop("target")
        
        # 处理超时参数
        DEFAULT_TIMEOUTS = {
            "goto": 60.0, "mine": 120.0, "mine_tree": 120.0,
            "craft": 30.0, "place": 10.0, "give": 30.0, "equip": 5.0, "scan": 10.0,
        }
        if "timeout_sec" in params:
            params["timeout"] = params.pop("timeout_sec")
        elif "timeout" not in params:
            params["timeout"] = DEFAULT_TIMEOUTS.get(action_name, 30.0)
        
        # scan 不接受 timeout
        if action_name == "scan" and "timeout" in params:
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
            if "self" in accepted:
                accepted.remove("self")
            has_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
            if not has_var_kw:
                params = {k: v for k, v in params.items() if k in accepted}
        except Exception:
            pass
        
        # 执行动作
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
    
    async def _decide_with_actor(
        self,
        task: StackTask,
        bot_state: dict,
        last_result: Optional["ActionResult"],
        context: RunContext
    ) -> tuple:
        """
        使用新 Actor 架构进行决策
        
        Args:
            task: 当前任务
            bot_state: Bot 状态
            last_result: 上一步结果
            context: 执行上下文
        
        Returns:
            (ActionStep, done: bool, done_message: str)
        """
        # 将 last_result 转换为 dict 格式
        last_result_dict = None
        if last_result is not None:
            last_result_dict = {
                "action": last_result.action,
                "success": last_result.success,
                "status": getattr(last_result.status, "value", str(last_result.status)),
                "message": last_result.message,
                "error_code": last_result.error_code,
                "data": last_result.data,
            }
        
        # 1. Actor 决策
        decision: ActorDecision = await self._actor.decide(
            task_goal=task.goal,
            bot_state=bot_state,
            last_result=last_result_dict
        )
        
        logger.debug(f"Actor decision: {decision}")
        
        # 2. 处理特殊动作
        if decision.is_done:
            return ActionStep(
                action="done",
                params=decision.params,
                description=decision.params.get("message", "任务完成")
            ), True, decision.params.get("message", "任务完成")
        
        if decision.is_clarify:
            # 骨架实现: 发送聊天消息，返回失败
            # 完整实现需要与状态机集成，此处先返回特殊 ActionStep
            logger.info(f"Actor requests clarification: {decision.clarify_question}")
            return ActionStep(
                action="clarify",
                params={
                    "question": decision.clarify_question,
                    "choices": decision.clarify_choices,
                },
                description=f"需要澄清: {decision.clarify_question}"
            ), False, ""
        
        # 3. Resolver 落地
        grounded: GroundedAction = await self._resolver.resolve(decision, context)
        
        logger.debug(f"Grounded action: {grounded}")
        
        # 4. 转换为 ActionStep
        step = ActionStep(
            action=grounded.action,
            params=grounded.params,
            description=grounded.description
        )
        
        return step, False, ""

    # ========================================================================
    # Recovery Methods
    # ========================================================================

    async def _handle_failure(
        self,
        result: "ActionResult",
        tick: int,
        actions: "IBotActions",
        context: RunContext
    ) -> Dict[str, Any]:
        """
        处理动作失败，使用 RecoveryCoordinator 决策
        
        Returns:
            dict with keys:
            - blocked: bool (L3, 任务需要阻塞)
            - push_stack: bool (L4, 需要压栈执行)
            - stack_task_goal: str (压栈任务的目标)
            - reason: str (原因描述)
        """
        if not self._recovery:
            return {}
        
        decision = self._recovery.on_action_result(result, tick)
        
        logger.info(
            f"[Recovery] Tick {tick}: {decision.level.value} - {decision.action_type.value} "
            f"(failures={self._recovery.get_consecutive_failures()})"
        )
        
        # L3: 报告并阻塞
        if decision.level == RecoveryLevel.L3_REPORT_BLOCK:
            return {
                "blocked": True,
                "reason": decision.reason,
            }
        
        # L4: 压栈执行 (goto_owner)
        if not decision.is_inline:
            return {
                "push_stack": True,
                "stack_task_goal": "goto_owner",
                "reason": decision.reason,
            }
        
        # L1/L2: 内联执行恢复动作
        if decision.should_retry:
            await self._execute_recovery_action(decision, actions)
        
        return {}

    async def _execute_recovery_action(
        self,
        decision: RecoveryDecision,
        actions: "IBotActions"
    ) -> None:
        """
        执行内联恢复动作 (L1/L2)
        
        Args:
            decision: 恢复决策
            actions: Bot 动作接口
        """
        action_type = decision.action_type
        params = decision.params or {}
        
        try:
            if action_type == RecoveryActionType.RETRY_SAME:
                # 不需要额外动作，让 loop 重新执行
                logger.debug("[Recovery] L1: Will retry same action")
                return
            
            elif action_type == RecoveryActionType.MICRO_MOVE:
                # 微移位：随机往某个方向移动一小段
                max_delta = params.get("max_delta", 1)
                dx = random.uniform(-max_delta, max_delta)
                dz = random.uniform(-max_delta, max_delta)
                
                bot_state = actions.get_state()
                pos = bot_state.get("position", {})
                new_x = int(pos.get("x", 0) + dx)
                new_y = int(pos.get("y", 64))
                new_z = int(pos.get("z", 0) + dz)
                
                target = f"{new_x},{new_y},{new_z}"
                logger.debug(f"[Recovery] L1: Micro move to {target}")
                
                await actions.goto(target=target, timeout=5.0)
            
            elif action_type == RecoveryActionType.UNSTUCK_BACKOFF:
                # 后退：往反方向走一段距离
                backoff = params.get("backoff_distance", 3)
                
                bot_state = actions.get_state()
                pos = bot_state.get("position", {})
                # 简单策略：随机方向后退
                dx = random.uniform(-backoff, backoff)
                dz = random.uniform(-backoff, backoff)
                
                new_x = int(pos.get("x", 0) + dx)
                new_y = int(pos.get("y", 64))
                new_z = int(pos.get("z", 0) + dz)
                
                target = f"{new_x},{new_y},{new_z}"
                logger.debug(f"[Recovery] L2: Unstuck backoff to {target}")
                
                await actions.goto(target=target, timeout=10.0)
            
            elif action_type == RecoveryActionType.UNSTUCK_STEP_UP:
                # 向上跳跃：尝试跳上一个方块
                bot_state = actions.get_state()
                pos = bot_state.get("position", {})
                
                new_x = int(pos.get("x", 0))
                new_y = int(pos.get("y", 64)) + 1
                new_z = int(pos.get("z", 0))
                
                target = f"{new_x},{new_y},{new_z}"
                logger.debug(f"[Recovery] L2: Unstuck step up to {target}")
                
                await actions.goto(target=target, timeout=5.0)
            
            else:
                logger.warning(f"[Recovery] Unknown action type: {action_type}")
        
        except Exception as e:
            logger.warning(f"[Recovery] Recovery action failed: {e}")

