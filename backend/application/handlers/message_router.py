import json

from protocol import MessageType
from websocket.connection_manager import manager

from application.core.context import AppRuntime
from application.handlers.player_handler import handle_player_message
from application.handlers.presence_handler import handle_presence_message
from application.core.response_sender import now_timestamp, send_error, send_hologram_update
from application.handlers.servant_handler import handle_servant_command
from config import settings


async def route_ws_message(message: dict, client_id: str, runtime: AppRuntime) -> None:
    """分流中枢：根据插件消息类型，将其分发至对应的业务逻辑处理器。"""
    msg_type = message.get("type")

    if msg_type == MessageType.HEARTBEAT.value:
        heartbeat = {"type": MessageType.HEARTBEAT.value, "timestamp": now_timestamp()}
        await manager.send_personal(json.dumps(heartbeat), client_id)
        return

    if msg_type in {"player_join", "player_quit", "player_login", "init_sync", "online_players_sync"}:
        await handle_presence_message(message, runtime)
        return

    if msg_type == "bot_spawned":
        npc = message.get("player") or settings.bot_username
        await send_hologram_update(npc, "💤 待命中", client_id=client_id)
        return

    if msg_type == MessageType.SERVANT_COMMAND.value:
        await handle_servant_command(message, client_id, runtime)
        return

    if msg_type == MessageType.PLAYER_MESSAGE.value:
        await handle_player_message(message, client_id, runtime)
        return

    await send_error(client_id, "unsupported_message", f"Unsupported message type: {msg_type}")


