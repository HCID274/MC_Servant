# Experience Retriever - RAG 检索层
#
# 经验检索器 - 从经验库中检索相似任务经验,注入 LLM Prompt
#
# 设计原则: 简单的接口，深度的功能；依赖于抽象，而非具体
#
# 特性:
# - 抽象接口 IExperienceRetriever
# - LRU 缓存层 (减少重复查询)
# - XML 格式化输出 (LLM 友好)

import asyncio
import hashlib
import logging
from abc import ABC, abstractmethod
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, Any, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..db.experience_repository import (
        IExperienceRepository, 
        ExperienceDTO, 
        EnvironmentFingerprint
    )

logger = logging.getLogger(__name__)


# ============================================================================
# Abstract Interface
# ============================================================================

class IExperienceRetriever(ABC):
    """
    经验检索器抽象接口
    
    简单的接口:
    - retrieve(): 检索相似经验
    - format_for_prompt(): 格式化为 Prompt 注入格式
    
    深度的功能:
    - 环境指纹过滤
    - 向量相似度排序
    - LRU 缓存
    """
    
    @abstractmethod
    async def retrieve(
        self, 
        goal: str, 
        bot_state: Dict[str, Any],
        top_k: int = 3,
        min_score: float = 0.5
    ) -> List["ExperienceDTO"]:
        """
        检索相似经验
        
        Args:
            goal: 任务目标文本 (如 "obtain 3 iron_ingot")
            bot_state: Bot 当前状态 (用于环境指纹)
            top_k: 返回前 K 条结果
            min_score: 最小相似度阈值
        
        Returns:
            相似经验列表 (按相似度降序)
        """
        ...
    
    @abstractmethod
    def format_for_prompt(self, experiences: List["ExperienceDTO"]) -> str:
        """
        将经验格式化为 Prompt 注入格式 (XML)
        
        Args:
            experiences: 经验列表
        
        Returns:
            XML 格式字符串
        """
        ...
    
    def clear_cache(self) -> None:
        """清空缓存 (可选实现)"""
        pass


# ============================================================================
# LRU Cache Implementation
# ============================================================================

@dataclass
class CacheEntry:
    """缓存条目"""
    experiences: List["ExperienceDTO"]
    timestamp: datetime = field(default_factory=datetime.now)
    hit_count: int = 0


class LRUCache:
    """
    LRU 缓存 - 用于减少重复检索
    
    缓存策略:
    - Key: hash(goal + dimension + y_level_category)
    - TTL: 5 分钟 (Minecraft 环境变化较快)
    - Max Size: 100 条
    """
    
    DEFAULT_MAX_SIZE = 100
    DEFAULT_TTL_SECONDS = 300  # 5 分钟
    
    def __init__(
        self, 
        max_size: int = DEFAULT_MAX_SIZE,
        ttl_seconds: int = DEFAULT_TTL_SECONDS
    ):
        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()
        self._max_size = max_size
        self._ttl_seconds = ttl_seconds
        self._stats = {"hits": 0, "misses": 0}
    
    def _compute_key(self, goal: str, fingerprint: Optional[Dict[str, Any]]) -> str:
        """计算缓存键"""
        key_parts = [goal.lower().strip()]
        if fingerprint:
            key_parts.append(fingerprint.get("dimension", ""))
            key_parts.append(fingerprint.get("y_level_category", ""))
        key_str = "|".join(key_parts)
        return hashlib.md5(key_str.encode()).hexdigest()
    
    def get(
        self, 
        goal: str, 
        fingerprint: Optional[Dict[str, Any]] = None
    ) -> Optional[List["ExperienceDTO"]]:
        """获取缓存"""
        if self._max_size <= 0 or self._ttl_seconds <= 0:
            self._stats["misses"] += 1
            return None
        key = self._compute_key(goal, fingerprint)
        
        if key not in self._cache:
            self._stats["misses"] += 1
            return None
        
        entry = self._cache[key]
        
        # 检查 TTL
        age = (datetime.now() - entry.timestamp).total_seconds()
        if age > self._ttl_seconds:
            del self._cache[key]
            self._stats["misses"] += 1
            return None
        
        # 更新 LRU 顺序
        self._cache.move_to_end(key)
        entry.hit_count += 1
        self._stats["hits"] += 1
        
        logger.debug(f"[RetrieverCache] HIT: {goal[:30]}... (age={age:.1f}s)")
        return entry.experiences
    
    def set(
        self, 
        goal: str, 
        fingerprint: Optional[Dict[str, Any]],
        experiences: List["ExperienceDTO"]
    ) -> None:
        """设置缓存"""
        if self._max_size <= 0 or self._ttl_seconds <= 0:
            return
        key = self._compute_key(goal, fingerprint)
        
        # 驱逐最老的条目
        while len(self._cache) >= self._max_size:
            oldest_key = next(iter(self._cache))
            del self._cache[oldest_key]
            logger.debug(f"[RetrieverCache] Evicted oldest entry")
        
        self._cache[key] = CacheEntry(experiences=experiences)
        logger.debug(f"[RetrieverCache] SET: {goal[:30]}... ({len(experiences)} experiences)")
    
    def clear(self) -> None:
        """清空缓存"""
        self._cache.clear()
        self._stats = {"hits": 0, "misses": 0}
        logger.info("[RetrieverCache] Cleared")
    
    @property
    def stats(self) -> Dict[str, int]:
        """获取统计信息"""
        total = self._stats["hits"] + self._stats["misses"]
        hit_rate = self._stats["hits"] / total if total > 0 else 0
        return {
            **self._stats,
            "size": len(self._cache),
            "hit_rate": f"{hit_rate:.1%}"
        }


