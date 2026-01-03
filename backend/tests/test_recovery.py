# Test Recovery Coordinator
# 恢复协调器单元测试

import pytest
from dataclasses import dataclass
from typing import Optional

# Import from task module
import sys
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from task.recovery_interfaces import (
    IRecoveryCoordinator,
    RecoveryDecision,
    RecoveryLevel,
    RecoveryActionType,
    FailureContext,
)
from task.recovery_coordinator import RecoveryCoordinator, create_recovery_coordinator
from task.recovery_logger import JsonRecoveryLogger
from task.behavior_rules import BehaviorRules


# ============================================================================
# Mock Classes
# ============================================================================

@dataclass
class MockActionResult:
    """Mock ActionResult for testing"""
    success: bool
    action: str
    message: str = ""
    error_code: Optional[str] = None
    data: Optional[dict] = None
    
    @property
    def status(self):
        return "success" if self.success else "failed"


class MockBehaviorRules:
    """Mock BehaviorRules with configurable thresholds"""
    
    def __init__(
        self,
        max_action_retries_l1: int = 3,
        max_l1_failures_before_l2: int = 3
    ):
        self._max_action_retries_l1 = max_action_retries_l1
        self._max_l1_failures_before_l2 = max_l1_failures_before_l2
    
    @property
    def max_action_retries_l1(self) -> int:
        return self._max_action_retries_l1
    
    @property
    def max_l1_failures_before_l2(self) -> int:
        return self._max_l1_failures_before_l2


# ============================================================================
# Test Cases
# ============================================================================

class TestRecoveryCoordinator:
    """Test RecoveryCoordinator behavior"""
    
    def test_success_resets_counter(self):
        """成功结果应该重置连续失败计数器"""
        rules = MockBehaviorRules()
        coordinator = RecoveryCoordinator(rules)
        
        # 先失败几次
        fail_result = MockActionResult(success=False, action="mine", error_code="PATH_NOT_FOUND")
        coordinator.on_action_result(fail_result, tick=1)
        coordinator.on_action_result(fail_result, tick=2)
        
        assert coordinator.get_consecutive_failures() == 2
        
        # 成功后重置
        success_result = MockActionResult(success=True, action="mine")
        decision = coordinator.on_action_result(success_result, tick=3)
        
        assert coordinator.get_consecutive_failures() == 0
        assert decision.action_type == RecoveryActionType.NO_RECOVERY
        assert decision.should_retry is False
    
    def test_l1_retry_on_first_failure(self):
        """首次失败应该返回 L1 重试"""
        rules = MockBehaviorRules()
        coordinator = RecoveryCoordinator(rules)
        
        fail_result = MockActionResult(success=False, action="mine", error_code="PATH_NOT_FOUND")
        decision = coordinator.on_action_result(fail_result, tick=1)
        
        assert decision.level == RecoveryLevel.L1_ACTION_RETRY
        assert decision.action_type == RecoveryActionType.RETRY_SAME
        assert decision.should_retry is True
        assert decision.is_inline is True
    
    def test_l1_micro_move_on_second_failure(self):
        """第二次失败应该返回 L1 微移位"""
        rules = MockBehaviorRules()
        coordinator = RecoveryCoordinator(rules)
        
        fail_result = MockActionResult(success=False, action="mine", error_code="PATH_NOT_FOUND")
        
        # 第一次失败
        coordinator.on_action_result(fail_result, tick=1)
        
        # 第二次失败
        decision = coordinator.on_action_result(fail_result, tick=2)
        
        assert decision.level == RecoveryLevel.L1_ACTION_RETRY
        assert decision.action_type == RecoveryActionType.MICRO_MOVE
        assert decision.is_inline is True
    
    def test_l2_unstuck_after_threshold(self):
        """连续失败超过阈值后应该升级到 L2"""
        rules = MockBehaviorRules(max_l1_failures_before_l2=3)
        coordinator = RecoveryCoordinator(rules)
        
        fail_result = MockActionResult(success=False, action="mine", error_code="PATH_NOT_FOUND")
        
        # 连续失败 3 次
        for tick in range(1, 4):
            decision = coordinator.on_action_result(fail_result, tick=tick)
        
        # 第三次应该是 L2
        assert decision.level == RecoveryLevel.L2_UNSTUCK
        assert decision.action_type in [
            RecoveryActionType.UNSTUCK_BACKOFF,
            RecoveryActionType.UNSTUCK_STEP_UP
        ]
        assert decision.is_inline is True
    
    def test_l3_immediate_on_inventory_full(self):
        """INVENTORY_FULL 应该立即跳到 L3"""
        rules = MockBehaviorRules()
        coordinator = RecoveryCoordinator(rules)
        
        fail_result = MockActionResult(
            success=False,
            action="mine",
            error_code="INVENTORY_FULL"
        )
        decision = coordinator.on_action_result(fail_result, tick=1)
        
        assert decision.level == RecoveryLevel.L3_REPORT_BLOCK
        assert decision.action_type == RecoveryActionType.REPORT_AND_BLOCK
        assert decision.should_retry is False
    
    def test_l4_goto_owner_not_inline(self):
        """L4 goto_owner 应该是压栈执行 (is_inline=False)"""
        rules = MockBehaviorRules()
        coordinator = RecoveryCoordinator(rules)
        
        decision = coordinator.make_l4_decision(reason="超时")
        
        assert decision.level == RecoveryLevel.L4_TIMEOUT_FALLBACK
        assert decision.action_type == RecoveryActionType.GOTO_OWNER
        assert decision.is_inline is False
    
    def test_reset_clears_all_counters(self):
        """reset() 应该清除所有计数器"""
        rules = MockBehaviorRules()
        coordinator = RecoveryCoordinator(rules)
        
        fail_result = MockActionResult(success=False, action="mine", error_code="PATH_NOT_FOUND")
        coordinator.on_action_result(fail_result, tick=1)
        coordinator.on_action_result(fail_result, tick=2)
        
        assert coordinator.get_consecutive_failures() == 2
        
        coordinator.reset()
        
        assert coordinator.get_consecutive_failures() == 0


