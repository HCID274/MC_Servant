# Crafting system (recipes, crafting execution)

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Optional, Dict, Any, List, Tuple

from bot.drivers.interfaces import IDriverAdapter
from bot.interfaces import ActionResult, ActionStatus
from bot.systems.common import BackgroundTaskManager, _coerce_js_int
from bot.systems.inventory import InventorySystem
from bot.systems.movement import MovementSystem

logger = logging.getLogger(__name__)


class CraftingSystem:
    def __init__(
        self,
        driver: IDriverAdapter,
        background: BackgroundTaskManager,
        movement: MovementSystem,
        inventory: InventorySystem,
    ) -> None:
        self._driver = driver
        self._bot = driver.bot
        self._mcData = driver.mcdata
        self._movement = movement
        self._inventory = inventory
        self._background = background

    async def craft(self, item_name: str, count: int = 1, timeout: float = 30.0) -> ActionResult:
        start_time = time.time()

        executable_recipe = None
        inventory: Dict[str, int] = {}
        missing_materials: Dict[str, int] = {}

        try:
            item_info = self._mcData.itemsByName[item_name] if hasattr(self._mcData.itemsByName, item_name) else None
            if not item_info:
                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"未知的物品: {item_name}",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )

            crafting_table_block = None
            try:
                ct_info = self._mcData.blocksByName["crafting_table"]
                if ct_info:
                    crafting_table_block = self._bot.findBlock({
                        "matching": ct_info.id,
                        "maxDistance": 32
                    })
            except Exception:
                pass

            all_recipes = []
            try:
                all_recipes_proxy = self._bot.recipesAll(item_info.id, None, crafting_table_block)
                all_recipes = list(all_recipes_proxy) if all_recipes_proxy else []
            except Exception as e:
                logger.debug(f"recipesAll failed: {e}")

            if not all_recipes:
                try:
                    recipes_proxy = None
                    try:
                        recipes_proxy = self._bot.recipesFor(item_info.id, None, int(count), None)
                    except Exception:
                        try:
                            recipes_proxy = self._bot.recipesFor(item_info.id, None, int(count))
                        except Exception:
                            recipes_proxy = self._bot.recipesFor(item_info.id)
                    all_recipes = list(recipes_proxy) if recipes_proxy else []
                except Exception:
                    pass

            if not all_recipes:
                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"找不到 {item_name} 的配方",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )

            inventory = self._inventory.get_inventory_summary()
            logger.info(f"[craft] Found {len(all_recipes)} recipe variants for {item_name}")

            if not all_recipes:
                has_raw_recipe = False
                try:
                    raw_recipes = self._mcData.recipes.get(str(item_info.id))
                    if raw_recipes and len(raw_recipes) > 0:
                        has_raw_recipe = True
                except Exception:
                    pass

                if has_raw_recipe:
                    return ActionResult(
                        success=False,
                        action="craft",
                        message=f"合成 {item_name} 需要工作台，请确保工作台已放置",
                        status=ActionStatus.FAILED,
                        error_code="STATION_NOT_PLACED",
                        data={"station": "crafting_table", "item": item_name}
                    )

            executable_recipe, missing_materials = self._find_executable_recipe(all_recipes, inventory, count)

            if not executable_recipe and "__recipe_parse_failed__" in missing_materials:
                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"合成 {item_name} 失败：配方解析失败 (delta)",
                    status=ActionStatus.FAILED,
                    error_code="RECIPE_PARSE_FAILED",
                    data={
                        "item": item_name,
                        "parse_failures": missing_materials.get("__recipe_parse_failed__", 0),
                        "recipe_count": len(all_recipes),
                    },
                    duration_ms=int((time.time() - start_time) * 1000),
                )

            if not executable_recipe:
                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"合成 {item_name} 材料不足: {missing_materials}",
                    status=ActionStatus.FAILED,
                    error_code="INSUFFICIENT_MATERIALS",
                    data={"missing": missing_materials, "item": item_name},
                    duration_ms=int((time.time() - start_time) * 1000)
                )

            crafting_table = None
            if executable_recipe.requiresTable:
                ct_info = self._mcData.blocksByName["crafting_table"] if hasattr(self._mcData.blocksByName, "crafting_table") else None
                if ct_info:
                    crafting_table = self._bot.findBlock({
                        "matching": ct_info.id,
                        "maxDistance": 32
                    })

                if not crafting_table:
                    return ActionResult(
                        success=False,
                        action="craft",
                        message=f"合成 {item_name} 需要工作台，但附近没有找到",
                        status=ActionStatus.FAILED,
                        error_code="NO_TOOL"
                    )

            try:
                await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: self._bot.craft(executable_recipe, count, crafting_table)
                    ),
                    timeout=timeout
                )
            except Exception as craft_exc:
                msg_lower = str(craft_exc).lower()

                if ("missing ingredient" in msg_lower or "timed out" in msg_lower) and executable_recipe:
                    logger.warning(
                        f"[craft] bot.craft() failed ({msg_lower}) for {item_name}. "
                        f"Attempting generic manual craft fallback..."
                    )
                    try:
                        use_window = None
                        if executable_recipe.requiresTable:
                            current_window = self._bot.currentWindow

                            if not current_window or "crafting_table" not in str(current_window.title).lower():
                                if crafting_table is None:
                                    crafting_table = self._bot.findBlock({
                                        "matching": lambda b: b.name == "crafting_table",
                                        "maxDistance": 2
                                    })

                                if crafting_table:
                                    logger.info(f"[craft] Manually opening crafting table at {crafting_table.position}")

                                    async def open_table():
                                        try:
                                            try:
                                                pos = crafting_table.position
                                                logger.info(f"[craft] Navigating to {pos}...")
                                                await self._movement.navigate_to_block(int(pos.x), int(pos.y), int(pos.z))
                                            except Exception as nav_err:
                                                logger.warning(f"[craft] Navigation to table failed: {nav_err}")

                                            try:
                                                center = crafting_table.position.offset(0.5, 0.5, 0.5)
                                                logger.info(f"[craft] Looking at {center}...")
                                                await self._bot.lookAt(center)
                                            except Exception:
                                                pass

                                            logger.info("[craft] Activating block...")
                                            try:
                                                self._bot.activateBlock(crafting_table)
                                            except Exception as act_err:
                                                logger.error(f"[craft] activateBlock failed: {act_err}")

                                            logger.info("[craft] Waiting for window to open...")
                                            await asyncio.sleep(1.0)

                                            for _ in range(15):
                                                try:
                                                    w = self._bot.currentWindow
                                                    if w:
                                                        w_title = str(w.title).lower() if w.title else "none"
                                                        w_type = str(w.type) if hasattr(w, "type") else "none"

                                                        try:
                                                            w_len = int(w.slots.length)
                                                        except Exception:
                                                            w_len = 0

                                                        logger.info(
                                                            f"[craft] Detected open window: title='{w_title}', "
                                                            f"type='{w_type}', slots={w_len}"
                                                        )

                                                        is_crafting = (
                                                            "crafting_table" in w_title or
                                                            "工作台" in w_title or
                                                            "crafting" in w_type or
                                                            w_len == 46
                                                        )

                                                        if is_crafting:
                                                            logger.info("[craft] Verified crafting table detected!")
                                                            return w
                                                except Exception as e:
                                                    logger.warning(f"[craft] Window check warning: {e}")
                                                await asyncio.sleep(1.0)
                                            logger.warning("[craft] Window open poll timed out.")
                                            return None
                                        except Exception as e:
                                            logger.error(f"[craft] open_table logic crashed: {e}")
                                            return None

                                    use_window = await asyncio.wait_for(open_table(), timeout=40.0)
                            else:
                                use_window = current_window

                            if not use_window:
                                raise RuntimeError("Failed to open crafting table window for manual fallback.")

                        await asyncio.wait_for(
                            asyncio.get_event_loop().run_in_executor(
                                None,
                                lambda: self._manual_craft_generic_sync(executable_recipe, int(count), use_window)
                            ),
                            timeout=timeout * 3
                        )

                        return ActionResult(
                            success=True,
                            action="craft",
                            message=f"成功合成 {count} 个 {item_name} (Manual Fallback)",
                            status=ActionStatus.SUCCESS,
                            data={"crafted": {item_name: count}, "mode": "manual_generic"},
                            duration_ms=int((time.time() - start_time) * 1000)
                        )
                    except Exception as manual_exc:
                        logger.error(f"[craft] Manual generic fallback failed: {manual_exc}")

                if "missing ingredient" in msg_lower and item_name == "crafting_table" and crafting_table is None:
                    pass

                raise craft_exc

            return ActionResult(
                success=True,
                action="craft",
                message=f"成功合成 {count} 个 {item_name}",
                status=ActionStatus.SUCCESS,
                data={"crafted": {item_name: count}},
                duration_ms=int((time.time() - start_time) * 1000)
            )

        except asyncio.TimeoutError:
            return ActionResult(
                success=False,
                action="craft",
                message=f"合成 {item_name} 超时",
                status=ActionStatus.TIMEOUT,
                error_code="TIMEOUT",
                duration_ms=int((time.time() - start_time) * 1000)
            )
        except Exception as e:
            logger.error(f"craft failed: {e}")
            error_msg = str(e)
            error_code = "UNKNOWN"
            data = None
            if "missing" in error_msg.lower():
                error_code = "INSUFFICIENT_MATERIALS"

                missing: Dict[str, int] = {}
                try:
                    if executable_recipe is not None:
                        required = self._extract_recipe_materials(executable_recipe)
                        for material_id, required_count in required.items():
                            material_name = self._get_item_name_by_id(material_id)
                            if not material_name:
                                continue
                            have = int(inventory.get(material_name, 0))
                            need = int(required_count) * int(count)
                            if have < need:
                                missing[material_name] = need - have
                except Exception:
                    pass

                if not missing:
                    m = re.search(r"missing ingredient\s+([a-z0-9_]+)", error_msg.lower())
                    if m:
                        missing[m.group(1)] = 1

                if missing:
                    data = {"missing": missing, "item": item_name}
            return ActionResult(
                success=False,
                action="craft",
                message=error_msg,
                status=ActionStatus.FAILED,
                error_code=error_code,
                data=data,
                duration_ms=int((time.time() - start_time) * 1000)
            )

    def _manual_craft_crafting_table_sync(self, plank_item_name: str, count: int = 1) -> None:
        import time as _time

        output_slot = 0
        input_slots = [1, 2, 3, 4]

        def _item_name(it) -> Optional[str]:
            if it is None:
                return None
            try:
                return it.name
            except Exception:
                try:
                    return it.get("name")
                except Exception:
                    return None

        def _item_count(it) -> int:
            if it is None:
                return 0
            try:
                return int(it.count)
            except Exception:
                try:
                    return int(it.get("count", 0))
                except Exception:
                    return 0

        def _slots_list() -> List[Any]:
            try:
                slots = getattr(self._bot.inventory, "slots", None)
                return list(slots) if slots is not None else []
            except Exception:
                return []

        def _find_source_slot(min_needed: int) -> int:
            slots = _slots_list()
            best_idx = -1
            best_count = 0
            for idx, it in enumerate(slots):
                if _item_name(it) == plank_item_name:
                    c = _item_count(it)
                    if c >= min_needed and c > best_count:
                        best_idx = idx
                        best_count = c
            return best_idx

        for _ in range(int(count)):
            source = _find_source_slot(4)
            if source < 0:
                raise RuntimeError(f"manual craft missing material: {plank_item_name} x4")

            self._bot.clickWindow(source, 0, 0)
            _time.sleep(0.05)

            for slot in input_slots:
                self._bot.clickWindow(slot, 1, 0)
                _time.sleep(0.05)

            self._bot.clickWindow(source, 0, 0)
            _time.sleep(0.05)

            self._bot.clickWindow(output_slot, 0, 1)
            _time.sleep(0.1)

    def _manual_craft_generic_sync(self, recipe, count: int = 1, crafting_table_window=None) -> None:
        import time as _time
        from bot.tag_resolver import get_tag_resolver

        tag_resolver = get_tag_resolver()

        window = crafting_table_window if crafting_table_window else self._bot.inventory
        is_3x3 = (crafting_table_window is not None)
        grid_width = 3 if is_3x3 else 2

        def get_grid_slot(row, col):
            if is_3x3:
                return 1 + row * 3 + col
            return 1 + row * 2 + col

        grid_slots_count = 9 if is_3x3 else 4
        for i in range(1, grid_slots_count + 1):
            slot_item = window.slots[i]
            if slot_item:
                self._bot.clickWindow(i, 0, 1)
                _time.sleep(0.2)

        inventory_snapshot = {}
        for item in self._bot.inventory.items():
            inventory_snapshot[item.name] = inventory_snapshot.get(item.name, 0) + item.count

        shape = recipe.inShape
        if not shape:
            raise RuntimeError("Recipe has no inShape")

        slots = getattr(window, "slots", [])
        if not slots:
            pass

        search_start = 10 if is_3x3 else 9

        def find_material_slot(target_id: int) -> int:
            slots_len = int(window.slots.length)
            logger.debug(
                f"[find_material_slot] Searching for target_id={target_id}, "
                f"search_start={search_start}, slots_len={slots_len}"
            )

            for i in range(search_start, slots_len):
                item = window.slots[i]
                if item and item.type == target_id:
                    logger.debug(f"[find_material_slot] Exact match found at slot {i}: {item.name}")
                    return i

            target_name = self._get_item_name_by_id(target_id)
            logger.debug(f"[find_material_slot] No exact match, target_name={target_name}, trying Tag match...")
            if not target_name:
                logger.warning(f"[find_material_slot] Cannot resolve target_id={target_id} to name")
                return -1

            equivs = tag_resolver.get_equivalents(target_name)
            logger.debug(
                f"[find_material_slot] Tag equivalents for {target_name}: "
                f"{equivs[:5]}{'...' if len(equivs) > 5 else ''}"
            )
            for i in range(search_start, slots_len):
                item = window.slots[i]
                if item and item.name in equivs:
                    logger.debug(
                        f"[find_material_slot] Tag match found at slot {i}: "
                        f"{item.name} (count={item.count})"
                    )
                    return i
            logger.warning(f"[find_material_slot] No material found for {target_name} (id={target_id})")
            return -1

        def _safe_len(obj):
            try:
                return len(obj)
            except Exception:
                try:
                    return int(obj.length)
                except Exception:
                    return 0

        max_rows = _safe_len(shape)
        max_cols = _safe_len(shape[0]) if max_rows > 0 else 0

        plan: List[Tuple[int, int]] = []
        for r in range(max_rows):
            row = shape[r]
            for c in range(max_cols):
                item = row[c]
                if not item:
                    continue
                try:
                    if isinstance(item, list):
                        target_id = item[0].id
                    else:
                        target_id = item.id
                except Exception:
                    continue
                plan.append((get_grid_slot(r, c), int(target_id)))

        for slot_idx, item_id in plan:
            source_slot = find_material_slot(item_id)
            if source_slot < 0:
                name = self._get_item_name_by_id(item_id) or str(item_id)
                raise RuntimeError(f"manual craft missing material: {name}")

            self._bot.clickWindow(source_slot, 0, 0)
            _time.sleep(0.05)
            self._bot.clickWindow(slot_idx, 0, 0)
            _time.sleep(0.05)

        self._bot.clickWindow(0, 0, 1)
        _time.sleep(0.2)

    def _find_executable_recipe(
        self,
        all_recipes,
        inventory: Dict[str, int],
        count: int
    ) -> Tuple[Optional[Any], Dict[str, int]]:
        best_recipe = None
        best_missing: Dict[str, int] = {}
        best_missing_count = 99999

        for recipe in all_recipes:
            try:
                needed = self._extract_recipe_materials(recipe)
            except Exception:
                best_missing["__recipe_parse_failed__"] = best_missing.get("__recipe_parse_failed__", 0) + 1
                continue

            missing: Dict[str, int] = {}
            for item_id, req_count in needed.items():
                item_name = self._get_item_name_by_id(item_id)
                if not item_name:
                    continue
                have = int(inventory.get(item_name, 0))
                need = int(req_count) * int(count)
                if have < need:
                    missing[item_name] = need - have

            if not missing:
                return (recipe, {})

            missing_count = sum(missing.values())
            if missing_count < best_missing_count:
                best_missing_count = missing_count
                best_missing = missing
                best_recipe = recipe

        return (None, best_missing)

    def _extract_recipe_materials(self, recipe) -> Dict[int, int]:
        materials: Dict[int, int] = {}

        if not hasattr(recipe, "delta") or not recipe.delta:
            raise ValueError("recipe has no delta")

        delta_items = list(recipe.delta)
        for delta_item in delta_items:
            try:
                if isinstance(delta_item, dict):
                    raw_id = delta_item.get("id")
                    raw_count = delta_item.get("count")
                else:
                    raw_id = getattr(delta_item, "id", None)
                    raw_count = getattr(delta_item, "count", None)

                item_id = _coerce_js_int(raw_id)
                count = _coerce_js_int(raw_count)
            except Exception as exc:
                raise TypeError(f"failed to parse recipe.delta item: {delta_item!r}") from exc

            if count < 0:
                if item_id > 0:
                    materials[item_id] = materials.get(item_id, 0) + abs(int(count))

        if not materials:
            raise ValueError("recipe.delta has no consumptions")

        return materials

    def _get_item_name_by_id(self, item_id: int) -> Optional[str]:
        try:
            item = self._mcData.items[item_id]
            return item.name if item else None
        except Exception:
            return None
