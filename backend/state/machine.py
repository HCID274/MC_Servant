# State Machine
# 状态机主体 - Bot 的行为总控

import asyncio
import logging
from pathlib import Path
from typing import Optional, Dict, Any, TYPE_CHECKING

from .interfaces import IState, IStateMachine, StateResult
from .events import Event, EventType
from .context import RuntimeContext, BotContext
from .config import BotConfig, DEFAULT_CONFIG_PATH
from .permission import PermissionGate, PermissionResult
from .states import UnclaimedState, IdleState
from text_utils import split_to_segments

if TYPE_CHECKING:
    from ..llm.interfaces import ILLMClient
    from ..bot.interfaces import IBotController
    from ..task.interfaces import ITaskExecutor

logger = logging.getLogger(__name__)


class StateMachine(IStateMachine):
    """
    状态机 - Bot 的行为总控
    
    职责：
    - 管理当前状态和状态转换
    - 集成权限校验 (PermissionGate)
    - 协调 LLM 和 BotController
    - 持久化 BotConfig
    """
    
    def __init__(
        self,
        config: Optional[BotConfig] = None,
        config_path: Optional[Path] = None,
        llm_client: Optional["ILLMClient"] = None,
        bot_controller: Optional["IBotController"] = None,
        bot_context: Optional[BotContext] = None,
        executor: Optional["ITaskExecutor"] = None,
    ):
        """
        初始化状态机
        
        Args:
            config: Bot 配置（如果提供则使用，否则从文件加载）
            config_path: 配置文件路径（默认 data/bot_config.json）
            llm_client: LLM 客户端
            bot_controller: Bot 控制器
            bot_context: Bot 上下文 (DI 容器)
            executor: 任务执行器
        """
        # 配置路径
        self._config_path = config_path or DEFAULT_CONFIG_PATH
        
        # 加载或使用提供的配置
        if config:
            self._config = config
        else:
            self._config = BotConfig.load(self._config_path)
        
        # 运行时上下文
        self._context = RuntimeContext()
        
        # 依赖注入
        self._llm = llm_client
        self._bot = bot_controller
        
        # BotContext (DI 容器)
        if bot_context:
            self._bot_context = bot_context
        else:
            self._bot_context = BotContext(
                runtime=self._context,
                llm=llm_client,
                executor=executor,
            )
        
        # 权限校验器
        self._permission_gate = PermissionGate()
        
        # 初始化状态（根据配置决定）
        self._current_state: IState = self._get_initial_state()
        
        logger.info(
            f"StateMachine initialized: state={self._current_state.name}, "
            f"owner={self._config.owner_name or 'None'}"
        )
    
    def _get_initial_state(self) -> IState:
        """根据配置决定初始状态"""
        if self._config.is_claimed:
            return IdleState(bot_context=self._bot_context, llm_client=self._llm)
        else:
            return UnclaimedState(self._llm)
    
    @property
    def current_state(self) -> IState:
        return self._current_state
    
    @property
    def config(self) -> BotConfig:
        return self._config
    
    @property
    def context(self) -> RuntimeContext:
        return self._context
    
    @property
    def bot_context(self) -> BotContext:
        """获取 Bot 上下文 (DI 容器)"""
        return self._bot_context
    
    async def process_pending_events(self) -> None:
        """
        处理待处理的内部事件
        
        由后台任务 (如 PlanningState._run_planning, WorkingState._run_executor) 
        通过 BotContext.queue_event() 放入队列的事件
        
        这个方法应该在主循环中定期调用，或者在 process() 结束后调用
        """
        while self._bot_context.has_pending_events():
            event_data = self._bot_context.pop_pending_event()
            if event_data:
                event_type, payload = event_data
                internal_event = Event(
                    type=event_type,
                    source_player="__internal__",
                    payload=payload,
                )
                logger.debug(f"Processing pending internal event: {event_type}")
                response = await self.process(internal_event)
                if response and self._bot_context.on_npc_response:
                    try:
                        await self._bot_context.on_npc_response(response)
                    except Exception as e:
                        logger.warning(f"Failed to dispatch pending response: {e}")
    
    async def process(self, event: Event) -> Optional[Dict[str, Any]]:
        """
        处理事件 - 完整的处理管道
        
        流程：
        1. 权限校验
        2. 委托给当前状态处理
        3. 状态转换（如果需要）
        4. 更新配置（如 CLAIM/RELEASE）
        5. 持久化配置
        6. 执行动作（如果需要）
        7. 构建响应
        
        Args:
            event: 输入事件
            
        Returns:
            响应消息字典
        """
        logger.debug(f"Processing event: {event} in state: {self._current_state.name}")
        logger.info(f"[DEBUG] FSM.process: event.type={event.type.value}, current_state={self._current_state.name}")
        
        # 1. 权限校验
        perm_result = self._permission_gate.check(
            event, 
            self._config, 
            self._current_state.name
        )
        
        if not perm_result.allowed:
            logger.info(f"Permission denied: {perm_result.reason}")
            response = self._build_response(
                StateResult(response=perm_result.rejection_message),
                hologram_text=None,
            )
            self._attach_target_player(response, event)
            return response
        
        # 2. 特殊事件处理（在状态处理之前）
        await self._handle_special_events(event)
        
        # 3. 委托给当前状态处理
        logger.info(f"[DEBUG] Delegating to state.handle_event: state={self._current_state.name}")
        result = await self._current_state.handle_event(event, self._context)
        logger.info(f"[DEBUG] State returned: next_state={result.next_state.name if result.next_state else None}, response={result.response[:50] if result.response else None}")
        
        # 4. 状态转换
        hologram_text = None
        if result.next_state:
            await self._current_state.on_exit(self._context)
            self._current_state = result.next_state
            hologram_text = await self._current_state.on_enter(self._context)
            logger.info(f"State transition: -> {self._current_state.name}")
        
        # 使用状态返回的 hologram_text 覆盖（如果有）
        if result.hologram_text:
            hologram_text = result.hologram_text
        
        # 5. 持久化配置（如果有变更）
        self._save_config_if_needed(event)
        
        # 6. 执行动作（如果需要）
        if result.action and self._bot:
            await self._execute_action(result.action)
        
        # 7. 构建响应
        response = self._build_response(result, hologram_text)
        self._attach_target_player(response, event)
        return response
    
    async def _handle_special_events(self, event: Event) -> None:
        """
        处理特殊事件（修改配置）
        
        这些事件需要在状态处理之前更新 BotConfig
        """
        if event.type == EventType.CLAIM:
            # 认领 Bot
            player_uuid = event.source_player_uuid or event.source_player
            self._config.claim(player_uuid, event.source_player)
            
        elif event.type == EventType.RELEASE:
            # 释放 Bot
            self._config.release()
    
    def _save_config_if_needed(self, event: Event) -> None:
        """需要时保存配置到文件"""
        # 这些事件会修改配置，需要持久化
        if event.type in (EventType.CLAIM, EventType.RELEASE):
            self._config.save(self._config_path)
            logger.debug(f"Config saved to {self._config_path}")
    
    async def _execute_action(self, action: Dict[str, Any]) -> None:
        """执行动作"""
        if not self._bot:
            logger.warning("No bot controller, skipping action")
            return
        
        action_type = action.get("type")
        
        try:
            if action_type == "jump":
                await self._bot.jump()
            elif action_type == "wave":
                # 挥手（暂未实现，用跳跃代替）
                await self._bot.jump()
            elif action_type == "celebrate":
                # 庆祝（跳一下，避免连续跳跃触发反作弊）
                await self._bot.jump()
            elif action_type == "start_task":
                # 开始任务（由 TaskExecutor 处理，这里只是标记）
                logger.info("Task started signal sent")
            else:
                logger.warning(f"Unknown action type: {action_type}")
        except Exception as e:
            logger.error(f"Action execution failed: {e}")
    
    def _build_response(
        self, 
        result: StateResult, 
        hologram_text: Optional[str]
    ) -> Dict[str, Any]:
        """构建响应消息"""
        # DEBUG: 打印构建响应时的关键信息
        logger.info(f"[DEBUG] _build_response: bot_name='{self._config.bot_name}', hologram_text='{hologram_text}'")
        
        response = {
            "type": "npc_response",
            "npc": self._config.bot_name,
            "state": self._current_state.name,
        }
        
        if result.response:
            response["content"] = result.response
            # 生成分段用于全息显示
            response["segments"] = split_to_segments(result.response)
            logger.info(f"[DEBUG] Generated {len(response['segments'])} segments for hologram")
        
        if hologram_text:
            response["hologram_text"] = hologram_text
        
        if result.action:
            response["action"] = result.action.get("type")
        
        return response

    def _attach_target_player(self, response: Optional[Dict[str, Any]], event: Event) -> None:
        """Attach target_player to response if missing."""
        if not response or response.get("target_player"):
            return
        
        payload = event.payload or {}
        target_player = payload.get("target_player") or payload.get("requesting_player")
        
        if not target_player and event.source_player != "__internal__":
            target_player = event.source_player
        
        if not target_player:
            target_player = self._config.owner_name
        
        if target_player:
            response["target_player"] = target_player
    
    # ==================== 便捷方法 ====================
    
    def get_status(self) -> Dict[str, Any]:
        """获取当前状态摘要"""
        return {
            "state": self._current_state.name,
            "owner": self._config.owner_name,
            "is_claimed": self._config.is_claimed,
            "current_task": str(self._context.current_task) if self._context.current_task else None,
            "hologram": self._config.get_display_status(),
        }
    
    async def force_state(self, state: IState) -> None:
        """
        强制切换状态（调试用）
        
        跳过正常的事件处理流程
        """
        await self._current_state.on_exit(self._context)
        self._current_state = state
        await self._current_state.on_enter(self._context)
        logger.warning(f"Forced state transition to: {state.name}")
