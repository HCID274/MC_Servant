# Runner Factory - Runner 创建工厂
#
# 设计原则：简单接口，深度功能；依赖抽象，而非具体
#
# 两种模式：
# 1. UniversalRunnerFactory: Phase 3+ 通用模式
# 2. ClassicRunnerFactory: 过渡期旧模式

import logging
from typing import Optional, TYPE_CHECKING

from .interfaces import IRunnerFactory, ITaskRunner, StackTask, TaskType
from .behavior_rules import BehaviorRules

if TYPE_CHECKING:
    from .runners.registry import RunnerRegistry
    from ..perception.knowledge_base import JsonKnowledgeBase
    from .actor import LLMTaskActor
    from .action_resolver import SemanticActionResolver
    from ..llm.interfaces import ILLMClient
    from ..perception.interfaces import IKnowledgeBase

logger = logging.getLogger(__name__)


class UniversalRunnerFactory(IRunnerFactory):
    """
    Phase 3+ 通用 Runner 工厂
    
    所有任务都交给 UniversalRunner 处理。
    每次 create() 都新建 Runner 和 LLMRecoveryPlanner 实例（任务级隔离）。
    
    依赖注入：
    - rules: BehaviorRules (共享，只读配置)
    - llm_client: ILLMClient (用于 LLM 驱动恢复)
    - knowledge_base: IKnowledgeBase (用于 KBOnlyResolver)
    
    每次新建：
    - LLMRecoveryPlanner (有状态，任务级隔离)
    - KBOnlyResolver (轻量级)
    - UniversalRunner
    """
    
    def __init__(
        self, 
        rules: Optional[BehaviorRules] = None,
        llm_client: Optional["ILLMClient"] = None,
        knowledge_base: Optional["IKnowledgeBase"] = None,
    ):
        """
        初始化工厂
        
        Args:
            rules: 行为规则配置 (可选，默认创建新实例)
            llm_client: LLM 客户端 (用于 LLM 驱动恢复)
            knowledge_base: 知识库 (用于参数归一化)
        """
        self._rules = rules or BehaviorRules()
        self._llm_client = llm_client
        self._kb = knowledge_base

        # 如果没有注入 KB，尝试获取全局实例 (为了兼容性)
        if self._kb is None:
            try:
                from ..perception.knowledge_base import get_knowledge_base
                self._kb = get_knowledge_base()
            except ImportError:
                logger.warning("KnowledgeBase not available for UniversalRunnerFactory")

        logger.info("UniversalRunnerFactory initialized")
    
    def create(self, task: StackTask) -> ITaskRunner:
        """
        为给定任务创建 UniversalRunner 实例
        
        每次调用都新建 LLMRecoveryPlanner，确保任务级状态隔离。
        """
        from .universal_runner import UniversalRunner
        from .kb_resolver import KBOnlyResolver
        
        recovery_planner = None
        if self._llm_client:
            from .llm_recovery_planner import LLMRecoveryPlanner
            recovery_planner = LLMRecoveryPlanner(llm_client=self._llm_client)
        
        # 创建 Resolver (注入 KnowledgeBase)
        # 注意：测试/无 KB 场景下 self._kb 可能为 None，此时不应强行构造 KBOnlyResolver(kb=None)
        # 让 UniversalRunner 自己走 fallback resolver（透传/轻量 resolver），避免 normalize_step 崩溃。
        resolver = None
        if self._kb is not None:
            resolver = KBOnlyResolver(kb=self._kb)

        logger.debug(f"Creating UniversalRunner for task: {task.name}")
        return UniversalRunner(
            resolver=resolver,
            rules=self._rules,
            recovery_planner=recovery_planner,
        )


