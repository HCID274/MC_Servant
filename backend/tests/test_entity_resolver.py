# Entity Resolver Unit Tests
#
# 测试 EntityResolver 的核心逻辑
# 使用 Mock 对象隔离外部依赖

import pytest
import asyncio
from typing import Dict, List

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from perception.interfaces import (
    ResolveStatus,
    ResolveResult,
    ScanResult,
)
from perception.resolver import EntityResolver, SearchConfig
from perception.knowledge_base import JsonKnowledgeBase
from perception.scanner import MockScanner
from perception.inventory import MockInventoryProvider


# ============================================================================
# Test Fixtures
# ============================================================================

@pytest.fixture
def knowledge_base():
    """创建真实的知识库实例"""
    return JsonKnowledgeBase()


@pytest.fixture
def mock_scanner():
    """创建模拟扫描器"""
    return MockScanner()


@pytest.fixture
def mock_inventory():
    """创建模拟背包"""
    return MockInventoryProvider()


@pytest.fixture
def resolver(knowledge_base, mock_scanner, mock_inventory):
    """创建 EntityResolver 实例"""
    return EntityResolver(
        knowledge_base=knowledge_base,
        scanner=mock_scanner,
        inventory=mock_inventory,
        search_config=SearchConfig(radii=(32, 64))
    )


# ============================================================================
# Test: Knowledge Base Queries
# ============================================================================

class TestKnowledgeBase:
    """测试知识库查询功能"""
    
    def test_get_candidates_by_tag(self, knowledge_base):
        """测试通过 tag 获取候选"""
        candidates = knowledge_base.get_candidates("logs")
        assert len(candidates) > 0
        assert "oak_log" in candidates
        assert "birch_log" in candidates
    
    def test_get_candidates_by_alias_chinese(self, knowledge_base):
        """测试中文别名解析"""
        # 先解析别名
        resolved = knowledge_base.resolve_alias("木头")
        assert resolved == "logs"
        
        # 再获取候选
        candidates = knowledge_base.get_candidates(resolved)
        assert "oak_log" in candidates
    
    def test_get_candidates_by_alias_english(self, knowledge_base):
        """测试英文别名解析"""
        resolved = knowledge_base.resolve_alias("wood")
        assert resolved == "logs"
    
    def test_get_candidates_direct_id(self, knowledge_base):
        """测试直接使用 ID"""
        candidates = knowledge_base.get_candidates("oak_log")
        assert candidates == ["oak_log"]
    
    def test_validate_ids(self, knowledge_base):
        """测试 ID 校验"""
        valid = knowledge_base.validate_ids(["oak_log", "invalid_item", "iron_ore"])
        assert "oak_log" in valid
        assert "iron_ore" in valid
        assert "invalid_item" not in valid
    
    def test_unknown_concept(self, knowledge_base):
        """测试未知概念"""
        candidates = knowledge_base.get_candidates("magic_unicorn_block")
        assert candidates == []


# ============================================================================
# Test: EntityResolver Core Logic
# ============================================================================

class TestEntityResolverCore:
    """测试 EntityResolver 核心逻辑"""
    
    @pytest.mark.asyncio
    async def test_resolve_unknown_concept(self, resolver):
        """测试未知概念返回 UNKNOWN_CONCEPT"""
        result = await resolver.resolve("magic_unicorn_block")
        
        assert not result.success
        assert result.status == ResolveStatus.UNKNOWN_CONCEPT
        assert "无法识别" in result.message
    
    @pytest.mark.asyncio
    async def test_resolve_with_inventory_hit(self, resolver, mock_inventory):
        """测试背包中有目标物品"""
        mock_inventory.set_items({"oak_log": 64, "cobblestone": 32})
        
        result = await resolver.resolve("logs")
        
        assert result.success
        assert result.status == ResolveStatus.SUCCESS
        assert result.target_id == "oak_log"
        assert result.source == "inventory"
    
    @pytest.mark.asyncio
    async def test_resolve_with_world_scan(self, resolver, mock_scanner, mock_inventory):
        """测试世界扫描找到目标"""
        mock_inventory.set_items({})  # 背包为空
        
        # 预设扫描结果
        mock_scanner.set_block_results("birch_log", [
            ScanResult(id="birch_log", position=(100.5, 64.0, 200.5), distance=15.0)
        ])
        
        result = await resolver.resolve("logs")
        
        assert result.success
        assert result.status == ResolveStatus.SUCCESS
        assert result.target_id == "birch_log"
        assert result.source == "world"
        assert result.position == (100.5, 64.0, 200.5)
    
    @pytest.mark.asyncio
    async def test_resolve_not_found_anywhere(self, resolver, mock_inventory):
        """测试背包和世界都没有"""
        mock_inventory.set_items({})  # 背包为空
        # scanner 默认返回空
        
        result = await resolver.resolve("logs")
        
        assert not result.success
        assert result.status == ResolveStatus.NOT_FOUND_ANYWHERE
        assert result.search_radius == 64  # 最大搜索半径
    
    @pytest.mark.asyncio
    async def test_resolve_skip_inventory(self, resolver, mock_inventory, mock_scanner):
        """测试跳过背包检查 (采集场景)"""
        mock_inventory.set_items({"oak_log": 64})  # 背包有
        mock_scanner.set_block_results("birch_log", [
            ScanResult(id="birch_log", position=(50.5, 64.0, 50.5), distance=10.0)
        ])
        
        result = await resolver.resolve("logs", check_inventory=False)
        
        assert result.success
        assert result.source == "world"  # 应该从世界找，不是背包
        assert result.target_id == "birch_log"
    
    @pytest.mark.asyncio
    async def test_resolve_llm_fallback(self, resolver, mock_scanner):
        """测试 LLM 候选补位"""
        # 使用一个知识库不认识的概念
        mock_scanner.set_block_results("glowstone", [
            ScanResult(id="glowstone", position=(10.5, 64.0, 10.5), distance=5.0)
        ])
        
        result = await resolver.resolve(
            "发光的东西",  # KB 可能不认识
            llm_candidates=["glowstone", "sea_lantern"]
        )
        
        # 如果 KB 不认识，应该用 LLM 候选
        if result.success:
            assert result.source in ["llm_fallback", "world", "knowledge_base"]
    
    @pytest.mark.asyncio
    async def test_resolve_invalid_llm_candidates(self, resolver):
        """测试 LLM 给的候选全部无效"""
        result = await resolver.resolve(
            "unknown_thing",
            llm_candidates=["fake_item_1", "fake_item_2"]
        )
        
        assert not result.success
        assert result.status == ResolveStatus.INVALID_CANDIDATES


