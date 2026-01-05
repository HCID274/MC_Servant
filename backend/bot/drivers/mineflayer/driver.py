# Mineflayer Driver Adapter

from __future__ import annotations

from typing import Any

from javascript import require

from bot.drivers.interfaces import IDriverAdapter


class MineflayerDriver(IDriverAdapter):
    """Mineflayer-backed driver adapter."""

    def __init__(self, bot_wrapper: Any) -> None:
        self._mf_bot = bot_wrapper
        self._bot = bot_wrapper._bot
        self._mcdata = bot_wrapper._mcData
        self._pathfinder = bot_wrapper._pathfinder
        self._Vec3 = require("vec3")

    @property
    def bot(self) -> Any:
        return self._bot

    @property
    def mcdata(self) -> Any:
        return self._mcdata

    @property
    def pathfinder(self) -> Any:
        return self._pathfinder

    @property
    def goals(self) -> Any:
        return self._pathfinder.goals

    def vec3(self, x: int, y: int, z: int) -> Any:
        return self._Vec3(x, y, z)

    def stop_pathfinder(self) -> None:
        try:
            self._bot.pathfinder.stop()
        except Exception:
            pass

    def chat(self, message: str) -> None:
        self._bot.chat(message)

    @property
    def username(self) -> str:
        try:
            return str(self._bot.username)
        except Exception:
            return ""
