# Context Manager - The Memory Flow Core
#
# 分层记忆上下文管理器 - 系统的"海马体"
#
# 设计原则：
# - 简单接口：add_message(), get_llm_context()
# - 深度功能：LRU 缓存、细粒度锁、异步压缩
# - 依赖抽象：依赖 ILLMClient, IContextRepository 接口
#
# 并发策略 (用户建议实现)：
# - 每个 (player, bot) 对有独立的锁
# - 压缩时先创建快照，清空 buffer
# - 压缩失败时恢复快照

import asyncio
import logging
from abc import ABC, abstractmethod
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Optional, Dict, Any

from .interfaces import ILLMClient
from .compression import IMemoryCompressor, MemoryCompressor

logger = logging.getLogger(__name__)


# ============================================================
# 配置常量
# ============================================================

MAX_BUFFER_ROUNDS = 20          # L0 缓冲区最大轮数 (每轮 = user + assistant)
MAX_EPISODIC_CHARS = 3000       # L1 情景记忆最大字符数
MAX_CORE_CHARS = 1500           # L2 核心记忆最大字符数
LRU_CACHE_SIZE = 100            # 内存缓存最大条目数


# ============================================================
# 内存中的上下文缓存
# ============================================================

@dataclass
class CachedContext:
    """内存中缓存的对话上下文"""
    ctx_id: int                          # 数据库 ID
    player_uuid: str
    bot_name: str
    raw_buffer: list = field(default_factory=list)      # L0
    episodic_memory: str = ""            # L1
    core_memory: str = ""                # L2
    is_dirty: bool = False               # 是否有未持久化的变更
    is_compressing: bool = False         # 是否正在压缩


# ============================================================
# 抽象接口
# ============================================================

class IContextManager(ABC):
    """
    上下文管理器抽象接口
    
    职责：
    - 管理对话历史的读写
    - 触发和协调记忆压缩
    - 为 LLM 构建上下文
    """
    
    @abstractmethod
    async def add_message(
        self, 
        player_uuid: str, 
        player_name: str,
        bot_name: str, 
        role: str, 
        content: str
    ) -> None:
        """添加一条对话消息"""
        pass
    
    @abstractmethod
    async def get_llm_context(
        self, 
        player_uuid: str, 
        bot_name: str,
        depth: str = "standard"
    ) -> list[dict]:
        """获取适合 LLM 调用的上下文"""
        pass
    
    @abstractmethod
    async def build_chat_context(
        self, 
        player_uuid: str, 
        bot_name: str,
        player_name: str = "",
    ):
        """
        构建完整的聊天上下文
        
        Returns:
            ChatContextResult: 包含消息列表、token 估算和记忆快照
        """
        pass
    
    @abstractmethod
    async def preload_contexts(self, limit: int = 10) -> None:
        """预加载最近活跃的上下文到缓存"""
        pass
    
    @abstractmethod
    async def start_worker(self) -> None:
        """启动后台压缩 Worker"""
        pass
    
    @abstractmethod
    async def stop_worker(self) -> None:
        """停止后台压缩 Worker"""
        pass


# ============================================================
# 具体实现
# ============================================================

