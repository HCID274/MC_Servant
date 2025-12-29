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

# 全局 Bot 管理器
bot_manager: Optional[BotManager] = None
message_router: Optional[MessageRouter] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    global bot_manager, message_router
    
    # 启动时初始化
    logger.info("Initializing MC_Servant Backend...")
    
    bot_manager = BotManager(
        mc_host=settings.mc_host,
        mc_port=settings.mc_port,
        default_password=settings.bot_password
    )
    
    # 生成默认 Bot
    try:
        default_bot = await bot_manager.spawn_bot(settings.bot_username)
        logger.info(f"Default bot spawned: {settings.bot_username}")
        
        # 初始化消息路由器
        message_router = MessageRouter(default_bot)
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
        
        message_router = MessageRouter(MockBot())
    
    logger.info(f"WebSocket server ready on ws://{settings.ws_host}:{settings.ws_port}")
    
    yield
    
    # 关闭时清理
    logger.info("Shutting down MC_Servant Backend...")
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


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    """
    WebSocket 端点
    
    Java 插件通过此端点连接
    """
    await manager.connect(websocket, client_id)
    
    try:
        while True:
            # 接收消息
            data = await websocket.receive_text()
            logger.debug(f"Received from {client_id}: {data}")
            
            try:
                # 解析 JSON
                message = json.loads(data)
                
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


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.ws_host,
        port=settings.ws_port,
        reload=True,
        log_level=settings.log_level.lower()
    )
