# Personality Provider Module
#
# 人格提供者 - Bot 个性化注入
#
# 设计原则：
# - 简单接口：get_personality(), build_system_prompt()
# - 深度功能：动态拼接人格与记忆，支持多种人格模板
# - 依赖抽象：依赖 IContextRepository 接口

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# ============================================================
# 数据类
# ============================================================

@dataclass
class ChatContextResult:
    """
    聊天上下文构建结果
    
    包含给 LLM 的消息列表，以及用于调试和监控的元数据
    """
    messages: list[dict] = field(default_factory=list)  # 给 LLM 用的消息列表
    token_count: int = 0                                 # 预估 token 数
    memory_snapshot: str = ""                            # 当前记忆快照 (Debug/UI)
    personality_used: str = ""                           # 使用的人格设定
    memory_depth: str = "standard"                       # 记忆深度 (fast/standard/deep)

    def __repr__(self) -> str:
        return f"<ChatContextResult(msgs={len(self.messages)}, tokens≈{self.token_count}, depth={self.memory_depth})>"


# ============================================================
# 默认人格模板
# ============================================================

DEFAULT_PERSONALITY = """你是 Minecraft 游戏中的一个可爱猫娘女仆助手。

## 基本设定
- 你的名字是 {bot_name}
- 你正在和玩家 {player_name} 聊天
- 你是一个忠诚、可爱、勤劳的女仆

## 回复风格
- 保持可爱、友好的语气
- 回复简短（不超过80字）
- 每句话结尾加一个喵~
- 根据记忆中的玩家偏好调整回复风格

## 能力
你可以帮主人：建造房屋、挖矿、种田、守卫家园"""


# ============================================================
# 抽象接口
# ============================================================

class IPersonalityProvider(ABC):
    """
    人格提供者抽象接口
    
    职责：
    - 提供 Bot 的人格设定
    - 构建包含人格和记忆的 System Prompt
    """
    
    @abstractmethod
    async def get_personality(self, bot_name: str) -> str:
        """
        获取 Bot 的人格设定
        
        Args:
            bot_name: Bot 名称
            
        Returns:
            人格设定文本，如果无设定则返回默认模板
        """
        pass
    
    @abstractmethod
    async def build_system_prompt(
        self, 
        bot_name: str, 
        core_memory: str = "",
        episodic_memory: str = "",
        player_name: str = "",
    ) -> str:
        """
        构建完整的 System Prompt
        
        将人格设定与核心记忆动态拼接
        
        Args:
            bot_name: Bot 名称
            core_memory: L2 核心记忆
            episodic_memory: L1 情景记忆摘要
            player_name: 玩家名称
            
        Returns:
            完整的 System Prompt
        """
        pass


# ============================================================
# 具体实现
# ============================================================

class PersonalityProvider(IPersonalityProvider):
    """
    人格提供者实现
    
    从数据库获取人格设定，或使用默认模板
    """
    
    def __init__(self, repository=None):
        """
        初始化人格提供者
        
        Args:
            repository: IContextRepository 实例（可选，用于从数据库获取人格）
        """
        self._repo = repository
        self._cache: dict[str, str] = {}  # 人格缓存
    
    async def get_personality(self, bot_name: str) -> str:
        """获取 Bot 的人格设定"""
        # 检查缓存
        if bot_name in self._cache:
            return self._cache[bot_name]
        
        personality = ""
        
        # 尝试从数据库获取
        if self._repo:
            try:
                personality = await self._repo.get_bot_personality(bot_name)
            except Exception as e:
                logger.warning(f"Failed to get personality from DB: {e}")
        
        # 如果无设定，使用默认模板
        if not personality:
            personality = DEFAULT_PERSONALITY
        
        # 缓存
        self._cache[bot_name] = personality
        
        return personality
    
    async def build_system_prompt(
        self, 
        bot_name: str, 
        core_memory: str = "",
        episodic_memory: str = "",
        player_name: str = "",
    ) -> str:
        """构建完整的 System Prompt"""
        # 获取人格设定
        personality = await self.get_personality(bot_name)
        
        # 替换模板变量
        prompt = personality.format(
            bot_name=bot_name,
            player_name=player_name or "主人",
        )
        
        # 添加记忆部分
        memory_sections = []
        
        if core_memory:
            memory_sections.append(f"## 关于这位玩家的核心认知\n{core_memory}")
        
        if episodic_memory:
            # 情景记忆只取最近的摘要
            recent_episodic = episodic_memory[-1500:] if len(episodic_memory) > 1500 else episodic_memory
            memory_sections.append(f"## 近期经历\n{recent_episodic}")
        
        if memory_sections:
            prompt += "\n\n---\n\n" + "\n\n".join(memory_sections)
        
        return prompt
    
    def clear_cache(self, bot_name: str = None) -> None:
        """清除人格缓存"""
        if bot_name:
            self._cache.pop(bot_name, None)
        else:
            self._cache.clear()


# ============================================================
# Token 估算工具
# ============================================================

def estimate_tokens(text: str) -> int:
    """
    估算文本的 Token 数
    
    简单估算：中文约 1.5 字/token，英文约 4 字符/token
    """
    if not text:
        return 0
    
    # 统计中文字符
    chinese_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    other_chars = len(text) - chinese_chars
    
    # 估算
    tokens = int(chinese_chars / 1.5) + int(other_chars / 4)
    return max(tokens, 1)
