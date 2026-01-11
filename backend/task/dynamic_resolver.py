# Dynamic Resolver - LLM 驱动的动态任务解决 (Slow Path)
# 
# 设计原则：
# - 仅在符号层 (PrerequisiteResolver) 返回 None 时调用
# - 注入 Tag 知识，避免 LLM 生成不合理的任务
# - 策略类型参考 VillagerAgent: decompose/insert/replan/retry/escalate

import asyncio
import json
import logging
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Dict, Any, Optional, List, TYPE_CHECKING

try:
    import json_repair
except ImportError:
    json_repair = None

from config import settings

if TYPE_CHECKING:
    from ..llm.interfaces import ILLMClient
    from ..bot.tag_resolver import ITagResolver


logger = logging.getLogger(__name__)


# ============================================================================
# Enums & Data Classes
# ============================================================================

class StrategyType(Enum):
    """
    VillagerAgent 风格的恢复策略类型
    
    使用场景：
    - DECOMPOSE: 任务太复杂 (如 "建个房子" → 分解为多个子任务)
    - INSERT: 缺少前置依赖 (如 缺木板 → 插入 "合成木板")
    - REPLAN: 当前方法不可行 (如 找不到树 → 改为探索/换区域)
    - RETRY: 瞬态错误 (如 TIMEOUT, PATH_NOT_FOUND 但附近有目标)
    - ESCALATE: 无法自主解决 (如 需要玩家输入坐标)
    """
    DECOMPOSE = "decompose"
    INSERT = "insert"
    REPLAN = "replan"
    RETRY = "retry"
    ESCALATE = "escalate"


@dataclass
class ResolutionDecision:
    """DynamicResolver 返回的决策结果"""
    strategy: StrategyType
    tasks: List[str] = field(default_factory=list)  # 生成的 goal 列表
    reason: str = ""
    raw: Optional[Dict[str, Any]] = None  # LLM 原始响应，用于调试
    
    def __repr__(self) -> str:
        return f"ResolutionDecision({self.strategy.value}, tasks={self.tasks}, reason={self.reason!r})"


# ============================================================================
# Prompt Template
# ============================================================================

DYNAMIC_RESOLVER_PROMPT = """你是 Minecraft Bot 的任务恢复规划器。当符号规则无法处理错误时，由你决策下一步。

## 当前状态
- 原始任务: {original_goal}
- 失败的动作: {failed_action}
- 错误类型: {error_code}
- 错误信息: {error_message}
- 已尝试次数: {attempt_count}

## Bot 背包
{inventory}

## Bot 位置
{position}

## 附近资源 (scan 结果)
{nearby_resources}

## 知识库提示 (重要!)
{knowledge_hints}

## 可选策略
1. **retry** - 瞬态错误，直接重试相同动作
   - 适用: TIMEOUT, PATH_BLOCKED (临时障碍), ENTITY_MOVED
   - 注意: 连续 retry 超过 3 次应改用其他策略

2. **insert** - 添加前置任务，完成后继续当前任务
   - 适用: INSUFFICIENT_MATERIALS (缺材料), NO_TOOL (缺工具), STATION_NOT_FOUND (需要工作台)
   - tasks 应是可直接执行的 goal，如 "craft wooden_pickaxe 1"

3. **replan** - 换一个方法尝试
   - 适用: TARGET_NOT_FOUND (目标不存在), 连续失败超过阈值
   - tasks 应是替代方案，如 原本 "mine oak_log" → 改为 "explore 50" 或 "mine birch_log"

4. **decompose** - 任务太复杂，分解为更简单的步骤
   - 适用: 复合任务失败，需要更细粒度的规划
   - tasks 应是有序的子任务列表

5. **escalate** - 无法自主解决，询问用户
   - 适用: 需要玩家提供具体信息 (如坐标)，或陷入死循环
   - reason 应包含清晰的问题描述

## 输出格式 (纯 JSON，无 markdown)
{{"strategy": "insert", "tasks": ["craft wooden_pickaxe 1"], "reason": "需要镐子才能采矿"}}

## 规则
1. tasks 中的每个任务应使用标准 goal 格式: "动作 物品/目标 数量"
2. 物品名必须使用 Minecraft 内部 ID (如 oak_planks，不要用"木板")
3. 优先使用背包中已有的材料，参考知识库提示
4. 如果知识库提示说有等价物品，优先使用它们
5. **禁止连续 replan 为 explore/patrol** - 如果已尝试次数 >= 2 且原任务是移动/拾取类，应返回 escalate 请求用户帮助
6. 如果失败的动作是 pickup 且错误是 TARGET_NOT_FOUND，优先返回 retry (物品可能因延迟未加载)
7. 如果连续失败 3 次以上，优先返回 escalate 而不是继续 replan
"""


# ============================================================================
# DynamicResolver Class
# ============================================================================

