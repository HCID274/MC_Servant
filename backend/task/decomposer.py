# LLMTaskDecomposer - 粗粒度任务分解器
# 使用 LLM 将用户意图分解为 StackTask 列表
#
# Neural 层：只做逻辑分解，不展开资源依赖

import json
import logging
from typing import Dict, Any, List, Optional, TYPE_CHECKING

from .interfaces import (
    StackTask,
    TaskType,
    TaskStatus,
    ITaskDecomposer,
)

if TYPE_CHECKING:
    from ..llm.interfaces import ILLMClient

logger = logging.getLogger(__name__)


# 任务分解 Prompt
DECOMPOSE_PROMPT = '''你是 Minecraft 任务分解专家。将用户意图分解为粗粒度任务列表。

## 任务类型
- gather: 采集资源（木头、矿石、羊毛等）
- craft: 合成物品（木板、工具、床等）
- build: 建造结构
- goto: 导航到位置
- give: 交付物品给玩家

## 分解规则
1. **只做逻辑分解**：盖房子 → [采集, 合成, 建造]
2. **不展开资源依赖**："合成木板需要木头" 由执行层处理，你无需管
3. **采集任务需指定目标和大致数量**
4. **简单任务不拆分**：如 "过来" → [goto]，"砍棵树" → [gather]

## goal 格式约定
- gather: "gather <item_id> <count>"，如 "gather oak_log 10"
- craft: "craft <item_name> <count>"，如 "craft oak_planks 40"
- build: "build <structure_name>"
- goto: "goto <target>"，target 可以是 "@玩家名" 或 "x,y,z"
- give: "give <item_name> <count>"

## Bot 当前状态
位置: {position}
背包: {inventory}
主人: {owner_name}

## 用户意图
{intent}

## 输出格式 (纯 JSON，无 markdown)
{{"tasks": [{{"name": "显示名", "task_type": "类型", "goal": "机器可解析的目标"}}]}}

## 示例
用户: "帮我采集5个木头"
输出: {{"tasks": [{{"name": "采集木头", "task_type": "gather", "goal": "gather oak_log 5"}}]}}

用户: "过来"
输出: {{"tasks": [{{"name": "走到主人身边", "task_type": "goto", "goal": "goto @HCID273"}}]}}

用户: "帮我合成一个工作台"
输出: {{"tasks": [{{"name": "合成工作台", "task_type": "craft", "goal": "craft crafting_table 1"}}]}}
'''


class LLMTaskDecomposer(ITaskDecomposer):
    """
    LLM 粗粒度任务分解器
    
    职责：
    - 将用户意图分解为 StackTask 列表
    - 只做逻辑分解，不展开资源依赖
    
    这是 Neuro-Symbolic 架构的 Neural 组件
    """
    
    def __init__(self, llm_client: "ILLMClient"):
        """
        初始化分解器
        
        Args:
            llm_client: LLM 客户端
        """
        self._llm = llm_client
    
    async def decompose(
        self,
        intent: str,
        bot_state: Dict[str, Any],
        target_info: Optional[Dict[str, Any]] = None
    ) -> List[StackTask]:
        """
        将用户意图分解为粗粒度任务列表
        
        Args:
            intent: 用户意图
            bot_state: Bot 当前状态
            target_info: 可选的目标信息
            
        Returns:
            List[StackTask]: 有序的粗粒度任务列表
        """
        # 构建 Prompt
        prompt = DECOMPOSE_PROMPT.format(
            position=json.dumps(bot_state.get("position", {}), ensure_ascii=False),
            inventory=self._format_inventory(bot_state.get("inventory", {})),
            owner_name=bot_state.get("owner_name", "未知"),
            intent=intent,
        )
        
        # 调用 LLM
        try:
            response = await self._llm.chat_json(
                system_prompt="你是 Minecraft 任务分解专家，只输出 JSON。",
                user_message=prompt
            )
        except Exception as e:
            logger.error(f"LLM decompose failed: {e}")
            # 降级：返回单任务
            return [self._create_fallback_task(intent)]
        
        # 解析响应
        tasks = self._parse_response(response)
        
        if not tasks:
            logger.warning(f"Empty decomposition result for: {intent}")
            return [self._create_fallback_task(intent)]
        
        logger.info(f"Decomposed '{intent}' into {len(tasks)} tasks: {[t.name for t in tasks]}")
        return tasks
    
    def _format_inventory(self, inventory: Dict[str, int]) -> str:
        """格式化背包为简洁字符串"""
        if not inventory:
            return "空"
        items = [f"{k}: {v}" for k, v in list(inventory.items())[:10]]
        if len(inventory) > 10:
            items.append(f"...还有 {len(inventory) - 10} 种物品")
        return ", ".join(items)
    
    def _parse_response(self, response: Dict[str, Any]) -> List[StackTask]:
        """解析 LLM 响应为 StackTask 列表"""
        tasks_data = response.get("tasks", [])
        if not isinstance(tasks_data, list):
            return []
        
        tasks = []
        for item in tasks_data:
            if not isinstance(item, dict):
                continue
            
            name = item.get("name", "未知任务")
            goal = item.get("goal", name)
            task_type_str = item.get("task_type", "craft")
            
            # 解析任务类型
            task_type = self._parse_task_type(task_type_str)
            
            task = StackTask(
                name=name,
                goal=goal,
                task_type=task_type,
                status=TaskStatus.PENDING,
                context={"source": "decomposer"},
            )
            tasks.append(task)
        
        return tasks
    
    def _parse_task_type(self, type_str: str) -> TaskType:
        """解析任务类型字符串为枚举"""
        type_map = {
            "gather": TaskType.GATHER,
            "mine": TaskType.GATHER,  # 兼容
            "craft": TaskType.CRAFT,
            "build": TaskType.BUILD,
            "goto": TaskType.GOTO,
            "give": TaskType.GIVE,
            "combat": TaskType.COMBAT,
            "follow": TaskType.FOLLOW,
        }
        return type_map.get(type_str.lower(), TaskType.CRAFT)
    
    def _create_fallback_task(self, intent: str) -> StackTask:
        """创建降级任务（LLM 失败时）"""
        # 简单规则推断任务类型
        intent_lower = intent.lower()
        
        if any(kw in intent_lower for kw in ["过来", "来", "到这", "到我"]):
            return StackTask(
                name="走到主人身边",
                goal=f"goto @owner",
                task_type=TaskType.GOTO,
                context={"source": "fallback"},
            )
        elif any(kw in intent_lower for kw in ["采", "挖", "砍", "收集", "找"]):
            return StackTask(
                name=intent,
                goal=intent,
                task_type=TaskType.GATHER,
                context={"source": "fallback"},
            )
        elif any(kw in intent_lower for kw in ["合成", "做", "造"]):
            return StackTask(
                name=intent,
                goal=intent,
                task_type=TaskType.CRAFT,
                context={"source": "fallback"},
            )
        else:
            return StackTask(
                name=intent,
                goal=intent,
                task_type=TaskType.CRAFT,  # 默认
                context={"source": "fallback"},
            )
