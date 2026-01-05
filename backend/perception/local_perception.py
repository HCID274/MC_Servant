# LocalPerception - 环境感知模块
# Phase 2: 扫描附近资源，为 LLM 提供上下文

"""
LocalPerception - 环境感知模块

设计原则：
- 简单接口：scan_nearby(radius) -> PerceptionSummary
- 深度功能：方块聚合、距离计算、Top-N 截断
- On-Demand Snapshot：每次 LLM 规划前调用一次

职责：
- 扫描 Bot 附近 N 格内的资源方块
- 返回压缩摘要（非原始坐标）
- 适合注入 Prompt
"""

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Protocol, TYPE_CHECKING

if TYPE_CHECKING:
    from ..bot.interfaces import IBotController

logger = logging.getLogger(__name__)


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class ResourceInfo:
    """单个资源的信息"""
    block_type: str          # 方块类型 (如 "cherry_log")
    count: int               # 数量
    nearest_distance: float  # 最近距离 (米)
    
    def to_natural_language(self) -> str:
        """转换为自然语言描述"""
        return f"{self.block_type}: {self.count} ({self.nearest_distance:.0f}m away)"


@dataclass  
class PerceptionSummary:
    """
    环境感知摘要 - 轻量级，适合注入 Prompt
    
    示例:
        nearby_resources: {"cherry_log": ResourceInfo(...), "oak_log": ResourceInfo(...)}
        nearby_entities: ["player", "cow"]
        position: {"x": 100, "y": 64, "z": 200}
    """
    position: Dict[str, float] = field(default_factory=dict)
    nearby_resources: Dict[str, ResourceInfo] = field(default_factory=dict)
    nearby_entities: List[str] = field(default_factory=list)
    scan_radius: int = 10
    
    def to_prompt_text(self, max_resources: int = 10) -> str:
        """
        转换为适合注入 Prompt 的文本
        
        Args:
            max_resources: 最多显示的资源数量 (Top-N)
        """
        lines = []
        
        # 位置
        if self.position:
            pos = self.position
            lines.append(f"Position: ({pos.get('x', 0):.0f}, {pos.get('y', 0):.0f}, {pos.get('z', 0):.0f})")
        
        # 附近资源 (按数量排序，取 Top-N)
        if self.nearby_resources:
            sorted_resources = sorted(
                self.nearby_resources.values(),
                key=lambda r: r.count,
                reverse=True
            )[:max_resources]
            
            resource_strs = [r.to_natural_language() for r in sorted_resources]
            lines.append(f"Nearby resources ({self.scan_radius}m): {', '.join(resource_strs)}")
        else:
            lines.append(f"Nearby resources ({self.scan_radius}m): None")
        
        # 附近实体
        if self.nearby_entities:
            lines.append(f"Nearby entities: {', '.join(self.nearby_entities[:5])}")
        
        return "\n".join(lines)
    
    def to_dict(self) -> dict:
        """转换为字典，用于注入 bot_state"""
        return {
            "position": self.position,
            "nearby_resources": {
                k: {"count": v.count, "distance": v.nearest_distance}
                for k, v in self.nearby_resources.items()
            },
            "nearby_entities": self.nearby_entities,
            "scan_radius": self.scan_radius,
        }


# ============================================================================
# Interface
# ============================================================================

class ILocalPerception(Protocol):
    """环境感知接口"""
    
    async def scan_nearby(self, radius: int = 10) -> PerceptionSummary:
        """
        扫描附近环境，返回结构化摘要
        
        Args:
            radius: 扫描半径 (格)
            
        Returns:
            PerceptionSummary: 环境摘要
        """
        ...


# ============================================================================
# Default Resource Types to Scan
# ============================================================================

# 常用资源方块 - 用于 JS 侧扫描
DEFAULT_RESOURCE_BLOCKS = [
    # 原木
    "oak_log", "birch_log", "spruce_log", "jungle_log",
    "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log",
    "crimson_stem", "warped_stem",
    # 矿石
    "stone", "cobblestone", "coal_ore", "iron_ore", "gold_ore", 
    "diamond_ore", "copper_ore", "redstone_ore",
    # 工作站
    "crafting_table", "furnace", "chest",
    # 其他
    "water", "sand", "gravel", "clay",
]
