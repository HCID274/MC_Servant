import asyncio
import logging
import time
from pathlib import Path
from typing import Any, Optional

from javascript import On, require

from bot.interfaces import BotActionError
from bot.runtime_rules import SCAFFOLD_BLOCK_NAMES


logger = logging.getLogger(__name__)


class MineflayerLifecycleMixin:
    """生命周期编排：负责 Bot 的物理连接、插件注入、登录握手（含 AuthMe 自动应答）及事件分发。"""

    async def connect(self) -> bool:
        """建立连接：异步拉起 Node.js 进程中的 Mineflayer 实例并阻塞至初始化完成。"""
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, self._init_bot)
            self._connected = True
            logger.info("Bot %s connected to %s:%s", self._username, self._host, self._port)
            return True
        except Exception as exc:
            logger.error("Failed to connect bot: %s", exc)
            self._connected = False
            return False

    def _require_node_module(self, package_name: str):
        """本地模块加载器：优先从 node_modules 加载指定的 JS 库，确保环境独立。"""
        local_pkg = Path(__file__).resolve().parents[2] / "node_modules" / package_name
        if local_pkg.exists():
            return require(str(local_pkg))
        return require(package_name)

    def _init_bot(self):
        """实例创建：配置 JS 原生 Bot，并加载空间快照与资源缓存等核心桥接组件。"""
        self._mineflayer = self._require_node_module("mineflayer")
        self._pathfinder = self._require_node_module("mineflayer-pathfinder")
        self._Vec3 = self._require_node_module("vec3")
        assets_dir = Path(__file__).resolve().parent / "assets"
        self._env_snapshot_helper = require(str(assets_dir / "env_snapshot.js"))
        self._craft_recipe_helper = require(str(assets_dir / "craft_recipe_helper.js"))
        self._collect_watchdog_helper = require(str(assets_dir / "collect_watchdog_helper.js"))
        self._stair_mining_helper = require(str(assets_dir / "stair_mining_helper.js"))
        self._resource_cache_helper = require(
            str(assets_dir / "resource_cache_bridge.js")
        )(self._version)

        self._bot = self._mineflayer.createBot(
            {
                "host": self._host,
                "port": self._port,
                "username": self._username,
                "checkTimeoutInterval": 600000,
                "auth": "offline",
                "version": self._version,
            }
        )
        self._js_bridge_faulted = False
        self._bot.loadPlugin(self._pathfinder.pathfinder)
        self._load_plugins()
        self._register_events()

    def _load_plugins(self):
        """插件配置：注入路径规划、自动采集及工具自适应等物理层增强能力。"""
        try:
            self._mcData = self._require_node_module("minecraft-data")(self._bot.version)
            self._Item = self._require_node_module("prismarine-item")(self._bot.registry)

            collectblock = self._require_node_module("mineflayer-collectblock")
            self._bot.loadPlugin(collectblock.plugin)

            tool_plugin = self._require_node_module("mineflayer-tool")
            self._bot.loadPlugin(tool_plugin.plugin)
            if callable(self._craft_recipe_helper):
                self._craft_recipe_helper = self._craft_recipe_helper(self._bot, self._mcData)
            if callable(self._collect_watchdog_helper):
                self._collect_watchdog_helper = self._collect_watchdog_helper(self._bot)
            if callable(self._stair_mining_helper):
                self._stair_mining_helper = self._stair_mining_helper(self._bot, self._pathfinder, self._mcData)

            movements = self._pathfinder.Movements(self._bot, self._mcData)
            movements.canDig = True
            movements.allowParkour = True
            movements.allow1by1towers = True

            scaffold_ids = []
            for name in SCAFFOLD_BLOCK_NAMES:
                try:
                    block = self._mcData.blocksByName[name]
                    if block:
                        scaffold_ids.append(block.id)
                except Exception:
                    pass
            movements.scafoldingBlocks = scaffold_ids
            self._bot.pathfinder.setMovements(movements)
            logger.info("Bot %s plugins loaded: pathfinder, collectblock, tool", self._username)
        except Exception as exc:
            logger.error("Failed to load plugins: %s", exc)

    def _register_events(self):
        """事件绑定：注册核心物理事件，并维护 AuthMe 认证状态机的自动流转。"""
        self._authme_logged_in = False
        self._last_authme_attempt_ts = 0.0
        self._authme_attempt_cooldown = 2.5

        @On(self._bot, "login")
        def on_login(*args):
            logger.info("Bot %s logged in!", self._username)

        @On(self._bot, "spawn")
        def on_spawn(*args):
            logger.info("Bot %s spawned in world", self._username)
            self._connected = True
            try:
                self._refresh_resource_cache_sync(radius=32)
            except Exception as exc:
                logger.debug("Initial resource cache warmup failed for %s: %s", self._username, exc)

        @On(self._bot, "message")
        def on_message(this, message, *args):
            """消息监听：处理服务器广播，并对认证请求进行自动回复。"""
            msg = str(message)
            msg_lower = msg.lower()
            if self._password and self._password in msg:
                logger.debug("Bot received message: %s", msg.replace(self._password, "********"))
            else:
                logger.debug("Bot received message: %s", msg)

            if self._password and not self._authme_logged_in:
                if (
                    "you are now logged in" in msg_lower
                    or "successfully logged in" in msg_lower
                    or "successful login" in msg_lower
                    or "you have successfully registered" in msg_lower
                    or "successfully registered" in msg_lower
                    or "registration successful" in msg_lower
                    or "you are now registered" in msg_lower
                ):
                    self._authme_logged_in = True
                    logger.info("Bot %s AuthMe authenticated", self._username)
                    return

                is_system_prompt = ":" not in msg or any(
                    key in msg_lower for key in ("please", "use", "command", "authme")
                )
                if not is_system_prompt:
                    return

                needs_register = "/register" in msg_lower or "/reg" in msg_lower
                needs_login = "/login" in msg_lower or "/log" in msg_lower or "/l " in msg_lower
                if "not registered" in msg_lower or "isn't registered" in msg_lower:
                    needs_register = True
                    needs_login = False
                if "already registered" in msg_lower:
                    needs_login = True
                if "wrong password" in msg_lower:
                    logger.warning("Bot %s AuthMe password rejected", self._username)

                now = time.time()
                if now - self._last_authme_attempt_ts < self._authme_attempt_cooldown:
                    return

                cmd = None
                action = None
                if needs_register:
                    cmd = f"/register {self._password} {self._password}"
                    action = "register"
                elif needs_login:
                    cmd = f"/login {self._password}"
                    action = "login"

                if cmd:
                    try:
                        logger.info("AuthMe prompt detected, sending %s...", action)
                        self._bot.chat(cmd)
                        self._last_authme_attempt_ts = now
                        logger.info("Bot %s sent AuthMe %s command", self._username, action)
                    except Exception as exc:
                        logger.error("AuthMe %s failed: %s", action, exc)

        @On(self._bot, "kicked")
        def on_kicked(this, reason, loggedIn):
            logger.warning("Bot %s was kicked: %s", self._username, reason)
            self._connected = False

        @On(self._bot, "error")
        def on_error(this, err):
            logger.error("Bot error: %s", err)

        @On(self._bot, "end")
        def on_end(this, reason):
            logger.info("Bot %s disconnected: %s", self._username, reason)
            self._connected = False

    async def disconnect(self) -> None:
        """主动下线：优雅退出 JS 进程并清理化身状态。"""
        if self._bot:
            try:
                self._bot.quit()
            except Exception as exc:
                logger.warning("Error during disconnect: %s", exc)
            finally:
                self._bot = None
                self._connected = False

    def _get_current_position_dict(self) -> Optional[dict[str, float]]:
        """物理快照：获取当前世界实体的坐标字典。"""
        if self._js_bridge_faulted:
            return None
        try:
            entity = getattr(self._bot, "entity", None)
            position = getattr(entity, "position", None)
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="entity.position")
            return None
        if position is None:
            return None
        try:
            return self._position_to_dict(position)
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="entity.position")
            return None

    def _set_action_error(
        self,
        *,
        source: str,
        action: str,
        target: str,
        stage: str,
        raw_name: str,
        raw_message: str,
        retryable_hint: Optional[bool] = None,
        target_position: Optional[dict[str, float]] = None,
        extra: Optional[dict[str, Any]] = None,
    ) -> None:
        """错误记录：封装物理动作失败的上下文快照，为错误翻译官提供全量证据。"""
        self._last_action_error = BotActionError(
            source=source,
            action=action,
            target=target,
            stage=stage,
            raw_name=raw_name,
            raw_message=raw_message,
            position=self._get_current_position_dict(),
            target_position=target_position,
            retryable_hint=retryable_hint,
            extra=extra or {},
        )

    def _clear_action_error(self) -> None:
        """状态重置：清除上一次的物理错误留痕。"""
        self._last_action_error = None

    def consume_last_action_error(self) -> Optional[BotActionError]:
        """错误冒泡：消费并清除当前缓存的物理错误，交由上层执行器处理。"""
        error = self._last_action_error
        self._last_action_error = None
        return error
