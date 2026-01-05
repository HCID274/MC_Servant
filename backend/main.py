# MC_Servant Backend - Main Entry Point

"""
FastAPI + WebSocket 服务器入口

启动命令:
    python main.py
    
或使用 uvicorn:
    uvicorn main:app --host 0.0.0.0 --port 8765 --reload
"""

import asyncio
import logging
import json
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

from config import settings
from websocket.connection_manager import manager
from websocket.handlers import MessageRouter
from bot.mineflayer_adapter import BotManager
from protocol import NpcResponse, MessageType
from bot.lifecycle_manager import BotLifecycleManager
from state.context import BotContext
from text_utils import split_to_segments

# ============================================================================
# 日志配置 - 简洁可读
# ============================================================================

# 自定义简洁格式
class SimpleFormatter(logging.Formatter):
    """简洁日志格式器 - 只显示关键信息"""
    
    # ANSI 颜色代码
    COLORS = {
        'DEBUG': '\033[36m',    # 青色
        'INFO': '\033[32m',     # 绿色
        'WARNING': '\033[33m',  # 黄色
        'ERROR': '\033[31m',    # 红色
        'CRITICAL': '\033[35m', # 紫色
        'RESET': '\033[0m',
    }
    
    def format(self, record):
        # 简化模块名（只取最后两级）
        name_parts = record.name.split('.')
        short_name = '.'.join(name_parts[-2:]) if len(name_parts) > 1 else record.name
        
        # 时间只显示 时:分:秒
        time_str = time.strftime('%H:%M:%S', time.localtime(record.created))
        
        # 级别简写
        level_short = record.levelname[0]  # I/D/W/E
        color = self.COLORS.get(record.levelname, '')
        reset = self.COLORS['RESET']
        
        # 格式: [时间] 级别 模块: 消息
        return f"{color}[{time_str}] {level_short} {short_name}: {record.getMessage()}{reset}"

# 配置根日志器
root_logger = logging.getLogger()
root_logger.setLevel(getattr(logging, settings.log_level))

# 清除默认处理器
for handler in root_logger.handlers[:]:
    root_logger.removeHandler(handler)

# 添加控制台处理器
console_handler = logging.StreamHandler()
console_handler.setFormatter(SimpleFormatter())
root_logger.addHandler(console_handler)

# 抑制嘈杂的第三方库日志
QUIET_LOGGERS = [
    'openai',
    'httpx',
    'httpcore',
    'asyncio',
    'uvicorn.access',
    'uvicorn.error',
    'websockets',
    'javascript',
    'aiosqlite',
    'sqlalchemy',
]
for name in QUIET_LOGGERS:
    logging.getLogger(name).setLevel(logging.WARNING)

# 主模块日志器
logger = logging.getLogger(__name__)

