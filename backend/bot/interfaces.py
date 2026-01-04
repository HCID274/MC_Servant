# Bot Controller Interfaces

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Tuple, Optional, Any, List
from enum import Enum


# ============================================================================
# Action System - Bot 动作执行能力 (Layer 2)
# ============================================================================

class ActionStatus(Enum):
    """动作执行状态"""
    SUCCESS = "success"
    FAILED = "failed"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"


@dataclass
class ActionResult:
    """
    动作执行结果 - 统一的反馈结构
    
    所有动作都必须返回此结构，供 LLM 反思决策
    
    Attributes:
        success: 是否成功
        action: 执行的动作名
        message: 人类可读的描述
        status: 状态枚举
        data: 返回数据 (格式由具体动作定义)
        error_code: 错误码
        duration_ms: 执行耗时
        
    Error Codes:
        INVENTORY_FULL - 背包满了
        TOOL_BROKEN - 工具损坏
        TARGET_NOT_FOUND - 找不到目标
        PATH_BLOCKED - 路径被阻挡
        TIMEOUT - 超时
        NO_TOOL - 没有合适工具
        INSUFFICIENT_MATERIALS - 材料不足
    """
    success: bool
    action: str
    message: str
    status: ActionStatus
    data: Optional[Any] = None
    error_code: Optional[str] = None
    duration_ms: int = 0


class IBotActions(ABC):
    """
    Bot 动作抽象接口 (Layer 2: Python Actions)
    
    设计原则：
    - 简单的接口：方法参数使用语义化名称，不暴露坐标细节
    - 深度的功能：内部封装寻路、工具选择、错误处理
    - 依赖抽象：上层只依赖此接口，不依赖 Mineflayer 具体实现
    
    Target 格式约定：
    - 坐标: "x,y,z" (如 "100,64,-200")
    - 玩家: "@PlayerName" (如 "@HCID273")
    """
    
    @abstractmethod
    async def goto(self, target: str, timeout: float = 60.0) -> ActionResult:
        """
        导航到目标位置
        
        Args:
            target: 目标 ("x,y,z" 或 "@PlayerName")
            timeout: 超时时间 (秒)
            
        Returns:
            ActionResult
            data: {"arrived_at": [x, y, z]}
        """
        pass
    
    @abstractmethod
    async def mine(self, block_type: str, count: int = 1, timeout: float = 120.0) -> ActionResult:
        """
        采集指定类型的方块
        
        自动处理: 寻找 → 导航 → 选工具 → 挖掘
        
        Args:
            block_type: 方块类型 ID (如 "oak_log", "iron_ore")
            count: 数量
            timeout: 超时时间 (秒)
            
        Returns:
            ActionResult
            data: {"collected": {"oak_log": 3}, "location": [x, y, z]}
        """
        pass
    
    @abstractmethod
    async def place(self, block_type: str, x: int, y: int, z: int, timeout: float = 10.0) -> ActionResult:
        """
        在指定位置放置方块
        
        Args:
            block_type: 方块类型 ID
            x, y, z: 目标坐标
            timeout: 超时时间
            
        Returns:
            ActionResult
            data: {"placed_at": [x, y, z]}
        """
        pass
    
    @abstractmethod
    async def craft(self, item_name: str, count: int = 1, timeout: float = 30.0) -> ActionResult:
        """
        合成物品
        
        自动处理: 查配方 → 检查材料 → 寻找工作台 (如需)
        
        Args:
            item_name: 物品 ID (如 "oak_planks", "crafting_table")
            count: 数量
            timeout: 超时时间
            
        Returns:
            ActionResult
            data: {"crafted": {"oak_planks": 4}}
        """
        pass
    
    @abstractmethod
    async def give(self, player_name: str, item_name: str, count: int = 1, timeout: float = 30.0) -> ActionResult:
        """
        将物品交给玩家
        
        Args:
            player_name: 玩家名
            item_name: 物品 ID
            count: 数量
            timeout: 超时时间
            
        Returns:
            ActionResult
            data: {"given": {"oak_log": 10}, "to": "PlayerName"}
        """
        pass
    
    @abstractmethod
    async def equip(self, item_name: str, timeout: float = 5.0) -> ActionResult:
        """
        装备物品到手上
        
        Args:
            item_name: 物品 ID
            timeout: 超时时间
            
        Returns:
            ActionResult
            data: {"equipped": "diamond_pickaxe"}
        """
        pass
    
    @abstractmethod
    async def scan(self, target_type: str, radius: int = 32) -> ActionResult:
        """
        扫描周围实体/方块
        
        Args:
            target_type: 目标类型 (方块ID 或 "player", "mob", "item")
            radius: 扫描半径 (格)
            
        Returns:
            ActionResult
            data: {"targets": [{"name": "iron_ore", "count": 3, "nearest": [x, y, z]}]}
        """
        pass
    
    @abstractmethod
    async def pickup(
        self, 
        target: Optional[str] = None, 
        count: int = -1,
        radius: int = 16, 
        timeout: float = 60.0
    ) -> ActionResult:
        """
        拾取附近的掉落物
        
        简单接口：
        - LLM 只需说 {"action": "pickup", "target": "apple"}
        
        深度功能：
        - 自动寻找最近的掉落物 → 寻路走过去 → 校验是否捡到 → 找下一个
        - 支持指定物品类型过滤
        - 支持指定拾取数量
        - 超时保护与进度追踪
        
        Args:
            target: 目标物品类型 (可选，None 或 "all" 表示拾取所有)
            count: 拾取数量 (-1 表示尽可能多捡)
            radius: 搜索半径 (格)
            timeout: 超时时间 (秒)
            
        Returns:
            ActionResult
            data: {"picked_up": {"apple": 3, "oak_log": 5}, "total": 8}
        """
        pass
    
    @abstractmethod
    def get_state(self) -> dict:
        """
        获取 Bot 当前状态 (同步方法)
        
        Returns:
            {
                "position": {"x": 100, "y": 64, "z": -200},
                "health": 20.0,
                "food": 20,
                "inventory": {"oak_log": 64, "cobblestone": 128},
                "equipped": "diamond_pickaxe" | None
            }
        """
        pass


