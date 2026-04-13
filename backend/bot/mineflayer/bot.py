from bot.interfaces import IBotController

from .action import MineflayerActionMixin
from .base import MineflayerBotBase
from .environment import MineflayerEnvironmentMixin
from .lifecycle import MineflayerLifecycleMixin
from .movement import MineflayerMovementMixin


class MineflayerBot(
    MineflayerLifecycleMixin,
    MineflayerMovementMixin,
    MineflayerEnvironmentMixin,
    MineflayerActionMixin,
    MineflayerBotBase,
    IBotController,
):
    """组合后的 Mineflayer 外观对象，对外仍保持原有能力接口。"""

    pass
