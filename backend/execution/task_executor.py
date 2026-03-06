from typing import Tuple

from grounding.task_translator import translate_task_step


async def execute_task_step(bot: object, action: str, target: str) -> Tuple[bool, str]:
    """物理动作映射器：将翻译后的原子指令下发给 Mineflayer 适配器执行。"""
    command = translate_task_step(action=action, target=target)
    command_name = command.get("command")

    if command_name == "chat":
        message = command.get("message", "")
        if not message:
            return False, "speak 缺少台词"
        ok = await bot.chat(message)
        return (True, f"speak: {message}") if ok else (False, "speak 发送失败")

    if command_name == "navigate_relative":
        entity = command.get("entity", "master")
        offset_type = command.get("offset_type", "front")
        distance = float(command.get("distance", 2.0))
        ok = await bot.navigate_relative(entity, offset_type, distance)
        if not ok:
            return False, f"移动失败: {offset_type}"
        if offset_type == "front":
            return True, "已移动到主人前方"
        if offset_type == "side":
            return True, "已移动到主人身旁"
        return True, "已完成移动"

    if command_name == "look_at":
        look_target = command.get("target", "")
        ok = await bot.look_at(look_target)
        return (True, "已看向目标") if ok else (False, "看向目标失败")

    if command_name == "mine_cluster":
        resource = command.get("resource", "unknown")
        return False, f"动作 mine 暂未接入执行层（target={resource}）"

    if command_name == "unsupported":
        unsupported_action = command.get("action", action)
        unsupported_target = command.get("target", target)
        return False, f"动作 {unsupported_action} 暂未接入执行层（target={unsupported_target}）"

    return False, f"未知动作: {action}"