class ContextManager(IContextManager):
    """
    分层记忆上下文管理器
    
    Features:
    - LRU 内存缓存 + 数据库双写
    - 细粒度锁保证并发安全
    - 异步压缩队列避免阻塞
    - Bot 个性化注入
    """
    
    def __init__(
        self,
        llm_client: Optional[ILLMClient] = None,
        compressor: Optional[IMemoryCompressor] = None,
        personality_provider = None,  # IPersonalityProvider
    ):
        """
        初始化上下文管理器
        
        Args:
            llm_client: LLM 客户端（用于压缩）
            compressor: 自定义压缩器（可选，默认创建 MemoryCompressor）
            personality_provider: 人格提供者（可选，用于 build_chat_context）
        """
        self._llm = llm_client
        self._compressor = compressor or (MemoryCompressor(llm_client) if llm_client else None)
        self._personality = personality_provider
        
        # LRU 缓存: key -> CachedContext
        self._cache: OrderedDict[str, CachedContext] = OrderedDict()
        
        # 细粒度锁: key -> asyncio.Lock
        self._locks: Dict[str, asyncio.Lock] = {}
        
        # 压缩队列
        self._compression_queue: asyncio.Queue = asyncio.Queue()
        self._worker_task: Optional[asyncio.Task] = None
        self._shutdown_event = asyncio.Event()
        
        logger.info("ContextManager initialized")
    
    def _get_key(self, player_uuid: str, bot_name: str) -> str:
        """生成缓存 key"""
        return f"{player_uuid}:{bot_name}"
    
    def _get_lock(self, key: str) -> asyncio.Lock:
        """获取或创建指定 key 的锁"""
        if key not in self._locks:
            self._locks[key] = asyncio.Lock()
        return self._locks[key]
    
    async def add_message(
        self, 
        player_uuid: str, 
        player_name: str,
        bot_name: str, 
        role: str, 
        content: str
    ) -> None:
        """
        添加一条对话消息
        
        并发安全：使用细粒度锁保护
        """
        key = self._get_key(player_uuid, bot_name)
        lock = self._get_lock(key)
        
        async with lock:
            # 1. 获取或创建上下文
            ctx = await self._get_or_create_cached(player_uuid, player_name, bot_name)
            
            # 2. 添加消息到 buffer
            ctx.raw_buffer.append({
                "role": role,
                "content": content,
            })
            ctx.is_dirty = True
            
            # 3. 写入数据库
            await self._persist_buffer(ctx)
            
            # 4. 检查是否需要压缩
            if self._should_compress_l0(ctx) and not ctx.is_compressing:
                await self._trigger_compression(ctx, key)
            
            logger.debug(f"Added message: {role[:4]}... to {key}, buffer_size={len(ctx.raw_buffer)}")
    
    async def get_llm_context(
        self, 
        player_uuid: str, 
        bot_name: str,
        depth: str = "standard"
    ) -> list[dict]:
        """
        获取适合 LLM 调用的上下文
        
        Args:
            player_uuid: 玩家 UUID
            bot_name: Bot 名称
            depth: 上下文深度
                - "fast": 仅 L0 (最近对话)
                - "standard": L0 + L1 摘要
                - "deep": L0 + L1 + L2 核心记忆
        """
        key = self._get_key(player_uuid, bot_name)
        ctx = self._cache.get(key)
        
        if not ctx:
            # 尝试从数据库加载
            ctx = await self._load_from_db(player_uuid, "", bot_name)
            if not ctx:
                return []
        
        messages = []
        
        # 构建 System 级别的记忆注入
        memory_context = ""
        
        if depth in ("standard", "deep") and ctx.episodic_memory:
            memory_context += f"## 近期经历\n{ctx.episodic_memory}\n\n"
        
        if depth == "deep" and ctx.core_memory:
            memory_context += f"## 核心认知\n{ctx.core_memory}\n\n"
        
        if memory_context:
            messages.append({
                "role": "system",
                "content": f"以下是你对这位玩家的记忆：\n\n{memory_context}"
            })
        
        # 添加 L0 原始对话
        messages.extend(ctx.raw_buffer)
        
        return messages
    
    async def start_worker(self) -> None:
        """启动后台压缩 Worker"""
        if self._worker_task is not None:
            logger.warning("Worker already running")
            return
        
        self._shutdown_event.clear()
        self._worker_task = asyncio.create_task(self._compression_worker())
        logger.info("Compression worker started")
    
    async def stop_worker(self) -> None:
        """优雅关闭后台压缩 Worker"""
        if self._worker_task is None:
            return
        
        logger.info("Stopping compression worker...")
        self._shutdown_event.set()
        
        # 等待队列清空
        try:
            await asyncio.wait_for(self._compression_queue.join(), timeout=30.0)
        except asyncio.TimeoutError:
            logger.warning("Compression queue did not drain in time")
        
        self._worker_task.cancel()
        try:
            await self._worker_task
        except asyncio.CancelledError:
            pass
        
        self._worker_task = None
        logger.info("Compression worker stopped")
    
    # ==================== 内部方法 ====================
    
    async def _get_or_create_cached(
        self, 
        player_uuid: str, 
        player_name: str,
        bot_name: str
    ) -> CachedContext:
        """获取或创建缓存的上下文"""
        key = self._get_key(player_uuid, bot_name)
        
        # 检查缓存
        if key in self._cache:
            # 移动到末尾 (LRU)
            self._cache.move_to_end(key)
            return self._cache[key]
        
        # 从数据库加载或创建
        ctx = await self._load_from_db(player_uuid, player_name, bot_name)
        if ctx is None:
            ctx = await self._create_in_db(player_uuid, player_name, bot_name)
        
        # 加入缓存
        self._cache[key] = ctx
        self._cache.move_to_end(key)
        
        # 清理超出容量的条目
        while len(self._cache) > LRU_CACHE_SIZE:
            evicted_key, evicted_ctx = self._cache.popitem(last=False)
            if evicted_ctx.is_dirty:
                # 异步持久化被驱逐的脏数据
                asyncio.create_task(self._persist_buffer(evicted_ctx))
            logger.debug(f"Cache evicted: {evicted_key}")
        
        return ctx
    
    async def _load_from_db(
        self, 
        player_uuid: str, 
        player_name: str,
        bot_name: str
    ) -> Optional[CachedContext]:
        """从数据库加载上下文"""
        from db.database import db
        from db.context_repository import ContextRepository
        
        try:
            async with db.session() as session:
                repo = ContextRepository(session)
                # 使用 get_or_create，如果不存在会返回新创建的
                db_ctx = await repo.get_or_create(player_uuid, player_name or player_uuid, bot_name)
                
                return CachedContext(
                    ctx_id=db_ctx.id,
                    player_uuid=player_uuid,
                    bot_name=bot_name,
                    raw_buffer=list(db_ctx.raw_buffer) if db_ctx.raw_buffer else [],
                    episodic_memory=db_ctx.episodic_memory or "",
                    core_memory=db_ctx.core_memory or "",
                )
        except Exception as e:
            logger.error(f"Failed to load from DB: {e}")
            return None
    
    async def _create_in_db(
        self, 
        player_uuid: str, 
        player_name: str,
        bot_name: str
    ) -> CachedContext:
        """在数据库中创建新上下文"""
        from db.database import db
        from db.context_repository import ContextRepository
        
        async with db.session() as session:
            repo = ContextRepository(session)
            db_ctx = await repo.get_or_create(player_uuid, player_name, bot_name)
            
            return CachedContext(
                ctx_id=db_ctx.id,
                player_uuid=player_uuid,
                bot_name=bot_name,
            )
    
    async def _persist_buffer(self, ctx: CachedContext) -> None:
        """持久化 buffer 到数据库"""
        from db.database import db
        from db.context_repository import ContextRepository
        
        try:
            async with db.session() as session:
                repo = ContextRepository(session)
                await repo.update_buffer(ctx.ctx_id, ctx.raw_buffer)
            ctx.is_dirty = False
        except Exception as e:
            logger.error(f"Failed to persist buffer: {e}")
    
    def _should_compress_l0(self, ctx: CachedContext) -> bool:
        """检查是否应该触发 L0→L1 压缩"""
        # 每轮 = user + assistant，所以用消息数 / 2
        rounds = len(ctx.raw_buffer) // 2
        return rounds >= MAX_BUFFER_ROUNDS
    
    async def _trigger_compression(self, ctx: CachedContext, key: str) -> None:
        """
        触发异步压缩
        
        策略（用户建议）：
        1. 创建 buffer 快照
        2. 清空原 buffer
        3. 把快照扔给压缩队列
        4. 压缩失败时恢复快照
        """
        # 创建快照
        snapshot = list(ctx.raw_buffer)
        ctx.raw_buffer = []  # 清空 buffer，新消息会写入新的 buffer
        ctx.is_compressing = True
        
        # 放入压缩队列（不等待）
        compression_task = {
            "key": key,
            "ctx_id": ctx.ctx_id,
            "snapshot": snapshot,
            "type": "L0_L1",
        }
        await self._compression_queue.put(compression_task)
        
        logger.info(f"Compression triggered for {key}, snapshot_size={len(snapshot)}")
    
    async def _compression_worker(self) -> None:
        """后台压缩 Worker"""
        logger.info("Compression worker loop started")
        
        while not self._shutdown_event.is_set():
            try:
                # 从队列获取任务（带超时以便检查 shutdown）
                try:
                    task = await asyncio.wait_for(
                        self._compression_queue.get(),
                        timeout=1.0
                    )
                except asyncio.TimeoutError:
                    continue
                
                key = task["key"]
                ctx_id = task["ctx_id"]
                snapshot = task["snapshot"]
                comp_type = task["type"]
                
                logger.info(f"Processing compression: {key}, type={comp_type}")
                
                try:
                    if comp_type == "L0_L1":
                        await self._do_l0_to_l1_compression(key, ctx_id, snapshot)
                    elif comp_type == "L1_L2":
                        await self._do_l1_to_l2_compression(key, ctx_id)
                except Exception as e:
                    logger.error(f"Compression failed: {e}")
                    # 恢复快照到 buffer
                    await self._restore_snapshot(key, snapshot)
                finally:
                    self._compression_queue.task_done()
                    
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Worker error: {e}")
    
    async def _do_l0_to_l1_compression(
        self, 
        key: str, 
        ctx_id: int, 
        snapshot: list
    ) -> None:
        """执行 L0→L1 压缩"""
        if not self._compressor:
            logger.warning("No compressor available, skipping L0→L1")
            return
        
        from db.database import db
        from db.context_repository import ContextRepository
        
        # 调用 LLM 压缩
        result = await self._compressor.compress_with_result(
            "L0_L1",
            raw_buffer=snapshot,
        )
        
        if not result.success:
            raise Exception(f"Compression failed: {result.error}")
        
        # 获取锁并更新
        lock = self._get_lock(key)
        async with lock:
            # 更新数据库
            async with db.session() as session:
                repo = ContextRepository(session)
                await repo.update_memories(
                    ctx_id,
                    episodic=result.content,
                    clear_buffer=False,  # buffer 已经清空了
                )
                
                # 记录压缩日志
                before_text = "\n".join([f"[{m['role']}] {m['content']}" for m in snapshot])
                await repo.log_compression(
                    ctx_id,
                    "L0_L1",
                    result.input_length,
                    result.output_length,
                    before_text,
                    result.content,
                )
            
            # 更新内存缓存
            if key in self._cache:
                ctx = self._cache[key]
                if ctx.episodic_memory:
                    ctx.episodic_memory = ctx.episodic_memory + "\n\n---\n\n" + result.content
                else:
                    ctx.episodic_memory = result.content
                ctx.is_compressing = False
                
                # 检查是否需要 L1→L2 压缩
                if len(ctx.episodic_memory) >= MAX_EPISODIC_CHARS:
                    await self._trigger_l1_to_l2_compression(ctx, key)
        
        logger.info(f"L0→L1 compression completed for {key}")
    
    async def _do_l1_to_l2_compression(self, key: str, ctx_id: int) -> None:
        """执行 L1→L2 压缩"""
        if not self._compressor:
            logger.warning("No compressor available, skipping L1→L2")
            return
        
        from db.database import db
        from db.context_repository import ContextRepository
        
        # 获取当前的 L1 和 L2
        ctx = self._cache.get(key)
        if not ctx:
            return
        
        old_episodic = ctx.episodic_memory
        old_core = ctx.core_memory
        
        # 调用 LLM 压缩
        result = await self._compressor.compress_with_result(
            "L1_L2",
            episodic=old_episodic,
            old_core=old_core,
        )
        
        if not result.success:
            logger.error(f"L1→L2 compression failed: {result.error}")
            return
        
        # 获取锁并更新
        lock = self._get_lock(key)
        async with lock:
            # 更新数据库
            async with db.session() as session:
                repo = ContextRepository(session)
                await repo.update_memories(
                    ctx_id,
                    episodic="",  # 清空 L1
                    core=result.content,  # 更新 L2
                )
                
                # 记录压缩日志
                await repo.log_compression(
                    ctx_id,
                    "L1_L2",
                    result.input_length,
                    result.output_length,
                    old_episodic + "\n\n" + old_core,
                    result.content,
                )
            
            # 更新内存缓存
            if key in self._cache:
                ctx = self._cache[key]
                ctx.episodic_memory = ""
                ctx.core_memory = result.content
        
        logger.info(f"L1→L2 compression completed for {key}")
    
    async def _trigger_l1_to_l2_compression(self, ctx: CachedContext, key: str) -> None:
        """触发 L1→L2 压缩"""
        compression_task = {
            "key": key,
            "ctx_id": ctx.ctx_id,
            "snapshot": None,  # L1→L2 不需要快照
            "type": "L1_L2",
        }
        await self._compression_queue.put(compression_task)
        logger.info(f"L1→L2 compression triggered for {key}")
    
    async def _restore_snapshot(self, key: str, snapshot: list) -> None:
        """压缩失败时恢复快照"""
        lock = self._get_lock(key)
        async with lock:
            if key in self._cache:
                ctx = self._cache[key]
                # 把快照插入到 buffer 开头
                ctx.raw_buffer = snapshot + ctx.raw_buffer
                ctx.is_compressing = False
                ctx.is_dirty = True
                
                # 持久化恢复后的 buffer
                await self._persist_buffer(ctx)
                
                logger.warning(f"Snapshot restored for {key}")
    
    # ==================== Phase 4 新增方法 ====================
    
    async def build_chat_context(
        self, 
        player_uuid: str, 
        bot_name: str,
        player_name: str = "",
    ):
        """
        构建完整的聊天上下文
        
        整合人格设定、核心记忆、情景记忆和对话历史
        
        Returns:
            ChatContextResult: 包含消息列表、token 估算和记忆快照
        """
        from .personality import ChatContextResult, estimate_tokens
        
        key = self._get_key(player_uuid, bot_name)
        ctx = self._cache.get(key)
        
        if not ctx:
            # 尝试从数据库加载
            ctx = await self._load_from_db(player_uuid, player_name or player_uuid, bot_name)
            if not ctx:
                # 返回空的上下文结果
                return ChatContextResult(
                    messages=[],
                    token_count=0,
                    memory_snapshot="",
                    personality_used="",
                    memory_depth="none",
                )
        
        messages = []
        memory_parts = []
        personality_text = ""
        
        # 1. 构建 System Prompt（人格 + 记忆）
        if self._personality:
            system_prompt = await self._personality.build_system_prompt(
                bot_name=bot_name,
                core_memory=ctx.core_memory,
                episodic_memory=ctx.episodic_memory,
                player_name=player_name,
            )
            personality_text = await self._personality.get_personality(bot_name)
        else:
            # 降级：使用简单的 System Prompt
            system_prompt = f"你是 {bot_name}，一个 Minecraft 猫娘女仆助手。"
            if ctx.core_memory:
                system_prompt += f"\n\n## 核心记忆\n{ctx.core_memory}"
            if ctx.episodic_memory:
                system_prompt += f"\n\n## 近期经历\n{ctx.episodic_memory[-1000:]}"
        
        messages.append({"role": "system", "content": system_prompt})
        
        # 2. 添加 L0 对话历史
        messages.extend(ctx.raw_buffer)
        
        # 3. 构建记忆快照（用于调试）
        if ctx.core_memory:
            memory_parts.append(f"[L2 核心记忆]\n{ctx.core_memory}")
        if ctx.episodic_memory:
            memory_parts.append(f"[L1 情景记忆]\n{ctx.episodic_memory[:500]}...")
        memory_parts.append(f"[L0 对话缓冲] {len(ctx.raw_buffer)} 条消息")
        
        memory_snapshot = "\n---\n".join(memory_parts)
        
        # 4. 估算 Token 数
        total_text = system_prompt + "".join(m.get("content", "") for m in ctx.raw_buffer)
        token_count = estimate_tokens(total_text)
        
        # 5. 确定记忆深度
        if ctx.core_memory:
            depth = "deep"
        elif ctx.episodic_memory:
            depth = "standard"
        else:
            depth = "fast"
        
        return ChatContextResult(
            messages=messages,
            token_count=token_count,
            memory_snapshot=memory_snapshot,
            personality_used=personality_text,
            memory_depth=depth,
        )
    
    async def preload_contexts(self, limit: int = 10) -> None:
        """
        预加载最近活跃的上下文到缓存
        
        在服务启动时调用，减少首次对话的延迟
        """
        from db.database import db
        from db.context_repository import ContextRepository
        
        try:
            async with db.session() as session:
                repo = ContextRepository(session)
                recent_contexts = await repo.get_recent_contexts(limit)
                
                for db_ctx in recent_contexts:
                    # 需要获取 player_uuid 和 bot_name
                    # 这里需要查询关联的 Player 和 Bot
                    player = db_ctx.player
                    bot = db_ctx.bot
                    
                    if player and bot:
                        key = self._get_key(player.uuid, bot.name)
                        
                        if key not in self._cache:
                            self._cache[key] = CachedContext(
                                ctx_id=db_ctx.id,
                                player_uuid=player.uuid,
                                bot_name=bot.name,
                                raw_buffer=list(db_ctx.raw_buffer) if db_ctx.raw_buffer else [],
                                episodic_memory=db_ctx.episodic_memory or "",
                                core_memory=db_ctx.core_memory or "",
                            )
                
                logger.info(f"Preloaded {len(recent_contexts)} contexts")
                
        except Exception as e:
            logger.warning(f"Failed to preload contexts: {e}")

