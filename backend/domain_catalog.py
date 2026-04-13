import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from javascript import require

from config import settings
from domain_registry import get_domain_registry
from schemas import EnvSnapshot


BASE_DIR = Path(__file__).resolve().parent
MINECRAFT_DATA_BRIDGE_PATH = BASE_DIR / "bot" / "mineflayer" / "assets" / "minecraft_data_bridge.js"


@lru_cache(maxsize=1)
def _minecraft_data_bridge():
    return require(str(MINECRAFT_DATA_BRIDGE_PATH))(settings.mc_version)


def _bridge_json(method_name: str, *args: Any) -> Any:
    bridge = _minecraft_data_bridge()
    method = getattr(bridge, method_name)
    payload = method(*args)
    text = str(payload or "").strip()
    if not text or text in {"undefined", "null"}:
        return None
    return json.loads(text)


def _normalize_name(value: Any) -> str:
    return str(value or "").strip().lower()


def _default_log() -> str:
    log_names = _log_block_names()
    return log_names[0] if log_names else ""


def _resource_profile_name(target_name: str) -> Optional[str]:
    return get_domain_registry().resource_profile_name(target_name)


def _preferred_planks_from_log(log_name: str) -> str:
    result = _bridge_json("getPreferredPlanksJson", log_name)
    normalized = _normalize_name(result)
    if normalized:
        return normalized
    fallback_log = _default_log()
    retry = _bridge_json("getPreferredPlanksJson", fallback_log) if fallback_log else None
    return _normalize_name(retry)


def _log_block_names() -> list[str]:
    names = _bridge_json("getLogBlockNamesJson")
    if not isinstance(names, list):
        return []
    return [str(name).strip().lower() for name in names if str(name or "").strip()]


def _planks_item_names() -> list[str]:
    names = _bridge_json("getPlanksItemNamesJson")
    if not isinstance(names, list):
        return []
    return [str(name).strip().lower() for name in names if str(name or "").strip()]


def _resolve_canonical_target(keyword: str) -> tuple[Optional[str], Optional[str]]:
    normalized = _normalize_name(keyword)
    if not normalized:
        return None, None

    alias_target = get_domain_registry().target_alias_map().get(normalized)
    if alias_target:
        return alias_target, "mapping_table"

    resolved = _bridge_json("resolveCanonicalTargetJson", normalized)
    if isinstance(resolved, dict):
        target = _normalize_name(resolved.get("resolved_target"))
        if target:
            return target, str(resolved.get("kind") or "minecraft_data")
    return None, None


def _preferred_log_from_inventory(inventory: dict[str, int]) -> Optional[str]:
    best_name: Optional[str] = None
    best_count = 0
    for item_name in _log_block_names():
        item_count = int(inventory.get(item_name, 0) or 0)
        if item_count > best_count:
            best_name = item_name
            best_count = item_count
    return best_name


def _pick_preferred_log(env_snapshot: EnvSnapshot) -> str:
    inventory = env_snapshot.get("inventory") or {}
    return (
        _preferred_log_from_inventory(inventory)
        or _default_log()
    )


def _inventory_count_for_target(target_name: str, inventory: dict[str, int]) -> int:
    normalized = _normalize_name(target_name)
    if not normalized:
        return 0
    if normalized == "any_log":
        return sum(int(inventory.get(name, 0) or 0) for name in _log_block_names())
    if normalized == "planks":
        return sum(int(inventory.get(name, 0) or 0) for name in _planks_item_names())
    return int(inventory.get(normalized, 0) or 0)


def resolve_target(keyword: Any, *, action: str = "") -> dict[str, Any]:
    normalized_keyword = _normalize_name(keyword)
    resolved_target, match_source = _resolve_canonical_target(normalized_keyword)
    return {
        "input": str(keyword or ""),
        "normalized_input": normalized_keyword,
        "action": _normalize_name(action),
        "resolved_target": resolved_target,
        "match_source": match_source,
    }


def _select_best_recipe(
    recipes: list[dict[str, Any]],
    *,
    preferred_planks: str,
) -> Optional[dict[str, Any]]:
    def score(recipe: dict[str, Any]) -> tuple[int, int, int]:
        materials = list((recipe.get("materials") or {}).keys())
        exact_preferred = 0 if preferred_planks in materials else 1
        any_planks = 0 if any(name.endswith("_planks") or name == "planks" for name in materials) else 1
        bamboo_penalty = 1 if "bamboo" in materials else 0
        return (exact_preferred, any_planks, bamboo_penalty)

    valid = [recipe for recipe in recipes if isinstance(recipe, dict) and (recipe.get("materials") or {})]
    if not valid:
        return None
    return min(valid, key=score)


