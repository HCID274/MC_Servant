# Bot Configuration
# Bot 持久化配置 - 重启后保留

import json
import logging
import time
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class BotConfig(BaseModel):
    """
    Bot 持久化配置
    
    这是 Bot 的"身份证"和"长期记忆"
    生命周期：永久，随服务器启动加载
    存储方式：JSON 文件 (MVP 阶段)
    """
    # Bot 身份
    bot_name: str = "Alice"
    bot_uuid: Optional[str] = None  # Mineflayer Bot 的 UUID
    
    # 主人信息
    owner_uuid: Optional[str] = None
    owner_name: Optional[str] = None
    
    # 外观
    skin_url: Optional[str] = None
    
    # 时间戳
    created_at: int = Field(default_factory=lambda: int(time.time()))
    claimed_at: Optional[int] = None
    
    # 未来扩展字段
    # affection_level: int = 0  # 好感度
    # experience: int = 0       # 经验值
    
    @property
    def is_claimed(self) -> bool:
        """Bot 是否已被认领"""
        return self.owner_uuid is not None
    
    def claim(self, player_uuid: str, player_name: str) -> None:
        """
        认领 Bot
        
        Args:
            player_uuid: 玩家 UUID
            player_name: 玩家名称
        """
        self.owner_uuid = player_uuid
        self.owner_name = player_name
        self.claimed_at = int(time.time())
        logger.info(f"Bot {self.bot_name} claimed by {player_name}")
    
    def release(self) -> None:
        """释放 Bot（恢复无主状态）"""
        old_owner = self.owner_name
        self.owner_uuid = None
        self.owner_name = None
        self.claimed_at = None
        logger.info(f"Bot {self.bot_name} released by {old_owner}")
    
    def is_owner(self, player_uuid: Optional[str], player_name: Optional[str] = None) -> bool:
        """
        检查玩家是否是主人
        
        Args:
            player_uuid: 玩家 UUID
            player_name: 玩家名称 (可选，用于兼容匹配)
            
        Returns:
            True 如果是主人
        """
        if not self.is_claimed:
            return False
        
        # 匹配 UUID
        if player_uuid and self.owner_uuid == player_uuid:
            return True
        
        # 匹配玩家名 (兼容 owner_uuid 存的是玩家名的情况)
        if player_name and self.owner_name == player_name:
            return True
        if player_name and self.owner_uuid == player_name:
            return True
        
        return False
    
    def save(self, path: Path) -> None:
        """
        保存配置到 JSON 文件
        
        Args:
            path: 文件路径
        """
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.model_dump(), f, indent=2, ensure_ascii=False)
        logger.debug(f"Bot config saved to {path}")
    
    @classmethod
    def load(cls, path: Path) -> "BotConfig":
        """
        从 JSON 文件加载配置
        
        如果文件不存在，返回默认配置
        
        Args:
            path: 文件路径
            
        Returns:
            BotConfig 实例
        """
        if not path.exists():
            logger.info(f"Config file not found: {path}, using defaults")
            return cls()
        
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            config = cls(**data)
            logger.info(f"Bot config loaded from {path}")
            return config
        except Exception as e:
            logger.warning(f"Failed to load config from {path}: {e}, using defaults")
            return cls()
    
    def get_display_status(self) -> str:
        """
        获取头顶显示的状态文本
        
        Returns:
            如 "[玩家A 的女仆]" 或 "[无主] 右键认领"
        """
        if self.is_claimed:
            return f"[{self.owner_name} 的女仆]"
        else:
            return "[无主] 右键认领"


# 默认配置文件路径
DEFAULT_CONFIG_PATH = Path("data/bot_config.json")
