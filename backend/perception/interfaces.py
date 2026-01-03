# Perception Interfaces - 感知系统抽象接口
#
# 设计原则:
# - IScanner: async (IO 密集型，可能涉及 executor)
# - IKnowledgeBase: sync (内存字典查询，极快)
# - IInventoryProvider: sync (内存数据，无网络 IO)

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional, Dict, Any, Tuple


# ============================================================================
# Data Structures
# ============================================================================

class ResolveStatus(Enum):
    """解析状态枚举 - 区分不同的失败原因，供上层规划器决策"""
    
    SUCCESS = "success"
    """成功找到目标"""
    
    UNKNOWN_CONCEPT = "unknown_concept"
    """知识库和 LLM 都不认识这个概念 -> 询问用户"""
    
    INVALID_CANDIDATES = "invalid_candidates"
    """LLM 给的候选 ID 全部不合法 -> 重新询问 LLM"""
    
    NOT_FOUND_IN_WORLD = "not_found_in_world"
    """知道是什么，但世界里找不到 -> 扩大搜索 / 移动到新区域"""
    
    NOT_FOUND_IN_INVENTORY = "not_found_in_inventory"
    """背包里没有 -> 去采集 / 去箱子找"""
    
    NOT_FOUND_ANYWHERE = "not_found_anywhere"
    """世界和背包都没有"""


@dataclass
class ScanResult:
    """
    扫描结果 - 单个目标的信息
    
    设计决策:
    - position 统一使用 float (Block 转为中心点坐标)
    - metadata 字典存储类型特定的额外信息
    """
    
    id: str
    """归一化 ID (如 "oak_log", "zombie")"""
    
    position: Tuple[float, float, float]
    """坐标 (Block 使用中心点: x+0.5, y, z+0.5)"""
    
    distance: float
    """距离 Bot 的距离"""
    
    metadata: Dict[str, Any] = field(default_factory=dict)
    """
    元数据字典，存储类型特定的信息:
    - Block: {"block_state": {...}, "hardness": 2.0}
    - Entity: {"health": 20, "type": "mob", "equipment": {...}}
    """


@dataclass
class ResolveResult:
    """
    解析结果 - EntityResolver.resolve() 的返回值
    
    设计决策:
    - 被动反馈: 只返回状态，不主动发消息
    - message 字段包含建议性文本，由上层决定是否发送给玩家
    """
    
    success: bool
    """是否成功找到目标"""
    
    status: ResolveStatus
    """详细状态，供上层规划器差异化决策"""
    
    target_id: Optional[str] = None
    """最终确定的 Minecraft ID (如 "birch_log")"""
    
    source: str = ""
    """
    结果来源:
    - "knowledge_base": 从知识库 Tag 查询
    - "llm_fallback": LLM 补位的候选
    - "inventory": 背包中找到
    - "world": 世界扫描找到
    """
    
    position: Optional[Tuple[float, float, float]] = None
    """找到的位置 (如果是世界扫描)"""
    
    candidates_tried: List[str] = field(default_factory=list)
    """尝试过的候选 ID 列表"""
    
    search_radius: int = 0
    """最终搜索半径"""
    
    message: str = ""
    """人类可读的描述/建议 (供上层决定是否发送给玩家)"""


# ============================================================================
# Abstract Interfaces
# ============================================================================

