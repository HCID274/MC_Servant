from typing import Any, Awaitable, Callable, Dict, Tuple

from grounding.task_translator import translate_task_step


ActionHandler = Callable[[object, str], Awaitable[Tuple[bool, str]]]
CommandHandler = Callable[[object, Dict[str, Any], str, str], Awaitable[Tuple[bool, str]]]

_ACTION_HANDLERS: Dict[str, ActionHandler] = {}
_COMMAND_HANDLERS: Dict[str, CommandHandler] = {}


def register_action_handler(*actions: str):
    """动作处理器注册器：将 action 名称映射到执行函数。"""
    def decorator(func: ActionHandler) -> ActionHandler:
        for action_name in actions:
            normalized = (action_name or "").strip().lower()
            if normalized:
                _ACTION_HANDLERS[normalized] = func
        return func

    return decorator


def register_command_handler(*commands: str):
    """命令处理器注册器：将 translator command 映射到执行函数。"""
    def decorator(func: CommandHandler) -> CommandHandler:
        for command_name in commands:
            normalized = (command_name or "").strip().lower()
            if normalized:
                _COMMAND_HANDLERS[normalized] = func
        return func

    return decorator


@register_action_handler("greet")
async def _handle_greet(bot: object, _: str) -> Tuple[bool, str]:
    ok = await bot.jump()
    return (True, "Ciallo~~~~") if ok else (False, "跳跃失败，暂时没法打招呼喵。")


@register_action_handler("status")
async def _handle_status(bot: object, _: str) -> Tuple[bool, str]:
    pos = await bot.get_position()
    if not pos:
        return True, "我现在还没准备好，稍后再试。"
    return True, f"我在 ({pos[0]:.0f}, {pos[1]:.0f}, {pos[2]:.0f})"


@register_action_handler("jump")
async def _handle_jump(bot: object, _: str) -> Tuple[bool, str]:
    ok = await bot.jump()
    return (True, "收到，跳了一下。") if ok else (False, "跳跃失败。")


@register_action_handler("say")
async def _handle_say(bot: object, target: str) -> Tuple[bool, str]:
    message = (target or "").strip()
    if not message:
        return False, "say 缺少台词"
    ok = await bot.chat(message)
    return (True, f"已发送聊天: {message}") if ok else (False, "聊天发送失败")


@register_action_handler("look", "look_at")
async def _handle_look(bot: object, target: str) -> Tuple[bool, str]:
    look_target = (target or "").strip()
    if not look_target:
        return False, "look 缺少目标"
    ok = await bot.look_at(look_target)
    return (True, "已看向目标。") if ok else (False, "看向失败，请确认目标格式。")


@register_command_handler("chat")
async def _handle_command_chat(
    bot: object,
    command: Dict[str, Any],
    _: str,
    __: str,
) -> Tuple[bool, str]:
    message = str(command.get("message", "")).strip()
    if not message:
        return False, "speak 缺少台词"
    ok = await bot.chat(message)
    return (True, f"speak: {message}") if ok else (False, "speak 发送失败")


@register_command_handler("navigate_relative")
async def _handle_command_navigate_relative(
    bot: object,
    command: Dict[str, Any],
    _: str,
    __: str,
) -> Tuple[bool, str]:
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


@register_command_handler("look_at")
async def _handle_command_look_at(
    bot: object,
    command: Dict[str, Any],
    _: str,
    __: str,
) -> Tuple[bool, str]:
    look_target = str(command.get("target", "")).strip()
    if not look_target:
        return False, "look_at 缺少目标"
    ok = await bot.look_at(look_target)
    return (True, "已看向目标") if ok else (False, "看向目标失败")


@register_command_handler("mine_cluster")
async def _handle_command_mine_cluster(
    _: object,
    command: Dict[str, Any],
    __: str,
    ___: str,
) -> Tuple[bool, str]:
    resource = command.get("resource", "unknown")
    return False, f"动作 mine 暂未接入执行层（target={resource}）"


@register_command_handler("unsupported")
async def _handle_command_unsupported(
    _: object,
    command: Dict[str, Any],
    action: str,
    target: str,
) -> Tuple[bool, str]:
    unsupported_action = command.get("action", action)
    unsupported_target = command.get("target", target)
    return False, f"动作 {unsupported_action} 暂未接入执行层（target={unsupported_target}）"


async def execute_task_step(bot: object, action: str, target: str) -> Tuple[bool, str]:
    """物理动作映射器：将翻译后的原子指令下发给 Mineflayer 适配器执行。"""
    normalized_action = (action or "").strip().lower()
    normalized_target = (target or "").strip()
    if not normalized_action:
        return False, "动作缺少 action 字段"

    action_handler = _ACTION_HANDLERS.get(normalized_action)
    if action_handler:
        return await action_handler(bot, normalized_target)

    command = translate_task_step(action=normalized_action, target=normalized_target)
    command_name = str(command.get("command") or "").strip().lower()
    command_handler = _COMMAND_HANDLERS.get(command_name)
    if command_handler:
        return await command_handler(bot, command, normalized_action, normalized_target)

    return False, f"未知动作: {normalized_action}"
