# WebSocket Message Handlers

from abc import ABC, abstractmethod
import asyncio
import logging
import time
from typing import Optional, List, TYPE_CHECKING

from protocol import (
    MessageType, PlayerMessage, NpcResponse, BotCommand,
    BotStatus, Heartbeat, ServantCommandMessage, parse_message
)
from llm.intent import Intent, IntentRecognizer
from state.events import Event, EventType, intent_to_event_type
from text_utils import split_to_segments

if TYPE_CHECKING:
    from bot.interfaces import IBotController, IBotManager
    from llm.interfaces import ILLMClient
    from state.machine import StateMachine

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
    - 委托给状态机处理 (如果启用)
    - 调用 Bot 执行动作
    - 返回 NPC 响应
    """
    
    def __init__(
        self, 
        bot_controller: "IBotController",
        llm_client: Optional["ILLMClient"] = None,
        state_machine: Optional["StateMachine"] = None,
        context_manager = None,  # IContextManager
    ):
        self._bot = bot_controller
        self._llm = llm_client
        self._fsm = state_machine  # 状态机（可选）
        self._ctx_manager = context_manager  # 记忆上下文管理器（可选）
        self._intent_recognizer = None
        
        # 延迟初始化意图识别器
        if llm_client:
            self._intent_recognizer = IntentRecognizer(llm_client)
            logger.info("LLM-based intent recognition enabled")
        
        if state_machine:
            logger.info("State machine enabled for message handling")
        
        if context_manager:
            logger.info("Context manager enabled for memory persistence")
    
    async def handle(self, data: dict) -> Optional[dict]:
        """处理玩家消息"""
        try:
            msg = PlayerMessage.model_validate(data)
            logger.info(f"Player {msg.player} -> {msg.npc}: {msg.content}")
            
            # 特殊指令处理（硬编码快速响应）
            if msg.content.lower() == "hello":
                return await self._handle_hello(msg)
            
            # 优先使用状态机处理（如果启用）
            if self._fsm and self._intent_recognizer:
                return await self._handle_with_state_machine(msg)
            
            # LLM 意图识别（无状态机时的处理）
            if self._intent_recognizer:
                return await self._handle_with_llm(msg)
            
            # 无 LLM 时的降级处理
            return await self._handle_fallback(msg)
            
        except Exception as e:
            logger.error(f"Error handling player message: {e}")
            return None
    
    async def _handle_with_state_machine(self, msg: PlayerMessage) -> Optional[dict]:
        """
        使用状态机处理消息 (推荐路径)
        
        流程:
        1. 记录用户消息到上下文
        2. 意图识别
        3. 构造事件
        4. 委托给状态机
        5. 记录助手响应到上下文
        """
        # 获取玩家 UUID 和 Bot 名称
        player_uuid = getattr(msg, 'player_uuid', None) or msg.player
        bot_name = self._get_bot_name()
        
        # 0. 记录用户消息到记忆系统
        if self._ctx_manager:
            try:
                await self._ctx_manager.add_message(
                    player_uuid=player_uuid,
                    player_name=msg.player,
                    bot_name=bot_name,
                    role="user",
                    content=msg.content,
                )
            except Exception as e:
                logger.warning(f"Failed to record user message: {e}")
        
        # 1. 意图识别
        intent, metadata = await self._intent_recognizer.recognize(msg.content)
        logger.info(f"Intent: {intent.value}, metadata: {metadata}")
        
        # 2. 构造事件
        event_type = intent_to_event_type(intent.value)
        logger.info(f"[DEBUG] intent_to_event_type: {intent.value} -> {event_type.value}")
        
        # 注意：CLAIM 和 RELEASE 应该通过 /servant claim 等命令触发
        # 不在这里处理，由 Java 插件发送 command 类型消息
        
        # 构建 payload，包含玩家实时位置（如果 Java 插件提供了）
        payload = {
            "intent": intent.value,
            "raw_input": msg.content,
            "entities": metadata.get("entities", {}),
            "confidence": metadata.get("confidence", 0),
            "requesting_player": msg.player,  # 用于 LLM Planner 知道谁发起的任务
        }
        
        # 添加玩家实时位置（来自 Java 插件，比 Mineflayer 更准确）
        if msg.player_x is not None and msg.player_y is not None and msg.player_z is not None:
            payload["player_position"] = {
                "x": int(msg.player_x),
                "y": int(msg.player_y),
                "z": int(msg.player_z),
            }
            logger.info(f"[DEBUG] Player position from Java: ({msg.player_x:.1f}, {msg.player_y:.1f}, {msg.player_z:.1f})")
        
        event = Event(
            type=event_type,
            source_player=msg.player,
            source_player_uuid=getattr(msg, 'player_uuid', None),  # 如果有 UUID
            payload=payload
        )
        
        # 3. 委托给状态机
        logger.info(f"[DEBUG] Sending event to FSM: type={event.type.value}, player={event.source_player}")
        response = await self._fsm.process(event)
        logger.info(f"[DEBUG] FSM response: {response}")
        
        # 3.5 处理后台任务生成的内部事件 (如 PLANNING_COMPLETE)
        # 给后台任务一点时间启动和完成
        await asyncio.sleep(0.5)  # 等待后台任务触发事件
        try:
            await self._fsm.process_pending_events()
        except Exception as e:
            logger.warning(f"Error processing pending events: {e}")
        
        # 4. 如果状态机返回响应，添加必要字段
        if response:
            response.setdefault("target_player", msg.player)
            response.setdefault("type", "npc_response")
            
            # 5. 记录助手响应到记忆系统
            if self._ctx_manager:
                try:
                    response_content = response.get("content", "")
                    await self._ctx_manager.add_message(
                        player_uuid=player_uuid,
                        player_name=msg.player,
                        bot_name=bot_name,
                        role="assistant",
                        content=response_content,
                    )
                except Exception as e:
                    logger.warning(f"Failed to record assistant message: {e}")
        
        return response
    
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
        
        bot_name = self._get_bot_name()
        # DEBUG: 打印响应信息
        logger.info(f"[DEBUG] _handle_hello: building response, npc='{bot_name}', hologram='💖'")
        
        response = NpcResponse(
            npc=bot_name,
            target_player=msg.player,
            content="Ciallo~~~~",
            hologram_text="💖",
            action="greeting"
        )
        return response.model_dump()
    
    async def _handle_with_llm(self, msg: PlayerMessage) -> dict:
        """使用 LLM 处理消息"""
        # 获取玩家 UUID (如果有)
        player_uuid = getattr(msg, 'player_uuid', None) or msg.player
        bot_name = self._get_bot_name()
        
        # 记录用户消息到记忆系统
        if self._ctx_manager:
            try:
                await self._ctx_manager.add_message(
                    player_uuid=player_uuid,
                    player_name=msg.player,
                    bot_name=bot_name,
                    role="user",
                    content=msg.content,
                )
            except Exception as e:
                logger.warning(f"Failed to record user message: {e}")
        
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
            
        elif intent == Intent.GOTO:
            target_desc = entities.get("description", "您指定的位置")
            content = f"好的主人！我这就过去~"
            hologram = "🚶 移动中..."
            action = "start_goto"
            
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
            # 使用 LLM 生成闲聊回复（集成记忆系统）
            content = await self._generate_chat_response(
                msg.content, 
                msg.player,
                player_uuid=player_uuid,
            )
            hologram = "💬"
            action = "chat"
        
        # 注意：不在这里调用 self._bot.chat()
        # Java 插件会通过 WebSocket 响应来显示消息，避免重复
        
        # 记录助手回复到记忆系统
        if self._ctx_manager:
            try:
                await self._ctx_manager.add_message(
                    player_uuid=player_uuid,
                    player_name=msg.player,
                    bot_name=bot_name,
                    role="assistant",
                    content=content,
                )
            except Exception as e:
                logger.warning(f"Failed to record assistant message: {e}")
        
        bot_name = self._get_bot_name()
        # 生成分段用于全息显示
        segments = split_to_segments(content)
        
        # DEBUG: 打印构建的响应信息
        logger.info(f"[DEBUG] _handle_with_llm: building response, npc='{bot_name}', segments={len(segments)}, action='{action}'")
        
        response = NpcResponse(
            npc=bot_name,
            target_player=msg.player,
            content=content,
            segments=segments,
            hologram_text=hologram,
            action=action
        )
        return response.model_dump()
    
    async def _generate_chat_response(
        self, 
        user_input: str, 
        player_name: str,
        player_uuid: str = None,
    ) -> str:
        """
        使用 LLM 生成闲聊回复
        
        集成分层记忆系统：使用 build_chat_context 构建完整上下文
        """
        if not self._llm:
            return f"你好呀 {player_name}~"
        
        try:
            bot_name = self._get_bot_name()
            player_uuid = player_uuid or player_name
            
            # 使用 ContextManager 构建完整上下文（人格 + 记忆）
            if self._ctx_manager:
                ctx_result = await self._ctx_manager.build_chat_context(
                    player_uuid=player_uuid,
                    bot_name=bot_name,
                    player_name=player_name,
                )
                
                # 使用构建好的消息列表
                messages = ctx_result.messages.copy()
                messages.append({"role": "user", "content": user_input})
                
                # 记录调试信息
                logger.debug(
                    f"Chat context built: tokens≈{ctx_result.token_count}, "
                    f"depth={ctx_result.memory_depth}"
                )
                if ctx_result.memory_snapshot:
                    logger.debug(f"Memory snapshot:\n{ctx_result.memory_snapshot[:200]}...")
            else:
                # 降级：使用硬编码的 System Prompt
                messages = [
                    {
                        "role": "system",
                        "content": f"""你是 Minecraft 游戏中的一个可爱猫娘助手。
