# Session Management
# 会话生命周期管理
#
# 设计原则：
# - 会话隔离：不同主人的对话历史分离
# - 消息归属：每条消息标记 sender_uuid
# - 优雅切换：Release 时生成摘要，Claim 时开启新会话

import time
import uuid
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class SessionMessage:
    """
    会话消息 - 携带发送者信息
    
    解决多玩家场景下的消息归属问题
    """
    role: str               # "user" | "assistant" | "system"
    content: str
    sender_uuid: str        # 发送者 UUID
    sender_name: str        # 发送者名称 (用于显示)
    timestamp: float = field(default_factory=time.time)
    is_from_owner: bool = False  # 是否来自当前主人
    
    def to_dict(self) -> dict:
        """转换为字典格式 (用于 LLM 上下文)"""
        return {
            "role": self.role,
            "content": self.content,
            "sender_uuid": self.sender_uuid,
            "sender_name": self.sender_name,
        }
    
    def to_llm_format(self) -> dict:
        """转换为 LLM 消息格式 (仅 role + content)"""
        return {
            "role": self.role,
            "content": self.content,
        }


@dataclass
class Session:
    """
    会话 - 一段连续的主人-Bot 交互
    
    生命周期：Claim → 对话 → Release
    """
    session_id: str
    owner_uuid: str
    owner_name: str
    bot_name: str
    started_at: float = field(default_factory=time.time)
    ended_at: Optional[float] = None
    messages: List[SessionMessage] = field(default_factory=list)
    summary: Optional[str] = None  # 会话结束时生成的摘要
    
    @classmethod
    def create(cls, owner_uuid: str, owner_name: str, bot_name: str) -> "Session":
        """创建新会话"""
        return cls(
            session_id=str(uuid.uuid4())[:8],
            owner_uuid=owner_uuid,
            owner_name=owner_name,
            bot_name=bot_name,
        )
    
    def add_message(
        self,
        role: str,
        content: str,
        sender_uuid: str,
        sender_name: str,
    ) -> SessionMessage:
        """添加消息到会话"""
        msg = SessionMessage(
            role=role,
            content=content,
            sender_uuid=sender_uuid,
            sender_name=sender_name,
            is_from_owner=(sender_uuid == self.owner_uuid),
        )
        self.messages.append(msg)
        return msg
    
    def end(self, summary: Optional[str] = None) -> None:
        """结束会话"""
        self.ended_at = time.time()
        self.summary = summary
    
    @property
    def is_active(self) -> bool:
        """会话是否活跃"""
        return self.ended_at is None
    
    @property
    def duration_seconds(self) -> float:
        """会话持续时间"""
        end = self.ended_at or time.time()
        return end - self.started_at
    
    @property
    def message_count(self) -> int:
        """消息总数"""
        return len(self.messages)
    
    @property
    def owner_message_count(self) -> int:
        """主人消息数"""
        return sum(1 for m in self.messages if m.is_from_owner)
    
    def get_messages_for_llm(
        self,
        include_bystanders: bool = False,
        max_messages: int = 20,
    ) -> List[dict]:
        """
        获取适合 LLM 的消息列表
        
        Args:
            include_bystanders: 是否包含旁观者消息
            max_messages: 最大消息数
            
        Returns:
            消息列表 [{"role": ..., "content": ...}, ...]
        """
        if include_bystanders:
            messages = self.messages
        else:
            # 只包含主人和 Bot 的对话
            messages = [m for m in self.messages if m.is_from_owner or m.role == "assistant"]
        
        # 取最近的 N 条
        recent = messages[-max_messages:]
        return [m.to_llm_format() for m in recent]
    
    def get_context_with_ownership(self, max_messages: int = 20) -> List[dict]:
        """
        获取带归属标记的 LLM 上下文
        
        格式:
        [
            {"role": "user", "content": "[Steve (Owner)]: Go mine iron"},
            {"role": "user", "content": "[Alex (Bystander)]: Hello!"},
            {"role": "assistant", "content": "好的主人，我去挖铁矿~"},
        ]
        """
        recent = self.messages[-max_messages:]
        result = []
        
        for msg in recent:
            if msg.role == "assistant":
                result.append(msg.to_llm_format())
            else:
                # 标记消息来源
                tag = "Owner" if msg.is_from_owner else "Bystander"
                formatted_content = f"[{msg.sender_name} ({tag})]: {msg.content}"
                result.append({
                    "role": msg.role,
                    "content": formatted_content,
                })
        
        return result
