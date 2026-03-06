# MC_Servant Backend - Minimal Core

"""
Minimal backend baseline:
- WebSocket auth and routing
- Java plugin protocol compatibility
- Basic Mineflayer bot actions
"""

import asyncio
import json
import logging
import secrets
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional, Tuple
from graph.workflow import build_workflow
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect

from bot.mineflayer_adapter import BotManager
from config import settings
from protocol import MessageType, NpcResponse
from websocket.connection_manager import manager

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="[%(asctime)s] %(levelname).1s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# 全局管理器：持有 Bot 实例、WS 连接以及决策流引擎。
bot_manager: Optional[BotManager] = None
ws_cleanup_task: Optional[asyncio.Task] = None
workflow_app: Optional[Any] = None
bot_task_queues: Dict[str, asyncio.Queue[dict]] = {}
bot_task_workers: Dict[str, asyncio.Task] = {}

# 内存状态机：记录 Bot 的归属权与玩家在线情况。
bot_owners: Dict[str, Dict[str, str]] = {}
online_players: Dict[str, Dict[str, str]] = {}


def _now() -> int:
    """获取当前 UNIX 时间戳。"""
    return int(time.time())


def _split_segments(text: str, max_len: int = 18) -> list[str]:
    """文本分段器：将长句拆分为符合游戏全息图宽度的短段。"""
    text = (text or "").strip()
    if not text:
        return []
    return [text[i : i + max_len] for i in range(0, len(text), max_len)]


def _resolve_bot_name(message: dict) -> str:
    """解析目标 Bot：识别指令指向的是哪个女仆。"""
    npc = (message.get("npc") or "").strip()
    if npc:
        return npc.lstrip("@")
    return settings.bot_username


def _is_known_bot_player(player_name: Optional[str]) -> bool:
    """身份过滤器：判断某个玩家名是否属于受控的 Bot。"""
    if not player_name:
        return False

    if settings.bot_username and player_name == settings.bot_username:
        return True

    if bot_manager and player_name in bot_manager.list_bots():
        return True

    return False


async def _ensure_bot(name: str) -> Tuple[Optional[object], bool]:
    """Bot 持久化保障：确保指定的 Bot 实例已就绪，必要时自动唤醒。"""
    if not bot_manager:
        return None, False

    current = bot_manager.get_bot(name)
    if current:
        return current, False

    try:
        spawned = await bot_manager.spawn_bot(name)
        logger.info("Spawned bot: %s", name)
        return spawned, True
    except Exception as exc:
        logger.warning("Spawn bot failed (%s): %s", name, exc)
        return None, False


async def _send_error(client_id: str, code: str, message: str) -> None:
    payload = {"type": MessageType.ERROR.value, "code": code, "message": message}
    await manager.send_personal(json.dumps(payload, ensure_ascii=False), client_id)


async def _send_npc_response(
    client_id: str,
    npc: str,
    target_player: str,
    content: str,
    action: str = "chat",
    hologram_text: Optional[str] = None,
) -> None:
    """响应封装：构造并向游戏插件发送女仆的回应数据包。"""
    response = NpcResponse(
        npc=npc,
        target_player=target_player,
        content=content,
        segments=_split_segments(content),
        action=action,
        hologram_text=hologram_text,
    ).model_dump(exclude_none=True)
    await manager.send_personal(json.dumps(response, ensure_ascii=False), client_id)


async def _send_hologram_update(
    npc: str,
    text: str,
    identity_line: Optional[str] = None,
    client_id: Optional[str] = None,
) -> None:
    payload = {
        "type": MessageType.HOLOGRAM_UPDATE.value,
        "npc": npc,
        "hologram_text": text,
        "identity_line": identity_line,
    }
    msg = json.dumps(payload, ensure_ascii=False)
    if client_id:
        await manager.send_personal(msg, client_id)
    else:
        await manager.broadcast(msg)


