# Memory Facade
# 统一记忆服务门面 - 系统的"海马体"
#
# 设计原则：
# - 简单接口：add_message() 是同步的，调用者无感知
# - 深度功能：内部异步持久化 + 会话管理 + 分层压缩
# - 依赖抽象：依赖 IContextManager 接口
#
# 架构位置：
# - BotContext.memory -> MemoryFacade -> ContextManager (DB)
#                                     -> Session (内存)

import logging
from abc import ABC, abstractmethod
from typing import List, Dict, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from utils.background_task_manager import BackgroundTaskManager
    from llm.context_manager import IContextManager

from .session import Session, SessionMessage

logger = logging.getLogger(__name__)


class IMemoryService(ABC):
    """
    统一记忆服务接口
    
    设计原则：简单接口，深度功能
    """
    
    @abstractmethod
    def add_message(
        self,
        role: str,
        content: str,
        sender_uuid: str,
        sender_name: str,
    ) -> None:
        """添加消息 (同步接口，内部异步持久化)"""
        pass
    
    @abstractmethod
    async def get_llm_context(self, depth: str = "standard") -> List[Dict]:
        """获取 LLM 上下文 (L0 + L1/L2 摘要)"""
        pass
    
    @abstractmethod
    def start_session(self, owner_uuid: str, owner_name: str) -> str:
        """开启新会话，返回 session_id"""
        pass
    
    @abstractmethod
    def end_session(self) -> Optional[str]:
        """结束当前会话，返回会话摘要"""
        pass
    
    @abstractmethod
    async def restore_on_startup(self) -> None:
        """启动时从 DB 恢复对话历史"""
        pass
    
    @abstractmethod
    def get_hot_buffer(self) -> List[Dict]:
        """获取热缓冲区 (兼容旧接口)"""
        pass
    
    @abstractmethod
    async def flush_pending(self) -> None:
        """优雅关闭：等待所有后台任务完成"""
        pass


