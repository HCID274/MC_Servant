# LLM Task Planner
# LLM 任务规划器 - Neuro-Symbolic 架构的 Neural 组件

import json
import logging
from typing import Dict, Any, List, TYPE_CHECKING, Tuple

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

## Bot 状态说明
- owner_name: 主人玩家名
- owner_position: 主人当前位置 (用户说"离我最近"时，指的是离主人最近)
- position: Bot 当前位置
- inventory: Bot 背包物品

## 可用动作

### 1. mine_tree - 砍一棵树 ⭐ 砍树专用！
功能：智能识别一棵完整的树，只砍这一棵，不会砍到其他树
参数：
- near_position (dict): 搜索中心点 {"x":int,"y":int,"z":int}
- search_radius (int, 可选): 搜索半径，默认32

示例：{"action":"mine_tree","params":{"near_position":{"x":100,"y":64,"z":200}}}

### 2. mine - 采集方块
功能：自动寻找 → 导航 → 选工具 → 挖掘
参数：
- block_type (str): 方块ID
- count (int): 数量
- near_position (dict, 可选): 搜索中心点
- search_radius (int, 可选): 搜索半径，默认64

示例：{"action":"mine","params":{"block_type":"oak_log","count":3}}

### 3. craft - 合成物品
参数：item_name (str), count (int)

### 4. give - 交给玩家
参数：player_name (str), item_name (str), count (int)
player_name 必须用 owner_name！

### 5. goto - 导航到指定位置
参数：target (str) - "x,y,z" 坐标格式
⚠️ 重要：如果有 owner_position，必须用坐标格式 "x,y,z"，不要用 @PlayerName！
示例：{"action":"goto","params":{"target":"100,64,200"}}

### 6. pickup - 拾取掉落物 捡东西专用！
功能：自动寻找掉落物 → 寻路走过去 → 拾取 → 循环直到没有或达到数量
参数：
- target (str, 可选): 物品类型（如"apple"、"oak_log"），不填或"all"表示捡所有
- count (int, 可选): 拾取数量，-1表示尽可能多捡
- radius (int, 可选): 搜索半径，默认16

示例：{"action":"pickup","params":{"target":"oak_log"}}
示例：{"action":"pickup","params":{}}  // 捡起所有掉落物

### 7. equip/scan/place - 其他动作
- equip: item_name (str)
- scan: target_type (str), radius (int)
- place: block_type (str), x, y, z (int)

## 方块ID对照
- 木头: oak_log, birch_log, spruce_log, jungle_log, acacia_log, dark_oak_log
- 石头: stone, cobblestone
- 矿石: coal_ore, iron_ore, gold_ore, diamond_ore

## 语义理解规则 ⭐重要
1. "到我这来"、"过来" = 用 goto，target 用 owner_position 的坐标 "x,y,z"
2. "离我最近" = 离 owner_position 最近，用 near_position 指定
3. "砍树/砍掉那棵树" = 用 mine_tree（智能砍一棵）
4. "砍N个木头" = 用 mine（指定数量）
5. "木头" = oak_log
6. 采集任务直接用 mine/mine_tree，不需要先 goto

## 输出格式 (纯 JSON)
{"steps": [{"action":"动作名","params":{...},"description":"描述"}], "estimated_time": 秒数}

## 示例
任务: "到我这来"
Bot状态: owner_name: "HCID273", owner_position: {"x":100,"y":64,"z":200}
输出: {"steps":[{"action":"goto","params":{"target":"100,64,200"},"description":"走到主人身边"}],"estimated_time":30}

任务: "把离我最近的树砍了"
Bot状态: owner_position: {"x":100,"y":64,"z":200}
输出: {"steps":[{"action":"mine_tree","params":{"near_position":{"x":100,"y":64,"z":200}},"description":"砍掉主人附近的一棵树"}],"estimated_time":60}

任务: "砍3个木头"
输出: {"steps":[{"action":"mine","params":{"block_type":"oak_log","count":3},"description":"采集3个橡木原木"}],"estimated_time":45}
"""

ACT_SYSTEM_PROMPT = """你是 Minecraft 任务执行决策器（Tick Loop 模式）。
你的目标：基于最新状态每次只决定下一步做什么。

## 输入内容
- task_description: 用户任务（自然语言）
- bot_state: Bot 当前状态（可能包含 owner_position、last_scan、last_result、inventory 等）
- completed_steps: 最近已完成动作

## 可选动作（只从下面选 1 个）
mine_tree, mine, scan, goto, craft, equip, give, pickup

## 决策规则（按优先级）

