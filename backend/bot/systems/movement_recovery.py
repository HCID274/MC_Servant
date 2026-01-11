# Movement recovery (unstuck policy)

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional, Tuple

from bot.drivers.interfaces import IDriverAdapter
from bot.interfaces import ActionResult, ActionStatus
from bot.systems.common import BackgroundTaskManager
from bot.systems.inventory import InventorySystem
from bot.systems.movement import MovementSystem

logger = logging.getLogger(__name__)


class UnstuckPolicy:
    def __init__(
        self,
        driver: IDriverAdapter,
        background: BackgroundTaskManager,
        movement: MovementSystem,
        inventory: InventorySystem,
    ) -> None:
        self._driver = driver
        self._Vec3 = driver.vec3
        self._background = background
        self._movement = movement
        self._inventory = inventory

    def _get_highest_block_y_at(self, x: int, z: int) -> Optional[int]:
        try:
            for y in range(120, -64, -1):
                block = self._driver.block_at(self._Vec3(x, y, z))
                if block and block.name not in ("air", "cave_air"):
                    return int(y)
        except Exception:
            pass
        return None

    async def climb_to_surface(self, timeout: float = 60.0) -> ActionResult:
        start_time = time.time()
        logger.info("[climb_to_surface] Starting physical recovery to surface")

        def is_air(block) -> bool:
            try:
                return block is None or block.name in ("air", "cave_air", "void_air")
            except Exception:
                return True

        def find_pillar_item():
            for name in (
                "dirt", "cobblestone", "stone",
                "oak_planks", "spruce_planks", "birch_planks"
            ):
                item = self._inventory.find_inventory_item(name)
                if item:
                    return item
            return None

        async def try_pillar_up(cur_x: int, current_y: int, cur_z: int) -> bool:
            item = find_pillar_item()
            if not item:
                return False

            ref_block = self._driver.block_at(self._Vec3(cur_x, current_y - 1, cur_z))
            if is_air(ref_block):
                return False

            try:
                await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._driver.equip_item(item, "hand")
                )
            except Exception:
                return False

            try:
                self._driver.set_control_state("jump", True)
                await asyncio.sleep(0.2)
                await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._driver.place_block(ref_block, self._Vec3(0, 1, 0))
                )
                await asyncio.sleep(0.2)
                return True
            except Exception:
                return False
            finally:
                try:
                    self._driver.set_control_state("jump", False)
                except Exception:
                    pass

        async def try_spiral_step(cur_x: int, current_y: int, cur_z: int) -> Tuple[bool, int, int]:
            directions = [(1, 0), (0, 1), (-1, 0), (0, -1)]
            for dx, dz in directions:
                head_pos = self._Vec3(cur_x + dx, current_y + 1, cur_z + dz)
                head_block = self._driver.block_at(head_pos)
                if head_block and not is_air(head_block) and getattr(head_block, "diggable", True):
                    try:
                        await self._driver.dig(head_block)
                    except Exception:
                        pass

                foot_block = self._driver.block_at(self._Vec3(cur_x + dx, current_y, cur_z + dz))
                if is_air(foot_block) and is_air(head_block):
                    try:
                        self._driver.look_at(self._Vec3(cur_x + dx + 0.5, current_y + 1.0, cur_z + dz + 0.5))
                    except Exception:
                        pass
                    await self._movement.unstuck_move(duration=0.6)
                    return True, cur_x + dx, cur_z + dz

            return False, cur_x, cur_z

        try:
            pos = self._driver.get_position()
            cur_x, cur_z = int(pos.x), int(pos.z)
            target_y = self._get_highest_block_y_at(cur_x, cur_z)

            if target_y is None:
                target_y = int(pos.y)

            if target_y <= pos.y:
                for dx, dz in [(2, 0), (-2, 0), (0, 2), (0, -2)]:
                    candidate = self._get_highest_block_y_at(cur_x + dx, cur_z + dz)
                    if candidate and candidate > target_y:
                        target_y = candidate
                        cur_x += dx
                        cur_z += dz
                        break

            head_block = self._driver.block_at(self._Vec3(cur_x, int(pos.y) + 2, cur_z))
            if int(pos.y) >= target_y and is_air(head_block):
                await self._movement.unstuck_move(duration=0.8)
                return ActionResult(
                    success=True,
                    action="climb_to_surface",
                    message="Surface level; no climb required",
                    status=ActionStatus.SUCCESS,
                    data={"final_y": int(pos.y), "skipped": True},
                )

            while True:
                if time.time() - start_time > timeout:
                    break

                pos_now = self._driver.get_position()
                current_y = int(pos_now.y)
                head_pos = self._Vec3(cur_x, current_y + 2, cur_z)
                block_head = self._driver.block_at(head_pos)

                if current_y >= target_y and is_air(block_head):
                    break

                if block_head and not is_air(block_head):
                    try:
                        await self._driver.dig(block_head)
                        await asyncio.sleep(0.1)
                    except Exception:
                        pass

                if await try_pillar_up(cur_x, current_y, cur_z):
                    continue

                moved, cur_x, cur_z = await try_spiral_step(cur_x, current_y, cur_z)
                if moved:
                    continue

                await self._movement.unstuck_move(duration=0.6)

            final_pos = self._driver.get_position()
            return ActionResult(
                success=final_pos.y >= target_y - 1,
                action="climb_to_surface",
                message=f"Climb finished at y={int(final_pos.y)}",
                status=ActionStatus.SUCCESS if final_pos.y >= target_y - 1 else ActionStatus.FAILED,
                data={"final_y": int(final_pos.y), "target_y": int(target_y)},
            )
        except Exception as e:
            return ActionResult(
                success=False,
                action="climb_to_surface",
                message=f"climb_to_surface failed: {e}",
                status=ActionStatus.FAILED,
            )
