# Embedding Service - Text Vectorization
#
# 文本向量化服务 - 用于 RAG 语义检索
#
# 设计原则: 依赖于抽象，而非具体
#
# 实现:
# - IEmbeddingService: 抽象接口
# - DashScopeEmbeddingService: 阿里云 text-embedding-v4 实现

import logging
from abc import ABC, abstractmethod
from typing import List, Optional

import dashscope
from dashscope import TextEmbedding
from http import HTTPStatus

logger = logging.getLogger(__name__)


# ============================================================================
# Abstract Interface
# ============================================================================

class IEmbeddingService(ABC):
    """
    Embedding 服务抽象接口
    
    将文本转换为向量，用于语义相似度计算
    """
    
    @property
    @abstractmethod
    def dimension(self) -> int:
        """向量维度"""
        ...
    
    @abstractmethod
    async def embed(self, text: str) -> List[float]:
        """
        将单个文本转换为向量
        
        Args:
            text: 输入文本
        
        Returns:
            向量 (List[float])
        
        Raises:
            EmbeddingError: 生成失败
        """
        ...
    
    @abstractmethod
    async def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """
        批量将文本转换为向量
        
        Args:
            texts: 输入文本列表
        
        Returns:
            向量列表
        
        Raises:
            EmbeddingError: 生成失败
        """
        ...


class EmbeddingError(Exception):
    """Embedding 生成错误"""
    pass


# ============================================================================
# DashScope Implementation (阿里云 text-embedding-v4)
# ============================================================================

class DashScopeEmbeddingService(IEmbeddingService):
    """
    阿里云 DashScope text-embedding-v4 实现
    
    使用通义千问的 API Key (与 qwen-flash 共用)
    
    特性:
    - 1536 维向量 (与 OpenAI text-embedding-3-small 兼容)
    - 支持中英文双语
    - 批量处理优化
    
    Usage:
        service = DashScopeEmbeddingService(api_key=settings.openai_api_key)
        embedding = await service.embed("挖铁矿")
    """
    
    DIMENSION = 1536
    MODEL = "text-embedding-v4"
    
    def __init__(self, api_key: str):
        """
        初始化服务
        
        Args:
            api_key: DashScope API Key (格式: sk-xxxxxxxx)
        """
        if not api_key:
            raise ValueError("DashScope API key is required")
        
        dashscope.api_key = api_key
        self._api_key = api_key
        logger.info(f"[EmbeddingService] Initialized DashScope {self.MODEL} (dim={self.DIMENSION})")
    
    @property
    def dimension(self) -> int:
        return self.DIMENSION
    
    async def embed(self, text: str) -> List[float]:
        """将单个文本转换为向量"""
        
        if not text or not text.strip():
            raise EmbeddingError("Input text cannot be empty")
        
        try:
            # DashScope TextEmbedding 是同步 API，需要包装
            import asyncio
            loop = asyncio.get_event_loop()
            
            def _call_api():
                return TextEmbedding.call(
                    model=self.MODEL,
                    input=text.strip()
                )
            
            resp = await loop.run_in_executor(None, _call_api)
            
            if resp.status_code == HTTPStatus.OK:
                # 提取 embedding
                embedding = resp.output["embeddings"][0]["embedding"]
                logger.debug(f"[EmbeddingService] Generated embedding for: {text[:50]}... (dim={len(embedding)})")
                return embedding
            else:
                raise EmbeddingError(f"DashScope API error: {resp.code} - {resp.message}")
                
        except EmbeddingError:
            raise
        except Exception as e:
            logger.error(f"[EmbeddingService] Failed to generate embedding: {e}")
            raise EmbeddingError(f"Embedding generation failed: {e}")
    
    async def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """批量将文本转换为向量"""
        
        if not texts:
            return []
        
        # 过滤空文本
        valid_texts = [t.strip() for t in texts if t and t.strip()]
        if not valid_texts:
            raise EmbeddingError("All input texts are empty")
        
        try:
            import asyncio
            loop = asyncio.get_event_loop()
            
            def _call_api():
                return TextEmbedding.call(
                    model=self.MODEL,
                    input=valid_texts
                )
            
            resp = await loop.run_in_executor(None, _call_api)
            
            if resp.status_code == HTTPStatus.OK:
                embeddings = [
                    item["embedding"] 
                    for item in resp.output["embeddings"]
                ]
                logger.debug(f"[EmbeddingService] Generated {len(embeddings)} embeddings")
                return embeddings
            else:
                raise EmbeddingError(f"DashScope API error: {resp.code} - {resp.message}")
                
        except EmbeddingError:
            raise
        except Exception as e:
            logger.error(f"[EmbeddingService] Batch embedding failed: {e}")
            raise EmbeddingError(f"Batch embedding generation failed: {e}")


# ============================================================================
# Mock Implementation (for Testing)
# ============================================================================

class MockEmbeddingService(IEmbeddingService):
    """
    Mock 实现 (仅用于单元测试)
    
    生成固定的随机向量，不调用实际 API
    """
    
    DIMENSION = 1536
    
    def __init__(self, seed: int = 42):
        import random
        self._rng = random.Random(seed)
        logger.info("[EmbeddingService] Using MockEmbeddingService (for testing)")
    
    @property
    def dimension(self) -> int:
        return self.DIMENSION
    
    async def embed(self, text: str) -> List[float]:
        """生成基于文本 hash 的伪随机向量"""
        seed = hash(text) % (2**32)
        self._rng.seed(seed)
        return [self._rng.uniform(-1, 1) for _ in range(self.DIMENSION)]
    
    async def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """批量生成伪随机向量"""
        embeddings = []
        for text in texts:
            embeddings.append(await self.embed(text))
        return embeddings


# ============================================================================
# Factory Function
# ============================================================================

def create_embedding_service(api_key: Optional[str] = None) -> Optional[IEmbeddingService]:
    """
    创建 Embedding 服务实例
    
    如果没有提供 API Key，返回 None (降级模式)
    
    Args:
        api_key: DashScope API Key
    
    Returns:
        IEmbeddingService 实例或 None
    """
    if not api_key:
        logger.warning("[EmbeddingService] No API key provided, embedding disabled")
        return None
    
    try:
        return DashScopeEmbeddingService(api_key=api_key)
    except Exception as e:
        logger.error(f"[EmbeddingService] Failed to create service: {e}")
        return None
