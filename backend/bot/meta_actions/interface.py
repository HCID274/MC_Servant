# Meta Action Interface
# 元动作抽象接口 - 简单的接口，深度的功能
#
# 设计原则:
# - name/description: LLM 可读，用于 Prompt 注入
# - can_execute: 前置条件检查 (动态过滤)
# - execute: 封装底层 Driver 调用 (actions.py)

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, TYPE_CHECKING

if TYPE_CHECKING:
    from ..interfaces import IBotActions, ActionResult

logger = logging.getLogger(__name__)


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class MetaActionResult:
    """
    元动作执行结果
    
    与底层 ActionResult 不同，这是一个简化的结果对象，
    用于 Meta-Action 内部逻辑判断
    """
    success: bool
    message: str
    data: Optional[Dict[str, Any]] = None
    error_code: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "success": self.success,
            "message": self.message,
            "data": self.data,
            "error_code": self.error_code
        }


@dataclass
class ParameterSpec:
    """参数规格定义"""
    name: str
    type: str  # "str", "int", "float", "bool", "dict", "list"
    description: str
    required: bool = True
    default: Any = None
    
    def to_json_schema(self) -> Dict[str, Any]:
        """转换为 JSON Schema 格式"""
        type_map = {
            "str": "string",
            "int": "integer",
            "float": "number",
            "bool": "boolean",
            "dict": "object",
            "list": "array"
        }
        schema = {
            "type": type_map.get(self.type, "string"),
            "description": self.description
        }
        if self.default is not None:
            schema["default"] = self.default
        return schema


# ============================================================================
# Abstract Interface
# ============================================================================

class IMetaAction(ABC):
    """
    元动作抽象接口
    
    设计原则:
    - 简单的接口: name, description, execute
    - 深度的功能: 完整的工具-方块匹配逻辑, 前置条件检查
    - 依赖于抽象: 委托给 IBotActions (Driver 层)
    
    LLM 友好:
    - name: snake_case 命名 (如 gather_block)
    - description: 自然语言描述
    - parameters_schema: JSON Schema 格式
    
    动态过滤:
    - can_execute(bot_state): 根据当前状态判断是否可用
    - 不可用的动作不会出现在 LLM Prompt 中
    """
    
    @property
    @abstractmethod
    def name(self) -> str:
        """
        动作名称 (snake_case)
        
        示例: "gather_block", "navigate_to", "craft_item"
        """
        ...
    
    @property
    @abstractmethod
    def description(self) -> str:
        """
        LLM 可读描述
        
        示例: "Navigate to and mine a block. Requires appropriate tool."
        """
        ...
    
    @property
    def parameters(self) -> List[ParameterSpec]:
        """
        参数规格列表
        
        用于生成 JSON Schema 和 Prompt
        """
        return []
    
    @property
    def parameters_schema(self) -> Dict[str, Any]:
        """
        参数 JSON Schema (自动从 parameters 生成)
        """
        if not self.parameters:
            return {}
        
        properties = {}
        required = []
        
        for param in self.parameters:
            properties[param.name] = param.to_json_schema()
            if param.required:
                required.append(param.name)
        
        return {
            "type": "object",
            "properties": properties,
            "required": required
        }
    
    @abstractmethod
    def can_execute(self, bot_state: Dict[str, Any]) -> bool:
        """
        检查前置条件是否满足
        
        用于动态过滤:
        - 如果返回 False，该动作不会出现在 Prompt 中
        - 减少 Token 消耗和 LLM 幻觉
        
        Args:
            bot_state: Bot 当前状态
                - inventory: 背包内容
                - position: 当前位置
                - health: 生命值
                - dimension: 所在维度
                - nearby_entities: 附近实体
                - ...
        
        Returns:
            是否满足前置条件
        """
        ...
    
    def get_unavailable_reason(self, bot_state: Dict[str, Any]) -> Optional[str]:
        """
        获取不可用的原因 (可选实现)
        
        当 can_execute 返回 False 时，可提供详细原因
        用于日志和调试
        """
        return None
    
    @abstractmethod
    async def execute(
        self, 
        actions: "IBotActions", 
        **params
    ) -> "ActionResult":
        """
        执行动作
        
        设计原则: 封装底层 Driver 调用
        
        Args:
            actions: 底层动作执行器 (IBotActions / BotActions)
            **params: 动作参数
        
        Returns:
            ActionResult: 执行结果
        """
        ...
    
    def format_for_prompt(self) -> str:
        """
        格式化为 Prompt 注入格式
        
        默认格式: "- **name**: description"
        可被子类覆盖以提供更详细的格式
        """
        param_hints = ""
        if self.parameters:
            param_names = [p.name for p in self.parameters]
            param_hints = f" (params: {', '.join(param_names)})"
        
        return f"- **{self.name}**: {self.description}{param_hints}"


# ============================================================================
# Tool Matcher Mixin (工具-方块匹配逻辑)
# ============================================================================