# ============================================================================
# Postgres Implementation
# ============================================================================

class PostgresExperienceRetriever(IExperienceRetriever):
    """
    PostgreSQL 经验检索器
    
    特性:
    - 包装 IExperienceRepository.query()
    - LRU 缓存层
    - XML 格式化输出
    """
    
    def __init__(
        self, 
        repository: "IExperienceRepository",
        cache_max_size: int = LRUCache.DEFAULT_MAX_SIZE,
        cache_ttl_seconds: int = LRUCache.DEFAULT_TTL_SECONDS
    ):
        """
        初始化检索器
        
        Args:
            repository: 经验仓库实现
            cache_max_size: 缓存最大条目数
            cache_ttl_seconds: 缓存 TTL (秒)
        """
        self._repository = repository
        self._cache = LRUCache(
            max_size=cache_max_size,
            ttl_seconds=cache_ttl_seconds
        )
        logger.info(
            f"[ExperienceRetriever] Initialized with cache "
            f"(max={cache_max_size}, ttl={cache_ttl_seconds}s)"
        )
    
    async def retrieve(
        self, 
        goal: str, 
        bot_state: Dict[str, Any],
        top_k: int = 3,
        min_score: float = 0.5
    ) -> List["ExperienceDTO"]:
        """检索相似经验"""
        
        from db.experience_repository import EnvironmentFingerprint
        
        # 提取环境指纹
        fingerprint = EnvironmentFingerprint.from_bot_state(bot_state)
        fingerprint_dict = fingerprint.to_dict() if fingerprint else None
        
        # 检查缓存
        cached = self._cache.get(goal, fingerprint_dict)
        if cached is not None:
            return cached[:top_k]  # 缓存可能有更多结果
        
        # 查询数据库
        try:
            experiences = await self._repository.query(
                goal_text=goal,
                fingerprint=fingerprint,
                top_k=top_k,
                min_score=min_score,
                outcome_filter=["success", "partial"]  # 只检索成功/部分成功的经验
            )
            
            # 写入缓存
            self._cache.set(goal, fingerprint_dict, experiences)
            
            logger.info(
                f"[ExperienceRetriever] Retrieved {len(experiences)} experiences "
                f"for goal: {goal[:50]}..."
            )
            return experiences
            
        except Exception as e:
            logger.error(f"[ExperienceRetriever] Query failed: {e}")
            return []
    
    def format_for_prompt(self, experiences: List["ExperienceDTO"]) -> str:
        """将经验格式化为 XML"""
        
        if not experiences:
            return ""
        
        lines = ["<historical_experience>"]
        
        for exp in experiences:
            lines.append(
                f'  <case id="{exp.id}" outcome="{exp.outcome}" '
                f'similarity="{exp.similarity_score:.2f}">'
            )
            lines.append(f"    <goal>{self._escape_xml(exp.goal_text)}</goal>")
            
            # 格式化执行计划
            plan_steps = self._format_plan_trace(exp.plan_trace)
            if plan_steps:
                lines.append("    <successful_plan>")
                for i, step in enumerate(plan_steps, 1):
                    lines.append(f"      {i}. {step}")
                lines.append("    </successful_plan>")
            
            # 提取关键洞察
            insight = self._extract_key_insight(exp)
            if insight:
                lines.append(f"    <key_insight>{self._escape_xml(insight)}</key_insight>")
            
            # 环境信息
            if exp.dimension or exp.y_level_category:
                env_info = []
                if exp.dimension:
                    env_info.append(f"dimension={exp.dimension}")
                if exp.y_level_category:
                    env_info.append(f"y_level={exp.y_level_category}")
                if exp.tool_tier:
                    env_info.append(f"tool_tier={exp.tool_tier}")
                lines.append(f"    <environment>{', '.join(env_info)}</environment>")
            
            lines.append("  </case>")
        
        lines.append("</historical_experience>")
        
        return "\n".join(lines)
    
    def clear_cache(self) -> None:
        """清空缓存"""
        self._cache.clear()
    
    @property
    def cache_stats(self) -> Dict[str, Any]:
        """获取缓存统计"""
        return self._cache.stats
    
    # -------------------------------------------------------------------------
    # Private Helpers
    # -------------------------------------------------------------------------
    
    def _format_plan_trace(self, plan_trace: Optional[List[Dict[str, Any]]]) -> List[str]:
        """格式化执行轨迹为简洁步骤"""
        if not plan_trace:
            return []
        steps = []
        for item in plan_trace:
            action = item.get("action", "unknown")
            params = item.get("params", {})
            result = item.get("result", "")
            
            # 构建简洁描述
            param_str = ", ".join(f"{k}={v}" for k, v in params.items() if v)
            step = f"{action}({param_str})" if param_str else action
            
            if result:
                step += f" → {result}"
            
            steps.append(step)
        
        return steps
    
    def _extract_key_insight(self, exp: "ExperienceDTO") -> str:
        """从经验中提取关键洞察"""
        insights = []
        
        # 基于工具等级
        if exp.tool_tier:
            insights.append(f"Requires {exp.tool_tier} tier tools or better")
        
        # 基于效率
        if exp.efficiency_score < 0.5:
            insights.append("This approach was slow, consider alternatives")
        elif exp.efficiency_score > 1.5:
            insights.append("Highly efficient approach")
        
        # 基于完成度
        if exp.completion_ratio < 1.0:
            insights.append(f"Only {exp.completion_ratio:.0%} completed last time")
        
        return ". ".join(insights) if insights else ""
    
    def _escape_xml(self, text: str) -> str:
        """转义 XML 特殊字符"""
        if text is None:
            return ""
        if not isinstance(text, str):
            text = str(text)
        return (
            text
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
            .replace("'", "&apos;")
        )