def get_recipe(item_name: Any, *, preferred_log: str) -> Optional[dict[str, Any]]:
    normalized_name = _normalize_name(item_name)
    if not normalized_name:
        return None

    canonical_name = normalized_name
    if normalized_name == "planks":
        canonical_name = _preferred_planks_from_log(preferred_log)

    recipes = _bridge_json("getRecipeOptionsJson", canonical_name)
    if not isinstance(recipes, list):
        return None

    selected = _select_best_recipe(recipes, preferred_planks=_preferred_planks_from_log(preferred_log))
    if not isinstance(selected, dict):
        return None
    return {
        "item": str(selected.get("item") or canonical_name),
        "requested_name": normalized_name,
        "materials": {str(name): int(count or 0) for name, count in (selected.get("materials") or {}).items()},
        "output_count": int(selected.get("output_count", 1) or 1),
        "requires_table": bool(selected.get("requires_table", False)),
    }


def get_mining_rule(target_name: Any) -> Optional[dict[str, Any]]:
    normalized_name = _normalize_name(target_name)
    if not normalized_name:
        return None
    payload = _bridge_json("getMiningRuleJson", normalized_name)
    if not isinstance(payload, dict):
        return None
    return {
        "target": str(payload.get("target") or normalized_name),
        "source_block": payload.get("source_block"),
        "drops": payload.get("drops"),
        "tool": payload.get("tool"),
        "min_tier": payload.get("min_tier"),
        "required_tool_item": payload.get("required_tool_item"),
        "candidate_blocks": list(payload.get("candidate_blocks") or []),
    }


def analyze_inventory_gap(item_name: Any, inventory: dict[str, int], *, preferred_log: str) -> Optional[dict[str, Any]]:
    recipe = get_recipe(item_name, preferred_log=preferred_log)
    if recipe is None:
        return None

    normalized_inventory = {str(name): int(count or 0) for name, count in dict(inventory or {}).items()}
    target_item = str(recipe.get("item") or "")
    target_count = _inventory_count_for_target(target_item, normalized_inventory)

    material_status: list[dict[str, Any]] = []
    for material_name, required_count in (recipe.get("materials") or {}).items():
        owned_count = _inventory_count_for_target(str(material_name), normalized_inventory)
        material_status.append(
            {
                "material": str(material_name),
                "required": int(required_count or 0),
                "owned": owned_count,
                "missing": max(int(required_count or 0) - owned_count, 0),
            }
        )

    return {
        "target_item": target_item,
        "target_count": target_count,
        "material_status": material_status,
        "can_craft_now": all(int(item["missing"]) == 0 for item in material_status),
    }


def _merge_missing_materials(base: dict[str, int], extra: dict[str, int]) -> dict[str, int]:
    merged = dict(base)
    for material_name, missing_count in (extra or {}).items():
        normalized_name = _normalize_name(material_name)
        if not normalized_name:
            continue
        merged[normalized_name] = int(merged.get(normalized_name, 0) or 0) + int(missing_count or 0)
    return merged


def _consume_inventory_item(target_name: str, amount: int, *, inventory: dict[str, int]) -> int:
    normalized_name = _normalize_name(target_name)
    if not normalized_name:
        return 0
    remaining = max(int(amount or 0), 0)
    if remaining <= 0:
        return 0

    if normalized_name == "any_log":
        consumed = 0
        for item_name in _log_block_names():
            available = int(inventory.get(item_name, 0) or 0)
            if available <= 0:
                continue
            used = min(remaining, available)
            inventory[item_name] = available - used
            remaining -= used
            consumed += used
            if remaining <= 0:
                break
        return consumed

    if normalized_name == "planks":
        consumed = 0
        for item_name in _planks_item_names():
            available = int(inventory.get(item_name, 0) or 0)
            if available <= 0:
                continue
            used = min(remaining, available)
            inventory[item_name] = available - used
            remaining -= used
            consumed += used
            if remaining <= 0:
                break
        return consumed

    available = int(inventory.get(normalized_name, 0) or 0)
    used = min(remaining, available)
    inventory[normalized_name] = available - used
    return used


