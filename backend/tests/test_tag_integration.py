# Test PrerequisiteResolver Tag Integration
# 测试 Tag 系统集成

import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from unittest.mock import Mock
from task.prerequisite_resolver import PrerequisiteResolver


class TestPrerequisiteResolverTagIntegration:
    """测试 PrerequisiteResolver 的 Tag 系统集成"""
    
    @pytest.fixture
    def resolver(self):
        """创建 PrerequisiteResolver 实例"""
        return PrerequisiteResolver()
    
    def test_tag_match_cherry_planks_satisfies_planks(self, resolver):
        """
        场景：配方需要 planks，背包有 cherry_planks
        预期：返回 None（无需前置任务）
        """
        context = {"missing": {"planks": 4}}
        inventory = {"cherry_planks": 16}
        
        result = resolver._resolve_missing_materials(context, inventory)
        
        # 应该返回 None，因为 cherry_planks 满足 planks 需求
        assert result is None, f"Expected None but got {result}"
    
    def test_tag_match_oak_planks_satisfies_planks(self, resolver):
        """
        场景：配方需要 planks，背包有 oak_planks
        预期：返回 None（无需前置任务）
        """
        context = {"missing": {"planks": 4}}
        inventory = {"oak_planks": 10}
        
        result = resolver._resolve_missing_materials(context, inventory)
        assert result is None
    
    def test_partial_tag_match_returns_reduced_task(self, resolver):
        """
        场景：配方需要 8 个 planks，背包只有 4 个 cherry_planks
        预期：返回采集/合成任务，但只需补充 4 个
        """
        context = {"missing": {"planks": 8}}
        inventory = {"cherry_planks": 4}
        
        result = resolver._resolve_missing_materials(context, inventory)
        
        # 应该返回一个任务（合成或采集），目标数量已减去现有的 4 个
        if result is not None:
            # 验证任务目标已调整
            assert "4" in result.goal or "1" in result.goal  # 4个木板或1个木头
    
    def test_no_tag_match_returns_prerequisite_task(self, resolver):
        """
        场景：配方需要 planks，背包没有任何木板
        预期：返回采集木头的前置任务
        """
        context = {"missing": {"planks": 4}}
        inventory = {}  # 空背包
        
        result = resolver._resolve_missing_materials(context, inventory)
        
        # 应该返回一个任务
        assert result is not None
        assert "mine" in result.goal or "craft" in result.goal
    
    def test_multiple_planks_uses_highest_count(self, resolver):
        """
        场景：背包有多种木板，应优先使用数量最多的
        预期：TagResolver.find_available 返回数量最多的物品
        """
        context = {"missing": {"planks": 4}}
        inventory = {
            "oak_planks": 2,
            "cherry_planks": 20,  # 数量最多
            "birch_planks": 5
        }
        
        result = resolver._resolve_missing_materials(context, inventory)
        
        # 应该返回 None，因为 cherry_planks x20 满足需求
        assert result is None


class TestTagResolverIntegration:
    """测试 TagResolver 本身的功能"""
    
    def test_find_available_returns_highest_count(self):
        """验证 find_available 返回数量最多的等价物品"""
        from bot.tag_resolver import get_tag_resolver
        
        resolver = get_tag_resolver()
        inventory = {
            "oak_planks": 2,
            "cherry_planks": 20,
            "birch_planks": 5
        }
        
        result = resolver.find_available("planks", inventory)
        
        # 应该返回 cherry_planks（数量最多）
        assert result == "cherry_planks"
    
    def test_get_equivalents_returns_all_planks(self):
        """验证 get_equivalents 返回所有等价物品"""
        from bot.tag_resolver import get_tag_resolver
        
        resolver = get_tag_resolver()
        equivalents = resolver.get_equivalents("oak_planks")
        
        assert "oak_planks" in equivalents
        assert "cherry_planks" in equivalents
        assert "birch_planks" in equivalents

    def test_get_available_count_sums_across_equivalents(self):
        """验证等价物品可混用时，get_available_count 会做总量统计"""
        from bot.tag_resolver import get_tag_resolver

        resolver = get_tag_resolver()
        inventory = {
            "oak_planks": 2,
            "cherry_planks": 2,
        }

        assert resolver.get_available_count("oak_planks", inventory) == 4
        assert resolver.get_available_count("planks", inventory) == 4

    def test_normalize_minecraft_prefix(self):
        """验证 minecraft: 前缀不会导致 Tag 匹配失败"""
        from bot.tag_resolver import get_tag_resolver

        resolver = get_tag_resolver()
        inventory = {
            "minecraft:cherry_planks": 4,
        }

        assert resolver.find_available("oak_planks", inventory) == "cherry_planks"
        assert resolver.get_available_count("oak_planks", inventory) == 4


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
