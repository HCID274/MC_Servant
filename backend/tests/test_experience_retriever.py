# Test Experience Retriever
# 经验检索器单元测试

import pytest
import asyncio
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch
from typing import List

# 导入被测模块 (相对于 backend 目录)
from task.experience_retriever import (
    IExperienceRetriever,
    PostgresExperienceRetriever,
    LRUCache,
    CacheEntry,
    create_experience_retriever,
)


# ============================================================================
# Fixtures
# ============================================================================

@pytest.fixture
def mock_experience_dto():
    """创建 Mock ExperienceDTO"""
    from db.experience_repository import ExperienceDTO
    
    return ExperienceDTO(
        id="exp_test_123",
        goal_text="obtain 3 iron_ingot",
        plan_trace=[
            {"action": "scan", "params": {"target_type": "iron_ore"}, "result": "found"},
            {"action": "mine", "params": {"block_type": "iron_ore", "count": 3}, "result": "success"},
            {"action": "smelt", "params": {"item": "raw_iron"}, "result": "success"},
        ],
        outcome="success",
        completion_ratio=1.0,
        efficiency_score=1.2,
        dimension="overworld",
        y_level_category="underground",
        biome_tag="plains",
        tool_tier="iron",
        duration_sec=120.0,
        reuse_count=5,
        created_at=datetime.now(),
        similarity_score=0.92
    )


@pytest.fixture
def mock_repository(mock_experience_dto):
    """创建 Mock IExperienceRepository"""
    repo = AsyncMock()
    repo.query = AsyncMock(return_value=[mock_experience_dto])
    return repo


@pytest.fixture
def bot_state():
    """创建测试用 Bot 状态"""
    return {
        "position": {"x": 100, "y": 64, "z": 200},
        "dimension": "overworld",
        "inventory": {"iron_pickaxe": 1, "stone_pickaxe": 1},
        "health": 20,
        "biome": "plains"
    }


# ============================================================================
# LRU Cache Tests
# ============================================================================

class TestLRUCache:
    """LRU 缓存测试"""
    
    def test_cache_set_and_get(self, mock_experience_dto):
        """测试缓存写入和读取"""
        cache = LRUCache(max_size=10, ttl_seconds=300)
        
        experiences = [mock_experience_dto]
        cache.set("obtain iron", {"dimension": "overworld"}, experiences)
        
        result = cache.get("obtain iron", {"dimension": "overworld"})
        
        assert result is not None
        assert len(result) == 1
        assert result[0].id == "exp_test_123"
    
    def test_cache_miss(self):
        """测试缓存未命中"""
        cache = LRUCache(max_size=10, ttl_seconds=300)
        
        result = cache.get("unknown goal", None)
        
        assert result is None
        assert cache.stats["misses"] == 1
    
    def test_cache_ttl_expiry(self, mock_experience_dto):
        """测试缓存 TTL 过期"""
        cache = LRUCache(max_size=10, ttl_seconds=0)  # 立即过期
        
        experiences = [mock_experience_dto]
        cache.set("obtain iron", None, experiences)
        
        # 应该过期
        result = cache.get("obtain iron", None)
        assert result is None
    
    def test_cache_eviction(self, mock_experience_dto):
        """测试缓存驱逐"""
        cache = LRUCache(max_size=2, ttl_seconds=300)
        
        # 添加 3 个条目，应驱逐第 1 个
        cache.set("goal_1", None, [mock_experience_dto])
        cache.set("goal_2", None, [mock_experience_dto])
        cache.set("goal_3", None, [mock_experience_dto])
        
        assert cache.stats["size"] == 2
        assert cache.get("goal_1", None) is None  # 被驱逐
        assert cache.get("goal_2", None) is not None
        assert cache.get("goal_3", None) is not None
    
    def test_cache_clear(self, mock_experience_dto):
        """测试清空缓存"""
        cache = LRUCache(max_size=10, ttl_seconds=300)
        
        cache.set("goal", None, [mock_experience_dto])
        cache.clear()
        
        assert cache.stats["size"] == 0
        assert cache.get("goal", None) is None


# ============================================================================
# PostgresExperienceRetriever Tests
# ============================================================================