def _analyze_dependency_budget_with_inventory(
    item_name: str,
    *,
    inventory: dict[str, int],
    preferred_log: str,
    desired_count: int,
    seen: set[str],
) -> dict[str, Any]:
    normalized_name = _normalize_name(item_name)
    desired_total = max(int(desired_count or 0), 1)
    recipe = get_recipe(normalized_name, preferred_log=preferred_log)

    if recipe is None:
        owned_count = _inventory_count_for_target(normalized_name, inventory)
        fulfilled_from_inventory = _consume_inventory_item(normalized_name, desired_total, inventory=inventory)
        missing_count = max(desired_total - fulfilled_from_inventory, 0)
        mining_rule = get_mining_rule(normalized_name)
        required_tool_dependency_budget = None
        required_tool_item = mining_rule.get("required_tool_item") if isinstance(mining_rule, dict) else None
        base_missing = {normalized_name: missing_count} if missing_count > 0 else {}
        if required_tool_item:
            required_tool_dependency_budget = analyze_dependency_budget(
                required_tool_item,
                dict(inventory),
                preferred_log=preferred_log,
            )
            if isinstance(required_tool_dependency_budget, dict):
                base_missing = _merge_missing_materials(
                    base_missing,
                    required_tool_dependency_budget.get("base_missing") or {},
                )
        return {
            "target_item": normalized_name,
            "desired_count": desired_total,
            "owned_count": owned_count,
            "fulfilled_from_inventory": fulfilled_from_inventory,
            "missing_target_count": missing_count,
            "output_count": 1,
            "crafts_needed": 0,
            "requires_table": False,
            "can_craft_now": fulfilled_from_inventory >= desired_total,
            "material_status": [],
            "subgoals": [],
            "base_missing": base_missing,
            "acquisition_hint": {
                "source_block": mining_rule.get("source_block") if isinstance(mining_rule, dict) else None,
                "required_tool_item": required_tool_item,
            },
            "required_tool_dependency_budget": required_tool_dependency_budget,
        }

    target_item = str(recipe.get("item") or normalized_name)
    owned_count = _inventory_count_for_target(target_item, inventory)
    fulfilled_from_inventory = _consume_inventory_item(target_item, desired_total, inventory=inventory)
    missing_target_count = max(desired_total - fulfilled_from_inventory, 0)
    output_count = max(int(recipe.get("output_count", 1) or 1), 1)
    crafts_needed = int(math.ceil(missing_target_count / output_count)) if missing_target_count > 0 else 0

    material_status: list[dict[str, Any]] = []
    subgoals: list[dict[str, Any]] = []
    base_missing: dict[str, int] = {}

    for material_name, per_craft_count in (recipe.get("materials") or {}).items():
        required_total = int(per_craft_count or 0) * crafts_needed
        if required_total <= 0:
            continue

        normalized_material = _normalize_name(material_name)
        owned_material_count = _inventory_count_for_target(normalized_material, inventory)
        if normalized_material in seen:
            fulfilled_material = _consume_inventory_item(normalized_material, required_total, inventory=inventory)
            missing_material_count = max(required_total - fulfilled_material, 0)
            material_status.append(
                {
                    "material": normalized_material,
                    "required_total": required_total,
                    "owned_before": owned_material_count,
                    "fulfilled_from_inventory": fulfilled_material,
                    "missing": missing_material_count,
                }
            )
            if missing_material_count > 0:
                base_missing[normalized_material] = int(base_missing.get(normalized_material, 0) or 0) + missing_material_count
            continue

        subgoal = _analyze_dependency_budget_with_inventory(
            normalized_material,
            inventory=inventory,
            preferred_log=preferred_log,
            desired_count=required_total,
            seen=seen | {target_item},
        )
        material_status.append(
            {
                "material": normalized_material,
                "required_total": required_total,
                "owned_before": owned_material_count,
                "fulfilled_from_inventory": int(subgoal.get("fulfilled_from_inventory", 0) or 0),
                "missing": int(subgoal.get("missing_target_count", 0) or 0),
            }
        )
        subgoals.append(subgoal)
        base_missing = _merge_missing_materials(base_missing, subgoal.get("base_missing") or {})

    if crafts_needed > 0:
        produced_total = crafts_needed * output_count
        leftover_count = max(produced_total - missing_target_count, 0)
        if leftover_count > 0:
            inventory[target_item] = int(inventory.get(target_item, 0) or 0) + leftover_count

    return {
        "target_item": target_item,
        "desired_count": desired_total,
        "owned_count": owned_count,
        "fulfilled_from_inventory": fulfilled_from_inventory,
        "missing_target_count": missing_target_count,
        "output_count": output_count,
        "crafts_needed": crafts_needed,
        "requires_table": bool(recipe.get("requires_table", False)),
        "can_craft_now": all(int(item.get("missing", 0) or 0) == 0 for item in material_status),
        "material_status": material_status,
        "subgoals": subgoals,
        "base_missing": base_missing,
    }


