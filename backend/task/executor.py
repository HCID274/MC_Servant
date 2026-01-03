# Task Executor
# 任务执行器 - 协调 Planner、Stack、Actions，驱动任务执行循环

import asyncio
import logging
from typing import Dict, Any, List, Optional, Callable, Awaitable, TYPE_CHECKING

from .interfaces import (
    StackTask,
    ActionStep,
    ActionPlan,
    TaskResult,
    TaskStatus,
    ITaskPlanner,
    IPrerequisiteResolver,
    ITaskExecutor,
)
from .stack_planner import StackPlanner, StackOverflowError

# 运行时导入 (测试时由 Mock 提供)
try:
    from ..bot.interfaces import IBotActions, ActionResult, ActionStatus
except ImportError:
    # 测试环境下可能导入失败，使用 TYPE_CHECKING 延迟
    IBotActions = None
    ActionResult = None
    ActionStatus = None

if TYPE_CHECKING:
    from ..bot.interfaces import IBotActions, ActionResult, ActionStatus


logger = logging.getLogger(__name__)


# 默认超时值 (秒)
DEFAULT_TIMEOUTS = {
    "goto": 60.0,
    "mine": 120.0,
    "craft": 30.0,
    "place": 10.0,
    "give": 30.0,
    "equip": 5.0,
    "scan": 10.0,
}


