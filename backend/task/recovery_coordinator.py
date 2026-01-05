# Recovery Coordinator Implementation
# 恢复协调器 - 消费 behavior_rules.json，输出恢复策略
#
# 核心职责：
# - 维护 consecutive_failure_count (按 Tick 计数)
# - 根据 error_code 匹配规则
# - 判断 L1→L2→L3→L4 升级

import logging
from typing import Optional, Set, TYPE_CHECKING

from .recovery_interfaces import (
    IRecoveryCoordinator,
    IRecoveryLogger,
    RecoveryDecision,
    RecoveryLevel,
    RecoveryActionType,
    FailureContext,
)
from .behavior_rules import BehaviorRules

if TYPE_CHECKING:
    from ..bot.interfaces import ActionResult

logger = logging.getLogger(__name__)


# ============================================================================
# Error Code Constants
# ============================================================================

# 直接跳到 L3 的错误码
L3_IMMEDIATE_ERRORS: Set[str] = {"INVENTORY_FULL"}

# 需要装备/合成的错误码
EQUIP_CRAFT_ERRORS: Set[str] = {"NO_TOOL", "TOOL_BROKEN"}


# ============================================================================
# RecoveryCoordinator Implementation
# ============================================================================

class RecoveryCoordinator(IRecoveryCoordinator):
    """
    恢复协调器
    
    消费 behavior_rules.json，根据 ActionResult 返回恢复策略
    
    计数器语义 (按 Tick 连续失败):
    - 任意 Action 成功 -> 重置为 0
    - 任意 Action 失败 -> +1
    - Count >= threshold -> 升级到 L2
    """
    
    def __init__(
        self,
        rules: BehaviorRules,
        recovery_logger: Optional[IRecoveryLogger] = None
    ):
        self._rules = rules
        self._logger = recovery_logger
        
        # 状态
        self._consecutive_failures = 0
        self._l1_retry_count = 0
        self._last_tick = -1
        self._last_error_code: Optional[str] = None
    
    def on_action_result(
        self,
        result: "ActionResult",
        tick: int
    ) -> RecoveryDecision:
        """
        处理动作结果，返回恢复决策
        
        决策流程：
        1. 成功 -> 重置计数器，返回 NO_RECOVERY
        2. 检查 L3 立即跳级错误 (INVENTORY_FULL)
        3. 检查是否需要升级到 L2 (连续失败超过阈值)
        4. 默认执行 L1 重试
        """
        # 1. 成功 -> 重置
        if result.success:
            self._reset_counters()
            return RecoveryDecision(
                level=RecoveryLevel.L0_SUCCESS,
                action_type=RecoveryActionType.NO_RECOVERY,
                should_retry=False,
                reason="动作成功，无需恢复"
            )
        
        # 2. 更新失败计数器
        self._update_failure_count(tick, result.error_code)
        
        # 构建上下文
        context = FailureContext(
            error_code=result.error_code,
            action_name=result.action,
            consecutive_failures=self._consecutive_failures,
            tick_count=tick,
        )
        
        # 3. 检查 L3 立即跳级
        if result.error_code in L3_IMMEDIATE_ERRORS:
            decision = self._make_l3_decision(result, context)
            self._log_decision(tick, decision, context)
            return decision
        
        # 4. 检查 L2 升级
        threshold = self._rules.max_l1_failures_before_l2
        if self._consecutive_failures >= threshold:
            decision = self._make_l2_decision(result, context)
            self._log_decision(tick, decision, context)
            return decision
        
        # 5. L1 重试
        decision = self._make_l1_decision(result, context)
        self._log_decision(tick, decision, context)
        return decision
    
    def reset(self) -> None:
        """重置状态"""
        self._reset_counters()
        logger.debug("[RecoveryCoordinator] State reset")
    
    def get_consecutive_failures(self) -> int:
        """获取当前连续失败次数"""
        return self._consecutive_failures
    
    # ========================================================================
    # Private Methods
    # ========================================================================
    
    def _reset_counters(self) -> None:
        """重置所有计数器"""
        self._consecutive_failures = 0
        self._l1_retry_count = 0
        self._last_error_code = None
    
    def _update_failure_count(self, tick: int, error_code: Optional[str]) -> None:
        """更新失败计数器"""
        self._consecutive_failures += 1
        self._last_error_code = error_code
        self._last_tick = tick
        logger.debug(
            f"[RecoveryCoordinator] Failure count updated: {self._consecutive_failures}, "
            f"error_code={error_code}"
        )
    
    def _make_l1_decision(
        self,
        result: "ActionResult",
        context: FailureContext
    ) -> RecoveryDecision:
        """
        L1 决策: 动作级重试
        
        策略选择:
        - 首次失败: retry_same
        - 连续失败: micro_move (换个位置再试)
        """
        max_retries = self._rules.max_action_retries_l1
        
        if self._l1_retry_count >= max_retries:
            # L1 重试次数用尽，但还没到 L2 阈值
            self._l1_retry_count = 0
            return RecoveryDecision(
                level=RecoveryLevel.L1_ACTION_RETRY,
                action_type=RecoveryActionType.MICRO_MOVE,
                should_retry=True,
                is_inline=True,
                params={"max_delta": 2},
                reason=f"L1 重试 {max_retries} 次后执行微移位"
            )
        
        self._l1_retry_count += 1
        
        # 首次失败直接重试，后续失败加微移位
        if self._l1_retry_count == 1:
            return RecoveryDecision(
                level=RecoveryLevel.L1_ACTION_RETRY,
                action_type=RecoveryActionType.RETRY_SAME,
                should_retry=True,
                is_inline=True,
                reason=f"L1 重试 #{self._l1_retry_count}"
            )
        else:
            return RecoveryDecision(
                level=RecoveryLevel.L1_ACTION_RETRY,
                action_type=RecoveryActionType.MICRO_MOVE,
                should_retry=True,
                is_inline=True,
                params={"max_delta": 1},
                reason=f"L1 重试 #{self._l1_retry_count}，附带微移位"
            )
    
    def _make_l2_decision(
        self,
        result: "ActionResult",
        context: FailureContext
    ) -> RecoveryDecision:
        """
        L2 决策: 脱困策略
        
        连续失败超过阈值，执行更激进的脱困
        """
        # 重置 L1 计数器
        self._l1_retry_count = 0
        
        # 选择脱困策略 (交替使用)
        if self._consecutive_failures % 2 == 0:
            action_type = RecoveryActionType.UNSTUCK_BACKOFF
            reason = "L2 脱困: 后退"
        else:
            action_type = RecoveryActionType.UNSTUCK_STEP_UP
            reason = "L2 脱困: 向上跳跃"
            
        # 🆕 增强: 如果之前的恢复动作失败，优先尝试爬向地面
        if result.error_code == "RECOVERY_FAILED":
             action_type = RecoveryActionType.CLIMB_TO_SURFACE
             reason = "L2 脱困: 基础恢复失败，尝试垂直爬向地面"
        
        return RecoveryDecision(
            level=RecoveryLevel.L2_UNSTUCK,
            action_type=action_type,
            should_retry=True,
            is_inline=True,  # 脱困动作仍然是内联的
            params={"backoff_distance": 3},
            reason=reason
        )
    
    def _make_l3_decision(
        self,
        result: "ActionResult",
        context: FailureContext
    ) -> RecoveryDecision:
        """
        L3 决策: 报告并阻塞
        
        需要主人介入才能解决的问题
        """
        reason_map = {
            "INVENTORY_FULL": "背包已满，等待主人处理",
        }
        reason = reason_map.get(result.error_code, f"遇到不可恢复错误: {result.error_code}")
        
        return RecoveryDecision(
            level=RecoveryLevel.L3_REPORT_BLOCK,
            action_type=RecoveryActionType.REPORT_AND_BLOCK,
            should_retry=False,
            is_inline=True,  # 报告是即时的
            reason=reason
        )
    
    def make_l4_decision(self, reason: str = "超时") -> RecoveryDecision:
        """
        L4 决策: 超时兜底
        
        回到主人身边待命 (外部调用，如超时检测)
        """
        return RecoveryDecision(
            level=RecoveryLevel.L4_TIMEOUT_FALLBACK,
            action_type=RecoveryActionType.GOTO_OWNER,
            should_retry=False,
            is_inline=False,  # 压栈执行
            reason=f"L4 兜底: {reason}"
        )
    
    def _log_decision(
        self,
        tick: int,
        decision: RecoveryDecision,
        context: FailureContext
    ) -> None:
        """记录决策日志"""
        if self._logger:
            self._logger.log_recovery_decision(tick, decision, context)


# ============================================================================
# Factory
# ============================================================================

def create_recovery_coordinator(
    rules: BehaviorRules,
    recovery_logger: Optional[IRecoveryLogger] = None
) -> IRecoveryCoordinator:
    """
    创建 RecoveryCoordinator 实例
    
    Args:
        rules: 行为规则配置
        recovery_logger: 可选的日志器
        
    Returns:
        配置好的 RecoveryCoordinator 实例
    """
    return RecoveryCoordinator(rules, recovery_logger)