# 全局管理器
bot_manager: Optional[BotManager] = None
message_router: Optional[MessageRouter] = None
llm_client = None  # LLM 客户端 (Optional)
state_machine = None  # 状态机 (Optional)
context_manager = None  # 记忆上下文管理器 (Optional)
lifecycle_manager = None  # 生命周期管理器 (Optional)
player_repo = None  # 玩家数据仓库 (Optional)
bot_repo = None  # Bot 数据仓库 (Optional)
ws_cleanup_task: Optional[asyncio.Task] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    global bot_manager, message_router, llm_client, state_machine, context_manager, lifecycle_manager, player_repo, bot_repo, ws_cleanup_task
    
    # 启动时初始化
    logger.info("Initializing MC_Servant Backend...")

    # 必填配置校验
    if not settings.bot_password or not settings.bot_password.strip():
        logger.error("MC_SERVANT_BOT_PASSWORD is required but missing")
        raise RuntimeError("MC_SERVANT_BOT_PASSWORD is required")
    if not settings.ws_access_token or not settings.ws_access_token.strip():
        logger.error("MC_SERVANT_WS_ACCESS_TOKEN is required but missing")
        raise RuntimeError("MC_SERVANT_WS_ACCESS_TOKEN is required")
    
    # 初始化数据库连接
    try:
        from db.database import db
        await db.init(settings.database_url, echo=settings.db_echo)
        logger.info("Database initialized")
        
        # 初始化数据仓库
        from db.player_repository import PlayerRepository
        from db.bot_repository import BotRepository
        player_repo = PlayerRepository()
        bot_repo = BotRepository()
        logger.info("Data repositories initialized")
    except Exception as e:
        logger.warning(f"Database initialization failed (memory mode): {e}")
    
    # 初始化 LLM 客户端 (如果配置了 API Key)
    try:
        from llm.factory import create_llm_client
        llm_client = await create_llm_client()
        if llm_client:
            logger.info(f"LLM client initialized: {llm_client.model_name}")

            from llm.context_manager import ContextManager
            context_manager = ContextManager(llm_client=llm_client)
            await context_manager.start_worker()
            logger.info("ContextManager initialized with compression worker")
        else:
            logger.info("LLM not configured (no API key), using fallback intent recognition")
    except Exception as e:
        logger.warning(f"Failed to initialize LLM client: {e}")
        llm_client = None
    
    bot_manager = BotManager(
        mc_host=settings.mc_host,
        mc_port=settings.mc_port,
        default_password=settings.bot_password
    )
    
    # 生成默认 Bot
    try:
        default_bot = await bot_manager.spawn_bot(settings.bot_username)
        logger.info(f"Default bot spawned: {settings.bot_username}")
        
        # Phase 1 Actions 验证完成，测试代码已删除
        
        # ========== 构建依赖图 (Layer 1 → Layer 3) ==========
        from pathlib import Path
        from state.machine import StateMachine
        from state.config import BotConfig
        from bot.actions import MineflayerActions
        from task.executor import TaskExecutor
        from task.llm_planner import LLMTaskPlanner
        from task.prerequisite_resolver import PrerequisiteResolver
        
        config_path = Path("data/bot_config.json")
        
        # 加载或创建配置，确保 bot_name 是真实的 Bot 用户名
        bot_config = BotConfig.load(config_path)
        bot_config.bot_name = default_bot.username
        bot_config.save(config_path)
        
        # Layer 2: 动作层 (依赖 Layer 1 bot)
        actions = MineflayerActions(default_bot)
        logger.info("MineflayerActions initialized")

        bot_context = BotContext(
            runtime=None,  # 稍后回填 RuntimeContext
            executor=None,
            actions=actions,
            llm=llm_client,
            bot=default_bot,  # 表演动作：spin, look_at, jump
        )
        
        # Layer 3: 规划/执行层 (如果有 LLM)
        executor = None
        if llm_client:
            planner = LLMTaskPlanner(llm_client)
            prereq_resolver = PrerequisiteResolver()
            async def on_progress(msg: str) -> None:
                await bot_context.update_hologram_throttled(f"🔧 {msg}")
            
            # ========== 新架构: Actor + Resolver ==========
            # 初始化知识库
            from perception.knowledge_base import JsonKnowledgeBase
            knowledge_base = JsonKnowledgeBase()
            logger.info("KnowledgeBase initialized")
            
            # 初始化 Actor 和 Resolver
            from task.actor import LLMTaskActor
            from task.action_resolver import SemanticActionResolver
            actor = LLMTaskActor(llm_client, knowledge_base)
            resolver = SemanticActionResolver(knowledge_base)
            logger.info("LLMTaskActor and SemanticActionResolver initialized")
            
                        # 🆕 Phase 3+ RunnerFactory (根据 Feature Flag 自动切换)
            from task.behavior_rules import BehaviorRules
            from task.runner_factory import create_runner_factory
            
            rules = BehaviorRules()
            runner_factory = create_runner_factory(
                rules=rules,
                actor=actor,
                resolver=resolver,
                llm_client=llm_client,  # 🆕 Phase 3+: LLM 驱动恢复
            )
            logger.info(f"RunnerFactory initialized: {runner_factory.__class__.__name__}")

            executor = TaskExecutor(
                planner,
                actions,
                prereq_resolver,
                on_progress=on_progress,
                runner_factory=runner_factory,  # 🆕 使用 factory 而非 registry
            )
            bot_context.executor = executor
            logger.info("TaskExecutor initialized with RunnerFactory architecture")
        else:
            logger.warning("No LLM client, TaskExecutor not initialized")
        
        # 创建 BotContext (DI 容器)
        
        # 创建状态机
        state_machine = StateMachine(
            config=bot_config,
            config_path=config_path,
            llm_client=llm_client,
            bot_controller=default_bot,
            bot_context=bot_context,
            executor=executor,
        )
        
        # 回填 runtime 到 BotContext
        bot_context.runtime = state_machine._context
        
        # 设置事件驱动回调 - 当后台任务生成事件时自动处理
        async def on_event_queued(event_type, payload):
            """事件回调：后台任务生成事件时触发"""
            logger.debug(f"Event queued: {event_type}, triggering process_pending_events")
            await state_machine.process_pending_events()
        
        bot_context.on_event_queued = on_event_queued
        
        logger.info(f"State machine initialized: state={state_machine.current_state.name}, bot={bot_config.bot_name}, executor={'✓' if executor else '✗'}")
        
        # 初始化生命周期管理器
        lifecycle_manager = BotLifecycleManager(
            bot_manager=bot_manager,
            config_path=config_path,
            ws_manager=manager,
            timeout_hours=10.0  # 主人离线后 10h 下线
        )
        logger.info("Lifecycle manager initialized")
        
        # 确保 Bot 存在于数据库中
        if bot_repo:
            try:
                await bot_repo.upsert(
                    name=default_bot.username,
                    personality=bot_config.personality if hasattr(bot_config, 'personality') else "",
                    auto_spawn=True
                )
                logger.info(f"Bot '{default_bot.username}' synced to database")
            except Exception as e:
                logger.warning(f"Failed to sync bot to database: {e}")
        
        # 创建 WebSocket 发送回调函数 (用于同步消息)
        async def ws_send_func(msg: dict):
            await manager.broadcast(json.dumps(msg, ensure_ascii=False))

        def _resolve_target_player() -> Optional[str]:
            task = state_machine.context.current_task if state_machine else None
            if task and isinstance(task.params, dict):
                target = task.params.get("requesting_player")
                if target:
                    return target
            if state_machine and state_machine.config.owner_name:
                return state_machine.config.owner_name
            return None

        async def on_hologram_update(text: str) -> None:
            msg = {
                "type": "hologram_update",
                "npc": bot_config.bot_name,
                "hologram_text": text,
                "identity_line": None,
            }
            await ws_send_func(msg)

        async def on_chat_message(content: str) -> None:
            target_player = _resolve_target_player()
            if not target_player:
                logger.debug("No target player for chat message, skipping send")
                return
            response = NpcResponse(
                npc=bot_config.bot_name,
                target_player=target_player,
                content=content,
                segments=split_to_segments(content),
            )
            await ws_send_func(response.model_dump())

        async def on_npc_response(response: dict) -> None:
            if "target_player" not in response:
                target_player = _resolve_target_player()
                if target_player:
                    response["target_player"] = target_player
            response.setdefault("type", MessageType.NPC_RESPONSE.value)
            response.setdefault("npc", bot_config.bot_name)
            await ws_send_func(response)

        bot_context.on_hologram_update = on_hologram_update
        bot_context.on_chat_message = on_chat_message
        bot_context.on_npc_response = on_npc_response
        
        # 初始化消息路由器 (with LLM client, state machine, context manager, and repositories)
        message_router = MessageRouter(
            bot_controller=default_bot,
            llm_client=llm_client,
            state_machine=state_machine,
            bot_manager=bot_manager,
            context_manager=context_manager,
            player_repo=player_repo,
            bot_repo=bot_repo,
            lifecycle_manager=lifecycle_manager,
            ws_send_func=ws_send_func,
        )
    except Exception as e:
        logger.warning(f"Failed to spawn default bot: {e}")
        logger.info("Will try to spawn bot when Java plugin connects")
        # 创建一个 Mock Bot 用于测试
        from bot.interfaces import IBotController
        
        class MockBot(IBotController):
            """Mock Bot for testing without Minecraft"""
            @property
            def is_connected(self) -> bool: return True
            @property
            def username(self) -> str: return "MockBot"
            async def connect(self) -> bool: return True
            async def disconnect(self) -> None: pass
            async def jump(self) -> bool:
                logger.info("[MockBot] Jump!")
                return True
            async def spin(self, rotations: int = 1, duration: float = 1.0) -> bool:
                logger.info(f"[MockBot] Spin {rotations} times!")
                return True
            async def look_at(self, target: str) -> bool:
                logger.info(f"[MockBot] Look at {target}")
                return True
            async def chat(self, message: str) -> bool:
                logger.info(f"[MockBot] Chat: {message}")
                return True
            async def get_position(self):
                return (0.0, 64.0, 0.0)
        
        # 初始化状态机 (with MockBot)
        from pathlib import Path
        from state.machine import StateMachine
        
        mock_bot = MockBot()
        config_path = Path("data/bot_config.json")
        
        # 先创建 BotContext
        bot_context = BotContext(
            runtime=None,  # 稍后回填 RuntimeContext
            executor=None, # MockBot 模式下暂不需要 Executor (或者由于没有 Java 连接无法工作)
            actions=None,  # MockBot 暂无 Actions
            llm=llm_client,
            bot=mock_bot,  # 表演动作 (MockBot)
        )

        state_machine = StateMachine(
            config_path=config_path,
            llm_client=llm_client,
            bot_controller=mock_bot,
            bot_context=bot_context, # 传入上下文
        )
        
        # 回填 runtime 到 BotContext
        bot_context.runtime = state_machine._context
        
        logger.info(f"State machine initialized (MockBot): state={state_machine.current_state.name}")
        
        # 创建 WebSocket 发送回调函数 (MockBot 模式)
        async def ws_send_func(msg: dict):
            await manager.broadcast(json.dumps(msg, ensure_ascii=False))

        def _resolve_target_player() -> Optional[str]:
            task = state_machine.context.current_task if state_machine else None
            if task and isinstance(task.params, dict):
                target = task.params.get("requesting_player")
                if target:
                    return target
            if state_machine and state_machine.config.owner_name:
                return state_machine.config.owner_name
            return None

        async def on_hologram_update(text: str) -> None:
            msg = {
                "type": "hologram_update",
                "npc": state_machine.config.bot_name,
                "hologram_text": text,
                "identity_line": None,
            }
            await ws_send_func(msg)

        async def on_chat_message(content: str) -> None:
            target_player = _resolve_target_player()
            if not target_player:
                logger.debug("No target player for chat message, skipping send")
                return
            response = NpcResponse(
                npc=state_machine.config.bot_name,
                target_player=target_player,
                content=content,
                segments=split_to_segments(content),
            )
            await ws_send_func(response.model_dump())

        async def on_npc_response(response: dict) -> None:
            if "target_player" not in response:
                target_player = _resolve_target_player()
                if target_player:
                    response["target_player"] = target_player
            response.setdefault("type", MessageType.NPC_RESPONSE.value)
            response.setdefault("npc", state_machine.config.bot_name)
            await ws_send_func(response)

        bot_context.on_hologram_update = on_hologram_update
        bot_context.on_chat_message = on_chat_message
        bot_context.on_npc_response = on_npc_response

        # 让 ContextManager 的后台压缩可以发“整理记忆中/完成”的用户提示（不阻塞主流程）
        if context_manager:
            async def _on_ctx_status(bot_name: str, text: str) -> None:
                msg = {
                    "type": MessageType.HOLOGRAM_UPDATE.value,
                    "npc": bot_name,
                    "hologram_text": text,
                    "identity_line": None,
                }
                await ws_send_func(msg)

            context_manager.set_status_callback(_on_ctx_status)

        async def on_event_queued(event_type, payload):
            logger.debug(f"Event queued: {event_type}, triggering process_pending_events")
            await state_machine.process_pending_events()

        bot_context.on_event_queued = on_event_queued
        
        message_router = MessageRouter(
            bot_controller=mock_bot,
            llm_client=llm_client,
            state_machine=state_machine,
            bot_manager=bot_manager,
            context_manager=context_manager,
            player_repo=player_repo,
            bot_repo=bot_repo,
            lifecycle_manager=lifecycle_manager,
            ws_send_func=ws_send_func,
        )
    
    # 启动连接清理任务
    async def ws_cleanup_worker() -> None:
        interval = max(5, settings.ws_heartbeat_timeout_seconds // 3)
        while True:
            try:
                await asyncio.sleep(interval)
                await manager.cleanup_stale(settings.ws_heartbeat_timeout_seconds)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"WS cleanup worker error: {e}")

    ws_cleanup_task = asyncio.create_task(ws_cleanup_worker())

    logger.info(f"WebSocket server ready on ws://{settings.ws_host}:{settings.ws_port}")
    
    yield
    
    # 关闭时清理
    logger.info("Shutting down MC_Servant Backend...")

    if ws_cleanup_task:
        ws_cleanup_task.cancel()
        try:
            await ws_cleanup_task
        except asyncio.CancelledError:
            pass
        ws_cleanup_task = None
    
    # 停止 ContextManager Worker
    if context_manager:
        await context_manager.stop_worker()
        logger.info("ContextManager worker stopped")
    
    # 关闭数据库连接
    try:
        from db.database import db
        await db.close()
        logger.info("Database connection closed")
    except:
        pass
    
    if bot_manager:
        await bot_manager.shutdown()


