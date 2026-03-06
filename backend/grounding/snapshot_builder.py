import logging
from typing import Any, Dict


logger = logging.getLogger(__name__)


async def build_env_snapshot(message: dict, bot_name: str, player: str, bot: object) -> Dict[str, Any]:
    """环境感知器：将原始坐标与状态打包成 LLM 可理解的语义快照。"""
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
        "inventory": {},
        "nearby_blocks": [],
    }