class ClassicRunnerFactory(IRunnerFactory):
    """
    过渡期旧 Runner 工厂
    
    使用旧的 GatherRunner + LinearPlanRunner 架构。
    内部通过 RunnerRegistry 维护 Type -> Runner 映射。
    
    注意：此工厂在 Week 12+ 将被删除。
    
    依赖注入：
    - rules: BehaviorRules
    - actor: LLMTaskActor (用于 GatherRunner)
    - resolver: SemanticActionResolver (用于 GatherRunner)
    """
    
    def __init__(
        self,
        rules: Optional[BehaviorRules] = None,
        actor: Optional["LLMTaskActor"] = None,
        resolver: Optional["SemanticActionResolver"] = None,
    ):
        """
        初始化工厂
        
        Args:
            rules: 行为规则配置
            actor: LLM Actor (用于 GatherRunner)
            resolver: 动作解析器 (用于 GatherRunner)
        """
        from .runners.registry import RunnerRegistry
        from .runners.gather_runner import GatherRunner
        from .runners.linear_plan_runner import LinearPlanRunner
        from .recovery_coordinator import RecoveryCoordinator
        
        self._rules = rules or BehaviorRules()
        self._actor = actor
        self._resolver = resolver
        
        # 内部维护 Registry
        self._registry = RunnerRegistry()
        
        # 注册 GatherRunner (如果有 actor/resolver)
        if actor and resolver:
            recovery = RecoveryCoordinator(rules=self._rules)
            gather_runner = GatherRunner(actor=actor, resolver=resolver, recovery=recovery)
            self._registry.register_for_types(gather_runner)
        else:
            # 无 actor/resolver 时使用简化版 GatherRunner
            gather_runner = GatherRunner(rules=self._rules)
            self._registry.register_for_types(gather_runner)
        
        # 注册 LinearPlanRunner
        self._default_runner = LinearPlanRunner(max_retries=3)
        self._registry.register_for_types(self._default_runner)
        
        logger.info(
            f"ClassicRunnerFactory initialized with types: "
            f"{[t.value for t in self._registry.registered_types]}"
        )
    
    def create(self, task: StackTask) -> ITaskRunner:
        """
        为给定任务获取 Runner
        
        路由逻辑：
        1. 如果 task.task_type 已设置，直接查询 Registry
        2. 否则使用类型推断
        3. 找不到则返回默认 Runner (LinearPlanRunner)
        """
        task_type = task.task_type
        
        # 类型推断（从 Executor._should_use_tick_loop 迁移）
        if task_type is None:
            task_type = self._infer_type(task)
        
        # 从 Registry 获取
        if task_type is not None:
            runner = self._registry.get(task_type)
            if runner:
                logger.debug(f"ClassicFactory: Using {runner.__class__.__name__} for {task.name}")
                return runner
        
        # 默认 Runner
        logger.debug(f"ClassicFactory: Using default LinearPlanRunner for {task.name}")
        return self._default_runner
    
    def _infer_type(self, task: StackTask) -> Optional[TaskType]:
        """
        从任务上下文推断类型
        
        迁移自 TaskExecutor._should_use_tick_loop()
        """
        ctx = task.context or {}
        
        # 前置任务走 Linear
        if ctx.get("source") == "prerequisite":
            return None
        
        # mine 任务走 Tick Loop
        if ctx.get("task_type") == "mine":
            return TaskType.GATHER
        
        return None


def create_runner_factory(
    rules: Optional[BehaviorRules] = None,
    actor: Optional["LLMTaskActor"] = None,
    resolver: Optional["SemanticActionResolver"] = None,
    llm_client: Optional["ILLMClient"] = None,
) -> IRunnerFactory:
    """
    根据 Feature Flag 创建合适的 RunnerFactory
    
    这是推荐的工厂创建入口，封装了 Feature Flag 判断。
    
    Args:
        rules: 行为规则配置
        actor: LLM Actor (仅 ClassicFactory 需要)
        resolver: 动作解析器 (仅 ClassicFactory 需要)
        llm_client: LLM 客户端 (仅 UniversalFactory 需要)
        
    Returns:
        IRunnerFactory: 合适的工厂实例
    """
    from config import settings
    
    if settings.use_universal_runner:
        logger.info("Feature flag enabled: using UniversalRunnerFactory")
        # 需要获取 KB 实例注入
        kb = None
        if resolver and hasattr(resolver, '_kb'):
            kb = resolver._kb
        elif actor and hasattr(actor, '_kb'):
            kb = actor._kb

        return UniversalRunnerFactory(rules=rules, llm_client=llm_client, knowledge_base=kb)
    else:
        logger.info("Feature flag disabled: using ClassicRunnerFactory")
        return ClassicRunnerFactory(rules=rules, actor=actor, resolver=resolver)
