# Bot Controller Interfaces

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Tuple, Optional, Any, List
from enum import Enum


# ============================================================================
# Action System - Bot 动作执行能力 (Layer 2)
# ============================================================================

class ActionStatus(Enum):
    """执行状态：明确标识动作的终态（成功、失败、超时或取消）。"""
    SUCCESS = "success"
    PARTIAL = "partial"
    FAILED = "failed"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"


@dataclass
class ActionResult:
    """结算报告：封装动作执行后的详细反馈，供决策层评估下一步行动。"""
    success: bool
    action: str
    message: str
    status: ActionStatus
    data: Optional[Any] = None
    error_code: Optional[str] = None
    duration_ms: int = 0


class IBotActions(ABC):
    """高级动作标准：定义挖矿、合成等复杂技能的契约，解耦大脑决策与底层执行。"""
    
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
    async def mine_tree(
        self,
        near_position: Optional[dict] = None,
        search_radius: int = 32,
        timeout: float = 120.0
    ) -> ActionResult:
        """
        砍树（采集原木）

        Args:
            near_position: 可选搜索中心 {x, y, z}
            search_radius: 搜索半径（格）
            timeout: 超时时间（秒）

        Returns:
            ActionResult
            data: {"collected": int, "failed": int, "log_type": str}
        """
        pass
    
    @abstractmethod
    async def climb_to_surface(self, timeout: float = 60.0) -> ActionResult:
        """
        尝试从地下返回地面 (垂直脱困)
        
        策略:
        1. 寻找上方最高的非空气方块高度
        2. 尝试使用 pathfinder 导航 (已启用 allow1by1towers)
        3. 如果常规导航失败，尝试强制搭路向上或使用挖掘脱困
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
    async def smelt(self, item_name: str, count: int = 1, timeout: float = 120.0) -> ActionResult:
        """
        冶炼物品

        Args:
            item_name: 原材料 ID (如 "raw_iron", "sand")
            count: 数量
            timeout: 超时时间 (秒)

        Returns:
            ActionResult
            data: {"smelted": {"iron_ingot": 3}}
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
    async def find_location(
        self, 
        feature: str, 
        radius: int = 64, 
        count: int = 1
    ) -> ActionResult:
        """
        寻找符合特定特征的地点 (语义感知)
        
        简单接口：
        - LLM 只需说 {"action": "find_location", "feature": "highest"}
        
        深度功能：
        - Python 负责特征提取，返回候选坐标
        - LLM 不需要处理原始高程数据，只需处理语义化的结果
        - 支持多种地形特征类型
        
        Args:
            feature: 特征描述，支持:
                     - "highest": 视野内最高点 (山顶)
                     - "lowest": 视野内最低点 (谷底/洞穴入口)
                     - "flat": 平坦区域 (适合建筑)
                     - "water": 最近的水源 (河边/海边)
                     - "tree": 树木密集处 (森林)
                     - "structure": 人造结构 (村庄/房子)
            radius: 搜索半径 (格)
            count: 返回候选点数量
            
        Returns:
            ActionResult
            data: {
                "locations": [
                    {"x": int, "y": int, "z": int, "description": str, "distance": float}
                ],
                "feature": str
            }
        """
        pass
    
    @abstractmethod
    async def patrol(
        self,
        center_x: int,
        center_z: int,
        radius: int = 10,
        duration: int = 30,
        timeout: float = 60.0
    ) -> ActionResult:
        """
        在指定区域内巡逻/游荡
        
        简单接口：
        - LLM 只需说 {"action": "patrol", "center_x": 100, "center_z": 200, "radius": 10}
        
        深度功能：
        - Python 自动生成随机巡逻路径点
        - 依次导航到各个路径点
        - 支持时间限制和超时保护
        
        Args:
            center_x: 巡逻中心 X 坐标
            center_z: 巡逻中心 Z 坐标
            radius: 巡逻半径 (格)
            duration: 巡逻时长 (秒)
            timeout: 超时时间 (秒)
            
        Returns:
            ActionResult
            data: {
                "waypoints_visited": int,
                "total_distance": float,
            "duration_actual": float
        }
        """
        pass

    @abstractmethod
    async def chat(self, message: str) -> bool:
        """发送聊天消息"""
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

    @abstractmethod
    def get_player_position(self, player_name: str) -> Optional[dict]:
        """
        获取指定玩家位置

        Returns:
            {"x": int, "y": int, "z": int} | None
        """
        pass


# ============================================================================
# Bot Controller - Bot 生命周期与基础控制 (已有)
# ============================================================================

class IBotController(ABC):
    """基础操控标准：定义跳跃、旋转、说话等最底层的原子操作规范。"""
    
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
    """管理契约：定义如何批量维护、查找以及注销多个 Bot 实例。"""
    
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