async def _build_init_config_payload() -> dict:
    bot_names = bot_manager.list_bots() if bot_manager else []
    if settings.bot_username and settings.bot_username not in bot_names:
        bot_names.append(settings.bot_username)

    owners = [
        {
            "bot_name": bot_name,
            "owner_uuid": owner["uuid"],
            "owner_name": owner["name"],
        }
        for bot_name, owner in bot_owners.items()
    ]

    return {
        "type": "init_config",
        "bot_names": bot_names,
        "bot_owners": owners,
        "timestamp": _now(),
    }


async def _send_init_config(client_id: str) -> None:
    payload = await _build_init_config_payload()
    await manager.send_personal(json.dumps(payload, ensure_ascii=False), client_id)


async def _broadcast_init_config() -> None:
    payload = await _build_init_config_payload()
    await manager.broadcast(json.dumps(payload, ensure_ascii=False))


async def _send_request_sync(client_id: str) -> None:
    payload = {"type": "request_sync", "timestamp": _now()}
    await manager.send_personal(json.dumps(payload, ensure_ascii=False), client_id)

async def _build_env_snapshot(
    message: dict, bot_name: str, player: str, bot: object
) -> dict:
    """构造给 LangGraph 的最小环境快照。"""
    bot_pos: dict = {}
    try:
        pos = await bot.get_position()
        if pos:
            bot_pos = {"x": pos[0], "y": pos[1], "z": pos[2]}
    except Exception as exc:
        logger.debug("Get bot position failed: %s", exc)

    player_pos: dict = {}
    px = message.get("player_x")
    py = message.get("player_y")
    pz = message.get("player_z")
    if px is not None and py is not None and pz is not None:
        player_pos = {"x": px, "y": py, "z": pz}

    return {
        "bot_name": bot_name,
        "master_name": player,
        "bot_pos": bot_pos,
        "player_pos": player_pos,
        "inventory": {},      # MVP：先用空背包，后续接真实采集
        "nearby_blocks": [],  # MVP：先用空列表，后续接真实扫描
    }
    
async def _invoke_workflow_with_timeout(
    state: dict, timeout_seconds: float = 20.0
) -> Optional[dict]:
    """异步线程化调用 LangGraph，避免阻塞 WS 事件循环。"""
    if workflow_app is None:
        return None
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(workflow_app.invoke, state),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError:
        logger.warning("LangGraph invoke timeout after %.1fs", timeout_seconds)
        return None
    except Exception as exc:
        logger.warning("LangGraph invoke failed: %s", exc)
        return None

def _get_or_create_task_queue(bot_name: str) -> asyncio.Queue[dict]:
    queue = bot_task_queues.get(bot_name)
    if queue is None:
        queue = asyncio.Queue()
        bot_task_queues[bot_name] = queue
    return queue

def _ensure_task_worker(bot_name: str) -> None:
    worker = bot_task_workers.get(bot_name)
    if worker is not None and not worker.done():
        return

    queue = _get_or_create_task_queue(bot_name)
    bot_task_workers[bot_name] = asyncio.create_task(
        _task_worker_loop(bot_name, queue),
        name=f"task-worker-{bot_name}",
    )

async def _enqueue_task_job(
      *,
      bot_name: str,
      client_id: str,
      player: str,
      tasks: list[dict],
  ) -> int:
      queue = _get_or_create_task_queue(bot_name)
      pending_before = queue.qsize()
      await queue.put(
          {
              "client_id": client_id,
              "player": player,
              "tasks": tasks,
          }
      )
      return pending_before + 1


async def _execute_task_step(bot: object, action: str, target: str) -> Tuple[bool, str]:
    action = (action or "").strip().lower()
    target = (target or "").strip()

    if action == "speak":
        if not target:
            return False, "speak 缺少台词"
        ok = await bot.chat(target)
        return (True, f"speak: {target}") if ok else (False, "speak 发送失败")

    if action == "move_to":
        if target == "master_front":
            ok = await bot.navigate_relative("master", "front", 2.0)
            return (True, "已移动到主人前方") if ok else (False, "移动到主人前方失败")
        if target == "master_side":
            ok = await bot.navigate_relative("master", "side", 1.5)
            return (True, "已移动到主人身旁") if ok else (False, "移动到主人身旁失败")
        return False, f"move_to 目标暂不支持: {target}"

    # 第二阶段先把“显式任务队列”跑通，动作能力后续再逐个接入
    if action in {"mine", "pick_up", "craft", "place"}:
        return False, f"动作 {action} 暂未接入执行层（target={target}）"

    return False, f"未知动作: {action}"


