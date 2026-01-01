# Alembic Migration Environment
#
# 配置 Alembic 使用我们的 SQLAlchemy 模型和数据库连接

import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import pool
from sqlalchemy import engine_from_config
from sqlalchemy import create_engine

from alembic import context

# 将 backend 目录添加到 sys.path
backend_path = Path(__file__).resolve().parents[2]
if str(backend_path) not in sys.path:
    sys.path.insert(0, str(backend_path))

# 导入我们的模型和配置
from db.models import Base
from config import settings

# Alembic Config 对象
config = context.config

# 设置日志
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# 使用我们的模型 Metadata 进行 autogenerate
target_metadata = Base.metadata

# 从配置获取数据库 URL (使用同步驱动 psycopg2)
def get_sync_url() -> str:
    """获取同步数据库 URL (Alembic 不支持 asyncpg)"""
    return f"postgresql://{settings.db_user}:{settings.db_password}@{settings.db_host}:{settings.db_port}/{settings.db_name}"


def run_migrations_offline() -> None:
    """
    离线模式迁移
    
    生成 SQL 而不是直接执行
    """
    url = get_sync_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """
    在线模式迁移
    
    直接连接数据库执行迁移
    """
    # 使用同步引擎 (Alembic 需要)
    connectable = create_engine(
        get_sync_url(),
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection, 
            target_metadata=target_metadata,
            compare_type=True,  # 检测类型变更
            compare_server_default=True,  # 检测默认值变更
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
