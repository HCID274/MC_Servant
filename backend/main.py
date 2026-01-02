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
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

from config import settings
from websocket.connection_manager import manager
from websocket.handlers import MessageRouter
from bot.mineflayer_adapter import BotManager
from protocol import NpcResponse, MessageType

# 配置日志
logging.basicConfig(
    level=getattr(logging, settings.log_level),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# 全局管理器
bot_manager: Optional[BotManager] = None
message_router: Optional[MessageRouter] = None
llm_client = None  # LLM 客户端 (Optional)
state_machine = None  # 状态机 (Optional)
context_manager = None  # 记忆上下文管理器 (Optional)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    global bot_manager, message_router, llm_client, state_machine, context_manager
    
    # 启动时初始化
    logger.info("Initializing MC_Servant Backend...")
    
    # 初始化数据库连接
    try:
        from db.database import db
        await db.init(settings.database_url, echo=settings.db_echo)
        logger.info("Database initialized")
    except Exception as e:
        logger.warning(f"Database initialization failed (memory mode): {e}")
    
    # 初始化 LLM 客户端 (如果配置了 API Key)
    if settings.openai_api_key:
        try:
            from llm.qwen_client import QwenClient
            llm_client = QwenClient(
                api_key=settings.openai_api_key,
                base_url=settings.openai_base_url,
                model=settings.openai_model,
            )
            logger.info(f"LLM client initialized: {settings.openai_model}")
            
            # 初始化 ContextManager (需要 LLM 客户端)
            from llm.context_manager import ContextManager
            context_manager = ContextManager(llm_client=llm_client)
            await context_manager.start_worker()
            logger.info("ContextManager initialized with compression worker")
        except Exception as e:
            logger.warning(f"Failed to initialize LLM client: {e}")
            llm_client = None
    else:
        logger.info("LLM not configured (no API key), using fallback intent recognition")
    
    bot_manager = BotManager(
        mc_host=settings.mc_host,
        mc_port=settings.mc_port,
        default_password=settings.bot_password
    )
    
    # 生成默认 Bot
    try:
        default_bot = await bot_manager.spawn_bot(settings.bot_username)
        logger.info(f"Default bot spawned: {settings.bot_username}")
        
        # 初始化状态机
        from pathlib import Path
        from state.machine import StateMachine
        from state.config import BotConfig
        
        config_path = Path("data/bot_config.json")
        
        # 加载或创建配置，确保 bot_name 是真实的 Bot 用户名
        bot_config = BotConfig.load(config_path)
        bot_config.bot_name = default_bot.username  # 使用真实的 Bot 名称
        bot_config.save(config_path)
        
        state_machine = StateMachine(
            config=bot_config,
            config_path=config_path,
            llm_client=llm_client,
            bot_controller=default_bot,
        )
        logger.info(f"State machine initialized: state={state_machine.current_state.name}, bot={bot_config.bot_name}")
        
        # 初始化消息路由器 (with LLM client, state machine, and context manager)
        message_router = MessageRouter(default_bot, llm_client, state_machine, bot_manager, context_manager)
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
        state_machine = StateMachine(
            config_path=config_path,
            llm_client=llm_client,
            bot_controller=mock_bot,
        )
        logger.info(f"State machine initialized (MockBot): state={state_machine.current_state.name}")
        
        message_router = MessageRouter(mock_bot, llm_client, state_machine, bot_manager, context_manager)
    
    logger.info(f"WebSocket server ready on ws://{settings.ws_host}:{settings.ws_port}")
    
    yield
    
    # 关闭时清理
    logger.info("Shutting down MC_Servant Backend...")
    
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
    await manager.connect(websocket, client_id)
    
    # Init Sync: 连接后立即发送 Bot 名称列表
    await send_init_config(websocket)
    
    try:
        while True:
            # 接收消息
            data = await websocket.receive_text()
            logger.debug(f"Received from {client_id}: {data}")
            
            try:
                # 解析 JSON
                message = json.loads(data)
                msg_type = message.get("type")
                
                # 特殊事件处理
                if msg_type == "bot_spawned":
                    await handle_bot_spawned(message, client_id)
                    continue
                elif msg_type in ("player_join", "player_quit"):
                    await handle_player_event(message)
                    continue
                
                # 路由到处理器
                if message_router:
                    response = await message_router.route(message)
                    
                    if response:
                        # 发送响应
                        response_json = json.dumps(response, ensure_ascii=False)
                        await manager.send_personal(response_json, client_id)
                        logger.debug(f"Sent to {client_id}: {response_json}")
                        
            except json.JSONDecodeError as e:
                logger.error(f"Invalid JSON from {client_id}: {e}")
                error_response = {
                    "type": MessageType.ERROR.value,
                    "code": "invalid_json",
                    "message": str(e)
                }
                await manager.send_personal(json.dumps(error_response), client_id)
                
    except WebSocketDisconnect:
        await manager.disconnect(client_id)
        logger.info(f"Client {client_id} disconnected")
    except Exception as e:
        logger.error(f"WebSocket error for {client_id}: {e}")
        await manager.disconnect(client_id)


async def send_init_config(websocket: WebSocket):
    """发送初始化配置给 Java 插件"""
    import time
    
    # 等待 Java 客户端完全准备好
    await asyncio.sleep(0.5)
    
    # 收集所有 Bot 名称
    bot_names = []
    if bot_manager:
        bot_names = bot_manager.list_bots()
    
    init_msg = {
        "type": "init_config",
        "bot_names": bot_names,
        "timestamp": int(time.time())
    }
    
    await websocket.send_text(json.dumps(init_msg))
    logger.info(f"[Init Sync] Sent bot_names: {bot_names}")


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


async def handle_player_event(message: dict):
    """处理玩家上下线事件 (为 Phase 2 预留)"""
    msg_type = message.get("type")
    player = message.get("player")
    
    # Phase 2 将在这里实现 Owner 检测和 Bot 生命周期逻辑
    logger.debug(f"Player event: {msg_type} - {player}")


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.ws_host,
        port=settings.ws_port,
        reload=True,
        log_level=settings.log_level.lower()
    )
