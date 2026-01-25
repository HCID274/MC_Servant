# MC_Servant Message Protocol

from enum import Enum
from typing import Any, Optional
from pydantic import BaseModel, Field


class MessageType(str, Enum):
    """消息类型枚举"""
    
    # Java → Python
    PLAYER_MESSAGE = "player_message"   # 玩家发送的消息
    PLUGIN_STATUS = "plugin_status"     # 插件状态更新
    
    # Python → Java
    NPC_RESPONSE = "npc_response"       # NPC 回复
    BOT_COMMAND = "bot_command"         # Bot 动作指令
    BOT_STATUS = "bot_status"           # Bot 状态更新
    HOLOGRAM_UPDATE = "hologram_update" # 主动推送全息更新
    
    # 双向
    HEARTBEAT = "heartbeat"             # 心跳
    ERROR = "error"                     # 错误
    
    # 系统命令 (Java → Python)
    SERVANT_COMMAND = "servant_command" # 认领/释放/列表


class PlayerMessage(BaseModel):
    """玩家消息 (Java → Python)"""
    type: MessageType = MessageType.PLAYER_MESSAGE
    player: Optional[str] = Field(default="Unknown", max_length=32)
    npc: Optional[str] = Field(default=None, max_length=32)
    content: Optional[str] = Field(default="", max_length=1000)
    timestamp: Optional[int] = 0
    # 玩家实时位置 (由 Java 插件提供，比 Mineflayer 更准确)
    player_x: Optional[float] = None
    player_y: Optional[float] = None
    player_z: Optional[float] = None


class NpcResponse(BaseModel):
    """NPC 回复 (Python → Java)"""
    type: MessageType = MessageType.NPC_RESPONSE
    npc: Optional[str] = "UnknownBot"
    target_player: Optional[str] = "Unknown"
    content: Optional[str] = ""
    segments: Optional[list[str]] = None  # 分段显示内容
    hologram_text: Optional[str] = None
    action: Optional[str] = None


class BotCommand(BaseModel):
    """Bot 动作指令 (Python → Java or internal)"""
    type: MessageType = MessageType.BOT_COMMAND
    npc: Optional[str] = "UnknownBot"
    command: Optional[str] = "idle"  # jump, chat, move_to, etc.
    args: dict = Field(default_factory=dict)


class BotStatus(BaseModel):
    """Bot 状态 (Python → Java)"""
    type: MessageType = MessageType.BOT_STATUS
    npc: Optional[str] = "UnknownBot"
    status: Optional[str] = "idle"  # idle, busy, offline
    position: Optional[list[float]] = None


class Heartbeat(BaseModel):
    """心跳消息"""
    type: MessageType = MessageType.HEARTBEAT
    timestamp: Optional[int] = 0


class ErrorMessage(BaseModel):
    """错误消息"""
    type: MessageType = MessageType.ERROR
    code: str
    message: str


class ServantCommandMessage(BaseModel):
    """系统命令消息 (Java → Python)
    
    用于 claim/release/list 等管理命令
    """
    type: MessageType = MessageType.SERVANT_COMMAND
    player: Optional[str] = Field(default="Unknown", max_length=32)
    player_uuid: Optional[str] = Field(default=None, max_length=36)
    command: Optional[str] = Field(default="help", max_length=32)
    target_bot: Optional[str] = Field(default=None, max_length=32)
    timestamp: Optional[int] = 0


class HologramUpdate(BaseModel):
    """全息更新消息 (Python → Java)
    
    主动推送 Bot 头顶全息状态变化
    """
    type: MessageType = MessageType.HOLOGRAM_UPDATE
    npc: str = Field(max_length=32)
    hologram_text: str = Field(max_length=255)
    identity_line: Optional[str] = Field(default=None, max_length=100)  # 可选更新身份行


# 消息类型到模型的映射
MESSAGE_MODELS = {
    MessageType.PLAYER_MESSAGE: PlayerMessage,
    MessageType.NPC_RESPONSE: NpcResponse,
    MessageType.BOT_COMMAND: BotCommand,
    MessageType.BOT_STATUS: BotStatus,
    MessageType.HOLOGRAM_UPDATE: HologramUpdate,
    MessageType.HEARTBEAT: Heartbeat,
    MessageType.ERROR: ErrorMessage,
    MessageType.SERVANT_COMMAND: ServantCommandMessage,
}


def parse_message(data: dict) -> BaseModel:
    """
    解析 JSON 数据为具体消息对象
    
    依赖抽象：通过 type 字段动态选择模型
    """
    msg_type = MessageType(data.get("type"))
    model_class = MESSAGE_MODELS.get(msg_type)
    if model_class is None:
        raise ValueError(f"Unknown message type: {msg_type}")
    return model_class.model_validate(data)
