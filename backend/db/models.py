# SQLAlchemy ORM Models for MC_Servant
# 
# 数据模型定义 - 分层记忆系统的持久化层
#
# 表结构:
# - players: 玩家基本信息
# - bots: NPC 助手信息
# - conversation_contexts: 每个玩家-Bot 对的独立记忆 (L0/L1/L2)
# - compression_logs: LLM 压缩操作日志 (可追溯)

from datetime import datetime, timezone, timedelta
from typing import Optional

from sqlalchemy import String, Text, Integer, DateTime, ForeignKey, Boolean
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


# 北京时区 (UTC+8)
BEIJING_TZ = timezone(timedelta(hours=8))


def beijing_now() -> datetime:
    """
    获取当前北京时间 (无时区信息)
    
    返回 naive datetime 以兼容 TIMESTAMP WITHOUT TIME ZONE 列类型
    """
    return datetime.now(BEIJING_TZ).replace(tzinfo=None)


class Base(DeclarativeBase):
    """SQLAlchemy 2.0 声明式基类"""
    pass


class Player(Base):
    """
    玩家表 - 记录 Minecraft 玩家基本信息
    
    使用 Minecraft UUID 作为唯一标识，玩家名可能会变化
    """
    __tablename__ = "players"
    
    id: Mapped[int] = mapped_column(primary_key=True)
    uuid: Mapped[str] = mapped_column(String(36), unique=True, index=True, comment="Minecraft UUID")
    name: Mapped[str] = mapped_column(String(16), comment="当前游戏名")
    
    # 在线状态 (v2 新增)
    is_online: Mapped[bool] = mapped_column(Boolean, default=False, comment="当前是否在线")
    last_login: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, comment="最后登录时间")
    
    created_at: Mapped[datetime] = mapped_column(DateTime, default=beijing_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=beijing_now, onupdate=beijing_now
    )
    
    # 关系
    contexts: Mapped[list["ConversationContext"]] = relationship(
        back_populates="player", cascade="all, delete-orphan"
    )
    
    def __repr__(self) -> str:
        return f"<Player(uuid={self.uuid}, name={self.name}, online={self.is_online})>"


class Bot(Base):
    """
    Bot 表 - 记录 NPC 助手信息
    
    每个 Bot 有独立的人格设定，可以被玩家认领
    设计原则：简单的接口，深度的功能
    """
    __tablename__ = "bots"
    
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(32), unique=True, index=True, comment="Bot 名称")
    personality: Mapped[str] = mapped_column(Text, default="", comment="人格设定 (System Prompt)")
    
    # 所有权信息 (v2 新增 owner_name, skin_url, claimed_at, auto_spawn)
    owner_uuid: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True, comment="当前主人 UUID")
    owner_name: Mapped[Optional[str]] = mapped_column(String(16), nullable=True, comment="当前主人名称")
    skin_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True, comment="皮肤 URL")
    claimed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, comment="认领时间")
    auto_spawn: Mapped[bool] = mapped_column(Boolean, default=True, comment="主人上线时自动生成")
    
    created_at: Mapped[datetime] = mapped_column(DateTime, default=beijing_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=beijing_now, onupdate=beijing_now
    )
    
    # 关系
    contexts: Mapped[list["ConversationContext"]] = relationship(
        back_populates="bot", cascade="all, delete-orphan"
    )
    
    @property
    def is_claimed(self) -> bool:
        """Bot 是否已被认领"""
        return self.owner_uuid is not None
    
    def __repr__(self) -> str:
        return f"<Bot(name={self.name}, owner={self.owner_name})>"


class ConversationContext(Base):
    """
    对话上下文表 - 每个玩家-Bot 对的独立记忆
    
    三层记忆结构:
    - L0 raw_buffer: 原始对话缓冲 (JSONB 数组, 最近 20 轮)
    - L1 episodic_memory: 情景记忆 (自然语言摘要, ~2000 tokens)
    - L2 core_memory: 核心记忆 (高密度信息, ~1000 tokens)
    """
    __tablename__ = "conversation_contexts"
    
    id: Mapped[int] = mapped_column(primary_key=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id", ondelete="CASCADE"), index=True)
    bot_id: Mapped[int] = mapped_column(ForeignKey("bots.id", ondelete="CASCADE"), index=True)
    
    # L0: 工作记忆 (JSONB 数组存储最近对话)
    # 格式: [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]
    raw_buffer: Mapped[list] = mapped_column(JSONB, default=list, comment="L0 原始对话缓冲")
    
    # L1: 情景记忆 (自然语言摘要)
    episodic_memory: Mapped[str] = mapped_column(Text, default="", comment="L1 情景记忆")
    
    # L2: 核心记忆 (高密度信息)
    core_memory: Mapped[str] = mapped_column(Text, default="", comment="L2 核心记忆")
    
    # 元数据
    created_at: Mapped[datetime] = mapped_column(DateTime, default=beijing_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=beijing_now, onupdate=beijing_now
    )
    last_compressed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    compression_count: Mapped[int] = mapped_column(Integer, default=0, comment="压缩次数")
    
    # 关系
    player: Mapped["Player"] = relationship(back_populates="contexts")
    bot: Mapped["Bot"] = relationship(back_populates="contexts")
    compression_logs: Mapped[list["CompressionLog"]] = relationship(
        back_populates="context", cascade="all, delete-orphan"
    )
    
    # 配置常量 (不存储在数据库)
    MAX_BUFFER_ROUNDS: int = 20
    MAX_EPISODIC_CHARS: int = 3000
    MAX_CORE_CHARS: int = 1500
    
    def __repr__(self) -> str:
        return f"<ConversationContext(player_id={self.player_id}, bot_id={self.bot_id})>"
    
    def buffer_is_full(self) -> bool:
        """检查 L0 缓冲区是否已满"""
        # 每轮包含 user + assistant 两条消息
        return len(self.raw_buffer) >= self.MAX_BUFFER_ROUNDS * 2
    
    def episodic_needs_compression(self) -> bool:
        """检查 L1 是否需要压缩到 L2"""
        return len(self.episodic_memory) >= self.MAX_EPISODIC_CHARS


class CompressionLog(Base):
    """
    压缩日志表 - 记录每次 LLM 压缩操作 (可追溯)
    
    用于:
    - 调试和分析压缩质量
    - 追溯信息丢失
    - 统计 Token 消耗
    """
    __tablename__ = "compression_logs"
    
    id: Mapped[int] = mapped_column(primary_key=True)
    context_id: Mapped[int] = mapped_column(
        ForeignKey("conversation_contexts.id", ondelete="CASCADE"), index=True
    )
    compression_type: Mapped[str] = mapped_column(String(10), comment="L0_L1 或 L1_L2")
    input_tokens: Mapped[int] = mapped_column(Integer, comment="输入 Token 数")
    output_tokens: Mapped[int] = mapped_column(Integer, comment="输出 Token 数")
    before_snapshot: Mapped[str] = mapped_column(Text, comment="压缩前内容快照")
    after_snapshot: Mapped[str] = mapped_column(Text, comment="压缩后内容")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=beijing_now)
    
    # 关系
    context: Mapped["ConversationContext"] = relationship(back_populates="compression_logs")
    
    def __repr__(self) -> str:
        return f"<CompressionLog(type={self.compression_type}, tokens={self.input_tokens}->{self.output_tokens})>"