class MemoryFacade(IMemoryService):
    """
    统一记忆门面
    
    桥接 RuntimeContext 和 ContextManager，提供：
    - 会话管理 (Session)
    - 消息归属标记
    - 异步持久化
    - 优雅关闭
    
    使用示例:
        memory = MemoryFacade(context_manager, task_manager, "Bot_001")
        memory.start_session(owner_uuid="player_123", owner_name="Steve")
        memory.add_message("user", "去挖铁矿", "player_123", "Steve")
        context = await memory.get_llm_context()
    """
    
    def __init__(
        self,
        context_manager: Optional["IContextManager"],
        task_manager: Optional["BackgroundTaskManager"],
        bot_name: str,
        max_buffer_size: int = 20,
    ):
        self._ctx_manager = context_manager
        self._task_manager = task_manager
        self._bot_name = bot_name
        self._max_buffer_size = max_buffer_size
        
        # 当前会话
        self._current_session: Optional[Session] = None
        
        # 历史会话摘要 (用于构建 System Prompt)
        self._session_summaries: List[str] = []
        
        logger.info(f"MemoryFacade initialized for {bot_name}")
    
    # ==================== 会话管理 ====================
    
    def start_session(self, owner_uuid: str, owner_name: str) -> str:
        """
        开启新会话 (Claim 时调用)
        
        Args:
            owner_uuid: 新主人的 UUID
            owner_name: 新主人的名称
            
        Returns:
            新会话的 session_id
        """
        # 如果有旧会话，先结束
        if self._current_session and self._current_session.is_active:
            self.end_session()
        
        # 创建新会话
        self._current_session = Session.create(
            owner_uuid=owner_uuid,
            owner_name=owner_name,
            bot_name=self._bot_name,
        )
        
        logger.info(
            f"Session started: id={self._current_session.session_id}, "
            f"owner={owner_name}"
        )
        
        return self._current_session.session_id
    
    def end_session(self) -> Optional[str]:
        """
        结束当前会话 (Release 时调用)
        
        Returns:
            会话摘要 (用于长期记忆)
        """
        if not self._current_session:
            return None
        
        session = self._current_session
        
        # 生成会话摘要
        summary = self._generate_session_summary(session)
        session.end(summary)
        
        # 保存摘要到历史
        if summary:
            self._session_summaries.append(summary)
            # 只保留最近 10 个会话摘要
            if len(self._session_summaries) > 10:
                self._session_summaries = self._session_summaries[-10:]
        
        # 异步持久化所有剩余消息
        self._flush_session_to_db(session)
        
        logger.info(
            f"Session ended: id={session.session_id}, "
            f"messages={session.message_count}, "
            f"duration={session.duration_seconds:.1f}s"
        )
        
        self._current_session = None
        return summary
    
    def _generate_session_summary(self, session: Session) -> Optional[str]:
        """生成会话摘要"""
        if session.message_count == 0:
            return None
        
        # 简单摘要：记录基本信息
        # TODO: 可以用 LLM 生成更智能的摘要
        owner_msgs = session.owner_message_count
        duration = session.duration_seconds
        
        summary = (
            f"Session #{session.session_id}: "
            f"与 {session.owner_name} 对话 {owner_msgs} 轮, "
            f"持续 {duration:.0f} 秒"
        )
        
        return summary
    
    def _flush_session_to_db(self, session: Session) -> None:
        """将会话消息刷入数据库"""
        if not self._ctx_manager or not self._task_manager:
            return
        
        for msg in session.messages:
            self._task_manager.fire_and_forget(
                self._persist_message(
                    role=msg.role,
                    content=msg.content,
                    sender_uuid=msg.sender_uuid,
                    sender_name=msg.sender_name,
                )
            )
    
    # ==================== 消息管理 ====================
    
    def add_message(
        self,
        role: str,
        content: str,
        sender_uuid: str,
        sender_name: str,
    ) -> None:
        """
        添加消息 - 同步接口
        
        内部逻辑:
        1. 立即更新内存会话 (微秒级)
        2. 异步 fire-and-forget 持久化到 DB
        """
        # 确保有会话
        if not self._current_session:
            # 自动创建临时会话
            self.start_session(sender_uuid, sender_name)
        
        # 1. 同步更新会话
        self._current_session.add_message(
            role=role,
            content=content,
            sender_uuid=sender_uuid,
            sender_name=sender_name,
        )
        
        # 2. 异步持久化
        if self._ctx_manager and self._task_manager:
            self._task_manager.fire_and_forget(
                self._persist_message(role, content, sender_uuid, sender_name)
            )
        
        logger.debug(
            f"Message added: role={role[:4]}, sender={sender_name}, "
            f"session_msgs={self._current_session.message_count}"
        )
    
    async def _persist_message(
        self,
        role: str,
        content: str,
        sender_uuid: str,
        sender_name: str,
    ) -> None:
        """后台持久化任务"""
        if not self._ctx_manager:
            return
        
        try:
            # 使用会话主人的 UUID 作为 player_uuid
            owner_uuid = (
                self._current_session.owner_uuid 
                if self._current_session 
                else sender_uuid
            )
            
            await self._ctx_manager.add_message(
                player_uuid=owner_uuid,
                player_name=sender_name,
                bot_name=self._bot_name,
                role=role,
                content=content,
            )
        except Exception as e:
            logger.warning(f"Memory persist failed (non-critical): {e}")
    
    # ==================== 上下文获取 ====================
    
    async def get_llm_context(self, depth: str = "standard") -> List[Dict]:
        """
        获取 LLM 上下文
        
        Args:
            depth: 上下文深度
                - "fast": 仅热缓冲区
                - "standard": + L1 摘要
                - "deep": + L2 核心记忆
        """
        messages = []
        
        # 1. 添加历史会话摘要 (作为 System 消息的一部分)
        if self._session_summaries:
            summaries_text = "\n".join(self._session_summaries[-5:])
            # 注意：这个会在外层被整合到 System Prompt
            messages.append({
                "role": "system",
                "content": f"## 你的近期经历\n{summaries_text}",
            })
        
        # 2. 如果有 ContextManager，获取 L1/L2 记忆
        if self._ctx_manager and self._current_session and depth != "fast":
            try:
                db_context = await self._ctx_manager.get_llm_context(
                    player_uuid=self._current_session.owner_uuid,
                    bot_name=self._bot_name,
                    depth=depth,
                )
                # 只取 system 角色的记忆注入
                for msg in db_context:
                    if msg.get("role") == "system":
                        messages.append(msg)
            except Exception as e:
                logger.warning(f"Failed to get DB context: {e}")
        
        # 3. 添加当前会话的对话历史 (带归属标记)
        if self._current_session:
            session_msgs = self._current_session.get_context_with_ownership(
                max_messages=self._max_buffer_size
            )
            messages.extend(session_msgs)
        
        return messages
    
    def get_hot_buffer(self) -> List[Dict]:
        """
        获取热缓冲区 (兼容旧接口)
        
        返回当前会话的消息，格式为 [{"role": ..., "content": ...}, ...]
        """
        if not self._current_session:
            return []
        
        return self._current_session.get_messages_for_llm(
            include_bystanders=False,
            max_messages=self._max_buffer_size,
        )
    
    # ==================== 生命周期 ====================
    
    async def restore_on_startup(self) -> None:
        """
        启动时恢复对话历史
        
        策略:
        1. 不自动恢复旧会话 (需要新的 Claim)
        2. 预加载 ContextManager 的上下文缓存
        """
        if self._ctx_manager:
            try:
                await self._ctx_manager.preload_contexts(limit=5)
                logger.info("Memory contexts preloaded")
            except Exception as e:
                logger.warning(f"Memory restore failed: {e}")
    
    async def flush_pending(self) -> None:
        """优雅关闭：等待所有后台任务完成"""
        # 先结束当前会话
        if self._current_session and self._current_session.is_active:
            self.end_session()
        
        # 等待后台任务
        if self._task_manager:
            count = await self._task_manager.wait_all_pending(timeout=30.0)
            logger.info(f"Memory facade shutdown: {count} tasks completed")
    
    # ==================== 属性访问 ====================
    
    @property
    def current_session(self) -> Optional[Session]:
        """当前会话"""
        return self._current_session
    
    @property
    def current_owner_uuid(self) -> Optional[str]:
        """当前主人 UUID"""
        return self._current_session.owner_uuid if self._current_session else None
    
    @property
    def current_owner_name(self) -> Optional[str]:
        """当前主人名称"""
        return self._current_session.owner_name if self._current_session else None
    
    @property
    def has_active_session(self) -> bool:
        """是否有活跃会话"""
        return self._current_session is not None and self._current_session.is_active
