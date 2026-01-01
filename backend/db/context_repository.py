# Context Repository - Data Access Layer
#
# 对话上下文数据访问层，封装数据库 CRUD 操作
#
# 设计原则：
# - 简单接口：get_or_create(), update_buffer(), log_compression()
# - 深度功能：异步 IO，事务管理，乐观锁
# - 依赖抽象：依赖 AsyncSession 接口

import logging
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Player, Bot, ConversationContext, CompressionLog

logger = logging.getLogger(__name__)


# ============================================================
# 抽象接口
# ============================================================

class IContextRepository(ABC):
    """
    对话上下文数据访问接口
    
    职责：CRUD 操作，对业务层隐藏 SQL 细节
    """
    
    @abstractmethod
    async def get_or_create(
        self, 
        player_uuid: str, 
        player_name: str,
        bot_name: str,
    ) -> ConversationContext:
        """获取或创建对话上下文"""
        pass
    
    @abstractmethod
    async def update_buffer(self, ctx_id: int, new_buffer: list) -> None:
        """更新 L0 缓冲区"""
        pass
    
    @abstractmethod
    async def update_memories(
        self, 
        ctx_id: int, 
        episodic: Optional[str] = None,
        core: Optional[str] = None,
        clear_buffer: bool = False,
    ) -> None:
        """更新 L1/L2 记忆"""
        pass
    
    @abstractmethod
    async def log_compression(
        self,
        ctx_id: int,
        compression_type: str,
        input_tokens: int,
        output_tokens: int,
        before_snapshot: str,
        after_snapshot: str,
    ) -> None:
        """记录压缩操作"""
        pass


# ============================================================
# 具体实现
# ============================================================

class ContextRepository(IContextRepository):
    """
    SQLAlchemy 异步实现的对话上下文仓库
    """
    
    def __init__(self, session: AsyncSession):
        """
        初始化仓库
        
        Args:
            session: SQLAlchemy 异步会话
        """
        self._session = session
    
    async def get_or_create(
        self, 
        player_uuid: str, 
        player_name: str,
        bot_name: str,
    ) -> ConversationContext:
        """
        获取或创建对话上下文
        
        如果玩家或 Bot 不存在，也会自动创建
        """
        # 1. 获取或创建 Player
        player = await self._get_or_create_player(player_uuid, player_name)
        
        # 2. 获取或创建 Bot
        bot = await self._get_or_create_bot(bot_name)
        
        # 3. 获取或创建 ConversationContext
        stmt = select(ConversationContext).where(
            ConversationContext.player_id == player.id,
            ConversationContext.bot_id == bot.id,
        )
        result = await self._session.execute(stmt)
        ctx = result.scalar_one_or_none()
        
        if ctx is None:
            ctx = ConversationContext(
                player_id=player.id,
                bot_id=bot.id,
                raw_buffer=[],
                episodic_memory="",
                core_memory="",
            )
            self._session.add(ctx)
            await self._session.flush()  # 获取 ID
            logger.info(f"Created new context: player={player_uuid}, bot={bot_name}")
        
        return ctx
    
    async def update_buffer(self, ctx_id: int, new_buffer: list) -> None:
        """更新 L0 缓冲区"""
        ctx = await self._session.get(ConversationContext, ctx_id)
        if ctx:
            ctx.raw_buffer = new_buffer
            ctx.updated_at = datetime.utcnow()
            await self._session.flush()
    
    async def update_memories(
        self, 
        ctx_id: int, 
        episodic: Optional[str] = None,
        core: Optional[str] = None,
        clear_buffer: bool = False,
    ) -> None:
        """
        更新 L1/L2 记忆
        
        Args:
            ctx_id: 上下文 ID
            episodic: 新的 L1 情景记忆（追加到现有）
            core: 新的 L2 核心记忆（替换）
            clear_buffer: 是否清空 L0 缓冲区
        """
        ctx = await self._session.get(ConversationContext, ctx_id)
        if not ctx:
            logger.warning(f"Context not found: {ctx_id}")
            return
        
        if episodic is not None:
            # 追加到现有情景记忆
            if ctx.episodic_memory:
                ctx.episodic_memory = ctx.episodic_memory + "\n\n---\n\n" + episodic
            else:
                ctx.episodic_memory = episodic
        
        if core is not None:
            # 替换核心记忆
            ctx.core_memory = core
        
        if clear_buffer:
            ctx.raw_buffer = []
        
        ctx.last_compressed_at = datetime.utcnow()
        ctx.compression_count += 1
        ctx.updated_at = datetime.utcnow()
        
        await self._session.flush()
        logger.debug(f"Updated memories for context {ctx_id}")
    
    async def log_compression(
        self,
        ctx_id: int,
        compression_type: str,
        input_tokens: int,
        output_tokens: int,
        before_snapshot: str,
        after_snapshot: str,
    ) -> None:
        """记录压缩操作到日志表"""
        log_entry = CompressionLog(
            context_id=ctx_id,
            compression_type=compression_type,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            before_snapshot=before_snapshot,
            after_snapshot=after_snapshot,
        )
        self._session.add(log_entry)
        await self._session.flush()
        logger.debug(f"Logged compression: {compression_type}, {input_tokens}→{output_tokens}")
    
    async def get_by_id(self, ctx_id: int) -> Optional[ConversationContext]:
        """通过 ID 获取上下文"""
        return await self._session.get(ConversationContext, ctx_id)
    
    # ==================== 辅助方法 ====================
    
    async def _get_or_create_player(self, uuid: str, name: str) -> Player:
        """获取或创建玩家"""
        stmt = select(Player).where(Player.uuid == uuid)
        result = await self._session.execute(stmt)
        player = result.scalar_one_or_none()
        
        if player is None:
            player = Player(uuid=uuid, name=name)
            self._session.add(player)
            await self._session.flush()
            logger.debug(f"Created new player: {uuid}")
        elif player.name != name:
            # 更新玩家名（可能改名了）
            player.name = name
            player.updated_at = datetime.utcnow()
        
        return player
    
    async def _get_or_create_bot(self, name: str) -> Bot:
        """获取或创建 Bot"""
        stmt = select(Bot).where(Bot.name == name)
        result = await self._session.execute(stmt)
        bot = result.scalar_one_or_none()
        
        if bot is None:
            bot = Bot(name=name)
            self._session.add(bot)
            await self._session.flush()
            logger.debug(f"Created new bot: {name}")
        
        return bot