async def _task_worker_loop(bot_name: str, queue: asyncio.Queue[dict]) -> None:
    while True:
        try:
            job = await queue.get()
        except asyncio.CancelledError:
            return

        try:
            client_id = str(job.get("client_id") or "")
            player = str(job.get("player") or "Unknown")
            tasks = job.get("tasks") or []

            bot, _ = await _ensure_bot(bot_name)
            if not bot:
                if client_id:
                    await _send_npc_response(
                        client_id,
                        bot_name,
                        player,
                        "Bot 不可用，任务终止喵。",
                        action="task_exec",
                        hologram_text="❌",
                    )
                continue

            total = len(tasks)
            for idx, step in enumerate(tasks, start=1):
                action = str((step or {}).get("action") or "").strip()
                target = str((step or {}).get("target") or "").strip()

                if not action:
                    if client_id:
                        await _send_npc_response(
                            client_id,
                            bot_name,
                            player,
                            f"[{idx}/{total}] 任务步骤缺少 action，已中断喵。",
                            action="task_exec",
                            hologram_text="⚠️",
                        )
                    break

                ok, msg = await _execute_task_step(bot, action, target)
                if not ok:
                    if client_id:
                        await _send_npc_response(
                            client_id,
                            bot_name,
                            player,
                            f"[{idx}/{total}] {msg}",
                            action="task_exec",
                            hologram_text="⚠️",
                        )
                    break

                if client_id:
                    await _send_npc_response(
                        client_id,
                        bot_name,
                        player,
                        f"[{idx}/{total}] {msg}",
                        action="task_exec",
                        hologram_text="⚙️",
                    )
            else:
                if client_id:
                    await _send_npc_response(
                        client_id,
                        bot_name,
                        player,
                        "任务执行完成喵。",
                        action="task_exec",
                        hologram_text="✅",
                    )

        except Exception as exc:
            logger.exception("Task worker error (%s): %s", bot_name, exc)
        finally:
            queue.task_done()

async def _try_handle_with_graph(
    message: dict,
    client_id: str,
    bot: object,
    bot_name: str,
    player: str,
    content: str,
) -> bool:
    """决策流入口：将用户输入喂给 LangGraph，尝试生成智能决策。"""
    env_snapshot = await _build_env_snapshot(message, bot_name, player, bot)
    state = {
        "user_input": content,
        "task_queue": [],
        "env_snapshot": env_snapshot,
    }

    result = await _invoke_workflow_with_timeout(state)
    if result is None:
        return False

    intent = result.get("intent")
    if intent == "chat":
        route = result.get("route")
        if isinstance(route, dict):
            reply_text = route.get("reply_text")
        else:
            reply_text = getattr(route, "reply_text", None)
        reply_text = reply_text or "我在呢主人喵~"

        await _send_npc_response(
            client_id,
            bot_name,
            player,
            reply_text,
            action="chat",
            hologram_text="💬",
        )
        return True

    if intent == "task":
        task_queue = result.get("task_queue") or []
        if not task_queue:
            await _send_npc_response(
                client_id,
                bot_name,
                player,
                "任务我听懂了，但暂时还没规划出步骤喵。",
                action="task_plan",
                hologram_text="🤔",
            )
            return True

        first = task_queue[0] if isinstance(task_queue[0], dict) else {}
        first_action = first.get("action", "unknown")
        first_target = first.get("target", "none")

        _ensure_task_worker(bot_name)
        queue_pos = await _enqueue_task_job(
            bot_name=bot_name,
            client_id=client_id,
            player=player,
            tasks=task_queue,
        )

        logger.info("Planned task_queue for %s: %s", bot_name, task_queue)
        await _send_npc_response(
            client_id,
            bot_name,
            player,
            f"任务已接收，共规划 {len(task_queue)} 步，首步
{first_action}->{first_target}，已入队 #{queue_pos} 喵。",
            action="task_plan",
            hologram_text="📥",
        )
        return True

    logger.warning("Graph returned unknown intent: %s", intent)
    return False

