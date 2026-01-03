# LLM Task Planner
# LLM 任务规划器 - Neuro-Symbolic 架构的 Neural 组件

import json
import logging
from typing import Dict, Any, List, TYPE_CHECKING

from .interfaces import (
    ActionPlan, 
    ActionStep, 
    ITaskPlanner,
)

if TYPE_CHECKING:
    from ..llm.interfaces import ILLMClient
    from ..bot.interfaces import ActionResult


logger = logging.getLogger(__name__)


# ============================================================================
# Prompt Templates
# ============================================================================

PLAN_SYSTEM_PROMPT = """你是 Minecraft 任务规划专家。根据用户任务和 Bot 状态，生成可执行的动作序列。

## 可用动作
所有动作的参数名必须与下面完全一致：

1. **goto** - 导航到目标
   - target: str (格式: "x,y,z" 或 "@PlayerName")
   - timeout_sec: int (可选，默认60)

2. **mine** - 采集方块 (自动寻找、导航、选工具、挖掘)
   - block_type: str (方块ID，如 "oak_log", "iron_ore")
   - count: int (数量)
   - timeout_sec: int (可选，默认120)

3. **craft** - 合成物品 (自动查配方、检查材料、使用工作台)
   - item_name: str (物品ID，如 "oak_planks", "stick")
   - count: int (数量)
   - timeout_sec: int (可选，默认30)

4. **place** - 放置方块
   - block_type: str (方块ID)
   - x: int, y: int, z: int (坐标)
   - timeout_sec: int (可选，默认10)

5. **give** - 交给玩家
   - player_name: str (重要：使用 Bot 状态中的 owner_name，不要用占位符！)
   - item_name: str
   - count: int
   - timeout_sec: int (可选，默认30)

6. **equip** - 装备物品到手上
   - item_name: str
   - timeout_sec: int (可选，默认5)

7. **scan** - 扫描周围
   - target_type: str (方块ID 或 "player", "mob", "item")
   - radius: int (默认32)

## 重要规则
1. 只使用上述列出的动作
2. 参数名必须完全匹配 (如 block_type 不能写成 blockType)
3. 不要假设背包有某些物品，先检查 Bot 状态
4. 合成物品前确保有足够材料
5. 采集矿石前确保有合适工具
6. **give 命令的 player_name 必须使用 Bot 状态中的 owner_name（真实玩家名），禁止使用占位符！**

## 输出格式
返回纯 JSON (不要 markdown 代码块)：
{
  "steps": [
    {"action": "动作名", "params": {"参数名": 值}, "description": "描述"},
    ...
  ],
  "estimated_time": 秒数
}
"""

REPLAN_SYSTEM_PROMPT = """你是 Minecraft 任务规划专家。之前的执行计划失败了，请根据错误信息重新规划。

## 失败信息
- 失败动作: {failed_action}
- 错误类型: {error_code}
- 错误信息: {error_message}
- 已完成步骤: {completed_count} 个

## Bot 当前状态
{bot_state}

## 重新规划要求
1. 分析失败原因
2. 如果是材料不足，考虑先采集/合成材料
3. 如果是路径问题，考虑换个方向或绕路
4. 生成新的执行计划

## 输出格式
返回纯 JSON：
{
  "analysis": "失败原因分析",
  "steps": [
    {"action": "动作名", "params": {"参数名": 值}, "description": "描述"},
    ...
  ],
  "estimated_time": 秒数
}
"""


