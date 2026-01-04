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
)
from .stack_planner import StackPlanner, StackOverflowError
from .behavior_rules import BehaviorRules
from .runners import RunnerRegistry

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
        runner_registry: Optional[RunnerRegistry] = None,
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
            runner_registry: Runner 注册表 (策略模式)
            max_retries: 单个任务最大重试次数
            on_progress: 进度回调 (用于更新头顶显示)
            owner_name: 主人玩家名 (用于 give 命令)
        """
        self._planner = planner
        self._actions = actions
        self._prereq = prereq_resolver
        self._registry = runner_registry or RunnerRegistry.create_default()
        self._max_retries = max_retries
        self._on_progress = on_progress
        self._owner_name = owner_name
        self._owner_position: Optional[dict] = None  # 玩家实时位置（来自 Java 插件）
        
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
        
        优先使用 RunnerRegistry 分发任务（策略模式）
        如果任务没有 task_type 或 Runner 不可用，回退到旧逻辑
        
        Args:
            task: 栈任务
            
        Returns:
            TaskResult: 任务执行结果
        """
        # 优先使用 RunnerRegistry（策略模式）
        if task.task_type is not None:
            runner = self._registry.get(task.task_type)
            if runner is not None:
                context = RunContext(
                    owner_name=self._owner_name,
                    owner_position=self._owner_position,
                    on_progress=self._on_progress,
                )
                return await runner.run(task, self._actions, self._planner, context)
        
        # 回退：旧的类型推断逻辑 -> 转换为 TaskType 并路由到 RunnerRegistry
        # 对采集类任务启用 Tick Loop (通过 GatherRunner)
        if self._should_use_tick_loop(task):
            # 设置 task_type 并重新路由到 RunnerRegistry (消除代码重复)
            task.task_type = TaskType.GATHER
            runner = self._registry.get(TaskType.GATHER)
            if runner is not None:
                context = RunContext(
                    owner_name=self._owner_name,
                    owner_position=self._owner_position,
                    on_progress=self._on_progress,
                )
                return await runner.run(task, self._actions, self._planner, context)

        retries = 0
        completed_steps: List["ActionResult"] = []
        
        # 获取 Bot 状态
        bot_state = self._actions.get_state()
        
        # 注入上下文信息（用于 LLM 规划）
        if self._owner_name:
            bot_state["owner_name"] = self._owner_name
            
            # 优先使用 Java 插件提供的实时位置（更准确）
            if self._owner_position:
                bot_state["owner_position"] = self._owner_position
                logger.info(f"[DEBUG] Using Java-provided owner position: {self._owner_position}")
            # 降级：使用 Mineflayer 获取的位置（可能有延迟）
            elif hasattr(self._actions, 'get_player_position'):
                owner_pos = self._actions.get_player_position(self._owner_name)
                if owner_pos:
                    bot_state["owner_position"] = owner_pos
                    logger.info(f"[DEBUG] Using Mineflayer owner position (fallback): {owner_pos}")
        
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

    def _should_use_tick_loop(self, task: StackTask) -> bool:
        """
        是否启用 Tick Loop：
        - 仅对“资源采集/非确定性”的任务启用（mine intent）
        - 前置任务（prerequisite resolver 生成）暂时保持线性计划，避免影响面过大
        """
        ctx = task.context or {}
        if ctx.get("source") == "prerequisite":
            return False
        task_type = ctx.get("task_type")
        return task_type == "mine"

    async def _execute_task_tick_loop(self, task: StackTask) -> TaskResult:
        """
        [已弃用] 采集任务 Tick Loop
        
        ⚠️ 此方法已弃用，请使用 GatherRunner 代替。
        所有采集类任务现在通过 RunnerRegistry 路由到 GatherRunner。
        
        保留此方法是为了向后兼容，但不再维护。
        
        原始功能：
        每个 tick：
        1) Observe：bot_state + last_scan + last_result + history
        2) Act：LLM 只输出 1 个动作（或 done=true）
        3) Execute：执行动作
        4) Reflect：通过下一次 act() 的 done 或动作结果收敛
        
        推荐迁移：
        - 使用 task.task_type = TaskType.GATHER
        - 任务会自动路由到 GatherRunner.run()
        """
        import warnings
        warnings.warn(
            "_execute_task_tick_loop is deprecated, use GatherRunner instead",
            DeprecationWarning,
            stacklevel=2
        )
        completed_steps: List["ActionResult"] = []
        last_result: Optional["ActionResult"] = None
        last_scan: Optional[dict] = None
        # Inventory Delta completion（采集任务完成判据）
        gather_item_id: Optional[str] = None
        gather_target_count: Optional[int] = None
        gather_start_count: Optional[int] = None

        # 总体安全上限：避免卡死
        max_ticks = 25
        start_time = asyncio.get_event_loop().time()
        overall_timeout = 180.0

        tree_intent = ("树" in task.goal) and (("砍" in task.goal) or ("伐" in task.goal))
        # 指代语：以“主人坐标”为参照系（而不是 bot 自己的位置）
        owner_anchor_intent = self._rules.is_owner_anchor_intent(task.goal or "")
        navigated_to_owner = False

        for tick in range(1, max_ticks + 1):
            if self._cancelled:
                return TaskResult(
                    success=False,
                    task_description=task.goal,
                    completed_steps=completed_steps,
                    message="任务已取消"
                )

            if asyncio.get_event_loop().time() - start_time > overall_timeout:
                return TaskResult(
                    success=False,
                    task_description=task.goal,
                    completed_steps=completed_steps,
                    failed_step=last_result,
                    message="采集任务超时（Tick Loop）"
                )

            # Observe
            bot_state = self._actions.get_state()
            if self._owner_name:
                bot_state["owner_name"] = self._owner_name
                if self._owner_position:
                    bot_state["owner_position"] = self._owner_position
                elif hasattr(self._actions, 'get_player_position'):
                    owner_pos = self._actions.get_player_position(self._owner_name)
                    if owner_pos:
                        bot_state["owner_position"] = owner_pos

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

            # 初始化 Inventory Delta（尽量不依赖 LLM 声明 done）
            if tick == 1:
                # 1) 优先从 task.context/task_payload 读取（未来 Decomposer 产出的 GatherTask 会走这条）
                ctx = task.context or {}
                gather_spec = ctx.get("gather") if isinstance(ctx, dict) else None
                if isinstance(gather_spec, dict):
                    gi = gather_spec.get("item_id") or gather_spec.get("block_id")
                    gc = gather_spec.get("target_count")
                    if isinstance(gi, str) and isinstance(gc, int) and gc > 0:
                        gather_item_id, gather_target_count = gi, gc

                # 2) 兼容旧 goal 形式：`mine <item_id> <count>`
                if gather_item_id is None and isinstance(task.goal, str):
                    parts = task.goal.strip().split()
                    if len(parts) == 3 and parts[0].lower() == "mine":
                        maybe_id = parts[1]
                        try:
                            maybe_count = int(parts[2])
                        except Exception:
                            maybe_count = None
                        if isinstance(maybe_id, str) and isinstance(maybe_count, int) and maybe_count > 0:
                            gather_item_id, gather_target_count = maybe_id, maybe_count

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

            # --- 符号层强约束：用户说“我这边/我附近/离我最近”时，先到主人身边再做采集 ---
            # 目的：把参照系固定在 owner_position，避免后续 tick 又以 bot 当前位置为原点导致“动了但没砍到你这边的树”。
            if owner_anchor_intent and has_owner_pos and not navigated_to_owner:
                bot_pos = (bot_state or {}).get("position") or {}
                try:
                    dx = float(bot_pos.get("x", 0)) - float(owner_pos["x"])
                    dy = float(bot_pos.get("y", 0)) - float(owner_pos["y"])
                    dz = float(bot_pos.get("z", 0)) - float(owner_pos["z"])
                    dist2 = dx * dx + dy * dy + dz * dz
                except Exception:
                    dist2 = 999999.0

                # 认为“已到身边”：<= N 格（配置化）
                reached = float(self._rules.thresholds.goto_owner_reached_distance)
                if dist2 <= reached * reached:
                    navigated_to_owner = True
                else:
                    step = ActionStep(
                        action="goto",
                        params={"target": f'{int(owner_pos["x"])},{int(owner_pos["y"])},{int(owner_pos["z"])}'},
                        description="先走到主人身边（以主人的坐标为参照系）",
                    )
                    done = False
                    done_message = ""
            # Fast Path：砍树类任务优先 mine_tree（并优先使用 owner_position 作为 near_position）
            elif tree_intent and (tick == 1 or owner_anchor_intent):
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
                done = False
                done_message = ""
            # 混合参照系策略：采集类任务默认以 bot 为圆心扫描，但“扫不到且离主人太远”时，触发隐式回主人
            elif (not owner_anchor_intent) and has_owner_pos and last_scan is not None:
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

                    # “离主人太远则回主人区域”阈值（配置化）
                    fallback = float(self._rules.thresholds.owner_fallback_distance)
                    if dist2 > (fallback * fallback):
                        step = ActionStep(
                            action="goto",
                            params={"target": f'{int(owner_pos["x"])},{int(owner_pos["y"])},{int(owner_pos["z"])}'},
                            description="扫描不到目标且离主人太远：先向主人区域移动（隐式子任务）",
                        )
                        done = False
                        done_message = ""
                    else:
                        # 继续交给 LLM 决策
                        try:
                            step, done, done_message = await self._planner.act(
                                task_description=task.goal,
                                bot_state=bot_state,
                                completed_steps=completed_steps[-8:],
                            )
                        except Exception as e:
                            logger.error(f"Tick Loop act() failed: {e}")
                            return TaskResult(
                                success=False,
                                task_description=task.goal,
                                completed_steps=completed_steps,
                                failed_step=last_result,
                                message=f"决策失败: {str(e)}"
                            )
            else:
                # Act（只产出一步）
                try:
                    step, done, done_message = await self._planner.act(
                        task_description=task.goal,
                        bot_state=bot_state,
                        completed_steps=completed_steps[-8:],  # 只给最近几步，控 token
                    )
                except Exception as e:
                    logger.error(f"Tick Loop act() failed: {e}")
                    return TaskResult(
                        success=False,
                        task_description=task.goal,
                        completed_steps=completed_steps,
                        failed_step=last_result,
                        message=f"决策失败: {str(e)}"
                    )

            if done:
                return TaskResult(
                    success=True,
                    task_description=task.goal,
                    completed_steps=completed_steps,
                    message=done_message or "任务完成"
                )

            # 对采集类动作注入 owner_position 作为搜索原点（不依赖 LLM 理解“我这边”）
            if owner_anchor_intent and has_owner_pos:
                if step.action == "mine":
                    step.params = step.params or {}
                    step.params.setdefault("near_position", owner_pos)
                    step.params.setdefault("search_radius", int(self._rules.thresholds.default_search_radius))
                elif step.action == "mine_tree":
                    step.params = step.params or {}
                    step.params.setdefault("near_position", owner_pos)
                    step.params.setdefault("search_radius", int(self._rules.thresholds.default_search_radius))

            await self._report_progress(step.description or f"执行: {step.action} (tick {tick}/{max_ticks})")

            # Execute
            result = await self._execute_step(step)
            last_result = result
            if step.action == "goto" and result.success and owner_anchor_intent and has_owner_pos:
                # goto 到主人附近成功后，认为参照系已对齐
                navigated_to_owner = True

            # 保存 scan 结果，供下一 tick 使用
            if result.action == "scan" and result.success and isinstance(result.data, dict):
                last_scan = result.data

            # 收集历史
            if result.success:
                completed_steps.append(result)
            else:
                # 失败也记录一份，方便 LLM 在下一 tick 修正（但不计入 completed_steps）
                logger.warning(f"[TickLoop] Step failed: {result.action} - {result.message}")

        return TaskResult(
            success=False,
            task_description=task.goal,
            completed_steps=completed_steps,
            failed_step=last_result,
            message="采集任务未在步数上限内完成（Tick Loop）"
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

        # --- 参数归一化（防御 LLM 生成的别名 / 多余字段） ---
        # mine: 允许 block -> block_type
        if action_name == "mine":
            if "block_type" not in params and "block" in params:
                params["block_type"] = params.pop("block")
            # 也允许 planner 用 target 表示方块类型
            if "block_type" not in params and "target" in params and isinstance(params["target"], str):
                params["block_type"] = params.pop("target")
        
        # 处理超时参数
        if "timeout_sec" in params:
            params["timeout"] = params.pop("timeout_sec")
        elif "timeout" not in params:
            params["timeout"] = DEFAULT_TIMEOUTS.get(action_name, 30.0)
        
        # 某些动作不接受 timeout 参数，需要过滤掉
        # scan() 只接受 target_type 和 radius
        NO_TIMEOUT_ACTIONS = {"scan"}
        if action_name in NO_TIMEOUT_ACTIONS and "timeout" in params:
            params.pop("timeout")
        
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

        # 过滤未知参数（避免 TypeError 直接打断执行循环）
        try:
            sig = inspect.signature(action_method)
            accepted = set(sig.parameters.keys())
            # bound method 的签名不包含 self；这里保持防御性处理
            if "self" in accepted:
                accepted.remove("self")

            # 如果函数有 **kwargs，则不需要过滤
            has_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
            if not has_var_kw:
                params = {k: v for k, v in params.items() if k in accepted}
        except Exception:
            # 签名解析失败时不阻断执行
            pass
        
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
