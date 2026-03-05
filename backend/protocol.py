# MC_Servant Message Protocol

from enum import Enum
from typing import Any, Optional
from pydantic import BaseModel, Field


class MessageType(str, Enum):
    """
    女仆与插件沟通的“暗号类型”。
    定义了这条消息到底是主人的唠叨、女仆的回复、还是机器人的动作指令。
    """
    
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
    """
    “主人的唠叨”消息包。
    当玩家在游戏里说话时，插件会把话语、玩家是谁、甚至玩家在哪儿都打包发给女仆。
    """
    type: MessageType = MessageType.PLAYER_MESSAGE
    player: Optional[str] = "Unknown"
    npc: Optional[str] = None
    content: Optional[str] = ""
    timestamp: Optional[int] = 0
    # 玩家实时位置 (由 Java 插件提供，比 Mineflayer 更准确)
    player_x: Optional[float] = None
    player_y: Optional[float] = None
    player_z: Optional[float] = None


class NpcResponse(BaseModel):
    """
    “女仆的回应”消息包。
    女仆想好怎么回话后，会把要说的话、要显示在头顶的文字、甚至接下来想做的动作打包发回给游戏插件。
    """
    type: MessageType = MessageType.NPC_RESPONSE
    npc: Optional[str] = "UnknownBot"
    target_player: Optional[str] = "Unknown"
    content: Optional[str] = ""
    segments: Optional[list[str]] = None  # 分段显示内容
    hologram_text: Optional[str] = None
    action: Optional[str] = None


class BotCommand(BaseModel):
    """
    “机器人动作”指令包。
    用来告诉游戏里的机器人该干嘛，比如跳一下、走两步。
    """
    type: MessageType = MessageType.BOT_COMMAND
    npc: Optional[str] = "UnknownBot"
    command: Optional[str] = "idle"  # jump, chat, move_to, etc.
    args: dict = Field(default_factory=dict)


class BotStatus(BaseModel):
    """
    “机器人近况”汇报包。
    用来告诉游戏插件：机器人现在是闲着呢，还是在忙着挖矿，或者已经掉线了。
    """
    type: MessageType = MessageType.BOT_STATUS
    npc: Optional[str] = "UnknownBot"
    status: Optional[str] = "idle"  # idle, busy, offline
    position: Optional[list[float]] = None


class Heartbeat(BaseModel):
    """
    “我还活着”心跳包。
    每隔一段时间发一次，证明女仆和插件之间的联系还没断。
    """
    type: MessageType = MessageType.HEARTBEAT
    timestamp: Optional[int] = 0


class ErrorMessage(BaseModel):
    """
    “出事了”报警包。
    当程序运行出错时，专门用来传递错误代码和具体原因。
    """
    type: MessageType = MessageType.ERROR
    code: str
    message: str


class ServantCommandMessage(BaseModel):
    """
    “管理员指令”消息包。
    专门用来处理一些高级管理操作，比如主人想要“认领”或者“释放”某个女仆。
    """
    type: MessageType = MessageType.SERVANT_COMMAND
    player: Optional[str] = "Unknown"
    player_uuid: Optional[str] = None
    command: Optional[str] = "help"  # "claim" | "release" | "list"
    target_bot: Optional[str] = None  # 目标 Bot 名称
    timestamp: Optional[int] = 0


class HologramUpdate(BaseModel):
    """
    “头顶文字更新”包。
    女仆想主动修改自己头顶上悬浮的文字（全息图）时，就发这个消息给插件。
    """
    type: MessageType = MessageType.HOLOGRAM_UPDATE
    npc: str
    hologram_text: str
    identity_line: Optional[str] = None  # 可选更新身份行


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
