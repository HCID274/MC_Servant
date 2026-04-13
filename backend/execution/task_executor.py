import logging
from typing import Any, Awaitable, Callable, Dict

from bot.interfaces import ActionResult
from execution.error_translator import (
    consume_or_default_raw_error,
    make_raw_error,
    make_success_result,
    translate_action_failure,
)
from grounding.task_translator import translate_task_step


ActionHandler = Callable[[object, str], Awaitable[ActionResult]]
CommandHandler = Callable[[object, Dict[str, Any], str, str], Awaitable[ActionResult]]

_ACTION_HANDLERS: Dict[str, ActionHandler] = {}
_COMMAND_HANDLERS: Dict[str, CommandHandler] = {}
logger = logging.getLogger(__name__)


def _attach_step_metadata(
    result: ActionResult,
    *,
    action: str,
    target: str,
    count: int | None,
    reason: str,
    executor_command: str,
) -> ActionResult:
    """结果增强：把 Planner 的 reason 与执行命令绑定到统一结果载荷中。"""
    existing = result.data if isinstance(result.data, dict) else {}
    result.data = {
        **existing,
        "step_action": action,
        "step_target": target,
        "step_count": int(count) if count is not None else None,
        "step_reason": str(reason or "").strip(),
        "executor_command": executor_command,
    }
    return result


def _missing_capability_failure(
    *,
    action: str,
    target: str,
    capability: str,
) -> ActionResult:
    """能力缺失：底层 Bot 尚未暴露对应技能时，输出稳定的结构化错误。"""
    return translate_action_failure(
        action=action,
        target=target,
        raw_error=make_raw_error(
            action=action,
            target=target,
            message=f"Bot 当前未暴露 {capability} 能力",
            raw_name="ActionNotImplemented",
            stage="dispatch",
        ),
    )


def register_action_handler(*actions: str):
    """逻辑动作注册：将高层语义动作（如 greet）绑定到具体的执行函数。"""
    def decorator(func: ActionHandler) -> ActionHandler:
        for action_name in actions:
            normalized = (action_name or "").strip().lower()
            if normalized:
                _ACTION_HANDLERS[normalized] = func
        return func

    return decorator


def register_command_handler(*commands: str):
    """物理命令注册：将翻译后的指令（如 navigate_relative）绑定到执行函数。"""
    def decorator(func: CommandHandler) -> CommandHandler:
        for command_name in commands:
            normalized = (command_name or "").strip().lower()
            if normalized:
                _COMMAND_HANDLERS[normalized] = func
        return func

    return decorator


@register_action_handler("greet")
async def _handle_greet(bot: object, _: str) -> ActionResult:
    ok = await bot.jump()
    if ok:
        return make_success_result(action="greet", message="Ciallo~~~~")
    return translate_action_failure(
        action="greet",
        target="self",
        raw_error=consume_or_default_raw_error(
            bot,
            action="greet",
            target="self",
            message="跳跃失败，暂时没法打招呼喵。",
        ),
    )


@register_action_handler("status")
async def _handle_status(bot: object, _: str) -> ActionResult:
    pos = await bot.get_position()
    if not pos:
        return translate_action_failure(
            action="status",
            target="self",
            raw_error=consume_or_default_raw_error(
                bot,
                action="status",
                target="self",
                message="暂时无法获取当前位置",
            ),
        )
    return make_success_result(action="status", message=f"我在 ({pos[0]:.0f}, {pos[1]:.0f}, {pos[2]:.0f})")


@register_action_handler("jump")
async def _handle_jump(bot: object, _: str) -> ActionResult:
    ok = await bot.jump()
    if ok:
        return make_success_result(action="jump", message="收到，跳了一下。")
    return translate_action_failure(
        action="jump",
        target="self",
        raw_error=consume_or_default_raw_error(
            bot,
            action="jump",
            target="self",
            message="跳跃失败。",
        ),
    )


