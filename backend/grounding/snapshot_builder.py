import logging
from typing import Any, Dict


logger = logging.getLogger(__name__)

DEFAULT_SCAN_RADIUS = 6
DEFAULT_VERTICAL_RADIUS = 2
DEFAULT_MAX_NEARBY_BLOCKS = 20


def _player_pos_from_message(message: dict) -> dict[str, float]:
    """从插件上报消息里提取玩家坐标，作为 Mineflayer 视野之外的兜底来源。"""
    px = message.get("player_x")
    py = message.get("player_y")
    pz = message.get("player_z")
    if px is None or py is None or pz is None:
        return {}
    return {"x": px, "y": py, "z": pz}


async def build_env_snapshot(message: dict, bot_name: str, player: str, bot: object) -> Dict[str, Any]:
    """环境感知器：将原始坐标与状态打包成 LLM 可理解的语义快照。"""
    snapshot: dict[str, Any] = {}

    # 深度感知：尝试从物理执行端获取周边的方块与实体快照。
    get_environment_snapshot = getattr(bot, "get_environment_snapshot", None)
    if callable(get_environment_snapshot):
        try:
            raw_snapshot = await get_environment_snapshot(
                player_name=player,
                horizontal_radius=DEFAULT_SCAN_RADIUS,
                vertical_radius=DEFAULT_VERTICAL_RADIUS,
                max_nearby_blocks=DEFAULT_MAX_NEARBY_BLOCKS,
            )
            if isinstance(raw_snapshot, dict):
                snapshot = raw_snapshot
        except Exception as exc:
            # 容错处理：感知失败时不崩溃，仅记录调试日志。
            logger.debug("Get environment snapshot failed: %s", exc)

    # 坐标兜底：若深度快照缺失位置信息，通过基础定位接口补全。
    bot_pos = snapshot.get("bot_pos") or {}
    if not bot_pos:
        try:
            pos = await bot.get_position()
            if pos:
                bot_pos = {"x": pos[0], "y": pos[1], "z": pos[2]}
        except Exception as exc:
            logger.debug("Get bot position failed: %s", exc)

    # 玩家追踪：优先使用物理视野内的玩家位置，视野外则依赖插件上报。
    player_pos = snapshot.get("player_pos") or _player_pos_from_message(message)

    # 语义封装：返回供 LLM 决策的全量环境上下文。
    return {
        "bot_name": bot_name,
        "master_name": player,
        "bot_pos": bot_pos,
        "player_pos": player_pos,
        "inventory": snapshot.get("inventory") or {},
        "nearby_blocks": snapshot.get("nearby_blocks") or [],
        "equipped": snapshot.get("equipped"),
        "health": snapshot.get("health"),
        "food": snapshot.get("food"),
    }
