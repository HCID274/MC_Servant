# Intent Recognition System

import logging
from enum import Enum
from typing import Optional, Tuple, Dict, Any

from .interfaces import ILLMClient, IIntentRecognizer

logger = logging.getLogger(__name__)


class Intent(str, Enum):
    """
    用户意图分类
    
    与 00任务规划.md 中定义的意图保持一致
    """
    BUILD = "build"      # 建造
    MINE = "mine"        # 挖矿
    FARM = "farm"        # 种田
    GUARD = "guard"      # 守卫
    CHAT = "chat"        # 闲聊
    STATUS = "status"    # 查询状态
    CANCEL = "cancel"    # 取消任务
    UNKNOWN = "unknown"  # 未知


# 意图识别 System Prompt
INTENT_SYSTEM_PROMPT = """你是一个 Minecraft 游戏助手的意图识别模块。
你的任务是分析玩家的输入，识别他们想要做什么。

## 可用意图类型

| 意图 | 说明 | 示例 |
|------|------|------|
| build | 建造建筑 | "帮我盖个房子"、"建一座塔"、"造个仓库" |
| mine | 挖矿采集 | "去挖点铁矿"、"采集钻石"、"挖煤" |
| farm | 种田农业 | "去种地"、"收割小麦"、"种些蔬菜" |
| guard | 守卫巡逻 | "保护这里"、"守住大门"、"巡逻" |
| status | 查询状态 | "你在哪"、"现在在干嘛"、"报告状态" |
| cancel | 取消任务 | "停下"、"别干了"、"取消" |
| chat | 闲聊对话 | "你好"、"今天天气怎么样"、其他无明确任务的对话 |
| unknown | 无法识别 | 真的无法理解的输入 |

## 输出格式

你必须输出一个 JSON 对象，包含以下字段:
- intent: 意图类型 (build/mine/farm/guard/status/cancel/chat/unknown)
- confidence: 置信度 (0.0-1.0)
- entities: 提取的实体信息 (如建筑类型、材料、位置等)
- reason: 简短的识别理由

## 示例

输入: "帮我盖个温馨的小木屋"
输出:
{
  "intent": "build",
  "confidence": 0.95,
  "entities": {
    "building_type": "小木屋",
    "style": "温馨"
  },
  "reason": "用户明确请求建造建筑"
}

输入: "你好呀"
输出:
{
  "intent": "chat",
  "confidence": 0.9,
  "entities": {},
  "reason": "简单的问候语，属于闲聊"
}
"""


class IntentRecognizer(IIntentRecognizer):
    """
    意图识别器
    
    使用 LLM 识别用户输入的意图
    """
    
    def __init__(self, llm_client: ILLMClient):
        """
        初始化意图识别器
        
        Args:
            llm_client: LLM 客户端实例
        """
        self._llm = llm_client
    
    async def recognize(
        self, 
        user_input: str, 
        context: Optional[str] = None
    ) -> Tuple[Intent, Dict[str, Any]]:
        """
        识别用户意图
        
        Args:
            user_input: 用户输入文本
            context: 可选的对话上下文
            
        Returns:
            (Intent 枚举, 实体和元数据字典)
        """
        if not user_input or not user_input.strip():
            return Intent.UNKNOWN, {"confidence": 0.0, "reason": "空输入"}
        
        # 构建消息
        messages = [
            {"role": "system", "content": INTENT_SYSTEM_PROMPT},
        ]
        
        # 添加上下文（如果有）
        if context:
            messages.append({
                "role": "user", 
                "content": f"对话上下文:\n{context}\n\n当前用户输入: {user_input}"
            })
        else:
            messages.append({"role": "user", "content": user_input})
        
        try:
            # 调用 LLM 进行意图识别
            result = await self._llm.chat_json(
                messages=messages,
                max_tokens=256,
                temperature=0.1,  # 低温度保证稳定输出
            )
            
            # 解析结果
            intent_str = result.get("intent", "unknown").lower()
            try:
                intent = Intent(intent_str)
            except ValueError:
                logger.warning(f"Unknown intent from LLM: {intent_str}")
                intent = Intent.UNKNOWN
            
            # 提取元数据
            metadata = {
                "confidence": result.get("confidence", 0.5),
                "entities": result.get("entities", {}),
                "reason": result.get("reason", ""),
            }
            
            logger.info(f"Intent recognized: {intent.value} (conf={metadata['confidence']})")
            return intent, metadata
            
        except Exception as e:
            logger.error(f"Intent recognition failed: {e}")
            # 降级处理：返回 CHAT 意图
            return Intent.CHAT, {
                "confidence": 0.0,
                "entities": {},
                "reason": f"LLM 调用失败: {str(e)}",
                "fallback": True,
            }
    
    def recognize_simple(self, user_input: str) -> Intent:
        """
        简单的规则匹配意图识别（不调用 LLM）
        
        用于快速响应或 LLM 不可用时的降级
        """
        text = user_input.lower().strip()
        
        # 建造相关关键词
        if any(kw in text for kw in ["盖", "建", "造", "房", "屋", "塔", "墙"]):
            return Intent.BUILD
        
        # 挖矿相关关键词
        if any(kw in text for kw in ["挖", "采", "矿", "钻石", "铁", "煤"]):
            return Intent.MINE
        
        # 种田相关关键词
        if any(kw in text for kw in ["种", "农", "田", "收割", "小麦"]):
            return Intent.FARM
        
        # 守卫相关关键词
        if any(kw in text for kw in ["守", "护", "巡逻", "保护", "看守"]):
            return Intent.GUARD
        
        # 状态查询
        if any(kw in text for kw in ["在哪", "位置", "状态", "干嘛", "在做什么"]):
            return Intent.STATUS
        
        # 取消任务
        if any(kw in text for kw in ["停", "取消", "别", "不要", "算了"]):
            return Intent.CANCEL
        
        # 默认为闲聊
        return Intent.CHAT
