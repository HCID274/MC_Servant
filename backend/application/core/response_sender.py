import json
import time
from typing import Optional

from protocol import MessageType, NpcResponse
from websocket.connection_manager import manager

from application.core.context import AppRuntime


def now_timestamp() -> int:
    """时间戳工具：获取当前 UNIX 时间，用于消息同步。"""
    return int(time.time())


def split_segments(text: str, max_len: int = 18) -> list[str]:
    """文本分段器：将长句拆分为符合游戏全息图宽度的短段。"""
    text = (text or "").strip()
    if not text:
        return []
    return [text[i : i + max_len] for i in range(0, len(text), max_len)]


async def send_error(client_id: str, code: str, message: str) -> None:
    """错误反馈：向指定客户端发送标准错误响应包。"""
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
    """全息响应发送：封装女仆台词并推送至游戏插件显示。"""
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
    """全息图更新：主动修改女仆头顶悬浮的文字内容。"""
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
    """配置生成器：构造系统初始化的同步数据包，包含 Bot 列表与所有权。"""
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
    """初始化同步：向新连接的客户端推送全量系统配置。"""
    payload = build_init_config_payload(runtime)
    await manager.send_personal(json.dumps(payload, ensure_ascii=False), client_id)


async def broadcast_init_config(runtime: AppRuntime) -> None:
    """全局广播配置：当系统状态（如 Bot 增减）变更时通知所有客户端。"""
    payload = build_init_config_payload(runtime)
    await manager.broadcast(json.dumps(payload, ensure_ascii=False))


async def send_request_sync(client_id: str) -> None:
    """数据同步请求：主动要求插件同步当前的在线玩家与状态。"""
    payload = {"type": "request_sync", "timestamp": now_timestamp()}
    await manager.send_personal(json.dumps(payload, ensure_ascii=False), client_id)


