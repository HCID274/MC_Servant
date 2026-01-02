# Bot 生命周期管理器

"""
BotLifecycleManager - Bot 智能生命周期管理

职责：
- 追踪主人在线状态
- 主人上线 = Bot 上线
- 主人下线 = 启动 10h 超时计时器
- 超时后优雅告别并下线

设计原则：简单接口，深度功能，依赖抽象而非具体
"""

import asyncio
import json
import logging
from pathlib import Path
from typing import Dict, Optional, Protocol

from state.config import BotConfig

logger = logging.getLogger(__name__)


class IBotManager(Protocol):
    """Bot 管理器接口 (依赖抽象)"""
    async def spawn_bot_with_retry(self, name: str) -> Optional[object]: ...
    async def remove_bot(self, name: str) -> bool: ...
    def get_bot(self, name: str) -> Optional[object]: ...
    def list_bots(self) -> list[str]: ...


class IWebSocketManager(Protocol):
    """WebSocket 管理器接口 (依赖抽象)"""
    async def broadcast(self, message: str) -> None: ...
    async def send_personal(self, message: str, client_id: str) -> None: ...


class BotLifecycleManager:
    """
    Bot 生命周期管理器
    
    这是 Bot 们的"调度中心"，感知主人动态，智能决策 Bot 上下线
    """
    
    # 默认超时时间 (小时)
    DEFAULT_TIMEOUT_HOURS = 10.0
    
    def __init__(
        self,
        bot_manager: IBotManager,
        config_path: Path,
        ws_manager: IWebSocketManager,
        timeout_hours: float = DEFAULT_TIMEOUT_HOURS
    ):
        """
        初始化生命周期管理器
        
        Args:
            bot_manager: Bot 管理器实例
            config_path: Bot 配置文件路径
            ws_manager: WebSocket 管理器 (用于发送全息更新)
            timeout_hours: 主人离线后 Bot 下线的超时时间 (默认 10h)
        """
        self._bot_manager = bot_manager
        self._config_path = config_path
        self._ws_manager = ws_manager
        self._timeout_hours = timeout_hours
        
        # 主人在线状态: {owner_uuid: bool}
        self._owner_online: Dict[str, bool] = {}
        
        # Bot 超时计时器: {bot_name: asyncio.Task}
        self._timeout_tasks: Dict[str, asyncio.Task] = {}
        
        # 加载 Bot 配置
        self._bot_config = BotConfig.load(config_path)
        
        logger.info(f"[Lifecycle] Initialized with timeout={timeout_hours}h, bot={self._bot_config.bot_name}")
    
    async def on_player_event(
        self, 
        event_type: str, 
        player: str, 
        player_uuid: str,
        client_id: Optional[str] = None
    ) -> None:
        """
        处理玩家上下线事件 (入口方法)
        
        Args:
            event_type: 事件类型 (player_join/player_quit)
            player: 玩家名称
            player_uuid: 玩家 UUID
            client_id: WebSocket 客户端 ID (用于发送响应)
        """
        if not event_type or not player:
            return
        
        # 检查是否为某个 Bot 的主人
        if not self._bot_config.is_owner(player_uuid, player):
            logger.debug(f"[Lifecycle] {player} is not an owner, ignoring")
            return
        
        logger.info(f"[Lifecycle] Owner event: {event_type} - {player}")
        
        if event_type == "player_join":
            await self._handle_owner_online(player, player_uuid, client_id)
        elif event_type == "player_quit":
            await self._handle_owner_offline(player, player_uuid, client_id)
    
    async def handle_online_players_sync(
        self,
        players: list[dict],
        client_id: Optional[str] = None
    ) -> None:
        """
        处理初始化同步时的在线玩家列表
        
        解决问题：Python 后端重启后，主人已在线但错过了 player_join 事件
        
        Args:
            players: 在线玩家列表 [{name: str, uuid: str}, ...]
            client_id: WebSocket 客户端 ID
        """
        logger.info(f"[Lifecycle] Syncing {len(players)} online players")
        
        for player_info in players:
            name = player_info.get("name", player_info.get("player"))
            uuid = player_info.get("uuid", player_info.get("player_uuid"))
            
            if self._bot_config.is_owner(uuid, name):
                logger.info(f"[Lifecycle] Found owner {name} already online during sync")
                await self._handle_owner_online(name, uuid, client_id)
    
    async def _handle_owner_online(
        self, 
        player: str, 
        player_uuid: str,
        client_id: Optional[str] = None
    ) -> None:
        """
        主人上线处理
        
        1. 取消可能存在的超时计时器
        2. 如果 Bot 不在线，启动 Bot
        3. 确保全息显示正确
        """
        self._owner_online[player_uuid] = True
        bot_name = self._bot_config.bot_name
        
        # 取消超时计时器 (如果存在)
        if bot_name in self._timeout_tasks:
            self._timeout_tasks[bot_name].cancel()
            del self._timeout_tasks[bot_name]
            logger.info(f"[Lifecycle] Cancelled timeout timer for {bot_name}")
        
        # 检查 Bot 是否已在线
        current_bots = self._bot_manager.list_bots()
        if bot_name in current_bots:
            logger.info(f"[Lifecycle] Bot {bot_name} already online, ensuring hologram")
            # 即使 Bot 已在线，也确保全息显示正确 (可能之前被清理了)
            await self._update_hologram(bot_name, "💤 待命中", client_id)
            return
        
        # 启动 Bot (带重试)
        logger.info(f"[Lifecycle] Owner {player} online, spawning bot {bot_name}")
        try:
            bot = await self._bot_manager.spawn_bot_with_retry(bot_name)
            if bot:
                logger.info(f"[Lifecycle] Bot {bot_name} spawned successfully")
                # 发送全息更新
                await self._update_hologram(bot_name, "💤 待命中", client_id)
            else:
                logger.error(f"[Lifecycle] Failed to spawn bot {bot_name}")
        except Exception as e:
            logger.error(f"[Lifecycle] Error spawning bot {bot_name}: {e}")
    
    async def _handle_owner_offline(
        self, 
        player: str, 
        player_uuid: str,
        client_id: Optional[str] = None
    ) -> None:
        """
        主人下线处理
        
        启动超时计时器，到期后 Bot 优雅下线
        """
        self._owner_online[player_uuid] = False
        bot_name = self._bot_config.bot_name
        
        # 检查 Bot 是否在线
        current_bots = self._bot_manager.list_bots()
        if bot_name not in current_bots:
            logger.info(f"[Lifecycle] Bot {bot_name} not online, no timer needed")
            return
        
        # 取消已存在的计时器 (防止重复)
        if bot_name in self._timeout_tasks:
            self._timeout_tasks[bot_name].cancel()
        
        # 启动新的超时计时器
        logger.info(f"[Lifecycle] Owner {player} offline, starting {self._timeout_hours}h timer for {bot_name}")
        
        # 更新全息显示
        await self._update_hologram(bot_name, f"主人离开了... {self._timeout_hours}h 后下线", client_id)
        
        # 创建超时任务
        task = asyncio.create_task(self._timeout_and_quit(bot_name, client_id))
        self._timeout_tasks[bot_name] = task
    
    async def _timeout_and_quit(self, bot_name: str, client_id: Optional[str] = None) -> None:
        """
        超时后优雅下线
        
        1. 等待超时
        2. 发送告别语
        3. 更新全息
        4. 移除 Bot
        """
        try:
            # 等待超时
            await asyncio.sleep(self._timeout_hours * 3600)
            
            logger.info(f"[Lifecycle] Timeout reached for {bot_name}, initiating graceful quit")
            
            # 获取 Bot 实例并发送告别语
            bot = self._bot_manager.get_bot(bot_name)
            if bot and hasattr(bot, 'chat'):
                try:
                    await bot.chat("主人不在了，我先回去休息啦~ 下次见！")
                except Exception as e:
                    logger.warning(f"[Lifecycle] Failed to send farewell: {e}")
            
            # 更新全息
            await self._update_hologram(bot_name, "👋 再见~", client_id)
            
            # 等待一小段时间让消息发出
            await asyncio.sleep(2)
            
            # 移除 Bot
            await self._bot_manager.remove_bot(bot_name)
            logger.info(f"[Lifecycle] Bot {bot_name} quit after timeout")
            
        except asyncio.CancelledError:
            # 主人重新上线，计时器被取消
            logger.info(f"[Lifecycle] Timeout cancelled for {bot_name} (owner is back)")
        except Exception as e:
            logger.error(f"[Lifecycle] Error during timeout quit: {e}")
        finally:
            # 清理计时器引用
            self._timeout_tasks.pop(bot_name, None)
    
    async def _update_hologram(
        self, 
        bot_name: str, 
        text: str,
        client_id: Optional[str] = None
    ) -> None:
        """发送全息更新到 Java 插件"""
        if not self._ws_manager:
            return
        
        hologram_msg = {
            "type": "hologram_update",
            "npc": bot_name,
            "hologram_text": text,
            "identity_line": None
        }
        
        try:
            msg_json = json.dumps(hologram_msg, ensure_ascii=False)
            if client_id:
                await self._ws_manager.send_personal(msg_json, client_id)
            else:
                await self._ws_manager.broadcast(msg_json)
        except Exception as e:
            logger.warning(f"[Lifecycle] Failed to update hologram: {e}")
    
    def shutdown(self) -> None:
        """关闭管理器，取消所有计时器"""
        for task in self._timeout_tasks.values():
            task.cancel()
        self._timeout_tasks.clear()
        logger.info("[Lifecycle] Shutdown complete")