class TestRecoveryDecision:
    """Test RecoveryDecision data class"""
    
    def test_repr(self):
        """测试 repr 输出"""
        decision = RecoveryDecision(
            level=RecoveryLevel.L1_ACTION_RETRY,
            action_type=RecoveryActionType.MICRO_MOVE,
            is_inline=True,
            reason="test"
        )
        
        repr_str = repr(decision)
        assert "L1" in repr_str
        assert "micro_move" in repr_str
    
    def test_default_values(self):
        """测试默认值"""
        decision = RecoveryDecision(
            level=RecoveryLevel.L1_ACTION_RETRY,
            action_type=RecoveryActionType.RETRY_SAME
        )
        
        assert decision.should_retry is True
        assert decision.is_inline is True
        assert decision.params == {}
        assert decision.reason == ""


# ============================================================================
# Integration Tests
# ============================================================================

class TestRecoveryIntegration:
    """Integration tests with real BehaviorRules"""
    
    def test_with_real_behavior_rules(self):
        """使用真实的 BehaviorRules 测试"""
        try:
            rules = BehaviorRules()
            coordinator = create_recovery_coordinator(rules)
            
            fail_result = MockActionResult(
                success=False,
                action="mine",
                error_code="PATH_NOT_FOUND"
            )
            
            decision = coordinator.on_action_result(fail_result, tick=1)
            
            assert decision.level == RecoveryLevel.L1_ACTION_RETRY
            assert decision.should_retry is True
        except FileNotFoundError:
            # 测试环境可能没有 behavior_rules.json
            pytest.skip("behavior_rules.json not found in test environment")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