async def _handle_player_message(message: dict, client_id: str) -> None:
    player = message.get("player") or "Unknown"
    content = (message.get("content") or "").strip()
    bot_name = _resolve_bot_name(message)

    if not content:
        await _send_error(client_id, "invalid_message", "content is empty")
        return

    bot, created = await _ensure_bot(bot_name)
    if created:
        await _broadcast_init_config()

    if not bot:
        await _send_error(client_id, "bot_unavailable", f"Bot '{bot_name}' is unavailable")
        return

    lowered = content.lower()

    if lowered in {"hello", "hi", "你好", "你好呀"}:
        await bot.jump()
        await _send_npc_response(client_id, bot_name, player, "Ciallo~~~~", action="greeting", hologram_text="💖")
        return

    if lowered in {"status", "where", "你在哪", "位置"}:
        pos = await bot.get_position()
        if pos:
            text = f"我在 ({pos[0]:.0f}, {pos[1]:.0f}, {pos[2]:.0f})"
        else:
            text = "我现在还没准备好，稍后再试。"
        await _send_npc_response(client_id, bot_name, player, text, action="status", hologram_text="📍")
        return

    if lowered in {"jump", "跳", "跳一下"}:
        await bot.jump()
        await _send_npc_response(client_id, bot_name, player, "收到，跳了一下。", action="jump", hologram_text="🦘")
        return

    if lowered.startswith("say ") and len(content) > 4:
        to_say = content[4:].strip()
        await bot.chat(to_say)
        await _send_npc_response(client_id, bot_name, player, f"已发送聊天: {to_say}", action="chat", hologram_text="💬")
        return

    if lowered.startswith("look ") and len(content) > 5:
        target = content[5:].strip()
        ok = await bot.look_at(target)
        text = "已看向目标。" if ok else "看向失败，请确认目标格式。"
        await _send_npc_response(client_id, bot_name, player, text, action="look_at", hologram_text="👀")
        return

    # 默认分支：先尝试走 LLM + LangGraph 主链路
    handled = await _try_handle_with_graph(
        message=message,
        client_id=client_id,
        bot=bot,
        bot_name=bot_name,
        player=player,
        content=content,
    )
    if handled:
        return

    # 降级回极简模式，保证服务可用
    await _send_npc_response(
        client_id,
        bot_name,
        player,
        f"已收到指令：{content}。当前为极简降级模式，复杂任务暂未启用。",
        action="ack",
        hologram_text="💤 待命中",
    )


