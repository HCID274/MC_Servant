import json
import time
from typing import Optional

from protocol import MessageType, NpcResponse
from websocket.connection_manager import manager

from application.context import AppRuntime


def now_timestamp() -> int:
    return int(time.time())


def split_segments(text: str, max_len: int = 18) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    return [text[i : i + max_len] for i in range(0, len(text), max_len)]


async def send_error(client_id: str, code: str, message: str) -> None:
    payload = {"type": MessageType.ERROR.value, "code": code, "message": message}
    await manager.send_personal(json.dumps(payload, ensure_ascii=False), client_id)


async def send_npc_response(
    client_id: str,
    npc: str,
    target_player: str,
    content: str,
    action: str = "chat",
    hologram_text: Optional[str] = None,
) -> None:
    response = NpcResponse(
        npc=npc,
        target_player=target_player,
        content=content,
        segments=split_segments(content),
        action=action,
        hologram_text=hologram_text,
    ).model_dump(exclude_none=True)
    await manager.send_personal(json.dumps(response, ensure_ascii=False), client_id)


async def send_hologram_update(
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
    message = json.dumps(payload, ensure_ascii=False)
    if client_id:
        await manager.send_personal(message, client_id)
    else:
        await manager.broadcast(message)


def build_init_config_payload(runtime: AppRuntime) -> dict:
    bot_names = runtime.bot_manager.list_bots() if runtime.bot_manager else []
    if runtime.bot_username and runtime.bot_username not in bot_names:
        bot_names.append(runtime.bot_username)

    owners = [
        {
            "bot_name": bot_name,
            "owner_uuid": owner["uuid"],
            "owner_name": owner["name"],
        }
        for bot_name, owner in runtime.bot_owners.items()
    ]

    return {
        "type": "init_config",
        "bot_names": bot_names,
        "bot_owners": owners,
        "timestamp": now_timestamp(),
    }


async def send_init_config(client_id: str, runtime: AppRuntime) -> None:
    payload = build_init_config_payload(runtime)
    await manager.send_personal(json.dumps(payload, ensure_ascii=False), client_id)


async def broadcast_init_config(runtime: AppRuntime) -> None:
    payload = build_init_config_payload(runtime)
    await manager.broadcast(json.dumps(payload, ensure_ascii=False))


async def send_request_sync(client_id: str) -> None:
    payload = {"type": "request_sync", "timestamp": now_timestamp()}
    await manager.send_personal(json.dumps(payload, ensure_ascii=False), client_id)