def analyze_dependency_budget(
    item_name: Any,
    inventory: dict[str, int],
    *,
    preferred_log: str,
    desired_count: int = 1,
) -> Optional[dict[str, Any]]:
    normalized_name = _normalize_name(item_name)
    if not normalized_name:
        return None
    working_inventory = {str(name): int(count or 0) for name, count in dict(inventory or {}).items()}
    return _analyze_dependency_budget_with_inventory(
        normalized_name,
        inventory=working_inventory,
        preferred_log=preferred_log,
        desired_count=desired_count,
        seen=set(),
    )


def build_tool_context(*, user_input: str, route_action: Any, route_target: Any, env_snapshot: EnvSnapshot) -> dict[str, Any]:
    normalized_env_snapshot = dict(env_snapshot or {})
    inventory = {str(name): int(count or 0) for name, count in dict(normalized_env_snapshot.get("inventory") or {}).items()}
    nearby_blocks = list(normalized_env_snapshot.get("nearby_blocks") or [])
    visible_block_names = [str(block.get("name") or "") for block in nearby_blocks if isinstance(block, dict)]
    preferred_log = _pick_preferred_log(env_snapshot)
    preferred_planks = _preferred_planks_from_log(preferred_log)

    resolution = resolve_target(route_target, action=str(route_action or ""))
    resolved_target = resolution.get("resolved_target") or _normalize_name(route_target)
    resource_profile = _resource_profile_name(resolved_target)
    target_recipe = get_recipe(resolved_target, preferred_log=preferred_log)
    target_mining = get_mining_rule(resolved_target)
    target_inventory_gap = analyze_inventory_gap(resolved_target, inventory, preferred_log=preferred_log)
    target_dependency_budget = analyze_dependency_budget(resolved_target, inventory, preferred_log=preferred_log)

    required_tool_item = None
    required_tool_recipe = None
    required_tool_inventory_gap = None
    required_tool_dependency_budget = None
    if isinstance(target_mining, dict):
        required_tool_item = target_mining.get("required_tool_item")
        if required_tool_item:
            required_tool_recipe = get_recipe(required_tool_item, preferred_log=preferred_log)
            required_tool_inventory_gap = analyze_inventory_gap(required_tool_item, inventory, preferred_log=preferred_log)
            required_tool_dependency_budget = analyze_dependency_budget(required_tool_item, inventory, preferred_log=preferred_log)

    explicit_nearby_crafting_table = normalized_env_snapshot.get("nearby_crafting_table")
    if explicit_nearby_crafting_table is None:
        nearby_crafting_table = any(str(name or "").strip().lower() == "crafting_table" for name in visible_block_names)
    else:
        nearby_crafting_table = bool(explicit_nearby_crafting_table)
    inventory_crafting_table_count = int(inventory.get("crafting_table", 0) or 0)

    return {
        "user_input": str(user_input or ""),
        "route": {
            "action": str(route_action or ""),
            "target": str(route_target or ""),
            "resolved_target": resolved_target,
            "resource_profile": resource_profile,
        },
        "resolution": resolution,
        "environment_hints": {
            "preferred_log": preferred_log,
            "preferred_planks": preferred_planks,
            "visible_block_names": visible_block_names,
            "nearby_crafting_table": nearby_crafting_table,
        },
        "workstations": {
            "nearby_crafting_table": nearby_crafting_table,
            "inventory_crafting_table_count": inventory_crafting_table_count,
            "target_requires_crafting_table": bool((target_recipe or {}).get("requires_table")),
            "required_tool_requires_crafting_table": bool((required_tool_recipe or {}).get("requires_table")),
        },
        "lookups": {
            "resource_profile": resource_profile,
            "target_recipe": target_recipe,
            "target_mining": target_mining,
            "target_inventory_gap": target_inventory_gap,
            "target_dependency_budget": target_dependency_budget,
            "required_tool_item": required_tool_item,
            "required_tool_recipe": required_tool_recipe,
            "required_tool_inventory_gap": required_tool_inventory_gap,
            "required_tool_dependency_budget": required_tool_dependency_budget,
        },
    }
