# Action Resolver Unit Tests
#
# 测试 SemanticActionResolver 的语义落地逻辑
# 使用 Mock 对象隔离 KnowledgeBase 依赖

import pytest
import asyncio
from typing import Dict, Any, List, Optional

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from task.actor_interfaces import (
    ActorDecision,
    ActorActionType,
    GroundedAction,
)
from task.action_resolver import SemanticActionResolver, OWNER_ANCHOR_KEYWORDS
from task.interfaces import RunContext


# ============================================================================
# Mock Knowledge Base
# ============================================================================

class MockKnowledgeBase:
    """Mock 知识库用于测试"""
    
    def __init__(self):
        # 模拟标签 → 候选映射
        self._tags = {
            "logs": ["oak_log", "birch_log", "spruce_log", "jungle_log"],
            "planks": ["oak_planks", "birch_planks", "spruce_planks"],
            "ores": ["iron_ore", "gold_ore", "diamond_ore", "coal_ore"],
            "stones": ["stone", "cobblestone", "granite"],
        }
        
        # 模拟别名 → 标签映射
        self._aliases = {
            "木头": "logs",
            "wood": "logs",
            "原木": "logs",
            "木板": "planks",
            "矿石": "ores",
            "石头": "stones",
        }
        
        # 所有有效 ID
        self._valid_ids = set()
        for candidates in self._tags.values():
            self._valid_ids.update(candidates)
    
    def get_candidates(self, concept: str) -> List[str]:
        """获取候选列表"""
        # 优先从标签获取
        if concept in self._tags:
            return self._tags[concept].copy()
        # 如果是单个有效 ID
        if concept in self._valid_ids:
            return [concept]
        return []
    
    def resolve_alias(self, alias: str) -> str:
        """解析别名"""
        return self._aliases.get(alias, alias)
    
    def is_valid_id(self, item_id: str) -> bool:
        """检查 ID 是否有效"""
        return item_id in self._valid_ids


# ============================================================================
# Test Fixtures
# ============================================================================

@pytest.fixture
def mock_kb():
    """创建 Mock 知识库"""
    return MockKnowledgeBase()


@pytest.fixture
def resolver(mock_kb):
    """创建 ActionResolver 实例"""
    return SemanticActionResolver(knowledge_base=mock_kb)


@pytest.fixture
def context_with_owner():
    """创建带 owner 信息的上下文"""
    return RunContext(
        owner_name="TestPlayer",
        owner_position={"x": 100, "y": 64, "z": 200}
    )


@pytest.fixture
def context_without_owner():
    """创建无 owner 信息的上下文"""
    return RunContext()


# ============================================================================
# Test: Mine Action Resolution
# ============================================================================

class TestMineResolution:
    """测试 mine 动作解析"""
    
    @pytest.mark.asyncio
    async def test_mine_logs_becomes_mine_tree(self, resolver, context_without_owner):
        """测试 logs 目标变成 mine_tree"""
        decision = ActorDecision(
            action=ActorActionType.MINE,
            target="logs",
            params={"count": 5}
        )
        
        grounded = await resolver.resolve(decision, context_without_owner)
        
        assert grounded.action == "mine_tree"
        assert "砍树" in grounded.description
    
    @pytest.mark.asyncio
    async def test_mine_chinese_wood_becomes_mine_tree(self, resolver, context_without_owner):
        """测试中文 '木头' 变成 mine_tree"""
        decision = ActorDecision(
            action=ActorActionType.MINE,
            target="木头",
            params={}
        )
        
        grounded = await resolver.resolve(decision, context_without_owner)
        
        assert grounded.action == "mine_tree"
    
    @pytest.mark.asyncio
    async def test_mine_ore_stays_mine(self, resolver, context_without_owner):
        """测试矿石保持 mine"""
        decision = ActorDecision(
            action=ActorActionType.MINE,
            target="iron_ore",
            params={"count": 3}
        )
        
        grounded = await resolver.resolve(decision, context_without_owner)
        
        assert grounded.action == "mine"
        assert grounded.params["block_type"] == "iron_ore"
        assert grounded.params["count"] == 3
    
    @pytest.mark.asyncio
    async def test_mine_with_owner_anchor(self, resolver, context_with_owner):
        """测试带 owner 锚点的采集"""
        decision = ActorDecision(
            action=ActorActionType.MINE,
            target="我附近的木头",
            params={}
        )
        
        grounded = await resolver.resolve(decision, context_with_owner)
        
        assert grounded.action == "mine_tree"
        assert grounded.params.get("near_position") == {"x": 100, "y": 64, "z": 200}


