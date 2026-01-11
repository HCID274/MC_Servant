# Perception system (scan & semantic location)

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional, Dict, Any, List

from bot.drivers.interfaces import IDriverAdapter
from bot.interfaces import ActionResult, ActionStatus

logger = logging.getLogger(__name__)


class PerceptionSystem:
    def __init__(self, driver: IDriverAdapter) -> None:
        self._driver = driver

    async def scan(self, target_type: str, radius: int = 32) -> ActionResult:
        start_time = time.time()

        try:
            targets = []

            if target_type == "player":
                for name in self._driver.get_player_names():
                    player = self._driver.get_player(name)
                    if player and player.entity and name != self._driver.username:
                        pos = player.entity.position
                        dist = self._driver.get_position().distanceTo(pos)
                        if dist <= radius:
                            targets.append({
                                "name": name,
                                "type": "player",
                                "position": [int(pos.x), int(pos.y), int(pos.z)],
                                "distance": int(dist)
                            })

            elif target_type in ("mob", "entity"):
                for entity_id, entity in self._driver.get_entities().items():
                    if entity.type == "mob" or entity.type == "animal":
                        pos = entity.position
                        dist = self._driver.get_position().distanceTo(pos)
                        if dist <= radius:
                            targets.append({
                                "name": entity.name or entity.type,
                                "type": entity.type,
                                "position": [int(pos.x), int(pos.y), int(pos.z)],
                                "distance": int(dist)
                            })

            else:
                block_id = self._driver.get_block_id(target_type)
                if block_id is not None:
                    blocks_proxy = await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: self._driver.find_blocks({
                            "matching": block_id,
                            "maxDistance": radius,
                            "count": 64
                        })
                    )

                    blocks = list(blocks_proxy) if blocks_proxy else []

                    if blocks:
                        bot_pos = self._driver.get_position()
                        nearest = None
                        nearest_dist = float("inf")

                        for block_pos in blocks:
                            try:
                                dist = bot_pos.distanceTo(block_pos)
                                if dist < nearest_dist:
                                    nearest_dist = dist
                                    nearest = block_pos
                            except Exception:
                                pass

                        targets.append({
                            "name": target_type,
                            "count": len(blocks),
                            "nearest": [int(nearest.x), int(nearest.y), int(nearest.z)] if nearest else None,
                            "distance": int(nearest_dist) if nearest and nearest_dist != float("inf") else None
                        })

            return ActionResult(
                success=True,
                action="scan",
                message=f"扫描完成，找到 {len(targets)} 个目标",
                status=ActionStatus.SUCCESS,
                data={"targets": targets},
                duration_ms=int((time.time() - start_time) * 1000)
            )

        except Exception as e:
            logger.error(f"scan failed: {e}")
            return ActionResult(
                success=False,
                action="scan",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                duration_ms=int((time.time() - start_time) * 1000)
            )

    async def find_location(
        self,
        feature: str,
        radius: int = 64,
        count: int = 1
    ) -> ActionResult:
        start_time = time.time()
        feature = feature.lower().strip()

        try:
            bot_pos = self._driver.get_position()
            candidates = []

            if feature == "highest":
                step = max(4, min(8, radius // 10))
                max_y = -999
                best_pos = None
                best_dist = float("inf")

                for x in range(int(bot_pos.x - radius), int(bot_pos.x + radius + 1), step):
                    for z in range(int(bot_pos.z - radius), int(bot_pos.z + radius + 1), step):
                        dx, dz = x - bot_pos.x, z - bot_pos.z
                        if dx * dx + dz * dz > radius * radius:
                            continue

                        y = self._get_highest_block_y_at(x, z)
                        if y is not None:
                            dist = ((x - bot_pos.x) ** 2 + (z - bot_pos.z) ** 2) ** 0.5
                            if y > max_y or (y == max_y and dist < best_dist):
                                max_y = y
                                best_pos = (x, y, z)
                                best_dist = dist

                if best_pos:
                    candidates.append({
                        "x": best_pos[0],
                        "y": best_pos[1],
                        "z": best_pos[2],
                        "description": f"Highest point (Y={best_pos[1]})",
                        "distance": round(best_dist, 1)
                    })

            elif feature == "lowest":
                step = max(4, min(8, radius // 10))
                min_y = 999
                best_pos = None
                best_dist = float("inf")

                for x in range(int(bot_pos.x - radius), int(bot_pos.x + radius + 1), step):
                    for z in range(int(bot_pos.z - radius), int(bot_pos.z + radius + 1), step):
                        dx, dz = x - bot_pos.x, z - bot_pos.z
                        if dx * dx + dz * dz > radius * radius:
                            continue

                        y = self._get_highest_block_y_at(x, z)
                        if y is not None and y > 0:
                            dist = ((x - bot_pos.x) ** 2 + (z - bot_pos.z) ** 2) ** 0.5
                            if y < min_y or (y == min_y and dist < best_dist):
                                min_y = y
                                best_pos = (x, y, z)
                                best_dist = dist

                if best_pos:
                    candidates.append({
                        "x": best_pos[0],
                        "y": best_pos[1],
                        "z": best_pos[2],
                        "description": f"Lowest point (Y={best_pos[1]})",
                        "distance": round(best_dist, 1)
                    })

            elif feature == "flat":
                step = 5
                best_pos = None
                best_variance = float("inf")
                best_dist = float("inf")

                for cx in range(int(bot_pos.x - radius), int(bot_pos.x + radius + 1), step):
                    for cz in range(int(bot_pos.z - radius), int(bot_pos.z + radius + 1), step):
                        dx, dz = cx - bot_pos.x, cz - bot_pos.z
                        if dx * dx + dz * dz > radius * radius:
                            continue

                        heights = []
                        for ox in range(-2, 3):
                            for oz in range(-2, 3):
                                y = self._get_highest_block_y_at(cx + ox, cz + oz)
                                if y is not None:
                                    heights.append(y)

                        if len(heights) >= 20:
                            avg_y = sum(heights) / len(heights)
                            variance = sum((h - avg_y) ** 2 for h in heights) / len(heights)
                            dist = ((cx - bot_pos.x) ** 2 + (cz - bot_pos.z) ** 2) ** 0.5

                            if variance < best_variance or (variance == best_variance and dist < best_dist):
                                best_variance = variance
                                best_pos = (cx, int(avg_y) + 1, cz)
                                best_dist = dist

                if best_pos and best_variance < 2.0:
                    candidates.append({
                        "x": best_pos[0],
                        "y": best_pos[1],
                        "z": best_pos[2],
                        "description": f"Flat area (variance={best_variance:.2f})",
                        "distance": round(best_dist, 1)
                    })

            elif feature == "water":
                water_id = None
                try:
                    water_id = self._driver.get_block_id("water")
                except Exception:
                    pass

                if water_id:
                    blocks = await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: self._driver.find_blocks({
                            "matching": water_id,
                            "maxDistance": radius,
                            "count": count * 5
                        })
                    )

                    blocks = list(blocks) if blocks else []

                    water_blocks = []
                    for b in blocks:
                        dist = bot_pos.distanceTo(b)
                        water_blocks.append((b, dist))

                    water_blocks.sort(key=lambda x: x[1])

                    for b, dist in water_blocks[:count]:
                        candidates.append({
                            "x": int(b.x),
                            "y": int(b.y),
                            "z": int(b.z),
                            "description": "Water source",
                            "distance": round(dist, 1)
                        })

            elif feature in ("tree", "forest"):
                log_types = [
                    "oak_log", "birch_log", "spruce_log", "jungle_log",
                    "acacia_log", "dark_oak_log", "cherry_log", "mangrove_log"
                ]

                all_logs = []
                for log_name in log_types:
                    try:
                        log_id = self._driver.get_block_id(log_name)
                        if log_id is not None:
                            blocks = self._driver.find_blocks({
                                "matching": log_id,
                                "maxDistance": radius,
                                "count": 64
                            })
                            all_logs.extend(list(blocks) if blocks else [])
                    except Exception:
                        pass

                if all_logs:
                    nearest = min(all_logs, key=lambda b: bot_pos.distanceTo(b))
                    dist = bot_pos.distanceTo(nearest)

                    candidates.append({
                        "x": int(nearest.x),
                        "y": int(nearest.y),
                        "z": int(nearest.z),
                        "description": f"Tree/Forest area ({len(all_logs)} logs nearby)",
                        "distance": round(dist, 1)
                    })

            else:
                return ActionResult(
                    success=False,
                    action="find_location",
                    message=(
                        f"Unknown feature type: {feature}. "
                        "Supported: highest, lowest, flat, water, tree"
                    ),
                    status=ActionStatus.FAILED,
                    error_code="INVALID_PARAM",
                    duration_ms=int((time.time() - start_time) * 1000)
                )

            if not candidates:
                return ActionResult(
                    success=False,
                    action="find_location",
                    message=f"No location found matching feature '{feature}' within {radius} blocks",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND",
                    data={"feature": feature, "locations": []},
                    duration_ms=int((time.time() - start_time) * 1000)
                )

            return ActionResult(
                success=True,
                action="find_location",
                message=f"Found {len(candidates)} location(s) matching '{feature}'",
                status=ActionStatus.SUCCESS,
                data={"feature": feature, "locations": candidates},
                duration_ms=int((time.time() - start_time) * 1000)
            )

        except Exception as e:
            logger.error(f"find_location failed: {e}")
            return ActionResult(
                success=False,
                action="find_location",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                duration_ms=int((time.time() - start_time) * 1000)
            )

    def get_highest_block_y_at(self, x: int, z: int) -> Optional[int]:
        return self._get_highest_block_y_at(x, z)

    def _get_highest_block_y_at(self, x: int, z: int) -> Optional[int]:
        try:
            start_y = min(320, int(self._driver.get_position().y) + 64)

            for y in range(start_y, -64, -1):
                try:
                    block = self._driver.block_at({"x": x, "y": y, "z": z})
                    if block and block.name not in ("air", "void_air", "cave_air"):
                        above = self._driver.block_at({"x": x, "y": y + 1, "z": z})
                        if above and above.name in ("air", "void_air", "cave_air"):
                            return y + 1
                except Exception:
                    pass

            return None
        except Exception:
            return None
