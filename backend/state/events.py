# Event Definitions
# 事件定义 - 驱动状态机流转的输入

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Optional


class EventType(str, Enum):
    """
    事件类型枚举
    
    分类：
    - 所有权相关：CLAIM, RELEASE
    - 任务相关：TASK_REQUEST, TASK_CONFIRM, TASK_COMPLETE, TASK_CANCEL, TASK_FAILED
    - 交互相关：CHAT, QUERY
    """
    # 所有权
    CLAIM = "claim"          # 认领 Bot
    RELEASE = "release"      # 释放 Bot（恢复无主状态）
    
    # 任务
    TASK_REQUEST = "task_request"    # 收到任务指令 (来自主人)
    TASK_CONFIRM = "task_confirm"    # 用户确认执行计划
    TASK_COMPLETE = "task_complete"  # 任务完成
    TASK_CANCEL = "task_cancel"      # 取消当前任务
    TASK_FAILED = "task_failed"      # 任务失败
    
    # 交互
    CHAT = "chat"            # 闲聊（不触发状态转换，触发回复）
    QUERY = "query"          # 查询状态（不触发状态转换）


@dataclass
class Event:
    """
    事件数据结构
    
    所有输入都被封装为事件，由状态机统一处理
    """
    type: EventType
    source_player: str                     # 发起事件的玩家名
    payload: Dict[str, Any] = field(default_factory=dict)  # 事件携带的数据
    timestamp: float = field(default_factory=time.time)    # 事件时间戳
    
    # 可选：玩家 UUID（用于权限校验）
    source_player_uuid: Optional[str] = None
    
    def __repr__(self) -> str:
        return f"Event({self.type.value}, player={self.source_player})"


# 意图到事件的映射
# 用于将 IntentRecognizer 的结果转换为状态机事件
INTENT_TO_EVENT_MAP = {
    "build": EventType.TASK_REQUEST,
    "mine": EventType.TASK_REQUEST,
    "farm": EventType.TASK_REQUEST,
    "guard": EventType.TASK_REQUEST,
    "chat": EventType.CHAT,
    "status": EventType.QUERY,
    "cancel": EventType.TASK_CANCEL,
}


def intent_to_event_type(intent: str) -> EventType:
    """
    将意图字符串转换为事件类型
    
    Args:
        intent: 意图识别结果 (如 "build", "chat")
        
    Returns:
        对应的 EventType
    """
    return INTENT_TO_EVENT_MAP.get(intent.lower(), EventType.CHAT)