class TestPostgresExperienceRetriever:
    """PostgreSQL 经验检索器测试"""
    
    @pytest.mark.asyncio
    async def test_retrieve_with_matching_experience(
        self, mock_repository, bot_state, mock_experience_dto
    ):
        """测试检索到匹配经验"""
        retriever = PostgresExperienceRetriever(
            repository=mock_repository,
            cache_max_size=10,
            cache_ttl_seconds=300
        )
        
        results = await retriever.retrieve(
            goal="obtain iron ingot",
            bot_state=bot_state,
            top_k=3
        )
        
        assert len(results) == 1
        assert results[0].id == "exp_test_123"
        mock_repository.query.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_retrieve_no_match(self, bot_state):
        """测试无匹配经验"""
        repo = AsyncMock()
        repo.query = AsyncMock(return_value=[])
        
        retriever = PostgresExperienceRetriever(repository=repo)
        
        results = await retriever.retrieve(
            goal="build a castle",
            bot_state=bot_state
        )
        
        assert len(results) == 0
    
    @pytest.mark.asyncio
    async def test_retrieve_uses_cache(
        self, mock_repository, bot_state, mock_experience_dto
    ):
        """测试检索使用缓存"""
        retriever = PostgresExperienceRetriever(
            repository=mock_repository,
            cache_max_size=10,
            cache_ttl_seconds=300
        )
        
        # 第一次检索
        await retriever.retrieve("obtain iron", bot_state)
        
        # 第二次检索 (应使用缓存)
        await retriever.retrieve("obtain iron", bot_state)
        
        # Repository 应该只被调用一次
        assert mock_repository.query.call_count == 1
        assert retriever.cache_stats["hits"] == 1
    
    def test_format_for_prompt_xml(self, mock_repository, mock_experience_dto):
        """测试 XML 格式化输出"""
        retriever = PostgresExperienceRetriever(repository=mock_repository)
        
        xml_output = retriever.format_for_prompt([mock_experience_dto])
        
        assert "<historical_experience>" in xml_output
        assert "</historical_experience>" in xml_output
        assert '<case id="exp_test_123"' in xml_output
        assert 'outcome="success"' in xml_output
        assert "<goal>" in xml_output
        assert "<successful_plan>" in xml_output
    
    def test_format_for_prompt_empty(self, mock_repository):
        """测试空列表格式化"""
        retriever = PostgresExperienceRetriever(repository=mock_repository)
        
        xml_output = retriever.format_for_prompt([])
        
        assert xml_output == ""
    
    def test_format_escapes_xml_special_chars(self, mock_repository):
        """测试 XML 特殊字符转义"""
        from db.experience_repository import ExperienceDTO
        
        exp = ExperienceDTO(
            id="exp_special",
            goal_text="craft <item> & \"build\"",
            plan_trace=[],
            outcome="success",
            completion_ratio=1.0,
            efficiency_score=1.0,
            dimension="overworld",
            y_level_category="surface",
            biome_tag=None,
            tool_tier=None,
            duration_sec=0,
            reuse_count=0,
            created_at=datetime.now(),
            similarity_score=0.8
        )
        
        retriever = PostgresExperienceRetriever(repository=mock_repository)
        xml_output = retriever.format_for_prompt([exp])
        
        # 确保特殊字符被转义
        assert "&lt;item&gt;" in xml_output
        assert "&amp;" in xml_output
        assert "&quot;build&quot;" in xml_output


# ============================================================================
# Factory Function Tests
# ============================================================================

class TestCreateExperienceRetriever:
    """工厂函数测试"""
    
    def test_create_with_repository(self, mock_repository):
        """测试有 Repository 时创建成功"""
        retriever = create_experience_retriever(
            repository=mock_repository,
            cache_enabled=True
        )
        
        assert retriever is not None
        assert isinstance(retriever, IExperienceRetriever)
    
    def test_create_without_repository(self):
        """测试无 Repository 时返回 None"""
        retriever = create_experience_retriever(repository=None)
        
        assert retriever is None


# ============================================================================
# Integration Tests (需要数据库连接)
# ============================================================================

@pytest.mark.skip(reason="Integration test - requires database connection")
class TestExperienceRetrieverIntegration:
    """集成测试 - 需要真实数据库"""
    
    @pytest.mark.asyncio
    async def test_end_to_end_retrieve(self):
        """端到端检索测试"""
        # 需要配置真实的数据库连接
        pass
