import json

from application.bot_runtime import ensure_bot
from application.context import AppRuntime
from application.response_sender import (
    broadcast_init_config,
    send_error,
    send_hologram_update,
    send_npc_response,
)
from config import settings
from websocket.connection_manager import manager


async def handle_servant_command(message: dict, client_id: str, runtime: AppRuntime) -> None:
    """管理指令网关：处理来自插件的认领、释放及 Bot 状态管理请求。"""
    player = message.get("player") or "Unknown"
    player_uuid = message.get("player_uuid") or ""
    command = (message.get("command") or "").strip().lower()
    target_bot = (message.get("target_bot") or settings.bot_username).lstrip("@")

    # 参数合法性检查。
    if not command:
        await send_error(client_id, "invalid_command", "command is empty")
        return

    # 功能 A - 资产列表：查询当前玩家名下的所有女仆。
    if command == "list":
        owned = [name for name, owner in runtime.bot_owners.items() if owner.get("uuid") == player_uuid]
        text = "你当前拥有: " + ", ".join(owned) if owned else "你当前没有已认领的 Bot。"
        await send_npc_response(client_id, target_bot, player, text, action="list", hologram_text="📋")
        return

    # 功能 B - 状态透视：实时返回 Bot 的在线状态与主从关系。
    if command == "status":
        bot = runtime.bot_manager.get_bot(target_bot) if runtime.bot_manager else None
        connected = bool(bot and bot.is_connected)
        owner = runtime.bot_owners.get(target_bot)
        owner_name = owner.get("name") if owner else "无"
        text = f"{target_bot} | online={connected} | owner={owner_name}"
        await send_npc_response(client_id, target_bot, player, text, action="status", hologram_text="📊")
        return

    # 前置保障：执行写操作前确保 Bot 已经初始化。
    bot, created = await ensure_bot(runtime.bot_manager, target_bot)
    if created:
        await broadcast_init_config(runtime)

    # 功能 C - 权属认领：建立玩家与 Bot 的排他性主从映射。
    if command == "claim":
        current_owner = runtime.bot_owners.get(target_bot)
        # 冲突检测：防止一个女仆被多个主人同时占有。
        if current_owner and current_owner.get("uuid") != player_uuid:
            await send_npc_response(
                client_id,
                target_bot,
                player,
                f"认领失败：{target_bot} 已被 {current_owner.get('name', 'Unknown')} 占用。",
                action="claim",
                hologram_text="⛔",
            )
            return

        # 更新状态：在内存中持久化归属权并广播至全服全息图。
        runtime.bot_owners[target_bot] = {"uuid": player_uuid, "name": player}
        owner_update = {
            "type": "bot_owner_update",
            "bot_name": target_bot,
            "owner_uuid": player_uuid,
            "owner_name": player,
        }
        await manager.broadcast(json.dumps(owner_update, ensure_ascii=False))
        await send_hologram_update(target_bot, "💤 待命中", identity_line=player)
        await send_npc_response(
            client_id,
            target_bot,
            player,
            f"认领成功：{target_bot} 现在归你管理。",
            action="claim",
            hologram_text="✅",
        )
        return

    # 功能 D - 权属释放：解除映射关系，使 Bot 回归公共可用状态。
    if command == "release":
        current_owner = runtime.bot_owners.get(target_bot)
        # 逻辑保护：防止路人非法释放他人名下的女仆。
        if not current_owner:
            await send_npc_response(
                client_id,
                target_bot,
                player,
                f"{target_bot} 当前是无主状态。",
                action="release",
                hologram_text="ℹ️",
            )
            return

        if current_owner.get("uuid") != player_uuid:
            await send_npc_response(
                client_id,
                target_bot,
                player,
                f"释放失败：你不是 {target_bot} 的主人。",
                action="release",
                hologram_text="⛔",
            )
            return

        # 状态解绑：清理内存映射并更新全息显示。
        runtime.bot_owners.pop(target_bot, None)
        owner_update = {
            "type": "bot_owner_update",
            "bot_name": target_bot,
            "owner_uuid": "",
            "owner_name": "",
        }
        await manager.broadcast(json.dumps(owner_update, ensure_ascii=False))
        await send_hologram_update(target_bot, "💤 待命中", identity_line="")
        await send_npc_response(
            client_id,
            target_bot,
            player,
            f"已释放 {target_bot}。",
            action="release",
            hologram_text="🆓",
        )
        return

    await send_error(client_id, "unsupported_command", f"Unsupported command: {command}")

