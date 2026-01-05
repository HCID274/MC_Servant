# Memory Compression Module
#
# 分层记忆压缩 - 将对话历史蒸馏为高密度认知
#
# 设计原则：
# - 简单接口：compress_l0_to_l1(), compress_l1_to_l2()
# - 深度功能：LLM 驱动的语义压缩
# - 依赖抽象：依赖 ILLMClient 接口，而非具体实现

import logging
import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

from config import settings
from .interfaces import ILLMClient

logger = logging.getLogger(__name__)


# ============================================================
# 压缩 Prompt 模板
# ============================================================

L0_TO_L1_PROMPT = """你是一个记忆整理助手。请将以下对话历史压缩成一段简洁的第三人称叙述。

## 输入格式
对话列表，每条包含角色(user/assistant)和内容。

## 输出要求
1. 使用第三人称视角叙述（如"玩家请求..."、"女仆回复..."）
2. 保留关键信息：
   - 用户的具体请求和执行结果
   - 发生的有趣事件或冲突
   - 用户表达的情绪和偏好
3. 忽略日常寒暄和重复内容
4. 输出300-500字左右

## 对话历史
{conversation}

## 输出
请直接输出叙述文本，不要添加任何标题或格式标记。"""


L1_TO_L2_PROMPT = """你是一个记忆蒸馏助手。请将以下情景记忆和旧核心记忆合并，提炼出最重要的持久认知。

## 目标
即使遗忘具体事件的细节，也要记住"关系"和"事实"。

## 输入
### 情景记忆(新)
{episodic}

### 核心记忆(旧)
{old_core}

## 输出格式
请按以下结构输出，每个部分2-4条要点，整体200-300字：

👤 用户画像
- 性格特点、交流风格
- 偏好（喜欢挖矿/建造/探险）
- 称呼习惯

🌍 世界事实
- 关键坐标（家、矿洞、农场位置）
- 历史承诺和约定
- 重要物品或建筑

❤️ 情感连接
- 共同经历的重要时刻
- 内部梗(Inside Jokes)
- 情感里程碑

## 输出
请直接输出结构化内容。"""


# ============================================================
# 抽象接口
# ============================================================

class IMemoryCompressor(ABC):
    """
    记忆压缩器抽象接口
    
    职责：将低层记忆压缩为高层摘要
    """
    
    @abstractmethod
    async def compress_l0_to_l1(self, raw_buffer: list[dict]) -> str:
        """
        L0 → L1 压缩（叙事化）
        
        Args:
            raw_buffer: 原始对话列表 [{"role": "user/assistant", "content": "..."}]
            
        Returns:
            第三人称叙述的情景记忆
        """
        pass
    
    @abstractmethod
    async def compress_l1_to_l2(self, episodic: str, old_core: str) -> str:
        """
        L1 → L2 压缩（认知化）
        
        Args:
            episodic: L1 情景记忆
            old_core: 旧的 L2 核心记忆
            
        Returns:
            新的结构化核心认知
        """
        pass


# ============================================================
# 压缩结果数据类
# ============================================================

@dataclass
class CompressionResult:
    """压缩操作结果"""
    success: bool
    content: str                    # 压缩后的内容
    input_length: int               # 输入字符数（估算 token）
    output_length: int              # 输出字符数（估算 token）
    error: Optional[str] = None     # 错误信息（如果失败）


# ============================================================
# 具体实现
# ============================================================

