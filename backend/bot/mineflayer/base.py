import asyncio
import logging
from typing import Any, Dict, Optional

from bot.interfaces import BotActionError
from config import settings


logger = logging.getLogger(__name__)


class MineflayerBotBase:
    """物理化身基座：管理 Mineflayer 实例的共享状态、JS 桥接句柄及底层错误转换工具。"""

    def __init__(
        self,
        host: str,
        port: int,
        username: str,
        password: Optional[str] = None,
        version: Optional[str] = None,
    ):
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._version = str(version or settings.mc_version or "1.20.6").strip()
        self._bot = None
        self._connected = False
        self._last_action_error: Optional[BotActionError] = None
        self._mineflayer = None
        self._pathfinder = None
        self._Vec3 = None
        self._Item = None
        self._mcData = None
        self._env_snapshot_helper = None
        self._resource_cache_helper = None
        self._craft_recipe_helper = None
        self._collect_watchdog_helper = None
        self._stair_mining_helper = None
        self._resource_cache_refresh_task: Optional[asyncio.Task] = None
        self._resource_attempt_state: Dict[str, Dict[str, set[str]]] = {}
        self._authme_logged_in = False
        self._last_authme_attempt_ts = 0.0
        self._authme_attempt_cooldown = 2.5
        self._master_name: Optional[str] = None
        self._js_bridge_faulted = False

    @property
    def is_connected(self) -> bool:
        """物理存活断言：检查 Bot 实例是否已建立网络连接。"""
        return self._connected and self._bot is not None

    @property
    def username(self) -> str:
        """化身标识：Bot 在游戏世界中的唯一玩家名。"""
        return self._username

    def set_master_name(self, player_name: Optional[str]) -> None:
        """会话绑定：记录当前任务/对话上下文中的主人名字，供跟随和交付使用。"""
        normalized = str(player_name or "").strip()
        self._master_name = normalized or None

    def _resolve_tracked_player_name(self, requested_name: Optional[str] = None) -> Optional[str]:
        """目标玩家解析：优先使用当前会话绑定的主人名字，而不是退化成任意在线玩家。"""
        normalized = str(requested_name or "").strip()
        if normalized and normalized.lower() not in {"master", "owner"}:
            return normalized
        if self._master_name:
            return self._master_name
        return None

    def _lookup_player(self, player_name: Optional[str]) -> Any:
        """玩家句柄查找：兼容 Mineflayer JS 桥对象与 Python dict 的读取差异。"""
        normalized = str(player_name or "").strip()
        if not normalized or self._bot is None:
            return None
        players = getattr(self._bot, "players", None)
        if not players:
            return None

        getter = getattr(players, "get", None)
        if callable(getter):
            try:
                player = getter(normalized)
                if player is not None:
                    return player
            except Exception:
                pass

        try:
            player = players[normalized]
            if player is not None:
                return player
        except Exception:
            pass

        try:
            for name in players:
                if str(name or "").strip() != normalized:
                    continue
                try:
                    player = players[name]
                except Exception:
                    player = None
                if player is not None:
                    return player
        except Exception:
            pass
        return None

    def _position_to_dict(self, pos: Any) -> dict[str, float]:
        """物理坐标转换：将原始 Vec3 转换为可序列化的 Python 字典。"""
        return {
            "x": round(float(getattr(pos, "x")), 2),
            "y": round(float(getattr(pos, "y")), 2),
            "z": round(float(getattr(pos, "z")), 2),
        }

    def _coerce_js_error_name(self, exc: Exception, default: str) -> str:
        """错误语义强制转换：从 JS 异常中提取类型名称，辅助错误翻译官进行分类。"""
        value = getattr(exc, "name", None) or getattr(exc, "__class__", type(exc)).__name__
        text = str(value or "").strip()
        return text or default

    def _coerce_js_error_message(self, exc: Exception, default: str) -> str:
        """错误细节转换：从 JS 异常中提取原始描述，保留物理层失败现场。"""
        text = str(exc or "").strip()
        return text or default

    def _is_js_bridge_timeout_error(self, exc: Exception) -> bool:
        """桥接异常识别：识别 Barrier 断裂与 JS 属性读取超时。"""
        text = str(exc or "").strip().lower()
        name = str(getattr(exc, "name", "") or getattr(type(exc), "__name__", "") or "").strip().lower()
        if "brokenbarriererror" in name or "brokenbarriererror" in text:
            return True
        if "timed out accessing" in text:
            return True
        if "call to '" in text and "timed out" in text:
            return True
        return False

    def _mark_js_bridge_fault(self, exc: Exception, *, context: str) -> bool:
        """桥接熔断：确认 JS IPC 已断时，后续状态读取统一降级为空值。"""
        if not self._is_js_bridge_timeout_error(exc):
            return False
        if not self._js_bridge_faulted:
            logger.warning(
                "JS bridge degraded for %s while reading %s: %s",
                self._username,
                context,
                exc,
            )
        self._js_bridge_faulted = True
        return True
