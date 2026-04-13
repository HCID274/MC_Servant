from dataclasses import asdict
from typing import Any

from bot.interfaces import ActionResult, ActionStatus, BotActionError


def make_raw_error(
    *,
    action: str,
    target: str,
    message: str,
    raw_name: str = "ActionFailed",
    stage: str = "execute",
    retryable_hint: bool | None = False,
) -> BotActionError:
    """内部错误构造：当底层适配器未提供详情时，手动补齐可追踪的原始错误包。"""
    return BotActionError(
        source="python_executor",
        action=action,
        target=target,
        stage=stage,
        raw_name=raw_name,
        raw_message=message,
        retryable_hint=retryable_hint,
    )


def consume_or_default_raw_error(
    bot: object,
    *,
    action: str,
    target: str,
    message: str,
) -> BotActionError:
    """错误消费器：尝试从 Bot 缓存中提取真实的物理错误，实现“案发现场”还原。"""
    consumer = getattr(bot, "consume_last_action_error", None)
    if callable(consumer):
        raw_error = consumer()
        if isinstance(raw_error, BotActionError):
            return raw_error
    return make_raw_error(action=action, target=target, message=message)


def _map_error_code(raw_error: BotActionError) -> str:
    raw_name = (raw_error.raw_name or "").strip()
    raw_message = (raw_error.raw_message or "").strip()
    action = (raw_error.action or "").strip().lower()
    normalized_message = raw_message.lower()

    mapping = {
        "BotNotConnected": "bot_not_connected",
        "InvalidTargetFormat": "invalid_target_format",
        "MissingMessage": "missing_message",
        "MissingTarget": "missing_target",
        "MissingAction": "missing_action",
        "UnknownAction": "unknown_action",
        "InvalidCount": "invalid_count",
        "ActionNotImplemented": "action_not_implemented",
        "MissingRecipe": "missing_recipe",
        "MissingCraftingTable": "missing_crafting_table",
        "NoNearbyPlacement": "no_nearby_placement",
        "NoNearbyDrop": "no_nearby_drop",
        "ItemNotInInventory": "item_not_in_inventory",
        "InsufficientItemCount": "insufficient_item_count",
        "UnknownItem": "unknown_item",
        "TargetNotVisible": "target_not_visible",
        "InvalidOffsetType": "invalid_offset_type",
        "EquipStateMismatch": "equip_state_mismatch",
        "CraftStateMismatch": "craft_state_mismatch",
        "DropStateMismatch": "drop_state_mismatch",
        "DropTimeout": "drop_timeout",
        "MineTimeout": "mine_timeout",
        "PlaceStateMismatch": "place_state_mismatch",
        "BlockBrokenNoCollection": "block_broken_no_collection",
        "NoPath": "path_no_path",
        "Timeout": "path_timeout",
        "GoalChanged": "goal_changed",
        "PathStopped": "path_stopped",
        "NoItem": "no_required_tool",
        "UnresolvedDependency": "dependency_missing",
        "UnknownType": "unknown_target_type",
    }
    if raw_name in mapping:
        return mapping[raw_name]
    if "took to long to decide path to goal" in normalized_message:
        return "path_timeout"
    if "no path to the goal" in normalized_message:
        return "path_no_path"
    if "path was stopped before it could be completed" in normalized_message:
        return "path_stopped"
    if "goal was changed before it could be completed" in normalized_message:
        return "goal_changed"
    if action == "chat":
        return "chat_failed"
    if action in {"look", "look_at"}:
        return "look_failed"
    if action == "move_to":
        return "move_failed"
    return "action_failed"


def _classify_failure(error_code: str, raw_error: BotActionError) -> str:
    if error_code == "no_required_tool":
        return "fatal"
    if error_code in {"path_no_path", "path_timeout", "path_stopped", "target_not_visible", "no_nearby_drop", "no_nearby_placement", "missing_crafting_table", "drop_timeout", "mine_timeout"}:
        return "recoverable"
    if error_code in {"goal_changed"}:
        return "suspendable"
    if raw_error.retryable_hint:
        return "recoverable"
    return "fatal"