@register_action_handler("say")
async def _handle_say(bot: object, target: str) -> ActionResult:
    message = (target or "").strip()
    if not message:
        return translate_action_failure(
            action="say",
            target=target,
            raw_error=make_raw_error(
                action="say",
                target=target,
                message="say 缺少台词",
                raw_name="MissingMessage",
                stage="validate_input",
            ),
        )
    return make_success_result(
        action="say",
        message=message,
        data={"spoken_text": message},
    )


@register_action_handler("look", "look_at")
async def _handle_look(bot: object, target: str) -> ActionResult:
    look_target = (target or "").strip()
    if not look_target:
        return translate_action_failure(
            action="look_at",
            target=target,
            raw_error=make_raw_error(
                action="look_at",
                target=target,
                message="look 缺少目标",
                raw_name="MissingTarget",
                stage="validate_input",
            ),
        )
    ok = await bot.look_at(look_target)
    if ok:
        return make_success_result(action="look_at", message="已看向目标。")
    return translate_action_failure(
        action="look_at",
        target=target,
        raw_error=consume_or_default_raw_error(
            bot,
            action="look_at",
            target=target,
            message="看向失败，请确认目标格式。",
        ),
    )


@register_command_handler("chat")
async def _handle_command_chat(
    bot: object,
    command: Dict[str, Any],
    _: str,
    __: str,
) -> ActionResult:
    message = str(command.get("message", "")).strip()
    if not message:
        return translate_action_failure(
            action="speak",
            target="",
            raw_error=make_raw_error(
                action="speak",
                target="",
                message="speak 缺少台词",
                raw_name="MissingMessage",
                stage="validate_input",
            ),
        )
    logger.info("[speak] %s", message)
    return make_success_result(
        action="speak",
        message=message,
        data={"spoken_text": message},
    )


@register_command_handler("collect_drop")
async def _handle_command_collect_drop(
    bot: object,
    command: Dict[str, Any],
    _: str,
    __: str,
) -> ActionResult:
    item_name = str(command.get("item", "")).strip()
    count = int(command.get("count", 1) or 1)
    pickup = getattr(bot, "pickup", None)
    if not callable(pickup):
        return _missing_capability_failure(action="pick_up", target=item_name, capability="pickup")

    ok = await pickup(item_name or None, count)
    if ok:
        return make_success_result(
            action="pick_up",
            message=f"已尝试拾取 {count} 个 {item_name or '附近掉落物'}",
            data={"picked_target": item_name or "nearest_drop", "count": count},
        )
    return translate_action_failure(
        action="pick_up",
        target=item_name,
        raw_error=consume_or_default_raw_error(
            bot,
            action="pick_up",
            target=item_name,
            message=f"拾取 {item_name or '掉落物'} 失败",
        ),
    )


@register_command_handler("drop_item")
async def _handle_command_drop_item(
    bot: object,
    command: Dict[str, Any],
    _: str,
    __: str,
) -> ActionResult:
    item_name = str(command.get("item", "")).strip()
    count = int(command.get("count", 1) or 1)
    if not item_name:
        return translate_action_failure(
            action="drop",
            target=item_name,
            raw_error=make_raw_error(
                action="drop",
                target=item_name,
                message="drop 缺少物品名",
                raw_name="MissingTarget",
                stage="validate_input",
            ),
        )
    if count < 1:
        return translate_action_failure(
            action="drop",
            target=item_name,
            raw_error=make_raw_error(
                action="drop",
                target=item_name,
                message="drop 数量必须大于等于 1",
                raw_name="InvalidCount",
                stage="validate_input",
            ),
        )
    drop = getattr(bot, "drop", None)
    if not callable(drop):
        return _missing_capability_failure(action="drop", target=item_name, capability="drop")

    ok = await drop(item_name, count)
    if ok:
        return make_success_result(
            action="drop",
            message=f"已实际丢出 {count} 个 {item_name}",
            data={"dropped_item": item_name, "count": count},
        )
    return translate_action_failure(
        action="drop",
        target=item_name,
        raw_error=consume_or_default_raw_error(
            bot,
            action="drop",
            target=item_name,
            message=f"丢出 {count} 个 {item_name} 失败",
        ),
    )


