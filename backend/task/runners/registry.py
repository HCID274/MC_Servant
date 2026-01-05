# RunnerRegistry - 任务类型到 Runner 的映射
# 遵循开闭原则：新增任务类型只需注册新 Runner

import logging
from typing import Dict, Optional, TYPE_CHECKING

from ..interfaces import TaskType, ITaskRunner

if TYPE_CHECKING:
    from .gather_runner import GatherRunner
    from .linear_plan_runner import LinearPlanRunner

logger = logging.getLogger(__name__)


class RunnerRegistry:
    """
    任务类型 → Runner 映射注册表
    
    遵循开闭原则 (OCP)：
    - 新增任务类型只需添加 Runner 并注册
    - 不需要修改 TaskExecutor 核心代码
    
    使用示例：
        registry = RunnerRegistry.create_default()
        runner = registry.get(TaskType.GATHER)
        result = await runner.run(task, actions, planner, context)
    """
    
    def __init__(self):
        self._runners: Dict[TaskType, ITaskRunner] = {}
    
    def register(self, task_type: TaskType, runner: ITaskRunner) -> None:
        """
        注册 Runner
        
        Args:
            task_type: 任务类型
            runner: 对应的 Runner 实例
        """
        self._runners[task_type] = runner
        logger.debug(f"Registered {runner.__class__.__name__} for {task_type.value}")
    
    def register_for_types(self, runner: ITaskRunner) -> None:
        """
        根据 Runner 的 supported_types 自动注册
        
        Args:
            runner: Runner 实例（会读取其 supported_types 属性）
        """
        for task_type in runner.supported_types:
            self.register(task_type, runner)
    
    def get(self, task_type: TaskType) -> Optional[ITaskRunner]:
        """
        获取指定类型的 Runner
        
        Args:
            task_type: 任务类型
            
        Returns:
            对应的 Runner，未找到则返回 None
        """
        return self._runners.get(task_type)
    
    def get_or_default(self, task_type: Optional[TaskType], default_type: TaskType = TaskType.CRAFT) -> Optional[ITaskRunner]:
        """
        获取 Runner，如果类型为 None 或未注册则返回默认类型的 Runner
        
        Args:
            task_type: 任务类型（可为 None）
            default_type: 默认任务类型
            
        Returns:
            对应的 Runner
        """
        if task_type is None:
            return self._runners.get(default_type)
        return self._runners.get(task_type) or self._runners.get(default_type)
    
    @property
    def registered_types(self) -> list:
        """已注册的任务类型列表"""
        return list(self._runners.keys())
    
    @classmethod
    def create_default(cls) -> "RunnerRegistry":
        """
        创建默认注册表
        
        根据 config.use_universal_runner 切换:
        - False (默认): GatherRunner + LinearPlanRunner
        - True: UniversalRunner (覆盖全部任务类型)
        """
        from config import settings
        from ..behavior_rules import BehaviorRules
        
        registry = cls()
        
        if settings.use_universal_runner:
            # Phase 3 MVP: UniversalRunner 接管全部
            from ..universal_runner import UniversalRunner
            
            rules = BehaviorRules()
            universal_runner = UniversalRunner(rules=rules)
            registry.register_for_types(universal_runner)
            
            logger.info(
                f"Created UniversalRunner registry (MVP mode) with types: "
                f"{[t.value for t in registry.registered_types]}"
            )
        else:
            # Legacy: GatherRunner + LinearPlanRunner
            from .gather_runner import GatherRunner
            from .linear_plan_runner import LinearPlanRunner
            
            gather_runner = GatherRunner(rules=BehaviorRules())
            linear_runner = LinearPlanRunner(max_retries=3)
            
            registry.register_for_types(gather_runner)
            registry.register_for_types(linear_runner)
            
            logger.info(
                f"Created default RunnerRegistry with types: "
                f"{[t.value for t in registry.registered_types]}"
            )
        
        return registry

