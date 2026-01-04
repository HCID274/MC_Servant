# Mineflayer Bot Adapter

"""
独立的 Mineflayer Bot 实现

不依赖 VillagerAgent，使用 javascript 模块直接调用 mineflayer
"""

import asyncio
import logging
from typing import Tuple, Optional, Dict

# javascript 模块用于在 Python 中调用 Node.js 模块
from javascript import require, On

from bot.interfaces import IBotController, IBotManager

logger = logging.getLogger(__name__)


class MineflayerBot(IBotController):
    """
    Mineflayer Bot 实现
    
    使用 javascript 模块调用 Node.js 的 mineflayer 库
    """
    
    def __init__(self, host: str, port: int, username: str, password: Optional[str] = None):
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._bot = None
        self._connected = False
        
        # Node.js 模块（延迟加载）
        self._mineflayer = None
        self._pathfinder = None
        self._Vec3 = None
    
    @property
    def is_connected(self) -> bool:
        return self._connected and self._bot is not None
    
    @property
    def username(self) -> str:
        return self._username
    
    async def connect(self) -> bool:
        """连接到 Minecraft 服务器"""
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, self._init_bot)
            self._connected = True
            logger.info(f"Bot {self._username} connected to {self._host}:{self._port}")
            return True
        except Exception as e:
            logger.error(f"Failed to connect bot: {e}")
            self._connected = False
            return False
    
    def _init_bot(self):
        """初始化 Mineflayer Bot（阻塞操作）"""
        # 加载 Node.js 模块
        self._mineflayer = require('mineflayer')
        self._pathfinder = require('mineflayer-pathfinder')
        self._Vec3 = require("vec3")
        
        # 创建 Bot
        self._bot = self._mineflayer.createBot({
            "host": self._host,
            "port": self._port,
            "username": self._username,
            "checkTimeoutInterval": 600000,
            "auth": "offline",
            "version": "1.20.6",
        })
        
        # 加载插件
        self._bot.loadPlugin(self._pathfinder.pathfinder)
        
        # 加载额外插件 (collectblock, tool)
        self._load_plugins()
        
        # 注册事件处理器
        self._register_events()
    
    def _load_plugins(self):
        """
        加载 Mineflayer 插件 (collectblock, tool) 并配置 Movements
        
        在 Bot 初始化完成后调用，确保插件正确挂载
        """
        try:
            # 加载 minecraft-data (用于方块/物品查询)
            self._mcData = require('minecraft-data')(self._bot.version)
            
            # 加载 collectblock 插件 (自动采集)
            collectblock = require('mineflayer-collectblock')
            self._bot.loadPlugin(collectblock.plugin)
            
            # 加载 tool 插件 (自动选择工具)
            tool_plugin = require('mineflayer-tool')
            self._bot.loadPlugin(tool_plugin.plugin)
            
            # 配置寻路参数
            movements = self._pathfinder.Movements(self._bot, self._mcData)
            movements.canDig = True      # 允许挖掘障碍
            movements.allowParkour = True  # 允许跑酷
            self._bot.pathfinder.setMovements(movements)
            
            logger.info(f"Bot {self._username} plugins loaded: pathfinder, collectblock, tool")
        except Exception as e:
            logger.error(f"Failed to load plugins: {e}")
    
    def _register_events(self):
        """注册 Bot 事件处理器"""
        self._authme_logged_in = False  # AuthMe 登录状态标记
        
        @On(self._bot, 'login')
        def on_login(*args):
            logger.info(f"Bot {self._username} logged in!")
        
        @On(self._bot, 'spawn')
        def on_spawn(*args):
            logger.info(f"Bot {self._username} spawned in world")
            self._connected = True
        
        @On(self._bot, 'message')
        def on_message(this, message, *args):
            """监听聊天消息，检测 AuthMe 登录提示"""
            msg = str(message)
            msg_lower = msg.lower()

            # 安全日志：检查是否包含密码
            if self._password and self._password in msg:
                safe_msg = msg.replace(self._password, "********")
                logger.debug(f"Bot received message: {safe_msg}")
            else:
                logger.debug(f"Bot received message: {msg}")
            
            # 检测 AuthMe 登录/注册提示
            # 必须匹配服务器的标准提示，避免玩家聊天误触发
            # 常见提示：
            # - Please register with "/register password password"
            # - Please login with "/login password"
            # - /login <password>
            if self._password and not self._authme_logged_in:
                should_login = False

                # 关键词匹配 (更严格)
                if "/login" in msg_lower or "/register" in msg_lower:
                    # 排除玩家聊天 (简单的启发式：如果不包含冒号，或者是系统消息格式)
                    # Mineflayer 的 message 对象通常是 ChatMessage，str(message) 得到纯文本
                    # 这是一个简化的判断，防止玩家通过聊天诱骗 Bot 发送密码
                    if ":" not in msg:
                        should_login = True
                    # 如果是常见的服务器提示格式
                    elif "please" in msg_lower or "use" in msg_lower or "command" in msg_lower:
                        should_login = True

                if should_login:
                    logger.info(f"AuthMe prompt detected, sending login...")
                    try:
                        self._bot.chat(f"/login {self._password}")
                        self._authme_logged_in = True
                        logger.info(f"Bot {self._username} sent AuthMe login command")
                    except Exception as e:
                        logger.error(f"AuthMe login failed: {e}")
        
        @On(self._bot, 'kicked')
        def on_kicked(this, reason, loggedIn):
            logger.warning(f"Bot {self._username} was kicked: {reason}")
            self._connected = False
        
        @On(self._bot, 'error')
        def on_error(this, err):
            logger.error(f"Bot error: {err}")
        
        @On(self._bot, 'end')
        def on_end(this, reason):
            logger.info(f"Bot {self._username} disconnected: {reason}")
            self._connected = False
    
    async def disconnect(self) -> None:
        """断开连接"""
        if self._bot:
            try:
                self._bot.quit()
            except Exception as e:
                logger.warning(f"Error during disconnect: {e}")
            finally:
                self._bot = None
                self._connected = False
    
    async def jump(self) -> bool:
        """跳跃"""
        if not self.is_connected:
            logger.warning("Cannot jump: Bot not connected")
            return False
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, self._do_jump)
            logger.info(f"Bot {self._username} jumped!")
            return True
        except Exception as e:
            logger.error(f"Jump failed: {e}")
            return False
    
    def _do_jump(self):
        """执行跳跃（阻塞操作）"""
        import time
        self._bot.setControlState('jump', True)
        time.sleep(0.3)
        self._bot.setControlState('jump', False)
    
    async def chat(self, message: str) -> bool:
        """发送聊天消息"""
        if not self.is_connected:
            logger.warning("Cannot chat: Bot not connected")
            return False
        try:
            self._bot.chat(message)
            logger.info(f"Bot {self._username} said: {message}")
            return True
        except Exception as e:
            logger.error(f"Chat failed: {e}")
            return False
    
    async def spin(self, rotations: int = 1, duration: float = 1.0) -> bool:
        """
        原地旋转（表演动作）
        
        通过逐步修改 bot 的 yaw 角度实现旋转效果
        """
        if not self.is_connected:
            logger.warning("Cannot spin: Bot not connected")
            return False
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, lambda: self._do_spin(rotations, duration))
            logger.info(f"Bot {self._username} spinned {rotations} times!")
            return True
        except Exception as e:
            logger.error(f"Spin failed: {e}")
            return False
    
    def _do_spin(self, rotations: int, duration: float):
        """执行旋转（阻塞操作）"""
        import time
        import math
        
        # 每圈分成 16 个步骤，更平滑的旋转
        steps_per_rotation = 16
        total_steps = abs(rotations) * steps_per_rotation
        angle_per_step = (2 * math.pi / steps_per_rotation) * (1 if rotations > 0 else -1)
        step_duration = duration / steps_per_rotation
        
        for _ in range(total_steps):
            try:
                # 获取当前 yaw 并增加角度
                current_yaw = self._bot.entity.yaw
                new_yaw = current_yaw + angle_per_step
                
                # 使用 look 方法设置朝向 (yaw, pitch)
                # pitch 保持不变（水平看）
                self._bot.look(new_yaw, 0, True)  # True 表示强制更新
                time.sleep(step_duration)
            except Exception as e:
                logger.warning(f"Spin step failed: {e}")
                break
    
    async def look_at(self, target: str) -> bool:
        """
        看向目标（表演动作）
        
        Args:
            target: 目标 ("@PlayerName" 或 "x,y,z")
        """
        if not self.is_connected:
            logger.warning("Cannot look_at: Bot not connected")
            return False
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, lambda: self._do_look_at(target))
            logger.info(f"Bot {self._username} looked at {target}")
            return True
        except Exception as e:
            logger.error(f"Look at failed: {e}")
            return False
    
    def _do_look_at(self, target: str):
        """执行看向目标（阻塞操作）"""
        if target.startswith("@"):
            # 看向玩家
            player_name = target[1:]
            player = self._bot.players.get(player_name)
            if player and player.entity:
                # lookAt 会自动计算角度
                self._bot.lookAt(player.entity.position.offset(0, 1.6, 0))  # 看向玩家眼睛高度
            else:
                logger.warning(f"Player {player_name} not found")
        else:
            # 看向坐标
            parts = target.split(",")
            if len(parts) == 3:
                x, y, z = map(float, parts)
                self._bot.lookAt(self._Vec3(x, y, z))
            else:
                logger.warning(f"Invalid target format: {target}")
    
    async def get_position(self) -> Optional[Tuple[float, float, float]]:
        """获取当前位置"""
        if not self.is_connected:
            return None
        try:
            pos = self._bot.entity.position
            return (pos.x, pos.y, pos.z)
        except Exception as e:
            logger.error(f"Get position failed: {e}")
            return None