@register_command_handler("craft_item")
async def _handle_command_craft_item(
    bot: object,
    command: Dict[str, Any],
    _: str,
    __: str,
) -> ActionResult:
    item_name = str(command.get("item", "")).strip()
    count = int(command.get("count", 1) or 1)
    if not item_name:
        return translate_action_failure(
            action="craft",
            target=item_name,
            raw_error=make_raw_error(
                action="craft",
                target=item_name,
                message="craft 缺少物品名",
                raw_name="MissingTarget",
                stage="validate_input",
            ),
        )
    craft = getattr(bot, "craft", None)
    if not callable(craft):
        return _missing_capability_failure(action="craft", target=item_name, capability="craft")

    ok = await craft(item_name, count)
    if ok:
        return make_success_result(
            action="craft",
            message=f"已尝试合成 {item_name}",
            data={"crafted_item": item_name, "count": count},
        )
    return translate_action_failure(
        action="craft",
        target=item_name,
        raw_error=consume_or_default_raw_error(
            bot,
            action="craft",
            target=item_name,
            message=f"合成 {item_name} 失败",
        ),
    )


@register_command_handler("place_block")
async def _handle_command_place_block(
    bot: object,
    command: Dict[str, Any],
    _: str,
    __: str,
) -> ActionResult:
    block_name = str(command.get("block", "")).strip()
    if not block_name:
        return translate_action_failure(
            action="place",
            target=block_name,
            raw_error=make_raw_error(
                action="place",
                target=block_name,
                message="place 缺少方块名",
                raw_name="MissingTarget",
                stage="validate_input",
            ),
        )

    place_nearby = getattr(bot, "place_nearby", None)
    if not callable(place_nearby):
        return _missing_capability_failure(action="place", target=block_name, capability="place_nearby")

    ok = await place_nearby(block_name)
    if ok:
        return make_success_result(
            action="place",
            message=f"已尝试放置 {block_name}",
            data={"placed_block": block_name},
        )
    return translate_action_failure(
        action="place",
        target=block_name,
        raw_error=consume_or_default_raw_error(
            bot,
            action="place",
            target=block_name,
            message=f"放置 {block_name} 失败",
        ),
    )


@register_command_handler("navigate_relative")
async def _handle_command_navigate_relative(
    bot: object,
    command: Dict[str, Any],
    _: str,
    __: str,
) -> ActionResult:
    entity = command.get("entity", "master")
    offset_type = command.get("offset_type", "front")
    distance = float(command.get("distance", 2.0))
    timeout = float(command.get("timeout", 120.0) or 120.0)
    ok = await bot.navigate_relative(entity, offset_type, distance, timeout=timeout)
    if not ok:
        return translate_action_failure(
            action="move_to",
            target=f"{entity}_{offset_type}",
            raw_error=consume_or_default_raw_error(
                bot,
                action="move_to",
                target=f"{entity}_{offset_type}",
                message=f"移动失败: {offset_type}",
            ),
        )
    if offset_type == "front":
        return make_success_result(action="move_to", message="已移动到主人前方")
    if offset_type == "side":
        return make_success_result(action="move_to", message="已移动到主人身旁")
    return make_success_result(action="move_to", message="已完成移动")


@register_command_handler("look_at")
async def _handle_command_look_at(
    bot: object,
    command: Dict[str, Any],
    _: str,
    __: str,
) -> ActionResult:
    look_target = str(command.get("target", "")).strip()
    if not look_target:
        return translate_action_failure(
            action="look_at",
            target=look_target,
            raw_error=make_raw_error(
                action="look_at",
                target=look_target,
                message="look_at 缺少目标",
                raw_name="MissingTarget",
                stage="validate_input",
            ),
        )
    ok = await bot.look_at(look_target)
    if ok:
        return make_success_result(action="look_at", message="已看向目标")
    return translate_action_failure(
        action="look_at",
        target=look_target,
        raw_error=consume_or_default_raw_error(
            bot,
            action="look_at",
            target=look_target,
            message="看向目标失败",
        ),
    )


