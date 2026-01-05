# Bot Repository - 数据访问层
#
# 设计原则：简单的接口，深度的功能；依赖抽象，而非具体
#
# 职责：
# - Bot 的 CRUD 操作
# - 替代 BotConfig.load()/save() 的 JSON 文件操作

import logging
from typing import Optional, Protocol, List

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert

from .models import Bot, beijing_now
from .database import db

logger = logging.getLogger(__name__)


class IBotRepository(Protocol):
    """Bot 仓库抽象接口"""
    async def get_by_name(self, name: str) -> Optional[Bot]: ...
    async def get_by_owner(self, owner_uuid: str) -> List[Bot]: ...
    async def get_all(self) -> List[Bot]: ...
    async def claim(self, bot_name: str, owner_uuid: str, owner_name: str) -> Optional[Bot]: ...
    async def release(self, bot_name: str) -> Optional[Bot]: ...
    async def upsert(self, name: str, **kwargs) -> Optional[Bot]: ...


class BotRepository:
    """
    Bot 仓库实现
    
    使用 SQLAlchemy 异步会话进行数据库操作
    """
    
    async def get_by_name(self, name: str) -> Optional[Bot]:
        """按名称获取 Bot"""
        try:
            async with db.session() as session:
                result = await session.execute(
                    select(Bot).where(Bot.name == name)
                )
                return result.scalar_one_or_none()
        except Exception as e:
            logger.error(f"Error in get_by_name(name={name}): {e}")
            return None
    
    async def get_by_owner(self, owner_uuid: str) -> List[Bot]:
        """获取玩家拥有的所有 Bot"""
        try:
            async with db.session() as session:
                result = await session.execute(
                    select(Bot).where(Bot.owner_uuid == owner_uuid)
                )
                return list(result.scalars().all())
        except Exception as e:
            logger.error(f"Error in get_by_owner(owner_uuid={owner_uuid}): {e}")
            return []
    
    async def get_all(self) -> List[Bot]:
        """获取所有 Bot"""
        try:
            async with db.session() as session:
                result = await session.execute(select(Bot))
                return list(result.scalars().all())
        except Exception as e:
            logger.error(f"Error in get_all: {e}")
            return []
    
    async def claim(
        self, 
        bot_name: str, 
        owner_uuid: str, 
        owner_name: str
    ) -> Optional[Bot]:
        """
        认领 Bot
        
        Args:
            bot_name: Bot 名称
            owner_uuid: 玩家 UUID
            owner_name: 玩家名称
            
        Returns:
            更新后的 Bot 实例，如果 Bot 不存在返回 None
        """
        try:
            async with db.session() as session:
                result = await session.execute(
                    update(Bot)
                    .where(Bot.name == bot_name)
                    .values(
                        owner_uuid=owner_uuid,
                        owner_name=owner_name,
                        claimed_at=beijing_now()
                    )
                    .returning(Bot)
                )
                return result.scalar_one_or_none()
        except Exception as e:
            logger.error(f"Error in claim(bot_name={bot_name}): {e}")
            return None
    
    async def release(self, bot_name: str) -> Optional[Bot]:
        """
        释放 Bot（恢复无主状态）
        
        Returns:
            更新后的 Bot 实例，如果 Bot 不存在返回 None
        """
        try:
            async with db.session() as session:
                result = await session.execute(
                    update(Bot)
                    .where(Bot.name == bot_name)
                    .values(
                        owner_uuid=None,
                        owner_name=None,
                        claimed_at=None
                    )
                    .returning(Bot)
                )
                return result.scalar_one_or_none()
        except Exception as e:
            logger.error(f"Error in release(bot_name={bot_name}): {e}")
            return None
    
    async def upsert(self, name: str, **kwargs) -> Optional[Bot]:
        """
        创建或更新 Bot
        
        Args:
            name: Bot 名称
            **kwargs: 其他字段（personality, skin_url, auto_spawn 等）
            
        Returns:
            Bot 实例
        """
        try:
            async with db.session() as session:
                stmt = insert(Bot).values(name=name, **kwargs)
                stmt = stmt.on_conflict_do_update(
                    index_elements=["name"],
                    set_=kwargs
                )
                await session.execute(stmt)

                # 查询并返回
                result = await session.execute(
                    select(Bot).where(Bot.name == name)
                )
                return result.scalar_one()
        except Exception as e:
            logger.error(f"Error in upsert(name={name}): {e}")
            return None
    
    async def is_owner(
        self, 
        bot_name: str, 
        player_uuid: Optional[str], 
        player_name: Optional[str] = None
    ) -> bool:
        """
        检查玩家是否是 Bot 的主人
        
        支持 UUID 和玩家名双重匹配（兼容旧数据）
        """
        try:
            bot = await self.get_by_name(bot_name)
            if bot is None or not bot.is_claimed:
                return False

            # UUID 匹配
            if player_uuid and bot.owner_uuid == player_uuid:
                return True

            # 玩家名匹配（兼容）
            if player_name and bot.owner_name == player_name:
                return True

            return False
        except Exception as e:
            logger.error(f"Error in is_owner: {e}")
            return False
