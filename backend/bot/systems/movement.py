# Movement system (pathfinding, navigation)

from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from typing import Optional, Dict, Any, Tuple

from bot.drivers.interfaces import IDriverAdapter
from bot.interfaces import ActionResult, ActionStatus
from bot.systems.common import BackgroundTaskManager

logger = logging.getLogger(__name__)


class MovementSystem:
    def __init__(self, driver: IDriverAdapter, background: BackgroundTaskManager) -> None:
        self._driver = driver
        self._Vec3 = driver.vec3
        self._background = background

    async def goto(self, target: str, timeout: float = 60.0) -> ActionResult:
        start_time = time.time()

        try:
            goal = self._parse_goal(target)
            if goal is None:
                return ActionResult(
                    success=False,
                    action="goto",
                    message=f"无法解析目标位置: {target}",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )

            logger.info("[DEBUG] goto: goal parsed, setting pathfinder goal")
            self._driver.set_goal(goal)

            try:
                await asyncio.wait_for(
                    self._wait_for_goal_reached(saved_goal=goal),
                    timeout=timeout
                )
            except asyncio.TimeoutError:
                self._driver.stop_pathfinder()
                return ActionResult(
                    success=False,
                    action="goto",
                    message=f"导航到 {target} 超时 ({timeout}s)",
                    status=ActionStatus.TIMEOUT,
                    error_code="TIMEOUT",
                    duration_ms=int((time.time() - start_time) * 1000)
                )
            except RuntimeError as e:
                logger.warning(f"[goto] Pathfinder error: {e}. Trying simple fallback move.")
                try:
                    self._driver.stop_pathfinder()
                except Exception:
                    pass

                fallback_moved = await self._simple_move_step(goal, duration=1.2)
                if self._driver.is_goal_reached(goal, self._driver.get_position()):
                    pos = self._driver.get_position()
                    return ActionResult(
                        success=True,
                        action="goto",
                        message=f"Arrived at {target}",
                        status=ActionStatus.SUCCESS,
                        data={"arrived_at": [int(pos.x), int(pos.y), int(pos.z)]},
                        duration_ms=int((time.time() - start_time) * 1000)
                    )

                remaining = max(0.0, timeout - (time.time() - start_time))
                if fallback_moved and remaining > 0.1:
                    try:
                        self._driver.set_goal(goal)
                        await asyncio.wait_for(
                            self._wait_for_goal_reached(saved_goal=goal),
                            timeout=remaining
                        )
                        pos = self._driver.get_position()
                        return ActionResult(
                            success=True,
                            action="goto",
                            message=f"Arrived at {target}",
                            status=ActionStatus.SUCCESS,
                            data={"arrived_at": [int(pos.x), int(pos.y), int(pos.z)]},
                            duration_ms=int((time.time() - start_time) * 1000)
                        )
                    except asyncio.TimeoutError:
                        try:
                            self._driver.stop_pathfinder()
                        except Exception:
                            pass
                        return ActionResult(
                            success=False,
                            action="goto",
                            message=f"Navigation to {target} timed out ({timeout}s)",
                            status=ActionStatus.TIMEOUT,
                            error_code="TIMEOUT",
                            duration_ms=int((time.time() - start_time) * 1000)
                        )
                    except Exception as retry_err:
                        logger.warning(f"[goto] Pathfinder retry failed after fallback: {retry_err}")
                return ActionResult(
                    success=False,
                    action="goto",
                    message=f"Pathfinder failed: {e}",
                    status=ActionStatus.FAILED,
                    error_code="PATH_BLOCKED",
                    duration_ms=int((time.time() - start_time) * 1000)
                )

            pos = self._driver.get_position()
            return ActionResult(
                success=True,
                action="goto",
                message=f"Arrived at {target}",
                status=ActionStatus.SUCCESS,
                data={"arrived_at": [int(pos.x), int(pos.y), int(pos.z)]},
                duration_ms=int((time.time() - start_time) * 1000)
            )

        except Exception as e:
            logger.error(f"goto failed: {e}")
            self._driver.stop_pathfinder()
            return ActionResult(
                success=False,
                action="goto",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="PATH_BLOCKED",
                duration_ms=int((time.time() - start_time) * 1000)
            )

    async def unstuck_move(self, duration: float = 0.8) -> bool:
        return await self._simple_move_step(goal=None, duration=duration)

    async def _simple_move_step(self, goal=None, duration: float = 0.8) -> bool:
        try:
            pos_before = self._driver.get_position()
            target = self._driver.goal_target_coords(goal) if goal else None
            if target:
                try:
                    self._driver.look_at(self._Vec3(target[0] + 0.5, pos_before.y + 1.6, target[2] + 0.5))
                except Exception:
                    pass

            if target:
                await self._try_clear_front_block(target)

            if self._has_moved(pos_before):
                return True

            for direction in ("forward", "left", "right", "back"):
                if await self._nudge_move(direction, duration=duration):
                    return True

            return self._has_moved(pos_before)
        except Exception as e:
            logger.debug(f"[simple_move] fallback failed: {e}")
            return False

    async def _nudge_move(self, direction: str, duration: float = 0.6) -> bool:
        pos_before = self._driver.get_position()
        try:
            self._driver.set_control_state(direction, True)
            self._driver.set_control_state("jump", True)
            await asyncio.sleep(max(0.2, duration))
        finally:
            try:
                self._driver.set_control_state(direction, False)
                self._driver.set_control_state("jump", False)
            except Exception:
                pass

        return self._has_moved(pos_before)

    async def _try_clear_front_block(self, target: Optional[Tuple[int, int, int]]) -> None:
        try:
            pos = self._driver.get_position()
            bx = int(math.floor(pos.x))
            by = int(math.floor(pos.y))
            bz = int(math.floor(pos.z))

            step_x = 0
            step_z = 0
            if target:
                dx = target[0] - pos.x
                dz = target[2] - pos.z
                if abs(dx) >= abs(dz):
                    step_x = 1 if dx > 0.3 else -1 if dx < -0.3 else 0
                else:
                    step_z = 1 if dz > 0.3 else -1 if dz < -0.3 else 0
            if step_x == 0 and step_z == 0:
                step_x = 1

            head_pos = self._Vec3(bx + step_x, by + 1, bz + step_z)
            head_block = self._driver.block_at(head_pos)
            if head_block and not self._is_air_block(head_block) and getattr(head_block, "diggable", True):
                try:
                    await self._driver.dig(head_block)
                except Exception:
                    pass
        except Exception:
            pass

    def _is_air_block(self, block) -> bool:
        try:
            return block is None or block.name in ("air", "cave_air", "void_air")
        except Exception:
            return True

    def _has_moved(self, pos_before, threshold: float = 0.2) -> bool:
        try:
            pos_after = self._driver.get_position()
            dx = pos_after.x - pos_before.x
            dy = pos_after.y - pos_before.y
            dz = pos_after.z - pos_before.z
            return (dx * dx + dy * dy + dz * dz) >= (threshold * threshold)
        except Exception:
            return False

    async def navigate_to_block(self, x: int, y: int, z: int) -> None:
        """Navigate near a block position for interaction."""
        try:
            bot_pos = self._driver.get_position()
            dist = ((bot_pos.x - x) ** 2 + (bot_pos.y - y) ** 2 + (bot_pos.z - z) ** 2) ** 0.5
            if dist < 4:
                return

            goal = self._driver.create_goal_near(int(x), int(y), int(z), 3)
            if goal is None:
                return
            self._driver.set_goal(goal)

            start_wait = time.time()
            while not self._driver.is_moving() and time.time() - start_wait < 2.0:
                await asyncio.sleep(0.1)
            if not self._driver.is_moving():
                fallback_goal = self._driver.create_goal_near_xz(int(x), int(z), 3, y_hint=int(bot_pos.y))
                logger.debug(f"Navigation fallback to XZ-only goal for ({x},{y},{z})")
                if fallback_goal is not None:
                    self._driver.set_goal(fallback_goal)

            start = time.time()
            while self._driver.is_moving() and time.time() - start < 10:
                await asyncio.sleep(0.1)

        except Exception as e:
            logger.debug(f"Navigation to ({x},{y},{z}) failed: {e}")

    async def navigate_close_to_position(
        self,
        position: Dict[str, float],
        timeout: float = 10.0,
        reach: float = 1.0
    ) -> bool:
        try:
            target_x = math.floor(position["x"])
            target_y = math.floor(position["y"])
            target_z = math.floor(position["z"])

            goal = self._driver.create_goal_block(target_x, target_y, target_z)
            if goal is None:
                goal = self._driver.create_goal_near(
                    target_x,
                    target_y,
                    target_z,
                    max(1, int(math.ceil(reach)))
                )
            if goal is None:
                return False

            self._driver.set_goal(goal)

            try:
                await asyncio.wait_for(
                    self._wait_for_goal_reached(saved_goal=goal),
                    timeout=timeout
                )
            except asyncio.TimeoutError:
                logger.debug(f"[pickup] Navigation to ({target_x},{target_y},{target_z}) timed out")
                return False
            except RuntimeError as e:
                logger.debug(f"[pickup] Navigation runtime error: {e}")
                return False
            finally:
                try:
                    self._driver.stop_pathfinder()
                except Exception:
                    pass

            pos = self._driver.get_position()
            dx = pos.x - position["x"]
            dy = pos.y - position["y"]
            dz = pos.z - position["z"]
            return (dx * dx + dy * dy + dz * dz) <= max(reach, 1.25) ** 2
        except Exception as e:
            logger.debug(f"[pickup] navigate_close_to_position failed: {e}")
            return False

    async def patrol(
        self,
        center_x: int,
        center_z: int,
        radius: int = 10,
        duration: int = 30,
        timeout: float = 60.0
    ) -> ActionResult:
        start_time = time.time()
        waypoints_visited = 0
        total_distance = 0.0

        logger.info(
            f"[patrol] Starting patrol at ({center_x}, {center_z}), "
            f"radius={radius}, duration={duration}s"
        )

        try:
            center_y = self._get_highest_block_y_at(center_x, center_z)
            if center_y is None:
                center_y = int(self._driver.get_position().y)

            num_waypoints = max(3, duration // 10)
            waypoints = []

            for _ in range(num_waypoints):
                angle = random.uniform(0, 2 * 3.14159)
                r = random.uniform(radius * 0.3, radius)

                wx = int(center_x + r * math.cos(angle))
                wz = int(center_z + r * math.sin(angle))
                wy = self._get_highest_block_y_at(wx, wz)

                if wy is not None:
                    waypoints.append((wx, wy, wz))

            # 🔧 Fix: Fallback - 如果随机点都无效，使用机器人当前位置附近的简单偏移
            if not waypoints:
                logger.warning("[patrol] Random waypoints failed, using fallback near bot position")
                bot_pos = self._driver.get_position()
                bot_y = int(bot_pos.y)
                for dx, dz in [(5, 0), (-5, 0), (0, 5), (0, -5), (3, 3), (-3, -3)]:
                    fallback_x = int(bot_pos.x) + dx
                    fallback_z = int(bot_pos.z) + dz
                    waypoints.append((fallback_x, bot_y, fallback_z))
                
                if not waypoints:
                    return ActionResult(
                        success=False,
                        action="patrol",
                        message="Failed to generate valid waypoints",
                        status=ActionStatus.FAILED,
                        error_code="TARGET_NOT_FOUND",
                        duration_ms=int((time.time() - start_time) * 1000)
                    )

            logger.info(f"[patrol] Generated {len(waypoints)} waypoints")

            patrol_start = time.time()
            last_pos = self._driver.get_position()

            while time.time() - patrol_start < duration:
                if time.time() - start_time > timeout:
                    break

                waypoint = random.choice(waypoints)
                target_str = f"{waypoint[0]},{waypoint[1]},{waypoint[2]}"

                logger.debug(f"[patrol] Moving to waypoint: {target_str}")

                goto_result = await self.goto(target_str, timeout=min(15, duration / 2))

                if goto_result.success:
                    waypoints_visited += 1
                    curr_pos = self._driver.get_position()
                    dist = (
                        (curr_pos.x - last_pos.x) ** 2 +
                        (curr_pos.y - last_pos.y) ** 2 +
                        (curr_pos.z - last_pos.z) ** 2
                    ) ** 0.5
                    total_distance += dist
                    last_pos = curr_pos

                    await asyncio.sleep(random.uniform(0.5, 2.0))
                else:
                    logger.debug("[patrol] Failed to reach waypoint, trying next")
                    await asyncio.sleep(0.5)

            actual_duration = time.time() - patrol_start

            return ActionResult(
                success=True,
                action="patrol",
                message=f"Patrol complete: visited {waypoints_visited} waypoints in {actual_duration:.1f}s",
                status=ActionStatus.SUCCESS,
                data={
                    "waypoints_visited": waypoints_visited,
                    "total_distance": round(total_distance, 1),
                    "duration_actual": round(actual_duration, 1)
                },
                duration_ms=int((time.time() - start_time) * 1000)
            )

        except Exception as e:
            logger.error(f"patrol failed: {e}")
            return ActionResult(
                success=waypoints_visited > 0,
                action="patrol",
                message=str(e) if waypoints_visited == 0 else f"Partial patrol: {waypoints_visited} waypoints",
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                data={
                    "waypoints_visited": waypoints_visited,
                    "total_distance": round(total_distance, 1),
                    "duration_actual": round(time.time() - start_time, 1)
                },
                duration_ms=int((time.time() - start_time) * 1000)
            )

    def _parse_goal(self, target: str):
        # Player target: @PlayerName
        if target.startswith("@"):
            player_name = target[1:]
            try:
                # 🔧 Fix: 安全的玩家查找
                player = self._driver.get_player(player_name)
                
                # 方法 3: 大小写不敏感匹配 (安全遍历)
                if not player or not getattr(player, 'entity', None):
                    try:
                        # 尝试获取所有玩家名的列表
                        player_names = self._driver.get_player_names()
                        
                        for pname in player_names:
                            if str(pname).lower() == player_name.lower():
                                try:
                                    candidate = self._driver.get_player(pname)
                                    if candidate is None and pname is not None:
                                        candidate = self._driver.get_player(str(pname))
                                    if candidate and getattr(candidate, 'entity', None):
                                        player = candidate
                                        logger.debug(f"Found player via case-insensitive match: {pname}")
                                        break
                                except Exception:
                                    continue
                    except Exception as iter_err:
                        logger.debug(f"Could not iterate players: {iter_err}")
                
                if player and getattr(player, 'entity', None):
                    pos = player.entity.position
                    goal = self._driver.create_goal_near(int(pos.x), int(pos.y), int(pos.z), 2)
                    if goal is None:
                        goal = self._driver.create_goal_block(int(pos.x), int(pos.y), int(pos.z))
                    return goal
                
                # 记录更详细的日志
                if player and not getattr(player, 'entity', None):
                    logger.warning(f"Player {player_name} exists but entity not loaded (may be too far)")
                else:
                    logger.warning(f"Player {player_name} not found in bot.players")
            except Exception as e:
                logger.warning(f"Error finding player {player_name}: {e}")
            return None

        if "," in target:
            parts = target.replace(" ", "").split(",")
            if len(parts) == 3:
                try:
                    x, y, z = map(int, parts)
                    return self._driver.create_goal_block(x, y, z)
                except ValueError:
                    logger.warning(f"Invalid coordinates: {target}")
                    return None

        logger.warning(f"Unsupported target format: {target}")
        return None

    async def _wait_for_goal_reached(self, saved_goal=None) -> None:
        start_wait = time.time()
        while not self._driver.is_moving():
            if time.time() - start_wait > 2.0:
                if saved_goal and self._driver.is_goal_reached(saved_goal, self._driver.get_position()):
                    logger.info("[DEBUG] Already at goal, no movement needed")
                    return
                logger.warning("Pathfinder did not start moving within 2s, path may be blocked")
                raise RuntimeError("Pathfinder failed to start - path may be blocked or unreachable")
            await asyncio.sleep(0.1)

        logger.info(f"[DEBUG] Pathfinder started moving: {self._driver.is_moving()}")

        iteration = 0
        while True:
            is_moving = self._driver.is_moving()
            goal = self._driver.current_goal()

            if iteration % 10 == 0:
                pos = self._driver.get_position()
                logger.info(
                    f"[DEBUG] Pathfinder status: moving={is_moving}, goal={goal is not None}, "
                    f"pos=({pos.x:.1f}, {pos.y:.1f}, {pos.z:.1f})"
                )
            iteration += 1

            if not is_moving:
                check_goal = goal or saved_goal
                if check_goal and self._driver.is_goal_reached(check_goal, self._driver.get_position()):
                    logger.info("[DEBUG] Goal reached!")
                    return
                # 容差检测：距离目标 < 1.5 格视为成功
                if check_goal:
                    coords = self._driver.goal_target_coords(check_goal)
                    if coords:
                        pos = self._driver.get_position()
                        dist_sq = (pos.x - coords[0])**2 + (pos.y - coords[1])**2 + (pos.z - coords[2])**2
                        if dist_sq < 2.25:  # 1.5^2 = 2.25
                            logger.info(f"[DEBUG] Close enough to goal (dist={dist_sq**0.5:.2f}), treating as reached")
                            return
                if goal is None and saved_goal is None:
                    logger.info("[DEBUG] Goal is None, pathfinder stopped (no saved goal)")
                    return
                pos = self._driver.get_position()
                logger.warning(
                    f"[DEBUG] Pathfinder stopped without reaching goal! "
                    f"pos=({pos.x:.1f}, {pos.y:.1f}, {pos.z:.1f})"
                )
                raise RuntimeError("Pathfinder stopped before reaching goal - path blocked or unreachable")

            await asyncio.sleep(0.1)

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