@register_command_handler("mine_cluster")
async def _handle_command_mine_cluster(
    bot: object,
    command: Dict[str, Any],
    __: str,
    ___: str,
) -> ActionResult:
    resource = command.get("resource", "unknown")
    count = int(command.get("count", 1) or 1)
    resource_profile = str(command.get("resource_profile", "") or "").strip() or None
    selection_policy = str(command.get("selection_policy", "") or "").strip() or None
    mine = getattr(bot, "mine", None)
    if not callable(mine):
        return _missing_capability_failure(action="mine", target=str(resource), capability="mine")

    ok = await mine(str(resource), count)
    if ok:
        return make_success_result(
            action="mine",
            message=f"已尝试采集 {count} 个 {resource}",
            data={
                "resource": str(resource),
                "count": count,
                "resource_profile": resource_profile,
                "selection_policy": selection_policy,
            },
        )
    return translate_action_failure(
        action="mine",
        target=str(resource),
        raw_error=consume_or_default_raw_error(
            bot,
            action="mine",
            target=str(resource),
            message=f"采集 {resource} 失败",
        ),
    )


@register_command_handler("unsupported")
async def _handle_command_unsupported(
    bot: object,
    command: Dict[str, Any],
    action: str,
    target: str,
) -> ActionResult:
    unsupported_action = command.get("action", action)
    unsupported_target = command.get("target", target)
    return translate_action_failure(
        action=str(unsupported_action),
        target=str(unsupported_target),
        raw_error=make_raw_error(
            action=str(unsupported_action),
            target=str(unsupported_target),
            message=f"动作 {unsupported_action} 暂未接入执行层（target={unsupported_target}）",
            raw_name="ActionNotImplemented",
            stage="dispatch",
        ),
    )


async def execute_task_step(
    bot: object,
    action: str,
    target: str,
    reason: str = "",
    count: int | None = None,
) -> ActionResult:
    """物理动作映射器：将翻译后的原子指令下发给 Mineflayer 适配器执行。"""
    normalized_action = (action or "").strip().lower()
    normalized_target = (target or "").strip()
    normalized_reason = (reason or "").strip()
    if not normalized_action:
        return _attach_step_metadata(
            translate_action_failure(
            action="unknown",
            target=normalized_target,
            raw_error=make_raw_error(
                action="unknown",
                target=normalized_target,
                message="动作缺少 action 字段",
                raw_name="MissingAction",
                stage="validate_input",
            ),
            ),
            action="unknown",
            target=normalized_target,
            count=count,
            reason=normalized_reason,
            executor_command="validate_input",
        )

    action_handler = _ACTION_HANDLERS.get(normalized_action)
    if action_handler:
        result = await action_handler(bot, normalized_target)
        return _attach_step_metadata(
            result,
            action=normalized_action,
            target=normalized_target,
            count=count,
            reason=normalized_reason,
            executor_command=f"action:{normalized_action}",
        )

    command = translate_task_step(action=normalized_action, target=normalized_target, count=count)
    command_name = str(command.get("command") or "").strip().lower()
    command_handler = _COMMAND_HANDLERS.get(command_name)
    if command_handler:
        result = await command_handler(bot, command, normalized_action, normalized_target)
        return _attach_step_metadata(
            result,
            action=normalized_action,
            target=normalized_target,
            count=count,
            reason=normalized_reason,
            executor_command=command_name,
        )

    return _attach_step_metadata(
        translate_action_failure(
            action=normalized_action,
            target=normalized_target,
            raw_error=make_raw_error(
                action=normalized_action,
                target=normalized_target,
                message=f"未知动作: {normalized_action}",
                raw_name="UnknownAction",
                stage="dispatch",
            ),
        ),
        action=normalized_action,
        target=normalized_target,
        count=count,
        reason=normalized_reason,
        executor_command=command_name or "unknown_command",
    )
