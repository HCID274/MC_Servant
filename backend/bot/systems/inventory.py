# Inventory and item interaction system

from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import Optional, Dict, Any, List

from bot.drivers.interfaces import IDriverAdapter
from bot.interfaces import ActionResult, ActionStatus
from bot.systems.common import BackgroundTaskManager, ProgressTimer
from bot.systems.movement import MovementSystem

logger = logging.getLogger(__name__)


class InventorySystem:
    def __init__(
        self,
        driver: IDriverAdapter,
        background: BackgroundTaskManager,
        movement: MovementSystem,
    ) -> None:
        self._driver = driver
        self._bot = driver.bot
        self._mcData = driver.mcdata
        self._movement = movement
        self._background = background
        self._progress_timer: Optional[ProgressTimer] = None

    async def give(self, player_name: str, item_name: str, count: int = 1, timeout: float = 30.0) -> ActionResult:
        start_time = time.time()

        try:
            try:
                player = self._bot.players[player_name]
            except (KeyError, TypeError):
                player = None
            if not player or not player.entity:
                return ActionResult(
                    success=False,
                    action="give",
                    message=f"找不到玩家 {player_name}",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )

            item = self.find_inventory_item(item_name)
            if not item:
                return ActionResult(
                    success=False,
                    action="give",
                    message=f"背包中没有 {item_name}",
                    status=ActionStatus.FAILED,
                    error_code="INSUFFICIENT_MATERIALS"
                )

            reach_distance = 3.0
            try:
                bot_pos = self._bot.entity.position
                target_pos = player.entity.position
                try:
                    dist = float(bot_pos.distanceTo(target_pos))
                except Exception:
                    dx = float(bot_pos.x) - float(target_pos.x)
                    dy = float(bot_pos.y) - float(target_pos.y)
                    dz = float(bot_pos.z) - float(target_pos.z)
                    dist = (dx * dx + dy * dy + dz * dz) ** 0.5
            except Exception:
                dist = 9999.0

            if dist > reach_distance:
                goto_result = await self._movement.goto(f"@{player_name}", timeout=timeout / 2)
                if not goto_result.success:
                    try:
                        bot_pos = self._bot.entity.position
                        target_pos = player.entity.position
                        try:
                            dist2 = float(bot_pos.distanceTo(target_pos))
                        except Exception:
                            dx = float(bot_pos.x) - float(target_pos.x)
                            dy = float(bot_pos.y) - float(target_pos.y)
                            dz = float(bot_pos.z) - float(target_pos.z)
                            dist2 = (dx * dx + dy * dy + dz * dz) ** 0.5
                    except Exception:
                        dist2 = 9999.0

                    if dist2 > reach_distance:
                        return ActionResult(
                            success=False,
                            action="give",
                            message=f"无法走到玩家 {player_name} 身边",
                            status=goto_result.status,
                            error_code=goto_result.error_code,
                            duration_ms=int((time.time() - start_time) * 1000)
                        )

            try:
                player = self._bot.players[player_name]
                if player and player.entity:
                    await asyncio.wait_for(
                        asyncio.get_event_loop().run_in_executor(
                            None,
                            lambda: self._bot.lookAt(player.entity.position)
                        ),
                        timeout=2.0
                    )
            except (KeyError, TypeError):
                pass

            actual_count = min(count, item.count)
            await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._bot.toss(item.type, None, actual_count)
                ),
                timeout=5.0
            )

            return ActionResult(
                success=True,
                action="give",
                message=f"已将 {actual_count} 个 {item_name} 交给 {player_name}",
                status=ActionStatus.SUCCESS,
                data={"given": {item_name: actual_count}, "to": player_name},
                duration_ms=int((time.time() - start_time) * 1000)
            )

        except Exception as e:
            logger.error(f"give failed: {e}")
            return ActionResult(
                success=False,
                action="give",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                duration_ms=int((time.time() - start_time) * 1000)
            )

    async def equip(self, item_name: str, timeout: float = 5.0) -> ActionResult:
        start_time = time.time()

        try:
            item = self.find_inventory_item(item_name)
            if not item:
                return ActionResult(
                    success=False,
                    action="equip",
                    message=f"背包中没有 {item_name}",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )

            await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._bot.equip(item, "hand")
                ),
                timeout=timeout
            )

            return ActionResult(
                success=True,
                action="equip",
                message=f"已装备 {item_name}",
                status=ActionStatus.SUCCESS,
                data={"equipped": item_name},
                duration_ms=int((time.time() - start_time) * 1000)
            )

        except Exception as e:
            logger.error(f"equip failed: {e}")
            return ActionResult(
                success=False,
                action="equip",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                duration_ms=int((time.time() - start_time) * 1000)
            )

    async def pickup(
        self,
        target: Optional[str] = None,
        count: int = -1,
        radius: int = 16,
        timeout: float = 60.0
    ) -> ActionResult:
        start_time = time.time()
        picked_up: Dict[str, int] = {}
        total_picked = 0
        unreachable_entities: Dict[int, int] = {}
        max_unreachable_attempts = 3

        self._progress_timer = ProgressTimer(timeout_seconds=30.0)

        target_item_name: Optional[str] = None
        if target and target.lower() not in ("all", "any", "*", ""):
            target_item_name = target.lower()

        unlimited_mode = (count <= 0)
        remaining = count if count > 0 else float("inf")

        logger.info(f"[pickup] Starting: target={target_item_name or 'all'}, count={count}, radius={radius}")

        try:
            while remaining > 0:
                if time.time() - start_time > timeout:
                    msg = f"拾取超时，已捡起 {total_picked} 个物品"
                    return ActionResult(
                        success=total_picked > 0,
                        action="pickup",
                        message=msg,
                        status=ActionStatus.TIMEOUT if total_picked == 0 else ActionStatus.SUCCESS,
                        error_code="TIMEOUT" if total_picked == 0 else None,
                        data={"picked_up": picked_up, "total": total_picked},
                        duration_ms=int((time.time() - start_time) * 1000)
                    )

                if self._progress_timer.is_expired():
                    msg = f"拾取停滞（30秒无进度），已拾起 {total_picked} 个物品"
                    return ActionResult(
                        success=total_picked > 0,
                        action="pickup",
                        message=msg,
                        status=ActionStatus.SUCCESS if total_picked > 0 else ActionStatus.FAILED,
                        error_code="NO_PROGRESS" if total_picked == 0 else None,
                        data={"picked_up": picked_up, "total": total_picked},
                        duration_ms=int((time.time() - start_time) * 1000)
                    )

                item_entities = self._list_item_entities(target_item_name, radius)

                if not item_entities:
                    if total_picked > 0:
                        msg = f"附近没有更多掉落物了，共捡起 {total_picked} 个物品"
                        return ActionResult(
                            success=True,
                            action="pickup",
                            message=msg,
                            status=ActionStatus.SUCCESS,
                            data={"picked_up": picked_up, "total": total_picked},
                            duration_ms=int((time.time() - start_time) * 1000)
                        )
                    target_desc = target_item_name or "掉落物"
                    msg = f"附近 {radius} 格内没有找到 {target_desc}"
                    return ActionResult(
                        success=False,
                        action="pickup",
                        message=msg,
                        status=ActionStatus.FAILED,
                        error_code="TARGET_NOT_FOUND",
                        data={"picked_up": picked_up, "total": 0},
                        duration_ms=int((time.time() - start_time) * 1000)
                    )

                available_entities = [
                    entity for entity in item_entities
                    if unreachable_entities.get(entity["entity_id"], 0) < max_unreachable_attempts
                ]

                if not available_entities:
                    msg = f"附近掉落物均不可达，已拾起 {total_picked} 个物品"
                    return ActionResult(
                        success=total_picked > 0,
                        action="pickup",
                        message=msg,
                        status=ActionStatus.SUCCESS if total_picked > 0 else ActionStatus.FAILED,
                        error_code=None if total_picked > 0 else "ITEM_UNREACHABLE",
                        data={"picked_up": picked_up, "total": total_picked},
                        duration_ms=int((time.time() - start_time) * 1000)
                    )

                progress_this_cycle = False

                for item_entity in available_entities:
                    if remaining <= 0:
                        break

                    item_pos = item_entity.get("position")
                    item_name = item_entity.get("name", "unknown")
                    entity_id = item_entity.get("entity_id")

                    logger.info(
                        f"[pickup] Target item: {item_name} at "
                        f"({item_pos['x']:.1f}, {item_pos['y']:.1f}, {item_pos['z']:.1f}) "
                        f"(attempt {unreachable_entities.get(entity_id, 0) + 1})"
                    )

                    inventory_before = self.get_inventory_count(item_name)

                    moved_close = await self._movement.navigate_close_to_position(
                        item_pos,
                        timeout=10.0,
                        reach=1.0
                    )

                    if not moved_close:
                        unreachable_entities[entity_id] = unreachable_entities.get(entity_id, 0) + 1
                        logger.debug(
                            f"[pickup] Failed to reach {item_name} ({entity_id}), "
                            f"mark unreachable={unreachable_entities[entity_id]}"
                        )
                        continue

                    await asyncio.sleep(0.3)
                    inventory_after = self.get_inventory_count(item_name)
                    actually_picked = inventory_after - inventory_before

                    if actually_picked > 0:
                        picked_up[item_name] = picked_up.get(item_name, 0) + actually_picked
                        total_picked += actually_picked
                        remaining -= actually_picked
                        self._progress_timer.reset("item_picked")
                        unreachable_entities.pop(entity_id, None)
                        progress_this_cycle = True
                        logger.info(
                            f"[pickup] Picked up {actually_picked} x {item_name}, total: {total_picked}"
                        )
                        break

                    if not self._entity_exists(entity_id):
                        logger.debug(f"[pickup] Item {item_name} disappeared but not in inventory")
                        self._progress_timer.reset("item_disappeared")
                        progress_this_cycle = True
                    else:
                        unreachable_entities[entity_id] = unreachable_entities.get(entity_id, 0) + 1
                        logger.debug(f"[pickup] Item {item_name} still exists after close approach")

                    await asyncio.sleep(0.2)

                if not progress_this_cycle:
                    await asyncio.sleep(0.2)

            msg = f"成功拾起 {total_picked} 个物品"
            return ActionResult(
                success=True,
                action="pickup",
                message=msg,
                status=ActionStatus.SUCCESS,
                data={"picked_up": picked_up, "total": total_picked},
                duration_ms=int((time.time() - start_time) * 1000)
            )

        except Exception as e:
            logger.error(f"pickup failed: {e}")
            return ActionResult(
                success=total_picked > 0,
                action="pickup",
                message=str(e) if total_picked == 0 else f"部分成功，已拾起 {total_picked} 个",
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                data={"picked_up": picked_up, "total": total_picked},
                duration_ms=int((time.time() - start_time) * 1000)
            )
        finally:
            self._progress_timer = None

    def _list_item_entities(
        self,
        target_name: Optional[str] = None,
        radius: int = 16
    ) -> List[Dict[str, Any]]:
        entities: List[Dict[str, Any]] = []
        try:
            bot_pos = self._bot.entity.position

            for entity_id in self._bot.entities:
                entity = self._bot.entities[entity_id]

                if entity.name != "item":
                    continue

                item_name = None
                try:
                    if hasattr(entity, "metadata") and entity.metadata:
                        for meta in entity.metadata:
                            if isinstance(meta, dict) and "itemId" in meta:
                                item_id = meta.get("itemId")
                                item_info = self._mcData.items[item_id]
                                if item_info:
                                    item_name = item_info.name
                                break
                            if isinstance(meta, dict) and "nbtData" in meta:
                                pass

                    if not item_name:
                        try:
                            dropped_item = entity.getDroppedItem()
                            if dropped_item:
                                item_name = dropped_item.name
                        except Exception:
                            pass

                    if not item_name:
                        item_name = getattr(entity, "displayName", None) or "unknown"
                except Exception as e:
                    logger.debug(f"Failed to get item name for entity {entity_id}: {e}")
                    item_name = "unknown"

                if target_name:
                    if item_name and target_name.lower() not in item_name.lower():
                        continue

                try:
                    e_pos = entity.position
                    dist = ((e_pos.x - bot_pos.x) ** 2 + (e_pos.y - bot_pos.y) ** 2 + (e_pos.z - bot_pos.z) ** 2) ** 0.5

                    if dist <= radius:
                        entities.append({
                            "entity_id": entity_id,
                            "name": item_name or "unknown",
                            "position": {"x": e_pos.x, "y": e_pos.y, "z": e_pos.z},
                            "distance": dist
                        })
                except Exception as e:
                    logger.debug(f"Failed to get position for entity {entity_id}: {e}")
                    continue

            entities.sort(key=lambda e: e["distance"])
            return entities
        except Exception as e:
            logger.warning(f"_list_item_entities failed: {e}")
            return []

    def _entity_exists(self, entity_id) -> bool:
        try:
            return entity_id in self._bot.entities
        except Exception:
            return False

    def get_inventory_count(self, item_name: str) -> int:
        try:
            total = 0
            for item in self._bot.inventory.items():
                if item.name == item_name:
                    total += item.count
            return total
        except Exception:
            return 0

    def find_inventory_item(self, item_name: str):
        try:
            items = self._bot.inventory.items()
            for item in items:
                if item.name == item_name:
                    return item
            return None
        except Exception:
            return None

    def get_inventory_summary(self) -> Dict[str, int]:
        summary: Dict[str, int] = {}
        try:
            items = self._bot.inventory.items()
            for item in items:
                name = item.name
                count = item.count
                summary[name] = summary.get(name, 0) + count
        except Exception as e:
            logger.warning(f"Failed to get inventory: {e}")
        return summary

    def get_equipped_item(self) -> Optional[str]:
        try:
            held_item = self._bot.heldItem
            return held_item.name if held_item else None
        except Exception:
            return None
