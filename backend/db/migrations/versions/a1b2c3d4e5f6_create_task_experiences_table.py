"""Create task_experiences table with pgvector support

Revision ID: a1b2c3d4e5f6
Revises: 7d8d61dac115
Create Date: 2026-01-06 18:56:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '7d8d61dac115'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create task_experiences table with pgvector extension."""
    
    # 1. 启用 pgvector 扩展 (如果尚未启用)
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    
    # 2. 创建 task_experiences 表
    op.create_table(
        'task_experiences',
        
        # 主键 (UUID)
        sa.Column('id', postgresql.UUID(as_uuid=True), 
                  server_default=sa.text("gen_random_uuid()"),
                  primary_key=True),
        
        # ========== 任务目标 ==========
        sa.Column('goal_text', sa.Text(), nullable=False,
                  comment='任务目标文本 (如 "obtain 3 iron_ingot")'),
        # ========== 前置条件 (JSONB) ==========
        sa.Column('preconditions', postgresql.JSONB(astext_type=sa.Text()),
                  nullable=False, server_default='{}',
                  comment='前置条件 (如 {"has_pickaxe": true, "tool_tier": "iron"})'),
        
        # ========== 执行轨迹 (JSONB) ==========
        sa.Column('plan_trace', postgresql.JSONB(astext_type=sa.Text()),
                  nullable=False, server_default='[]',
                  comment='语义化执行步骤 (如 [{"action": "scan", "params": {...}}])'),
        
        # ========== 结果状态 ==========
        sa.Column('outcome', sa.String(16), nullable=False,
                  comment='结果: success | partial | failed'),
        sa.Column('completion_ratio', sa.Float(), nullable=False, server_default='1.0',
                  comment='完成比例 (0.0 - 1.0)'),
        sa.Column('efficiency_score', sa.Float(), nullable=False, server_default='1.0',
                  comment='效率评分 (耗时/预期耗时)'),
        
        # ========== 环境指纹 ==========
        sa.Column('dimension', sa.String(16), nullable=False, server_default='overworld',
                  comment='维度: overworld | the_nether | the_end'),
        sa.Column('y_level_category', sa.String(16), nullable=False, server_default='surface',
                  comment='Y层级: surface | underground | deep_slate'),
        sa.Column('biome_tag', sa.String(32), nullable=True,
                  comment='生物群系标签'),
        sa.Column('tool_tier', sa.String(16), nullable=True,
                  comment='最高工具等级: wooden | stone | iron | diamond | netherite'),
        
        # ========== 元数据 ==========
        sa.Column('duration_sec', sa.Float(), nullable=False, server_default='0.0',
                  comment='执行耗时 (秒)'),
        sa.Column('reuse_count', sa.Integer(), nullable=False, server_default='0',
                  comment='被复用次数'),
        sa.Column('last_used_at', sa.DateTime(), nullable=True,
                  comment='最后使用时间'),
        sa.Column('created_at', sa.DateTime(), nullable=False,
                  server_default=sa.text("NOW()"),
                  comment='创建时间'),
        
        # ========== 父任务关联 (分层记录) ==========
        sa.Column('parent_experience_id', postgresql.UUID(as_uuid=True), nullable=True,
                  comment='父经验ID (用于宏观任务链)'),
        
        # 外键约束
        sa.ForeignKeyConstraint(
            ['parent_experience_id'], ['task_experiences.id'],
            ondelete='SET NULL'
        ),
    )
    
    # 3. 添加 goal_embedding 列 (VECTOR(1536)) - 使用原生 SQL
    op.execute("""
        ALTER TABLE task_experiences 
        ADD COLUMN goal_embedding VECTOR(1536);
    """)
    op.execute("""
        COMMENT ON COLUMN task_experiences.goal_embedding IS 'Goal vector embedding (1536d)';
    """)
    
    # 4. 创建索引
    # 向量相似度索引 (IVFFlat - 适合中等规模数据)
    op.execute("""
        CREATE INDEX idx_task_experiences_goal_embedding 
        ON task_experiences 
        USING ivfflat (goal_embedding vector_cosine_ops)
        WITH (lists = 100);
    """)
    
    # 普通索引
    op.create_index('idx_task_experiences_dimension', 'task_experiences', ['dimension'])
    op.create_index('idx_task_experiences_outcome', 'task_experiences', ['outcome'])
    op.create_index('idx_task_experiences_created_at', 'task_experiences', ['created_at'])
    
    # GIN 索引 (用于 JSONB 查询)
    op.execute("""
        CREATE INDEX idx_task_experiences_preconditions 
        ON task_experiences 
        USING GIN(preconditions);
    """)


def downgrade() -> None:
    """Drop task_experiences table."""
    op.drop_index('idx_task_experiences_preconditions', table_name='task_experiences')
    op.drop_index('idx_task_experiences_created_at', table_name='task_experiences')
    op.drop_index('idx_task_experiences_outcome', table_name='task_experiences')
    op.drop_index('idx_task_experiences_dimension', table_name='task_experiences')
    op.execute("DROP INDEX IF EXISTS idx_task_experiences_goal_embedding")
    op.drop_table('task_experiences')