# ============================================================================
# Cached Retriever Wrapper (可选装饰器模式)
# ============================================================================

class CachedExperienceRetriever(IExperienceRetriever):
    """
    缓存装饰器 - 为任意 Retriever 添加缓存能力
    
    用于无内置缓存的 Retriever 实现
    """
    
    def __init__(
        self, 
        inner: IExperienceRetriever,
        cache_max_size: int = 100,
        cache_ttl_seconds: int = 300
    ):
        self._inner = inner
        self._cache = LRUCache(cache_max_size, cache_ttl_seconds)
    
    async def retrieve(
        self, 
        goal: str, 
        bot_state: Dict[str, Any],
        top_k: int = 3,
        min_score: float = 0.5
    ) -> List["ExperienceDTO"]:
        from ..db.experience_repository import EnvironmentFingerprint
        
        fingerprint = EnvironmentFingerprint.from_bot_state(bot_state)
        fingerprint_dict = fingerprint.to_dict() if fingerprint else None
        
        cached = self._cache.get(goal, fingerprint_dict)
        if cached is not None:
            return cached[:top_k]
        
        experiences = await self._inner.retrieve(goal, bot_state, top_k, min_score)
        self._cache.set(goal, fingerprint_dict, experiences)
        return experiences
    
    def format_for_prompt(self, experiences: List["ExperienceDTO"]) -> str:
        return self._inner.format_for_prompt(experiences)
    
    def clear_cache(self) -> None:
        self._cache.clear()
        if hasattr(self._inner, 'clear_cache'):
            self._inner.clear_cache()


# ============================================================================
# Factory Function
# ============================================================================

def create_experience_retriever(
    repository: Optional["IExperienceRepository"] = None,
    cache_enabled: bool = True,
    cache_max_size: int = 100,
    cache_ttl_seconds: int = 300
) -> Optional[IExperienceRetriever]:
    """
    创建 ExperienceRetriever 实例
    
    Args:
        repository: 经验仓库实现
        cache_enabled: 是否启用缓存
        cache_max_size: 缓存最大条目数
        cache_ttl_seconds: 缓存 TTL (秒)
    
    Returns:
        IExperienceRetriever 实例或 None
    """
    if repository is None:
        logger.warning("[ExperienceRetriever] No repository provided, retriever disabled")
        return None
    
    try:
        retriever = PostgresExperienceRetriever(
            repository=repository,
            cache_max_size=cache_max_size if cache_enabled else 0,
            cache_ttl_seconds=cache_ttl_seconds if cache_enabled else 0
        )
        return retriever
    except Exception as e:
        logger.error(f"[ExperienceRetriever] Failed to create retriever: {e}")
        return None