def _build_failure_reason(raw_error: BotActionError, error_code: str) -> str:
    target = raw_error.target or "目标"
    if error_code == "bot_not_connected":
        return "女仆当前未连接服务器，无法执行动作"
    if error_code == "invalid_target_format":
        return f"动作参数格式无效，无法识别目标 {target}"
    if error_code == "missing_message":
        return f"动作 {raw_error.action} 缺少要说的内容"
    if error_code == "invalid_count":
        return f"动作 {raw_error.action} 的数量参数无效"
    if error_code == "missing_target":
        return f"动作 {raw_error.action} 缺少目标参数"
    if error_code == "missing_action":
        return "任务步骤缺少 action 字段"
    if error_code == "unknown_action":
        return f"执行层不认识动作 {raw_error.action}"
    if error_code == "action_not_implemented":
        return f"动作 {raw_error.action} 当前尚未接入执行层"
    if error_code == "missing_recipe":
        return f"当前找不到 {target} 的可用合成路径或材料不足"
    if error_code == "missing_crafting_table":
        return f"合成 {target} 需要工作台，但我附近没有可用工作台"
    if error_code == "no_nearby_placement":
        return f"当前附近没有适合放置 {target} 的位置"
    if error_code == "no_nearby_drop":
        return f"当前附近没有可拾取的 {target} 掉落物"
    if error_code == "item_not_in_inventory":
        return f"背包里没有可用于执行 {raw_error.action} 的 {target}"
    if error_code == "insufficient_item_count":
        return f"背包里的 {target} 数量不够，无法完成这次交付"
    if error_code == "unknown_item":
        return f"底层执行器无法识别物品或方块 {target}"
    if error_code == "target_not_visible":
        return f"当前看不到目标 {target}，无法继续定位"
    if error_code == "invalid_offset_type":
        return f"移动偏移类型 {target} 不受支持"
    if error_code == "equip_state_mismatch":
        return f"底层已执行装备动作，但主手没有切换到 {target}"
    if error_code == "craft_state_mismatch":
        return f"底层已执行合成动作，但背包里没有看到 {target} 的实际产出"
    if error_code == "drop_state_mismatch":
        return f"底层已执行丢弃动作，但背包里的 {target} 数量没有按预期减少"
    if error_code == "drop_timeout":
        return f"丢出 {target} 时等待过久，物理交付没有确认完成"
    if error_code == "mine_timeout":
        return f"采集 {target} 时没有在时限内拿到足够数量"
    if error_code == "place_state_mismatch":
        return f"底层已执行放置动作，但世界里没有确认 {target} 已落地"
    if error_code == "block_broken_no_collection":
        return f"目标 {target} 已被破坏，但背包与掉落物都没有确认到采集结果"
    if error_code == "path_no_path":
        return f"前往 {target} 时暂时找不到可行路径"
    if error_code == "path_timeout":
        return f"前往 {target} 时寻路超时"
    if error_code == "goal_changed":
        return f"前往 {target} 的任务目标被新的指令打断"
    if error_code == "path_stopped":
        return f"前往 {target} 的移动过程被中途停止"
    if error_code == "no_required_tool":
        return f"当前缺少完成 {target} 所需的工具"
    if error_code == "dependency_missing":
        return "底层 Mineflayer 插件依赖缺失，当前动作无法执行"
    if error_code == "unknown_target_type":
        return f"底层执行器无法识别目标类型 {target}"
    return raw_error.raw_message or f"执行动作 {raw_error.action} 失败"