class MemoryCompressor(IMemoryCompressor):
    """
    LLM 驱动的记忆压缩器
    
    使用 LLM 将原始对话压缩为结构化摘要
    """
    
    def __init__(self, llm_client: ILLMClient):
        """
        初始化压缩器
        
        Args:
            llm_client: LLM 客户端（依赖注入）
        """
        self._llm = llm_client
    
    async def compress_l0_to_l1(self, raw_buffer: list[dict]) -> str:
        """
        L0 → L1 压缩（叙事化）
        
        将原始对话列表转化为第三人称叙述
        """
        if not raw_buffer:
            return ""
        
        # 格式化对话历史
        conversation_text = self._format_conversation(raw_buffer)
        
        # 构建 Prompt
        prompt = L0_TO_L1_PROMPT.format(conversation=conversation_text)
        
        try:
            result = await asyncio.wait_for(
                self._llm.chat(
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=800,
                    temperature=0.3,  # 低温度保证稳定输出
                ),
                timeout=settings.llm_compression_timeout_seconds,
            )
            
            logger.info(f"L0→L1 compression: {len(conversation_text)} chars → {len(result)} chars")
            return result.strip()

        except asyncio.TimeoutError:
            logger.warning("L0→L1 compression timeout, fallback")
            return self._fallback_l0_to_l1(raw_buffer)
        except Exception as e:
            logger.error(f"L0→L1 compression failed: {e}")
            # 降级：返回简单拼接
            return self._fallback_l0_to_l1(raw_buffer)
    
    async def compress_l1_to_l2(self, episodic: str, old_core: str) -> str:
        """
        L1 → L2 压缩（认知化）
        
        将情景记忆提炼为核心认知
        """
        if not episodic and not old_core:
            return ""
        
        # 如果没有旧核心，标记为空
        old_core_text = old_core if old_core else "（首次记忆，无旧核心）"
        
        # 构建 Prompt
        prompt = L1_TO_L2_PROMPT.format(
            episodic=episodic,
            old_core=old_core_text,
        )
        
        try:
            result = await asyncio.wait_for(
                self._llm.chat(
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=600,
                    temperature=0.3,
                ),
                timeout=settings.llm_compression_timeout_seconds,
            )
            
            logger.info(f"L1→L2 compression: {len(episodic)+len(old_core)} chars → {len(result)} chars")
            return result.strip()

        except asyncio.TimeoutError:
            logger.warning("L1→L2 compression timeout, keep old core")
            return old_core or ""
        except Exception as e:
            logger.error(f"L1→L2 compression failed: {e}")
            # 降级：保留旧核心
            return old_core or ""
    
    async def compress_with_result(
        self, 
        compression_type: str,
        raw_buffer: list[dict] = None,
        episodic: str = None,
        old_core: str = None,
    ) -> CompressionResult:
        """
        带详细结果的压缩（用于日志记录）
        
        Args:
            compression_type: "L0_L1" 或 "L1_L2"
            其他参数根据压缩类型提供
        """
        try:
            if compression_type == "L0_L1":
                if not raw_buffer:
                    return CompressionResult(False, "", 0, 0, "Empty buffer")
                    
                input_text = self._format_conversation(raw_buffer)
                output = await self.compress_l0_to_l1(raw_buffer)
                
                return CompressionResult(
                    success=True,
                    content=output,
                    input_length=len(input_text),
                    output_length=len(output),
                )
                
            elif compression_type == "L1_L2":
                input_length = len(episodic or "") + len(old_core or "")
                output = await self.compress_l1_to_l2(episodic or "", old_core or "")
                
                return CompressionResult(
                    success=True,
                    content=output,
                    input_length=input_length,
                    output_length=len(output),
                )
            else:
                return CompressionResult(False, "", 0, 0, f"Unknown type: {compression_type}")
                
        except Exception as e:
            return CompressionResult(
                success=False,
                content="",
                input_length=0,
                output_length=0,
                error=str(e),
            )
    
    # ==================== 辅助方法 ====================
    
    def _format_conversation(self, buffer: list[dict]) -> str:
        """格式化对话列表为文本"""
        lines = []
        for msg in buffer:
            role = "玩家" if msg.get("role") == "user" else "女仆"
            content = msg.get("content", "")
            lines.append(f"[{role}] {content}")
        return "\n".join(lines)
    
    def _fallback_l0_to_l1(self, buffer: list[dict]) -> str:
        """降级处理：简单拼接最后几条"""
        # 只保留最后 5 条消息的摘要
        recent = buffer[-10:] if len(buffer) > 10 else buffer
        summary_parts = []
        for msg in recent:
            role = "玩家" if msg.get("role") == "user" else "女仆"
            content = msg.get("content", "")[:50]  # 截断
            summary_parts.append(f"{role}说: {content}")
        return "（压缩失败，保留原文摘要）\n" + "\n".join(summary_parts)