async def _handle_servant_command(message: dict, client_id: str) -> None:
    player = message.get("player") or "Unknown"
    player_uuid = message.get("player_uuid") or ""
    command = (message.get("command") or "").strip().lower()
    target_bot = (message.get("target_bot") or settings.bot_username).lstrip("@")

    if not command:
        await _send_error(client_id, "invalid_command", "command is empty")
        return

    if command == "list":
        owned = [name for name, owner in bot_owners.items() if owner.get("uuid") == player_uuid]
        if owned:
            text = "你当前拥有: " + ", ".join(owned)
        else:
            text = "你当前没有已认领的 Bot。"
        await _send_npc_response(client_id, target_bot, player, text, action="list", hologram_text="📋")
        return

    if command == "status":
        bot = bot_manager.get_bot(target_bot) if bot_manager else None
        connected = bool(bot and bot.is_connected)
        owner = bot_owners.get(target_bot)
        owner_name = owner.get("name") if owner else "无"
        text = f"{target_bot} | online={connected} | owner={owner_name}"
        await _send_npc_response(client_id, target_bot, player, text, action="status", hologram_text="📊")
        return

    bot, created = await _ensure_bot(target_bot)
    if created:
        await _broadcast_init_config()

    if command == "claim":
        current_owner = bot_owners.get(target_bot)
        if current_owner and current_owner.get("uuid") != player_uuid:
            await _send_npc_response(
                client_id,
                target_bot,
                player,
                f"认领失败：{target_bot} 已被 {current_owner.get('name', 'Unknown')} 占用。",
                action="claim",
                hologram_text="⛔",
            )
            return

        bot_owners[target_bot] = {"uuid": player_uuid, "name": player}
        owner_update = {
            "type": "bot_owner_update",
            "bot_name": target_bot,
            "owner_uuid": player_uuid,
            "owner_name": player,
        }
        await manager.broadcast(json.dumps(owner_update, ensure_ascii=False))
        await _send_hologram_update(target_bot, "💤 待命中", identity_line=player)

        await _send_npc_response(
            client_id,
            target_bot,
            player,
            f"认领成功：{target_bot} 现在归你管理。",
            action="claim",
            hologram_text="✅",
        )
        return

    if command == "release":
        current_owner = bot_owners.get(target_bot)
        if not current_owner:
            await _send_npc_response(
                client_id,
                target_bot,
                player,
                f"{target_bot} 当前是无主状态。",
                action="release",
                hologram_text="ℹ️",
            )
            return

        if current_owner.get("uuid") != player_uuid:
            await _send_npc_response(
                client_id,
                target_bot,
                player,
                f"释放失败：你不是 {target_bot} 的主人。",
                action="release",
                hologram_text="⛔",
            )
            return

        del bot_owners[target_bot]
        owner_update = {
            "type": "bot_owner_update",
            "bot_name": target_bot,
            "owner_uuid": "",
            "owner_name": "",
        }
        await manager.broadcast(json.dumps(owner_update, ensure_ascii=False))
        await _send_hologram_update(target_bot, "💤 待命中", identity_line="")

        await _send_npc_response(
            client_id,
            target_bot,
            player,
            f"已释放 {target_bot}。",
            action="release",
            hologram_text="🆓",
        )
        return

    await _send_error(client_id, "unsupported_command", f"Unsupported command: {command}")


