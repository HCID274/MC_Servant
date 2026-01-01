# Permission Gate
# 权限校验 - 管道模式实现

import logging
from typing import Dict, Tuple, Optional

from .events import Event, EventType
from .config import BotConfig
from .interfaces import IPermissionGate, PermissionResult

logger = logging.getLogger(__name__)


class PermissionGate(IPermissionGate):
    """
    权限校验器 - 管道/中间件模式
    
    在状态机处理事件之前进行权限检查，实现：
    - 单一职责：权限逻辑与状态逻辑分离
    - 防骚扰：路人无法干扰主人的任务
    """
    
    # 权限矩阵：(EventType, is_owner) -> is_allowed
    # 注意：这是基础矩阵，特殊情况在 check() 中额外处理
    PERMISSION_MATRIX: Dict[Tuple[EventType, bool], bool] = {
        # 认领/释放
        (EventType.CLAIM, True): True,      # 主人可以重新认领（无意义但允许）
        (EventType.CLAIM, False): True,     # 路人可认领 (仅当 Bot 无主时)
        (EventType.RELEASE, True): True,    # 只有主人能释放
        (EventType.RELEASE, False): False,
        
        # 任务相关 - 只有主人能操作
        (EventType.TASK_REQUEST, True): True,
        (EventType.TASK_REQUEST, False): False,
        (EventType.TASK_CONFIRM, True): True,
        (EventType.TASK_CONFIRM, False): False,
        (EventType.TASK_CANCEL, True): True,
        (EventType.TASK_CANCEL, False): False,
        
        # 任务完成/失败 - 系统事件，总是允许
        (EventType.TASK_COMPLETE, True): True,
        (EventType.TASK_COMPLETE, False): True,
        (EventType.TASK_FAILED, True): True,
        (EventType.TASK_FAILED, False): True,
        
        # 交互 - 所有人都能闲聊/查询
        (EventType.CHAT, True): True,
        (EventType.CHAT, False): True,
        (EventType.QUERY, True): True,
        (EventType.QUERY, False): True,
    }
    
    # 拒绝消息模板
    REJECTION_MESSAGES: Dict[EventType, str] = {
        EventType.CLAIM: "抱歉，我已经有主人了，不能被认领哦~",
        EventType.RELEASE: "只有主人才能释放我哦~",
        EventType.TASK_REQUEST: "抱歉，我只听从主人的安排，不能随便帮忙哦~",
        EventType.TASK_CONFIRM: "只有主人才能确认任务哦~",
        EventType.TASK_CANCEL: "只有主人才能取消任务哦~",
    }
    
    def check(
        self, 
        event: Event, 
        config: BotConfig,
        current_state: str
    ) -> PermissionResult:
        """
        检查事件是否被允许
        
        逻辑顺序：
        1. 特殊情况处理（如 CLAIM 需要检查 Bot 是否已有主）
        2. 查询权限矩阵
        3. 生成拒绝消息（如果不允许）
        
        Args:
            event: 输入事件
            config: Bot 配置
            current_state: 当前状态名称
            
        Returns:
            PermissionResult
        """
        # 判断是否是主人
        is_owner = config.is_owner(event.source_player_uuid)
        
        # 特殊情况 1: CLAIM 事件
        if event.type == EventType.CLAIM:
            return self._check_claim(event, config, is_owner)
        
        # 特殊情况 2: 无主 Bot 只响应 CLAIM 和 CHAT
        if not config.is_claimed:
            if event.type in (EventType.CLAIM, EventType.CHAT, EventType.QUERY):
                return PermissionResult(allowed=True)
            else:
                return PermissionResult(
                    allowed=False,
                    reason="Bot 尚未被认领",
                    rejection_message="请先认领我，才能下达指令哦~ 输入「认领」或右键点击我~",
                )
        
        # 查询权限矩阵
        key = (event.type, is_owner)
        allowed = self.PERMISSION_MATRIX.get(key, False)
        
        if allowed:
            return PermissionResult(allowed=True)
        else:
            rejection_msg = self.REJECTION_MESSAGES.get(
                event.type, 
                "抱歉，你没有权限执行这个操作哦~"
            )
            return PermissionResult(
                allowed=False,
                reason=f"Non-owner attempted {event.type.value}",
                rejection_message=rejection_msg,
            )
    
    def _check_claim(
        self, 
        event: Event, 
        config: BotConfig, 
        is_owner: bool
    ) -> PermissionResult:
        """
        检查 CLAIM 事件的权限
        
        特殊逻辑：
        - Bot 无主时，任何人都可以认领
        - Bot 有主时，只有主人可以"重新认领"（实际上无意义）
        - 路人不能抢走别人的女仆
        """
        if not config.is_claimed:
            # Bot 无主，允许认领
            return PermissionResult(allowed=True)
        
        if is_owner:
            # 主人重新认领（无意义但允许）
            return PermissionResult(
                allowed=True,
                reason="Owner re-claiming (no-op)",
            )
        
        # 路人尝试抢走有主的 Bot
        return PermissionResult(
            allowed=False,
            reason="Attempted to claim owned bot",
            rejection_message=f"抱歉，我已经是 {config.owner_name} 的女仆了，不能被认领哦~",
        )