### 采集类任务 (砍树/挖矿)
1) **看不到目标就先 scan**：如果没有 last_scan 或 last_scan.targets 为空 → 先 scan
2) **看到目标就靠近/采集**：如果 last_scan 有 nearest 且 distance <= 6 → mine/mine_tree；远则 goto
3) **"砍树"优先 mine_tree**：任务语义是砍树/砍掉那棵树 → mine_tree（near_position 优先用 owner_position）
4) **"离我最近/我这边/旁边"**：near_position 以 owner_position 为准

### 合成类任务 (做/craft)
5) **检查材料**：如果 inventory 有足够材料 → 直接 craft
6) **材料不足先采集**：缺原木 → mine_tree；缺其他材料 → mine
7) **单步完成**：craft 成功后，如果任务只是合成 → done: true

### 交付类任务 (给/give)
8) **检查背包**：inventory 有目标物品 → 直接 give
9) **物品不足**：先合成/采集所需物品
10) **单步完成**：give 成功后 → done: true

### 导航类任务 (来/goto)
11) **单步完成**：goto 成功后 → done: true

### 多步闭环任务 (如"做点木板给我")
12) **分解执行**：
    - 第一步：检查背包是否有原木，没有则 mine_tree
    - 第二步：craft oak_planks
    - 第三步：give owner_name oak_planks
    - 第四步：done: true
13) **不要提前 done**：只有所有子步骤都完成才能 done: true

## 参数格式
- mine: {"block_type": "oak_log", "count": 3}
- mine_tree: {"near_position": {"x":100,"y":64,"z":200}}（可选）
- craft: {"item_name": "oak_planks", "count": 4}
- give: {"player_name": "HCID273", "item_name": "oak_planks", "count": 4}
- goto: {"target": "100,64,200"}
- scan: {"target_type": "oak_log", "radius": 32}
- pickup: {"target": "apple"} 或 {} 捡所有

## 输出格式（纯 JSON）
必须是以下结构之一：
1) 继续执行：
{"done": false, "step": {"action": "scan", "params": {"target_type": "oak_log", "radius": 32}, "description": "扫描附近木头"}}
2) 已完成：
{"done": true, "message": "已完成：XXX"}

## 重要提醒
- 不要编坐标：goto 必须用真实坐标 "x,y,z"
- player_name 必须用 owner_name 的值！
- 多步任务不要提前 done！
"""

REPLAN_SYSTEM_PROMPT = """你是 Minecraft 任务规划专家。之前的执行计划失败了，请根据错误信息重新规划。

## 失败信息
- 失败动作: {failed_action}
- 错误类型: {error_code}
- 错误信息: {error_message}
- 已完成步骤: {completed_count} 个

## Bot 当前状态
{bot_state}

## 常见错误修复策略
- TARGET_NOT_FOUND (goto失败): 如果是采集任务，改用 mine（自动寻找+导航）
- INSUFFICIENT_MATERIALS: 先采集/合成所需材料
- NO_TOOL: 先合成所需工具
- TIMEOUT: 可能目标太远，尝试缩小范围或换目标

## 重要提醒
- mine 动作会自动寻找方块并导航，不需要先 goto！
- 如果 goto 失败且是采集任务，直接用 mine 替代

## 输出格式 (纯 JSON，无代码块)
{{"analysis": "简短分析", "steps": [{{"action": "动作名", "params": {{}}, "description": "描述"}}], "estimated_time": 秒数}}
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

    async def act(
        self,
        task_description: str,
        bot_state: Dict[str, Any],
        completed_steps: List["ActionResult"],
    ) -> Tuple[ActionStep, bool, str]:
        """
        Tick Loop 决策：每次只产出 1 个 ActionStep，或 done=true。

        Returns:
            (step, done, message)
        """
        # 构建用户消息（尽量短，避免 token 爆炸）
        user_message = json.dumps(
            {
                "task_description": task_description,
                "bot_state": bot_state,
                "completed_steps": [
                    {
                        "action": r.action,
                        "success": r.success,
                        "status": getattr(r.status, "value", str(r.status)),
                        "message": r.message,
                        "error_code": r.error_code,
                        "data": r.data,
                    }
                    for r in completed_steps
                ],
            },
            ensure_ascii=False,
        )

        messages = [
            {"role": "system", "content": ACT_SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ]

        response = await self._llm.chat_json(
            messages=messages,
            max_tokens=512,
            temperature=0.2,
        )

        if isinstance(response, dict) and response.get("done") is True:
            msg = response.get("message", "任务完成")
            # 返回一个占位 step（不会被执行），由上层根据 done 直接收敛
            return ActionStep(action="scan", params={"target_type": "player", "radius": 1}, description="done"), True, msg

        step_data = (response or {}).get("step") if isinstance(response, dict) else None
        if not isinstance(step_data, dict):
            raise ValueError(f"act() 输出格式错误: {response}")

        step = ActionStep(
            action=step_data.get("action", ""),
            params=step_data.get("params", {}) or {},
            description=step_data.get("description", "") or "",
        )
        return step, False, ""
    
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
