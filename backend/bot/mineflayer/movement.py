import asyncio
import logging
import math
import time
from typing import Optional

from bot.interfaces import BotActionError


logger = logging.getLogger(__name__)


class MineflayerMovementMixin:
    """物理执行：封装基于 Mineflayer 的基础动作（跳跃、旋转、视角切换、路径导航及聊天）。"""

    def _navigation_proxy_timeout_seconds(
        self,
        action_timeout_seconds: Optional[float],
        *,
        minimum_seconds: float = 30.0,
        maximum_seconds: float = 180.0,
    ) -> float:
        """移动桥接超时：显式覆盖 javascript.Proxy 默认 10s Barrier 超时。"""
        timeout_seconds = float(action_timeout_seconds or 0.0)
        if timeout_seconds <= 0:
            return minimum_seconds
        return min(max(timeout_seconds, minimum_seconds), maximum_seconds)

    def _distance_to_position(self, target_x: float, target_y: float, target_z: float) -> float:
        """目标距离：计算当前 Bot 与目标坐标之间的欧氏距离。"""
        position = getattr(getattr(self._bot, "entity", None), "position", None)
        if position is None:
            return float("inf")
        dx = float(getattr(position, "x", 0.0) or 0.0) - float(target_x)
        dy = float(getattr(position, "y", 0.0) or 0.0) - float(target_y)
        dz = float(getattr(position, "z", 0.0) or 0.0) - float(target_z)
        return math.sqrt((dx * dx) + (dy * dy) + (dz * dz))

    def _wait_for_arrival(
        self,
        *,
        target_x: float,
        target_y: float,
        target_z: float,
        radius: float,
        timeout_seconds: float,
        poll_interval: float = 0.2,
    ) -> bool:
        """到达等待：轮询当前位置，直到真正进入目标半径。"""
        deadline = time.perf_counter() + max(float(timeout_seconds or 0.0), 0.0)
        acceptable_radius = max(float(radius or 0.0), 0.5) + 0.35
        while time.perf_counter() < deadline:
            if self._distance_to_position(target_x, target_y, target_z) <= acceptable_radius:
                return True
            time.sleep(max(float(poll_interval or 0.2), 0.05))
        return self._distance_to_position(target_x, target_y, target_z) <= acceptable_radius

    def _stop_navigation(self) -> None:
        """路径停止：在业务超时后主动中止 pathfinder，避免后台仍持续移动。"""
        pathfinder = getattr(self._bot, "pathfinder", None)
        if pathfinder is None:
            return
        stop = getattr(pathfinder, "stop", None)
        if callable(stop):
            try:
                stop(timeout=None)
                return
            except TypeError:
                try:
                    stop()
                    return
                except Exception:
                    pass
            except Exception:
                pass
        set_goal = getattr(pathfinder, "setGoal", None)
        if callable(set_goal):
            try:
                set_goal(None, timeout=None)
            except TypeError:
                try:
                    set_goal(None)
                except Exception:
                    pass
            except Exception:
                pass

    async def animate(self, animation: str, duration: float = 0.8) -> bool:
        """轻表演动作：供 chat 交互链复用，不承载重任务语义。"""
        self._clear_action_error()
        if not self.is_connected:
            logger.warning("Cannot animate: Bot not connected")
            self._set_action_error(
                source="python_adapter",
                action="animate",
                target=animation,
                stage="precheck",
                raw_name="BotNotConnected",
                raw_message="Bot not connected",
                retryable_hint=False,
            )
            return False

        try:
            loop = asyncio.get_event_loop()
            action_error = await loop.run_in_executor(
                None,
                lambda: self._do_animate(str(animation or "").strip().lower(), duration),
            )
            if action_error is not None:
                logger.warning("Animate failed for %s: %s", animation, action_error.raw_message)
                self._last_action_error = action_error
                return False
            logger.info("Bot %s animated: %s", self._username, animation)
            return True
        except Exception as exc:
            logger.error("Animate failed: %s", exc)
            self._set_action_error(
                source="mineflayer_core",
                action="animate",
                target=animation,
                stage="execute",
                raw_name=type(exc).__name__ or "AnimateError",
                raw_message=str(exc) or "Animate failed",
                retryable_hint=True,
            )
            return False

    async def jump(self) -> bool:
        """跳跃动作：触发化身在原地执行一次物理跳跃。"""
        self._clear_action_error()
        if not self.is_connected:
            logger.warning("Cannot jump: Bot not connected")
            self._set_action_error(
                source="python_adapter",
                action="jump",
                target="self",
                stage="precheck",
                raw_name="BotNotConnected",
                raw_message="Bot not connected",
                retryable_hint=False,
            )
            return False
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, self._do_jump)
            logger.info("Bot %s jumped!", self._username)
            return True
        except Exception as exc:
            logger.error("Jump failed: %s", exc)
            self._set_action_error(
                source="mineflayer_core",
                action="jump",
                target="self",
                stage="execute",
                raw_name=type(exc).__name__ or "JumpError",
                raw_message=str(exc) or "Jump failed",
                retryable_hint=True,
            )
            return False

    def _do_jump(self):
        """物理执行逻辑：通过直接控制状态机实现跳跃。"""
        import time

        self._bot.setControlState("jump", True)
        time.sleep(0.3)
        self._bot.setControlState("jump", False)

    def _do_animate(self, animation: str, duration: float) -> Optional[BotActionError]:
        """表演执行细节：执行轻量互动动作，不改变世界资源状态。"""
        import time

        if animation == "jump":
            self._do_jump()
            return None
        if animation == "sneak":
            self._bot.setControlState("sneak", True)
            time.sleep(max(float(duration), 0.2))
            self._bot.setControlState("sneak", False)
            return None
        if animation == "swing_arm":
            self._bot.swingArm("right", True)
            return None
        if animation == "spin":
            self._do_spin(1, max(float(duration), 0.8))
            return None
        return BotActionError(
            source="python_adapter",
            action="animate",
            target=animation,
            stage="validate_input",
            raw_name="UnsupportedAnimation",
            raw_message=f"Unsupported animation: {animation}",
            position=self._get_current_position_dict(),
            retryable_hint=False,
        )

    async def chat(self, message: str) -> bool:
        """外部交流：发送聊天信息或执行服务器命令。"""
        self._clear_action_error()
        if not self.is_connected:
            logger.warning("Cannot chat: Bot not connected")
            self._set_action_error(
                source="python_adapter",
                action="chat",
                target=message,
                stage="precheck",
                raw_name="BotNotConnected",
                raw_message="Bot not connected",
                retryable_hint=False,
            )
            return False
        try:
            self._bot.chat(message)
            logger.info("Bot %s said: %s", self._username, message)
            return True
        except Exception as exc:
            logger.error("Chat failed: %s", exc)
            self._set_action_error(
                source="mineflayer_core",
                action="chat",
                target=message,
                stage="send_chat",
                raw_name=type(exc).__name__ or "ChatError",
                raw_message=str(exc) or "Chat failed",
                retryable_hint=True,
            )
            return False

    async def spin(self, rotations: int = 1, duration: float = 1.0) -> bool:
        """物理旋转：控制化身执行指定圈数的原地旋转动作。"""
        if not self.is_connected:
            logger.warning("Cannot spin: Bot not connected")
            return False
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, lambda: self._do_spin(rotations, duration))
            logger.info("Bot %s spinned %s times!", self._username, rotations)
            return True
        except Exception as exc:
            logger.error("Spin failed: %s", exc)
            return False

    def _do_spin(self, rotations: int, duration: float):
        """旋转执行细节：分步计算偏航角偏移并触发转向。"""
        import math
        import time

        steps_per_rotation = 16
        total_steps = abs(rotations) * steps_per_rotation
        angle_per_step = (2 * math.pi / steps_per_rotation) * (1 if rotations > 0 else -1)
        step_duration = duration / steps_per_rotation

        for _ in range(total_steps):
            try:
                current_yaw = self._bot.entity.yaw
                new_yaw = current_yaw + angle_per_step
                self._bot.look(new_yaw, 0, True)
                time.sleep(step_duration)
            except Exception as exc:
                logger.warning("Spin step failed: %s", exc)
                break

    async def look_at(self, target: str) -> bool:
        """视角对焦：使化身转向特定实体（玩家）或坐标。"""
        self._clear_action_error()
        if not self.is_connected:
            logger.warning("Cannot look_at: Bot not connected")
            self._set_action_error(
                source="python_adapter",
                action="look_at",
                target=target,
                stage="precheck",
                raw_name="BotNotConnected",
                raw_message="Bot not connected",
                retryable_hint=False,
            )
            return False
        try:
            loop = asyncio.get_event_loop()
            action_error = await loop.run_in_executor(None, lambda: self._do_look_at(target))
            if action_error is not None:
                logger.warning("Look at failed for %s: %s", target, action_error.raw_message)
                self._last_action_error = action_error
                return False
            logger.info("Bot %s looked at %s", self._username, target)
            return True
        except Exception as exc:
            logger.error("Look at failed: %s", exc)
            self._set_action_error(
                source="mineflayer_core",
                action="look_at",
                target=target,
                stage="execute",
                raw_name=type(exc).__name__ or "LookAtError",
                raw_message=str(exc) or "Look at failed",
                retryable_hint=True,
            )
            return False

    def _do_look_at(self, target: str) -> Optional[BotActionError]:
        """对焦执行细节：解析目标标识符并计算物理观察角。"""
        if target.startswith("@"):
            player_name = target[1:]
            player = self._lookup_player(player_name)
            if player and player.entity:
                self._bot.lookAt(player.entity.position.offset(0, 1.6, 0))
                return None
            return BotActionError(
                source="mineflayer_core",
                action="look_at",
                target=target,
                stage="resolve_target",
                raw_name="TargetNotVisible",
                raw_message=f"Player {player_name} not found",
                position=self._get_current_position_dict(),
                retryable_hint=True,
            )

        parts = target.split(",")
        if len(parts) == 3:
            x, y, z = map(float, parts)
            self._bot.lookAt(self._Vec3(x, y, z))
            return None
        return BotActionError(
            source="python_adapter",
            action="look_at",
            target=target,
            stage="parse_target",
            raw_name="InvalidTargetFormat",
            raw_message=f"Invalid target format: {target}",
            position=self._get_current_position_dict(),
            retryable_hint=False,
        )

    async def navigate_relative(
        self,
        entity_name: str,
        offset_type: str,
        distance: float,
        timeout: float = 120.0,
    ) -> bool:
        """相对导航：以特定实体为参照，移动至其指定方向的偏移坐标。"""
        self._clear_action_error()
        if not self.is_connected:
            self._set_action_error(
                source="python_adapter",
                action="move_to",
                target=f"{entity_name}_{offset_type}",
                stage="precheck",
                raw_name="BotNotConnected",
                raw_message="Bot not connected",
                retryable_hint=False,
            )
            return False

        try:
            loop = asyncio.get_event_loop()
            action_error = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    lambda: self._do_navigate_relative(
                        entity_name,
                        offset_type,
                        distance,
                        action_timeout_seconds=timeout,
                    ),
                ),
                timeout=max(float(timeout or 0.0), 0.1),
            )
            if action_error is not None:
                logger.warning("Relative navigation failed: %s", action_error.raw_message)
                self._last_action_error = action_error
                return False
            return True
        except asyncio.TimeoutError:
            await loop.run_in_executor(None, self._stop_navigation)
            self._set_action_error(
                source="mineflayer_core",
                action="move_to",
                target=f"{entity_name}_{offset_type}",
                stage="execute",
                raw_name="MoveTimeout",
                raw_message=f"Relative navigation timed out for {entity_name}_{offset_type}",
                retryable_hint=True,
            )
            return False
        except Exception as exc:
            logger.error("Relative navigation failed: %s", exc)
            self._set_action_error(
                source="mineflayer_core",
                action="move_to",
                target=f"{entity_name}_{offset_type}",
                stage="pathfind_setup",
                raw_name=type(exc).__name__ or "NavigateError",
                raw_message=str(exc) or "Relative navigation failed",
                retryable_hint=True,
            )
            return False

    def _do_navigate_relative(
        self,
        entity_name: str,
        offset_type: str,
        distance: float,
        *,
        action_timeout_seconds: Optional[float] = None,
    ) -> Optional[BotActionError]:
        """相对坐标解算：基于参照实体的偏航角（Yaw）计算目标落点并启动路径规划。"""
        tracked_player_name = self._resolve_tracked_player_name(entity_name)
        master_player = self._lookup_player(tracked_player_name)

        if not master_player or not master_player.entity:
            return BotActionError(
                source="mineflayer_core",
                action="move_to",
                target=f"{entity_name}_{offset_type}",
                stage="resolve_target",
                raw_name="TargetNotVisible",
                raw_message=(
                    f"Tracked player {tracked_player_name or entity_name or 'master'} "
                    "not found for relative navigation"
                ),
                position=self._get_current_position_dict(),
                retryable_hint=True,
            )

        yaw = master_player.entity.yaw
        pos = master_player.entity.position
        if offset_type == "front":
            dx = -math.sin(yaw) * distance
            dz = -math.cos(yaw) * distance
        elif offset_type == "side":
            dx = -math.cos(yaw) * distance
            dz = math.sin(yaw) * distance
        else:
            return BotActionError(
                source="python_adapter",
                action="move_to",
                target=offset_type,
                stage="translate_offset",
                raw_name="InvalidOffsetType",
                raw_message=f"Unsupported offset_type: {offset_type}",
                position=self._get_current_position_dict(),
                retryable_hint=False,
            )

        target_x = pos.x + dx
        target_y = pos.y
        target_z = pos.z + dz
        logger.info(
            "Calculated target: %s of master at (%.1f, %.1f)",
            offset_type,
            target_x,
            target_z,
        )
        goal_radius = 0.5
        if self._distance_to_position(target_x, target_y, target_z) <= goal_radius + 0.35:
            return None

        goal = self._pathfinder.goals.GoalNear(target_x, target_y, target_z, goal_radius)
        pathfinder = getattr(self._bot, "pathfinder", None)
        if pathfinder is None:
            return BotActionError(
                source="mineflayer_core",
                action="move_to",
                target=f"{entity_name}_{offset_type}",
                stage="pathfind_setup",
                raw_name="PathfinderUnavailable",
                raw_message="Pathfinder unavailable during relative navigation",
                position=self._get_current_position_dict(),
                retryable_hint=True,
            )

        goto = getattr(pathfinder, "goto", None)
        try:
            if callable(goto):
                try:
                    goto(goal, timeout=None)
                except TypeError:
                    goto(goal)
            else:
                pathfinder.setGoal(goal)
            if self._wait_for_arrival(
                target_x=target_x,
                target_y=target_y,
                target_z=target_z,
                radius=goal_radius,
                timeout_seconds=min(max(float(action_timeout_seconds or 3.0), 1.5), 5.0),
            ):
                return None
            return BotActionError(
                source="mineflayer_core",
                action="move_to",
                target=f"{entity_name}_{offset_type}",
                stage="postcheck",
                raw_name="MoveStateMismatch",
                raw_message=(
                    f"Relative navigation finished but bot never entered goal radius "
                    f"for ({target_x:.2f}, {target_y:.2f}, {target_z:.2f})"
                ),
                position=self._get_current_position_dict(),
                target_position={"x": float(target_x), "y": float(target_y), "z": float(target_z)},
                retryable_hint=True,
            )
        except Exception as exc:
            return BotActionError(
                source="mineflayer_core",
                action="move_to",
                target=f"{entity_name}_{offset_type}",
                stage="execute",
                raw_name=self._coerce_js_error_name(exc, "NavigateFailed"),
                raw_message=self._coerce_js_error_message(
                    exc,
                    f"Relative navigation failed for {entity_name}_{offset_type}",
                ),
                position=self._get_current_position_dict(),
                target_position={"x": float(target_x), "y": float(target_y), "z": float(target_z)},
                retryable_hint=True,
            )

    async def look_at_eyes(self, entity_name: str, height_offset: float = 1.6) -> bool:
        """眼神对视：转向指定玩家的头部高度，建立物理社交感。"""
        self._clear_action_error()
        if not self.is_connected:
            self._set_action_error(
                source="python_adapter",
                action="look_at",
                target=entity_name,
                stage="precheck",
                raw_name="BotNotConnected",
                raw_message="Bot not connected",
                retryable_hint=False,
            )
            return False

        try:
            tracked_player_name = self._resolve_tracked_player_name(entity_name)
            master_player = self._lookup_player(tracked_player_name)

            if master_player and master_player.entity:
                eye_pos = master_player.entity.position.offset(0, height_offset, 0)
                self._bot.lookAt(eye_pos, True)
                return True
            self._set_action_error(
                source="mineflayer_core",
                action="look_at",
                target=entity_name,
                stage="resolve_target",
                raw_name="TargetNotVisible",
                raw_message=f"Player {tracked_player_name or entity_name} not found",
                retryable_hint=True,
            )
            return False
        except Exception as exc:
            logger.error("Look at eyes failed: %s", exc)
            self._set_action_error(
                source="mineflayer_core",
                action="look_at",
                target=entity_name,
                stage="execute",
                raw_name=type(exc).__name__ or "LookAtEyesError",
                raw_message=str(exc) or "Look at eyes failed",
                retryable_hint=True,
            )
            return False
