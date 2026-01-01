# Database Connection Management
#
# 异步 PostgreSQL 连接管理
# 使用 SQLAlchemy 2.0 async 引擎

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Optional

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
    AsyncEngine,
)
from sqlalchemy.pool import NullPool

from .models import Base

logger = logging.getLogger(__name__)


class DatabaseManager:
    """
    数据库连接管理器 (单例模式)
    
    Features:
    - 异步连接池管理
    - 自动创建表结构
    - 会话生命周期管理
    """
    
    _instance: Optional["DatabaseManager"] = None
    _engine: Optional[AsyncEngine] = None
    _session_factory: Optional[async_sessionmaker[AsyncSession]] = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    async def init(
        self,
        database_url: str,
        echo: bool = False,
        pool_size: int = 5,
        max_overflow: int = 10,
    ) -> None:
        """
        初始化数据库连接
        
        Args:
            database_url: PostgreSQL 连接 URL
                格式: postgresql+asyncpg://user:pass@host:port/dbname
            echo: 是否打印 SQL 语句 (调试用)
            pool_size: 连接池大小
            max_overflow: 超出 pool_size 时允许的额外连接数
        """
        if self._engine is not None:
            logger.warning("DatabaseManager already initialized, skipping...")
            return
        
        logger.info(f"Initializing database connection...")
        
        self._engine = create_async_engine(
            database_url,
            echo=echo,
            pool_size=pool_size,
            max_overflow=max_overflow,
            # 对于 asyncpg，推荐使用 NullPool 避免连接问题 (可选)
            # poolclass=NullPool,
        )
        
        self._session_factory = async_sessionmaker(
            bind=self._engine,
            class_=AsyncSession,
            expire_on_commit=False,  # 防止 commit 后对象过期
        )
        
        logger.info("Database connection initialized successfully")
    
    async def create_tables(self) -> None:
        """
        创建所有表结构 (仅用于开发/测试)
        
        生产环境应使用 Alembic 迁移
        """
        if self._engine is None:
            raise RuntimeError("DatabaseManager not initialized")
        
        async with self._engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        
        logger.info("Database tables created")
    
    async def drop_tables(self) -> None:
        """删除所有表 (危险! 仅用于测试)"""
        if self._engine is None:
            raise RuntimeError("DatabaseManager not initialized")
        
        async with self._engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        
        logger.warning("Database tables dropped")
    
    @asynccontextmanager
    async def session(self) -> AsyncGenerator[AsyncSession, None]:
        """
        获取数据库会话 (上下文管理器)
        
        Usage:
            async with db.session() as session:
                result = await session.execute(...)
        """
        if self._session_factory is None:
            raise RuntimeError("DatabaseManager not initialized")
        
        async with self._session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise
    
    async def close(self) -> None:
        """关闭数据库连接"""
        if self._engine is not None:
            await self._engine.dispose()
            self._engine = None
            self._session_factory = None
            logger.info("Database connection closed")
    
    @property
    def engine(self) -> AsyncEngine:
        if self._engine is None:
            raise RuntimeError("DatabaseManager not initialized")
        return self._engine


# 全局单例
db = DatabaseManager()


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """
    FastAPI 依赖注入用的会话获取函数
    
    Usage:
        @app.get("/")
        async def handler(session: AsyncSession = Depends(get_session)):
            ...
    """
    async with db.session() as session:
        yield session