class BotManager(IBotManager):
    """
    Bot 管理器实现
    
    管理多个 MineflayerBot 实例
    """
    
    def __init__(self, mc_host: str, mc_port: int, default_password: Optional[str] = None):
        self._mc_host = mc_host
        self._mc_port = mc_port
        self._default_password = default_password
        self._bots: Dict[str, MineflayerBot] = {}
    
    def get_bot(self, name: str) -> Optional[IBotController]:
        return self._bots.get(name)
    
    async def spawn_bot(self, name: str) -> IBotController:
        """生成新的 Bot"""
        if name in self._bots:
            return self._bots[name]
        
        bot = MineflayerBot(
            host=self._mc_host,
            port=self._mc_port,
            username=name,
            password=self._default_password
        )
        
        if await bot.connect():
            self._bots[name] = bot
            return bot
        else:
            raise RuntimeError(f"Failed to spawn bot: {name}")
    
    async def spawn_bot_with_retry(
        self, 
        name: str, 
        max_retries: int = 5,
        base_delay: float = 2.0
    ) -> Optional[IBotController]:
        """
        带指数退避重试的 Bot 生成
        
        重试间隔: 5s -> 10s -> 20s -> 40s -> 80s
        
        Args:
            name: Bot 用户名
            max_retries: 最大重试次数 (默认 5)
            base_delay: 基础延迟秒数 (默认 5s)
            
        Returns:
            成功返回 Bot 实例，失败返回 None
        """
        for attempt in range(max_retries):
            try:
                return await self.spawn_bot(name)
            except Exception as e:
                delay = base_delay * (2 ** attempt)
                logger.warning(
                    f"Spawn failed (attempt {attempt + 1}/{max_retries}), "
                    f"retrying in {delay}s: {e}"
                )
                await asyncio.sleep(delay)
        
        logger.error(f"Failed to spawn {name} after {max_retries} attempts")
        return None
    
    async def remove_bot(self, name: str) -> bool:
        """移除 Bot"""
        bot = self._bots.pop(name, None)
        if bot:
            await bot.disconnect()
            return True
        return False
    
    def list_bots(self) -> list[str]:
        return list(self._bots.keys())
    
    async def shutdown(self):
        """关闭所有 Bot"""
        for name in list(self._bots.keys()):
            await self.remove_bot(name)
