from typing import Optional, Tuple

from bot.mineflayer_adapter import BotManager


def resolve_bot_name(message: dict, default_bot_username: str) -> str:
    """名称解析器：从消息体或配置中提取目标女仆的唯一标识符。"""
    npc = (message.get("npc") or "").strip()
    if npc:
        return npc.lstrip("@")
    return default_bot_username


async def ensure_bot(bot_manager: Optional[BotManager], name: str) -> Tuple[Optional[object], bool]:
    """生命周期保障：确保目标 Bot 实例在线，若失联则尝试静默重连。"""
    if bot_manager is None:
        return None, False

    # 检查存量：优先从内存池中获取现有的控制器。
    current = bot_manager.get_bot(name)
    if current:
        return current, False

    try:
        # 按需创建：当且仅当第一次指令到达时才拉起物理 Bot。
        spawned = await bot_manager.spawn_bot(name)
        return spawned, True
    except Exception:
        # 错误降级：记录拉起失败，避免程序崩溃。
        return None, False