# ============================================================================
# Bot Controller - Bot 生命周期与基础控制 (已有)
# ============================================================================

class IBotController(ABC):
    """
    Bot 控制器抽象接口
    
    简单接口：jump, chat, get_position
    深度功能：后续可扩展 move_to, attack, place_block 等
    
    依赖抽象：业务逻辑依赖此接口，不依赖具体实现
    """
    
    @property
    @abstractmethod
    def is_connected(self) -> bool:
        """Bot 是否已连接"""
        pass
    
    @property
    @abstractmethod
    def username(self) -> str:
        """Bot 用户名"""
        pass
    
    @abstractmethod
    async def connect(self) -> bool:
        """连接到 Minecraft 服务器"""
        pass
    
    @abstractmethod
    async def disconnect(self) -> None:
        """断开连接"""
        pass
    
    @abstractmethod
    async def jump(self) -> bool:
        """跳跃"""
        pass
    
    @abstractmethod
    async def spin(self, rotations: int = 1, duration: float = 1.0) -> bool:
        """
        原地旋转（表演动作）
        
        Args:
            rotations: 旋转圈数 (正数顺时针，负数逆时针)
            duration: 每圈耗时（秒）
            
        Returns:
            是否成功
        """
        pass
    
    @abstractmethod
    async def look_at(self, target: str) -> bool:
        """
        看向目标（表演动作）
        
        Args:
            target: 目标 ("@PlayerName" 或 "x,y,z")
            
        Returns:
            是否成功
        """
        pass
    
    @abstractmethod
    async def chat(self, message: str) -> bool:
        """发送聊天消息"""
        pass
    
    @abstractmethod
    async def get_position(self) -> Optional[Tuple[float, float, float]]:
        """获取当前位置"""
        pass


class IBotManager(ABC):
    """
    Bot 管理器抽象接口
    
    管理多个 Bot 实例
    """
    
    @abstractmethod
    def get_bot(self, name: str) -> Optional[IBotController]:
        """获取指定名称的 Bot"""
        pass
    
    @abstractmethod
    async def spawn_bot(self, name: str) -> IBotController:
        """生成新的 Bot"""
        pass
    
    @abstractmethod
    async def remove_bot(self, name: str) -> bool:
        """移除 Bot"""
        pass
    
    @abstractmethod
    def list_bots(self) -> list[str]:
        """列出所有 Bot 名称"""
        pass
