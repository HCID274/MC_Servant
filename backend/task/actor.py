# LLM Task Actor Implementation
# LLM 驱动的任务决策者
#
# 设计原则：
# - 只输出语义意图，不输出坐标
# - 每次决策只产出 1 个 ActorDecision

import json
import logging
from typing import Dict, Any, List, Optional, TYPE_CHECKING

from .actor_interfaces import (
    ActorDecision,
    ActorActionType,
    ITaskActor,
)

if TYPE_CHECKING:
    from ..llm.interfaces import ILLMClient
    from ..perception.interfaces import IKnowledgeBase

logger = logging.getLogger(__name__)


# ============================================================================
# Actor System Prompt
# ============================================================================

ACTOR_SYSTEM_PROMPT = """你是 Minecraft 机器人的决策大脑。根据任务目标和当前状态，决定**下一步**要做什么。

## 核心规则
1. **每次只输出 1 个动作**
2. **只输出语义目标，不要输出坐标**（坐标由执行层计算）
3. 优先完成主任务，遇到障碍时合理应对

## 可用动作

### 1. mine - 采集资源
目标填写资源类型（如 logs, iron_ore, cobblestone），系统会自动找到并采集
```json
{"action": "mine", "target": "logs", "params": {"count": 5}}
```

### 2. goto - 导航
目标可以是: "owner"（主人位置）, "坐标字符串 x,y,z"
```json
{"action": "goto", "target": "owner"}
```

### 3. craft - 合成
```json
{"action": "craft", "target": "wooden_pickaxe", "params": {"count": 1}}
```

### 4. give - 交付物品给主人
```json
{"action": "give", "target": "oak_log", "params": {"count": 10}}
```

### 5. scan - 扫描周围
用于查看附近有什么资源
```json
{"action": "scan", "target": "logs", "params": {"radius": 32}}
```

### 6. clarify - 向玩家提问
当任务不明确时使用。优先使用默认值，只有完全无法理解时才提问
```json
{"action": "clarify", "params": {"question": "您想要哪种木头？", "choices": ["橡木", "白桦木", "任意"], "default": "任意"}}
```

### 7. done - 任务完成
```json
{"action": "done", "params": {"message": "采集完成！共获得 10 个木头"}}
```

## 决策规则

1. **last_result 为空或成功** → 继续执行任务
2. **last_result 失败 + error_code=TARGET_NOT_FOUND** → 尝试 scan 或扩大搜索范围
3. **last_result 失败 + error_code=NO_TOOL** → 先 craft 工具
4. **背包已满** → 先 give 给主人
5. **任务目标不明确** → clarify（但优先用默认值）
6. **目标数量已达成** → done

## 语义目标映射（你不需要记，只需要用语义词）
- "木头/wood/logs" → 各种原木
- "石头/stone" → 圆石/石头
- "矿石/ores" → 铁矿/金矿/钻石矿等

## 输出格式 (纯 JSON)
{"action": "动作名", "target": "语义目标", "params": {...}, "reasoning": "简短理由"}
"""


# ============================================================================
# LLMTaskActor Implementation
# ============================================================================