class LLMTaskPlanner(ITaskPlanner):
    """
    LLM 任务规划器
    
    职责：
    - 调用大模型生成可执行的动作计划
    - 失败后根据错误信息重新规划
    
    这是 Neuro-Symbolic 架构的 Neural 组件 (Slow Path)
    """
    
    def __init__(self, llm_client: "ILLMClient"):
        """
        初始化规划器
        
        Args:
            llm_client: LLM 客户端
        """
        self._llm = llm_client
        logger.info(f"LLMTaskPlanner initialized with model: {llm_client.model_name}")
    
    async def plan(
        self, 
        task_description: str, 
        bot_state: Dict[str, Any]
    ) -> ActionPlan:
        """
        规划任务
        
        Args:
            task_description: 任务描述
            bot_state: Bot 当前状态
            
        Returns:
            ActionPlan: 可执行的动作计划
        """
        logger.info(f"Planning task: {task_description}")
        
        # 构建用户消息
        user_message = self._build_plan_message(task_description, bot_state)
        
        messages = [
            {"role": "system", "content": PLAN_SYSTEM_PROMPT},
            {"role": "user", "content": user_message}
        ]
        
        try:
            # 调用 LLM
            response = await self._llm.chat_json(
                messages=messages,
                max_tokens=1024,
                temperature=0.3
            )
            
            # 解析响应
            return self._parse_plan_response(task_description, response)
            
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse LLM response as JSON: {e}")
            # 返回空计划，让 Executor 处理
            return ActionPlan(
                task_description=task_description,
                steps=[],
                estimated_time=0
            )
        except Exception as e:
            logger.error(f"LLM plan failed: {e}")
            raise
    
    async def replan(
        self,
        task_description: str,
        bot_state: Dict[str, Any],
        failed_result: "ActionResult",
        completed_steps: List["ActionResult"]
    ) -> ActionPlan:
        """
        任务重规划
        
        Args:
            task_description: 原始任务描述
            bot_state: Bot 当前状态
            failed_result: 失败的动作结果
            completed_steps: 已完成的动作结果列表
            
        Returns:
            ActionPlan: 新的执行计划
        """
        logger.info(f"Replanning task: {task_description}, failed at: {failed_result.action}")
        
        # 构建重规划 prompt
        system_prompt = REPLAN_SYSTEM_PROMPT.format(
            failed_action=failed_result.action,
            error_code=failed_result.error_code or "UNKNOWN",
            error_message=failed_result.message,
            completed_count=len(completed_steps),
            bot_state=json.dumps(bot_state, ensure_ascii=False, indent=2)
        )
        
        user_message = f"""原始任务: {task_description}

已完成的步骤:
{self._format_completed_steps(completed_steps)}

请重新规划剩余步骤。"""

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ]
        
        try:
            response = await self._llm.chat_json(
                messages=messages,
                max_tokens=1024,
                temperature=0.3
            )
            
            return self._parse_plan_response(task_description, response)
            
        except json.JSONDecodeError as e:
            logger.error(f"Replan JSON parse failed: {e}")
            logger.error(f"This usually means LLM response was truncated or malformed")
            # 返回空计划
            return ActionPlan(
                task_description=task_description,
                steps=[],
                estimated_time=0
            )
        except Exception as e:
            logger.error(f"LLM replan failed: {e}")
            # 返回空计划
            return ActionPlan(
                task_description=task_description,
                steps=[],
                estimated_time=0
            )
    
    def _build_plan_message(self, task: str, bot_state: Dict[str, Any]) -> str:
        """构建规划请求消息"""
        state_str = json.dumps(bot_state, ensure_ascii=False, indent=2)
        return f"""## 任务
{task}

## Bot 当前状态
{state_str}

请规划执行步骤。"""
    
    def _parse_plan_response(self, task: str, response: Dict[str, Any]) -> ActionPlan:
        """解析规划响应"""
        steps = []
        
        for step_data in response.get("steps", []):
            step = ActionStep(
                action=step_data.get("action", ""),
                params=step_data.get("params", {}),
                description=step_data.get("description", "")
            )
            steps.append(step)
        
        plan = ActionPlan(
            task_description=task,
            steps=steps,
            estimated_time=response.get("estimated_time", 0)
        )
        
        logger.info(f"Parsed plan: {len(steps)} steps, estimated {plan.estimated_time}s")
        return plan
    
    def _format_completed_steps(self, steps: List["ActionResult"]) -> str:
        """格式化已完成步骤"""
        if not steps:
            return "(无)"
        
        lines = []
        for i, step in enumerate(steps, 1):
            status = "✅" if step.success else "❌"
            lines.append(f"{i}. {status} {step.action}: {step.message}")
        
        return "\n".join(lines)