def _build_user_message(raw_error: BotActionError, error_code: str) -> str:
    if error_code == "bot_not_connected":
        return "我现在还没有连接到服务器，暂时做不了这个动作喵。"
    if error_code == "invalid_target_format":
        return "这个目标格式我看不懂，暂时没法执行喵。"
    if error_code == "missing_message":
        return "这句话没有内容，我暂时没法说出来喵。"
    if error_code == "invalid_count":
        return "这个动作给的数量不对，我暂时没法执行喵。"
    if error_code == "missing_target":
        return "这个动作没有目标，我暂时没法执行喵。"
    if error_code == "missing_action":
        return "这个任务步骤缺少动作类型，我没法执行喵。"
    if error_code == "unknown_action":
        return "这个动作名字我还不认识，暂时做不了喵。"
    if error_code == "action_not_implemented":
        return "这个动作我还没有学会，暂时做不了喵。"
    if error_code == "missing_recipe":
        return "我现在凑不出这个合成条件，暂时做不了喵。"
    if error_code == "missing_crafting_table":
        return "这个合成得靠工作台，但我附近还没有能用的工作台喵。"
    if error_code == "no_nearby_placement":
        return "我附近暂时没有合适的位置放下它喵。"
    if error_code == "no_nearby_drop":
        return "我附近暂时没有看到能捡的目标掉落物喵。"
    if error_code == "item_not_in_inventory":
        return "我背包里没有这个东西，暂时没法继续喵。"
    if error_code == "insufficient_item_count":
        return "我背包里的数量还不够，暂时没法按要求交付喵。"
    if error_code == "unknown_item":
        return "这个物品或方块我现在还识别不出来喵。"
    if error_code == "target_not_visible":
        return "我现在看不到目标，暂时没法过去喵。"
    if error_code == "invalid_offset_type":
        return "这个移动方向我暂时不会执行喵。"
    if error_code == "equip_state_mismatch":
        return "我刚才想拿起目标物品，但主手没有真正切过去喵。"
    if error_code == "craft_state_mismatch":
        return "我刚才尝试合成了，但背包里没有看到成品真的出现喵。"
    if error_code == "drop_state_mismatch":
        return "我刚才尝试把东西丢给主人了，但背包数量没有真的减少喵。"
    if error_code == "drop_timeout":
        return "我刚才想把东西交给主人，但等得太久还没确认成功喵。"
    if error_code == "mine_timeout":
        return "我刚才一直在采集，但在时限内还没凑够需要的数量喵。"
    if error_code == "place_state_mismatch":
        return "我刚才尝试放下方块了，但地上没有确认它真的放成功喵。"
    if error_code == "block_broken_no_collection":
        return "我把目标挖掉了，但背包和地上都没确认到收获喵。"
    if error_code == "path_no_path":
        return "我暂时找不到过去的路喵。"
    if error_code == "path_timeout":
        return "我刚才想路想太久了，暂时没走过去喵。"
    if error_code == "goal_changed":
        return "我刚才的移动目标被新的指令打断了喵。"
    if error_code == "path_stopped":
        return "我刚才走到一半被中断了喵。"
    if error_code == "no_required_tool":
        return "我手头没有合适的工具，暂时做不了这个动作喵。"
    return raw_error.raw_message or "这个动作执行失败了喵。"


def translate_action_failure(
    *,
    action: str,
    target: str,
    raw_error: BotActionError,
    extra_data: dict[str, Any] | None = None,
) -> ActionResult:
    """错误翻译官：把底层 JS/Python 错误统一转成执行层可消费的人话与错误码。"""
    error_code = _map_error_code(raw_error)
    failure_class = _classify_failure(error_code, raw_error)
    status = ActionStatus.TIMEOUT if error_code == "path_timeout" else ActionStatus.FAILED
    failure_reason = _build_failure_reason(raw_error, error_code)
    user_message = _build_user_message(raw_error, error_code)
    payload = {
        "failure_class": failure_class,
        "failure_reason": failure_reason,
        "raw_error": asdict(raw_error),
    }
    if isinstance(extra_data, dict) and extra_data:
        payload.update(extra_data)
    return ActionResult(
        success=False,
        action=action,
        message=user_message,
        status=status,
        error_code=error_code,
        data=payload,
    )


def make_success_result(
    *,
    action: str,
    message: str,
    data: dict[str, Any] | None = None,
) -> ActionResult:
    """成功结算：统一生成成功态 ActionResult。"""
    return ActionResult(
        success=True,
        action=action,
        message=message,
        status=ActionStatus.SUCCESS,
        data=data or {},
    )
