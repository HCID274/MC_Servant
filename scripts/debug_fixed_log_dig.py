r"""
固定坐标原木直挖诊断脚本。

用途：
1. 绕过现有 Planner / task_queue / collectblock
2. 直接对指定坐标调用底层 `bot.dig(block)`
3. 记录挖前 / 挖后方块状态、距离、主手物品，以及关键事件

推荐运行方式：
    cd backend
    uv run ..\scripts\debug_fixed_log_dig.py --x -38 --y 72 --z 87
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
os.chdir(BACKEND_DIR)
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from javascript import On  # type: ignore

from bot.mineflayer_adapter import MineflayerBot
from config import settings


logger = logging.getLogger("fixed_log_dig")


def _position_to_dict(pos: Any) -> dict[str, float] | None:
    if pos is None:
        return None
    try:
        return {
            "x": round(float(getattr(pos, "x")), 2),
            "y": round(float(getattr(pos, "y")), 2),
            "z": round(float(getattr(pos, "z")), 2),
        }
    except Exception:
        return None


def _block_payload(block: Any) -> dict[str, Any]:
    if block is None:
        return {}
    payload: dict[str, Any] = {}
    try:
        payload["name"] = str(getattr(block, "name", "") or "").strip()
    except Exception:
        payload["name"] = ""
    try:
        payload["display_name"] = str(getattr(block, "displayName", "") or "").strip()
    except Exception:
        payload["display_name"] = ""
    try:
        payload["type"] = int(getattr(block, "type"))
    except Exception:
        payload["type"] = None
    try:
        payload["diggable"] = bool(getattr(block, "diggable"))
    except Exception:
        payload["diggable"] = None
    try:
        payload["position"] = _position_to_dict(getattr(block, "position", None))
    except Exception:
        payload["position"] = None
    return payload


def _held_item_name(bot: MineflayerBot) -> str:
    try:
        held_item = getattr(bot._bot, "heldItem", None)
        return str(getattr(held_item, "name", "") or "").strip()
    except Exception:
        return ""


def _inventory_counts(bot: MineflayerBot) -> dict[str, int]:
    inventory = getattr(bot._bot, "inventory", None)
    if inventory is None or not hasattr(inventory, "items"):
        return {}
    counts: dict[str, int] = {}
    try:
        for item in inventory.items():
            name = str(getattr(item, "name", "") or "").strip()
            if not name:
                continue
            counts[name] = counts.get(name, 0) + int(getattr(item, "count", 0) or 0)
    except Exception:
        return {}
    return dict(sorted(counts.items()))


def _distance_to_block(bot: MineflayerBot, block: Any) -> float | None:
    try:
        bot_pos = getattr(getattr(bot._bot, "entity", None), "position", None)
        block_pos = getattr(block, "position", None)
        if bot_pos is None or block_pos is None:
            return None
        return round(float(bot_pos.distanceTo(block_pos)), 3)
    except Exception:
        return None


def _entity_payload(entity: Any) -> dict[str, Any]:
    if entity is None:
        return {}
    payload: dict[str, Any] = {}
    try:
        payload["kind"] = str(getattr(entity, "kind", "") or "").strip()
    except Exception:
        payload["kind"] = ""
    try:
        payload["name"] = str(getattr(entity, "name", "") or "").strip()
    except Exception:
        payload["name"] = ""
    try:
        payload["display_name"] = str(getattr(entity, "displayName", "") or "").strip()
    except Exception:
        payload["display_name"] = ""
    try:
        payload["position"] = _position_to_dict(getattr(entity, "position", None))
    except Exception:
        payload["position"] = None
    return payload


async def _wait_until_spawned(bot: MineflayerBot, timeout_seconds: float = 15.0) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if getattr(getattr(bot, "_bot", None), "entity", None) is not None:
            return
        await asyncio.sleep(0.2)
    raise TimeoutError("Bot 已连接但在超时时间内未完成 spawn")


async def _direct_dig(bot: MineflayerBot, x: int, y: int, z: int) -> None:
    raw_bot = bot._bot
    vec = bot._Vec3(x, y, z)
    event_log: list[dict[str, Any]] = []

    def _record_event(event_name: str, payload: dict[str, Any]) -> None:
        item = {"event": event_name, **payload}
        event_log.append(item)
        logger.info("[direct_dig.test] event %s", json.dumps(item, ensure_ascii=False, sort_keys=True))

    def _same_target(block: Any) -> bool:
        pos = _position_to_dict(getattr(block, "position", None))
        return pos == {"x": float(x), "y": float(y), "z": float(z)}

    @On(raw_bot, "diggingCompleted")
    def on_digging_completed(this, block, *args):
        if _same_target(block):
            _record_event("diggingCompleted", {"block": _block_payload(block)})

    @On(raw_bot, "diggingAborted")
    def on_digging_aborted(this, block, *args):
        if _same_target(block):
            _record_event("diggingAborted", {"block": _block_payload(block)})

    @On(raw_bot, "blockUpdate")
    def on_block_update(this, old_block, new_block, *args):
        if _same_target(old_block) or _same_target(new_block):
            _record_event(
                "blockUpdate",
                {
                    "old_block": _block_payload(old_block),
                    "new_block": _block_payload(new_block),
                },
            )

    @On(raw_bot, "itemDrop")
    def on_item_drop(this, entity, *args):
        _record_event("itemDrop", {"entity": _entity_payload(entity)})

    @On(raw_bot, "playerCollect")
    def on_player_collect(this, collector, collected, *args):
        _record_event(
            "playerCollect",
            {
                "collector": _entity_payload(collector),
                "collected": _entity_payload(collected),
            },
        )

    loop = asyncio.get_running_loop()

    def _run_sync_dig() -> dict[str, Any]:
        target_block = raw_bot.blockAt(vec)
        before_payload = {
            "target": {"x": x, "y": y, "z": z},
            "before_block": _block_payload(target_block),
            "held_item_before": _held_item_name(bot),
            "inventory_before": _inventory_counts(bot),
            "distance_before": _distance_to_block(bot, target_block),
            "bot_pos_before": _position_to_dict(getattr(getattr(raw_bot, "entity", None), "position", None)),
        }
        if target_block is None:
            return {
                "ok": False,
                "stage": "resolve_target",
                "summary": before_payload,
                "error": "指定坐标读取不到方块",
            }

        logger.info("[direct_dig.test] precheck %s", json.dumps(before_payload, ensure_ascii=False, sort_keys=True))

        started_at = time.perf_counter()
        try:
            raw_bot.dig(target_block)
            checkpoints: dict[str, dict[str, Any]] = {}
            for label, delay in (("after_1s", 1.0), ("after_3s", 2.0), ("after_5s", 2.0)):
                time.sleep(delay)
                checkpoint_block = raw_bot.blockAt(vec)
                checkpoints[label] = {
                    "block": _block_payload(checkpoint_block),
                    "inventory": _inventory_counts(bot),
                    "held_item": _held_item_name(bot),
                }
            after_block = raw_bot.blockAt(vec)
            return {
                "ok": True,
                "stage": "execute",
                "summary": {
                    **before_payload,
                    "duration_ms": int((time.perf_counter() - started_at) * 1000),
                    "after_block": _block_payload(after_block),
                    "held_item_after": _held_item_name(bot),
                    "inventory_after": _inventory_counts(bot),
                    "distance_after": _distance_to_block(bot, after_block),
                    "bot_pos_after": _position_to_dict(getattr(getattr(raw_bot, "entity", None), "position", None)),
                    "checkpoints": checkpoints,
                    "events": list(event_log),
                },
            }
        except Exception as exc:
            after_block = raw_bot.blockAt(vec)
            return {
                "ok": False,
                "stage": "execute",
                "error_type": type(exc).__name__ or "DigFailed",
                "error_message": str(exc or "").strip() or "direct dig failed",
                "summary": {
                    **before_payload,
                    "duration_ms": int((time.perf_counter() - started_at) * 1000),
                    "after_block": _block_payload(after_block),
                    "held_item_after": _held_item_name(bot),
                    "inventory_after": _inventory_counts(bot),
                    "distance_after": _distance_to_block(bot, after_block),
                    "bot_pos_after": _position_to_dict(getattr(getattr(raw_bot, "entity", None), "position", None)),
                    "events": list(event_log),
                },
            }

    result = await loop.run_in_executor(None, _run_sync_dig)
    if result.get("ok"):
        logger.info("[direct_dig.test] result %s", json.dumps(result, ensure_ascii=False, sort_keys=True))
        return
    logger.error("[direct_dig.test] result %s", json.dumps(result, ensure_ascii=False, sort_keys=True))


async def _main() -> None:
    parser = argparse.ArgumentParser(description="固定坐标直挖诊断脚本")
    parser.add_argument("--x", type=int, required=True, help="目标方块 X")
    parser.add_argument("--y", type=int, required=True, help="目标方块 Y")
    parser.add_argument("--z", type=int, required=True, help="目标方块 Z")
    parser.add_argument("--host", default=settings.mc_host, help="Minecraft 服务器地址")
    parser.add_argument("--port", type=int, default=settings.mc_port, help="Minecraft 服务器端口")
    parser.add_argument("--version", default=settings.mc_version, help="Minecraft 协议版本")
    parser.add_argument("--username", default=settings.bot_username, help="Bot 用户名")
    parser.add_argument("--password", default=settings.bot_password, help="Bot 密码")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    bot = MineflayerBot(
        host=args.host,
        port=args.port,
        username=args.username,
        password=args.password,
        version=args.version,
    )

    try:
        connected = await bot.connect()
        if not connected:
            raise RuntimeError("Bot 连接失败")
        await _wait_until_spawned(bot)
        await asyncio.sleep(1.0)
        await _direct_dig(bot, args.x, args.y, args.z)
    finally:
        await bot.disconnect()


if __name__ == "__main__":
    asyncio.run(_main())
