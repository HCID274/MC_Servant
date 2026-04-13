"""Mineflayer 外观导出层。"""

from .mineflayer.bot import MineflayerBot


def create_mineflayer_bot(*args, **kwargs) -> MineflayerBot:
    return MineflayerBot(*args, **kwargs)


__all__ = ["MineflayerBot", "create_mineflayer_bot"]