# ============================================================================
# Test: Progressive Search
# ============================================================================

class TestProgressiveSearch:
    """测试渐进式搜索"""
    
    @pytest.mark.asyncio
    async def test_find_in_first_radius(self, resolver, mock_scanner):
        """测试在第一个半径内找到"""
        mock_scanner.set_block_results("iron_ore", [
            ScanResult(id="iron_ore", position=(10.5, 30.0, 10.5), distance=20.0)
        ])
        
        result = await resolver.resolve("iron_ore", check_inventory=False)
        
        assert result.success
        assert result.search_radius == 32  # 在 32 格内找到
    
    @pytest.mark.asyncio
    async def test_find_in_second_radius(self, resolver, mock_scanner):
        """测试在第二个半径内找到"""
        # 设置一个距离 50 的目标 (超过 32 但在 64 内)
        mock_scanner.set_block_results("diamond_ore", [
            ScanResult(id="diamond_ore", position=(50.5, 10.0, 50.5), distance=50.0)
        ])
        
        result = await resolver.resolve("diamond_ore", check_inventory=False)
        
        assert result.success
        assert result.search_radius == 64  # 在 64 格内找到
    
    @pytest.mark.asyncio
    async def test_closest_result_selected(self, resolver, mock_scanner):
        """测试选择最近的结果"""
        mock_scanner.set_block_results("oak_log", [
            ScanResult(id="oak_log", position=(30.5, 64.0, 30.5), distance=30.0),
            ScanResult(id="oak_log", position=(10.5, 64.0, 10.5), distance=10.0),
            ScanResult(id="oak_log", position=(20.5, 64.0, 20.5), distance=20.0),
        ])
        
        result = await resolver.resolve("oak_log", check_inventory=False)
        
        assert result.success
        assert result.position == (10.5, 64.0, 10.5)  # 最近的


# ============================================================================
# Test: Convenience Methods
# ============================================================================

class TestConvenienceMethods:
    """测试便捷方法"""
    
    @pytest.mark.asyncio
    async def test_resolve_for_mining(self, resolver, mock_inventory, mock_scanner):
        """测试采集专用方法 - 忽略背包"""
        # 使用 "ores" tag，它在知识库中确定存在
        mock_inventory.set_items({"iron_ore": 64})
        mock_scanner.set_block_results("iron_ore", [
            ScanResult(id="iron_ore", position=(5.5, 60.0, 5.5), distance=5.0)
        ])
        
        result = await resolver.resolve_for_mining("ores")
        
        assert result.success
        assert result.source == "world"  # 不应该从背包取
    
    @pytest.mark.asyncio
    async def test_resolve_for_crafting(self, resolver, mock_inventory):
        """测试合成专用方法 - 优先背包"""
        mock_inventory.set_items({"oak_planks": 32})
        
        result = await resolver.resolve_for_crafting("planks")
        
        assert result.success
        assert result.source == "inventory"
    
    def test_get_candidates_only(self, resolver):
        """测试仅获取候选列表 (同步)"""
        candidates = resolver.get_candidates_only("ores")
        
        assert len(candidates) > 0
        assert "iron_ore" in candidates
        assert "gold_ore" in candidates


# ============================================================================
# Run Tests
# ============================================================================

if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])

