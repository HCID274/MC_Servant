# Crafting system (recipes, crafting execution)

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from typing import Optional, Dict, Any, List, Tuple

from bot.drivers.interfaces import IDriverAdapter
from bot.interfaces import ActionResult, ActionStatus
from bot.systems.common import BackgroundTaskManager, _coerce_js_int
from bot.systems.inventory import InventorySystem
from bot.systems.movement import MovementSystem
from bot.crafting_mediator import ICraftingMediator, TagCraftingMediator, CraftingPlan

logger = logging.getLogger(__name__)


class CraftingSystem:
    """Crafting system for bot item crafting."""

    def __init__(
        self,
        driver: IDriverAdapter,
        background: BackgroundTaskManager,
        movement: MovementSystem,
        inventory: InventorySystem,
        crafting_mediator: Optional[ICraftingMediator] = None,
    ) -> None:
        self._driver = driver
        self._movement = movement
        self._inventory = inventory
        self._background = background
        self._crafting_mediator = crafting_mediator or TagCraftingMediator()

    async def craft(self, item_name: str, count: int = 1, timeout: float = 30.0) -> ActionResult:
        start_time = time.time()

        executable_recipe = None
        inventory: Dict[str, int] = {}
        missing_materials: Dict[str, int] = {}
        uses_tag_substitution = False

        try:
            item_id = self._driver.get_item_id(item_name)
            if item_id is None:
                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"Unknown item: {item_name}",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )

            crafting_table_block = None
            try:
                ct_id = self._driver.get_block_id("crafting_table")
                if ct_id is not None:
                    crafting_table_block = self._driver.find_block({
                        "matching": ct_id,
                        "maxDistance": 32
                    })
            except Exception:
                pass

            all_recipes = []
            try:
                all_recipes_proxy = self._driver.recipes_all(item_id, crafting_table_block)
                all_recipes = list(all_recipes_proxy) if all_recipes_proxy else []
            except Exception as e:
                logger.debug(f"recipesAll failed: {e}")

            if not all_recipes:
                try:
                    recipes_proxy = None
                    try:
                        recipes_proxy = self._driver.recipes_for(item_id, count=int(count), crafting_table=crafting_table_block)
                    except Exception:
                        try:
                            recipes_proxy = self._driver.recipes_for(item_id, count=int(count))
                        except Exception:
                            recipes_proxy = self._driver.recipes_for(item_id)
                    all_recipes = list(recipes_proxy) if recipes_proxy else []
                except Exception:
                    pass

            # 🔧 Fix: 在返回 "No recipe found" 之前，先检查是否需要工作台
            if not all_recipes:
                requires_table = self._driver.recipe_requires_table(item_name)

                logger.info(
                    f"[craft] Recipe check for {item_name}: "
                    f"requires_table={requires_table}, "
                    f"crafting_table_nearby={crafting_table_block is not None}"
                )

                if requires_table:
                    return ActionResult(
                        success=False,
                        action="craft",
                        message=f"Crafting {item_name} requires a crafting table. Please place one nearby.",
                        status=ActionStatus.FAILED,
                        error_code="STATION_NOT_PLACED",
                        data={"station": "crafting_table", "item": item_name}
                    )

                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"No recipe found for {item_name}",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )


            inventory = self._inventory.get_inventory_summary()
            logger.info(f"[craft] Found {len(all_recipes)} recipe variants for {item_name}")

            executable_recipe, missing_materials, uses_tag_substitution = self._find_executable_recipe(
                all_recipes,
                inventory,
                count
            )
            resolved_plan: Optional[CraftingPlan] = None
            if executable_recipe:
                try:
                    resolved_plan = self._crafting_mediator.resolve(
                        executable_recipe,
                        inventory,
                        count,
                        self._driver.get_item_name,
                    )
                    if resolved_plan and resolved_plan.missing:
                        display_missing = self._format_missing_for_message(resolved_plan.missing, inventory)
                        return ActionResult(
                            success=False,
                            action="craft",
                            message=f"Insufficient materials for {item_name}: {display_missing}",
                            status=ActionStatus.FAILED,
                            error_code="INSUFFICIENT_MATERIALS",
                            data={"missing": resolved_plan.missing, "item": item_name, "tag_aware": True},
                            duration_ms=int((time.time() - start_time) * 1000),
                        )
                    if resolved_plan and resolved_plan.uses_tag_substitution:
                        uses_tag_substitution = True
                except Exception as resolve_err:
                    logger.warning(f"[craft] Mediator resolve failed: {resolve_err}")

            if not executable_recipe and "__recipe_parse_failed__" in missing_materials:
                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"Failed to craft {item_name}: recipe parse failed (delta)",
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
                display_missing = self._format_missing_for_message(missing_materials, inventory)
                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"Insufficient materials for {item_name}: {display_missing}",
                    status=ActionStatus.FAILED,
                    error_code="INSUFFICIENT_MATERIALS",
                    data={"missing": missing_materials, "item": item_name, "tag_aware": True},
                    duration_ms=int((time.time() - start_time) * 1000)
                )

            crafting_table = None
            if executable_recipe.requiresTable:
                ct_id = self._driver.get_block_id("crafting_table")
                if ct_id is not None:
                    crafting_table = self._driver.find_block({
                        "matching": ct_id,
                        "maxDistance": 32
                    })

                if not crafting_table:
                    return ActionResult(
                        success=False,
                        action="craft",
                        message=f"Crafting {item_name} requires a crafting table, but none was found nearby.",
                        status=ActionStatus.FAILED,
                        error_code="NO_TOOL"
                    )

            # 🔧 只有在需要工作台的配方中使用 tag 替换时，才走 manual fallback
            # 对于 2x2 配方（如 crafting_table），让 bot.craft() 直接处理
            if uses_tag_substitution and executable_recipe.requiresTable:
                return await self._manual_craft_fallback(
                    executable_recipe,
                    count,
                    item_name,
                    crafting_table,
                    timeout,
                    start_time,
                    reason="tag_substitution",
                    resolved_plan=resolved_plan,
                )

            try:
                await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: self._driver.craft_recipe(executable_recipe, count, crafting_table)
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
                    if not getattr(executable_recipe, "inShape", None):
                        logger.warning(
                            "[craft] Recipe has no inShape; skipping manual fallback to avoid unsafe crafting."
                        )
                        raise craft_exc
                    try:
                        return await self._manual_craft_fallback(
                            executable_recipe,
                            count,
                            item_name,
                            crafting_table,
                            timeout,
                            start_time,
                            reason="mineflayer_failed"
                        )
                    except Exception as manual_exc:
                        logger.error(f"[craft] Manual generic fallback failed: {manual_exc}")

                if "missing ingredient" in msg_lower and item_name == "crafting_table" and crafting_table is None:
                    pass

                raise craft_exc

            return ActionResult(
                success=True,
                action="craft",
                message=f"Successfully crafted {count}x {item_name}",
                status=ActionStatus.SUCCESS,
                data={"crafted": {item_name: count}},
                duration_ms=int((time.time() - start_time) * 1000)
            )

        except asyncio.TimeoutError:
            return ActionResult(
                success=False,
                action="craft",
                message=f"Crafting {item_name} timed out",
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
                from bot.tag_resolver import get_tag_resolver
                tag_resolver = get_tag_resolver()
                try:
                    if executable_recipe is not None:
                        required = self._extract_recipe_materials(executable_recipe)
                        for material_id, required_count in required.items():
                            material_name = self._get_item_name_by_id(material_id)
                            if not material_name:
                                continue
                            have = tag_resolver.get_available_count(material_name, inventory)
                            need = int(required_count) * int(count)
                            if have < need:
                                missing[material_name] = need - have
                except Exception:
                    pass

                if not missing:
                    m = re.search(r"missing ingredient\s+([a-z0-9_]+)", error_msg.lower())
                    if m:
                        candidate = m.group(1)
                        if tag_resolver.get_available_count(candidate, inventory) < 1:
                            missing[candidate] = 1

                if missing:
                    data = {"missing": missing, "item": item_name, "tag_aware": True}
            return ActionResult(
                success=False,
                action="craft",
                message=error_msg,
                status=ActionStatus.FAILED,
                error_code=error_code,
                data=data,
                duration_ms=int((time.time() - start_time) * 1000)
            )

    async def _manual_craft_fallback(
        self,
        recipe: Any,
        count: int,
        item_name: str,
        crafting_table,
        timeout: float,
        start_time: float,
        reason: str,
        resolved_plan: Optional[CraftingPlan] = None,
    ) -> ActionResult:
        logger.warning(
            f"[craft] Using manual craft fallback for {item_name} (reason={reason})"
        )

        use_window = None
        if recipe.requiresTable:
            current_window = self._driver.get_current_window()
            current_title = self._driver.get_window_title(current_window) if current_window else ""

            if not current_window or "crafting_table" not in str(current_title).lower():
                if crafting_table is None:
                    crafting_table = self._driver.find_block({
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
                                await self._driver.look_at(center)
                            except Exception:
                                pass

                            logger.info("[craft] Activating block...")
                            try:
                                self._driver.activate_block(crafting_table)
                            except Exception as act_err:
                                logger.error(f"[craft] activateBlock failed: {act_err}")

                            logger.info("[craft] Waiting for window to open...")
                            await asyncio.sleep(1.0)

                            for _ in range(15):
                                try:
                                    w = self._driver.get_current_window()
                                    if w:
                                        w_title = self._driver.get_window_title(w).lower() if w else "none"
                                        w_type = self._driver.get_window_type(w) if w else "none"
                                        w_len = self._driver.get_window_length(w) if w else 0

                                        logger.info(
                                            f"[craft] Detected open window: title='{w_title}', "
                                            f"type='{w_type}', slots={w_len}"
                                        )

                                        is_crafting = (
                                            "crafting_table" in w_title or
                                            "\u5de5\u4f5c\u53f0" in w_title or
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

        before_count = self._inventory.get_inventory_count(item_name)
        expected_per_craft = self._get_recipe_output_count(recipe)
        expected_total = max(1, int(count) * expected_per_craft)

        def _run_manual() -> None:
            craft_times = max(int(count), 1)
            if resolved_plan:
                for idx in range(craft_times):
                    if idx == 0:
                        plan = resolved_plan
                    else:
                        inv = self._inventory.get_inventory_summary()
                        plan = self._crafting_mediator.resolve(
                            recipe,
                            inv,
                            1,
                            self._driver.get_item_name,
                        )
                        if plan.missing:
                            raise RuntimeError(f"manual craft missing material: {plan.missing}")
                    self._manual_craft_plan_sync(plan, use_window)
            else:
                self._manual_craft_generic_sync(recipe, craft_times, use_window)

        await asyncio.wait_for(
            asyncio.get_event_loop().run_in_executor(None, _run_manual),
            timeout=timeout * 3,
        )

        after_count = self._inventory.get_inventory_count(item_name)
        if after_count - before_count < expected_total:
            raise RuntimeError(
                f"manual craft produced no output for {item_name} "
                f"(expected >= {expected_total}, got {after_count - before_count})"
            )

        return ActionResult(
            success=True,
            action="craft",
            message=f"Successfully crafted {count}x {item_name} (Manual Fallback)",
            status=ActionStatus.SUCCESS,
            data={"crafted": {item_name: count}, "mode": "manual_generic", "reason": reason},
            duration_ms=int((time.time() - start_time) * 1000)
        )

    def _get_recipe_output_count(self, recipe) -> int:
        try:
            result = getattr(recipe, "result", None)
            if isinstance(result, dict):
                raw_count = result.get("count")
            else:
                raw_count = getattr(result, "count", None)
            count = _coerce_js_int(raw_count)
            return int(count) if count and int(count) > 0 else 1
        except Exception:
            return 1

    def _format_missing_for_message(self, missing: Dict[str, int], inventory: Dict[str, int]) -> Dict[str, int]:
        from bot.tag_resolver import get_tag_resolver

        if not missing:
            return {}

        tag_resolver = get_tag_resolver()
        display: Dict[str, int] = {}
        for name, count in missing.items():
            tag = None
            if hasattr(tag_resolver, "get_tag_for_item"):
                tag = tag_resolver.get_tag_for_item(name)
            if tag and not tag.startswith("_"):
                display_name = tag
            else:
                display_name = name
            display[display_name] = display.get(display_name, 0) + int(count)
        return display

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
            return self._driver.get_inventory_slots()

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

            self._driver.click_window(source, 0, 0)
            _time.sleep(0.05)

            for slot in input_slots:
                self._driver.click_window(slot, 1, 0)
                _time.sleep(0.05)

            self._driver.click_window(source, 0, 0)
            _time.sleep(0.05)

            self._driver.click_window(output_slot, 0, 1)
            _time.sleep(0.1)

    def _manual_craft_plan_sync(self, plan: CraftingPlan, crafting_table_window=None) -> None:
        import time as _time

        if not plan.slots:
            raise RuntimeError("manual craft plan has no slots")

        window = crafting_table_window if crafting_table_window else self._driver.get_inventory_window()
        is_3x3 = (crafting_table_window is not None)
        grid_width = 3 if is_3x3 else 2

        def _normalize_name(name: Optional[str]) -> str:
            if not name:
                return ""
            n = str(name).strip()
            if n.startswith("minecraft:"):
                n = n.split("minecraft:", 1)[1]
            return n

        def get_grid_slot(row, col):
            if is_3x3:
                return 1 + row * 3 + col
            return 1 + row * 2 + col

        grid_slots_count = 9 if is_3x3 else 4
        for i in range(1, grid_slots_count + 1):
            slot_item = self._driver.get_window_slot(window, i)
            if slot_item:
                self._driver.click_window(i, 0, 1)
                _time.sleep(0.2)

        search_start = 10 if is_3x3 else 9

        def find_material_slot_by_name(target_name: str) -> int:
            slots_len = int(self._driver.get_window_length(window))
            norm_target = _normalize_name(target_name)
            logger.debug(
                f"[find_material_slot] Searching for target_name={norm_target}, "
                f"search_start={search_start}, slots_len={slots_len}"
            )
            for i in range(search_start, slots_len):
                item = self._driver.get_window_slot(window, i)
                if item and _normalize_name(getattr(item, "name", "")) == norm_target:
                    logger.debug(f"[find_material_slot] Exact match found at slot {i}: {item.name}")
                    return i
            logger.warning(f"[find_material_slot] No material found for {norm_target}")
            return -1

        plan_by_item: Dict[str, List[int]] = {}
        for row, col, item_name in plan.slots:
            slot_idx = get_grid_slot(int(row), int(col))
            norm_name = _normalize_name(item_name)
            if not norm_name:
                continue
            plan_by_item.setdefault(norm_name, []).append(slot_idx)

        for item_name, slot_list in plan_by_item.items():
            remaining_slots = list(slot_list)
            while remaining_slots:
                source_slot = find_material_slot_by_name(item_name)
                if source_slot < 0:
                    raise RuntimeError(f"manual craft missing material: {item_name}")

                source_item = self._driver.get_window_slot(window, source_slot)
                try:
                    source_count = int(source_item.count) if source_item else 0
                except Exception:
                    source_count = 0
                if source_count <= 0:
                    source_count = len(remaining_slots)

                self._driver.click_window(source_slot, 0, 0)
                _time.sleep(0.08)

                to_place = min(source_count, len(remaining_slots))
                for _ in range(to_place):
                    slot_idx = remaining_slots.pop(0)
                    self._driver.click_window(slot_idx, 1, 0)
                    _time.sleep(0.08)

                self._driver.click_window(source_slot, 0, 0)
                _time.sleep(0.08)

        self._driver.click_window(0, 0, 1)
        _time.sleep(0.2)

    def _manual_craft_generic_sync(self, recipe, count: int = 1, crafting_table_window=None) -> None:
        import time as _time
        from bot.tag_resolver import get_tag_resolver

        tag_resolver = get_tag_resolver()

        window = crafting_table_window if crafting_table_window else self._driver.get_inventory_window()
        is_3x3 = (crafting_table_window is not None)
        grid_width = 3 if is_3x3 else 2

        def get_grid_slot(row, col):
            if is_3x3:
                return 1 + row * 3 + col
            return 1 + row * 2 + col

        grid_slots_count = 9 if is_3x3 else 4
        for i in range(1, grid_slots_count + 1):
            slot_item = self._driver.get_window_slot(window, i)
            if slot_item:
                self._driver.click_window(i, 0, 1)
                _time.sleep(0.2)

        inventory_snapshot = {}
        for item in self._driver.get_inventory_items():
            inventory_snapshot[item.name] = inventory_snapshot.get(item.name, 0) + item.count

        shape = recipe.inShape
        if not shape:
            raise RuntimeError("Recipe has no inShape")

        slots = self._driver.get_window_slots(window)
        if not slots:
            pass

        search_start = 10 if is_3x3 else 9

        def find_material_slot(target_id: int) -> int:
            slots_len = int(self._driver.get_window_length(window))
            logger.debug(
                f"[find_material_slot] Searching for target_id={target_id}, "
                f"search_start={search_start}, slots_len={slots_len}"
            )

            # 第一轮：精确匹配
            for i in range(search_start, slots_len):
                item = self._driver.get_window_slot(window, i)
                if item and item.type == target_id:
                    logger.debug(f"[find_material_slot] Exact match found at slot {i}: {item.name}")
                    return i

            # 第二轮：Tag 等价匹配
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
                item = self._driver.get_window_slot(window, i)
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

        def _extract_item_id(cell) -> Optional[int]:
            if cell is None:
                return None
            try:
                if isinstance(cell, list):
                    for candidate in cell:
                        cid = _extract_item_id(candidate)
                        if cid is not None and cid > 0:
                            return int(cid)
                    return None
                if isinstance(cell, dict):
                    raw_id = cell.get("id")
                else:
                    raw_id = getattr(cell, "id", None)
                cid = _coerce_js_int(raw_id)
                if cid is None or int(cid) <= 0:
                    return None
                return int(cid)
            except Exception:
                return None

        plan: List[Tuple[int, int]] = []
        for r in range(max_rows):
            row = shape[r]
            for c in range(max_cols):
                item = row[c]
                if not item:
                    continue
                target_id = _extract_item_id(item)
                if target_id is None:
                    continue
                plan.append((get_grid_slot(r, c), int(target_id)))

        plan_by_item: Dict[int, List[int]] = {}
        for slot_idx, item_id in plan:
            plan_by_item.setdefault(int(item_id), []).append(slot_idx)

        for item_id, slot_list in plan_by_item.items():
            remaining_slots = list(slot_list)
            while remaining_slots:
                source_slot = find_material_slot(item_id)
                if source_slot < 0:
                    name = self._get_item_name_by_id(item_id) or str(item_id)
                    raise RuntimeError(f"manual craft missing material: {name}")

                source_item = self._driver.get_window_slot(window, source_slot)
                try:
                    source_count = int(source_item.count) if source_item else 0
                except Exception:
                    source_count = 0
                if source_count <= 0:
                    source_count = len(remaining_slots)

                self._driver.click_window(source_slot, 0, 0)
                _time.sleep(0.08)

                to_place = min(source_count, len(remaining_slots))
                for _ in range(to_place):
                    slot_idx = remaining_slots.pop(0)
                    self._driver.click_window(slot_idx, 1, 0)
                    _time.sleep(0.08)

                self._driver.click_window(source_slot, 0, 0)
                _time.sleep(0.08)
        self._driver.click_window(0, 0, 1)
        _time.sleep(0.2)

    def _find_executable_recipe(
        self,
        all_recipes,
        inventory: Dict[str, int],
        count: int
    ) -> Tuple[Optional[Any], Dict[str, int], bool]:
        from bot.tag_resolver import get_tag_resolver
        tag_resolver = get_tag_resolver()

        logger.debug(f"[_find_executable_recipe] inventory contents: {inventory}")

        def _normalize_name(name: Optional[str]) -> str:
            if not name:
                return ""
            n = str(name).strip()
            if n.startswith("minecraft:"):
                n = n.split("minecraft:", 1)[1]
            return n

        inventory_norm: Dict[str, int] = {}
        for k, v in (inventory or {}).items():
            nk = _normalize_name(k)
            if not nk:
                continue
            inventory_norm[nk] = inventory_norm.get(nk, 0) + int(v or 0)

        best_recipe = None
        best_missing: Dict[str, int] = {}
        best_missing_count = 99999
        best_substitution_count = 99999

        for recipe in all_recipes:
            try:
                needed = self._extract_recipe_materials(recipe)
            except Exception:
                best_missing["__recipe_parse_failed__"] = best_missing.get("__recipe_parse_failed__", 0) + 1
                continue

            missing: Dict[str, int] = {}
            substitution_count = 0
            for item_id, req_count in needed.items():
                item_name = self._get_item_name_by_id(item_id)
                if not item_name:
                    continue
                have = tag_resolver.get_available_count(item_name, inventory)
                need = int(req_count) * int(count)
                if have < need:
                    logger.debug(
                        f"[_find_executable_recipe] Material check: {item_name} need={need}, "
                        f"have={have} (tag-aware)"
                    )
                    missing[item_name] = need - have
                else:
                    logger.debug(f"[_find_executable_recipe] Material OK: {item_name} need={need}, have={have}")
                    norm_name = _normalize_name(item_name)
                    exact_have = int(inventory_norm.get(norm_name, 0))
                    if exact_have < need:
                        substitution_count += 1

            if not missing:
                if substitution_count == 0:
                    return (recipe, {}, False)
                if substitution_count < best_substitution_count:
                    best_recipe = recipe
                    best_substitution_count = substitution_count
                continue

            missing_count = sum(missing.values())
            if missing_count < best_missing_count:
                best_missing_count = missing_count
                best_missing = missing

        if best_recipe is not None:
            return (best_recipe, {}, True)

        return (None, best_missing, False)

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
        return self._driver.get_item_name(item_id)

    # =========================================================================
    # Smelting System
    # =========================================================================
    
    # Smeltable items: raw -> product
    SMELTABLE_ITEMS = {
        "raw_iron": "iron_ingot",
        "raw_gold": "gold_ingot",
        "raw_copper": "copper_ingot",
        "iron_ore": "iron_ingot",  # Legacy
        "gold_ore": "gold_ingot",
        "copper_ore": "copper_ingot",
        "sand": "glass",
        "cobblestone": "stone",
        "oak_log": "charcoal",
        "spruce_log": "charcoal",
        "birch_log": "charcoal",
        "jungle_log": "charcoal",
        "acacia_log": "charcoal",
        "dark_oak_log": "charcoal",
        "cherry_log": "charcoal",
        "mangrove_log": "charcoal",
        "clay_ball": "brick",
        "netherrack": "nether_brick",
        "wet_sponge": "sponge",
        "kelp": "dried_kelp",
        "cactus": "green_dye",
        "ancient_debris": "netherite_scrap",
    }

    # Furnace type compatibility (subset of smeltable items)
    BLAST_FURNACE_ITEMS = {
        "raw_iron", "raw_gold", "raw_copper",
        "iron_ore", "gold_ore", "copper_ore",
        "ancient_debris",
    }
    SMOKER_ITEMS = {
        "kelp",
    }
    
    # Valid fuels with burn time (items smelted per fuel)
    FUEL_PRIORITY = [
        ("coal", 8),
        ("charcoal", 8),
        ("coal_block", 80),
        ("oak_log", 1.5),
        ("oak_planks", 1.5),
        ("stick", 0.5),
        ("dried_kelp_block", 20),
        ("blaze_rod", 12),
        ("lava_bucket", 100),
    ]

    async def smelt(
        self,
        item_name: str,
        count: int = 1,
        timeout: float = 120.0
    ) -> ActionResult:
        """
        Smelt items in a furnace.
        
        Flow:
        1. Validate item is smeltable
        2. Check inventory for raw materials
        3. Find nearby furnace (or craft one if possible)
        4. Navigate to furnace
        5. Open furnace and put fuel + input
        6. Wait for smelting to complete
        7. Take output
        
        Args:
            item_name: Raw item to smelt (e.g. "raw_iron")
            count: Number of items to smelt
            timeout: Maximum time for entire operation
        
        Returns:
            ActionResult with smelted items data
        """
        start_time = time.time()
        
        # Normalize item name
        smelt_input = item_name.replace("minecraft:", "")
        
        # Check if smeltable
        if smelt_input not in self.SMELTABLE_ITEMS:
            return ActionResult(
                success=False,
                action="smelt",
                message=f"{smelt_input} 不是可冶炼的物品",
                status=ActionStatus.FAILED,
                error_code="INVALID_TARGET"
            )
        
        output_item = self.SMELTABLE_ITEMS[smelt_input]
        
        # Check inventory for raw materials
        inventory = self._inventory.get_inventory_summary()
        available = inventory.get(smelt_input, 0)
        
        if available < count:
            return ActionResult(
                success=False,
                action="smelt",
                message=f"材料不足: 需要 {count} 个 {smelt_input}，只有 {available} 个",
                status=ActionStatus.FAILED,
                error_code="INSUFFICIENT_MATERIALS",
                data={"missing": {smelt_input: count - available}}
            )
        
        # Find fuel in inventory (ensure enough for count)
        fuel_item = None
        fuel_count_needed = 0
        best_candidate = None
        best_missing = None
        for fuel_name, burn_rate in self.FUEL_PRIORITY:
            available_fuel = inventory.get(fuel_name, 0)
            if available_fuel <= 0:
                continue

            required = int(math.ceil(count / burn_rate))
            if available_fuel >= required:
                fuel_item = fuel_name
                fuel_count_needed = required
                break

            missing = required - available_fuel
            if best_missing is None or missing < best_missing:
                best_missing = missing
                best_candidate = (fuel_name, available_fuel, required)

        if not fuel_item:
            if best_candidate:
                fuel_name, available_fuel, required = best_candidate
                return ActionResult(
                    success=False,
                    action="smelt",
                    message=(
                        f"燃料不足: 需要 {required} 个 {fuel_name}，只有 {available_fuel} 个"
                    ),
                    status=ActionStatus.FAILED,
                    error_code="INSUFFICIENT_MATERIALS",
                    data={"missing": {fuel_name: required - available_fuel}}
                )
            return ActionResult(
                success=False,
                action="smelt",
                message="没有燃料可用于冶炼",
                status=ActionStatus.FAILED,
                error_code="INSUFFICIENT_MATERIALS",
                data={"missing": {"fuel": 1}}
            )
        
        try:
            # Find furnace nearby
            furnace_block = None
            furnace_kind = None
            furnace_types = ["furnace"]
            if smelt_input in self.BLAST_FURNACE_ITEMS:
                furnace_types.append("blast_furnace")
            if smelt_input in self.SMOKER_ITEMS:
                furnace_types.append("smoker")
            
            for furnace_type in furnace_types:
                try:
                    block_id = self._driver.get_block_id(furnace_type)
                    if block_id is not None:
                        furnace_block = self._driver.find_block({
                            "matching": block_id,
                            "maxDistance": 32
                        })
                        if furnace_block:
                            furnace_kind = furnace_type
                            logger.info(f"[smelt] Found {furnace_type} at {furnace_block.position}")
                            break
                except Exception:
                    continue
            
            if not furnace_block:
                # Check if we can craft a furnace
                if inventory.get("cobblestone", 0) >= 8:
                    logger.info("[smelt] No furnace found, attempting to craft one...")
                    craft_result = await self.craft("furnace", 1)
                    if not craft_result.success:
                        return ActionResult(
                            success=False,
                            action="smelt",
                            message="附近没有熔炉，且无法合成",
                            status=ActionStatus.FAILED,
                            error_code="NO_TOOL",
                            data={"station": "furnace"}
                        )
                    # Need to place the furnace - this requires placing logic
                    return ActionResult(
                        success=False,
                        action="smelt",
                        message="已合成熔炉，请先放置后再冶炼",
                        status=ActionStatus.FAILED,
                        error_code="STATION_NOT_PLACED",
                        data={"station": "furnace", "action_needed": "place"}
                    )
                else:
                    return ActionResult(
                        success=False,
                        action="smelt",
                        message="附近没有熔炉",
                        status=ActionStatus.FAILED,
                        error_code="NO_TOOL",
                        data={"station": "furnace"}
                    )
            
            # Navigate to furnace
            pos = furnace_block.position
            nav_result = await self._movement.navigate_to_block(
                int(pos.x), int(pos.y), int(pos.z)
            )
            if not nav_result:
                logger.warning(f"[smelt] Navigation to furnace failed, trying anyway...")
            
            # Open furnace using mineflayer API
            loop = asyncio.get_running_loop()
            open_method = self._driver.open_furnace
            if furnace_kind == "blast_furnace":
                open_method = self._driver.open_blast_furnace
            elif furnace_kind == "smoker":
                open_method = self._driver.open_smoker
            furnace = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    lambda: open_method(furnace_block)
                ),
                timeout=10.0
            )
            
            if not furnace:
                return ActionResult(
                    success=False,
                    action="smelt",
                    message="无法打开熔炉",
                    status=ActionStatus.FAILED,
                    error_code="EXECUTION_ERROR"
                )
            
            try:
                # Get item type IDs
                input_item_id = self._driver.get_item_id(smelt_input)
                fuel_item_id = self._driver.get_item_id(fuel_item) if fuel_item else None

                if input_item_id is None:
                    raise RuntimeError(f"Unknown item: {smelt_input}")
                
                # Put fuel first
                if fuel_item_id is not None:
                    logger.info(f"[smelt] Putting fuel: {fuel_item}")
                    await asyncio.wait_for(
                        loop.run_in_executor(
                            None,
                            lambda: furnace.putFuel(fuel_item_id, None, fuel_count_needed)
                        ),
                        timeout=5.0
                    )
                
                # Put input
                logger.info(f"[smelt] Putting input: {count}x {smelt_input}")
                await asyncio.wait_for(
                    loop.run_in_executor(
                        None,
                        lambda: furnace.putInput(input_item_id, None, count)
                    ),
                    timeout=5.0
                )
                
                # Wait for smelting - poll furnace.outputItem()
                # Each item takes ~10 seconds to smelt
                smelt_time_per_item = 10.0
                max_wait = min(count * smelt_time_per_item + 10, timeout - (time.time() - start_time))
                
                logger.info(f"[smelt] Waiting up to {max_wait:.1f}s for smelting...")
                smelted_count = 0
                poll_start = time.time()
                
                while time.time() - poll_start < max_wait:
                    await asyncio.sleep(2.0)
                    
                    output = furnace.outputItem()
                    if output and output.count > 0:
                        smelted_count = output.count
                        if smelted_count >= count:
                            break
                    
                    # Check if input is empty and output has items
                    input_remaining = furnace.inputItem()
                    if (not input_remaining or input_remaining.count == 0) and smelted_count > 0:
                        break
                
                # Take output
                if smelted_count > 0:
                    logger.info(f"[smelt] Taking output: {smelted_count}x {output_item}")
                    await asyncio.wait_for(
                        loop.run_in_executor(
                            None,
                            lambda: furnace.takeOutput()
                        ),
                        timeout=5.0
                    )
                
                # Close furnace
                try:
                    furnace.close()
                except Exception:
                    pass
                
                if smelted_count == 0:
                    return ActionResult(
                        success=False,
                        action="smelt",
                        message=f"冶炼超时，没有产出",
                        status=ActionStatus.TIMEOUT,
                        error_code="TIMEOUT",
                        duration_ms=int((time.time() - start_time) * 1000)
                    )
                
                return ActionResult(
                    success=True,
                    action="smelt",
                    message=f"成功冶炼 {smelted_count} 个 {output_item}",
                    status=ActionStatus.SUCCESS,
                    data={"smelted": {output_item: smelted_count}},
                    duration_ms=int((time.time() - start_time) * 1000)
                )
                
            finally:
                try:
                    furnace.close()
                except Exception:
                    pass
        
        except asyncio.TimeoutError:
            return ActionResult(
                success=False,
                action="smelt",
                message=f"冶炼 {smelt_input} 超时",
                status=ActionStatus.TIMEOUT,
                error_code="TIMEOUT",
                duration_ms=int((time.time() - start_time) * 1000)
            )
        except Exception as e:
            logger.error(f"[smelt] Failed: {e}")
            return ActionResult(
                success=False,
                action="smelt",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="EXECUTION_ERROR",
                duration_ms=int((time.time() - start_time) * 1000)
            )
