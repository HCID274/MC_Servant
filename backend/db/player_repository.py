# Player Repository - 数据访问层
#
# 设计原则：简单的接口，深度的功能；依赖抽象，而非具体
#
# 职责：
# - Player 的 CRUD 操作
# - 在线状态管理

from datetime import datetime
from typing import Optional, Protocol

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Player, beijing_now
from .database import db


class IPlayerRepository(Protocol):
    """Player 仓库抽象接口"""
    async def get_by_uuid(self, uuid: str) -> Optional[Player]: ...
    async def get_online_players(self) -> list[Player]: ...
    async def upsert(self, uuid: str, name: str, is_online: bool = False) -> Player: ...
    async def set_online(self, uuid: str, name: str) -> Player: ...
    async def set_offline(self, uuid: str) -> Optional[Player]: ...
    async def set_all_offline(self) -> int: ...


class PlayerRepository:
    """
    Player 仓库实现
    
    使用 SQLAlchemy 异步会话进行数据库操作
    """
    
    async def get_by_uuid(self, uuid: str) -> Optional[Player]:
        """按 UUID 获取玩家"""
        async with db.session() as session:
            result = await session.execute(
                select(Player).where(Player.uuid == uuid)
            )
            return result.scalar_one_or_none()
    
    async def get_online_players(self) -> list[Player]:
        """获取所有在线玩家"""
        async with db.session() as session:
            result = await session.execute(
                select(Player).where(Player.is_online == True)
            )
            return list(result.scalars().all())
    
    async def upsert(
        self, 
        uuid: str, 
        name: str, 
        is_online: bool = False
    ) -> Player:
        """
        创建或更新玩家
        
        Args:
            uuid: Minecraft UUID
            name: 当前游戏名
            is_online: 是否在线
        """
        async with db.session() as session:
            now = beijing_now()
            values = {
                "name": name,
                "is_online": is_online,
                "updated_at": now,
            }
            if is_online:
                values["last_login"] = now
            
            stmt = insert(Player).values(uuid=uuid, **values)
            stmt = stmt.on_conflict_do_update(
                index_elements=["uuid"],
                set_=values
            )
            await session.execute(stmt)
            
            # 查询并返回
            result = await session.execute(
                select(Player).where(Player.uuid == uuid)
            )
            return result.scalar_one()
    
    async def set_online(self, uuid: str, name: str) -> Player:
        """
        设置玩家上线状态
        
        会更新 is_online=True 和 last_login
        """
        return await self.upsert(uuid, name, is_online=True)
    
    async def set_offline(self, uuid: str) -> Optional[Player]:
        """
        设置玩家下线状态
        
        Returns:
            更新后的 Player，如果不存在返回 None
        """
        async with db.session() as session:
            result = await session.execute(
                update(Player)
                .where(Player.uuid == uuid)
                .values(is_online=False, updated_at=beijing_now())
                .returning(Player)
            )
            return result.scalar_one_or_none()
    
    async def set_all_offline(self) -> int:
        """
        将所有玩家设置为离线
        
        用于冷启动同步前的清理
        
        Returns:
            受影响的行数
        """
        async with db.session() as session:
            result = await session.execute(
                update(Player)
                .where(Player.is_online == True)
                .values(is_online=False, updated_at=beijing_now())
            )
            return result.rowcount
