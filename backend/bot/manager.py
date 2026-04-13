import asyncio
import logging
from typing import Dict, Optional

from bot.interfaces import IBotController, IBotManager
from config import settings

from .mineflayer.bot import MineflayerBot


logger = logging.getLogger(__name__)


class BotManager(IBotManager):
    """生命周期编排器：负责物理化身（Bot）的动态创建、重试连接、批量下线及池化管理。"""

    def __init__(
        self,
        mc_host: str,
        mc_port: int,
        default_password: Optional[str] = None,
        mc_version: Optional[str] = None,
    ):
        self._mc_host = mc_host
        self._mc_port = mc_port
        self._default_password = default_password
        self._mc_version = str(mc_version or settings.mc_version or "1.20.6").strip()
        self._bots: Dict[str, MineflayerBot] = {}

    def get_bot(self, name: str) -> Optional[IBotController]:
        """实例检索：按玩家名获取已激活的化身控制器。"""
        return self._bots.get(name)

    async def spawn_bot(self, name: str) -> IBotController:
        """化身孵化：创建新的物理化身并同步完成服务器握手。"""
        if name in self._bots:
            return self._bots[name]

        bot = MineflayerBot(
            host=self._mc_host,
            port=self._mc_port,
            username=name,
            password=self._default_password,
            version=self._mc_version,
        )
        if await bot.connect():
            self._bots[name] = bot
            return bot
        raise RuntimeError(f"Failed to spawn bot: {name}")

    async def spawn_bot_with_retry(
        self,
        name: str,
        max_retries: int = 5,
        base_delay: float = 2.0,
    ) -> Optional[IBotController]:
        """鲁棒连接：采用指数退避算法进行自动重连，应对瞬时网络波动。"""
        for attempt in range(max_retries):
            try:
                return await self.spawn_bot(name)
            except Exception as exc:
                delay = base_delay * (2 ** attempt)
                logger.warning(
                    "Spawn failed (attempt %s/%s), retrying in %ss: %s",
                    attempt + 1,
                    max_retries,
                    delay,
                    exc,
                )
                await asyncio.sleep(delay)
        logger.error("Failed to spawn %s after %s attempts", name, max_retries)
        return None

    async def remove_bot(self, name: str) -> bool:
        """实例回收：切断连接并从活跃池中移除指定化身。"""
        bot = self._bots.pop(name, None)
        if bot:
            await bot.disconnect()
            return True
        return False

    def list_bots(self) -> list[str]:
        """存活统计：列出当前所有在线的化身名单。"""
        return list(self._bots.keys())

    async def shutdown(self):
        """系统关停：清理所有化身连接，回收 Node.js 进程资源。"""
        for name in list(self._bots.keys()):
            await self.remove_bot(name)