# ============================================================================
# Test: Goto Action Resolution
# ============================================================================

class TestGotoResolution:
    """测试 goto 动作解析"""
    
    @pytest.mark.asyncio
    async def test_goto_owner(self, resolver, context_with_owner):
        """测试导航到主人"""
        decision = ActorDecision(
            action=ActorActionType.GOTO,
            target="owner"
        )
        
        grounded = await resolver.resolve(decision, context_with_owner)
        
        assert grounded.action == "goto"
        assert "100,64,200" in grounded.params["target"]
    
    @pytest.mark.asyncio
    async def test_goto_coords(self, resolver, context_without_owner):
        """测试导航到坐标"""
        decision = ActorDecision(
            action=ActorActionType.GOTO,
            target="50,70,50"
        )
        
        grounded = await resolver.resolve(decision, context_without_owner)
        
        assert grounded.action == "goto"
        assert grounded.params["target"] == "50,70,50"
    
    @pytest.mark.asyncio
    async def test_goto_player(self, resolver, context_without_owner):
        """测试导航到玩家"""
        decision = ActorDecision(
            action=ActorActionType.GOTO,
            target="SomePlayer"
        )
        
        grounded = await resolver.resolve(decision, context_without_owner)
        
        assert grounded.action == "goto"
        assert "@SomePlayer" in grounded.params["target"]


# ============================================================================
# Test: Special Actions
# ============================================================================

class TestSpecialActions:
    """测试特殊动作"""
    
    @pytest.mark.asyncio
    async def test_done_passthrough(self, resolver, context_without_owner):
        """测试完成动作透传"""
        decision = ActorDecision(
            action=ActorActionType.DONE,
            params={"message": "任务完成！"}
        )
        
        grounded = await resolver.resolve(decision, context_without_owner)
        
        assert grounded.action == "done"
        assert grounded.params["message"] == "任务完成！"
    
    @pytest.mark.asyncio
    async def test_clarify_passthrough(self, resolver, context_without_owner):
        """测试澄清动作透传"""
        decision = ActorDecision(
            action=ActorActionType.CLARIFY,
            params={"question": "需要多少?", "choices": ["1", "5"]}
        )
        
        grounded = await resolver.resolve(decision, context_without_owner)
        
        assert grounded.action == "clarify"
        assert "question" in grounded.params


# ============================================================================
# Test: Owner Anchor Keywords
# ============================================================================

class TestOwnerAnchorKeywords:
    """测试 owner 锚点关键词"""
    
    def test_chinese_keywords(self):
        """测试中文关键词"""
        keywords = OWNER_ANCHOR_KEYWORDS
        assert "我" in keywords
        assert "附近" in keywords
        assert "我这边" in keywords  # Fixed: actual keyword is "我这边" not "这边"
    
    def test_english_keywords(self):
        """测试英文关键词"""
        keywords = OWNER_ANCHOR_KEYWORDS
        assert "owner" in keywords
        assert "me" in keywords
        assert "player" in keywords


# ============================================================================
# Test: Craft and Give
# ============================================================================

class TestCraftAndGive:
    """测试合成和交付动作"""
    
    @pytest.mark.asyncio
    async def test_craft(self, resolver, context_without_owner):
        """测试合成"""
        decision = ActorDecision(
            action=ActorActionType.CRAFT,
            target="wooden_pickaxe",
            params={"count": 1}
        )
        
        grounded = await resolver.resolve(decision, context_without_owner)
        
        assert grounded.action == "craft"
        assert grounded.params["item_name"] == "wooden_pickaxe"
    
    @pytest.mark.asyncio
    async def test_give(self, resolver, context_with_owner):
        """测试交付"""
        decision = ActorDecision(
            action=ActorActionType.GIVE,
            target="oak_log",
            params={"count": 10}
        )
        
        grounded = await resolver.resolve(decision, context_with_owner)
        
        assert grounded.action == "give"
        assert grounded.params["player_name"] == "TestPlayer"
        assert grounded.params["item_name"] == "oak_log"
        assert grounded.params["count"] == 10


# ============================================================================
# Run Tests
# ============================================================================

if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
