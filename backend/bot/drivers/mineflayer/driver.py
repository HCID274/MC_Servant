# Mineflayer Driver Adapter

from __future__ import annotations

import logging
from typing import Any, Optional, List, Dict

from javascript import require

from bot.drivers.interfaces import IDriverAdapter

logger = logging.getLogger(__name__)


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
        """Dig a block. Handles JS Promise that might return None."""
        try:
            result = self._bot.dig(block)
            # JS bot.dig() returns a Promise, but JSPyBridge might return None
            if result is not None:
                import inspect
                if inspect.isawaitable(result):
                    await result
        except Exception as e:
            logger.warning(f"[dig] Error during dig: {e}")
            raise

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
            items = list(self._bot.inventory.items())
            # 🔧 Debug: 打印获取到的物品数量
            if items:
                logger.debug(f"[get_inventory_items] Got {len(items)} items from inventory")
            else:
                logger.debug(f"[get_inventory_items] Inventory is empty (no items)")
            return items
        except Exception as e:
            # 🔧 Debug: 打印异常信息
            logger.warning(f"[get_inventory_items] Exception accessing inventory: {e}")
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
        """Get window slots with timeout protection.
        
        Avoids JSPyBridge timeout by limiting slot count and using direct indexing.
        """
        try:
            slots = getattr(window, "slots", None)
            if slots is None:
                return []
            
            # Get length first (faster than converting entire array)
            length = 0
            try:
                length = int(getattr(slots, "length", 0))
            except Exception:
                try:
                    length = len(slots)
                except Exception:
                    return []
            
            # Limit to reasonable number to avoid very long timeouts
            # Crafting table has 46 slots, inventory has 45
            max_slots = min(length, 100)
            
            result = []
            for i in range(max_slots):
                try:
                    result.append(slots[i])
                except Exception:
                    result.append(None)
            
            return result
            
        except Exception as e:
            logger.debug(f"[get_window_slots] Failed: {e}")
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
        """Get recipe data from mcData for a given item ID.
        
        mcData.recipes structure varies by version. Try multiple access methods.
        """
        try:
            recipes = self._mcdata.recipes
            if recipes is None:
                return None
            
            # 尝试多种 key 格式
            for key in [item_id, str(item_id), int(item_id)]:
                try:
                    # 方式1: dict-like get
                    if hasattr(recipes, 'get'):
                        result = recipes.get(key)
                        if result is not None:
                            return result
                    # 方式2: 直接索引
                    result = recipes[key]
                    if result is not None:
                        return result
                except (KeyError, TypeError, IndexError):
                    continue
            
            # 方式3: 尝试用物品名称查找
            try:
                item = self._mcdata.items[item_id]
                if item and hasattr(item, 'name'):
                    item_name = item.name
                    for key in [item_name, f"minecraft:{item_name}"]:
                        try:
                            if hasattr(recipes, 'get'):
                                result = recipes.get(key)
                                if result is not None:
                                    return result
                            result = recipes[key]
                            if result is not None:
                                return result
                        except (KeyError, TypeError):
                            continue
            except Exception:
                pass
            
            return None
        except Exception:
            return None

    # 2x2 背包合成槽可合成的物品（不需要工作台）
    # 使用反向逻辑：只有这些物品可以在背包内合成，其他物品默认需要工作台
    _CAN_CRAFT_IN_INVENTORY_PATTERNS = (
        "_planks",  # 原木 -> 木板
        "_button",  # 木板/石头 -> 按钮 (1个材料)
    )
    
    _CAN_CRAFT_IN_INVENTORY_ITEMS = frozenset({
        # 基础材料
        "stick",           # 2 木板 -> 4 木棍
        "crafting_table",  # 4 木板 -> 1 工作台
        
        # 染料相关 (1-2个材料)
        "bone_meal", "light_gray_dye", "gray_dye", "pink_dye", 
        "lime_dye", "yellow_dye", "light_blue_dye", "magenta_dye", 
        "orange_dye", "cyan_dye", "purple_dye",
        
        # 食物 (简单配方)
        "sugar", "wheat", "pumpkin_seeds", "melon_seeds",
        "mushroom_stew", "beetroot_soup", "rabbit_stew",
        
        # 其他 2x2 配方
        "fire_charge", "firework_star",
        "fermented_spider_eye", "glistering_melon_slice",
        "magma_cream", "blaze_powder", "ender_eye",
    })

    def recipe_requires_table(self, item_name: str) -> bool:
        """
        Check if crafting an item requires a 3x3 crafting table.
        
        Prefer mcData recipes to detect 2x2 craftability, falling back to
        heuristics when recipe data is unavailable.
        """
        if not item_name:
            return True

        item_id = self.get_item_id(item_name)
        if item_id is None:
            return True

        def _as_list(value: Any) -> list[Any]:
            if value is None:
                return []
            if isinstance(value, dict):
                for key in ("inShape", "shape", "in_shape", "ingredients", "inIngredients", "in"):
                    if key in value:
                        return [value]
                return list(value.values())
            try:
                return list(value)
            except TypeError:
                return [value]

        def _get_attr(obj: Any, names: tuple[str, ...]) -> Any:
            if isinstance(obj, dict):
                for name in names:
                    if name in obj:
                        return obj.get(name)
            for name in names:
                if hasattr(obj, name):
                    return getattr(obj, name)
            return None

        def _is_empty_slot(value: Any) -> bool:
            if value is None:
                return True
            if isinstance(value, (int, float)):
                return int(value) <= 0
            if isinstance(value, str):
                return value in ("", "air", "minecraft:air")
            try:
                item_id_value = getattr(value, "id", None)
                if item_id_value is not None:
                    return int(item_id_value) <= 0
            except Exception:
                pass
            return False

        def _shape_fits_inventory(shape: Any) -> bool:
            rows = _as_list(shape)
            min_r = max_r = min_c = max_c = None
            for r_idx, row in enumerate(rows):
                cols = _as_list(row)
                for c_idx, cell in enumerate(cols):
                    if _is_empty_slot(cell):
                        continue
                    if min_r is None:
                        min_r = max_r = r_idx
                        min_c = max_c = c_idx
                    else:
                        min_r = min(min_r, r_idx)
                        max_r = max(max_r, r_idx)
                        min_c = min(min_c, c_idx)
                        max_c = max(max_c, c_idx)
            if min_r is None:
                return False
            height = max_r - min_r + 1
            width = max_c - min_c + 1
            return height <= 2 and width <= 2

        def _ingredients_fit_inventory(recipe: Any) -> bool:
            ingredients = _get_attr(recipe, ("ingredients", "inIngredients", "in", "ingredient"))
            if ingredients is None:
                return False
            items = _as_list(ingredients)
            count = sum(1 for item in items if not _is_empty_slot(item))
            return 0 < count <= 4

        try:
            raw_recipes = self.get_recipe_data(item_id)
        except Exception:
            raw_recipes = None

        if raw_recipes:
            recipe_entries = _as_list(raw_recipes)
            if recipe_entries:
                for entry in recipe_entries:
                    if entry is None:
                        continue
                    shape = _get_attr(entry, ("inShape", "shape", "in_shape"))
                    if shape is not None:
                        if _shape_fits_inventory(shape):
                            return False
                        continue
                    if _ingredients_fit_inventory(entry):
                        return False
                return True

        for pattern in self._CAN_CRAFT_IN_INVENTORY_PATTERNS:
            if item_name.endswith(pattern):
                return False

        if item_name in self._CAN_CRAFT_IN_INVENTORY_ITEMS:
            return False

        return True

    @property
    def username(self) -> str:
        try:
            return str(self._bot.username)
        except Exception:
            return ""