class ToolMatcherMixin:
    """
    工具-方块匹配逻辑 Mixin
    
    提供完整的 Minecraft 工具等级检查:
    - 判断背包是否有合适的工具
    - 支持工具等级继承 (钻石 > 铁 > 石 > 木)
    """
    
    # 工具等级定义 (数值越大越强)
    TOOL_TIERS = {
        "netherite": 5,
        "diamond": 4,
        "iron": 3,
        "stone": 2,
        "wooden": 1,
        "golden": 1,  # 金质工具效率高但耐久低
    }
    
    # 方块所需最低工具等级
    BLOCK_REQUIREMENTS = {
        # 矿石
        "iron_ore": ("pickaxe", "stone"),
        "deepslate_iron_ore": ("pickaxe", "stone"),
        "gold_ore": ("pickaxe", "iron"),
        "deepslate_gold_ore": ("pickaxe", "iron"),
        "diamond_ore": ("pickaxe", "iron"),
        "deepslate_diamond_ore": ("pickaxe", "iron"),
        "ancient_debris": ("pickaxe", "diamond"),
        "obsidian": ("pickaxe", "diamond"),
        "redstone_ore": ("pickaxe", "iron"),
        "lapis_ore": ("pickaxe", "stone"),
        "emerald_ore": ("pickaxe", "iron"),
        "copper_ore": ("pickaxe", "stone"),
        
        # 普通石头类
        "stone": ("pickaxe", "wooden"),
        "cobblestone": ("pickaxe", "wooden"),
        "granite": ("pickaxe", "wooden"),
        "diorite": ("pickaxe", "wooden"),
        "andesite": ("pickaxe", "wooden"),
        "deepslate": ("pickaxe", "wooden"),
        
        # 木头类 (任意斧子或徒手)
        "_log": ("axe", None),  # 通配符
        "_planks": (None, None),  # 无需工具
        
        # 泥土类 (任意铲子或徒手)
        "dirt": ("shovel", None),
        "grass_block": ("shovel", None),
        "sand": ("shovel", None),
        "gravel": ("shovel", None),
    }
    
    # 可以徒手挖掘的方块类型
    HAND_MINEABLE = {
        "dirt", "grass_block", "sand", "gravel",
        "leaves", "tall_grass", "flowers",
        "crafting_table", "chest", "furnace",
    }
    
    def has_required_tool(
        self, 
        block_type: str, 
        inventory: Dict[str, int]
    ) -> bool:
        """
        检查背包是否有挖掘指定方块所需的工具
        
        Args:
            block_type: 方块类型 (如 "iron_ore")
            inventory: 背包内容 {item_name: count}
        
        Returns:
            是否有合适的工具
        """
        # 检查是否可徒手挖掘
        if self._is_hand_mineable(block_type):
            return True
        
        # 获取所需工具类型和最低等级
        tool_type, min_tier = self._get_tool_requirement(block_type)
        
        if tool_type is None:
            # 无需特定工具
            return True
        
        if min_tier is None:
            # 任意等级工具都可
            return self._has_any_tool(inventory, tool_type)
        
        # 需要特定等级
        return self._has_tool_at_tier(inventory, tool_type, min_tier)
    
    def get_best_tool(
        self, 
        block_type: str, 
        inventory: Dict[str, int]
    ) -> Optional[str]:
        """
        获取挖掘指定方块的最佳工具
        
        Returns:
            工具名称 (如 "iron_pickaxe") 或 None
        """
        tool_type, _ = self._get_tool_requirement(block_type)
        
        if tool_type is None:
            return None
        
        # 按等级从高到低搜索
        for tier in ["netherite", "diamond", "iron", "stone", "golden", "wooden"]:
            tool_name = f"{tier}_{tool_type}"
            if inventory.get(tool_name, 0) > 0:
                return tool_name
        
        return None
    
    def get_missing_tool_requirement(
        self, 
        block_type: str, 
        inventory: Dict[str, int]
    ) -> Optional[str]:
        """
        获取缺失的工具需求描述
        
        Returns:
            如 "Requires stone_pickaxe or better" 或 None
        """
        if self.has_required_tool(block_type, inventory):
            return None
        
        tool_type, min_tier = self._get_tool_requirement(block_type)
        
        if tool_type is None:
            return None
        
        if min_tier is None:
            return f"Requires any {tool_type}"
        
        return f"Requires {min_tier}_{tool_type} or better"
    
    # -------------------------------------------------------------------------
    # Private Helpers
    # -------------------------------------------------------------------------
    
    def _is_hand_mineable(self, block_type: str) -> bool:
        """检查是否可徒手挖掘"""
        # 直接匹配
        if block_type in self.HAND_MINEABLE:
            return True
        
        # 模糊匹配 (如 oak_leaves -> leaves)
        for hand_type in self.HAND_MINEABLE:
            if block_type.endswith(hand_type):
                return True
        
        return False
    
    def _get_tool_requirement(self, block_type: str) -> tuple:
        """获取方块的工具需求 (tool_type, min_tier)"""
        # 直接匹配
        if block_type in self.BLOCK_REQUIREMENTS:
            return self.BLOCK_REQUIREMENTS[block_type]
        
        # 通配符匹配 (如 oak_log -> _log)
        for pattern, requirement in self.BLOCK_REQUIREMENTS.items():
            if pattern.startswith("_") and block_type.endswith(pattern[1:]):
                return requirement
        
        # 默认: 无需工具
        return (None, None)
    
    def _has_any_tool(self, inventory: Dict[str, int], tool_type: str) -> bool:
        """检查是否有任意等级的指定工具"""
        for item in inventory.keys():
            if item.endswith(f"_{tool_type}"):
                return True
        return False
    
    def _has_tool_at_tier(
        self, 
        inventory: Dict[str, int], 
        tool_type: str, 
        min_tier: str
    ) -> bool:
        """检查是否有达到指定等级的工具"""
        min_tier_level = self.TOOL_TIERS.get(min_tier, 0)
        
        for item in inventory.keys():
            if not item.endswith(f"_{tool_type}"):
                continue
            
            # 提取工具等级
            for tier, level in self.TOOL_TIERS.items():
                if item.startswith(tier) and level >= min_tier_level:
                    return True
        
        return False
