# Mineflayer Driver Adapter

from __future__ import annotations

from typing import Any, Optional, List, Dict

from javascript import require

from bot.drivers.interfaces import IDriverAdapter


class MineflayerDriver(IDriverAdapter):
    """Mineflayer-backed driver adapter."""

    def __init__(self, bot_wrapper: Any) -> None:
        self._bot = bot_wrapper._bot
        self._mcdata = bot_wrapper._mcData
        self._pathfinder = bot_wrapper._pathfinder
        self._Vec3 = require("vec3")

    def vec3(self, x: int, y: int, z: int) -> Any:
        return self._Vec3(x, y, z)

    def _get_by_name(self, container: Any, name: str) -> Any:
        try:
            if hasattr(container, "get"):
                return container.get(name)
        except Exception:
            pass
        try:
            return container[name]
        except Exception:
            pass
        try:
            return getattr(container, name)
        except Exception:
            return None

    def create_goal_near(self, x: int, y: int, z: int, reach: int) -> Any:
        try:
            return self._pathfinder.goals.GoalNear(int(x), int(y), int(z), int(reach))
        except Exception:
            return None

    def create_goal_near_xz(self, x: int, z: int, reach: int, y_hint: Optional[int] = None) -> Any:
        try:
            goals = self._pathfinder.goals
            if hasattr(goals, "GoalNearXZ"):
                return goals.GoalNearXZ(int(x), int(z), int(reach))
        except Exception:
            pass
        try:
            fallback_y = int(y_hint) if y_hint is not None else 0
            return self._pathfinder.goals.GoalNear(int(x), int(fallback_y), int(z), int(reach))
        except Exception:
            return None

    def create_goal_block(self, x: int, y: int, z: int) -> Any:
        try:
            goals = self._pathfinder.goals
            if hasattr(goals, "GoalBlock"):
                return goals.GoalBlock(int(x), int(y), int(z))
        except Exception:
            pass
        return self.create_goal_near(int(x), int(y), int(z), 1)

    def goal_target_coords(self, goal: Any) -> Optional[tuple[int, int, int]]:
        if not goal:
            return None
        if hasattr(goal, "x") and hasattr(goal, "y") and hasattr(goal, "z"):
            try:
                return int(goal.x), int(goal.y), int(goal.z)
            except Exception:
                return None
        return None

    def is_goal_reached(self, goal: Any, position: Any) -> bool:
        try:
            if not goal or not position:
                return False

            bx = int(position.x)
            by = int(position.y)
            bz = int(position.z)

            coords = self.goal_target_coords(goal)
            if coords:
                gx, gy, gz = coords
                if bx == gx and by == gy and bz == gz:
                    return True

            if hasattr(goal, "range"):
                try:
                    dx = position.x - float(goal.x)
                    dy = position.y - float(goal.y)
                    dz = position.z - float(goal.z)
                    if (dx * dx + dy * dy + dz * dz) <= (float(goal.range) ** 2):
                        return True
                except Exception:
                    pass

            try:
                if goal.isEnd(self._Vec3(bx, by, bz)):
                    return True
            except Exception:
                pass
            try:
                if goal.isEnd(bx, by, bz):
                    return True
            except Exception:
                pass
            return False
        except Exception:
            return False

    def set_goal(self, goal: Any) -> None:
        self._bot.pathfinder.setGoal(goal)

    def is_moving(self) -> bool:
        return bool(self._bot.pathfinder.isMoving())

    def current_goal(self) -> Any:
        return self._bot.pathfinder.goal

    def get_position(self) -> Any:
        return self._bot.entity.position

    def get_health(self) -> float:
        try:
            return float(self._bot.health) if self._bot.health else 20.0
        except Exception:
            return 20.0

    def get_food(self) -> int:
        try:
            return int(self._bot.food) if self._bot.food else 20
        except Exception:
            return 20

    def look_at(self, target: Any) -> None:
        self._bot.lookAt(target)

    def set_control_state(self, control: str, state: bool) -> None:
        self._bot.setControlState(control, state)

    def get_player(self, name: str) -> Optional[Any]:
        try:
            return self._bot.players[name]
        except Exception:
            pass
        try:
            if hasattr(self._bot.players, "get"):
                return self._bot.players.get(name)
        except Exception:
            pass
        return None

    def get_player_names(self) -> List[str]:
        try:
            if hasattr(self._bot.players, "keys"):
                return list(self._bot.players.keys())
            if hasattr(self._bot.players, "__iter__"):
                return list(self._bot.players)
        except Exception:
            pass
        return []

    def block_at(self, pos: Any) -> Any:
        return self._bot.blockAt(pos)

    async def dig(self, block: Any) -> None:
        await self._bot.dig(block)

    def find_blocks(self, query: Any) -> Any:
        return self._bot.findBlocks(query)

    def find_block(self, query: Any) -> Any:
        return self._bot.findBlock(query)

    def place_block(self, reference_block: Any, offset: Any) -> None:
        self._bot.placeBlock(reference_block, offset)

    def collect_block(self, block: Any) -> None:
        self._bot.collectBlock.collect(block)

    def get_entities(self) -> Dict[int, Any]:
        try:
            return dict(self._bot.entities)
        except Exception:
            return {}

    def get_inventory_items(self) -> List[Any]:
        try:
            return list(self._bot.inventory.items())
        except Exception:
            return []

    def get_held_item(self) -> Optional[Any]:
        try:
            return self._bot.heldItem
        except Exception:
            return None

    def equip_item(self, item: Any, destination: str = "hand") -> None:
        self._bot.equip(item, destination)

    def toss_item(self, item_type: Any, metadata: Any, count: int) -> None:
        self._bot.toss(item_type, metadata, count)

    def get_yaw(self) -> float:
        try:
            return float(self._bot.entity.yaw)
        except Exception:
            return 0.0

    def recipes_all(self, item_id: int, crafting_table: Any = None) -> Any:
        return self._bot.recipesAll(item_id, None, crafting_table)

    def recipes_for(self, item_id: int, count: Optional[int] = None, crafting_table: Any = None) -> Any:
        if count is None:
            if crafting_table is None:
                return self._bot.recipesFor(item_id)
            return self._bot.recipesFor(item_id, None, None, crafting_table)
        if crafting_table is None:
            return self._bot.recipesFor(item_id, None, int(count))
        return self._bot.recipesFor(item_id, None, int(count), crafting_table)

    def craft_recipe(self, recipe: Any, count: int, crafting_table: Any = None) -> None:
        self._bot.craft(recipe, count, crafting_table)

    def get_current_window(self) -> Any:
        return self._bot.currentWindow

    def get_inventory_window(self) -> Any:
        return self._bot.inventory

    def get_inventory_slots(self) -> List[Any]:
        try:
            slots = getattr(self._bot.inventory, "slots", None)
            return list(slots) if slots is not None else []
        except Exception:
            return []

    def click_window(self, slot: int, mouse_button: int, mode: int) -> None:
        self._bot.clickWindow(slot, mouse_button, mode)

    def activate_block(self, block: Any) -> None:
        self._bot.activateBlock(block)

    def open_furnace(self, block: Any) -> Any:
        return self._bot.openFurnace(block)

    def open_blast_furnace(self, block: Any) -> Any:
        if hasattr(self._bot, "openBlastFurnace"):
            return self._bot.openBlastFurnace(block)
        return self._bot.openFurnace(block)

    def open_smoker(self, block: Any) -> Any:
        if hasattr(self._bot, "openSmoker"):
            return self._bot.openSmoker(block)
        return self._bot.openFurnace(block)

    def get_window_title(self, window: Any) -> str:
        try:
            title = getattr(window, "title", "")
            return str(title) if title is not None else ""
        except Exception:
            return ""

    def get_window_type(self, window: Any) -> str:
        try:
            wtype = getattr(window, "type", "")
            return str(wtype) if wtype is not None else ""
        except Exception:
            return ""

    def get_window_slots(self, window: Any) -> List[Any]:
        try:
            slots = getattr(window, "slots", None)
            if slots is None:
                return []
            return list(slots)
        except Exception:
            try:
                length = int(getattr(getattr(window, "slots", None), "length", 0))
                return [window.slots[i] for i in range(length)]
            except Exception:
                return []

    def get_window_slot(self, window: Any, index: int) -> Any:
        try:
            return window.slots[index]
        except Exception:
            try:
                slots = self.get_window_slots(window)
                if 0 <= index < len(slots):
                    return slots[index]
            except Exception:
                pass
        return None

    def get_window_length(self, window: Any) -> int:
        try:
            slots = getattr(window, "slots", None)
            if slots is None:
                return 0
            try:
                return len(slots)
            except Exception:
                return int(getattr(slots, "length", 0))
        except Exception:
            return 0

    def stop_pathfinder(self) -> None:
        try:
            self._bot.pathfinder.stop()
        except Exception:
            pass

    def chat(self, message: str) -> None:
        self._bot.chat(message)

    def get_item_id(self, item_name: str) -> Optional[int]:
        if not item_name:
            return None
        try:
            item = self._get_by_name(self._mcdata.itemsByName, item_name)
            return int(item.id) if item and getattr(item, "id", None) is not None else None
        except Exception:
            return None

    def get_item_name(self, item_id: int) -> Optional[str]:
        try:
            item = self._mcdata.items[item_id]
            return item.name if item else None
        except Exception:
            return None

    def get_block_id(self, block_name: str) -> Optional[int]:
        if not block_name:
            return None
        try:
            block = self._get_by_name(self._mcdata.blocksByName, block_name)
            return int(block.id) if block and getattr(block, "id", None) is not None else None
        except Exception:
            return None

    def get_recipe_data(self, item_id: int) -> Any:
        try:
            return self._mcdata.recipes.get(str(int(item_id)))
        except Exception:
            return None

    @property
    def username(self) -> str:
        try:
            return str(self._bot.username)
        except Exception:
            return ""