app = FastAPI(
    title="MC_Servant Backend",
    description="Minecraft 智能 NPC 助手后端服务",
    version="1.0.0",
    lifespan=lifespan
)


@app.get("/")
async def root():
    """健康检查"""
    return {
        "status": "running",
        "service": "MC_Servant Backend",
        "websocket": f"ws://{settings.ws_host}:{settings.ws_port}/ws"
    }


@app.get("/bots")
async def list_bots():
    """列出所有活跃的 Bot"""
    if bot_manager:
        return {"bots": bot_manager.list_bots()}
    return {"bots": []}


@app.get("/state")
async def get_state():
    """获取状态机状态（调试用）"""
    if state_machine:
        return state_machine.get_status()
    return {"error": "State machine not initialized"}


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    """
    WebSocket 端点
    
    Java 插件通过此端点连接
    """
    token = websocket.headers.get("x-access-token")
    if token != settings.ws_access_token:
        logger.warning(f"Rejected WebSocket connection for {client_id}: invalid token")
        await websocket.accept()
        await websocket.close(code=1008, reason="Invalid token")
        return

    await manager.connect(websocket, client_id)
    
    # Init Sync: 连接后立即发送 Bot 名称列表
    await send_init_config(websocket)
    manager.touch(client_id)
    
    # Cold Start Sync: 请求 Java 端发送当前在线玩家列表
    await send_request_sync(websocket)
    manager.touch(client_id)
    
    # 每个客户端一个“业务消息队列 + 单 worker”，避免 LLM/任务执行阻塞心跳收包
    business_queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=settings.ws_client_queue_size)
    last_thinking_ts: float = 0.0

    async def _send_thinking_hologram(npc_name: Optional[str]) -> None:
        nonlocal last_thinking_ts
        if not npc_name:
            return
        now = time.time()
        if (now - last_thinking_ts) < settings.ws_thinking_hologram_min_interval_seconds:
            return
        last_thinking_ts = now
        hologram_msg = {
            "type": MessageType.HOLOGRAM_UPDATE.value,
            "npc": npc_name,
            "hologram_text": "🧠 我先捋捋思绪…",
            "identity_line": None,
        }
        await manager.send_personal(json.dumps(hologram_msg, ensure_ascii=False), client_id)

    async def _business_worker() -> None:
        while True:
            item = await business_queue.get()
            try:
                if message_router:
                    response = await message_router.route(item)
                    if response:
                        response_json = json.dumps(response, ensure_ascii=False)
                        await manager.send_personal(response_json, client_id)
                        logger.debug(f"Sent to {client_id}: {response_json}")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Business worker error for {client_id}: {e}")
            finally:
                business_queue.task_done()

    business_task = asyncio.create_task(_business_worker())

    try:
        while True:
            data = await websocket.receive_text()
            manager.touch(client_id)
            logger.debug(f"Received from {client_id}: {data}")

            try:
                message = json.loads(data)
                msg_type = message.get("type")

                # 1) 心跳必须“立即响应”，不进业务队列
                if msg_type == MessageType.HEARTBEAT.value:
                    heartbeat = {"type": MessageType.HEARTBEAT.value, "timestamp": int(time.time())}
                    await manager.send_personal(json.dumps(heartbeat, ensure_ascii=False), client_id)
                    continue

                # 2) 特殊事件：保持原逻辑（快速且需要即时生效）
                if msg_type == "bot_spawned":
                    await handle_bot_spawned(message, client_id)
                    continue
                if msg_type in ("player_join", "player_quit"):
                    await handle_player_event(message, client_id)
                    if msg_type == "player_quit":
                        try:
                            business_queue.put_nowait(message)
                        except asyncio.QueueFull:
                            logger.warning(f"Business queue full for {client_id}, drop player_quit")
                    continue
                if msg_type in ("player_login", "init_sync"):
                    try:
                        business_queue.put_nowait(message)
                    except asyncio.QueueFull:
                        logger.warning(f"Business queue full for {client_id}, drop {msg_type}")
                    continue
                if msg_type == "online_players_sync":
                    await handle_online_players_sync(message, client_id)
                    continue

                # 3) 业务消息：入队（LLM/规划/数据库等都可能很慢）
                if msg_type == MessageType.PLAYER_MESSAGE.value:
                    await _send_thinking_hologram(message.get("npc") or settings.bot_username)

                try:
                    business_queue.put_nowait(message)
                except asyncio.QueueFull:
                    logger.warning(f"Business queue full for {client_id}, dropping msg_type={msg_type}")
                    error_response = {
                        "type": MessageType.ERROR.value,
                        "code": "server_busy",
                        "message": "服务器正在忙，请稍后再试",
                    }
                    await manager.send_personal(json.dumps(error_response, ensure_ascii=False), client_id)

            except json.JSONDecodeError as e:
                logger.error(f"Invalid JSON from {client_id}: {e}")
                error_response = {
                    "type": MessageType.ERROR.value,
                    "code": "invalid_json",
                    "message": str(e)
                }
                await manager.send_personal(json.dumps(error_response, ensure_ascii=False), client_id)

    except WebSocketDisconnect:
        logger.info(f"Client {client_id} disconnected")
    except Exception as e:
        logger.error(f"WebSocket error for {client_id}: {e}")
    finally:
        business_task.cancel()
        try:
            await business_task
        except asyncio.CancelledError:
            pass
        await manager.disconnect(client_id)


