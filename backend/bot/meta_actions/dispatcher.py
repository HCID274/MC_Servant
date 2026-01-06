# Meta Action Dispatcher
# 元动作分发器 - 取代现有的 hardcoded dispatch

import inspect
import logging
from typing import Optional, Dict, Any, TYPE_CHECKING

from .registry import MetaActionRegistry

if TYPE_CHECKING:
    from ..interfaces import IBotActions, ActionResult

logger = logging.getLogger(__name__)


class MetaActionDispatcher:
    """
    元动作分发器 - 取代现有的 hardcoded dispatch
    
    职责:
    1. 解析 ActionStep (LLM 输出)
    2. 匹配 Registry 中的 MetaAction
    3. 执行并返回 ActionResult
    4. Fallback 到原生 BotActions
    
    设计原则:
    - 简单的接口: dispatch(action_name, params, actions)
    - 深度的功能: 自动参数过滤、timeout 归一化、错误处理
    - 依赖于抽象: 通过 IBotActions 和 IMetaAction 解耦
    """
    
    # 默认超时时间
    DEFAULT_TIMEOUTS = {
        "goto": 60.0,
        "navigate": 60.0,
        "mine": 120.0,
        "mine_tree": 120.0,
        "gather_block": 120.0,
        "craft": 30.0,
        "craft_item": 30.0,
        "smelt": 120.0,
        "smelt_item": 120.0,
        "place": 10.0,
        "give": 30.0,
        "equip": 5.0,
        "scan": 10.0,
        "scan_environment": 10.0,
        "pickup": 60.0,
        "find_location": 30.0,
        "patrol": 90.0,
        "retreat_safe": 30.0,
        "climb_to_surface": 60.0,
    }
    
    # 不接受 timeout 参数的动作
    NO_TIMEOUT_ACTIONS = {"scan", "chat", "look_around", "find_location", "scan_environment"}
    
    def __init__(self, registry: Optional[MetaActionRegistry] = None):
        """
        初始化分发器
        
        Args:
            registry: MetaAction 注册表 (可选，默认使用全局)
        """
        # 使用传入的注册表或全局注册表
        self._registry = registry if registry else MetaActionRegistry
    
    async def dispatch(
        self,
        action_name: str,
        params: Dict[str, Any],
        actions: "IBotActions",
    ) -> "ActionResult":
        """
        分发动作执行
        
        流程:
        1. 归一化 timeout 参数
        2. 尝试从 Registry 获取 MetaAction
        3. 如果找到，调用 action.execute()
        4. 否则 fallback 到 getattr(actions, action_name)
        
        Args:
            action_name: 动作名称 (如 "navigate", "smelt_item")
            params: 动作参数
            actions: 底层动作执行器
        
        Returns:
            ActionResult
        """
        from ..interfaces import ActionResult as AR, ActionStatus as AS
        
        # 复制参数避免修改原始数据
        params = dict(params) if params else {}
        
        # 归一化 timeout
        params = self._normalize_timeout(action_name, params)
        
        # 尝试 MetaAction
        meta_action = self._registry.get(action_name)
        if meta_action:
            logger.debug(f"[Dispatcher] Routing to MetaAction: {action_name}")
            try:
                # 过滤参数，仅传递 MetaAction 接受的参数
                filtered_params = self._filter_params_for_meta(meta_action, params)
                return await meta_action.execute(actions, **filtered_params)
            except Exception as e:
                logger.exception(f"[Dispatcher] MetaAction execution error: {e}")
                return AR(
                    success=False,
                    action=action_name,
                    message=str(e),
                    status=AS.FAILED,
                    error_code="META_ACTION_ERROR"
                )
        
        # Fallback 到 BotActions
        action_method = getattr(actions, action_name, None)
        if action_method is None:
            return AR(
                success=False,
                action=action_name,
                message=f"未知动作: {action_name}",
                status=AS.FAILED,
                error_code="UNKNOWN_ACTION"
            )
        
        logger.debug(f"[Dispatcher] Fallback to BotActions: {action_name}")
        
        # 过滤参数
        filtered_params = self._filter_params_for_method(action_method, params)
        
        try:
            result = await action_method(**filtered_params)
            
            # 标准化返回值
            if isinstance(result, bool):
                return AR(
                    success=result,
                    action=action_name,
                    message="ok" if result else "failed",
                    status=AS.SUCCESS if result else AS.FAILED,
                )
            if result is None:
                return AR(
                    success=False,
                    action=action_name,
                    message="empty result",
                    status=AS.FAILED,
                    error_code="EMPTY_RESULT"
                )
            return result
        
        except TypeError as e:
            logger.error(f"[Dispatcher] Parameter error: {e}")
            return AR(
                success=False,
                action=action_name,
                message=f"参数错误: {str(e)}",
                status=AS.FAILED,
                error_code="INVALID_PARAMS"
            )
        except Exception as e:
            logger.exception(f"[Dispatcher] Execution error: {e}")
            return AR(
                success=False,
                action=action_name,
                message=str(e),
                status=AS.FAILED,
                error_code="EXECUTION_ERROR"
            )
    
    def _normalize_timeout(
        self,
        action_name: str,
        params: Dict[str, Any]
    ) -> Dict[str, Any]:
        """归一化 timeout 参数"""
        # 处理 timeout_sec -> timeout
        if "timeout_sec" in params:
            params["timeout"] = params.pop("timeout_sec")
        
        # 添加默认 timeout
        if "timeout" not in params:
            params["timeout"] = self.DEFAULT_TIMEOUTS.get(action_name, 30.0)
        
        # 移除不需要 timeout 的动作的 timeout 参数
        if action_name in self.NO_TIMEOUT_ACTIONS and "timeout" in params:
            params.pop("timeout")
        
        return params
    
    def _filter_params_for_meta(
        self,
        meta_action,
        params: Dict[str, Any]
    ) -> Dict[str, Any]:
        """为 MetaAction 过滤参数"""
        # MetaAction.execute 使用 **kwargs，所以大部分参数都可以传递
        # 但我们仍然可以基于 parameters 属性做智能过滤
        accepted = set()
        for param_spec in meta_action.parameters:
            accepted.add(param_spec.name)
        
        # 总是允许的通用参数
        accepted.update({"timeout", "owner_position", "context"})
        
        # 如果 MetaAction 没有定义参数，传递所有参数
        if not meta_action.parameters:
            return params
        
        return {k: v for k, v in params.items() if k in accepted}
    
    def _filter_params_for_method(
        self,
        method,
        params: Dict[str, Any]
    ) -> Dict[str, Any]:
        """为 BotActions 方法过滤参数"""
        try:
            sig = inspect.signature(method)
            accepted = set(sig.parameters.keys())
            accepted.discard("self")
            
            # 检查是否有 **kwargs
            has_var_kw = any(
                p.kind == inspect.Parameter.VAR_KEYWORD
                for p in sig.parameters.values()
            )
            
            if has_var_kw:
                return params
            
            return {k: v for k, v in params.items() if k in accepted}
        except Exception:
            return params
