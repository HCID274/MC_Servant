# Experience Repository - Task Experience Database
#
# 任务经验仓库 - RAG 检索的核心存储层
#
# 设计原则: 简单的接口，深度的功能；依赖于抽象，而非具体
#
# 特性:
# - 异步 CRUD 操作
# - 混合检索: 环境指纹过滤 + 向量相似度排序
# - 支持降级: 无 embedding 时使用关键词匹配

import logging
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import List, Optional, Dict, Any, TYPE_CHECKING

from sqlalchemy import select, update, text, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

if TYPE_CHECKING:
    from .database import DatabaseManager
    from ..llm.embedding import IEmbeddingService

logger = logging.getLogger(__name__)


# ============================================================================
# Environment Fingerprint (环境指纹)
# ============================================================================

@dataclass
class EnvironmentFingerprint:
    """
    环境指纹 - 用于记录和匹配经验的适用环境
    
    在 Minecraft 中，环境决定了策略的生死:
    - dimension: 主世界的导航逻辑在下界完全行不通
    - y_level_category: 铁矿在 Y=100 和 Y=15 的策略完全不同
    - tool_tier: 有钻石镐可以挖黑曜石，木镐只能挖石头
    - biome_tag: 沙漠没树，雪原水会结冰
    """
    dimension: str = "overworld"
    y_level_category: str = "surface"
    biome_tag: Optional[str] = None
    tool_tier: Optional[str] = None
    
    @classmethod
    def from_bot_state(cls, bot_state: Dict[str, Any]) -> "EnvironmentFingerprint":
        """
        从 Bot 状态提取环境指纹
        
        Args:
            bot_state: 包含 position, inventory, dimension, biome 等信息
        
        Returns:
            EnvironmentFingerprint 实例
        """
        # 1. 提取 Y 层级
        pos = bot_state.get("position", {})
        y = pos.get("y", 64)
        
        if y > 60:
            y_cat = "surface"
        elif y > 0:
            y_cat = "underground"
        else:
            y_cat = "deep_slate"
        
        # 2. 提取工具等级
        inventory = bot_state.get("inventory", {})
        tool_tier = cls._infer_tool_tier(inventory)
        
        # 3. 构建指纹
        return cls(
            dimension=bot_state.get("dimension", "overworld"),
            y_level_category=y_cat,
            biome_tag=bot_state.get("biome"),
            tool_tier=tool_tier,
        )
    
    @staticmethod
    def _infer_tool_tier(inventory: Dict[str, int]) -> Optional[str]:
        """
        从背包推断最高工具等级
        
        Returns:
            最高工具等级 (netherite > diamond > iron > stone > wooden) 或 None
        """
        tiers = ["netherite", "diamond", "iron", "stone", "wooden"]
        tool_keywords = ["pickaxe", "axe", "shovel", "sword", "hoe"]
        
        for tier in tiers:
            for item in inventory.keys():
                item_lower = item.lower()
                if tier in item_lower and any(tool in item_lower for tool in tool_keywords):
                    return tier
        return None
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典 (用于存储和比较)"""
        return {k: v for k, v in asdict(self).items() if v is not None}


# ============================================================================
# Experience Data Transfer Object
# ============================================================================

@dataclass
class ExperienceDTO:
    """
    经验数据传输对象
    
    用于 query() 返回结果，避免直接暴露 ORM 对象
    """
    id: str
    goal_text: str
    plan_trace: List[Dict[str, Any]]
    outcome: str
    completion_ratio: float
    efficiency_score: float
    dimension: str
    y_level_category: str
    biome_tag: Optional[str]
    tool_tier: Optional[str]
    duration_sec: float
    reuse_count: int
    created_at: datetime
    similarity_score: float = 0.0  # 向量相似度 (0.0 - 1.0)
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return asdict(self)


# ============================================================================
# Abstract Repository Interface
# ============================================================================

class IExperienceRepository(ABC):
    """
    任务经验仓库抽象接口
    
    设计原则: 
    - 简单的接口: save, query, update_usage
    - 深度的功能: 混合检索、环境过滤、相似度排序
    - 依赖于抽象: 不依赖具体的 embedding 实现
    """
    
    @abstractmethod
    async def save(
        self,
        goal_text: str,
        plan_trace: List[Dict[str, Any]],
        outcome: str,
        fingerprint: EnvironmentFingerprint,
        preconditions: Optional[Dict[str, Any]] = None,
        completion_ratio: float = 1.0,
        efficiency_score: float = 1.0,
        duration_sec: float = 0.0,
        parent_id: Optional[str] = None,
    ) -> str:
        """
        保存任务经验
        
        Args:
            goal_text: 任务目标文本 (如 "obtain 3 iron_ingot")
            plan_trace: 语义化执行步骤列表
            outcome: 结果状态 (success/partial/failed)
            fingerprint: 环境指纹
            preconditions: 前置条件 (可选)
            completion_ratio: 完成比例 (0.0 - 1.0)
            efficiency_score: 效率评分
            duration_sec: 执行耗时
            parent_id: 父经验ID (分层记录)
        
        Returns:
            experience_id: 新创建的经验ID
        """
        ...
    
    @abstractmethod
    async def query(
        self,
        goal_text: str,
        fingerprint: Optional[EnvironmentFingerprint] = None,
        top_k: int = 3,
        min_score: float = 0.5,
        outcome_filter: Optional[List[str]] = None,
    ) -> List[ExperienceDTO]:
        """
        语义检索相似经验
        
        检索策略 (混合检索):
        1. 环境指纹过滤: dimension 必须匹配
        2. 向量相似度排序: goal_embedding 余弦相似度
        3. 关键词降级: 无 embedding 时使用 ILIKE
        
        Args:
            goal_text: 查询目标文本
            fingerprint: 当前环境指纹 (用于过滤)
            top_k: 返回最多 K 条
            min_score: 最小相似度阈值
            outcome_filter: 结果状态过滤 (默认 ['success', 'partial'])
        
        Returns:
            按相似度降序排列的经验列表
        """
        ...
    
    @abstractmethod
    async def update_usage(self, experience_id: str) -> None:
        """
        更新使用统计
        
        在经验被复用时调用，更新:
        - reuse_count += 1
        - last_used_at = NOW()
        
        Args:
            experience_id: 经验ID
        """
        ...
    
    @abstractmethod
    async def get_by_id(self, experience_id: str) -> Optional[ExperienceDTO]:
        """
        根据 ID 获取单条经验
        
        Args:
            experience_id: 经验ID
        
        Returns:
            ExperienceDTO 或 None
        """
        ...


# ============================================================================
# PostgreSQL + pgvector Implementation
# ============================================================================

class PostgresExperienceRepository(IExperienceRepository):
    """
    PostgreSQL + pgvector 实现
    
    特性:
    - 使用 pgvector 进行高效向量检索
    - 支持 JSONB 前置条件过滤
    - 混合检索: 环境过滤 + 向量相似度
    - 降级策略: 无 embedding 时使用关键词匹配
    """
    
    def __init__(
        self,
        db_manager: "DatabaseManager",
        embedding_service: Optional["IEmbeddingService"] = None,
    ):
        """
        初始化 Repository
        
        Args:
            db_manager: 数据库管理器 (提供 session 上下文)
            embedding_service: Embedding 服务 (可选，无则降级到关键词)
        """
        self._db = db_manager
        self._embedding_service = embedding_service
    
    async def save(
        self,
        goal_text: str,
        plan_trace: List[Dict[str, Any]],
        outcome: str,
        fingerprint: EnvironmentFingerprint,
        preconditions: Optional[Dict[str, Any]] = None,
        completion_ratio: float = 1.0,
        efficiency_score: float = 1.0,
        duration_sec: float = 0.0,
        parent_id: Optional[str] = None,
    ) -> str:
        """保存任务经验"""
        
        # 1. 生成 embedding (如果服务可用)
        embedding = None
        if self._embedding_service:
            try:
                embedding = await self._embedding_service.embed(goal_text)
                logger.debug(f"[ExperienceRepo] Generated embedding for: {goal_text[:50]}...")
            except Exception as e:
                logger.warning(f"[ExperienceRepo] Failed to generate embedding: {e}")
        
        # 2. 准备 SQL 参数
        exp_id = str(uuid.uuid4())
        
        async with self._db.session() as session:
            # 使用原生 SQL 插入 (因为 goal_embedding 是 VECTOR 类型)
            if embedding:
                sql = text("""
                    INSERT INTO task_experiences (
                        id, goal_text, goal_embedding, preconditions, plan_trace,
                        outcome, completion_ratio, efficiency_score,
                        dimension, y_level_category, biome_tag, tool_tier,
                        duration_sec, parent_experience_id
                    ) VALUES (
                        :id, :goal_text, :embedding::vector, :preconditions::jsonb, :plan_trace::jsonb,
                        :outcome, :completion_ratio, :efficiency_score,
                        :dimension, :y_level_category, :biome_tag, :tool_tier,
                        :duration_sec, :parent_id
                    )
                """)
            else:
                sql = text("""
                    INSERT INTO task_experiences (
                        id, goal_text, preconditions, plan_trace,
                        outcome, completion_ratio, efficiency_score,
                        dimension, y_level_category, biome_tag, tool_tier,
                        duration_sec, parent_experience_id
                    ) VALUES (
                        :id, :goal_text, :preconditions::jsonb, :plan_trace::jsonb,
                        :outcome, :completion_ratio, :efficiency_score,
                        :dimension, :y_level_category, :biome_tag, :tool_tier,
                        :duration_sec, :parent_id
                    )
                """)
            
            import json
            params = {
                "id": exp_id,
                "goal_text": goal_text,
                "preconditions": json.dumps(preconditions or {}),
                "plan_trace": json.dumps(plan_trace),
                "outcome": outcome,
                "completion_ratio": completion_ratio,
                "efficiency_score": efficiency_score,
                "dimension": fingerprint.dimension,
                "y_level_category": fingerprint.y_level_category,
                "biome_tag": fingerprint.biome_tag,
                "tool_tier": fingerprint.tool_tier,
                "duration_sec": duration_sec,
                "parent_id": parent_id,
            }
            
            if embedding:
                # 将 embedding 转换为 pgvector 格式: [0.1, 0.2, ...]
                params["embedding"] = "[" + ",".join(str(x) for x in embedding) + "]"
            
            await session.execute(sql, params)
            await session.commit()
            
            logger.info(f"[ExperienceRepo] Saved experience: {exp_id} for goal: {goal_text[:50]}...")
            return exp_id
    
    async def query(
        self,
        goal_text: str,
        fingerprint: Optional[EnvironmentFingerprint] = None,
        top_k: int = 3,
        min_score: float = 0.5,
        outcome_filter: Optional[List[str]] = None,
    ) -> List[ExperienceDTO]:
        """
        混合检索相似经验
        
        策略:
        1. 环境指纹过滤 (dimension 必须匹配)
        2. 向量相似度排序 (使用余弦相似度)
        3. 关键词降级 (无 embedding 时使用 ILIKE)
        """
        
        if outcome_filter is None:
            outcome_filter = ["success", "partial"]
        
        async with self._db.session() as session:
            # 尝试向量检索
            if self._embedding_service:
                try:
                    return await self._query_by_vector(
                        session, goal_text, fingerprint, top_k, min_score, outcome_filter
                    )
                except Exception as e:
                    logger.warning(f"[ExperienceRepo] Vector query failed, falling back to keyword: {e}")
            
            # 降级到关键词检索
            return await self._query_by_keyword(
                session, goal_text, fingerprint, top_k, outcome_filter
            )
    
    async def _query_by_vector(
        self,
        session: AsyncSession,
        goal_text: str,
        fingerprint: Optional[EnvironmentFingerprint],
        top_k: int,
        min_score: float,
        outcome_filter: List[str],
    ) -> List[ExperienceDTO]:
        """向量相似度检索"""
        
        # 1. 生成查询向量
        query_embedding = await self._embedding_service.embed(goal_text)
        embedding_str = "[" + ",".join(str(x) for x in query_embedding) + "]"
        
        # 2. 构建 SQL
        # pgvector 使用 <=> 计算余弦距离 (越小越相似)
        # 相似度 = 1 - 距离
        base_sql = """
            SELECT 
                id, goal_text, plan_trace, outcome, completion_ratio, efficiency_score,
                dimension, y_level_category, biome_tag, tool_tier,
                duration_sec, reuse_count, created_at,
                1 - (goal_embedding <=> :embedding::vector) AS similarity
            FROM task_experiences
            WHERE 
                goal_embedding IS NOT NULL
                AND outcome = ANY(:outcomes)
        """
        
        # 添加环境过滤
        if fingerprint:
            base_sql += " AND dimension = :dimension"
        
        # 相似度过滤和排序
        base_sql += """
            AND (1 - (goal_embedding <=> :embedding::vector)) >= :min_score
            ORDER BY similarity DESC
            LIMIT :limit
        """
        
        params = {
            "embedding": embedding_str,
            "outcomes": outcome_filter,
            "min_score": min_score,
            "limit": top_k,
        }
        if fingerprint:
            params["dimension"] = fingerprint.dimension
        
        result = await session.execute(text(base_sql), params)
        rows = result.fetchall()
        
        # 3. 转换为 DTO
        experiences = []
        for row in rows:
            experiences.append(ExperienceDTO(
                id=str(row.id),
                goal_text=row.goal_text,
                plan_trace=row.plan_trace,
                outcome=row.outcome,
                completion_ratio=row.completion_ratio,
                efficiency_score=row.efficiency_score,
                dimension=row.dimension,
                y_level_category=row.y_level_category,
                biome_tag=row.biome_tag,
                tool_tier=row.tool_tier,
                duration_sec=row.duration_sec,
                reuse_count=row.reuse_count,
                created_at=row.created_at,
                similarity_score=float(row.similarity),
            ))
        
        logger.debug(f"[ExperienceRepo] Vector query found {len(experiences)} experiences")
        return experiences
    
    async def _query_by_keyword(
        self,
        session: AsyncSession,
        goal_text: str,
        fingerprint: Optional[EnvironmentFingerprint],
        top_k: int,
        outcome_filter: List[str],
    ) -> List[ExperienceDTO]:
        """关键词降级检索 (无 embedding 时使用)"""
        
        # 提取关键词 (简单分词)
        keywords = self._extract_keywords(goal_text)
        
        if not keywords:
            return []
        
        # 构建 ILIKE 条件
        like_conditions = " OR ".join([f"goal_text ILIKE :kw{i}" for i in range(len(keywords))])
        
        base_sql = f"""
            SELECT 
                id, goal_text, plan_trace, outcome, completion_ratio, efficiency_score,
                dimension, y_level_category, biome_tag, tool_tier,
                duration_sec, reuse_count, created_at
            FROM task_experiences
            WHERE 
                outcome = ANY(:outcomes)
                AND ({like_conditions})
        """
        
        if fingerprint:
            base_sql += " AND dimension = :dimension"
        
        base_sql += """
            ORDER BY reuse_count DESC, created_at DESC
            LIMIT :limit
        """
        
        params = {
            "outcomes": outcome_filter,
            "limit": top_k,
        }
        for i, kw in enumerate(keywords):
            params[f"kw{i}"] = f"%{kw}%"
        if fingerprint:
            params["dimension"] = fingerprint.dimension
        
        result = await session.execute(text(base_sql), params)
        rows = result.fetchall()
        
        experiences = []
        for row in rows:
            experiences.append(ExperienceDTO(
                id=str(row.id),
                goal_text=row.goal_text,
                plan_trace=row.plan_trace,
                outcome=row.outcome,
                completion_ratio=row.completion_ratio,
                efficiency_score=row.efficiency_score,
                dimension=row.dimension,
                y_level_category=row.y_level_category,
                biome_tag=row.biome_tag,
                tool_tier=row.tool_tier,
                duration_sec=row.duration_sec,
                reuse_count=row.reuse_count,
                created_at=row.created_at,
                similarity_score=0.5,  # 关键词匹配给固定分数
            ))
        
        logger.debug(f"[ExperienceRepo] Keyword query found {len(experiences)} experiences")
        return experiences
    
    def _extract_keywords(self, text: str) -> List[str]:
        """
        提取关键词 (简单实现)
        
        过滤停用词，保留有意义的词汇
        """
        stop_words = {
            "a", "an", "the", "to", "for", "of", "in", "on", "at", "is", "are",
            "我", "你", "的", "了", "和", "是", "在", "有", "个", "一", "这", "那",
            "帮", "请", "给", "把", "让", "能", "会", "要", "些", "点",
        }
        
        # 简单分词
        import re
        words = re.findall(r'\w+', text.lower())
        
        # 过滤
        keywords = [w for w in words if w not in stop_words and len(w) > 1]
        
        return keywords[:5]  # 最多 5 个关键词
    
    async def update_usage(self, experience_id: str) -> None:
        """更新使用统计"""
        
        async with self._db.session() as session:
            sql = text("""
                UPDATE task_experiences
                SET reuse_count = reuse_count + 1, last_used_at = NOW()
                WHERE id = :id
            """)
            await session.execute(sql, {"id": experience_id})
            await session.commit()
            
            logger.debug(f"[ExperienceRepo] Updated usage for: {experience_id}")
    
    async def get_by_id(self, experience_id: str) -> Optional[ExperienceDTO]:
        """根据 ID 获取单条经验"""
        
        async with self._db.session() as session:
            sql = text("""
                SELECT 
                    id, goal_text, plan_trace, outcome, completion_ratio, efficiency_score,
                    dimension, y_level_category, biome_tag, tool_tier,
                    duration_sec, reuse_count, created_at
                FROM task_experiences
                WHERE id = :id
            """)
            result = await session.execute(sql, {"id": experience_id})
            row = result.fetchone()
            
            if not row:
                return None
            
            return ExperienceDTO(
                id=str(row.id),
                goal_text=row.goal_text,
                plan_trace=row.plan_trace,
                outcome=row.outcome,
                completion_ratio=row.completion_ratio,
                efficiency_score=row.efficiency_score,
                dimension=row.dimension,
                y_level_category=row.y_level_category,
                biome_tag=row.biome_tag,
                tool_tier=row.tool_tier,
                duration_sec=row.duration_sec,
                reuse_count=row.reuse_count,
                created_at=row.created_at,
            )


# ============================================================================
# In-Memory Implementation (for Testing)
# ============================================================================

class InMemoryExperienceRepository(IExperienceRepository):
    """
    内存实现 (仅用于单元测试)
    
    不依赖数据库和 embedding 服务
    """
    
    def __init__(self):
        self._storage: Dict[str, Dict[str, Any]] = {}
        self._counter = 0
    
    async def save(
        self,
        goal_text: str,
        plan_trace: List[Dict[str, Any]],
        outcome: str,
        fingerprint: EnvironmentFingerprint,
        preconditions: Optional[Dict[str, Any]] = None,
        completion_ratio: float = 1.0,
        efficiency_score: float = 1.0,
        duration_sec: float = 0.0,
        parent_id: Optional[str] = None,
    ) -> str:
        exp_id = str(uuid.uuid4())
        self._storage[exp_id] = {
            "id": exp_id,
            "goal_text": goal_text,
            "plan_trace": plan_trace,
            "outcome": outcome,
            "preconditions": preconditions or {},
            "completion_ratio": completion_ratio,
            "efficiency_score": efficiency_score,
            "dimension": fingerprint.dimension,
            "y_level_category": fingerprint.y_level_category,
            "biome_tag": fingerprint.biome_tag,
            "tool_tier": fingerprint.tool_tier,
            "duration_sec": duration_sec,
            "reuse_count": 0,
            "created_at": datetime.now(),
            "parent_id": parent_id,
        }
        return exp_id
    
    async def query(
        self,
        goal_text: str,
        fingerprint: Optional[EnvironmentFingerprint] = None,
        top_k: int = 3,
        min_score: float = 0.5,
        outcome_filter: Optional[List[str]] = None,
    ) -> List[ExperienceDTO]:
        if outcome_filter is None:
            outcome_filter = ["success", "partial"]
        
        results = []
        goal_lower = goal_text.lower()
        
        for exp in self._storage.values():
            # 过滤 outcome
            if exp["outcome"] not in outcome_filter:
                continue
            
            # 过滤 dimension
            if fingerprint and exp["dimension"] != fingerprint.dimension:
                continue
            
            # 简单关键词匹配
            if any(kw in exp["goal_text"].lower() for kw in goal_lower.split()):
                results.append(ExperienceDTO(
                    id=exp["id"],
                    goal_text=exp["goal_text"],
                    plan_trace=exp["plan_trace"],
                    outcome=exp["outcome"],
                    completion_ratio=exp["completion_ratio"],
                    efficiency_score=exp["efficiency_score"],
                    dimension=exp["dimension"],
                    y_level_category=exp["y_level_category"],
                    biome_tag=exp["biome_tag"],
                    tool_tier=exp["tool_tier"],
                    duration_sec=exp["duration_sec"],
                    reuse_count=exp["reuse_count"],
                    created_at=exp["created_at"],
                    similarity_score=0.5,
                ))
        
        return results[:top_k]
    
    async def update_usage(self, experience_id: str) -> None:
        if experience_id in self._storage:
            self._storage[experience_id]["reuse_count"] += 1
    
    async def get_by_id(self, experience_id: str) -> Optional[ExperienceDTO]:
        exp = self._storage.get(experience_id)
        if not exp:
            return None
        return ExperienceDTO(
            id=exp["id"],
            goal_text=exp["goal_text"],
            plan_trace=exp["plan_trace"],
            outcome=exp["outcome"],
            completion_ratio=exp["completion_ratio"],
            efficiency_score=exp["efficiency_score"],
            dimension=exp["dimension"],
            y_level_category=exp["y_level_category"],
            biome_tag=exp["biome_tag"],
            tool_tier=exp["tool_tier"],
            duration_sec=exp["duration_sec"],
            reuse_count=exp["reuse_count"],
            created_at=exp["created_at"],
        )