async def send_init_config(websocket: WebSocket):
    """发送初始化配置给 Java 插件（含 owner 同步）"""
    # 等待 Java 客户端完全准备好
    await asyncio.sleep(0.5)
    
    # 收集所有 Bot 名称
    bot_names = []
    if bot_manager:
        bot_names = bot_manager.list_bots()
    
    # 从数据库获取 Bot 的 owner 信息
    bot_owners = []
    if bot_repo:
        try:
            bots = await bot_repo.get_all()
            for bot in bots:
                if bot.owner_uuid:
                    bot_owners.append({
                        "bot_name": bot.name,
                        "owner_uuid": bot.owner_uuid,
                        "owner_name": bot.owner_name,
                    })
            logger.info(f"[Init Sync] Found {len(bot_owners)} bots with owners in DB")
        except Exception as e:
            logger.warning(f"[Init Sync] Failed to get bot owners from DB: {e}")
    
    init_msg = {
        "type": "init_config",
        "bot_names": bot_names,
        "bot_owners": bot_owners,  # 新增：owner 数据同步
        "timestamp": int(time.time())
    }
    
    await websocket.send_text(json.dumps(init_msg))
    logger.info(f"[Init Sync] Sent bot_names: {bot_names}, owners: {len(bot_owners)}")


async def send_request_sync(websocket: WebSocket):
    """发送同步请求给 Java 插件 (Cold Start Sync)"""
    # 请求 Java 端发送当前在线玩家列表
    request_msg = {
        "type": "request_sync",
        "timestamp": int(time.time())
    }
    
    await websocket.send_text(json.dumps(request_msg))
    logger.info("[Cold Start] Sent request_sync to Java")


