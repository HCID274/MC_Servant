import logging
from typing import Any, Dict

from schemas import EnvSnapshot, NearbyBlockSnapshot, PositionSnapshot


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


def _normalize_position(value: Any) -> PositionSnapshot:
    """统一坐标结构，过滤非法值并保证数值类型稳定。"""
    if not isinstance(value, dict):
        return {}
    normalized: PositionSnapshot = {}
    for axis in ("x", "y", "z"):
        raw = value.get(axis)
        if raw is None:
            continue
        try:
            normalized[axis] = float(raw)
        except Exception:
            continue
    return normalized


def _normalize_inventory(value: Any) -> dict[str, int]:
    """统一背包摘要结构，只保留正整数数量。"""
    if not isinstance(value, dict):
        return {}
    inventory: dict[str, int] = {}
    for raw_name, raw_count in value.items():
        item_name = str(raw_name or "").strip()
        if not item_name:
            continue
        try:
            item_count = int(raw_count or 0)
        except Exception:
            continue
        if item_count <= 0:
            continue
        inventory[item_name] = item_count
    return inventory


def _normalize_nearby_blocks(value: Any) -> list[NearbyBlockSnapshot]:
    """统一附近方块摘要，剔除不完整条目并固定字段类型。"""
    if not isinstance(value, list):
        return []

    normalized: list[NearbyBlockSnapshot] = []
    for entry in value:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            continue

        try:
            count = int(entry.get("count", 0) or 0)
        except Exception:
            count = 0

        try:
            cluster_count = int(entry.get("cluster_count", 0) or 0)
        except Exception:
            cluster_count = 0

        normalized.append(
            {
                "name": name,
                "count": count,
                "cluster_count": max(cluster_count, 0),
            }
        )
    return normalized


def normalize_env_snapshot(
    snapshot: Any,
    *,
    bot_name: str = "Maid",
    player: str = "Master",
) -> EnvSnapshot:
    """环境快照标准化：将任意来源的原始字典收口为唯一标准结构。"""
    source = snapshot if isinstance(snapshot, dict) else {}

    health_value = source.get("health")
    try:
        health = float(health_value) if health_value is not None else None
    except Exception:
        health = None

    food_value = source.get("food")
    try:
        food = int(food_value) if food_value is not None else None
    except Exception:
        food = None

    equipped_value = source.get("equipped")
    equipped = str(equipped_value).strip() if equipped_value is not None else None
    if equipped == "":
        equipped = None

    return {
        "bot_name": str(source.get("bot_name") or bot_name or "Maid"),
        "master_name": str(source.get("master_name") or player or "Master"),
        "bot_pos": _normalize_position(source.get("bot_pos")),
        "player_pos": _normalize_position(source.get("player_pos")),
        "inventory": _normalize_inventory(source.get("inventory")),
        "nearby_blocks": _normalize_nearby_blocks(source.get("nearby_blocks")),
        "nearby_crafting_table": bool(source.get("nearby_crafting_table")) if source.get("nearby_crafting_table") is not None else None,
        "equipped": equipped,
        "health": health,
        "food": food,
    }


async def build_env_snapshot(message: dict, bot_name: str, player: str, bot: object) -> EnvSnapshot:
    """环境感知器：采样并标准化全链路唯一的环境快照。"""
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
    return normalize_env_snapshot(
        {
        "bot_name": bot_name,
        "master_name": player,
        "bot_pos": bot_pos,
        "player_pos": player_pos,
        "inventory": snapshot.get("inventory") or {},
        "nearby_blocks": snapshot.get("nearby_blocks") or [],
        "nearby_crafting_table": snapshot.get("nearby_crafting_table"),
        "equipped": snapshot.get("equipped"),
        "health": snapshot.get("health"),
        "food": snapshot.get("food"),
        },
        bot_name=bot_name,
        player=player,
    )
