# LinearPlanRunner - Linear Plan 执行策略
# 用于确定性任务 (合成/建造/导航/交付)
#
# 从 executor.py 的 _execute_task() 线性部分提取

import asyncio
import inspect
import logging
from typing import List, Optional, Dict, Any, TYPE_CHECKING

from ..interfaces import (
    StackTask,
    ActionStep,
    ActionPlan,
    TaskResult,
    TaskType,
    RunContext,
    ITaskRunner,
    ITaskPlanner,
)

if TYPE_CHECKING:
    from ...bot.interfaces import IBotActions, ActionResult

logger = logging.getLogger(__name__)


# 默认超时值 (秒)
DEFAULT_TIMEOUTS = {
    "goto": 60.0,
    "mine": 120.0,
    "mine_tree": 120.0,
    "craft": 30.0,
    "place": 10.0,
    "give": 30.0,
    "equip": 5.0,
    "scan": 10.0,
}


class LinearPlanRunner(ITaskRunner):
    """
    线性计划执行器
    
    流程：
    1) 调用 planner.plan() 生成 ActionPlan
    2) 逐步执行 ActionStep
    3) 步骤失败时调用 planner.replan()
    4) 超过重试次数则返回失败
    
    适用于：合成、建造、导航、交付等确定性任务
    """
    
    def __init__(self, max_retries: int = 3):
        """
        初始化 LinearPlanRunner
        
        Args:
            max_retries: 单个任务最大重试次数
        """
        self._max_retries = max_retries
    
    @property
    def supported_types(self) -> List[TaskType]:
        """支持的任务类型"""
        return [TaskType.CRAFT, TaskType.BUILD, TaskType.GOTO, TaskType.GIVE]
    
    async def run(
        self,
        task: StackTask,
        actions: "IBotActions",
        planner: ITaskPlanner,
        context: RunContext
    ) -> TaskResult:
        """
        执行确定性任务 (Linear Plan)
        
        提取自 TaskExecutor._execute_task() 的线性部分
        """
        retries = 0
        completed_steps: List["ActionResult"] = []
        
        # 获取 Bot 状态
        bot_state = actions.get_state()
        
        # 注入上下文信息
        if context.owner_name:
            bot_state["owner_name"] = context.owner_name
            if context.owner_position:
                bot_state["owner_position"] = context.owner_position
        
        # 规划
        try:
            plan = await planner.plan(task.goal, bot_state)
        except Exception as e:
            logger.error(f"Planning failed: {e}")
            return TaskResult(
                success=False,
                task_description=task.goal,
                message=f"规划失败: {str(e)}"
            )
        
        if not plan.steps:
            logger.warning(f"Empty plan for task: {task.name}")
            return TaskResult(
                success=False,
                task_description=task.goal,
                message="无法生成执行计划"
            )
        
        logger.info(f"Plan generated: {len(plan.steps)} steps")
        
        # 执行步骤
        step_index = 0
        while step_index < len(plan.steps):
            step = plan.steps[step_index]
            
            # 报告进度
            if context.on_progress:
                try:
                    await context.on_progress(step.description or f"执行: {step.action}")
                except Exception as e:
                    logger.warning(f"Progress callback failed: {e}")
            
            # 执行单个步骤
            result = await self._execute_step(actions, step)
            
            if result.success:
                completed_steps.append(result)
                step_index += 1
                logger.debug(f"Step {step_index}/{len(plan.steps)} completed: {step.action}")
            else:
                # 步骤失败
                logger.warning(f"Step failed: {step.action} - {result.message}")
                retries += 1
                
                if retries >= self._max_retries:
                    return TaskResult(
                        success=False,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        failed_step=result,
                        message=f"步骤 '{step.action}' 失败，已重试 {retries} 次"
                    )
                
                # 尝试 replan
                logger.info(f"Attempting replan (retry {retries}/{self._max_retries})")
                bot_state = actions.get_state()
                if context.owner_name:
                    bot_state["owner_name"] = context.owner_name
                    if context.owner_position:
                        bot_state["owner_position"] = context.owner_position
                
                try:
                    plan = await planner.replan(
                        task.goal, bot_state, result, completed_steps
                    )
                    
                    # 检查 replan 是否返回空计划
                    if not plan.steps:
                        logger.warning(f"Replan returned empty plan, giving up")
                        return TaskResult(
                            success=False,
                            task_description=task.goal,
                            completed_steps=completed_steps,
                            failed_step=result,
                            message=f"步骤 '{step.action}' 失败，重规划无法修复"
                        )
                    
                    step_index = 0  # 从新计划的开头执行
                except Exception as e:
                    logger.error(f"Replan failed: {e}")
                    return TaskResult(
                        success=False,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        failed_step=result,
                        message=f"重规划失败: {str(e)}"
                    )
        
        return TaskResult(
            success=True,
            task_description=task.goal,
            completed_steps=completed_steps,
            message="任务完成"
        )
    
    async def _execute_step(self, actions: "IBotActions", step: ActionStep) -> "ActionResult":
        """执行单个动作步骤"""
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
        
        # goto 参数归一化: {'x', 'y', 'z'} -> {'target': {'x', 'y', 'z'}}
        if action_name == "goto":
            # 如果没有 target 参数，但有 x, y, z 参数，则封装为 target 字典
            if "target" not in params and all(k in params for k in ("x", "y", "z")):
                params["target"] = {
                    "x": params.pop("x"),
                    "y": params.pop("y"),
                    "z": params.pop("z")
                }
                logger.debug(f"Normalized goto params: {params}")
        
        # craft 参数归一化: {'item': 'xxx'} -> {'item_name': 'xxx'}
        if action_name == "craft":
            if "item" in params and "item_name" not in params:
                params["item_name"] = params.pop("item")
                logger.debug(f"Normalized craft params: {params}")
        
        # give 参数归一化: {'player': 'xxx', 'item': 'xxx'} -> {'player_name': 'xxx', 'item_name': 'xxx'}
        if action_name == "give":
            if "player" in params and "player_name" not in params:
                params["player_name"] = params.pop("player")
            if "item" in params and "item_name" not in params:
                params["item_name"] = params.pop("item")
            logger.debug(f"Normalized give params: {params}")
        
        # 处理超时参数
        if "timeout_sec" in params:
            params["timeout"] = params.pop("timeout_sec")
        elif "timeout" not in params:
            params["timeout"] = DEFAULT_TIMEOUTS.get(action_name, 30.0)
        
        # scan 不接受 timeout
        NO_TIMEOUT_ACTIONS = {"scan"}
        if action_name in NO_TIMEOUT_ACTIONS and "timeout" in params:
            params.pop("timeout")

        # MetaAction dispatch
        try:
            from ...bot.meta_actions import MetaActionRegistry
        except Exception:
            MetaActionRegistry = None

        if MetaActionRegistry:
            meta_action = MetaActionRegistry.get(action_name)
            if meta_action:
                try:
                    return await meta_action.execute(actions, **params)
                except Exception as e:
                    logger.exception(f"MetaAction execution error: {e}")
                    return _ActionResult(
                        success=False,
                        action=action_name,
                        message=str(e),
                        status=_ActionStatus.FAILED,
                        error_code="META_ACTION_ERROR"
                    )
        
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