class DynamicResolver:
    """
    LLM 驱动的动态任务解决器 (Slow Path)
    
    设计：
    - 仅在 PrerequisiteResolver (符号层) 返回 None 时调用
    - 会注入 Tag 知识，让 LLM 知道等价物品
    - 支持 retry 机制和 JSON 修复
    
    使用方式：
        resolver = DynamicResolver(llm_client, tag_resolver)
        decision = await resolver.resolve(
            error_code="NO_TOOL",
            context={"tool_type": "pickaxe"},
            inventory={"oak_log": 5},
            bot_state={...}
        )
    """
    
    MAX_RETRIES = 2
    
    def __init__(
        self, 
        llm_client: "ILLMClient",
        tag_resolver: Optional["ITagResolver"] = None,
    ):
        self._llm = llm_client
        self._tag_resolver = tag_resolver
        logger.info(f"DynamicResolver initialized with model: {llm_client.model_name}")
    
    async def resolve(
        self,
        error_code: str,
        context: Dict[str, Any],
        inventory: Dict[str, int],
        bot_state: Dict[str, Any],
        original_goal: str = "",
        attempt_count: int = 1,
    ) -> Optional[ResolutionDecision]:
        """
        根据错误上下文动态决策恢复策略
        
        Args:
            error_code: 错误码 (如 "NO_TOOL", "INSUFFICIENT_MATERIALS")
            context: 错误上下文 (如 {"missing": {"oak_planks": 2}})
            inventory: Bot 当前背包
            bot_state: Bot 完整状态 (含位置、附近资源等)
            original_goal: 原始任务目标
            attempt_count: 已尝试次数
            
        Returns:
            ResolutionDecision: LLM 决策结果
            None: LLM 调用失败
        """
        # 构建 Prompt
        prompt = self._build_prompt(
            error_code=error_code,
            context=context,
            inventory=inventory,
            bot_state=bot_state,
            original_goal=original_goal,
            attempt_count=attempt_count,
        )
        
        messages = [
            {"role": "system", "content": "你是 Minecraft Bot 任务恢复专家。只返回 JSON，不要有任何其他文字。"},
            {"role": "user", "content": prompt},
        ]
        
        last_error = None
        
        for attempt in range(1, self.MAX_RETRIES + 1):
            try:
                raw_response = await asyncio.wait_for(
                    self._llm.chat(
                        messages=messages,
                        max_tokens=256,
                        temperature=0.3,
                    ),
                    timeout=settings.llm_chat_timeout_seconds,
                )
                
                if not raw_response or not raw_response.strip():
                    logger.warning(f"[DynamicResolver] Attempt {attempt}: Empty response")
                    continue
                
                # 解析 JSON
                parsed = self._repair_json(raw_response)
                decision = self._parse_response(parsed)
                
                if decision:
                    logger.info(f"[DynamicResolver] Decision: {decision}")
                    return decision
                    
            except asyncio.TimeoutError:
                logger.warning(f"[DynamicResolver] LLM timeout on attempt {attempt}")
                last_error = "timeout"
            except Exception as e:
                logger.exception(f"[DynamicResolver] Attempt {attempt} failed: {e}")
                last_error = str(e)
                
                # 添加格式修正
                if attempt < self.MAX_RETRIES:
                    messages.append({"role": "assistant", "content": f"(error: {e})"})
                    messages.append({"role": "user", "content": '请只返回 JSON: {"strategy": "...", "tasks": [...], "reason": "..."}'})
        
        logger.error(f"[DynamicResolver] All attempts failed, last error: {last_error}")
        return None
    
    def _build_prompt(
        self,
        error_code: str,
        context: Dict[str, Any],
        inventory: Dict[str, int],
        bot_state: Dict[str, Any],
        original_goal: str,
        attempt_count: int,
    ) -> str:
        """构建 LLM Prompt，注入 Tag 知识"""
        
        # 格式化背包
        inv_str = self._format_inventory(inventory)
        
        # 格式化位置
        position = bot_state.get("position", {})
        pos_str = f"x={position.get('x', '?')}, y={position.get('y', '?')}, z={position.get('z', '?')}"
        
        # 格式化附近资源
        nearby = bot_state.get("nearby_resources", bot_state.get("last_scan", {}))
        nearby_str = json.dumps(nearby, ensure_ascii=False) if nearby else "(无 scan 数据)"
        
        # 构建知识库提示 (关键!)
        knowledge_hints = self._build_knowledge_hints(error_code, context, inventory)
        
        # 错误信息
        failed_action = context.get("action", context.get("failed_action", "unknown"))
        error_message = context.get("message", context.get("error_message", ""))
        
        return DYNAMIC_RESOLVER_PROMPT.format(
            original_goal=original_goal,
            failed_action=failed_action,
            error_code=error_code,
            error_message=error_message,
            attempt_count=attempt_count,
            inventory=inv_str,
            position=pos_str,
            nearby_resources=nearby_str,
            knowledge_hints=knowledge_hints,
        )
    
    def _build_knowledge_hints(
        self,
        error_code: str,
        context: Dict[str, Any],
        inventory: Dict[str, int],
    ) -> str:
        """
        构建知识库提示，解决 "樱花木板 vs 橡木木板" 类问题
        
        利用 TagResolver 预处理等价物品信息
        """
        hints = []
        
        # 处理材料不足的情况
        if error_code == "INSUFFICIENT_MATERIALS":
            missing = context.get("missing", {})
            for item_name, count in missing.items():
                # 检查背包中是否有等价物品
                if self._tag_resolver:
                    equivalent = self._tag_resolver.find_available(item_name, inventory)
                    if equivalent and equivalent != item_name:
                        available_count = inventory.get(equivalent, 0)
                        hints.append(
                            f"⚡ {item_name} 可以用背包中的 {equivalent} (x{available_count}) 替代"
                        )
                    
                    # 获取该物品所属的 Tag
                    tag = self._tag_resolver.get_tag_for_item(item_name) if hasattr(self._tag_resolver, 'get_tag_for_item') else None
                    if tag:
                        hints.append(f"📦 {item_name} 属于 #{tag} 类别")
        
        # 处理工具缺失的情况
        if error_code == "NO_TOOL":
            tool_type = context.get("tool_type", "")
            min_tier = context.get("min_tier", "wooden")
            hints.append(f"🔧 需要 {min_tier} 级或更高的 {tool_type}")
            
            # 提供背包中可用的材料
            craftable_materials = []
            for item, count in inventory.items():
                if item.endswith("_planks") and count >= 2:
                    craftable_materials.append(f"{item} x{count}")
                elif item.endswith("_log") and count >= 1:
                    craftable_materials.append(f"{item} x{count} (可合成木板)")
            
            if craftable_materials:
                hints.append(f"📦 背包可用材料: {', '.join(craftable_materials)}")
        
        # 默认提示
        if not hints:
            hints.append("(无特殊知识库提示)")
        
        return "\n".join(hints)
    
    def _format_inventory(self, inventory: Dict[str, int]) -> str:
        """格式化背包为简洁字符串"""
        if not inventory:
            return "(空)"
        
        items = [f"{name}: {count}" for name, count in inventory.items() if count > 0]
        return ", ".join(items[:20])  # 限制长度
    
    def _repair_json(self, raw_str: str) -> Dict[str, Any]:
        """使用 json-repair 修复损坏的 JSON"""
        # 清理可能的 markdown 代码块
        cleaned = raw_str.strip()
        if cleaned.startswith("```"):
            lines = cleaned.split("\n")
            cleaned = "\n".join(lines[1:-1] if lines[-1].startswith("```") else lines[1:])
        
        if json_repair is not None:
            try:
                result = json_repair.repair_json(cleaned, return_objects=True, ensure_ascii=False)
                if isinstance(result, dict):
                    return result
                elif isinstance(result, str):
                    return json.loads(result)
            except Exception as e:
                logger.warning(f"[DynamicResolver] json_repair failed: {e}")
        
        return json.loads(cleaned)
    
    def _parse_response(self, response: Dict[str, Any]) -> Optional[ResolutionDecision]:
        """解析 LLM 响应为 ResolutionDecision"""
        if not isinstance(response, dict):
            logger.warning(f"[DynamicResolver] Response is not a dict: {type(response)}")
            return None
        
        strategy_raw = str(response.get("strategy", "")).strip().lower()
        
        # 映射策略类型
        strategy_map = {
            "decompose": StrategyType.DECOMPOSE,
            "insert": StrategyType.INSERT,
            "replan": StrategyType.REPLAN,
            "retry": StrategyType.RETRY,
            "escalate": StrategyType.ESCALATE,
            # 别名
            "retry_same": StrategyType.RETRY,
            "add": StrategyType.INSERT,
            "prerequisite": StrategyType.INSERT,
            "ask": StrategyType.ESCALATE,
            "clarify": StrategyType.ESCALATE,
        }
        
        strategy = strategy_map.get(strategy_raw)
        if not strategy:
            logger.warning(f"[DynamicResolver] Unknown strategy: {strategy_raw}")
            return None
        
        # 解析 tasks
        tasks_raw = response.get("tasks", [])
        if isinstance(tasks_raw, str):
            tasks = [tasks_raw]
        elif isinstance(tasks_raw, list):
            tasks = [str(t) for t in tasks_raw if t]
        else:
            tasks = []
        
        reason = str(response.get("reason", ""))
        
        return ResolutionDecision(
            strategy=strategy,
            tasks=tasks,
            reason=reason,
            raw=response,
        )


# ============================================================================
# Factory Function
# ============================================================================

def create_dynamic_resolver(
    llm_client: Optional["ILLMClient"] = None,
    tag_resolver: Optional["ITagResolver"] = None,
) -> Optional[DynamicResolver]:
    """
    工厂函数：创建 DynamicResolver 实例
    
    如果 LLM 客户端不可用，返回 None
    """
    if llm_client is None:
        try:
            from ..llm import get_llm_client
            llm_client = get_llm_client()
        except Exception as e:
            logger.warning(f"Failed to get LLM client: {e}")
            return None
    
    if tag_resolver is None:
        try:
            from ..bot.tag_resolver import get_tag_resolver
            tag_resolver = get_tag_resolver()
        except Exception as e:
            logger.warning(f"Failed to get TagResolver: {e}")
            # TagResolver 可选，继续创建
    
    return DynamicResolver(llm_client, tag_resolver)