async def handle_bot_spawned(message: dict, client_id: str):
    """处理 Bot 登录事件 - 创建全息"""
    bot_name = message.get("player")
    if not bot_name:
        return
    
    logger.info(f"Bot spawned: {bot_name}")
    
    # 发送 hologram_update 创建全息
    hologram_msg = {
        "type": "hologram_update",
        "npc": bot_name,
        "hologram_text": "💤 待命中",
        "identity_line": None  # 使用默认
    }
    
    await manager.send_personal(json.dumps(hologram_msg), client_id)
    logger.info(f"Sent hologram_update for {bot_name}")


async def handle_player_event(message: dict, client_id: str):
    """处理玩家上下线事件 - 转发给生命周期管理器"""
    msg_type = message.get("type")
    player = message.get("player")
    player_uuid = message.get("player_uuid")
    
    logger.debug(f"Player event: {msg_type} - {player}")
    
    if lifecycle_manager:
        await lifecycle_manager.on_player_event(
            event_type=msg_type,
            player=player,
            player_uuid=player_uuid,
            client_id=client_id
        )


async def handle_online_players_sync(message: dict, client_id: str):
    """处理初始化同步时的在线玩家列表 (解决 Python 重启问题)"""
    players = message.get("players", [])
    logger.info(f"[Init Sync] Received {len(players)} online players")
    
    # 获取当前在线的 Bot 列表
    current_bots = []
    if bot_manager:
        current_bots = bot_manager.list_bots()
    
    # 为所有在线的 Bot 发送全息更新 (无论 owner 状态)
    for player_info in players:
        name = player_info.get("name", player_info.get("player"))
        if name in current_bots:
            logger.info(f"[Init Sync] Sending hologram update for bot: {name}")
            hologram_msg = {
                "type": "hologram_update",
                "npc": name,
                "hologram_text": "💤 待命中",
                "identity_line": None
            }
            await manager.send_personal(json.dumps(hologram_msg), client_id)
    
    # 同时处理 lifecycle 逻辑 (owner 相关)
    if lifecycle_manager:
        await lifecycle_manager.handle_online_players_sync(
            players=players,
            client_id=client_id
        )


if __name__ == "__main__":
    # 默认关闭热重载：
    # - 采集/移动等"长动作"期间热重载会强制断开 websocket、kill mineflayer 进程，表现为"动了一下就不砍/不继续"
    # - 需要开发热重载时，显式设置环境变量 MC_SERVANT_RELOAD=1
    import os
    reload_enabled = os.getenv("MC_SERVANT_RELOAD", "0") == "1"
    
    # uvicorn 日志配置
    log_config = uvicorn.config.LOGGING_CONFIG
    log_config["formatters"]["default"]["fmt"] = "[%(asctime)s] %(levelname)s: %(message)s"
    log_config["formatters"]["default"]["datefmt"] = "%H:%M:%S"
    log_config["formatters"]["access"]["fmt"] = '[%(asctime)s] %(levelname)s: %(client_addr)s - "%(request_line)s" %(status_code)s'
    log_config["formatters"]["access"]["datefmt"] = "%H:%M:%S"
    
    uvicorn.run(
        "main:app",
        host=settings.ws_host,
        port=settings.ws_port,
        reload=reload_enabled,
        log_level="warning",  # uvicorn 只输出 warning 以上
        log_config=log_config,
    )
