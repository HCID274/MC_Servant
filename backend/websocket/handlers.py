# WebSocket Message Handlers

from abc import ABC, abstractmethod
from typing import Optional, TYPE_CHECKING
import logging

from protocol import (
    MessageType, PlayerMessage, NpcResponse, BotCommand, 
    BotStatus, Heartbeat, parse_message
)

if TYPE_CHECKING:
    from bot.interfaces import IBotController
    from llm.interfaces import ILLMClient

logger = logging.getLogger(__name__)


class IMessageHandler(ABC):
    """
    消息处理器抽象接口
    
    依赖抽象：处理器不关心 Bot 的具体实现
    """
    
    @abstractmethod
    async def handle(self, data: dict) -> Optional[dict]:
        """
        处理消息，返回响应（如果有）
        
        Args:
            data: 解析后的 JSON 消息
            
        Returns:
            响应消息字典，或 None
        """
        pass


class PlayerMessageHandler(IMessageHandler):
    """
    处理玩家消息
    
    职责：
    - 解析玩家意图 (使用 LLM)
    - 调用 Bot 执行动作
    - 返回 NPC 响应
    """
    
    def __init__(
        self, 
        bot_controller: "IBotController",
        llm_client: Optional["ILLMClient"] = None,
    ):
        self._bot = bot_controller
        self._llm = llm_client
        self._intent_recognizer = None
        
        # 延迟初始化意图识别器
        if llm_client:
            from llm.intent import IntentRecognizer
            self._intent_recognizer = IntentRecognizer(llm_client)
            logger.info("LLM-based intent recognition enabled")
    
    async def handle(self, data: dict) -> Optional[dict]:
        """处理玩家消息"""
        try:
            msg = PlayerMessage.model_validate(data)
            logger.info(f"Player {msg.player} -> {msg.npc}: {msg.content}")
            
            # 特殊指令处理（硬编码快速响应）
            if msg.content.lower() == "hello":
                return await self._handle_hello(msg)
            
            # LLM 意图识别
            if self._intent_recognizer:
                return await self._handle_with_llm(msg)
            
            # 无 LLM 时的降级处理
            return await self._handle_fallback(msg)
            
        except Exception as e:
            logger.error(f"Error handling player message: {e}")
            return None
    
    def _get_bot_name(self) -> str:
        """获取当前 Bot 名称"""
        try:
            return self._bot.username
        except:
            return "MCServant_Bot"
    
    async def _handle_hello(self, msg: PlayerMessage) -> dict:
        """处理 hello 指令 (硬编码快速响应)"""
        await self._bot.jump()
        await self._bot.chat("Ciallo~~~~")
        
        response = NpcResponse(
            npc=self._get_bot_name(),
            target_player=msg.player,
            content="Ciallo~~~~",
            hologram_text="💖",
            action="greeting"
        )
        return response.model_dump()
    
    async def _handle_with_llm(self, msg: PlayerMessage) -> dict:
        """使用 LLM 处理消息"""
        from llm.intent import Intent
        
        # 识别意图
        intent, metadata = await self._intent_recognizer.recognize(msg.content)
        confidence = metadata.get("confidence", 0)
        entities = metadata.get("entities", {})
        
        logger.info(f"Intent: {intent.value}, confidence: {confidence}, entities: {entities}")
        
        # 根据意图生成响应
        if intent == Intent.BUILD:
            building_type = entities.get("building_type", "建筑")
            style = entities.get("style", "")
            content = f"好的主人！我来帮您建造{style}{building_type}~"
            hologram = "🏗️ 准备建造..."
            action = "plan_build"
            
        elif intent == Intent.MINE:
            material = entities.get("material", "矿物")
            content = f"收到！我去帮您挖{material}~"
            hologram = "⛏️ 挖矿中..."
            action = "start_mine"
            
        elif intent == Intent.FARM:
            crop = entities.get("crop", "作物")
            content = f"好的！我去处理{crop}~"
            hologram = "🌾 农作中..."
            action = "start_farm"
            
        elif intent == Intent.GUARD:
            content = "交给我吧！我会守护好这里的~"
            hologram = "🛡️ 守卫中..."
            action = "start_guard"
            
        elif intent == Intent.STATUS:
            pos = await self._bot.get_position()
            if pos:
                content = f"我在 ({pos[0]:.0f}, {pos[1]:.0f}, {pos[2]:.0f}) 哦！"
            else:
                content = "我在这里呢！"
            hologram = "📍"
            action = "report_status"
            
        elif intent == Intent.CANCEL:
            content = "好的，我停下来了~"
            hologram = "⏹️ 已停止"
            action = "cancel_task"
            
        else:  # CHAT or UNKNOWN
            # 使用 LLM 生成闲聊回复
            content = await self._generate_chat_response(msg.content, msg.player)
            hologram = "💬"
            action = "chat"
        
        # 注意：不在这里调用 self._bot.chat()
        # Java 插件会通过 WebSocket 响应来显示消息，避免重复
        
        response = NpcResponse(
            npc=self._get_bot_name(),
            target_player=msg.player,
            content=content,
            hologram_text=hologram,
            action=action
        )
        return response.model_dump()
    
    async def _generate_chat_response(self, user_input: str, player_name: str) -> str:
        """使用 LLM 生成闲聊回复"""
        if not self._llm:
            return f"你好呀 {player_name}~"
        
        try:
            messages = [
                {
                    "role": "system",
                    "content": f"""你是 Minecraft 游戏中的一个可爱猫娘助手。
你的名字是 {self._get_bot_name()}。
你正在和玩家 {player_name} 聊天。

回复要求：
- 保持可爱、友好的语气
- 回复简短（不超过50字）
- 可以使用表情符号
- 每句话结尾必须加一个喵~
- 如果玩家问你能做什么，告诉他们你可以帮忙建造、挖矿、种田、守卫"""
                },
                {"role": "user", "content": user_input}
            ]
            
            response = await self._llm.chat(
                messages=messages,
                max_tokens=100,
                temperature=0.8,
            )
            return response.strip()
            
        except Exception as e:
            logger.error(f"Chat generation failed: {e}")
            return f"你好呀 {player_name}~ 有什么可以帮你的吗？"
    
    async def _handle_fallback(self, msg: PlayerMessage) -> dict:
        """降级处理 (使用简单规则匹配)"""
        from llm.intent import IntentRecognizer, Intent
        
        # 使用简单规则匹配
        class DummyLLM:
            @property
            def model_name(self): return "dummy"
            async def chat(self, *args, **kwargs): return ""
            async def chat_json(self, *args, **kwargs): return {}
        
        recognizer = IntentRecognizer(DummyLLM())
        intent = recognizer.recognize_simple(msg.content)
        
        # 简单响应
        intent_responses = {
            Intent.BUILD: ("建造功能还在开发中~", "🏗️"),
            Intent.MINE: ("挖矿功能还在开发中~", "⛏️"),
            Intent.FARM: ("种田功能还在开发中~", "🌾"),
            Intent.GUARD: ("守卫功能还在开发中~", "🛡️"),
            Intent.STATUS: ("我在这里呢！", "📍"),
            Intent.CANCEL: ("好的~", "⏹️"),
        }
        
        content, hologram = intent_responses.get(
            intent, 
            (f"我收到了: {msg.content}", "💬")
        )
        
        response = NpcResponse(
            npc=self._get_bot_name(),
            target_player=msg.player,
            content=content,
            hologram_text=hologram,
            action=intent.value
        )
        return response.model_dump()


class HeartbeatHandler(IMessageHandler):
    """心跳处理器"""
    
    async def handle(self, data: dict) -> Optional[dict]:
        """回复心跳"""
        import time
        return Heartbeat(timestamp=int(time.time())).model_dump()


class MessageRouter:
    """
    消息路由器
    
    根据消息类型分发到对应处理器
    """
    
    def __init__(
        self, 
        bot_controller: "IBotController",
        llm_client: Optional["ILLMClient"] = None,
    ):
        self._handlers: dict[MessageType, IMessageHandler] = {
            MessageType.PLAYER_MESSAGE: PlayerMessageHandler(bot_controller, llm_client),
            MessageType.HEARTBEAT: HeartbeatHandler(),
        }
    
    async def route(self, data: dict) -> Optional[dict]:
        """路由消息到对应处理器"""
        try:
            msg_type = MessageType(data.get("type"))
            handler = self._handlers.get(msg_type)
            
            if handler:
                return await handler.handle(data)
            else:
                logger.warning(f"No handler for message type: {msg_type}")
                return None
                
        except Exception as e:
            logger.error(f"Error routing message: {e}")
            return None
