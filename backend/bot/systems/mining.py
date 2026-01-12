# Mining and placement system

from __future__ import annotations

import asyncio
import inspect
import logging
import math
import time
from typing import Optional, List, Dict, Any

from bot.drivers.interfaces import IDriverAdapter
from bot.interfaces import ActionResult, ActionStatus
from bot.systems.common import BackgroundTaskManager, ProgressTimer
from bot.systems.inventory import InventorySystem
from bot.systems.movement import MovementSystem

logger = logging.getLogger(__name__)


class MiningSystem:
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
        self._progress_timer: Optional[ProgressTimer] = None
        # 🔧 Fix: 持久化 cheats 状态，一旦无权限就永久禁用
        
        # 地下方块列表（从知识库加载 + 基础石头类）
        # 这些方块通常在地下，找不到时应该尝试向下探测
        self._underground_blocks: Optional[set] = None  # 延迟加载

    def _get_underground_blocks(self) -> set:
        """
        获取地下方块列表（延迟加载）
        
        从知识库加载 all_ores 标签，并添加基础石头类方块
        """
        if self._underground_blocks is None:
            # 基础石头类方块（总是在地下）
            base_blocks = {
                "cobblestone", "stone", "deepslate", "tuff", "calcite",
                "granite", "diorite", "andesite", "ancient_debris",
            }
            
            # 从知识库加载矿石
            try:
                import json
                from pathlib import Path
                
                kb_path = Path(__file__).parent.parent.parent / "data" / "mc_knowledge_base.json"
                if kb_path.exists():
                    with open(kb_path, "r", encoding="utf-8") as f:
                        kb = json.load(f)
                    
                    # 加载 all_ores 标签
                    ores = set(kb.get("tags", {}).get("all_ores", []))
                    self._underground_blocks = base_blocks | ores
                    logger.debug(f"[Mining] Loaded {len(self._underground_blocks)} underground blocks from KB")
                else:
                    logger.warning("[Mining] Knowledge base not found, using base blocks only")
                    self._underground_blocks = base_blocks
            except Exception as e:
                logger.warning(f"[Mining] Failed to load KB: {e}, using base blocks only")
                self._underground_blocks = base_blocks
        
        return self._underground_blocks

    async def _get_block_harvest_info(self, block) -> dict:

        def _sync_get():
            try:
                harvest_tools = getattr(block, "harvestTools", None)
                tools_dict = {}
                can_hand = True

                if harvest_tools:
                    can_hand = False
                    try:
                        for key in harvest_tools:
                            tools_dict[int(key)] = True
                    except Exception:
                        pass

                return {
                    "name": getattr(block, "name", "unknown"),
                    "harvestTools": tools_dict,
                    "can_hand_harvest": can_hand,
                }
            except Exception as e:
                logger.warning(f"Failed to get harvest info: {e}")
                return {"name": "unknown", "harvestTools": {}, "can_hand_harvest": True}

        return await asyncio.get_event_loop().run_in_executor(None, _sync_get)

    async def _select_best_harvest_tool(self, block) -> Optional[dict]:
        TOOL_TIERS = {
            "netherite": 5,
            "diamond": 4,
            "iron": 3,
            "stone": 2,
            "golden": 1,
            "wooden": 0,
        }

        def _sync_select():
            try:
                harvest_tools = getattr(block, "harvestTools", None)

                if not harvest_tools:
                    logger.debug(f"Block {block.name} can be harvested by hand")
                    return None

                required_tool_ids = set()
                try:
                    for key in harvest_tools:
                        required_tool_ids.add(int(key))
                except Exception:
                    pass

                if not required_tool_ids:
                    return None

                inventory_items = list(self._driver.get_inventory_items())
                available_tools = []

                for item in inventory_items:
                    if item.type in required_tool_ids:
                        tier = 0
                        item_name = item.name.lower()
                        for tier_name, tier_value in TOOL_TIERS.items():
                            if tier_name in item_name:
                                tier = tier_value
                                break
                        available_tools.append((tier, item))

                if not available_tools:
                    required_names = []
                    for tool_id in list(required_tool_ids)[:5]:
                        try:
                            item_name = self._driver.get_item_name(tool_id)
                            if item_name:
                                required_names.append(item_name)
                            else:
                                required_names.append(f"item_{tool_id}")
                        except Exception:
                            required_names.append(f"item_{tool_id}")

                    return {
                        "error": "NO_TOOL",
                        "required": required_names,
                        "block": block.name
                    }

                available_tools.sort(key=lambda x: x[0], reverse=True)
                best_tool = available_tools[0][1]

                held_item = self._driver.get_held_item()
                if held_item and held_item.type == best_tool.type:
                    logger.debug(f"Already holding best tool: {best_tool.name}")
                    return None

                logger.info(
                    f"Selected tool: {best_tool.name} "
                    f"(tier {available_tools[0][0]}) for {block.name}"
                )
                return {"item": best_tool}

            except Exception as e:
                logger.error(f"Tool selection failed: {e}")
                return None

        return await asyncio.get_event_loop().run_in_executor(None, _sync_select)

    def _infer_tool_requirements(self, required_tools: List[str]) -> tuple[Optional[str], Optional[str]]:
        tier_order = ["wooden", "stone", "iron", "diamond", "netherite"]
        tool_type = None
        min_tier = None

        for tool in required_tools or []:
            if not isinstance(tool, str):
                continue
            name = tool.lower()
            parts = name.split("_")
            if len(parts) < 2:
                continue
            tier = parts[0]
            kind = parts[-1]

            if tool_type is None:
                tool_type = kind
            if tier in tier_order:
                if min_tier is None or tier_order.index(tier) < tier_order.index(min_tier):
                    min_tier = tier

        if tool_type and min_tier is None:
            min_tier = "wooden"

        return tool_type, min_tier

    def _equip_axe_sync(self) -> bool:
        AXE_PRIORITY = [
            "netherite_axe", "diamond_axe", "iron_axe",
            "stone_axe", "golden_axe", "wooden_axe"
        ]

        try:
            held = self._driver.get_held_item()
            if held and "axe" in held.name:
                return True

            for axe_name in AXE_PRIORITY:
                for item in self._driver.get_inventory_items():
                    if item.name == axe_name:
                        self._driver.equip_item(item, "hand")
                        logger.debug(f"Equipped {axe_name} for tree mining")
                        return True

            return False
        except Exception as e:
            logger.warning(f"Failed to equip axe: {e}")
            return False

    def _dig_sync(self, block) -> None:
        """
        Synchronously dig a block.
        
        The driver's dig() is async, so we need to handle it properly.
        We create a new event loop to run the coroutine since we're being
        called from run_in_executor (which runs in a thread pool).
        """
        try:
            result = self._driver.dig(block)
            
            # If result is a coroutine/awaitable, we need to run it
            if inspect.isawaitable(result):
                # We're in a thread pool worker, so we can create a new event loop
                loop = asyncio.new_event_loop()
                try:
                    asyncio.set_event_loop(loop)
                    loop.run_until_complete(result)
                finally:
                    loop.close()
                    asyncio.set_event_loop(None)
            # If result is None or not awaitable, dig was synchronous and completed
            
        except Exception as e:
            logger.warning(f"[_dig_sync] dig() raised: {e}")
            raise

    def _is_underground_target(self, block_type: str) -> bool:
        try:
            return block_type in self._get_underground_blocks()
        except Exception:
            return False

    def _find_nearest_block(self, block_id: int, center: Any, max_distance: int = 16) -> Any:
        """
        Find the nearest block of the given type within max_distance.
        
        Args:
            block_id: The block ID to search for
            center: Center position (Vec3) to search from
            max_distance: Maximum search radius
            
        Returns:
            Block if found, None otherwise
        """
        try:
            # Use driver's find_block method with matching query
            result = self._driver.find_block({
                "matching": block_id,
                "maxDistance": max_distance,
                "point": center
            })
            
            if result:
                logger.debug(f"[_find_nearest_block] Found block id={block_id} at ({result.position.x}, {result.position.y}, {result.position.z})")
            
            return result
        except Exception as e:
            logger.debug(f"[_find_nearest_block] Search failed: {e}")
            return None

    def _should_spiral_to_target(self, block_type: str, target_block) -> bool:
        # For underground mining tasks, always prefer a spiral descent.
        if not self._is_underground_target(block_type):
            return False
        return True

    def _spiral_steps_to_target(self, target_block, max_steps: int = 16) -> int:
        try:
            pos = self._driver.get_position()
            dy = int(pos.y) - int(target_block.position.y) - 1
            if dy <= 0:
                return max(2, min(6, max_steps))
            return max(2, min(max_steps, dy))
        except Exception:
            return max_steps

    def _is_air_block(self, block) -> bool:
        try:
            if block is None:
                return True
            if block.name in ("air", "cave_air", "void_air"):
                return True
            if block.name in ("water", "lava"):
                return False
            if getattr(block, "boundingBox", "") == "empty":
                return True
            return False
        except Exception:
            return True

    def _is_hazard_block(self, block) -> bool:
        try:
            return block is not None and block.name in ("lava", "water")
        except Exception:
            return False

    def _is_soft_obstacle(self, block) -> bool:
        try:
            if block is None:
                return False
            name = block.name
            if name in (
                "grass_block", "dirt", "coarse_dirt", "rooted_dirt", "podzol",
                "mycelium", "moss_block", "mud", "clay",
                "grass", "tall_grass", "fern", "large_fern", "dead_bush",
                "pink_petals", "vine", "moss_carpet", "snow",
                "azalea_leaves", "flowering_azalea_leaves",
            ):
                return True
            if name.endswith(("_leaves", "_sapling", "_log", "_stem")):
                return True
            return False
        except Exception:
            return False

    def _find_scaffold_item(self):
        candidates = [
            "cobblestone", "dirt", "stone", "tuff", "deepslate",
            "granite", "diorite", "andesite", "calcite",
            "oak_planks", "spruce_planks", "birch_planks", "jungle_planks",
            "acacia_planks", "dark_oak_planks", "mangrove_planks", "cherry_planks",
        ]
        for name in candidates:
            item = self._inventory.find_inventory_item(name)
            if item and getattr(item, "count", 0) > 0:
                return item
        return None

    async def _place_block_at(self, x: int, y: int, z: int, item) -> bool:
        if not item:
            return False

        try:
            await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._driver.equip_item(item, "hand")
                ),
                timeout=2.0
            )
        except Exception:
            return False

        target_pos = self._Vec3(x, y, z)
        target_block = self._driver.block_at(target_pos)
        if not self._is_air_block(target_block):
            return True

        offsets = [
            (0, -1, 0), (0, 1, 0),
            (1, 0, 0), (-1, 0, 0),
            (0, 0, 1), (0, 0, -1),
        ]

        for ox, oy, oz in offsets:
            ref_pos = self._Vec3(x + ox, y + oy, z + oz)
            ref_block = self._driver.block_at(ref_pos)
            if self._is_air_block(ref_block) or self._is_hazard_block(ref_block):
                continue

            try:
                await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda b=ref_block, off=self._Vec3(-ox, -oy, -oz): self._driver.place_block(b, off)
                    ),
                    timeout=3.0
                )
            except Exception:
                continue

            placed = self._driver.block_at(target_pos)
            if not self._is_air_block(placed):
                return True

        return False

    async def _relocate_spiral_start(self, radius_min: int = 3, radius_max: int = 5) -> bool:
        pos = self._driver.get_position()
        base_x, base_y, base_z = int(pos.x), int(pos.y), int(pos.z)
        dir_index = self._yaw_to_spiral_index(self._driver.get_yaw())
        dirs = [(0, 1), (1, 0), (0, -1), (-1, 0)]

        async def try_step(nx: int, ny: int, nz: int) -> bool:
            support_block = self._driver.block_at(self._Vec3(nx, ny - 1, nz))
            if self._is_hazard_block(support_block):
                return False
            if self._is_air_block(support_block):
                scaffold_item = self._find_scaffold_item()
                if not await self._place_block_at(nx, ny - 1, nz, scaffold_item):
                    return False

            foot_block = self._driver.block_at(self._Vec3(nx, ny, nz))
            if self._is_hazard_block(foot_block):
                return False

            if not await self._dig_block_at(nx, ny, nz, allow_hand_break=True):
                return False
            await self._dig_block_at(nx, ny + 1, nz, allow_hand_break=True)
            return await self._step_to(nx, ny, nz)

        for dist in range(radius_min, radius_max + 1):
            for offset in range(4):
                dx, dz = dirs[(dir_index + offset) % 4]
                cur_x, cur_z = base_x, base_z
                moved = True
                for _ in range(dist):
                    cur_x += dx
                    cur_z += dz
                    if not await try_step(cur_x, base_y, cur_z):
                        moved = False
                        break
                if moved:
                    logger.info(f"[Mining] Relocated spiral start to {cur_x},{base_y},{cur_z}")
                    return True

        return False

    async def _attempt_spiral_descent(
        self,
        block_type: str,
        max_steps: int,
        scan_radius: int,
        timeout: float,
        relocate_attempts: int = 2,
    ) -> ActionResult:
        last_result: Optional[ActionResult] = None
        for attempt in range(relocate_attempts + 1):
            last_result = await self._dig_spiral_staircase(
                block_type,
                max_steps=max_steps,
                scan_radius=scan_radius,
                timeout=timeout,
            )

            if last_result.success:
                return last_result

            if last_result.error_code != "PATH_BLOCKED":
                return last_result

            if last_result.message != "Spiral staircase blocked, no safe step":
                return last_result

            if attempt >= relocate_attempts:
                return last_result

            if not await self._relocate_spiral_start():
                return last_result

        return last_result or ActionResult(
            success=False,
            action="spiral_staircase",
            message="Spiral staircase failed",
            status=ActionStatus.FAILED,
            error_code="PATH_BLOCKED",
        )

    def _yaw_to_spiral_index(self, yaw: float) -> int:
        dx = -math.sin(yaw)
        dz = math.cos(yaw)
        if abs(dx) > abs(dz):
            return 1 if dx > 0 else 3
        return 0 if dz > 0 else 2

    async def _dig_block_at(
        self,
        x: int,
        y: int,
        z: int,
        timeout: float = 6.0,
        allow_hand_break: bool = False,
        max_retries: int = 3,
    ) -> bool:
        """
        Dig a block at the given coordinates with retry logic and view angle adjustment.
        
        Improvements:
        - Moves closer to block if too far away (>4 blocks)
        - Tries multiple view angles (center, top, bottom) on failure
        - Adds debug logging for each failure case
        - Increased default timeout from 4s to 6s
        - Retry mechanism for transient failures
        """
        # First, check if we need to move closer to the block
        pos = self._driver.get_position()
        dx = pos.x - (x + 0.5)
        dy = pos.y - (y + 0.5)
        dz = pos.z - (z + 0.5)
        dist_sq = dx * dx + dy * dy + dz * dz
        
        # Minecraft reach distance is about 4.5 blocks, but for spiral mining
        # we need to be VERY close (almost on top) to fall into the hole
        MAX_REACH_SQ = 1.5 * 1.5  # ~2.25 - must be very close
        
        if dist_sq > MAX_REACH_SQ:
            logger.debug(f"[_dig_block_at] Too far from ({x},{y},{z}), dist={dist_sq**0.5:.2f}, moving closer")
            # Move closer to the block
            try:
                # Create a goal near the block
                goal = self._driver.create_goal_near(x, y, z, reach=2)
                self._driver.set_goal(goal)
                
                # Wait for pathfinder to get us close (max 5 seconds)
                move_start = time.time()
                while time.time() - move_start < 5.0:
                    await asyncio.sleep(0.3)
                    
                    # Check if we're close enough now
                    new_pos = self._driver.get_position()
                    new_dx = new_pos.x - (x + 0.5)
                    new_dy = new_pos.y - (y + 0.5)
                    new_dz = new_pos.z - (z + 0.5)
                    new_dist_sq = new_dx * new_dx + new_dy * new_dy + new_dz * new_dz
                    
                    if new_dist_sq <= MAX_REACH_SQ:
                        logger.debug(f"[_dig_block_at] Moved closer, now dist={new_dist_sq**0.5:.2f}")
                        break
                    
                    # Check if pathfinder stopped
                    if not self._driver.is_moving():
                        break
                
                # Stop pathfinder
                self._driver.stop_pathfinder()
                
            except Exception as e:
                logger.warning(f"[_dig_block_at] Failed to move closer: {e}")
                try:
                    self._driver.stop_pathfinder()
                except Exception:
                    pass
        
        block = self._driver.block_at(self._Vec3(x, y, z))
        if self._is_air_block(block):
            return True
        
        block_name = getattr(block, "name", "unknown")
        
        if not getattr(block, "diggable", True):
            logger.warning(f"[_dig_block_at] Block {block_name} at {x},{y},{z} is not diggable")
            if not allow_hand_break or not self._is_soft_obstacle(block):
                return False

        tool_result = await self._select_best_harvest_tool(block)
        if tool_result and "error" in tool_result:
            logger.warning(f"[_dig_block_at] No suitable tool for {block_name}: {tool_result.get('required', [])}")
            if not allow_hand_break or not self._is_soft_obstacle(block):
                return False
            tool_result = None
            
        if tool_result and "item" in tool_result:
            try:
                best_tool = tool_result["item"]
                await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: self._driver.equip_item(best_tool, "hand")
                    ),
                    timeout=2.5
                )
                logger.debug(f"[_dig_block_at] Equipped {best_tool.name} for {block_name}")
            except Exception as e:
                logger.warning(f"[_dig_block_at] Failed to equip tool: {e}")

        # Calculate timeout based on block type
        actual_timeout = timeout
        if allow_hand_break and not tool_result:
            actual_timeout = max(timeout, 12.0)  # Increased from 10s for hand-breaking
        
        # View angle offsets to try: center, top, bottom, corners
        view_offsets = [
            (0.5, 0.5, 0.5),   # Center
            (0.5, 0.9, 0.5),   # Top center
            (0.5, 0.1, 0.5),   # Bottom center
            (0.2, 0.5, 0.2),   # Corner 1
            (0.8, 0.5, 0.8),   # Corner 2
        ]
        
        for attempt in range(max_retries):
            # Get fresh block reference in case it changed
            block = self._driver.block_at(self._Vec3(x, y, z))
            if self._is_air_block(block):
                return True
            
            # Select view offset based on attempt
            offset_idx = attempt % len(view_offsets)
            ox, oy, oz = view_offsets[offset_idx]
            
            try:
                self._driver.look_at(self._Vec3(x + ox, y + oy, z + oz))
                await asyncio.sleep(0.1)  # Small delay to let view angle settle
            except Exception as e:
                logger.debug(f"[_dig_block_at] look_at failed: {e}")
            
            try:
                await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(
                        None, lambda b=block: self._dig_sync(b)
                    ),
                    timeout=actual_timeout
                )
                # Dig succeeded, verify block is gone
                try:
                    result = await self._wait_for_block_break(x, y, z, block_name, timeout=2.0)
                    if result:
                        return True
                    # Block not gone, will retry
                    logger.debug(f"[_dig_block_at] Block {block_name} still present after dig, retry {attempt+1}")
                except Exception:
                    return True  # Assume success if verification fails
                    
            except asyncio.TimeoutError:
                logger.warning(f"[_dig_block_at] Dig timeout for {block_name} at {x},{y},{z} (attempt {attempt+1}/{max_retries}, offset={offset_idx})")
                # Stop any stuck digging - call bot directly since driver doesn't have this method
                try:
                    if hasattr(self._driver, '_bot') and hasattr(self._driver._bot, 'stopDigging'):
                        self._driver._bot.stopDigging()
                except Exception:
                    pass
                await asyncio.sleep(0.2)
                
            except Exception as e:
                logger.warning(f"[_dig_block_at] Dig failed for {block_name} at {x},{y},{z}: {e} (attempt {attempt+1}/{max_retries})")
                await asyncio.sleep(0.2)
        
        # All retries exhausted
        logger.error(f"[_dig_block_at] Failed to dig {block_name} at {x},{y},{z} after {max_retries} attempts")
        return False

    async def _step_to(self, x: int, y: int, z: int, duration: float = 0.6, max_retries: int = 3) -> bool:
        """
        Step to a nearby position with retry logic.
        
        Improvements:
        - Retries up to max_retries times with increasing duration
        - Relaxed distance tolerance (1.5 blocks instead of 0.9)
        - Debug logging for failures
        """
        try:
            self._driver.stop_pathfinder()
        except Exception:
            pass

        for attempt in range(max_retries):
            pos_before = self._driver.get_position()
            
            try:
                self._driver.look_at(self._Vec3(x + 0.5, y + 1.2, z + 0.5))
            except Exception:
                pass

            descending = y < (pos_before.y - 0.1)
            jump = y > (pos_before.y + 0.2)
            
            # Adjust duration based on retry attempt
            current_duration = duration * (1 + attempt * 0.3)  # Increase duration on retries
            
            try:
                if not descending:
                    self._driver.set_control_state("sneak", True)
            except Exception:
                pass
                
            try:
                self._driver.set_control_state("forward", True)
                if jump:
                    self._driver.set_control_state("jump", True)
                await asyncio.sleep(max(current_duration, 0.9 if descending else current_duration))
            finally:
                try:
                    self._driver.set_control_state("forward", False)
                    self._driver.set_control_state("jump", False)
                    self._driver.set_control_state("sneak", False)
                except Exception:
                    pass

            pos_after = self._driver.get_position()
            dx = pos_after.x - x
            dy = pos_after.y - y
            dz = pos_after.z - z
            dist_sq = dx * dx + dy * dy + dz * dz
            
            # Relaxed tolerance: 1.5 blocks (was 0.9)
            if dist_sq <= 2.25:  # 1.5^2 = 2.25
                return True
            
            # Log the failure
            logger.debug(f"[_step_to] Attempt {attempt+1}/{max_retries}: target=({x},{y},{z}), actual=({pos_after.x:.1f},{pos_after.y:.1f},{pos_after.z:.1f}), dist={dist_sq**0.5:.2f}")
            
            # Small wait before retry
            await asyncio.sleep(0.2)
        
        logger.warning(f"[_step_to] Failed to reach ({x},{y},{z}) after {max_retries} attempts")
        return False

    async def _wait_for_drop(self, target_y: int, timeout: float = 1.2, max_nudge_attempts: int = 5) -> bool:
        """
        Wait for bot to drop to target Y level, actively nudging if needed.
        
        Args:
            target_y: Target Y coordinate to reach
            timeout: Timeout for each drop check
            max_nudge_attempts: Maximum number of forward nudge attempts
        """
        start = time.time()
        
        # First check if we're already at target
        for _ in range(int(timeout / 0.1)):
            pos = self._driver.get_position()
            if pos.y <= target_y + 0.1:
                return True
            await asyncio.sleep(0.1)
        
        # If not dropped, try nudging forward multiple times
        for nudge in range(max_nudge_attempts):
            try:
                # Nudge forward with increasing duration
                nudge_duration = 0.2 + (nudge * 0.1)  # 0.2, 0.3, 0.4, 0.5, 0.6 seconds
                
                self._driver.set_control_state("sneak", False)  # Disable sneak to move faster
                self._driver.set_control_state("forward", True)
                await asyncio.sleep(nudge_duration)
                self._driver.set_control_state("forward", False)
                
                # Check if we dropped
                await asyncio.sleep(0.3)  # Wait for gravity
                pos = self._driver.get_position()
                if pos.y <= target_y + 0.1:
                    logger.debug(f"[_wait_for_drop] Dropped after nudge {nudge+1}")
                    return True
                    
            except Exception as e:
                logger.debug(f"[_wait_for_drop] Nudge failed: {e}")
            finally:
                try:
                    self._driver.set_control_state("forward", False)
                except Exception:
                    pass
        
        logger.warning(f"[_wait_for_drop] Failed to drop to Y={target_y} after {max_nudge_attempts} nudges")
        return False

    async def _dig_spiral_staircase(
        self,
        target_block: str,
        max_steps: int = 16,
        scan_radius: int = 16,
        timeout: float = 60.0
    ) -> ActionResult:
        start_time = time.time()
        
        # Map dropped item to actual block in ground
        # When looking for cobblestone as a drop, we need to find stone blocks
        search_block = target_block
        if target_block == "cobblestone":
            search_block = "stone"
        elif target_block == "charcoal":
            search_block = "coal_ore"  # charcoal comes from smelting, but just in case
            
        target_id = self._driver.get_block_id(search_block)
        logger.debug(f"[spiral] Searching for {search_block} (target={target_block}), id={target_id}")
        
        if target_id is None:
            return ActionResult(
                success=False,
                action="spiral_staircase",
                message=f"Unknown block type: {search_block}",
                status=ActionStatus.FAILED,
                error_code="UNKNOWN_BLOCK"
            )

        pos = self._driver.get_position()
        cx, cy, cz = int(pos.x), int(pos.y), int(pos.z)
        dir_index = self._yaw_to_spiral_index(self._driver.get_yaw())

        dirs = [
            (0, 0, 1),   # south
            (1, 0, 0),   # east
            (0, 0, -1),  # north
            (-1, 0, 0),  # west
        ]

        for step in range(max_steps):
            if time.time() - start_time > timeout:
                break

            if scan_radius and scan_radius > 0:
                found = self._find_nearest_block(target_id, self._Vec3(cx, cy, cz), scan_radius)
                if found:
                    return ActionResult(
                        success=True,
                        action="spiral_staircase",
                        message=f"Found {target_block} while descending",
                        status=ActionStatus.SUCCESS,
                        data={
                            "found": True,
                            "position": {
                                "x": int(found.position.x),
                                "y": int(found.position.y),
                                "z": int(found.position.z)
                            },
                            "steps": step
                        }
                    )

            idx = dir_index
            dx, _, dz = dirs[idx]
            nx, ny, nz = cx + dx, cy, cz + dz

            head_block = self._driver.block_at(self._Vec3(nx, ny + 1, nz))
            body_block = self._driver.block_at(self._Vec3(nx, ny, nz))
            below_block = self._driver.block_at(self._Vec3(nx, ny - 1, nz))
            support_block = self._driver.block_at(self._Vec3(nx, ny - 2, nz))

            if self._is_hazard_block(head_block) or self._is_hazard_block(body_block):
                return ActionResult(
                    success=False,
                    action="spiral_staircase",
                    message="Spiral staircase blocked, hazard ahead",
                    status=ActionStatus.FAILED,
                    error_code="PATH_BLOCKED",
                    data={"steps": step}
                )
            if self._is_hazard_block(below_block) or self._is_hazard_block(support_block):
                return ActionResult(
                    success=False,
                    action="spiral_staircase",
                    message="Spiral staircase blocked, hazard below",
                    status=ActionStatus.FAILED,
                    error_code="PATH_BLOCKED",
                    data={"steps": step}
                )

            if self._is_air_block(support_block):
                scaffold_item = self._find_scaffold_item()
                placed = await self._place_block_at(nx, ny - 2, nz, scaffold_item)
                if not placed:
                    return ActionResult(
                        success=False,
                        action="spiral_staircase",
                        message="Spiral staircase blocked, no support",
                        status=ActionStatus.FAILED,
                        error_code="PATH_BLOCKED",
                        data={"steps": step}
                    )

            if not await self._dig_block_at(nx, ny + 1, nz, allow_hand_break=True):
                return ActionResult(
                    success=False,
                    action="spiral_staircase",
                    message="Spiral staircase blocked, cannot clear head",
                    status=ActionStatus.FAILED,
                    error_code="PATH_BLOCKED",
                    data={"steps": step}
                )
            if not await self._dig_block_at(nx, ny, nz, allow_hand_break=True):
                return ActionResult(
                    success=False,
                    action="spiral_staircase",
                    message="Spiral staircase blocked, cannot clear body",
                    status=ActionStatus.FAILED,
                    error_code="PATH_BLOCKED",
                    data={"steps": step}
                )
            if not await self._dig_block_at(nx, ny - 1, nz, allow_hand_break=True):
                return ActionResult(
                    success=False,
                    action="spiral_staircase",
                    message="Spiral staircase blocked, cannot clear descent",
                    status=ActionStatus.FAILED,
                    error_code="PATH_BLOCKED",
                    data={"steps": step}
                )

            # After digging all 3 blocks, move bot directly into the hole using pathfinder
            # This is more reliable than step + nudge because pathfinder navigates properly
            logger.debug(f"[spiral] Moving into hole at ({nx},{ny-1},{nz})")
            
            descent_success = False
            for descent_attempt in range(3):
                try:
                    # Create goal to move directly into the hole (ny-1 is the bottom of the hole)
                    goal = self._driver.create_goal_near(nx, ny - 1, nz, reach=1)
                    self._driver.set_goal(goal)
                    
                    move_start = time.time()
                    while time.time() - move_start < 5.0:
                        await asyncio.sleep(0.3)
                        
                        # Check if we've dropped into the hole
                        pos = self._driver.get_position()
                        if pos.y <= ny - 0.5:  # Successfully dropped
                            descent_success = True
                            break
                        
                        if not self._driver.is_moving():
                            break
                    
                    self._driver.stop_pathfinder()
                    
                    if descent_success:
                        break
                        
                    # If not in hole yet, try a forward nudge
                    self._driver.look_at(self._Vec3(nx + 0.5, ny, nz + 0.5))
                    self._driver.set_control_state("forward", True)
                    await asyncio.sleep(0.5)
                    self._driver.set_control_state("forward", False)
                    await asyncio.sleep(0.3)
                    
                    pos = self._driver.get_position()
                    if pos.y <= ny - 0.5:
                        descent_success = True
                        break
                        
                except Exception as e:
                    logger.debug(f"[spiral] Descent attempt {descent_attempt+1} failed: {e}")
                    try:
                        self._driver.stop_pathfinder()
                        self._driver.set_control_state("forward", False)
                    except Exception:
                        pass
            
            if not descent_success:
                # Final check - maybe we're already in the hole
                pos = self._driver.get_position()
                if pos.y > ny - 0.5:
                    # Instead of giving up, try a different direction
                    logger.warning(f"[spiral] Descent failed at step {step}, trying different direction")
                    dir_index = (idx + 1) % 4  # Switch to next direction
                    
                    # Track consecutive failures
                    if not hasattr(self, '_spiral_fail_count'):
                        self._spiral_fail_count = 0
                    self._spiral_fail_count += 1
                    
                    if self._spiral_fail_count >= 4:  # Tried all 4 directions
                        self._spiral_fail_count = 0
                        return ActionResult(
                            success=False,
                            action="spiral_staircase",
                            message="Spiral staircase blocked, drop failed after trying all directions",
                            status=ActionStatus.FAILED,
                            error_code="PATH_BLOCKED",
                            data={"steps": step}
                        )
                    continue  # Try next iteration with new direction
                    
            # Success - reset fail counter
            if hasattr(self, '_spiral_fail_count'):
                self._spiral_fail_count = 0

            pos = self._driver.get_position()
            cx, cy, cz = int(pos.x), int(pos.y), int(pos.z)
            dir_index = (idx + 1) % 4

        return ActionResult(
            success=False,
            action="spiral_staircase",
            message=f"Spiral staircase depth limit reached ({max_steps} steps)",
            status=ActionStatus.TIMEOUT,
            error_code="TIMEOUT",
            data={"steps": max_steps},
            duration_ms=int((time.time() - start_time) * 1000)
        )

    async def mine(
        self,
        block_type: str,
        count: int = 1,
        timeout: float = 120.0,
        near_position: dict = None,
        search_radius: int = 64
    ) -> ActionResult:
        start_time = time.time()
        collected = {}

        self._progress_timer = ProgressTimer(timeout_seconds=30.0)

        if near_position:
            search_center = self._Vec3(near_position["x"], near_position["y"], near_position["z"])
        else:
            search_center = self._driver.get_position()

        try:
            block_id = self._driver.get_block_id(block_type)
            if block_id is None:
                return ActionResult(
                    success=False,
                    action="mine",
                    message=f"未知的方块类型: {block_type}",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )
            remaining = count if count > 0 else float("inf")
            unlimited_mode = (count <= 0)
            last_location = None

            while remaining > 0:
                if time.time() - start_time > timeout:
                    return ActionResult(
                        success=False,
                        action="mine",
                        message=(
                            f"采集 {block_type} 超时 (硬限制)，已采集 {count - remaining}/{count}"
                        ),
                        status=ActionStatus.TIMEOUT,
                        error_code="TIMEOUT",
                        data={"collected": collected},
                        duration_ms=int((time.time() - start_time) * 1000)
                    )

                if self._progress_timer.is_expired():
                    return ActionResult(
                        success=False,
                        action="mine",
                        message=(
                            f"采集 {block_type} 30秒无进度，已采集 {count - remaining}/{count}"
                        ),
                        status=ActionStatus.TIMEOUT,
                        error_code="NO_PROGRESS",
                        data={
                            "collected": collected,
                            "progress_count": self._progress_timer.progress_count
                        },
                        duration_ms=int((time.time() - start_time) * 1000)
                    )

                target_block = self._find_nearest_block(
                    block_id,
                    search_center,
                    search_radius
                )

                if not target_block:
                    if self._is_underground_target(block_type):
                        inventory_before_spiral = self._inventory.get_inventory_count(block_type)
                        spiral_steps = 16
                        spiral_scan_radius = 0
                        spiral_result = await self._attempt_spiral_descent(
                            block_type,
                            max_steps=spiral_steps,
                            scan_radius=spiral_scan_radius,
                            timeout=min(60.0, timeout)
                        )
                        inventory_after_spiral = self._inventory.get_inventory_count(block_type)
                        spiral_delta = inventory_after_spiral - inventory_before_spiral
                        if spiral_delta > 0:
                            collected[block_type] = collected.get(block_type, 0) + spiral_delta
                            remaining -= spiral_delta
                            self._progress_timer.reset("spiral_collect")
                            if remaining <= 0:
                                break

                        if spiral_result.success:
                            search_center = self._driver.get_position()
                            continue
                        if unlimited_mode:
                            break
                        return ActionResult(
                            success=False,
                            action="mine",
                            message=spiral_result.message,
                            status=ActionStatus.FAILED,
                            error_code=spiral_result.error_code or "TARGET_NOT_FOUND"
                        )
                    if unlimited_mode:
                        break
                    if collected.get(block_type, 0) == 0:
                        return ActionResult(
                            success=False,
                            action="mine",
                            message=f"附近找不到 {block_type}",
                            status=ActionStatus.FAILED,
                            error_code="TARGET_NOT_FOUND"
                        )
                    break

                if self._should_spiral_to_target(block_type, target_block):
                    inventory_before_spiral = self._inventory.get_inventory_count(block_type)
                    spiral_scan_radius = 0
                    spiral_steps = self._spiral_steps_to_target(target_block, max_steps=24)
                    spiral_result = await self._attempt_spiral_descent(
                        block_type,
                        max_steps=spiral_steps,
                        scan_radius=spiral_scan_radius,
                        timeout=min(60.0, timeout)
                    )
                    inventory_after_spiral = self._inventory.get_inventory_count(block_type)
                    spiral_delta = inventory_after_spiral - inventory_before_spiral
                    if spiral_delta > 0:
                        collected[block_type] = collected.get(block_type, 0) + spiral_delta
                        remaining -= spiral_delta
                        self._progress_timer.reset("spiral_collect")
                        if remaining <= 0:
                            break

                    if spiral_result.success:
                        search_center = self._driver.get_position()
                        continue
                    if unlimited_mode:
                        break
                    return ActionResult(
                        success=False,
                        action="mine",
                        message=spiral_result.message,
                        status=ActionStatus.FAILED,
                        error_code=spiral_result.error_code or "PATH_BLOCKED"
                    )

                last_location = [
                    int(target_block.position.x),
                    int(target_block.position.y),
                    int(target_block.position.z)
                ]

                inventory_before = self._inventory.get_inventory_count(block_type)

                tool_result = await self._select_best_harvest_tool(target_block)

                if tool_result and "error" in tool_result:
                    required_tools = tool_result.get("required", ["pickaxe"])
                    tool_type, min_tier = self._infer_tool_requirements(required_tools)
                    return ActionResult(
                        success=False,
                        action="mine",
                        message=(
                            f"无法采集 {block_type}：需要合适的工具 (如 {', '.join(required_tools[:3])})"
                        ),
                        status=ActionStatus.FAILED,
                        error_code="NO_TOOL",
                        data={
                            "block": block_type,
                            "required_tools": required_tools,
                            "tool_type": tool_type,
                            "min_tier": min_tier,
                            "hint": "建议先合成或获取合适的工具"
                        },
                        duration_ms=int((time.time() - start_time) * 1000)
                    )

                if tool_result and "item" in tool_result:
                    try:
                        best_tool = tool_result["item"]
                        await asyncio.wait_for(
                            asyncio.get_event_loop().run_in_executor(
                                None,
                                lambda: self._driver.equip_item(best_tool, "hand")
                            ),
                            timeout=3.0
                        )
                        self._progress_timer.reset("tool_equipped")
                        logger.info(f"Equipped {best_tool.name} for mining {block_type}")
                    except Exception as e:
                        logger.warning(f"Failed to equip tool: {e}")

                collect_done = False
                collect_error = None

                def do_collect():
                    nonlocal collect_done, collect_error
                    try:
                        if self._background.shutdown_requested:
                            return
                        self._driver.collect_block(target_block)
                        collect_done = True
                    except Exception as e:
                        collect_error = e

                import threading
                collect_thread = threading.Thread(
                    target=do_collect,
                    daemon=True,
                    name=f"collect_{block_type}"
                )
                self._background.track_thread(collect_thread)
                collect_thread.start()

                last_inventory_check = inventory_before
                while not collect_done and collect_error is None:
                    await asyncio.sleep(1.0)

                    try:
                        current_inventory = self._inventory.get_inventory_count(block_type)
                        if current_inventory > last_inventory_check:
                            self._progress_timer.reset("inventory_changed")
                            last_inventory_check = current_inventory
                            logger.debug(f"Inventory increased: {current_inventory}")
                    except Exception:
                        pass

                    if self._progress_timer.is_expired():
                        logger.warning("No inventory progress for 30s during collect")
                        break

                    if time.time() - start_time > timeout:
                        break

                inventory_after = self._inventory.get_inventory_count(block_type)
                actually_collected = inventory_after - inventory_before

                if actually_collected > 0:
                    collected[block_type] = collected.get(block_type, 0) + actually_collected
                    remaining -= actually_collected
                    self._progress_timer.reset("inventory_increased")
                    logger.info(f"Collected {actually_collected} {block_type}, remaining: {remaining}")
                elif collect_done:
                    collected[block_type] = collected.get(block_type, 0) + 1
                    remaining -= 1
                    self._progress_timer.reset("collect_completed")
                    logger.info(f"Collect reported done for {block_type}, remaining: {remaining}")
                elif collect_error:
                    logger.warning(f"Collect error: {collect_error}")
                    await asyncio.sleep(0.5)

            total_collected = collected.get(block_type, 0)
            if unlimited_mode:
                msg = f"采集完成！共采集 {total_collected} 个 {block_type}"
            else:
                msg = f"成功采集 {total_collected} 个 {block_type}"

            return ActionResult(
                success=True,
                action="mine",
                message=msg,
                status=ActionStatus.SUCCESS,
                data={
                    "collected": collected,
                    "location": last_location,
                    "progress_events": self._progress_timer.progress_count,
                    "unlimited_mode": unlimited_mode
                },
                duration_ms=int((time.time() - start_time) * 1000)
            )

        except Exception as e:
            logger.error(f"mine failed: {e}")
            return ActionResult(
                success=False,
                action="mine",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                data={"collected": collected},
                duration_ms=int((time.time() - start_time) * 1000)
            )


    async def mine_tree(
        self,
        near_position: dict = None,
        search_radius: int = 32,
        timeout: float = 120.0
    ) -> ActionResult:
        start_time = time.time()

        LOG_TYPES = [
            "oak_log", "birch_log", "spruce_log", "jungle_log",
            "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log"
        ]

        try:
            if near_position:
                search_center = {
                    "x": int(near_position.get("x", 0)),
                    "y": int(near_position.get("y", 64)),
                    "z": int(near_position.get("z", 0))
                }
            else:
                pos = self._driver.get_position()
                search_center = {"x": int(pos.x), "y": int(pos.y), "z": int(pos.z)}
            search_point = self._Vec3(search_center["x"], search_center["y"], search_center["z"])

            logger.info(f"[mine_tree] Searching for tree near {search_center}, radius={search_radius}")

            first_log = None
            first_log_type = None

            for log_type in LOG_TYPES:
                try:
                    block_id = self._driver.get_block_id(log_type)
                    if block_id is not None:
                        block = self._driver.find_block({
                            "matching": block_id,
                            "maxDistance": search_radius,
                            "point": search_point
                        })
                        if block:
                            if first_log is None:
                                first_log = block
                                first_log_type = log_type
                            else:
                                dist_new = (
                                    (block.position.x - search_center["x"]) ** 2 +
                                    (block.position.y - search_center["y"]) ** 2 +
                                    (block.position.z - search_center["z"]) ** 2
                                )
                                dist_old = (
                                    (first_log.position.x - search_center["x"]) ** 2 +
                                    (first_log.position.y - search_center["y"]) ** 2 +
                                    (first_log.position.z - search_center["z"]) ** 2
                                )
                                if dist_new < dist_old:
                                    first_log = block
                                    first_log_type = log_type
                except Exception:
                    continue

            if not first_log:
                return ActionResult(
                    success=False,
                    action="mine_tree",
                    message=f"附近 {search_radius} 格内没有找到树",
                    status=ActionStatus.FAILED,
                    error_code="NO_TARGET"
                )

            tree_logs = self._find_connected_logs(first_log, first_log_type)
            logger.info(f"[mine_tree] Found tree with {len(tree_logs)} logs of type {first_log_type}")

            if not tree_logs:
                return ActionResult(
                    success=False,
                    action="mine_tree",
                    message="无法识别树的结构",
                    status=ActionStatus.FAILED,
                    error_code="TREE_SCAN_FAILED"
                )

            tree_logs.sort(key=lambda pos: pos[1])

            try:
                bot_pos = self._driver.get_position()
                tx, ty, tz = tree_logs[0]
                dist = ((bot_pos.x - tx) ** 2 + (bot_pos.y - ty) ** 2 + (bot_pos.z - tz) ** 2) ** 0.5
                if dist > 5.0:
                    await self._movement.navigate_to_block(tx, ty, tz)
                    await asyncio.sleep(0.3)
            except Exception:
                pass

            collected = 0
            failed = 0

            max_collect_retries = 3

            for log_pos in tree_logs:
                if time.time() - start_time > timeout:
                    logger.warning(f"[mine_tree] Timeout after collecting {collected} logs")
                    break

                x, y, z = log_pos

                try:
                    block = self._driver.block_at(self._Vec3(x, y, z))
                    if not block or block.name != first_log_type:
                        logger.debug(
                            f"[mine_tree] Block at ({x},{y},{z}) is no longer {first_log_type}, skipping"
                        )
                        continue
                except Exception as e:
                    logger.debug(f"[mine_tree] Error checking block at ({x},{y},{z}): {e}")
                    continue

                bot_pos = self._driver.get_position()
                distance = (
                    (bot_pos.x - x) ** 2 +
                    (bot_pos.y - y) ** 2 +
                    (bot_pos.z - z) ** 2
                ) ** 0.5

                try:
                    last_err = None
                    mined_this_log = False
                    inventory_before = self._inventory.get_inventory_count(first_log_type)

                    import threading

                    for attempt in range(1, max_collect_retries + 1):
                        block = self._driver.block_at(self._Vec3(x, y, z))
                        if not block or block.name != first_log_type:
                            mined_this_log = True
                            break

                        bot_pos = self._driver.get_position()
                        distance = (
                            (bot_pos.x - x) ** 2 +
                            (bot_pos.y - y) ** 2 +
                            (bot_pos.z - z) ** 2
                        ) ** 0.5

                        dig_attempted = False
                        if distance <= 5.0:
                            logger.debug(
                                f"[mine_tree] Direct dig at ({x},{y},{z}), distance={distance:.1f}"
                            )
                            dig_attempted = True
                            try:
                                try:
                                    self._equip_axe_sync()
                                except Exception:
                                    pass

                                dig_done = False
                                dig_error = None

                                def do_dig():
                                    nonlocal dig_done, dig_error
                                    try:
                                        if self._background.shutdown_requested:
                                            return
                                        self._dig_sync(block)
                                        dig_done = True
                                    except Exception as e:
                                        dig_error = e

                                dig_thread = threading.Thread(
                                    target=do_dig,
                                    daemon=True,
                                    name=f"dig_{x}_{y}_{z}"
                                )
                                self._background.track_thread(dig_thread)
                                dig_thread.start()

                                dig_start = time.time()
                                while not dig_done and dig_error is None and (time.time() - dig_start < 10):
                                    await asyncio.sleep(0.3)

                                if await self._wait_for_block_break(x, y, z, first_log_type, timeout=2.0):
                                    collected += 1
                                    mined_this_log = True
                                    logger.debug(
                                        f"[mine_tree] Successfully dug log at ({x},{y},{z})"
                                    )
                                    break
                                logger.debug(
                                    f"[mine_tree] Dig completed but block still exists at ({x},{y},{z}) - moving closer"
                                )
                                dig_attempted = False

                                if dig_error:
                                    last_err = dig_error
                                    logger.debug(f"[mine_tree] Dig error at ({x},{y},{z}): {dig_error}")

                            except Exception as e:
                                last_err = e
                                logger.debug(f"[mine_tree] Direct dig failed at ({x},{y},{z}): {e}")

                        if not mined_this_log:
                            logger.debug(
                                f"[mine_tree] Need to move closer to ({x},{y},{z}), "
                                f"distance={distance:.1f}, dig_attempted={dig_attempted}"
                            )
                            try:
                                try:
                                    self._driver.stop_pathfinder()
                                except Exception:
                                    pass

                                await self._movement.navigate_to_block(x, y, z)
                                await asyncio.sleep(0.3)

                                block = self._driver.block_at(self._Vec3(x, y, z))
                                if block and block.name == first_log_type:
                                    try:
                                        self._equip_axe_sync()
                                    except Exception:
                                        pass

                                    dig_done = False
                                    dig_error = None

                                    def do_dig2():
                                        nonlocal dig_done, dig_error
                                        try:
                                            if self._background.shutdown_requested:
                                                return
                                            self._dig_sync(block)
                                            dig_done = True
                                        except Exception as e:
                                            dig_error = e

                                    dig_thread = threading.Thread(
                                        target=do_dig2,
                                        daemon=True,
                                        name=f"dig2_{x}_{y}_{z}"
                                    )
                                    self._background.track_thread(dig_thread)
                                    dig_thread.start()

                                    dig_start = time.time()
                                    while not dig_done and dig_error is None and (time.time() - dig_start < 10):
                                        await asyncio.sleep(0.3)

                                    if dig_done:
                                        if await self._wait_for_block_break(x, y, z, first_log_type, timeout=2.0):
                                            collected += 1
                                            mined_this_log = True
                                            break

                                    if dig_error:
                                        last_err = dig_error

                            except Exception as e:
                                last_err = e
                                logger.debug(f"[mine_tree] Move+dig failed at ({x},{y},{z}): {e}")

                        if mined_this_log:
                            break

                        if attempt < max_collect_retries:
                            await asyncio.sleep(0.5 * attempt)

                    if not mined_this_log:
                        failed += 1
                        if last_err is not None:
                            logger.warning(
                                f"[mine_tree] Failed to mine log at ({x},{y},{z}) after retries: {last_err}"
                            )
                        else:
                            logger.warning(
                                f"[mine_tree] Failed to mine log at ({x},{y},{z}) after retries: block still present"
                            )

                except Exception as e:
                    logger.warning(f"[mine_tree] Failed to mine log at ({x},{y},{z}): {e}")
                    failed += 1

            logger.info("[mine_tree] Waiting for falling logs and items...")
            await asyncio.sleep(1.0)

            try:
                pickup_count = 0
                logger.info("[mine_tree] Searching for dropped items...")

                for attempt in range(3):
                    items_to_pickup = []
                    try:
                        bot_pos = self._driver.get_position()
                        total_entities = 0
                        item_entities = 0

                        for entity_id, entity in self._driver.get_entities().items():
                            total_entities += 1

                            if entity.name == "item":
                                item_entities += 1
                                try:
                                    e_pos = entity.position
                                    dist = (
                                        (e_pos.x - bot_pos.x) ** 2 +
                                        (e_pos.y - bot_pos.y) ** 2 +
                                        (e_pos.z - bot_pos.z) ** 2
                                    ) ** 0.5
                                    if dist <= 16:
                                        items_to_pickup.append((dist, e_pos))
                                        logger.debug(
                                            f"[mine_tree] Found item entity at distance {dist:.1f}"
                                        )
                                except Exception as e:
                                    logger.debug(f"[mine_tree] Error checking item entity: {e}")

                        logger.info(
                            f"[mine_tree] Attempt {attempt + 1}: Found {total_entities} entities, "
                            f"{item_entities} items, {len(items_to_pickup)} within range"
                        )

                    except Exception as e:
                        logger.warning(f"[mine_tree] Error finding dropped items: {e}")

                    if not items_to_pickup:
                        logger.info("[mine_tree] No items to pickup, stopping search")
                        break

                    items_to_pickup.sort(key=lambda x: x[0])
                    nearest = items_to_pickup[0][1]

                    logger.info(
                        f"[mine_tree] Moving to pickup items at "
                        f"({nearest.x:.1f},{nearest.y:.1f},{nearest.z:.1f})"
                    )

                    try:
                        await self._movement.goto(
                            target=f"{int(nearest.x)},{int(nearest.y)},{int(nearest.z)}",
                            timeout=5.0
                        )
                        pickup_count += 1
                        await asyncio.sleep(0.5)
                    except Exception as e:
                        logger.warning(f"[mine_tree] Failed to pickup items: {e}")
                        break

                if pickup_count > 0:
                    logger.info(f"[mine_tree] Picked up items from {pickup_count} locations")
                else:
                    logger.info("[mine_tree] No items were picked up")

            except Exception as e:
                logger.warning(f"[mine_tree] Error in item pickup phase: {e}")

            msg = f"砍树完成！共砍掉 {collected} 个 {first_log_type}"
            if failed > 0:
                msg += f"（{failed} 个失败）"

            return ActionResult(
                success=collected > 0,
                action="mine_tree",
                message=msg,
                status=ActionStatus.SUCCESS if collected > 0 else ActionStatus.FAILED,
                data={
                    "collected": collected,
                    "failed": failed,
                    "log_type": first_log_type,
                    "tree_size": len(tree_logs)
                },
                duration_ms=int((time.time() - start_time) * 1000)
            )

        except Exception as e:
            logger.error(f"mine_tree failed: {e}")
            return ActionResult(
                success=False,
                action="mine_tree",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                duration_ms=int((time.time() - start_time) * 1000)
            )

    def _find_connected_logs(self, start_block, log_type: str) -> list:
        from collections import deque

        visited = set()
        tree_logs = []
        queue = deque()

        start_pos = (
            int(start_block.position.x),
            int(start_block.position.y),
            int(start_block.position.z)
        )
        queue.append(start_pos)
        visited.add(start_pos)

        base_directions = [
            (0, 1, 0),
            (0, -1, 0),
            (1, 0, 0),
            (-1, 0, 0),
            (0, 0, 1),
            (0, 0, -1),
        ]
        diagonal_up_directions = [
            (1, 1, 0), (-1, 1, 0), (0, 1, 1), (0, 1, -1),
            (1, 1, 1), (-1, 1, 1), (1, 1, -1), (-1, 1, -1),
        ]

        log_block_id = self._driver.get_block_id(log_type)
        if log_block_id is None:
            return [start_pos]

        while queue:
            x, y, z = queue.popleft()
            tree_logs.append((x, y, z))

            all_directions = base_directions + diagonal_up_directions
            for dx, dy, dz in all_directions:
                nx, ny, nz = x + dx, y + dy, z + dz

                if (nx, ny, nz) in visited:
                    continue

                if abs(nx - start_pos[0]) > 5 or abs(nz - start_pos[2]) > 5:
                    continue
                if ny < start_pos[1] - 3 or ny > start_pos[1] + 30:
                    continue

                visited.add((nx, ny, nz))

                try:
                    block = self._driver.block_at(self._Vec3(nx, ny, nz))
                    if block and block.type == log_block_id:
                        queue.append((nx, ny, nz))
                except Exception:
                    continue

        return tree_logs

    async def _wait_for_block_break(
        self,
        x: int,
        y: int,
        z: int,
        expected_name: str,
        timeout: float = 2.0
    ) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                block = self._driver.block_at(self._Vec3(x, y, z))
            except Exception:
                block = None
            if block is not None and block.name != expected_name:
                return True
            await asyncio.sleep(0.2)
        return False

    async def expose_underground(
        self,
        target_block: str,
        max_depth: int = 5,
        timeout: float = 60.0
    ) -> ActionResult:
        """
        暴露地下方块
        
        安全地向前下方挖掘，直到目标方块出现在感知范围内。
        遵循 Minecraft 生存法则：不挖脚下的方块，而是挖前方的方块。
        
        Args:
            target_block: 目标方块类型（如 cobblestone, iron_ore）
            max_depth: 最大挖掘深度
            timeout: 超时时间
            
        Returns:
            ActionResult: 成功时表示目标方块已暴露
        """
        start_time = time.time()
        logger.info(f"[expose_underground] Starting to expose {target_block}, max_depth={max_depth}")
        
        try:
            # 获取目标方块 ID
            block_id = self._driver.get_block_id(target_block)
            if block_id is None:
                return ActionResult(
                    success=False,
                    action="expose_underground",
                    message=f"未知方块类型: {target_block}",
                    status=ActionStatus.FAILED,
                    error_code="UNKNOWN_BLOCK"
                )
            target_block_id = block_id
            
            # 获取当前位置
            pos = self._driver.get_position()
            bot_x, bot_y, bot_z = int(pos.x), int(pos.y), int(pos.z)
            
            # 获取机器人朝向，确定"前方"位置
            yaw = self._driver.get_yaw()
            import math
            # 朝向向量
            dx = -math.sin(yaw)
            dz = math.cos(yaw)
            # 选择前方 1 格的位置
            front_x = bot_x + int(round(dx))
            front_z = bot_z + int(round(dz))
            
            logger.debug(f"[expose_underground] Bot at ({bot_x}, {bot_y}, {bot_z}), digging at ({front_x}, *, {front_z})")
            
            # 先检查目标方块是否已经可见
            existing = self._find_nearest_block(target_block_id, pos, 32)
            if existing:
                logger.info(f"[expose_underground] {target_block} already visible at {existing.position}")
                return ActionResult(
                    success=True,
                    action="expose_underground",
                    message=f"目标方块 {target_block} 已经可见",
                    status=ActionStatus.SUCCESS,
                    data={"position": {"x": int(existing.position.x), "y": int(existing.position.y), "z": int(existing.position.z)}}
                )
            
            # 开始向下挖掘（前方位置）
            dug_count = 0
            for depth in range(1, max_depth + 1):
                if time.time() - start_time > timeout:
                    break
                
                dig_y = bot_y - depth
                
                # 挖掘两格宽：前方和前方+1（形成阶梯洞口，方便观察和安全）
                for dx_offset in [0, 1]:
                    dig_x = front_x + dx_offset
                    
                    block = self._driver.block_at(self._Vec3(dig_x, dig_y, front_z))
                    if not block or block.name in ("air", "cave_air", "water", "lava"):
                        continue
                    
                    # 危险检测：如果下方是岩浆，停止
                    below = self._driver.block_at(self._Vec3(dig_x, dig_y - 1, front_z))
                    if below and below.name == "lava":
                        logger.warning(f"[expose_underground] Lava detected at ({dig_x}, {dig_y-1}, {front_z}), stopping")
                        return ActionResult(
                            success=False,
                            action="expose_underground",
                            message="检测到岩浆，停止挖掘",
                            status=ActionStatus.PARTIAL,
                            error_code="DANGER_DETECTED",
                            data={"depth": depth, "dug": dug_count}
                        )
                    
                    # 选择最佳工具
                    await self._select_best_harvest_tool(block)
                    
                    # 挖掘
                    try:
                        await asyncio.wait_for(
                            asyncio.get_event_loop().run_in_executor(
                                None, lambda b=block: self._dig_sync(b)
                            ),
                            timeout=5.0
                        )
                        dug_count += 1
                        logger.debug(f"[expose_underground] Dug {block.name} at ({dig_x}, {dig_y}, {front_z})")
                    except asyncio.TimeoutError:
                        logger.warning(f"[expose_underground] Dig timeout at ({dig_x}, {dig_y}, {front_z})")
                    except Exception as e:
                        logger.warning(f"[expose_underground] Dig error: {e}")
                    
                    await asyncio.sleep(0.1)
                
                # 每挖一层后检查目标方块是否可见
                await asyncio.sleep(0.2)
                found = self._find_nearest_block(target_block_id, pos, 32)
                if found:
                    logger.info(f"[expose_underground] ✅ Found {target_block} at {found.position} after digging {dug_count} blocks")
                    return ActionResult(
                        success=True,
                        action="expose_underground",
                        message=f"成功暴露 {target_block}",
                        status=ActionStatus.SUCCESS,
                        data={
                            "position": {"x": int(found.position.x), "y": int(found.position.y), "z": int(found.position.z)},
                            "depth": depth,
                            "dug": dug_count
                        },
                        duration_ms=int((time.time() - start_time) * 1000)
                    )
            
            # 达到最大深度仍未找到
            return ActionResult(
                success=False,
                action="expose_underground",
                message=f"挖掘 {max_depth} 层后仍未找到 {target_block}",
                status=ActionStatus.PARTIAL,
                error_code="TARGET_NOT_FOUND",
                data={"depth": max_depth, "dug": dug_count},
                duration_ms=int((time.time() - start_time) * 1000)
            )
            
        except Exception as e:
            logger.error(f"[expose_underground] Error: {e}")
            return ActionResult(
                success=False,
                action="expose_underground",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="EXECUTION_ERROR",
                duration_ms=int((time.time() - start_time) * 1000)
            )

    async def place(

        self,
        block_type: str,
        x: int,
        y: int,
        z: int,
        timeout: float = 10.0
    ) -> ActionResult:
        start_time = time.time()

        try:
            try:
                existing = self._driver.block_at(self._Vec3(x, y, z))
                if existing and getattr(existing, "name", None) == block_type:
                    return ActionResult(
                        success=True,
                        action="place",
                        message=f"{block_type} 已在 ({x},{y},{z})，无需重复放置",
                        status=ActionStatus.SUCCESS,
                        data={"placed_at": [x, y, z], "already_there": True},
                        duration_ms=int((time.time() - start_time) * 1000),
                    )
            except Exception:
                pass

            try:
                pos = self._driver.get_position()
                dx = float(pos.x) - float(x)
                dy = float(pos.y) - float(y)
                dz = float(pos.z) - float(z)
                dist = (dx * dx + dy * dy + dz * dz) ** 0.5
            except Exception:
                dist = 9999.0
            if dist > 4.5:
                try:
                    await self._movement.goto(f"{x},{y},{z}", timeout=min(10.0, max(3.0, timeout / 2)))
                except Exception:
                    pass

            item = self._inventory.find_inventory_item(block_type)
            if not item:
                return ActionResult(
                    success=False,
                    action="place",
                    message=f"背包中没有 {block_type}",
                    status=ActionStatus.FAILED,
                    error_code="INSUFFICIENT_MATERIALS",
                    data={"missing": {block_type: 1}, "item": block_type}
                )

            await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._driver.equip_item(item, "hand")
                ),
                timeout=3.0
            )

            target_pos = self._Vec3(x, y - 1, z)
            ref_block = self._driver.block_at(target_pos)

            await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._driver.place_block(ref_block, self._Vec3(0, 1, 0))
                ),
                timeout=timeout
            )

            return ActionResult(
                success=True,
                action="place",
                message=f"成功放置 {block_type} 在 ({x},{y},{z})",
                status=ActionStatus.SUCCESS,
                data={"placed_at": [x, y, z]},
                duration_ms=int((time.time() - start_time) * 1000)
            )

        except asyncio.TimeoutError:
            try:
                placed = self._driver.block_at(self._Vec3(x, y, z))
                if placed and getattr(placed, "name", None) == block_type:
                    return ActionResult(
                        success=True,
                        action="place",
                        message=f"成功放置 {block_type} 在 ({x},{y},{z})（事件超时但已确认落地）",
                        status=ActionStatus.SUCCESS,
                        data={"placed_at": [x, y, z], "event_timeout_but_placed": True},
                        duration_ms=int((time.time() - start_time) * 1000),
                    )
            except Exception:
                pass
            return ActionResult(
                success=False,
                action="place",
                message=f"放置 {block_type} 超时",
                status=ActionStatus.TIMEOUT,
                error_code="TIMEOUT",
                duration_ms=int((time.time() - start_time) * 1000)
            )
        except Exception as e:
            msg = str(e)
            if "blockupdate" in msg.lower() and "did not fire within timeout" in msg.lower():
                try:
                    placed = self._driver.block_at(self._Vec3(x, y, z))
                    if placed and getattr(placed, "name", None) == block_type:
                        return ActionResult(
                            success=True,
                            action="place",
                            message=(
                                f"成功放置 {block_type} 在 ({x},{y},{z})"
                                "（blockUpdate 超时但已确认落地）"
                            ),
                            status=ActionStatus.SUCCESS,
                            data={"placed_at": [x, y, z], "blockupdate_timeout_but_placed": True},
                            duration_ms=int((time.time() - start_time) * 1000),
                        )
                except Exception:
                    pass
                return ActionResult(
                    success=False,
                    action="place",
                    message=msg,
                    status=ActionStatus.TIMEOUT,
                    error_code="TIMEOUT",
                    duration_ms=int((time.time() - start_time) * 1000),
                )

            logger.error(f"place failed: {e}")
            return ActionResult(
                success=False,
                action="place",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                duration_ms=int((time.time() - start_time) * 1000)
            )

    def _find_nearest_block(self, block_id: int, center, radius: int):
        try:
            blocks = self._driver.find_blocks({
                "matching": block_id,
                "maxDistance": radius,
                "count": 256
            })

            if not blocks:
                return None

            nearest_block = None
            nearest_dist = float("inf")

            for block_pos in blocks:
                try:
                    dist = center.distanceTo(block_pos)
                    if dist < nearest_dist:
                        nearest_dist = dist
                        nearest_block = self._driver.block_at(block_pos)
                except Exception:
                    pass

            return nearest_block
        except Exception as e:
            logger.warning(f"_find_nearest_block failed: {e}")
            return None
        except Exception as e:
            logger.warning(f"Axe equip failed: {e}")
            return False