class TaskExecutor(ITaskExecutor):
    """
    任务执行器
    
    职责：
    - 协调 Planner (LLM)、Stack、Actions (Mineflayer)
    - 驱动「规划 → 执行 → 反思」循环
    - 处理失败和前置任务压栈
    
    执行流程：
    1. execute(task_description) - 入口
       - 创建根任务压入栈
       - 进入 while 循环
    2. _execute_task(stack_task) - 执行单个栈任务
       - 调用 planner.plan() 生成 ActionPlan
       - 逐步执行 ActionStep
       - 失败时尝试 replan
    3. _execute_step(step) - 执行单个动作
       - 调用对应的 IBotActions 方法
    4. _handle_failure() - 处理失败
       - 符号层优先 (PrerequisiteResolver)
       - 符号层失败则调用 LLM replan
    """
    
    def __init__(
        self,
        planner: ITaskPlanner,
        actions: "IBotActions",
        prereq_resolver: Optional[IPrerequisiteResolver] = None,
        max_retries: int = 3,
        on_progress: Optional[Callable[[str], Awaitable[None]]] = None,
    ):
        """
        初始化执行器
        
        Args:
            planner: 任务规划器 (LLM)
            actions: Bot 动作接口
            prereq_resolver: 前置任务解析器 (符号层)
            max_retries: 单个任务最大重试次数
            on_progress: 进度回调 (用于更新头顶显示)
        """
        self._planner = planner
        self._actions = actions
        self._prereq = prereq_resolver
        self._max_retries = max_retries
        self._on_progress = on_progress
        
        self._stack = StackPlanner()
        self._cancelled = False
        self._running = False
        
        logger.info("TaskExecutor initialized")
    
    @property
    def is_running(self) -> bool:
        """是否正在执行任务"""
        return self._running
    
    @property
    def current_task(self) -> Optional[StackTask]:
        """当前正在执行的任务"""
        return self._stack.current()
    
    @property
    def stack_depth(self) -> int:
        """当前栈深度"""
        return self._stack.depth
    
    async def execute(self, task_description: str) -> TaskResult:
        """
        执行任务直到完成或失败 (顶层入口)
        
        流程:
        1. 创建根任务并压入栈
        2. while 循环: 执行栈顶任务
        3. 任务成功 → pop，继续下一个
        4. 任务失败 → 尝试符号解析压栈前置任务
        5. 栈空 → 全部完成
        
        Args:
            task_description: 任务描述
            
        Returns:
            TaskResult: 执行结果
        """
        self._cancelled = False
        self._running = True
        
        logger.info(f"Starting task execution: {task_description}")
        
        # 创建根任务并压入栈
        root_task = StackTask(
            name=task_description,
            goal=task_description,
            context={"is_root": True},
            status=TaskStatus.PENDING
        )
        
        try:
            self._stack.push(root_task)
        except StackOverflowError as e:
            self._running = False
            return TaskResult(
                success=False,
                task_description=task_description,
                message=str(e)
            )
        
        all_completed_steps: List["ActionResult"] = []
        last_failed_step: Optional["ActionResult"] = None
        
        try:
            # 主执行循环
            while not self._stack.is_empty() and not self._cancelled:
                current = self._stack.current()
                logger.info(f"Executing task: {current.name} (depth={self._stack.depth})")
                
                # 更新进度
                await self._report_progress(f"执行: {current.name}")
                
                # 执行当前任务
                result = await self._execute_task(current)
                
                if result.success:
                    # 任务成功，弹出栈
                    self._stack.pop()
                    all_completed_steps.extend(result.completed_steps)
                    logger.info(f"Task completed: {current.name}")
                else:
                    # 任务失败，尝试解决
                    last_failed_step = result.failed_step
                    resolved = await self._handle_task_failure(result)
                    
                    if not resolved:
                        # 无法解决，中止执行
                        logger.warning(f"Task failed and cannot be resolved: {current.name}")
                        self._stack.clear()
                        self._running = False
                        return TaskResult(
                            success=False,
                            task_description=task_description,
                            completed_steps=all_completed_steps,
                            failed_step=last_failed_step,
                            message=f"任务失败: {result.message}"
                        )
            
            # 检查取消状态
            if self._cancelled:
                self._running = False
                return TaskResult(
                    success=False,
                    task_description=task_description,
                    completed_steps=all_completed_steps,
                    message="任务已取消"
                )
            
            # 全部完成
            self._running = False
            await self._report_progress("任务完成 ✅")
            return TaskResult(
                success=True,
                task_description=task_description,
                completed_steps=all_completed_steps,
                message="任务完成"
            )
            
        except StackOverflowError as e:
            self._running = False
            self._stack.clear()
            logger.error(f"Stack overflow: {e}")
            return TaskResult(
                success=False,
                task_description=task_description,
                completed_steps=all_completed_steps,
                failed_step=last_failed_step,
                message="任务太复杂了，我脑子转不过来了，请拆分一下指令吧。"
            )
        except Exception as e:
            self._running = False
            self._stack.clear()
            logger.exception(f"Unexpected error during execution: {e}")
            return TaskResult(
                success=False,
                task_description=task_description,
                completed_steps=all_completed_steps,
                failed_step=last_failed_step,
                message=f"执行出错: {str(e)}"
            )
    
    async def _execute_task(self, task: StackTask) -> TaskResult:
        """
        执行单个栈任务
        
        流程:
        1. 调用 planner.plan() 生成 ActionPlan
        2. 逐步执行 ActionStep
        3. Step 失败时尝试 replan
        4. 超过重试次数则返回失败
        
        Args:
            task: 栈任务
            
        Returns:
            TaskResult: 任务执行结果
        """
        retries = 0
        completed_steps: List["ActionResult"] = []
        
        # 获取 Bot 状态
        bot_state = self._actions.get_state()
        
        # 规划
        try:
            plan = await self._planner.plan(task.goal, bot_state)
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
        while step_index < len(plan.steps) and not self._cancelled:
            step = plan.steps[step_index]
            
            await self._report_progress(step.description or f"执行: {step.action}")
            
            # 执行单个步骤
            result = await self._execute_step(step)
            
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
                bot_state = self._actions.get_state()
                
                try:
                    plan = await self._planner.replan(
                        task.goal, bot_state, result, completed_steps
                    )
                    
                    # 检查 replan 是否返回空计划（LLM 放弃）
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
        
        # 检查取消
        if self._cancelled:
            return TaskResult(
                success=False,
                task_description=task.goal,
                completed_steps=completed_steps,
                message="任务已取消"
            )
        
        return TaskResult(
            success=True,
            task_description=task.goal,
            completed_steps=completed_steps,
            message="任务完成"
        )
    
    async def _execute_step(self, step: ActionStep) -> "ActionResult":
        """
        执行单个动作步骤
        
        Args:
            step: 动作步骤
            
        Returns:
            ActionResult: 动作执行结果
        """
        # 使用模块顶部导入的类，如果导入失败则从 bot.interfaces 获取
        _ActionResult = ActionResult
        _ActionStatus = ActionStatus
        if _ActionResult is None:
            from bot.interfaces import ActionResult as _ActionResult, ActionStatus as _ActionStatus
        
        action_name = step.action
        params = step.params.copy()
        
        # 处理超时参数
        if "timeout_sec" in params:
            params["timeout"] = params.pop("timeout_sec")
        elif "timeout" not in params:
            params["timeout"] = DEFAULT_TIMEOUTS.get(action_name, 30.0)
        
        # 获取动作方法
        action_method = getattr(self._actions, action_name, None)
        if action_method is None:
            return _ActionResult(
                success=False,
                action=action_name,
                message=f"未知动作: {action_name}",
                status=_ActionStatus.FAILED,
                error_code="UNKNOWN_ACTION"
            )
        
        # 执行动作
        try:
            result = await action_method(**params)
            return result
        except TypeError as e:
            # 参数错误
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
    
    async def _handle_task_failure(self, result: TaskResult) -> bool:
        """
        处理任务失败
        
        优先使用符号层 (Fast Path)，失败则已经在 _execute_task 中尝试过 replan
        
        Args:
            result: 失败的任务结果
            
        Returns:
            True 如果成功压入前置任务
            False 如果无法解决
        """
        if not result.failed_step or not self._prereq:
            return False
        
        failed = result.failed_step
        
        # 只处理特定错误码
        if failed.error_code not in ("INSUFFICIENT_MATERIALS", "NO_TOOL"):
            return False
        
        # 构建上下文
        context = {
            "action": failed.action,
            "missing": failed.data.get("missing", {}) if failed.data else {},
            "item": failed.data.get("item") if failed.data else None,
            "tool_type": failed.data.get("tool_type") if failed.data else None,
            "min_tier": failed.data.get("min_tier") if failed.data else None,
        }
        
        inventory = self._actions.get_state().get("inventory", {})
        
        # 尝试符号解析
        prereq_task = self._prereq.resolve(
            error_code=failed.error_code,
            context=context,
            inventory=inventory
        )
        
        if prereq_task:
            logger.info(f"Symbolic resolution: pushing prerequisite task '{prereq_task.name}'")
            try:
                self._stack.push(prereq_task)
                return True
            except StackOverflowError:
                raise  # 让上层处理
        
        return False
    
    async def _report_progress(self, message: str) -> None:
        """报告进度"""
        if self._on_progress:
            try:
                await self._on_progress(message)
            except Exception as e:
                logger.warning(f"Progress callback failed: {e}")
    
    def cancel(self) -> None:
        """
        取消当前执行
        
        清空任务栈，停止执行循环
        """
        logger.info("Task execution cancelled")
        self._cancelled = True
        self._stack.clear()
    
    def get_stack_trace(self) -> List[str]:
        """获取当前栈追踪 (调试用)"""
        return self._stack.get_stack_trace()
