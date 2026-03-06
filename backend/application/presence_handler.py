from typing import Optional

from application.context import AppRuntime
from application.response_sender import send_hologram_update


def _is_known_bot_player(player_name: Optional[str], runtime: AppRuntime) -> bool:
    if not player_name:
        return False

    if runtime.bot_username and player_name == runtime.bot_username:
        return True

    if runtime.bot_manager and player_name in runtime.bot_manager.list_bots():
        return True

    return False


async def handle_presence_message(message: dict, runtime: AppRuntime) -> None:
    msg_type = message.get("type")
    player = message.get("player")
    player_uuid = message.get("player_uuid")

    if msg_type in {"player_join", "player_login"} and player and player_uuid:
        runtime.online_players[player_uuid] = {"name": player, "uuid": player_uuid}
        if _is_known_bot_player(player, runtime):
            owner = runtime.bot_owners.get(player)
            await send_hologram_update(
                player,
                "💤 待命中",
                identity_line=owner["name"] if owner else "",
            )
        return

    if msg_type == "player_quit" and player_uuid:
        runtime.online_players.pop(player_uuid, None)
        return

    if msg_type in {"init_sync", "online_players_sync"}:
        players = message.get("players") or []
        runtime.online_players.clear()
        for item in players:
            puid = item.get("uuid")
            pname = item.get("name")
            if not puid or not pname:
                continue
            runtime.online_players[puid] = {"name": pname, "uuid": puid}
            if _is_known_bot_player(pname, runtime):
                owner = runtime.bot_owners.get(pname)
                await send_hologram_update(
                    pname,
                    "💤 待命中",
                    identity_line=owner["name"] if owner else "",
                )

