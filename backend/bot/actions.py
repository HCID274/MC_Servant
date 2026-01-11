# Mineflayer Actions Facade

from __future__ import annotations

import logging
from typing import Optional

from bot.interfaces import IBotActions, ActionResult
from bot.drivers.mineflayer.driver import MineflayerDriver
from bot.systems.common import BackgroundTaskManager
from bot.systems.movement import MovementSystem
from bot.systems.movement_recovery import UnstuckPolicy
from bot.systems.inventory import InventorySystem
from bot.systems.mining import MiningSystem
from bot.systems.crafting import CraftingSystem
from bot.systems.perception import PerceptionSystem

logger = logging.getLogger(__name__)


class MineflayerActions(IBotActions):
    def __init__(self, bot):
        self._driver = MineflayerDriver(bot)
        self._background = BackgroundTaskManager(self._driver)
        self._movement = MovementSystem(self._driver, self._background)
        self._inventory = InventorySystem(self._driver, self._background, self._movement)
        self._perception = PerceptionSystem(self._driver)
        self._mining = MiningSystem(self._driver, self._background, self._movement, self._inventory)
        self._crafting = CraftingSystem(self._driver, self._background, self._movement, self._inventory)
        self._recovery = UnstuckPolicy(self._driver, self._background, self._movement, self._inventory)

        self._setup_progress_events()

    def _setup_progress_events(self) -> None:
        # No-op placeholder (kept for compatibility).
        pass

    def stop_all_background_tasks(self, timeout: float = 5.0) -> int:
        return self._background.stop_all(timeout=timeout)

    async def chat(self, message: str) -> bool:
        try:
            self._driver.chat(message)
            return True
        except Exception as e:
            logger.error(f"chat failed: {e}")
            return False

    async def goto(self, target: str, timeout: float = 60.0) -> ActionResult:
        return await self._movement.goto(target, timeout=timeout)

    async def mine(
        self,
        block_type: str,
        count: int = 1,
        timeout: float = 120.0,
        near_position: dict = None,
        search_radius: int = 64,
    ) -> ActionResult:
        return await self._mining.mine(
            block_type,
            count=count,
            timeout=timeout,
            near_position=near_position,
            search_radius=search_radius,
        )

    async def mine_tree(self, near_position: dict = None, search_radius: int = 32, timeout: float = 120.0) -> ActionResult:
        return await self._mining.mine_tree(
            near_position=near_position,
            search_radius=search_radius,
            timeout=timeout
        )

    async def climb_to_surface(self, timeout: float = 60.0) -> ActionResult:
        return await self._recovery.climb_to_surface(timeout=timeout)

    async def expose_underground(self, target_block: str, max_depth: int = 5, timeout: float = 60.0) -> ActionResult:
        """暴露地下方块，用于找不到目标时向下探测"""
        return await self._mining.expose_underground(target_block, max_depth=max_depth, timeout=timeout)

    async def place(self, block_type: str, x: int, y: int, z: int, timeout: float = 10.0) -> ActionResult:
        return await self._mining.place(block_type, x, y, z, timeout=timeout)

    async def craft(self, item_name: str, count: int = 1, timeout: float = 30.0) -> ActionResult:
        return await self._crafting.craft(item_name, count=count, timeout=timeout)

    async def smelt(self, item_name: str, count: int = 1, timeout: float = 120.0) -> ActionResult:
        return await self._crafting.smelt(item_name, count=count, timeout=timeout)

    async def give(self, player_name: str, item_name: str, count: int = 1, timeout: float = 30.0) -> ActionResult:
        return await self._inventory.give(player_name, item_name, count=count, timeout=timeout)

    async def equip(self, item_name: str, timeout: float = 5.0) -> ActionResult:
        return await self._inventory.equip(item_name, timeout=timeout)

    async def scan(self, target_type: str, radius: int = 32) -> ActionResult:
        return await self._perception.scan(target_type, radius=radius)

    async def pickup(
        self,
        target: Optional[str] = None,
        count: int = -1,
        radius: int = 16,
        timeout: float = 60.0
    ) -> ActionResult:
        return await self._inventory.pickup(target=target, count=count, radius=radius, timeout=timeout)

    async def find_location(self, feature: str, radius: int = 64, count: int = 1) -> ActionResult:
        return await self._perception.find_location(feature, radius=radius, count=count)

    async def patrol(
        self,
        center_x: int,
        center_z: int,
        radius: int = 10,
        duration: int = 30,
        timeout: float = 60.0
    ) -> ActionResult:
        return await self._movement.patrol(center_x, center_z, radius=radius, duration=duration, timeout=timeout)

    def get_state(self) -> dict:
        try:
            pos = self._driver.get_position()
            return {
                "position": {
                    "x": int(pos.x),
                    "y": int(pos.y),
                    "z": int(pos.z)
                },
                "health": self._driver.get_health(),
                "food": self._driver.get_food(),
                "inventory": self._inventory.get_inventory_summary(),
                "equipped": self._inventory.get_equipped_item()
            }
        except Exception as e:
            logger.error(f"get_state failed: {e}")
            return {
                "position": {"x": 0, "y": 0, "z": 0},
                "health": 0,
                "food": 0,
                "inventory": {},
                "equipped": None,
                "error": str(e)
            }

    def get_player_position(self, player_name: str) -> Optional[dict]:
        try:
            player = self._driver.get_player(player_name)
            if player and player.entity:
                pos = player.entity.position
                return {
                    "x": int(pos.x),
                    "y": int(pos.y),
                    "z": int(pos.z)
                }
        except (KeyError, TypeError):
            pass
        return None