你的名字是 {bot_name}。
你正在和玩家 {player_name} 聊天。

回复要求：
- 保持可爱、友好的语气
- 回复简短（不超过80字）
- 可以使用表情符号
- 每句话结尾必须加一个喵~
- 如果玩家问你能做什么，告诉他们你可以帮忙建造、挖矿、种田、守卫"""
                    },
                    {"role": "user", "content": user_input}
                ]
            
            response = await self._llm.chat(
                messages=messages,
                max_tokens=150,
                temperature=0.8,
            )
            return response.strip()
            
        except Exception as e:
            logger.error(f"Chat generation failed: {e}")
            return f"你好呀 {player_name}~ 有什么可以帮你的吗？"
    
    async def _handle_fallback(self, msg: PlayerMessage) -> dict:
        """降级处理 (使用简单规则匹配)"""
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
        return Heartbeat(timestamp=int(time.time())).model_dump()


class ServantCommandHandler(IMessageHandler):
    """
    处理系统命令 (claim/release/list)
    
    职责：
    - 验证 target_bot 参数
    - 委托给状态机处理 claim/release
    - 同步到数据库
    - 发送 bot_owner_update 同步到 Java
    - 查询 BotManager 处理 list
    """
    
    def __init__(
        self,
        bot_manager: Optional["IBotManager"] = None,
        state_machine: Optional["StateMachine"] = None,
        bot_repo = None,  # IBotRepository
        ws_send_func = None,  # async callback to send WebSocket messages
    ):
        self._bot_manager = bot_manager
        self._fsm = state_machine
        self._bot_repo = bot_repo
        self._ws_send = ws_send_func
    
    async def handle(self, data: dict) -> Optional[dict]:
        """处理系统命令"""
        try:
            msg = ServantCommandMessage.model_validate(data)
            command = msg.command.lower()
            
            # 清理 target_bot (去掉 @ 前缀)
            bot_name = msg.target_bot.lstrip('@') if msg.target_bot else None
            
            logger.info(f"ServantCommand: {command} from {msg.player}, target={bot_name}")
            
            if command == "claim":
                return await self._handle_claim(msg.player, msg.player_uuid, bot_name)
            elif command == "release":
                return await self._handle_release(msg.player, msg.player_uuid, bot_name)
            elif command == "list":
                return await self._handle_list(msg.player, msg.player_uuid)
            elif command == "status":
                return await self._handle_status(msg.player, msg.player_uuid, bot_name)
            else:
                return self._error_response(f"未知命令: {command}")
                
        except Exception as e:
            logger.error(f"Error handling servant command: {e}")
            return self._error_response(str(e))
    
    async def _handle_claim(self, player: str, player_uuid: Optional[str], bot_name: Optional[str]) -> dict:
        """处理 claim 命令"""
        if not self._fsm:
            return self._error_response("后端状态机未初始化")
        
        # 如果没指定 target_bot，使用当前 Bot
        if not bot_name:
            bot_name = self._fsm.config.bot_name
            logger.info(f"No target specified, using default bot: {bot_name}")
        
        # 构造 CLAIM 事件
        event = Event(
            type=EventType.CLAIM,
            source_player=player,
            source_player_uuid=player_uuid,
            payload={"target_bot": bot_name}
        )
        
        # 委托给状态机处理
        response = await self._fsm.process(event)
        
        # 同步到数据库
        if self._bot_repo:
            try:
                await self._bot_repo.claim(bot_name, player_uuid or player, player)
                logger.info(f"[DB] Bot '{bot_name}' claimed by {player}")
            except Exception as e:
                logger.error(f"[DB] Failed to sync claim: {e}")
        
        # 发送 bot_owner_update 同步到 Java
        if self._ws_send:
            try:
                await self._ws_send({
                    "type": "bot_owner_update",
                    "bot_name": bot_name,
                    "owner_uuid": player_uuid or player,
                    "owner_name": player,
                })
                logger.info(f"[Sync] Sent bot_owner_update for {bot_name} -> {player}")
            except Exception as e:
                logger.error(f"[Sync] Failed to send bot_owner_update: {e}")
        
        if response:
            response.setdefault("target_player", player)
            return response
        
        return {
            "type": "npc_response",
            "target_player": player,
            "content": f"✅ 认领成功！{bot_name} 现在是你的女仆了~",
            "npc": bot_name,
        }
    
    async def _handle_release(self, player: str, player_uuid: Optional[str], bot_name: Optional[str]) -> dict:
        """处理 release 命令"""
        if not self._fsm:
            return self._error_response("后端状态机未初始化")
        
        # 如果没指定 target_bot，使用当前 Bot
        if not bot_name:
            bot_name = self._fsm.config.bot_name
            logger.info(f"No target specified, using default bot: {bot_name}")
        
        # 构造 RELEASE 事件
        event = Event(
            type=EventType.RELEASE,
            source_player=player,
            source_player_uuid=player_uuid,
            payload={"target_bot": bot_name}
        )
        
        # 委托给状态机处理
        response = await self._fsm.process(event)
        
        # 同步到数据库
        if self._bot_repo:
            try:
                await self._bot_repo.release(bot_name)
                logger.info(f"[DB] Bot '{bot_name}' released")
            except Exception as e:
                logger.error(f"[DB] Failed to sync release: {e}")
        
        # 发送 bot_owner_update 同步到 Java (清空所有权)
        if self._ws_send:
            try:
                await self._ws_send({
                    "type": "bot_owner_update",
                    "bot_name": bot_name,
                    "owner_uuid": None,
                    "owner_name": None,
                })
                logger.info(f"[Sync] Sent bot_owner_update for {bot_name} -> (released)")
            except Exception as e:
                logger.error(f"[Sync] Failed to send bot_owner_update: {e}")
        
        if response:
            response.setdefault("target_player", player)
            return response
        
        return {
            "type": "npc_response",
            "target_player": player,
            "content": f"✅ 已释放 {bot_name}，她现在自由了~",
            "npc": bot_name,
        }
    
    async def _handle_list(self, player: str, player_uuid: Optional[str]) -> dict:
        """处理 list 命令 - 列出玩家拥有的所有 Bot"""
        owned_bots = []
        
        def is_owner(config) -> bool:
            """检查玩家是否是主人 (匹配 UUID 或 玩家名)"""
            if config.owner_uuid == player_uuid:
                return True
            if config.owner_name == player:
                return True
            # 兼容：owner_uuid 可能存的是玩家名
            if config.owner_uuid == player:
                return True
            return False
        
        # 遍历 BotManager 中的所有 Bot
        if self._bot_manager:
            for bot_name in self._bot_manager.list_bots():
                # 获取 Bot 的状态机/配置
                # 注意：当前架构只有一个全局 FSM，未来需要每个 Bot 独立 FSM
                if self._fsm and is_owner(self._fsm.config):
                    owned_bots.append({
                        "name": self._fsm.config.bot_name,
                        "state": self._fsm.current_state.name,
                    })
        elif self._fsm:
            # 降级：只检查当前 FSM
            if is_owner(self._fsm.config):
                owned_bots.append({
                    "name": self._fsm.config.bot_name,
                    "state": self._fsm.current_state.name,
                })
        
        if owned_bots:
            bot_list = "\n".join([f"  • {b['name']} ({b['state']})" for b in owned_bots])
            content = f"📋 你的女仆列表:\n{bot_list}"
        else:
            content = "📋 你还没有认领任何女仆。使用 /servant claim @名字 来认领~"
        
        return {
            "type": "npc_response",
            "target_player": player,
            "content": content,
            "npc": "System",
        }
    
    async def _handle_status(self, player: str, player_uuid: Optional[str], bot_name: Optional[str]) -> dict:
        """处理 status 命令 - 查询 Bot 状态"""
        if not self._fsm:
            return self._error_response("后端状态机未初始化")
        
        # 如果没指定 target_bot，使用当前 Bot
        if not bot_name:
            bot_name = self._fsm.config.bot_name
        
        # 获取状态信息
        status = self._fsm.get_status()
        state = status.get("state", "unknown")
        owner = status.get("owner", "无")
        is_claimed = status.get("is_claimed", False)
        
        # 尝试获取位置
        position_str = "未知"
        if self._fsm._bot:
            try:
                pos = await self._fsm._bot.get_position()
                if pos:
                    position_str = f"({pos[0]:.0f}, {pos[1]:.0f}, {pos[2]:.0f})"
            except Exception:
                pass
        
        # 构建状态消息
        lines = [
            f"📊 {bot_name} 的状态:",
            f"  • 状态: {state}",
            f"  • 位置: {position_str}",
            f"  • 主人: {owner if is_claimed else '无主'}",
        ]
        
        if status.get("current_task"):
            lines.append(f"  • 当前任务: {status['current_task']}")
        
        return {
            "type": "npc_response",
            "target_player": player,
            "content": "\n".join(lines),
            "npc": bot_name,
        }
    
    def _error_response(self, message: str) -> dict:
        """构建错误响应"""
        return {
            "type": "error",
            "code": "servant_command_error",
            "message": message,
        }


class PlayerLoginHandler(IMessageHandler):
    """
    处理玩家登录 (AuthMe 验证通过后)
    
    职责：
    - 更新数据库玩家在线状态
    - 触发 Bot 上线逻辑
    
    设计原则：依赖抽象而非具体
    """
    
    def __init__(
        self,
        player_repo = None,  # IPlayerRepository
        bot_repo = None,     # IBotRepository
        lifecycle_manager = None,  # BotLifecycleManager
    ):
        self._player_repo = player_repo
        self._bot_repo = bot_repo
        self._lifecycle = lifecycle_manager
    
    async def handle(self, data: dict) -> Optional[dict]:
        """处理玩家登录消息"""
        uuid = data.get("player_uuid")
        name = data.get("player")
        
        if not uuid or not name:
            logger.warning(f"player_login missing uuid or name: {data}")
            return None
        
        logger.info(f"[PlayerLogin] {name} ({uuid})")
        
        # 1. 更新数据库 is_online = True
        if self._player_repo:
            try:
                await self._player_repo.set_online(uuid, name)
                logger.debug(f"[PlayerLogin] DB updated: {name} is_online=True")
            except Exception as e:
                logger.error(f"[PlayerLogin] DB update failed: {e}")
        
        # 2. 触发 Bot 生成逻辑
        if self._lifecycle:
            try:
                await self._lifecycle.on_player_event(
                    event_type="player_join",
                    player=name,
                    player_uuid=uuid,
                )
            except Exception as e:
                logger.error(f"[PlayerLogin] Lifecycle event failed: {e}")
        
        return None


class PlayerQuitHandler(IMessageHandler):
    """
    处理玩家退出 (AuthMe 登出或断开连接)
    
    职责：
    - 更新数据库玩家离线状态
    - 触发 Bot 下线倒计时
    """
    
    def __init__(
        self,
        player_repo = None,  # IPlayerRepository
        lifecycle_manager = None,  # BotLifecycleManager
    ):
        self._player_repo = player_repo
        self._lifecycle = lifecycle_manager
    
    async def handle(self, data: dict) -> Optional[dict]:
        """处理玩家退出消息"""
        uuid = data.get("player_uuid")
        name = data.get("player")
        
        if not uuid:
            logger.warning(f"player_quit missing uuid: {data}")
            return None
        
        logger.info(f"[PlayerQuit] {name} ({uuid})")
        
        # 1. 更新数据库 is_online = False
        if self._player_repo:
            try:
                await self._player_repo.set_offline(uuid)
                logger.debug(f"[PlayerQuit] DB updated: {uuid} is_online=False")
            except Exception as e:
                logger.error(f"[PlayerQuit] DB update failed: {e}")
        
        # 2. 触发 Bot 下线流程 (10h 倒计时)
        if self._lifecycle:
            try:
                await self._lifecycle.on_player_event(
                    event_type="player_quit",
                    player=name,
                    player_uuid=uuid,
                )
            except Exception as e:
                logger.error(f"[PlayerQuit] Lifecycle event failed: {e}")
        
        return None


class InitSyncHandler(IMessageHandler):
    """
    处理初始化同步 (Cold Start Sync)
    
    职责：
    - 批量更新数据库玩家在线状态
    - 触发 Bot 生成逻辑
    
    触发时机：
    - Python 后端重启后发送 request_sync
    - Java 端响应 init_sync 包含在线玩家列表
    """
    
    def __init__(
        self,
        player_repo = None,  # IPlayerRepository
        lifecycle_manager = None,  # BotLifecycleManager
    ):
        self._player_repo = player_repo
        self._lifecycle = lifecycle_manager
    
    async def handle(self, data: dict) -> Optional[dict]:
        """处理初始化同步消息"""
        players = data.get("players", [])
        use_authme = data.get("use_authme", False)
        
        logger.info(f"[InitSync] Received {len(players)} players (AuthMe={use_authme})")
        
        # 1. 先将所有玩家标记为离线
        if self._player_repo:
            try:
                count = await self._player_repo.set_all_offline()
                logger.debug(f"[InitSync] Reset {count} players to offline")
            except Exception as e:
                logger.error(f"[InitSync] Reset offline failed: {e}")
        
        # 2. 批量更新在线玩家
        if self._player_repo:
            for p in players:
                try:
                    await self._player_repo.set_online(p["uuid"], p["name"])
                except Exception as e:
                    logger.error(f"[InitSync] Failed to set online: {p}: {e}")
        
        # 3. 触发 Bot 生成逻辑
        if self._lifecycle:
            try:
                await self._lifecycle.handle_online_players_sync(players)
            except Exception as e:
                logger.error(f"[InitSync] Lifecycle sync failed: {e}")
        
        return None


class MessageRouter:
    """
    消息路由器
    
    根据消息类型分发到对应处理器
    """
    
    def __init__(
        self, 
        bot_controller: "IBotController",
        llm_client: Optional["ILLMClient"] = None,
        state_machine: Optional["StateMachine"] = None,
        bot_manager: Optional["IBotManager"] = None,
        context_manager = None,  # IContextManager
        player_repo = None,  # IPlayerRepository
        bot_repo = None,  # IBotRepository
        lifecycle_manager = None,  # BotLifecycleManager
        ws_send_func = None,  # async callback to send WebSocket messages
    ):
        self._handlers: dict[MessageType, IMessageHandler] = {
            MessageType.PLAYER_MESSAGE: PlayerMessageHandler(
                bot_controller, llm_client, state_machine, context_manager
            ),
            MessageType.HEARTBEAT: HeartbeatHandler(),
            MessageType.SERVANT_COMMAND: ServantCommandHandler(
                bot_manager, state_machine, bot_repo, ws_send_func
            ),
        }
        
        # 添加新的处理器（数据库同步相关）
        self._player_login_handler = PlayerLoginHandler(
            player_repo, bot_repo, lifecycle_manager
        )
        self._player_quit_handler = PlayerQuitHandler(
            player_repo, lifecycle_manager
        )
        self._init_sync_handler = InitSyncHandler(
            player_repo, lifecycle_manager
        )
    
    async def route(self, data: dict) -> Optional[dict]:
        """路由消息到对应处理器"""
        msg_type_str = data.get("type")
        
        # 处理新增的消息类型（不在 MessageType 枚举中）
        if msg_type_str == "player_login":
            return await self._player_login_handler.handle(data)
        elif msg_type_str == "player_quit":
            return await self._player_quit_handler.handle(data)
        elif msg_type_str == "init_sync":
            return await self._init_sync_handler.handle(data)
        
        # 处理原有消息类型
        try:
            msg_type = MessageType(msg_type_str)
            handler = self._handlers.get(msg_type)
            
            if handler:
                return await handler.handle(data)
            else:
                logger.warning(f"No handler for message type: {msg_type}")
                return None
                
        except Exception as e:
            logger.error(f"Error routing message: {e}")
            return None

