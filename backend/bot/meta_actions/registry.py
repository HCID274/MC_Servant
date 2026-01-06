# Meta Action Registry
# 元动作注册表 - 静态注册 + 动态过滤
#
# 设计原则:
# - 静态注册: 系统启动时加载所有 MetaAction
# - 动态过滤: 根据 Bot 状态筛选可用动作

import logging
from typing import Dict, List, Type, Any, Optional

from .interface import IMetaAction

logger = logging.getLogger(__name__)


class MetaActionRegistry:
    """
    元动作注册表
    
    静态注册 + 动态过滤
    
    Usage:
        # 注册 (装饰器)
        @MetaActionRegistry.register
        class NavigateAction(IMetaAction):
            ...
        
        # 获取可用动作
        available = MetaActionRegistry.get_available(bot_state)
        
        # 格式化为 Prompt
        prompt_text = MetaActionRegistry.format_for_prompt(available)
    """
    
    _actions: Dict[str, Type[IMetaAction]] = {}
    _instances: Dict[str, IMetaAction] = {}  # 缓存实例
    
    @classmethod
    def register(cls, action_class: Type[IMetaAction]) -> Type[IMetaAction]:
        """
        装饰器: 注册 MetaAction
        
        Usage:
            @MetaActionRegistry.register
            class MyAction(IMetaAction):
                ...
        """
        # 创建实例以获取 name
        instance = action_class()
        name = instance.name
        
        if name in cls._actions:
            logger.warning(f"[MetaActionRegistry] Overwriting action: {name}")
        
        cls._actions[name] = action_class
        cls._instances[name] = instance
        
        logger.debug(f"[MetaActionRegistry] Registered: {name}")
        return action_class
    
    @classmethod
    def get(cls, name: str) -> Optional[IMetaAction]:
        """
        根据名称获取动作实例
        
        Args:
            name: 动作名称
        
        Returns:
            IMetaAction 实例或 None
        """
        if name not in cls._instances:
            if name in cls._actions:
                cls._instances[name] = cls._actions[name]()
            else:
                return None
        return cls._instances[name]
    
    @classmethod
    def get_all(cls) -> List[IMetaAction]:
        """获取所有已注册的动作"""
        return list(cls._instances.values())
    
    @classmethod
    def get_available(cls, bot_state: Dict[str, Any]) -> List[IMetaAction]:
        """
        根据 Bot 状态过滤可用动作
        
        只返回 can_execute() == True 的动作
        
        Args:
            bot_state: Bot 当前状态
        
        Returns:
            可用动作列表
        """
        available = []
        unavailable_reasons = []
        
        for name, action in cls._instances.items():
            try:
                if action.can_execute(bot_state):
                    available.append(action)
                else:
                    reason = action.get_unavailable_reason(bot_state)
                    if reason:
                        unavailable_reasons.append(f"{name}: {reason}")
            except Exception as e:
                logger.error(f"[MetaActionRegistry] can_execute failed for {name}: {e}")
        
        if unavailable_reasons:
            logger.debug(
                f"[MetaActionRegistry] Filtered out {len(unavailable_reasons)} actions: "
                f"{', '.join(unavailable_reasons[:3])}..."
            )
        
        logger.debug(
            f"[MetaActionRegistry] Available actions: "
            f"{[a.name for a in available]}"
        )
        
        return available
    
    @classmethod
    def format_for_prompt(
        cls, 
        actions: List[IMetaAction],
        style: str = "markdown"
    ) -> str:
        """
        格式化为 Prompt 注入格式
        
        Args:
            actions: 动作列表
            style: 格式风格 ("markdown" 或 "xml")
        
        Returns:
            格式化字符串
        """
        if not actions:
            return ""
        
        if style == "xml":
            return cls._format_xml(actions)
        else:
            return cls._format_markdown(actions)
    
    @classmethod
    def _format_markdown(cls, actions: List[IMetaAction]) -> str:
        """Markdown 格式"""
        lines = ["## Available Actions"]
        lines.append("")
        
        for action in actions:
            lines.append(action.format_for_prompt())
        
        return "\n".join(lines)
    
    @classmethod
    def _format_xml(cls, actions: List[IMetaAction]) -> str:
        """XML 格式"""
        lines = ["<available_actions>"]
        
        for action in actions:
            lines.append(f'  <action name="{action.name}">')
            lines.append(f"    <description>{action.description}</description>")
            
            if action.parameters:
                lines.append("    <parameters>")
                for param in action.parameters:
                    required = "required" if param.required else "optional"
                    lines.append(
                        f'      <param name="{param.name}" type="{param.type}" {required}>'
                        f"{param.description}</param>"
                    )
                lines.append("    </parameters>")
            
            lines.append("  </action>")
        
        lines.append("</available_actions>")
        return "\n".join(lines)
    
    @classmethod
    def clear(cls) -> None:
        """清空注册表 (仅用于测试)"""
        cls._actions.clear()
        cls._instances.clear()
        logger.info("[MetaActionRegistry] Cleared all registrations")
    
    @classmethod
    def count(cls) -> int:
        """获取已注册动作数量"""
        return len(cls._actions)
