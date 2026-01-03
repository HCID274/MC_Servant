# Actor Layer Unit Tests
#
# 测试 LLMTaskActor 和 ActorDecision 的核心逻辑
# 使用 Mock 对象隔离 LLM 依赖

import pytest
import asyncio
from typing import Dict, Any, List, Optional
from unittest.mock import AsyncMock, MagicMock

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from task.actor_interfaces import (
    ActorDecision,
    ActorActionType,
    ITaskActor,
)
from task.actor import LLMTaskActor


# ============================================================================
# Mock LLM Client
# ============================================================================

class MockLLMClient:
    """Mock LLM 客户端用于测试"""
    
    def __init__(self, responses: List[Dict[str, Any]] = None):
        """
        Args:
            responses: 预设的响应列表，按调用顺序返回
        """
        self._responses = responses or []
        self._call_count = 0
    
    async def chat_json(
        self,
        messages: List[Dict[str, str]],
        max_tokens: int = 256,
        temperature: float = 0.2,
    ) -> Dict[str, Any]:
        """模拟 LLM 响应"""
        if self._call_count < len(self._responses):
            response = self._responses[self._call_count]
            self._call_count += 1
            return response
        # 默认返回完成
        return {"action": "done", "params": {"message": "默认完成"}}
    
    def set_responses(self, responses: List[Dict[str, Any]]):
        """设置预设响应"""
        self._responses = responses
        self._call_count = 0


# ============================================================================
# Test: ActorDecision Data Class
# ============================================================================

class TestActorDecision:
    """测试 ActorDecision 数据类"""
    
    def test_basic_creation(self):
        """测试基本创建"""
        decision = ActorDecision(
            action="mine",
            target="logs",
            params={"count": 5}
        )
        assert decision.action == "mine"
        assert decision.target == "logs"
        assert decision.params["count"] == 5
    
    def test_is_done(self):
        """测试完成判断"""
        done = ActorDecision(action=ActorActionType.DONE, params={"message": "完成"})
        assert done.is_done
        assert not done.is_clarify
        
        not_done = ActorDecision(action="mine", target="logs")
        assert not not_done.is_done
    
    def test_is_clarify(self):
        """测试澄清判断"""
        clarify = ActorDecision(
            action=ActorActionType.CLARIFY,
            params={"question": "需要多少?", "choices": ["1", "5", "10"]}
        )
        assert clarify.is_clarify
        assert clarify.clarify_question == "需要多少?"
        assert clarify.clarify_choices == ["1", "5", "10"]
    
    def test_repr(self):
        """测试字符串表示"""
        decision = ActorDecision(action="mine", target="logs")
        repr_str = repr(decision)
        assert "mine" in repr_str
        assert "logs" in repr_str


# ============================================================================
# Test: LLMTaskActor
# ============================================================================

class TestLLMTaskActor:
    """测试 LLMTaskActor"""
    
    @pytest.fixture
    def mock_llm(self):
        """创建 Mock LLM 客户端"""
        return MockLLMClient()
    
    @pytest.fixture
    def actor(self, mock_llm):
        """创建 Actor 实例"""
        return LLMTaskActor(llm_client=mock_llm)
    
    @pytest.mark.asyncio
    async def test_decide_mine_action(self, actor, mock_llm):
        """测试采集决策"""
        mock_llm.set_responses([
            {"action": "mine", "target": "logs", "params": {"count": 5}, "reasoning": "需要木头"}
        ])
        
        decision = await actor.decide(
            task_goal="采集 5 个木头",
            bot_state={"position": {"x": 0, "y": 64, "z": 0}},
        )
        
        assert decision.action == "mine"
        assert decision.target == "logs"
        assert decision.params.get("count") == 5
    
    @pytest.mark.asyncio
    async def test_decide_done_action(self, actor, mock_llm):
        """测试完成决策"""
        mock_llm.set_responses([
            {"action": "done", "params": {"message": "采集完成！"}}
        ])
        
        decision = await actor.decide(
            task_goal="采集木头",
            bot_state={"inventory": {"oak_log": 10}},
        )
        
        assert decision.is_done
        assert "完成" in decision.params.get("message", "")
    
    @pytest.mark.asyncio
    async def test_decide_clarify_action(self, actor, mock_llm):
        """测试澄清决策"""
        mock_llm.set_responses([
            {
                "action": "clarify",
                "params": {
                    "question": "您想要哪种木头？",
                    "choices": ["橡木", "白桦木"],
                    "default": "橡木"
                }
            }
        ])
        
        decision = await actor.decide(
            task_goal="弄点东西",
            bot_state={},
        )
        
        assert decision.is_clarify
        assert "木头" in decision.clarify_question
        assert len(decision.clarify_choices) == 2
    
    @pytest.mark.asyncio
    async def test_decide_with_last_result(self, actor, mock_llm):
        """测试带 last_result 的决策"""
        mock_llm.set_responses([
            {"action": "scan", "target": "logs", "params": {"radius": 64}}
        ])
        
        last_result = {
            "action": "mine",
            "success": False,
            "error_code": "TARGET_NOT_FOUND",
            "message": "附近找不到目标"
        }
        
        decision = await actor.decide(
            task_goal="采集木头",
            bot_state={},
            last_result=last_result
        )
        
        assert decision.action == "scan"
    
    @pytest.mark.asyncio
    async def test_decide_fallback_on_error(self, actor, mock_llm):
        """测试错误时的回退"""
        # 模拟 LLM 返回无效响应
        mock_llm.set_responses([
            "invalid response"  # 不是 dict
        ])
        
        decision = await actor.decide(
            task_goal="测试",
            bot_state={},
        )
        
        # 应该返回默认的 scan 动作
        assert decision.action == ActorActionType.SCAN
    
    @pytest.mark.asyncio
    async def test_decide_with_owner_info(self, actor, mock_llm):
        """测试带主人信息的决策"""
        mock_llm.set_responses([
            {"action": "goto", "target": "owner"}
        ])
        
        bot_state = {
            "position": {"x": 0, "y": 64, "z": 0},
            "owner_name": "TestPlayer",
            "owner_position": {"x": 100, "y": 64, "z": 100}
        }
        
        decision = await actor.decide(
            task_goal="到主人身边",
            bot_state=bot_state,
        )
        
        assert decision.action == "goto"
        assert decision.target == "owner"


# ============================================================================
# Run Tests
# ============================================================================

if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
