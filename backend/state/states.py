# State Implementations
# 具体状态实现

import asyncio
import io
import json
import logging
import os
import zipfile
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Optional, TYPE_CHECKING

from .interfaces import IState, StateResult
from .events import Event, EventType
from .context import RuntimeContext, BotContext
from config import settings

if TYPE_CHECKING:
    from ..llm.interfaces import ILLMClient

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _load_kb_maps() -> tuple[dict, dict]:
    kb_path = Path(__file__).parent.parent / "data" / "mc_knowledge_base.json"
    try:
        with kb_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        logger.warning(f"Failed to load knowledge base: {e}")
        return {}, {}
    return data.get("items", {}) or {}, data.get("aliases", {}) or {}


def _load_lang_from_json_file(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        logger.warning(f"Failed to load lang file: {path} ({e})")
        return {}
    return _extract_lang_map(data)


def _extract_lang_map(data: dict) -> dict:
    mapping = {}
    for key, value in data.items():
        if not isinstance(value, str):
            continue
        if key.startswith("block.minecraft.") or key.startswith("item.minecraft."):
            item_id = key.split(".", 2)[2]
            mapping[item_id] = value
    return mapping


def _load_lang_from_jar(jar_path: str) -> dict:
    jar_file = Path(jar_path)
    if not jar_file.is_file():
        return {}
    try:
        with zipfile.ZipFile(jar_file) as zf:
            lang_path = "assets/minecraft/lang/zh_cn.json"
            try:
                with zf.open(lang_path) as f:
                    data = json.load(io.TextIOWrapper(f, encoding="utf-8"))
            except KeyError:
                logger.warning("zh_cn.json not found in jar")
                return {}
    except Exception as e:
        logger.warning(f"Failed to load language file: {e}")
        return {}
    return _extract_lang_map(data)


def _load_lang_from_minecraft_assets() -> dict:
    appdata = os.getenv("APPDATA")
    if not appdata:
        return {}
    base = Path(appdata) / ".minecraft" / "assets"
    indexes_dir = base / "indexes"
    objects_dir = base / "objects"
    if not indexes_dir.is_dir() or not objects_dir.is_dir():
        return {}
    index_files = sorted(indexes_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for index_path in index_files:
        try:
            with index_path.open("r", encoding="utf-8") as f:
                index_data = json.load(f)
        except Exception:
            continue
        objects = index_data.get("objects", {})
        meta = objects.get("minecraft/lang/zh_cn.json")
        if not meta:
            continue
        hash_value = meta.get("hash", "")
        if not hash_value:
            continue
        obj_path = objects_dir / hash_value[:2] / hash_value
        data = _load_lang_from_json_file(obj_path)
        if data:
            return data
    return {}


@lru_cache(maxsize=1)
def _load_lang_map() -> dict:
    env_lang_path = os.getenv("MC_SERVANT_MC_LANG_PATH", "").strip()
    settings_lang_path = getattr(settings, "mc_lang_path", "")
    lang_path = (env_lang_path or settings_lang_path or "").strip()
    if lang_path:
        data = _load_lang_from_json_file(Path(lang_path))
        if data:
            return data

    jar_path = (settings.mc_jar_path or "").strip()
    if jar_path:
        data = _load_lang_from_jar(jar_path)
        if data:
            return data

    data = _load_lang_from_minecraft_assets()
    if data:
        return data

    return {}


def _build_tag_to_zh(aliases: dict) -> dict:
    tag_to_aliases = {}
    for alias, tag in aliases.items():
        if not isinstance(alias, str) or not isinstance(tag, str):
            continue
        if any("\u4e00" <= ch <= "\u9fff" for ch in alias):
            tag_to_aliases.setdefault(tag, []).append(alias)
    tag_to_zh = {}
    for tag, names in tag_to_aliases.items():
        preferred = [n for n in names if 2 <= len(n) <= 4]
        if preferred:
            tag_to_zh[tag] = sorted(preferred, key=len)[0]
        else:
            tag_to_zh[tag] = sorted(names, key=len)[0]
    return tag_to_zh


@lru_cache(maxsize=1)
def _get_tag_to_zh() -> dict:
    _, aliases = _load_kb_maps()
    return _build_tag_to_zh(aliases)


def _translate_by_tag(item_id: str) -> Optional[str]:
    items, _ = _load_kb_maps()
    tags = items.get(item_id) or items.get(item_id.lower())
    if not tags:
        return None
    tag_to_zh = _get_tag_to_zh()
    for tag in tags:
        name = tag_to_zh.get(tag)
        if name:
            return name
    return None


def _translate_item_name(item_id: str) -> str:
    lang_map = _load_lang_map()
    if lang_map:
        name = lang_map.get(item_id) or lang_map.get(item_id.lower())
        if name:
            return name
    name = _translate_by_tag(item_id)
    if name:
        return name
    return item_id


def _get_bot_state(bot_context: Optional["BotContext"]) -> Optional[dict]:
    if not bot_context or not bot_context.actions:
        return None
    try:
        return bot_context.actions.get_state()
    except Exception as e:
        logger.warning(f"Query get_state failed: {e}")
        return None


def _format_inventory(inventory: dict, limit: int = 10) -> str:
    if not inventory:
        return "背包是空的喵~"
    translated = []
    for item_id, count in inventory.items():
        translated.append((_translate_item_name(item_id), item_id, count))
    name_counts = Counter(name for name, _, _ in translated)
    translated.sort(key=lambda kv: (-kv[2], kv[0], kv[1]))
    display_items = []
    for name, item_id, count in translated[:limit]:
        if name_counts[name] > 1 and name != item_id:
            display_name = f"{name}({item_id})"
        else:
            display_name = name
        display_items.append(f"{display_name} x{count}")
    shown = ", ".join(display_items)
    if len(translated) > limit:
        shown += f" ...还有 {len(translated) - limit} 种物品"
    return f"背包里有: {shown}"


def _handle_query(bot_context: Optional["BotContext"], entities: Optional[dict]) -> Optional[str]:
    if not entities:
        return None
    query_type = (entities.get("query_type") or "").lower()
    if not query_type:
        return None

    state = _get_bot_state(bot_context)
    if query_type in ("inventory", "bag"):
        if not state:
            return "我现在读不到背包信息喵~"
        inventory = state.get("inventory") or {}
        return _format_inventory(inventory)

    if query_type in ("position", "location"):
        if not state:
            return "我现在不太确定位置喵~"
        pos = state.get("position") or {}
        return f"我在 ({pos.get('x', 0)}, {pos.get('y', 0)}, {pos.get('z', 0)}) 喵~"

    return None


class UnclaimedState(IState):
    """
    无主状态 - 等待认领
    
    行为：
    - 接受 CLAIM 事件 → 转换到 IdleState
    - 接受 CHAT 事件 → 回复引导认领
    - 拒绝其他任务指令
    """
    
    @property
    def name(self) -> str:
        return "unclaimed"
    
    async def on_enter(self, context: RuntimeContext) -> Optional[str]:
        context.reset_state_timer()
        return "[无主] 右键认领"
    
    async def on_exit(self, context: RuntimeContext) -> None:
        pass
    
    async def handle_event(self, event: Event, context: RuntimeContext) -> StateResult:
        if event.type == EventType.CLAIM:
            # 认领成功，转换到 IdleState
            # 注意：实际的 owner 信息由 StateMachine 在 BotConfig 中设置
            return StateResult(
                next_state=IdleState(bot_context=None, llm_client=self._llm) if hasattr(self, '_llm') else IdleState(),
                response=f"认领成功！你好主人，我是你的女仆，请多多关照喵~",
                action={"type": "jump"},  # 开心地跳一下
            )
        
        elif event.type == EventType.CHAT:
            return StateResult(
                response="你好呀~ 我现在还没有主人，你可以输入「认领」把我带回家哦~",
                hologram_text="👋",
            )
        
        elif event.type == EventType.QUERY:
            return StateResult(
                response="我是一只无主的女仆，正在等待有缘人认领我~",
            )
        
        # 其他事件（理论上被 PermissionGate 拦截了）
        return StateResult(
            response="请先认领我哦~",
        )
    
    def __init__(self, llm_client: Optional["ILLMClient"] = None):
        self._llm = llm_client


class IdleState(IState):
    """
    待命状态 - 等待主人指令
    
    行为：
    - 接受 TASK_REQUEST → 转换到 PlanningState
    - 接受 RELEASE → 转换到 UnclaimedState
    - 接受 CHAT → 调用 LLM 闲聊
    - 接受 QUERY → 报告状态
    """
    
    def __init__(self, bot_context: Optional["BotContext"] = None, llm_client: Optional["ILLMClient"] = None):
        self._ctx = bot_context
        self._llm = llm_client
    
    @property
    def name(self) -> str:
        return "idle"
    
    async def on_enter(self, context: RuntimeContext) -> Optional[str]:
        context.reset_state_timer()
        context.clear_task()
        return "💤 待命中"
    
    async def on_exit(self, context: RuntimeContext) -> None:
        pass
    
    async def handle_event(self, event: Event, context: RuntimeContext) -> StateResult:
        logger.info(f"[DEBUG] IdleState.handle_event: event.type={event.type.value}")
        
        if event.type == EventType.RELEASE:
            return StateResult(
                next_state=UnclaimedState(self._llm),
                response="好的，我自由了...再见，曾经的主人...",
                action={"type": "wave"},
            )
        
        elif event.type == EventType.TASK_REQUEST:
            # 提取任务信息
            task_type = event.payload.get("intent", "unknown")
            description = event.payload.get("description", event.payload.get("raw_input", ""))
            
            logger.info(f"[DEBUG] IdleState: TASK_REQUEST received, task_type={task_type}, description={description}")
            
            # 开始任务，转换到规划状态
            context.start_task(task_type, description, event.payload)

            # 用户可见提示：避免“只会说思考不干活”的观感
            response_text = "收到！我开始处理啦~"
            hologram_text = "💭 规划中..."
            if task_type == "goto":
                response_text = "好的主人！我这就过去~"
                hologram_text = "🚶 移动中..."
            elif task_type == "mine":
                response_text = "收到！我去帮您采集/挖矿~"
                hologram_text = "⛏️ 采集中..."
            elif task_type == "craft":
                response_text = "好的！我去合成需要的东西~"
                hologram_text = "🧰 合成中..."
            elif task_type == "give":
                response_text = "收到！我准备把东西交给您~"
                hologram_text = "📦 准备交付..."
            elif task_type == "build":
                response_text = "好耶！我来规划建造步骤~"
                hologram_text = "🏗️ 规划中..."

            return StateResult(
                next_state=PlanningState(bot_context=self._ctx, llm_client=self._llm),
                response=response_text,
                hologram_text=hologram_text,
            )
        
        elif event.type == EventType.CHAT:
            # 闲聊 + 表演动作
            logger.info(f"[DEBUG] IdleState: CHAT event received")
            chat_result = await self._generate_chat_response(event, context)
            
            response_text = chat_result.get("text", "喵~")
            actions = chat_result.get("actions", [])
            
            # 执行表演动作（如果有）
            if actions:
                logger.info(f"[DEBUG] IdleState: Executing {len(actions)} performance actions")
                # 在后台执行动作，不阻塞响应
                asyncio.create_task(self._execute_performance_actions(actions))
            
            # 截取前60个字符显示在全息上
            short_msg = response_text[:60] + "..." if len(response_text) > 60 else response_text
            return StateResult(response=response_text, hologram_text=f"💬 {short_msg}")
        
        elif event.type == EventType.QUERY:
            query_response = _handle_query(self._ctx, event.payload.get("entities"))
            if query_response:
                return StateResult(response=query_response)
            duration = context.get_state_duration()
            return StateResult(
                response=f"我正在待命中，已经等了 {int(duration)} 秒啦，随时准备接受主人的指令喵~",
            )
        
        return StateResult(response="喵？")
    
    async def _generate_chat_response(self, event: Event, context: RuntimeContext) -> dict:
        """
        使用 LLM 生成闲聊回复 + 表演动作
        
        JSON 解析失败时自动重试，最多 3 次
        
        Returns:
            {
                "text": "回复文字",
                "actions": [{"type": "spin", "rotations": 2}, {"type": "jump"}]  # 可选
            }
        """
        if not self._llm:
            return {"text": "主人好~ (LLM 未配置，无法进行深度对话)", "actions": []}
        
        MAX_RETRIES = 3
        user_input = event.payload.get("raw_input", "")
        
        try:
            # 添加用户消息到统一记忆服务
            user_input = event.payload.get("raw_input", "")
            sender_uuid = event.source_player_uuid or event.source_player
            if self._ctx and self._ctx.memory:
                self._ctx.memory.add_message(
                    role="user",
                    content=user_input,
                    sender_uuid=sender_uuid,
                    sender_name=event.source_player,
                )
            
            # 构建消息 - 增强版 prompt 支持表演动作
            system_prompt = f"""你是一个可爱的 Minecraft 女仆助手，说话要可爱俏皮，每句话结尾都要加上「喵~」。
你的主人是 {event.source_player}。

## 表演能力
你不仅会说话，还能用实际动作来表达自己！当主人让你做某些表演动作时，你要在回复中包含动作指令。

## 可用动作
- spin: 原地转圈 (参数: rotations=圈数, 正数顺时针、负数逆时针)
- jump: 跳跃
- look_at: 看向主人 (参数: target="@主人名字")

## 响应格式 (必须严格遵守!)
只输出一个 JSON 对象，格式如下:
{{"text": "你的回复", "actions": []}}

## 示例
用户: "给我跳个舞"
{{"text": "好的主人！看我的专属舞蹈喵~ ✧(≖ ◡ ≖✿)", "actions": [{{"type": "look_at", "target": "@{event.source_player}"}}, {{"type": "spin", "rotations": 2}}, {{"type": "jump"}}]}}

用户: "今天天气怎么样"
{{"text": "主人~我是女仆不是天气预报喵，不过只要和主人在一起，每天都是好天气呀！♪(^∇^*)", "actions": []}}

## 重要
- 只输出 JSON，不要有任何其他文字
- 不要使用 markdown 代码块
- 表演请求（跳舞、转圈、看我等）要包含动作
- 普通对话不需要动作，actions 填空数组 []"""

            last_response = None
            
            for attempt in range(1, MAX_RETRIES + 1):
                # 获取对话历史 (优先使用 MemoryFacade)
                if self._ctx and self._ctx.memory:
                    chat_history = self._ctx.memory.get_hot_buffer()
                else:
                    chat_history = context.get_conversation_for_llm()
                
                messages = [
                    {"role": "system", "content": system_prompt},
                    *chat_history
                ]
                
                # 重试时追加格式修正提示
                if attempt > 1:
                    messages.append({
                        "role": "user", 
                        "content": f"请用纯 JSON 格式回复，不要有其他文字。格式: {{\"text\": \"...\", \"actions\": []}}"
                    })
                
                response = await self._llm.chat(messages, max_tokens=512, temperature=0.7)
                last_response = response
                
                if not response or not response.strip():
                    logger.warning(f"LLM returned empty response (attempt {attempt}/{MAX_RETRIES})")
                    continue
                
                # 尝试解析 JSON
                parsed_result = self._try_parse_json_response(response)
                if parsed_result is not None:
                    logger.info(f"[Chat] JSON parsed successfully on attempt {attempt}")
                    # 记录助手回复到统一记忆服务
                    if self._ctx and self._ctx.memory:
                        self._ctx.memory.add_message(
                            role="assistant",
                            content=parsed_result["text"],
                            sender_uuid=self._ctx.bot.username if self._ctx.bot else "bot",
                            sender_name=self._ctx.bot.username if self._ctx.bot else "Bot",
                        )
                    return parsed_result
                else:
                    logger.warning(f"[Chat] JSON parse failed (attempt {attempt}/{MAX_RETRIES})")
            
            # 所有重试都失败，使用最后一次响应作为纯文字
            logger.warning(f"[Chat] All {MAX_RETRIES} attempts failed, using plain text fallback")
            fallback_text = last_response.strip() if last_response else "喵？"
            if self._ctx and self._ctx.memory:
                self._ctx.memory.add_message(
                    role="assistant",
                    content=fallback_text,
                    sender_uuid=self._ctx.bot.username if self._ctx.bot else "bot",
                    sender_name=self._ctx.bot.username if self._ctx.bot else "Bot",
                )
            return {"text": fallback_text, "actions": []}
            
        except Exception as e:
            logger.error(f"Chat generation failed: {e}")
            return {"text": "啊...我脑子有点转不过来了，再说一遍好吗喵~", "actions": []}
    
    def _try_parse_json_response(self, response: str) -> dict | None:
        """
        尝试解析 LLM 响应中的 JSON
        
        Returns:
            成功返回 {"text": ..., "actions": [...]}, 失败返回 None
        """
        try:
            response_text = response.strip()
            
            # 处理 markdown 代码块
            if response_text.startswith("```"):
                lines = response_text.split("\n")
                json_lines = []
                in_block = False
                for line in lines:
                    if line.startswith("```"):
                        in_block = not in_block
                        continue
                    if in_block:
                        json_lines.append(line)
                response_text = "\n".join(json_lines).strip()
            
            # 尝试提取 JSON 对象（处理可能的前导/尾随文字）
            start_idx = response_text.find("{")
            end_idx = response_text.rfind("}") + 1
            if start_idx != -1 and end_idx > start_idx:
                response_text = response_text[start_idx:end_idx]
            
            parsed = json.loads(response_text)
            text = parsed.get("text", "喵~")
            actions = parsed.get("actions", [])
            
            # 验证动作格式
            valid_actions = []
            for action in actions:
                if isinstance(action, dict) and action.get("type") in ["spin", "jump", "look_at"]:
                    valid_actions.append(action)
            
            return {"text": text, "actions": valid_actions}
            
        except (json.JSONDecodeError, Exception):
            return None
    
    async def _execute_performance_actions(self, actions: list) -> None:
        """执行表演动作序列"""
        if not self._ctx or not self._ctx.bot:
            logger.warning("No bot controller available for performance actions")
            return
        
        bot = self._ctx.bot
        
        for action in actions:
            action_type = action.get("type")
            try:
                if action_type == "jump":
                    await bot.jump()
                    await asyncio.sleep(0.3)  # 跳跃后短暂等待
                    
                elif action_type == "spin":
                    rotations = action.get("rotations", 1)
                    duration = action.get("duration", 0.8)
                    await bot.spin(rotations, duration)
                    
                elif action_type == "look_at":
                    target = action.get("target", "")
                    if target:
                        await bot.look_at(target)
                        await asyncio.sleep(0.2)
                        
            except Exception as e:
                logger.warning(f"Performance action '{action_type}' failed: {e}")
    


class PlanningState(IState):
    """
    规划状态 - Auto-Start 模式
    
    行为：
    - 进入时启动后台规划任务 (不阻塞状态机)
    - 规划完成后自动触发 PLANNING_COMPLETE → 转换到 WorkingState
    - 接受 TASK_CANCEL → 返回 IdleState
    - 接受 CHAT → 简短回复
    
    设计：使用 asyncio.create_task 避免阻塞 on_enter
    """
    
    def __init__(self, bot_context: Optional["BotContext"] = None, llm_client: Optional["ILLMClient"] = None):
        self._ctx = bot_context
        self._llm = llm_client
        self._planning_task: Optional[asyncio.Task] = None
    
    @property
    def name(self) -> str:
        return "planning"
    
    async def on_enter(self, context: RuntimeContext) -> Optional[str]:
        """进入规划状态，启动后台规划任务"""
        context.reset_state_timer()
        
        task = context.current_task
        if not task:
            return "❌ 无任务"
        
        # 发送开始消息 (通过 BotContext 回调)
        if self._ctx and self._ctx.on_chat_message:
            try:
                await self._ctx.on_chat_message(f"好的，开始{task.description}...")
            except Exception as e:
                logger.warning(f"Failed to send chat message: {e}")
        
        # 启动后台规划任务 (不阻塞 on_enter)
        self._planning_task = asyncio.create_task(
            self._run_planning(context)
        )
        
        return "💭 规划中..."
    
    async def _run_planning(self, context: RuntimeContext) -> None:
        """
        后台规划协程
        
        规划逻辑实际由 TaskExecutor.execute() 内部的 LLMPlanner 处理，
        这里只需标记规划完成，触发自动转入 WORKING 状态
        """
        task = context.current_task
        if not task:
            if self._ctx:
                await self._ctx.queue_event_async(EventType.TASK_FAILED, {"error": "无任务"})
            return
        
        # 规划阶段实际不需要做什么，executor.execute() 会自己规划
        # 这里只是给用户一个视觉反馈，稍微延迟一下再进入 WORKING
        await asyncio.sleep(0.3)  # 短暂延迟，让全息显示有时间更新
        
        # 规划完成，触发进入 WORKING (使用异步版本立即通知)
        if self._ctx:
            requesting_player = None
            if task and isinstance(task.params, dict):
                requesting_player = task.params.get("requesting_player")
            payload = {}
            if requesting_player:
                payload["requesting_player"] = requesting_player
            await self._ctx.queue_event_async(EventType.PLANNING_COMPLETE, payload)
    
    async def on_exit(self, context: RuntimeContext) -> None:
        """退出时取消未完成的规划任务"""
        if self._planning_task and not self._planning_task.done():
            self._planning_task.cancel()
            try:
                await self._planning_task
            except asyncio.CancelledError:
                pass
    
    async def handle_event(self, event: Event, context: RuntimeContext) -> StateResult:
        if event.type == EventType.PLANNING_COMPLETE:
            # 规划完成，自动进入 WORKING (无需用户确认)
            return StateResult(
                next_state=WorkingState(bot_context=self._ctx, llm_client=self._llm),
                hologram_text="🔨 工作中",
            )
        
        # 兼容旧逻辑：手动确认也可以进入 WORKING
        elif event.type == EventType.TASK_CONFIRM:
            return StateResult(
                next_state=WorkingState(bot_context=self._ctx, llm_client=self._llm),
                response="好的，开始干活啦！",
                hologram_text="🔨 工作中",
                action={"type": "start_task"},
            )
        
        elif event.type == EventType.TASK_CANCEL:
            return StateResult(
                next_state=IdleState(bot_context=self._ctx, llm_client=self._llm),
                response="好的，取消了喵~",
                hologram_text="💤 待命中",
            )
        
        elif event.type == EventType.TASK_REQUEST:
            # 避免重复下发任务导致“反复思考”的无效循环
            task = context.current_task
            if task:
                return StateResult(
                    response=f"我正在规划「{task.description}」，稍等一下喵~（想换任务请先说“取消/停”）",
                    hologram_text="💭 思考中...",
                )
            return StateResult(response="我正在规划中喵~", hologram_text="💭 思考中...")

        elif event.type == EventType.CHAT:
            # 规划中，简短回复
            return StateResult(
                response="等一下喵，我正在想方案呢...",
                hologram_text="💭 思考中...",
            )
        
        elif event.type == EventType.QUERY:
            query_response = _handle_query(self._ctx, event.payload.get("entities"))
            if query_response:
                return StateResult(response=query_response)
            task = context.current_task
            if task:
                return StateResult(
                    response=f"我正在规划「{task.description}」任务，请稍等喵~",
                )
            return StateResult(response="我正在思考中喵~")
        
        return StateResult()




class WorkingState(IState):
    """
    工作状态 - 执行任务
    
    行为：
    - 进入时启动 TaskExecutor 后台任务
    - 接受 TASK_COMPLETE → 返回 IdleState
    - 接受 TASK_FAILED → 返回 IdleState (附带失败信息)
    - 接受 TASK_STOP / TASK_CANCEL → 取消执行，返回 IdleState
    - 接受 CHAT → 简短回复，不中断工作
    
    设计：
    - 使用 asyncio.create_task 后台执行任务
    - 通过 BotContext.queue_event 触发状态转换
    - 支持 on_progress 回调更新全息显示
    """
    
    def __init__(self, bot_context: Optional["BotContext"] = None, llm_client: Optional["ILLMClient"] = None):
        self._ctx = bot_context
        self._llm = llm_client
        self._executor_task: Optional[asyncio.Task] = None
    
    @property
    def name(self) -> str:
        return "working"
    
    async def on_enter(self, context: RuntimeContext) -> Optional[str]:
        """进入工作状态，启动 TaskExecutor 后台任务"""
        context.reset_state_timer()
        task = context.current_task
        task_name = task.task_type if task else "任务"
        
        # 启动后台执行任务
        self._executor_task = asyncio.create_task(
            self._run_executor(context)
        )
        
        return f"🔨 {task_name}中"
    
    async def _run_executor(self, context: RuntimeContext) -> None:
        """
        后台执行协程
        
        调用 TaskExecutor.execute() 执行任务，完成后触发事件
        """
        task = context.current_task
        if not task:
            if self._ctx:
                await self._ctx.queue_event_async(EventType.TASK_FAILED, {"error": "无任务"})
            return
        requesting_player = None
        if isinstance(task.params, dict):
            requesting_player = task.params.get("requesting_player")
        
        # 检查 executor 是否可用
        if not self._ctx or not self._ctx.executor:
            logger.warning("No executor available, simulating task execution")
            # 模拟执行 (用于测试/无 executor 场景)
            await asyncio.sleep(1)
            if self._ctx:
                payload = {}
                if requesting_player:
                    payload["requesting_player"] = requesting_player
                await self._ctx.queue_event_async(EventType.TASK_COMPLETE, payload)
            return
        
        try:
            # 设置进度回调 (节流)
            async def on_progress(msg: str):
                if self._ctx:
                    await self._ctx.update_hologram_throttled(f"🔨 {msg}")
            
            # 如果 executor 支持 on_progress，设置回调
            # 注意：当前 TaskExecutor 通过构造函数注入 on_progress
            # 这里我们通过 BotContext 的回调间接实现
            
            # 设置 owner_name 用于 give 命令 (从 task params 获取)
            if requesting_player and hasattr(self._ctx.executor, "_owner_name"):
                self._ctx.executor._owner_name = requesting_player
                logger.debug(f"Set executor owner_name to: {requesting_player}")
            
            # 设置玩家实时位置（来自 Java 插件，比 Mineflayer 更准确）
            player_position = task.params.get("player_position")
            if player_position and hasattr(self._ctx.executor, "_owner_position"):
                self._ctx.executor._owner_position = player_position
                logger.info(f"[DEBUG] Set executor owner_position from Java: {player_position}")
            
            # 执行任务（透传 task_type / payload，用于“循环决策”等能力）
            result = await self._ctx.executor.execute(
                task.description,
                task_type=getattr(task, "task_type", None),
                task_payload=getattr(task, "params", None),
            )
            
            # 触发结果事件
            if result.success:
                payload = {
                    "message": result.message,
                    "completed_steps": len(result.completed_steps),
                }
                if requesting_player:
                    payload["requesting_player"] = requesting_player
                await self._ctx.queue_event_async(EventType.TASK_COMPLETE, payload)
            else:
                payload = {"error": result.message}
                if requesting_player:
                    payload["requesting_player"] = requesting_player
                await self._ctx.queue_event_async(EventType.TASK_FAILED, payload)
                
        except asyncio.CancelledError:
            logger.info("Task execution cancelled")
            # 不在这里重新抛出，或者抛出也没关系，外层已结束
            # raise
        except Exception as e:
            logger.error(f"Task execution error: {e}")
            if self._ctx:
                payload = {"error": str(e)}
                if requesting_player:
                    payload["requesting_player"] = requesting_player
                await self._ctx.queue_event_async(EventType.TASK_FAILED, payload)
    
    async def on_exit(self, context: RuntimeContext) -> None:
        """退出时取消执行任务并清理"""
        logger.debug("WorkingState.on_exit: Starting cleanup...")
        
        # 1. 首先尝试取消 TaskExecutor 内部的执行逻辑
        if self._ctx and self._ctx.executor:
            try:
                # 明确调用 cancel，确保底层任务被通知
                if hasattr(self._ctx.executor, "cancel"):
                    logger.info("Cancelling task executor...")
                    # 如果 executor.cancel 是 async，需要 await
                    if asyncio.iscoroutinefunction(self._ctx.executor.cancel):
                        await self._ctx.executor.cancel()
                    else:
                        self._ctx.executor.cancel()
            except Exception as e:
                logger.warning(f"Failed to cancel executor: {e}")

        # 2. 取消后台包装任务
        if self._executor_task and not self._executor_task.done():
            self._executor_task.cancel()
            try:
                # 设置超时，防止死锁或长时间挂起
                await asyncio.wait_for(self._executor_task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                logger.info("Background executor task cancelled (or timed out).")
            except Exception as e:
                logger.error(f"Error while cancelling background task: {e}")
        
        # 3. 彻底清理任务状态（无论成功还是失败）
        context.clear_task()
        logger.debug("WorkingState.on_exit: Task context cleared.")
    
    async def handle_event(self, event: Event, context: RuntimeContext) -> StateResult:
        if event.type == EventType.TASK_COMPLETE:
            return StateResult(
                next_state=IdleState(bot_context=self._ctx, llm_client=self._llm),
                response="任务完成啦！主人看看满意吗喵~",
                hologram_text="💤 待命中",
                action={"type": "celebrate"},
            )
        
        elif event.type == EventType.TASK_FAILED:
            error = event.payload.get("error", "未知错误")
            return StateResult(
                next_state=IdleState(bot_context=self._ctx, llm_client=self._llm),
                response=f"呜呜，任务失败了...原因：{error}，对不起主人喵~",
                hologram_text="💤 待命中",
            )
        
        elif event.type in (EventType.TASK_CANCEL, EventType.TASK_STOP):
            # 用户请求停止 - cancel 在 on_exit 中处理
            return StateResult(
                next_state=IdleState(bot_context=self._ctx, llm_client=self._llm),
                response="好的，停下来了喵~",
                hologram_text="💤 待命中",
            )
        
        elif event.type == EventType.TASK_REQUEST:
            # 工作中收到新任务：引导用户先停止/取消，避免任务编排乱序导致“只回复不执行”
            task = context.current_task
            if task:
                return StateResult(
                    response=f"我正在执行「{task.description}」，想换任务的话先说“停/取消”喵~",
                    hologram_text="🔨 工作中",
                )
            return StateResult(response="我在忙着呢喵~", hologram_text="🔨 工作中")

        elif event.type == EventType.CHAT:
            # 工作中，简短回复（不中断工作）
            task = context.current_task
            if task:
                progress = task.progress * 100
                return StateResult(
                    response=f"忙着呢~ 进度 {progress:.0f}%，等会儿再聊喵~",
                    hologram_text="🔨 工作中",
                )
            return StateResult(response="忙着呢喵~", hologram_text="🔨 工作中")
        
        elif event.type == EventType.QUERY:
            query_response = _handle_query(self._ctx, event.payload.get("entities"))
            if query_response:
                return StateResult(response=query_response)
            task = context.current_task
            if task:
                progress = task.progress * 100
                duration = context.get_state_duration()
                return StateResult(
                    response=(
                        f"正在执行「{task.description}」\n"
                        f"进度: {progress:.0f}% | 已用时: {int(duration)}秒"
                    ),
                )
            return StateResult(response="正在工作中喵~")
        
        return StateResult()