class IKnowledgeBase(ABC):
    """
    知识库抽象接口 - 静态语义知识查询
    
    设计决策:
    - 所有方法都是 同步 (sync)，因为是内存字典查询
    - 不涉及 IO 操作
    
    职责:
    - 语义概念 → 候选 ID 列表
    - 别名解析
    - ID 合法性校验
    """
    
    @abstractmethod
    def get_candidates(self, concept: str) -> List[str]:
        """
        获取概念对应的候选 ID 列表
        
        Args:
            concept: 语义概念 (如 "wood", "logs", "light_source")
            
        Returns:
            候选 ID 列表 (如 ["oak_log", "birch_log", ...])
            如果概念不存在，返回空列表
        """
        pass
    
    @abstractmethod
    def resolve_alias(self, alias: str) -> str:
        """
        解析别名到标准概念名
        
        Args:
            alias: 可能是别名的输入 (如 "木头", "wood", "timber")
            
        Returns:
            标准概念名 (如 "logs")
            如果不是别名，返回原值
        """
        pass
    
    @abstractmethod
    def validate_ids(self, ids: List[str]) -> List[str]:
        """
        校验 ID 列表的合法性
        
        Args:
            ids: 待校验的 ID 列表 (可能来自 LLM)
            
        Returns:
            合法的 ID 列表 (过滤掉不存在的 ID)
        """
        pass
    
    @abstractmethod
    def is_valid_id(self, item_id: str) -> bool:
        """
        检查单个 ID 是否合法
        
        Args:
            item_id: Minecraft 物品/方块 ID
            
        Returns:
            是否在知识库中存在
        """
        pass
    
    def reload(self) -> None:
        """
        重新加载知识库 (预留方法)
        
        Phase 1 实现: 简单重新加载内存 Dict
        不处理并发安全性 (KISS 原则)
        """
        pass


class IScanner(ABC):
    """
    世界扫描器抽象接口 - 环境感知
    
    设计决策:
    - 所有方法都是 异步 (async)，因为可能涉及 executor 或未来的寻路计算
    - 分离 scan_blocks 和 scan_entities，因为底层数据结构差异大
    
    职责:
    - 扫描世界中的方块/实体
    - 返回符合条件的目标列表
    """
    
    @abstractmethod
    async def scan_blocks(
        self, 
        block_ids: List[str], 
        radius: int = 32
    ) -> List[ScanResult]:
        """
        扫描指定类型的方块
        
        Args:
            block_ids: 目标方块 ID 列表 (如 ["oak_log", "birch_log"])
            radius: 扫描半径 (格)
            
        Returns:
            扫描结果列表，按距离排序
            Block 坐标转为中心点 (x+0.5, y, z+0.5)
        """
        pass
    
    @abstractmethod
    async def scan_entities(
        self, 
        entity_types: List[str], 
        radius: int = 32
    ) -> List[ScanResult]:
        """
        扫描指定类型的实体
        
        Args:
            entity_types: 目标实体类型列表 (如 ["zombie", "skeleton", "pig"])
            radius: 扫描半径 (格)
            
        Returns:
            扫描结果列表，按距离排序
        """
        pass
    
    def get_closest(self, results: List[ScanResult]) -> Optional[ScanResult]:
        """
        获取最近的扫描结果
        
        Args:
            results: 扫描结果列表
            
        Returns:
            距离最近的结果，如果列表为空返回 None
        """
        if not results:
            return None
        return min(results, key=lambda r: r.distance)


class IInventoryProvider(ABC):
    """
    背包查询接口 - 背包感知
    
    设计决策:
    - 所有方法都是 同步 (sync)，因为背包数据在内存中
    - 与 IScanner 分离，保持单一职责
    
    职责:
    - 查询背包内容
    - 检查物品是否存在
    """
    
    @abstractmethod
    def get_items(self) -> Dict[str, int]:
        """
        获取背包物品摘要
        
        Returns:
            {item_id: count} 字典 (合并同类项)
            如 {"oak_log": 64, "cobblestone": 128}
        """
        pass
    
    @abstractmethod
    def has_item(self, item_id: str, min_count: int = 1) -> bool:
        """
        检查背包是否有指定物品
        
        Args:
            item_id: 物品 ID
            min_count: 最少数量 (默认 1)
            
        Returns:
            是否有足够数量的物品
        """
        pass
    
    @abstractmethod
    def get_item_count(self, item_id: str) -> int:
        """
        获取指定物品的数量
        
        Args:
            item_id: 物品 ID
            
        Returns:
            物品数量，没有则返回 0
        """
        pass

