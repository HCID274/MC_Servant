# Movement system (pathfinding, navigation)

from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from typing import Optional, Dict, Any

from bot.drivers.interfaces import IDriverAdapter
from bot.interfaces import ActionResult, ActionStatus
from bot.systems.common import BackgroundTaskManager

logger = logging.getLogger(__name__)


class MovementSystem:
    def __init__(self, driver: IDriverAdapter, background: BackgroundTaskManager) -> None:
        self._driver = driver
        self._bot = driver.bot
        self._pathfinder = driver.pathfinder
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
            self._bot.pathfinder.setGoal(goal)

            try:
                await asyncio.wait_for(
                    self._wait_for_goal_reached(saved_goal=goal),
                    timeout=timeout
                )
            except asyncio.TimeoutError:
                self._bot.pathfinder.stop()
                return ActionResult(
                    success=False,
                    action="goto",
                    message=f"导航到 {target} 超时 ({timeout}s)",
                    status=ActionStatus.TIMEOUT,
                    error_code="TIMEOUT",
                    duration_ms=int((time.time() - start_time) * 1000)
                )

            pos = self._bot.entity.position
            return ActionResult(
                success=True,
                action="goto",
                message=f"已到达 {target}",
                status=ActionStatus.SUCCESS,
                data={"arrived_at": [int(pos.x), int(pos.y), int(pos.z)]},
                duration_ms=int((time.time() - start_time) * 1000)
            )

        except Exception as e:
            logger.error(f"goto failed: {e}")
            self._bot.pathfinder.stop()
            return ActionResult(
                success=False,
                action="goto",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="PATH_BLOCKED",
                duration_ms=int((time.time() - start_time) * 1000)
            )

    async def navigate_to_block(self, x: int, y: int, z: int) -> None:
        """Navigate near a block position for interaction."""
        try:
            bot_pos = self._bot.entity.position
            dist = ((bot_pos.x - x) ** 2 + (bot_pos.y - y) ** 2 + (bot_pos.z - z) ** 2) ** 0.5
            if dist < 4:
                return

            goals = self._pathfinder.goals
            goal = goals.GoalNear(int(x), int(y), int(z), 3)
            self._bot.pathfinder.setGoal(goal)

            start_wait = time.time()
            while not self._bot.pathfinder.isMoving() and time.time() - start_wait < 2.0:
                await asyncio.sleep(0.1)
            if not self._bot.pathfinder.isMoving():
                fallback_goal = None
                if hasattr(goals, "GoalNearXZ"):
                    fallback_goal = goals.GoalNearXZ(int(x), int(z), 3)
                else:
                    fallback_goal = goals.GoalNear(int(x), int(bot_pos.y), int(z), 3)
                logger.debug(f"Navigation fallback to XZ-only goal for ({x},{y},{z})")
                self._bot.pathfinder.setGoal(fallback_goal)

            start = time.time()
            while self._bot.pathfinder.isMoving() and time.time() - start < 10:
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
            goals = self._pathfinder.goals
            target_x = math.floor(position["x"])
            target_y = math.floor(position["y"])
            target_z = math.floor(position["z"])

            goal = None
            if hasattr(goals, "GoalBlock"):
                goal = goals.GoalBlock(target_x, target_y, target_z)
            else:
                goal = goals.GoalNear(target_x, target_y, target_z, max(1, int(math.ceil(reach))))

            self._bot.pathfinder.setGoal(goal)

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
                    self._bot.pathfinder.stop()
                except Exception:
                    pass

            pos = self._bot.entity.position
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
                center_y = int(self._bot.entity.position.y)

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
            last_pos = self._bot.entity.position

            while time.time() - patrol_start < duration:
                if time.time() - start_time > timeout:
                    break

                waypoint = random.choice(waypoints)
                target_str = f"{waypoint[0]},{waypoint[1]},{waypoint[2]}"

                logger.debug(f"[patrol] Moving to waypoint: {target_str}")

                goto_result = await self.goto(target_str, timeout=min(15, duration / 2))

                if goto_result.success:
                    waypoints_visited += 1
                    curr_pos = self._bot.entity.position
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
        goals = self._pathfinder.goals

        # Player target: @PlayerName
        if target.startswith("@"):
            player_name = target[1:]
            try:
                player = self._bot.players.get(player_name)
                if player and player.entity:
                    pos = player.entity.position
                    try:
                        return goals.GoalNear(int(pos.x), int(pos.y), int(pos.z), 2)
                    except Exception:
                        return goals.GoalBlock(int(pos.x), int(pos.y), int(pos.z))
            except Exception:
                pass
            logger.warning(f"Player not found: {player_name}")
            return None

        if "," in target:
            parts = target.replace(" ", "").split(",")
            if len(parts) == 3:
                try:
                    x, y, z = map(int, parts)
                    return goals.GoalBlock(x, y, z)
                except ValueError:
                    logger.warning(f"Invalid coordinates: {target}")
                    return None

        logger.warning(f"Unsupported target format: {target}")
        return None

    async def _wait_for_goal_reached(self, saved_goal=None) -> None:
        start_wait = time.time()
        while not self._bot.pathfinder.isMoving():
            if time.time() - start_wait > 2.0:
                if saved_goal and self._is_goal_reached(saved_goal):
                    logger.info("[DEBUG] Already at goal, no movement needed")
                    return
                logger.warning("Pathfinder did not start moving within 2s, path may be blocked")
                raise RuntimeError("Pathfinder failed to start - path may be blocked or unreachable")
            await asyncio.sleep(0.1)

        logger.info(f"[DEBUG] Pathfinder started moving: {self._bot.pathfinder.isMoving()}")

        iteration = 0
        while True:
            is_moving = self._bot.pathfinder.isMoving()
            goal = self._bot.pathfinder.goal

            if iteration % 10 == 0:
                pos = self._bot.entity.position
                logger.info(
                    f"[DEBUG] Pathfinder status: moving={is_moving}, goal={goal is not None}, "
                    f"pos=({pos.x:.1f}, {pos.y:.1f}, {pos.z:.1f})"
                )
            iteration += 1

            if not is_moving:
                check_goal = goal or saved_goal
                if check_goal and self._is_goal_reached(check_goal):
                    logger.info("[DEBUG] Goal reached!")
                    return
                if goal is None and saved_goal is None:
                    logger.info("[DEBUG] Goal is None, pathfinder stopped (no saved goal)")
                    return
                pos = self._bot.entity.position
                logger.warning(
                    f"[DEBUG] Pathfinder stopped without reaching goal! "
                    f"pos=({pos.x:.1f}, {pos.y:.1f}, {pos.z:.1f})"
                )
                raise RuntimeError("Pathfinder stopped before reaching goal - path blocked or unreachable")

            await asyncio.sleep(0.1)

    def _is_goal_reached(self, goal) -> bool:
        try:
            pos = self._bot.entity.position
            bx = math.floor(pos.x)
            by = math.floor(pos.y)
            bz = math.floor(pos.z)

            if hasattr(goal, "x") and hasattr(goal, "y") and hasattr(goal, "z"):
                try:
                    gx = int(goal.x)
                    gy = int(goal.y)
                    gz = int(goal.z)
                    if bx == gx and by == gy and bz == gz:
                        return True
                except Exception:
                    pass

            if hasattr(goal, "range") and hasattr(goal, "x") and hasattr(goal, "y") and hasattr(goal, "z"):
                try:
                    dx = pos.x - float(goal.x)
                    dy = pos.y - float(goal.y)
                    dz = pos.z - float(goal.z)
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

    def _get_highest_block_y_at(self, x: int, z: int) -> Optional[int]:
        try:
            start_y = min(320, int(self._bot.entity.position.y) + 64)

            for y in range(start_y, -64, -1):
                try:
                    block = self._bot.blockAt({"x": x, "y": y, "z": z})
                    if block and block.name not in ("air", "void_air", "cave_air"):
                        above = self._bot.blockAt({"x": x, "y": y + 1, "z": z})
                        if above and above.name in ("air", "void_air", "cave_air"):
                            return y + 1
                except Exception:
                    pass

            return None
        except Exception:
            return None