async def _handle_presence_message(message: dict) -> None:
    msg_type = message.get("type")
    player = message.get("player")
    player_uuid = message.get("player_uuid")

    if msg_type in {"player_join", "player_login"} and player and player_uuid:
        online_players[player_uuid] = {"name": player, "uuid": player_uuid}
        if _is_known_bot_player(player):
            owner = bot_owners.get(player)
            await _send_hologram_update(
                player,
                "💤 待命中",
                identity_line=owner["name"] if owner else "",
            )
    elif msg_type == "player_quit" and player_uuid:
        online_players.pop(player_uuid, None)
    elif msg_type in {"init_sync", "online_players_sync"}:
        players = message.get("players") or []
        online_players.clear()
        for item in players:
            puid = item.get("uuid")
            pname = item.get("name")
            if puid and pname:
                online_players[puid] = {"name": pname, "uuid": puid}
                if _is_known_bot_player(pname):
                    owner = bot_owners.get(pname)
                    await _send_hologram_update(
                        pname,
                        "💤 待命中",
                        identity_line=owner["name"] if owner else "",
                    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    global bot_manager, ws_cleanup_task, workflow_app

    logger.info("Initializing MC_Servant minimal backend...")

    if not settings.ws_access_token.strip():
        raise RuntimeError("MC_SERVANT_WS_ACCESS_TOKEN is required")

    if not settings.bot_password:
        logger.warning("MC_SERVANT_BOT_PASSWORD is empty; AuthMe servers may reject bot login")

    bot_manager = BotManager(
        mc_host=settings.mc_host,
        mc_port=settings.mc_port,
        default_password=settings.bot_password,
    )

    # Best effort: spawn default bot on startup
    spawned, created = await _ensure_bot(settings.bot_username)
    if spawned:
        logger.info("Default bot ready: %s", settings.bot_username)
    else:
        logger.warning("Default bot not ready at startup; it can be spawned lazily")

    # 启动时编译 LangGraph（失败则自动降级）
    try:
        workflow_app = build_workflow()
        logger.info("LangGraph workflow ready")
    except Exception as exc:
        workflow_app = None
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

    logger.info("Shutting down MC_Servant minimal backend...")

    if ws_cleanup_task:
        ws_cleanup_task.cancel()
        try:
            await ws_cleanup_task
        except asyncio.CancelledError:
            pass
        ws_cleanup_task = None
        for worker in bot_task_workers.values():
            worker.cancel()
        if bot_task_workers:
            await asyncio.gather(*bot_task_workers.values(), return_exceptions=True)
        bot_task_workers.clear()
        bot_task_queues.clear()

    workflow_app = None
    if bot_manager:
        await bot_manager.shutdown()


app = FastAPI(
    title="MC_Servant Backend (Minimal)",
    description="Minimal baseline backend for MC_Servant",
    version="2.0.0-minimal",
    lifespan=lifespan,
)


async def verify_token(x_access_token: str = Header(default=None)):
    if not x_access_token or not secrets.compare_digest(x_access_token, settings.ws_access_token):
        raise HTTPException(status_code=401, detail="Invalid or missing token")


@app.get("/")
async def root():
    return {
        "status": "running",
        "mode": "minimal",
        "service": "MC_Servant Backend",
        "websocket": f"ws://{settings.ws_host}:{settings.ws_port}/ws",
    }


@app.get("/bots", dependencies=[Depends(verify_token)])
async def list_bots():
    return {"bots": bot_manager.list_bots() if bot_manager else []}


@app.get("/state", dependencies=[Depends(verify_token)])
async def get_state():
    return {
        "mode": "minimal",
        "bot_count": len(bot_manager.list_bots()) if bot_manager else 0,
        "owners": bot_owners,
        "online_players": list(online_players.values()),
    }


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    token = websocket.headers.get("x-access-token")
    if not token or not secrets.compare_digest(token, settings.ws_access_token):
        logger.warning("Rejected WebSocket connection for %s: invalid token", client_id)
        await websocket.accept()
        await websocket.close(code=1008, reason="Invalid token")
        return

    await manager.connect(websocket, client_id)
    await _send_init_config(client_id)
    await _send_request_sync(client_id)
    manager.touch(client_id)

    try:
        while True:
            data = await websocket.receive_text()
            manager.touch(client_id)

            try:
                message = json.loads(data)
            except json.JSONDecodeError:
                await _send_error(client_id, "invalid_json", "Invalid JSON payload")
                continue

            msg_type = message.get("type")

            if msg_type == MessageType.HEARTBEAT.value:
                heartbeat = {"type": MessageType.HEARTBEAT.value, "timestamp": _now()}
                await manager.send_personal(json.dumps(heartbeat), client_id)
                continue

            if msg_type in {"player_join", "player_quit", "player_login", "init_sync", "online_players_sync"}:
                await _handle_presence_message(message)
                continue

            if msg_type == "bot_spawned":
                npc = message.get("player") or settings.bot_username
                await _send_hologram_update(npc, "💤 待命中", client_id=client_id)
                continue

            if msg_type == MessageType.SERVANT_COMMAND.value:
                await _handle_servant_command(message, client_id)
                continue

            if msg_type == MessageType.PLAYER_MESSAGE.value:
                await _handle_player_message(message, client_id)
                continue

            await _send_error(client_id, "unsupported_message", f"Unsupported message type: {msg_type}")

    except WebSocketDisconnect:
        logger.info("Client disconnected: %s", client_id)
    except Exception as exc:
        logger.error("WebSocket error for %s: %s", client_id, exc)
    finally:
        await manager.disconnect(client_id)


if __name__ == "__main__":
    uvicorn.run(app, host=settings.ws_host, port=settings.ws_port)
