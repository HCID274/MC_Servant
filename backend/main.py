# MC_Servant Backend - Layered Entry

"""
Backend entrypoint responsibilities:
- FastAPI app creation
- Lifecycle wiring
- WebSocket binding and message dispatch
"""

import asyncio
import json
import logging
import secrets
from contextlib import asynccontextmanager
from typing import Optional

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect

from application.bot_runtime import ensure_bot
from application.context import AppRuntime
from application.message_router import route_ws_message
from application.player_handler import process_task_job
from application.response_sender import send_error, send_init_config, send_request_sync
from bot.mineflayer_adapter import BotManager
from config import settings
from execution.task_queue import TaskQueueManager
from graph.workflow import build_workflow
from websocket.connection_manager import manager

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="[%(asctime)s] %(levelname).1s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# 系统全局上下文：管理 Bot 运行实例、任务队列及决策流状态。
runtime = AppRuntime(bot_username=settings.bot_username)
ws_cleanup_task: Optional[asyncio.Task] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """生命周期管理器：负责系统启动时的依赖注入与关闭时的资源回收。"""
    global ws_cleanup_task

    logger.info("Initializing MC_Servant layered backend...")

    # 环境校验：确保通信令牌存在，防止未授权访问。
    if not settings.ws_access_token.strip():
        raise RuntimeError("MC_SERVANT_WS_ACCESS_TOKEN is required")

    # 安全预警：提醒开发者配置密码以兼容 AuthMe 插件。
    if not settings.bot_password:
        logger.warning("MC_SERVANT_BOT_PASSWORD is empty; AuthMe servers may reject bot login")

    # 注入物理管家：初始化底层的 Mineflayer 控制中枢。
    runtime.bot_manager = BotManager(
        mc_host=settings.mc_host,
        mc_port=settings.mc_port,
        default_password=settings.bot_password,
    )

    # 注入调度中枢：配置任务异步执行队列。
    runtime.task_queue_manager = TaskQueueManager(
        process_job=lambda bot_name, job: process_task_job(runtime, bot_name, job),
    )

    # 预加载默认 Bot：尝试在启动时激活主女仆。
    spawned, _ = await ensure_bot(runtime.bot_manager, settings.bot_username)
    if spawned:
        logger.info("Default bot ready: %s", settings.bot_username)
    else:
        logger.warning("Default bot not ready at startup; it can be spawned lazily")

    # 装载大脑工作流：编译 LangGraph 状态机。
    try:
        runtime.workflow_app = build_workflow()
        logger.info("LangGraph workflow ready")
    except Exception as exc:
        # 容错处理：若 LLM 模块异常，则降级为纯指令模式。
        runtime.workflow_app = None
        logger.warning("LangGraph init failed, fallback to minimal mode: %s", exc)

    async def ws_cleanup_worker() -> None:
        interval = max(5, settings.ws_heartbeat_timeout_seconds // 3)
        while True:
            try:
                await asyncio.sleep(interval)
                await manager.cleanup_stale(settings.ws_heartbeat_timeout_seconds)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning("WS cleanup worker error: %s", exc)

    ws_cleanup_task = asyncio.create_task(ws_cleanup_worker())
    logger.info("WebSocket server ready on ws://%s:%s", settings.ws_host, settings.ws_port)
    yield

    logger.info("Shutting down MC_Servant layered backend...")

    if ws_cleanup_task:
        ws_cleanup_task.cancel()
        try:
            await ws_cleanup_task
        except asyncio.CancelledError:
            pass
        ws_cleanup_task = None

    if runtime.task_queue_manager:
        await runtime.task_queue_manager.shutdown()
        runtime.task_queue_manager = None

    runtime.workflow_app = None
    if runtime.bot_manager:
        await runtime.bot_manager.shutdown()
        runtime.bot_manager = None

    runtime.bot_owners.clear()
    runtime.online_players.clear()


app = FastAPI(
    title="MC_Servant Backend (Layered)",
    description="Layered backend for MC_Servant",
    version="2.1.0-layered",
    lifespan=lifespan,
)


async def verify_token(x_access_token: str = Header(default=None)):
    """安全鉴权：验证请求头中的令牌，保护核心 API 免受非法访问。"""
    if not x_access_token or not secrets.compare_digest(x_access_token, settings.ws_access_token):
        raise HTTPException(status_code=401, detail="Invalid or missing token")


@app.get("/")
async def root():
    """根路径：提供系统元数据，用于简单的状态连通性测试。"""
    return {
        "status": "running",
        "mode": "layered",
        "service": "MC_Servant Backend",
        "websocket": f"ws://{settings.ws_host}:{settings.ws_port}/ws",
    }


@app.get("/bots", dependencies=[Depends(verify_token)])
async def list_bots():
    """清单查询：透传底层控制器的实例列表，展示当前在线的 Bot。"""
    return {"bots": runtime.bot_manager.list_bots() if runtime.bot_manager else []}


@app.get("/state", dependencies=[Depends(verify_token)])
async def get_state():
    """实时快照：聚合内存中的所有玩家归属与在线状态，提供全量视图。"""
    return {
        "mode": "layered",
        "bot_count": len(runtime.bot_manager.list_bots()) if runtime.bot_manager else 0,
        "owners": runtime.bot_owners,
        "online_players": list(runtime.online_players.values()),
    }


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    """网关入口：处理插件长连接，并作为原始数据流入系统的第一站。"""
    token = websocket.headers.get("x-access-token")
    if not token or not secrets.compare_digest(token, settings.ws_access_token):
        logger.warning("Rejected WebSocket connection for %s: invalid token", client_id)
        await websocket.accept()
        await websocket.close(code=1008, reason="Invalid token")
        return

    await manager.connect(websocket, client_id)
    await send_init_config(client_id, runtime)
    await send_request_sync(client_id)
    manager.touch(client_id)

    try:
        while True:
            data = await websocket.receive_text()
            manager.touch(client_id)

            try:
                message = json.loads(data)
            except json.JSONDecodeError:
                await send_error(client_id, "invalid_json", "Invalid JSON payload")
                continue

            await route_ws_message(message, client_id, runtime)
    except WebSocketDisconnect:
        logger.info("Client disconnected: %s", client_id)
    except Exception as exc:
        logger.error("WebSocket error for %s: %s", client_id, exc)
    finally:
        await manager.disconnect(client_id)


if __name__ == "__main__":
    uvicorn.run(app, host=settings.ws_host, port=settings.ws_port)

