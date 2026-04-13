r"""
楼梯式采矿寻路调试脚本。

用途：
1. 绕过现有 Planner / mine action
2. 可直接查找最近铁矿坐标，或对指定坐标调用 JS 侧 stair BFS helper
3. 输出完整规划结果与执行结果，便于单独验证复杂地形下的采矿接近逻辑

推荐运行方式：
    cd backend
    uv run ..\scripts\debug_stair_mine_route.py
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

from javascript import On, require  # type: ignore

from bot.mineflayer_adapter import MineflayerBot
from config import settings


logger = logging.getLogger("stair_mine_route")


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


def _block_payload(block: Any) -> dict[str, Any] | None:
    if block is None:
        return None
    payload: dict[str, Any] = {}
    try:
        payload["name"] = str(getattr(block, "name", "") or "").strip()
    except Exception:
        payload["name"] = ""
    try:
        payload["diggable"] = bool(getattr(block, "diggable"))
    except Exception:
        payload["diggable"] = None
    try:
        payload["bounding_box"] = str(getattr(block, "boundingBox", "") or "").strip()
    except Exception:
        payload["bounding_box"] = ""
    try:
        payload["position"] = _position_to_dict(getattr(block, "position", None))
    except Exception:
        payload["position"] = None
    return payload


def _attach_connection_trace(bot: MineflayerBot) -> dict[str, Any]:
    raw_bot = bot._bot
    state: dict[str, Any] = {
        "logged_in": False,
        "spawned": False,
        "kicked": None,
        "ended": None,
        "errors": [],
        "messages": [],
    }

    @On(raw_bot, "login")
    def on_login(*args):
        state["logged_in"] = True
        logger.info("[stair_mine.connect] login event received")

    @On(raw_bot, "spawn")
    def on_spawn(*args):
        state["spawned"] = True
        logger.info("[stair_mine.connect] spawn event received")

    @On(raw_bot, "kicked")
    def on_kicked(this, reason, logged_in, *args):
        payload = {
            "reason": str(reason or "").strip(),
            "logged_in": bool(logged_in),
        }
        state["kicked"] = payload
        logger.error("[stair_mine.connect] kicked %s", json.dumps(payload, ensure_ascii=False, sort_keys=True))

    @On(raw_bot, "end")
    def on_end(this, reason, *args):
        payload = {"reason": str(reason or "").strip()}
        state["ended"] = payload
        logger.error("[stair_mine.connect] end %s", json.dumps(payload, ensure_ascii=False, sort_keys=True))

    @On(raw_bot, "error")
    def on_error(this, err, *args):
        text = str(err or "").strip()
        if text:
            state["errors"] = [*state["errors"], text][-5:]
        logger.error("[stair_mine.connect] error %s", text or "<empty>")

    @On(raw_bot, "message")
    def on_message(this, message, *args):
        text = str(message or "").strip()
        if not text:
            return
        state["messages"] = [*state["messages"], text][-5:]
        logger.info("[stair_mine.connect] message %s", text)

    return state


async def _wait_until_spawned(
    bot: MineflayerBot,
    *,
    timeout_seconds: float = 45.0,
    connection_trace: dict[str, Any] | None = None,
) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if getattr(getattr(bot, "_bot", None), "entity", None) is not None:
            return
        await asyncio.sleep(0.2)
    payload = {
        "timeout_seconds": timeout_seconds,
        "connected_flag": bool(getattr(bot, "_connected", False)),
        "entity_present": getattr(getattr(bot, "_bot", None), "entity", None) is not None,
        "trace": connection_trace or {},
    }
    raise TimeoutError(
        "Bot 已连接但在超时时间内未完成 spawn: "
        + json.dumps(payload, ensure_ascii=False, sort_keys=True)
    )


async def _wait_until_world_ready(bot: MineflayerBot, *, timeout_seconds: float = 20.0) -> None:
    raw_bot = getattr(bot, "_bot", None)
    if raw_bot is None:
        raise RuntimeError("Bot 尚未初始化")

    wait_for_chunks = getattr(raw_bot, "waitForChunksToLoad", None)
    if callable(wait_for_chunks):
        logger.info("[stair_mine.connect] waiting for chunks to load")
        loop = asyncio.get_running_loop()
        await asyncio.wait_for(
            loop.run_in_executor(
                None,
                lambda: wait_for_chunks(timeout=None),
            ),
            timeout=max(float(timeout_seconds or 0.0), 1.0),
        )
        logger.info("[stair_mine.connect] chunks ready")

    deadline = time.time() + max(float(timeout_seconds or 0.0), 1.0)
    while time.time() < deadline:
        entity = getattr(raw_bot, "entity", None)
        position = getattr(entity, "position", None)
        if position is not None and raw_bot.blockAt(position.floored()) is not None:
            logger.info(
                "[stair_mine.connect] world ready at %s",
                json.dumps(_position_to_dict(position), ensure_ascii=False, sort_keys=True),
            )
            return
        await asyncio.sleep(0.2)

    position = getattr(getattr(raw_bot, "entity", None), "position", None)
    raise TimeoutError(
        "Bot 已 spawn，但周围区块仍未准备完成: "
        + json.dumps(
            {
                "bot_position": _position_to_dict(position),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )


def _load_helper(bot: MineflayerBot):
    helper_factory = require(str(BACKEND_DIR / "bot" / "mineflayer" / "assets" / "stair_mining_helper.js"))
    return helper_factory(bot._bot, bot._pathfinder, bot._mcData)


def _resolve_target_from_resource(
    bot: MineflayerBot,
    *,
    resource_key: str,
    search_radius: int,
) -> dict[str, Any]:
    normalized_resource = str(resource_key or "").strip() or "iron_ore"
    profile = bot._resource_profile_sync(normalized_resource)
    base_radius = max(int(profile.get("radius", 32) or 32), 8)
    requested_radius = max(int(search_radius or 0), base_radius)
    tried_radii: list[int] = []

    block = None
    cluster_context = None
    selected_block_payload = None
    for radius in dict.fromkeys(
        [
            base_radius,
            min(max(base_radius * 2, 48), requested_radius),
            requested_radius,
        ]
    ):
        effective_radius = max(int(radius or 0), base_radius)
        tried_radii.append(effective_radius)
        bot._refresh_resource_cache_sync(radius=effective_radius)
        block, cluster_context, selected_block_payload = bot._pick_cluster_candidate(
            normalized_resource,
            attempt_key=f"debug_stair_mine:{normalized_resource}",
        )
        if block is not None:
            break

    if block is None:
        candidate_names: list[str] = []
        source = profile.get("candidate_block_source") if isinstance(profile, dict) else None
        if isinstance(source, dict):
            for name in list(source.get("block_names") or []):
                normalized_name = str(name or "").strip()
                if normalized_name:
                    candidate_names.append(normalized_name)

        nearest_block = None
        nearest_name = ""
        nearest_distance = float("inf")
        for name in candidate_names:
            matched = bot._find_block_by_name(name, max_distance=requested_radius)
            if matched is None or getattr(matched, "position", None) is None:
                continue
            try:
                position = getattr(getattr(bot._bot, "entity", None), "position", None)
                distance = float(position.distanceTo(getattr(matched, "position"))) if position is not None else 0.0
            except Exception:
                distance = 0.0
            if nearest_block is None or distance < nearest_distance:
                nearest_block = matched
                nearest_name = name
                nearest_distance = distance
        if nearest_block is not None:
            pos = getattr(nearest_block, "position", None)
            return {
                "resource_key": normalized_resource,
                "resolved_via": "plain_block_fallback",
                "selected_block": {
                    "name": nearest_name or str(getattr(nearest_block, "name", "") or "").strip(),
                    "x": int(getattr(pos, "x")),
                    "y": int(getattr(pos, "y")),
                    "z": int(getattr(pos, "z")),
                },
                "tried_radii": tried_radii,
                "resource_cluster": cluster_context or {},
            }
        raise RuntimeError(
            f"未找到可见目标资源: {normalized_resource} "
            f"(tried_radii={tried_radii}, search_radius={requested_radius})"
        )

    selected_payload = selected_block_payload or {}
    if not selected_payload and getattr(block, "position", None) is not None:
        pos = getattr(block, "position")
        selected_payload = {
            "name": str(getattr(block, "name", "") or "").strip(),
            "x": int(getattr(pos, "x")),
            "y": int(getattr(pos, "y")),
            "z": int(getattr(pos, "z")),
        }
    return {
        "resource_key": normalized_resource,
        "resolved_via": "resource_cache_cluster",
        "selected_block": selected_payload,
        "tried_radii": tried_radii,
        "resource_cluster": cluster_context or {},
    }


async def _run_trial(bot: MineflayerBot, x: int, y: int, z: int) -> dict[str, Any]:
    helper = _load_helper(bot)
    target = {"x": x, "y": y, "z": z}
    raw_bot = bot._bot
    loop = asyncio.get_running_loop()

    before_payload = {
        "target": target,
        "bot_position_before": _position_to_dict(getattr(getattr(raw_bot, "entity", None), "position", None)),
        "target_block_before": _block_payload(raw_bot.blockAt(bot._Vec3(x, y, z))),
    }
    logger.info("[stair_mine.test] precheck %s", json.dumps(before_payload, ensure_ascii=False, sort_keys=True))

    raw_plan = await loop.run_in_executor(
        None,
        lambda: helper.planStairPathToBlockJson(
            target,
            bot._stair_debug_options,
            timeout=None,
        ),
    )
    plan = json.loads(str(raw_plan or "").strip() or "{}")
    logger.info("[stair_mine.test] plan %s", json.dumps(plan, ensure_ascii=False, sort_keys=True))

    raw_result = await loop.run_in_executor(
        None,
        lambda: helper.executeStairPathToBlockJson(
            target,
            bot._stair_debug_options,
            timeout=None,
        ),
    )
    result = json.loads(str(raw_result or "").strip() or "{}")
    result["bot_position_after"] = _position_to_dict(getattr(getattr(raw_bot, "entity", None), "position", None))
    result["target_block_after"] = _block_payload(raw_bot.blockAt(bot._Vec3(x, y, z)))
    return result


async def _main() -> None:
    parser = argparse.ArgumentParser(description="楼梯式采矿寻路调试脚本")
    parser.add_argument("--x", type=int, help="目标方块 X；不传则自动查找最近铁矿")
    parser.add_argument("--y", type=int, help="目标方块 Y；不传则自动查找最近铁矿")
    parser.add_argument("--z", type=int, help="目标方块 Z；不传则自动查找最近铁矿")
    parser.add_argument("--host", default=settings.mc_host, help="Minecraft 服务器地址")
    parser.add_argument("--port", type=int, default=settings.mc_port, help="Minecraft 服务器端口")
    parser.add_argument("--version", default=settings.mc_version, help="Minecraft 协议版本")
    parser.add_argument("--username", default=settings.bot_username, help="Bot 用户名")
    parser.add_argument("--password", default=settings.bot_password, help="Bot 密码")
    parser.add_argument("--spawn-timeout", type=float, default=45.0, help="等待 login/spawn 的超时时间（秒）")
    parser.add_argument("--target-resource", default="iron_ore", help="自动查找模式下的资源 key，默认 iron_ore")
    parser.add_argument("--resource-radius", type=int, default=96, help="自动查找资源时的最大扫描半径")
    parser.add_argument("--horizontal-padding", type=int, default=8, help="BFS 水平搜索边界扩展")
    parser.add_argument("--vertical-padding", type=int, default=6, help="BFS 垂直搜索边界扩展")
    parser.add_argument("--max-nodes", type=int, default=20000, help="BFS 最大展开节点数")
    parser.add_argument("--step-timeout-ms", type=int, default=8000, help="单步移动超时（毫秒，传 0 表示禁用）")
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
    bot._stair_debug_options = {
        "horizontalPadding": max(int(args.horizontal_padding or 0), 3),
        "verticalPadding": max(int(args.vertical_padding or 0), 2),
        "maxNodes": max(int(args.max_nodes or 0), 64),
        "stepTimeoutMs": int(args.step_timeout_ms),
    }

    try:
        connected = await bot.connect()
        if not connected:
            raise RuntimeError("Bot 连接失败")
        connection_trace = _attach_connection_trace(bot)
        await _wait_until_spawned(
            bot,
            timeout_seconds=max(float(args.spawn_timeout or 0.0), 5.0),
            connection_trace=connection_trace,
        )
        await _wait_until_world_ready(
            bot,
            timeout_seconds=min(max(float(args.spawn_timeout or 0.0), 5.0), 20.0),
        )
        if args.x is None or args.y is None or args.z is None:
            resolved_target = _resolve_target_from_resource(
                bot,
                resource_key=args.target_resource,
                search_radius=max(int(args.resource_radius or 0), 8),
            )
            logger.info(
                "[stair_mine.test] resolved_target %s",
                json.dumps(resolved_target, ensure_ascii=False, sort_keys=True),
            )
            selected_block = resolved_target.get("selected_block") if isinstance(resolved_target, dict) else None
            if not isinstance(selected_block, dict):
                raise RuntimeError(f"自动查找资源失败: {args.target_resource}")
            target_x = int(selected_block.get("x"))
            target_y = int(selected_block.get("y"))
            target_z = int(selected_block.get("z"))
        else:
            target_x = int(args.x)
            target_y = int(args.y)
            target_z = int(args.z)
        result = await _run_trial(bot, target_x, target_y, target_z)
        if result.get("ok"):
            logger.info("[stair_mine.test] result %s", json.dumps(result, ensure_ascii=False, sort_keys=True))
            return
        logger.error("[stair_mine.test] result %s", json.dumps(result, ensure_ascii=False, sort_keys=True))
        raise SystemExit(1)
    finally:
        await bot.disconnect()


if __name__ == "__main__":
    asyncio.run(_main())
