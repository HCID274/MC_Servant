# Recovery Logger Implementation
# 结构化 JSON 日志系统
#
# 设计原则：
# - 输出结构化 JSON，便于后续分析
# - 记录完整决策链路

import json
import logging
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Optional

from .recovery_interfaces import (
    IRecoveryLogger,
    RecoveryDecision,
    RecoveryActionType,
    FailureContext,
)

logger = logging.getLogger(__name__)


# ============================================================================
# Log Event Structures
# ============================================================================

@dataclass
class RecoveryLogEvent:
    """结构化恢复日志事件"""
    timestamp: str
    event_type: str  # "decision" | "execution"
    tick: int
    level: str
    action_type: str
    error_code: Optional[str] = None
    consecutive_failures: int = 0
    is_inline: bool = True
    should_retry: bool = True
    reason: str = ""
    params: dict = None
    success: Optional[bool] = None
    details: dict = None

    def __post_init__(self):
        if self.params is None:
            self.params = {}
        if self.details is None:
            self.details = {}


# ============================================================================
# Implementation
# ============================================================================

class JsonRecoveryLogger(IRecoveryLogger):
    """
    JSON 格式日志输出
    
    输出示例：
    {
        "timestamp": "2026-01-04T01:05:00",
        "event_type": "decision",
        "tick": 5,
        "level": "L1",
        "action_type": "micro_move",
        "error_code": "PATH_NOT_FOUND",
        "consecutive_failures": 2,
        "is_inline": true,
        "reason": "连续失败2次，执行微移位"
    }
    """
    
    def __init__(self, log_level: int = logging.INFO):
        self._log_level = log_level
    
    def log_recovery_decision(
        self,
        tick: int,
        decision: RecoveryDecision,
        context: FailureContext
    ) -> None:
        """记录恢复决策"""
        event = RecoveryLogEvent(
            timestamp=datetime.now().isoformat(),
            event_type="decision",
            tick=tick,
            level=decision.level.value,
            action_type=decision.action_type.value,
            error_code=context.error_code,
            consecutive_failures=context.consecutive_failures,
            is_inline=decision.is_inline,
            should_retry=decision.should_retry,
            reason=decision.reason,
            params=decision.params,
        )
        self._emit(event)
    
    def log_recovery_action_executed(
        self,
        tick: int,
        action_type: RecoveryActionType,
        success: bool,
        details: dict
    ) -> None:
        """记录恢复动作执行结果"""
        event = RecoveryLogEvent(
            timestamp=datetime.now().isoformat(),
            event_type="execution",
            tick=tick,
            level="",  # 执行阶段不关心级别
            action_type=action_type.value,
            success=success,
            details=details,
        )
        self._emit(event)
    
    def _emit(self, event: RecoveryLogEvent) -> None:
        """输出日志"""
        event_dict = asdict(event)
        # 移除 None 值
        event_dict = {k: v for k, v in event_dict.items() if v is not None}
        log_line = json.dumps(event_dict, ensure_ascii=False)
        logger.log(self._log_level, f"[RECOVERY] {log_line}")


# ============================================================================
# Factory
# ============================================================================

def create_recovery_logger() -> IRecoveryLogger:
    """创建默认的恢复日志器"""
    return JsonRecoveryLogger()
