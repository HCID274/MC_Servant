# Recovery Logger Implementation
# 结构化 JSON 日志系统
#
# 设计原则：
# - 输出结构化 JSON，便于后续分析
# - 记录完整决策链路
# - 支持日志轮转，防止文件无限增长

import json
import logging
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Optional
from logging.handlers import RotatingFileHandler

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
    JSON 格式日志输出 (支持日志轮转)
    
    特性：
    - 输出到 Python 标准日志
    - 可选：写入独立 JSON 文件 (带轮转)
    
    日志轮转参数：
    - max_bytes: 单文件最大大小 (默认 5MB)
    - backup_count: 保留的备份文件数 (默认 3)
    
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
    
    def __init__(
        self, 
        log_level: int = logging.INFO,
        log_file: Optional[str] = None,
        max_bytes: int = 5 * 1024 * 1024,  # 5MB
        backup_count: int = 3
    ):
        """
        初始化日志器
        
        Args:
            log_level: Python 日志级别
            log_file: 可选的 JSON 日志文件路径
            max_bytes: 单个日志文件最大大小 (字节)
            backup_count: 保留的轮转备份数量
        """
        self._log_level = log_level
        self._file_handler: Optional[RotatingFileHandler] = None
        self._file_logger: Optional[logging.Logger] = None
        
        # 如果指定了日志文件，创建带轮转的文件处理器
        if log_file:
            self._setup_file_logger(log_file, max_bytes, backup_count)
    
    def _setup_file_logger(
        self, 
        log_file: str, 
        max_bytes: int, 
        backup_count: int
    ) -> None:
        """设置带轮转的文件日志器"""
        try:
            # 确保日志目录存在
            log_path = Path(log_file)
            log_path.parent.mkdir(parents=True, exist_ok=True)
            
            # 创建独立的 logger
            self._file_logger = logging.getLogger(f"recovery_json_{id(self)}")
            self._file_logger.setLevel(logging.DEBUG)
            self._file_logger.propagate = False  # 不传播到父 logger
            
            # 创建带轮转的文件处理器
            self._file_handler = RotatingFileHandler(
                log_file,
                maxBytes=max_bytes,
                backupCount=backup_count,
                encoding='utf-8'
            )
            self._file_handler.setLevel(logging.DEBUG)
            
            # 格式：纯 JSON，每行一条记录
            self._file_handler.setFormatter(logging.Formatter('%(message)s'))
            self._file_logger.addHandler(self._file_handler)
            
            logger.info(f"Recovery log file initialized: {log_file} (max={max_bytes/1024/1024:.1f}MB, backups={backup_count})")
        except Exception as e:
            logger.warning(f"Failed to setup file logger: {e}")
            self._file_logger = None
            self._file_handler = None
    
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
        
        # 输出到 Python 标准日志
        logger.log(self._log_level, f"[RECOVERY] {log_line}")
        
        # 如果有文件日志器，也写入文件
        if self._file_logger:
            self._file_logger.debug(log_line)
    
    def close(self) -> None:
        """关闭日志器，释放资源"""
        if self._file_handler:
            self._file_handler.close()
            self._file_handler = None
        if self._file_logger:
            self._file_logger.handlers.clear()
            self._file_logger = None


# ============================================================================
# Factory
# ============================================================================

def create_recovery_logger(
    log_file: Optional[str] = None,
    max_bytes: int = 5 * 1024 * 1024,
    backup_count: int = 3
) -> IRecoveryLogger:
    """
    创建恢复日志器
    
    Args:
        log_file: 可选的 JSON 日志文件路径 (启用轮转)
        max_bytes: 单文件最大大小 (默认 5MB)
        backup_count: 保留备份数 (默认 3)
    
    Returns:
        IRecoveryLogger 实例
    """
    return JsonRecoveryLogger(
        log_file=log_file,
        max_bytes=max_bytes,
        backup_count=backup_count
    )

