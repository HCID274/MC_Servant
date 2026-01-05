# Runner Factory - Runner 创建工厂
#
# 设计原则：简单接口，深度功能；依赖抽象，而非具体
#
# Phase 3+ 通用模式: UniversalRunnerFactory

import logging
from typing import Optional, TYPE_CHECKING

from .interfaces import IRunnerFactory, ITaskRunner, StackTask
from .behavior_rules import BehaviorRules

if TYPE_CHECKING:
    from .runners.registry import RunnerRegistry
    from ..perception.knowledge_base import JsonKnowledgeBase
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
        from .prerequisite_resolver import PrerequisiteResolver
        
        recovery_planner = None
        dynamic_resolver = None
        
        if self._llm_client:
            from .llm_recovery_planner import LLMRecoveryPlanner
            from .dynamic_resolver import DynamicResolver
            
            recovery_planner = LLMRecoveryPlanner(llm_client=self._llm_client)
            
            # 创建 DynamicResolver (Slow Path)
            try:
                from ..bot.tag_resolver import get_tag_resolver
                tag_resolver = get_tag_resolver()
            except Exception:
                tag_resolver = None
            dynamic_resolver = DynamicResolver(
                llm_client=self._llm_client, 
                tag_resolver=tag_resolver
            )
        
        # 创建 PrerequisiteResolver (Fast Path)
        prerequisite_resolver = PrerequisiteResolver()
        
        # 创建 Resolver (注入 KnowledgeBase)
        resolver = None
        if self._kb is not None:
            resolver = KBOnlyResolver(kb=self._kb)

        logger.debug(f"Creating UniversalRunner for task: {task.name}")
        return UniversalRunner(
            resolver=resolver,
            rules=self._rules,
            recovery_planner=recovery_planner,
            dynamic_resolver=dynamic_resolver,
            prerequisite_resolver=prerequisite_resolver,
        )


def create_runner_factory(
    rules: Optional[BehaviorRules] = None,
    llm_client: Optional["ILLMClient"] = None,
    knowledge_base: Optional["IKnowledgeBase"] = None,
    # Legacy arguments for compatibility, ignored
    actor: Optional[any] = None,
    resolver: Optional[any] = None,
) -> IRunnerFactory:
    """
    创建 RunnerFactory
    
    始终返回 UniversalRunnerFactory，Legacy 工厂已被删除。
    
    Args:
        rules: 行为规则配置
        llm_client: LLM 客户端
        knowledge_base: 知识库
        
    Returns:
        IRunnerFactory: UniversalRunnerFactory 实例
    """
    logger.info("Using UniversalRunnerFactory (Legacy runners removed)")
    
    # 如果没有显式传递 knowledge_base，尝试从 legacy args 中获取 (如果存在)
    # 实际上 actor 和 resolver 已经被废弃，所以这里主要是做一下清理
    # 但为了防止调用者仍然传了 actor.kb，这里尝试挽救一下
    kb = knowledge_base
    if kb is None and resolver and hasattr(resolver, '_kb'):
        kb = resolver._kb
    elif kb is None and actor and hasattr(actor, '_kb'):
        kb = actor._kb

    return UniversalRunnerFactory(rules=rules, llm_client=llm_client, knowledge_base=kb)
