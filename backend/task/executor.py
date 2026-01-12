# Task Executor
# 任务执行器 - 协调 Planner、Stack、Actions，驱动任务执行循环

import asyncio
import logging
import inspect
from typing import Dict, Any, List, Optional, Callable, Awaitable, TYPE_CHECKING, Tuple

from .interfaces import (
    StackTask,
    ActionStep,
    ActionPlan,
    TaskResult,
    TaskStatus,
    TaskType,
    RunContext,
    ITaskPlanner,
    IPrerequisiteResolver,
    ITaskExecutor,
    IRunnerFactory,
)
from .stack_planner import StackPlanner, StackOverflowError
from .behavior_rules import BehaviorRules

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
    from .runners import RunnerRegistry


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
       - 通过 RunnerFactory 创建 Runner
       - 调用 Runner.run()
    3. _handle_failure() - 处理失败
       - 符号层优先 (PrerequisiteResolver)
       - 符号层失败则由 Runner 内部处理或向上抛出
    """
    
    def __init__(
        self,
        planner: ITaskPlanner,
        actions: "IBotActions",
        prereq_resolver: Optional[IPrerequisiteResolver] = None,
        runner_registry: Optional["RunnerRegistry"] = None,
        runner_factory: Optional[IRunnerFactory] = None,  #  Phase 3+: 推荐使用
        max_retries: int = 3,
        on_progress: Optional[Callable[[str], Awaitable[None]]] = None,
        owner_name: Optional[str] = None,  # 用于 give 命令的玩家名
    ):
        """
        初始化执行器
        
        Args:
            planner: 任务规划器 (LLM)
            actions: Bot 动作接口
            prereq_resolver: 前置任务解析器 (符号层)
            runner_registry: [Deprecated] Runner 注册表，请使用 runner_factory
            runner_factory: Runner 工厂 (推荐，Phase 3+)
            max_retries: 单个任务最大重试次数
            on_progress: 进度回调 (用于更新头顶显示)
            owner_name: 主人玩家名 (用于 give 命令)
        """
        self._planner = planner
        self._actions = actions
        self._prereq = prereq_resolver
        self._max_retries = max_retries
        self._on_progress = on_progress
        self._owner_name = owner_name
        self._owner_position: Optional[dict] = None  # 玩家实时位置（来自 Java 插件）
        
        # 并发锁，防止多任务重入导致状态不一致
        self._lock = asyncio.Lock()

        #  Phase 3+ RunnerFactory 优先
        # 兼容性：支持 runner_registry 或自动创建默认 factory
        if runner_factory is not None:
            self._runner_factory = runner_factory
            self._registry = None  # 不再使用
        elif runner_registry is not None:
            # 兼容旧代码：包装 registry 为 factory-like 行为
            self._registry = runner_registry
            self._runner_factory = None
        else:
            # 默认：根据 Feature Flag 创建
            from .runner_factory import create_runner_factory
            self._runner_factory = create_runner_factory(BehaviorRules())
            self._registry = None
        
        self._stack = StackPlanner()
        self._cancelled = False
        self._running = False
        # Rulebook：将阈值/关键词/策略配置化，避免写死在 prompt/代码里
        self._rules = BehaviorRules()
        
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
    
    async def execute_tasks(self, tasks: List[StackTask]) -> TaskResult:
        """
        执行 Decomposer 产出的任务列表
        
        Args:
            tasks: 有序的任务列表（按依赖序，第一个先执行）
            
        Returns:
            TaskResult: 执行结果
        """
        if not tasks:
            return TaskResult(
                success=False,
                task_description="空任务列表",
                message="没有任务需要执行"
            )
        
        self._cancelled = False
        self._running = True
        
        task_names = [t.name for t in tasks]
        overall_description = f"{len(tasks)} 个任务: {', '.join(task_names[:3])}{'...' if len(tasks) > 3 else ''}"
        
        logger.info(f"Starting execution of {len(tasks)} decomposed tasks: {task_names}")
        
        # 使用锁确保串行执行
        async with self._lock:
            # 反向压入栈（确保第一个任务在栈顶先执行）
            try:
                for task in reversed(tasks):
                    self._stack.push(task)
            except StackOverflowError as e:
                self._running = False
                return TaskResult(
                    success=False,
                    task_description=overall_description,
                    message=str(e)
                )

            # 复用现有执行逻辑（继续到 execute 方法的循环部分）
            all_completed_steps: List["ActionResult"] = []
            last_failed_step: Optional["ActionResult"] = None

            try:
                while not self._stack.is_empty() and not self._cancelled:
                    current = self._stack.current()
                    logger.info(f"Executing task: {current.name} (depth={self._stack.depth})")
                    await self._report_progress(f"执行: {current.name}")
                    result = await self._execute_task(current)

                    if result.success:
                        self._stack.pop()
                        all_completed_steps.extend(result.completed_steps)
                        logger.info(f"Task completed: {current.name}")
                    else:
                        last_failed_step = result.failed_step

                        # 增加重试计数逻辑，防止无限循环
                        current_retries = current.context.get("retries", 0)
                        if current_retries >= self._max_retries:
                            logger.warning(f"Task {current.name} failed {current_retries} times. Max retries reached.")
                            resolved = False
                        else:
                            current.context["retries"] = current_retries + 1
                            resolved = await self._handle_task_failure(result)

                        if not resolved:
                            self._stack.clear()
                            self._running = False
                            return TaskResult(
                                success=False,
                                task_description=overall_description,
                                completed_steps=all_completed_steps,
                                failed_step=last_failed_step,
                                message=f"任务失败: {result.message}"
                            )
                
                if self._cancelled:
                    self._running = False
                    return TaskResult(success=False, task_description=overall_description, message="任务已取消")
            
                self._running = False
                await self._report_progress("任务完成 ✅")
                return TaskResult(success=True, task_description=overall_description, completed_steps=all_completed_steps, message="任务完成")
            except StackOverflowError as e:
                self._running = False
                self._stack.clear()
                return TaskResult(success=False, task_description=overall_description, message="任务太复杂")
            except Exception as e:
                self._running = False
                self._stack.clear()
                return TaskResult(success=False, task_description=overall_description, message=f"执行出错: {str(e)}")
    
    async def execute(
        self,
        task_description: str,
        task_type: Optional[str] = None,
        task_payload: Optional[Dict[str, Any]] = None,
    ) -> TaskResult:
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
        
        # 使用锁确保串行执行
        async with self._lock:
            # 创建根任务并压入栈
            root_task = StackTask(
                name=task_description,
                goal=task_description,
                context={"is_root": True, "task_type": task_type, "task_payload": task_payload or {}},
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

                        # 增加重试计数逻辑，防止无限循环
                        current_retries = current.context.get("retries", 0)
                        if current_retries >= self._max_retries:
                            logger.warning(f"Task {current.name} failed {current_retries} times. Max retries reached.")
                            resolved = False
                        else:
                            current.context["retries"] = current_retries + 1
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
        
        Phase 3+ 架构：
        - 通过 RunnerFactory 获取 Runner（封装所有路由决策）
        - TaskExecutor 只负责生命周期管理，不关心具体 Runner 类型
        
        兼容模式：
        - 如果使用旧的 runner_registry，则回退到旧逻辑
        
        Args:
            task: 栈任务
            
        Returns:
            TaskResult: 任务执行结果
        """
        # 构建执行上下文
        context = RunContext(
            owner_name=self._owner_name,
            owner_position=self._owner_position,
            on_progress=self._on_progress,
        )
        
        #  Phase 3+: 使用 RunnerFactory
        if self._runner_factory is not None:
            try:
                runner = self._runner_factory.create(task)
                logger.debug(f"Using {runner.__class__.__name__} for task: {task.name}")
                return await runner.run(task, self._actions, self._planner, context)
            except Exception as e:
                logger.exception(f"Runner execution failed: {e}")
                return TaskResult(
                    success=False,
                    task_description=task.goal,
                    message=f"执行异常: {str(e)}"
                )
        
        # 兼容模式: 使用旧的 RunnerRegistry (已精简，仅支持基本的 get)
        if self._registry is not None:
            # 类型推断 (简单的)
            if task.task_type is None and self._should_use_tick_loop(task):
                 task.task_type = TaskType.GATHER

            runner = None
            if task.task_type is not None:
                runner = self._registry.get(task.task_type)

            if runner:
                 return await runner.run(task, self._actions, self._planner, context)
            else:
                return TaskResult(
                    success=False,
                    task_description=task.goal,
                    message="未找到合适的 Runner，且 Legacy fallback 已移除"
                )
        
        # 不应到达这里
        logger.error("No runner_factory or registry configured")
        return TaskResult(
            success=False,
            task_description=task.goal,
            message="内部错误: 未配置 Runner"
        )
        
    def _should_use_tick_loop(self, task: StackTask) -> bool:
        """
        [Helper] 简单的类型推断，仅用于 Legacy Registry 模式
        """
        ctx = task.context or {}
        if ctx.get("source") == "prerequisite":
            return False
        task_type = ctx.get("task_type")
        return task_type == "mine"
    
    def _is_duplicate_explore_task(self, new_task: str) -> bool:
        """
        🔧 Fix: 检测是否是重复的 explore/patrol 任务
        
        防止 LLM 无限推入 explore 50 → explore 100 → ... 死循环
        
        Args:
            new_task: 待推入的任务描述
            
        Returns:
            True 如果检测到重复的探索任务
        """
        explore_keywords = ["explore", "patrol", "search", "scout", "巡逻", "探索", "搜索"]
        new_lower = new_task.lower()
        
        # 新任务是否是探索类
        new_is_explore = any(kw in new_lower for kw in explore_keywords)
        if not new_is_explore:
            return False
        
        # 检查栈中是否已有探索类任务
        explore_count = 0
        for task in self._stack._stack:
            task_lower = (task.goal or "").lower()
            if any(kw in task_lower for kw in explore_keywords):
                explore_count += 1
        
        # 如果栈中已有 2 个以上的探索任务，拒绝新增
        if explore_count >= 2:
            logger.warning(f"[Dedup] Stack already has {explore_count} explore tasks, blocking new: {new_task}")
            return True
        
        return False

    def _parse_task_parts(self, task: str) -> Optional[tuple]:
        parts = (task or "").strip().split()
        if len(parts) < 2:
            return None
        return parts[0].lower(), parts[1]

    def _should_skip_dynamic_task(
        self,
        task: str,
        inventory: Dict[str, int],
        error_code: Optional[str],
    ) -> bool:
        parsed = self._parse_task_parts(task)
        if not parsed:
            return False
        action, item = parsed
        if action != "craft":
            return False
        if inventory.get(item, 0) > 0:
            return True
        if item.endswith(("_pickaxe", "_axe", "_shovel", "_hoe", "_sword")) and error_code != "NO_TOOL":
            return True
        return False
    
    async def _handle_task_failure(self, result: TaskResult) -> bool:
        """
        处理任务失败
        
        优先级：
        1. 如果有 dynamic_tasks (LLM Slow Path)，直接压入栈
        2. 否则尝试符号层 (Fast Path)
        
        Args:
            result: 失败的任务结果
            
        Returns:
            True 如果成功压入前置任务
            False 如果无法解决
        """
        #  优先处理 dynamic_tasks (来自 DynamicResolver)
        if result.dynamic_tasks:
            # 🔧 Fix: 去重检测 - 防止无限 explore 死循环
            filtered_tasks = []
            error_code = result.failed_step.error_code if result.failed_step else None
            inventory = {}
            equipped = None
            if self._actions:
                state = self._actions.get_state()
                inventory = dict(state.get("inventory", {}) or {})
                equipped = state.get("equipped")
            if equipped:
                inventory[equipped] = max(inventory.get(equipped, 0), 1)
            for task_str in result.dynamic_tasks:
                if self._is_duplicate_explore_task(task_str):
                    logger.warning(f"[Dedup] Blocked duplicate explore task: {task_str}")
                    # 🔧 Fix: 发送 escalate 消息给玩家
                    if self._actions and hasattr(self._actions, 'chat'):
                        try:
                            await self._actions.chat("主人，这一片我找遍了也没发现目标，要不换个地方或者帮我指个路？")
                        except Exception:
                            pass
                    continue
                if result.failed_step and result.failed_step.action == "mine":
                    action_word = task_str.split(" ", 1)[0].lower()
                    if action_word in ("explore", "patrol"):
                        logger.warning(f"[Dedup] Blocked explore task for mining failure: {task_str}")
                        continue
                if self._should_skip_dynamic_task(task_str, inventory, error_code):
                    logger.info(f"[Dedup] Skipped dynamic task (already satisfied): {task_str}")
                    continue
                filtered_tasks.append(task_str)
            
            if not filtered_tasks:
                logger.info("[Dedup] All dynamic_tasks blocked as duplicates, escalating to user")
                if result.failed_step and result.failed_step.message:
                    result.message = result.failed_step.message
                return False  # 触发 escalate 逻辑
            
            logger.info(f"[DynamicResolver] Pushing {len(filtered_tasks)} prerequisite tasks")
            try:
                # 反向压入栈（确保第一个任务先执行）
                for task_str in reversed(filtered_tasks):
                    prereq = StackTask(
                        name=task_str,
                        goal=task_str,
                        context={"source": "dynamic_resolver"},
                        status=TaskStatus.PENDING,
                    )
                    self._stack.push(prereq)
                    logger.info(f"  - Pushed: {task_str}")
                return True
            except StackOverflowError:
                logger.warning("Stack overflow while pushing dynamic_tasks")
                raise  # 让上层处理
        
        # 符号层 (Fast Path)
        if not result.failed_step or not self._prereq:
            return False
        
        failed = result.failed_step
        
        # 只处理特定错误码
        if failed.error_code not in ("INSUFFICIENT_MATERIALS", "NO_TOOL", "STATION_NOT_PLACED"):
            return False
        
        # 构建上下文
        context = {
            "action": failed.action,
            "missing": failed.data.get("missing", {}) if isinstance(failed.data, dict) else {},
            "item": failed.data.get("item") if isinstance(failed.data, dict) else None,
            "tool_type": failed.data.get("tool_type") if isinstance(failed.data, dict) else None,
            "min_tier": failed.data.get("min_tier") if isinstance(failed.data, dict) else None,
            "station": failed.data.get("station") if isinstance(failed.data, dict) else None,
            "tag_aware": failed.data.get("tag_aware") if isinstance(failed.data, dict) else None,
        }
        
        inventory = self._actions.get_state().get("inventory", {}) if self._actions else {}
        
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