class LLMTaskActor(ITaskActor):
    """
    LLM 驱动的任务决策者
    
    职责：
    - 根据任务目标和状态决策下一步
    - 只输出语义意图，不输出坐标
    """
    
    def __init__(
        self, 
        llm_client: "ILLMClient",
        knowledge_base: Optional["IKnowledgeBase"] = None
    ):
        """
        初始化 Actor
        
        Args:
            llm_client: LLM 客户端
            knowledge_base: 知识库 (可选，用于验证目标合法性)
        """
        self._llm = llm_client
        self._kb = knowledge_base
    
    async def decide(
        self,
        task_goal: str,
        bot_state: Dict[str, Any],
        last_result: Optional[Dict[str, Any]] = None
    ) -> ActorDecision:
        """
        决策下一步动作
        
        Args:
            task_goal: 任务目标
            bot_state: Bot 状态
            last_result: 上一步结果
        
        Returns:
            ActorDecision: 语义决策
        """
        # 构建用户消息
        user_message = self._build_user_message(task_goal, bot_state, last_result)
        
        messages = [
            {"role": "system", "content": ACTOR_SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ]
        
        try:
            response = await self._llm.chat_json(
                messages=messages,
                max_tokens=256,
                temperature=0.2,
            )
            
            return self._parse_response(response)
            
        except Exception as e:
            logger.error(f"Actor decide failed: {e}")
            # 返回一个安全的默认动作
            return ActorDecision(
                action=ActorActionType.SCAN,
                target="block",
                params={"radius": 32},
                reasoning=f"决策失败，执行默认扫描: {str(e)}"
            )
    
    def _build_user_message(
        self,
        task_goal: str,
        bot_state: Dict[str, Any],
        last_result: Optional[Dict[str, Any]]
    ) -> str:
        """构建用户消息"""
        # 精简 bot_state，只保留必要信息
        simplified_state = {}
        
        # 位置
        if "position" in bot_state:
            pos = bot_state["position"]
            simplified_state["position"] = f"({pos.get('x', 0)}, {pos.get('y', 0)}, {pos.get('z', 0)})"
        
        # 背包 (只显示主要物品)
        if "inventory" in bot_state:
            inv = bot_state["inventory"]
            if isinstance(inv, dict) and inv:
                # 只保留前 10 个物品
                items = list(inv.items())[:10]
                simplified_state["inventory"] = dict(items)
        
        # 健康状态
        if "health" in bot_state:
            simplified_state["health"] = bot_state["health"]
        if "food" in bot_state:
            simplified_state["food"] = bot_state["food"]
        
        # 主人信息
        if "owner_name" in bot_state:
            simplified_state["owner_name"] = bot_state["owner_name"]
        if "owner_position" in bot_state:
            owner_pos = bot_state["owner_position"]
            if isinstance(owner_pos, dict):
                simplified_state["owner_position"] = f"({owner_pos.get('x', 0)}, {owner_pos.get('y', 0)}, {owner_pos.get('z', 0)})"
        
        # 上次扫描结果
        if "last_scan" in bot_state:
            scan = bot_state["last_scan"]
            if isinstance(scan, dict):
                targets = scan.get("targets", [])
                if targets:
                    simplified_state["last_scan"] = f"{len(targets)} targets found"
                else:
                    simplified_state["last_scan"] = "no targets found"
        
        # 构建消息
        data = {
            "task_goal": task_goal,
            "bot_state": simplified_state,
        }
        
        if last_result:
            # 精简 last_result
            data["last_result"] = {
                "action": last_result.get("action"),
                "success": last_result.get("success"),
                "error_code": last_result.get("error_code"),
                "message": last_result.get("message", "")[:100],  # 截断
            }
        
        return json.dumps(data, ensure_ascii=False, indent=None)
    
    def _parse_response(self, response: Any) -> ActorDecision:
        """解析 LLM 响应"""
        if not isinstance(response, dict):
            raise ValueError(f"Invalid response format: {response}")
        
        action = response.get("action", "")
        target = response.get("target")
        params = response.get("params", {}) or {}
        reasoning = response.get("reasoning", "")
        
        # 验证必要字段
        if not action:
            raise ValueError(f"Missing action in response: {response}")
        
        # 标准化 action 名称
        action = action.lower().strip()
        
        # 处理 done 动作
        if action == "done":
            return ActorDecision(
                action=ActorActionType.DONE,
                target=None,
                params=params,
                reasoning=reasoning
            )
        
        # 处理 clarify 动作
        if action == "clarify":
            return ActorDecision(
                action=ActorActionType.CLARIFY,
                target=None,
                params=params,
                reasoning=reasoning
            )
        
        return ActorDecision(
            action=action,
            target=target,
            params=params,
            reasoning=reasoning
        )
