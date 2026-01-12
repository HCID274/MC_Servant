# Crafting mediator for tag-aware material resolution

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

import logging

from bot.systems.common import _coerce_js_int
from bot.tag_resolver import get_tag_resolver, ITagResolver

logger = logging.getLogger(__name__)


@dataclass
class CraftingPlan:
    """Resolved crafting plan for one craft cycle."""

    slots: List[Tuple[int, int, str]]  # (row, col, item_name)
    missing: Dict[str, int]
    uses_tag_substitution: bool


class ICraftingMediator(ABC):
    """Abstract crafting mediator for tag-aware resolution."""

    @abstractmethod
    def resolve(
        self,
        recipe: Any,
        inventory: Dict[str, int],
        count: int,
        item_id_to_name: Callable[[int], Optional[str]],
    ) -> CraftingPlan:
        """Resolve a recipe into a concrete material plan."""
        pass


class TagCraftingMediator(ICraftingMediator):
    """Resolve crafting inputs using tag equivalence."""

    def __init__(self, tag_resolver: Optional[ITagResolver] = None) -> None:
        self._tag_resolver = tag_resolver or get_tag_resolver()

    @staticmethod
    def _normalize_name(name: Optional[str]) -> str:
        if not name:
            return ""
        n = str(name).strip()
        if n.startswith("minecraft:"):
            n = n.split("minecraft:", 1)[1]
        return n

    def _normalize_inventory(self, inventory: Dict[str, int]) -> Dict[str, int]:
        inv_norm: Dict[str, int] = {}
        for k, v in (inventory or {}).items():
            nk = self._normalize_name(k)
            if not nk:
                continue
            inv_norm[nk] = inv_norm.get(nk, 0) + int(v or 0)
        return inv_norm

    def _extract_required_materials(
        self,
        recipe: Any,
        item_id_to_name: Callable[[int], Optional[str]],
    ) -> Dict[str, int]:
        if not hasattr(recipe, "delta") or not recipe.delta:
            raise ValueError("recipe has no delta")

        required: Dict[str, int] = {}
        for delta_item in list(recipe.delta):
            try:
                if isinstance(delta_item, dict):
                    raw_id = delta_item.get("id")
                    raw_count = delta_item.get("count")
                else:
                    raw_id = getattr(delta_item, "id", None)
                    raw_count = getattr(delta_item, "count", None)

                item_id = _coerce_js_int(raw_id)
                count = _coerce_js_int(raw_count)
            except Exception as exc:
                raise TypeError(f"failed to parse recipe.delta item: {delta_item!r}") from exc

            if count < 0 and item_id is not None and item_id > 0:
                item_name = item_id_to_name(int(item_id))
                if not item_name:
                    continue
                key = self._normalize_name(item_name)
                required[key] = required.get(key, 0) + abs(int(count))

        if not required:
            raise ValueError("recipe.delta has no consumptions")

        return required

    def _choose_equivalents(
        self,
        item_name: str,
        needed: int,
        inventory_norm: Dict[str, int],
    ) -> Optional[List[str]]:
        equivalents = self._tag_resolver.get_equivalents(item_name)
        available = [(name, inventory_norm.get(name, 0)) for name in equivalents]
        available = [(name, count) for name, count in available if count > 0]
        if not available:
            return None
        total = sum(count for _, count in available)
        if total < needed:
            return None
        available.sort(key=lambda x: x[1], reverse=True)
        chosen: List[str] = []
        remaining = int(needed)
        for name, count in available:
            if remaining <= 0:
                break
            take = min(int(count), remaining)
            chosen.extend([name] * take)
            remaining -= take
        return chosen

    def _extract_cell_candidates(
        self,
        cell: Any,
        item_id_to_name: Callable[[int], Optional[str]],
    ) -> List[str]:
        candidates: List[str] = []
        if cell is None:
            return candidates
        if isinstance(cell, list):
            for candidate in cell:
                candidates.extend(self._extract_cell_candidates(candidate, item_id_to_name))
            return [c for c in candidates if c]
        try:
            raw_id = cell.get("id") if isinstance(cell, dict) else getattr(cell, "id", None)
            item_id = _coerce_js_int(raw_id)
            if item_id is None or int(item_id) <= 0:
                return []
            name = item_id_to_name(int(item_id))
            if name:
                return [self._normalize_name(name)]
        except Exception:
            return []
        return []

    def resolve(
        self,
        recipe: Any,
        inventory: Dict[str, int],
        count: int,
        item_id_to_name: Callable[[int], Optional[str]],
    ) -> CraftingPlan:
        inv_norm = self._normalize_inventory(inventory)
        required = self._extract_required_materials(recipe, item_id_to_name)

        missing: Dict[str, int] = {}
        allocations: Dict[str, List[str]] = {}
        uses_substitution = False

        for item_name, base_needed in required.items():
            total_needed = int(base_needed) * int(count)
            available_total = self._tag_resolver.get_available_count(item_name, inv_norm)
            if available_total < total_needed:
                missing[item_name] = total_needed - available_total
                continue

            chosen = self._choose_equivalents(item_name, int(base_needed), inv_norm)
            if not chosen:
                missing[item_name] = int(base_needed)
                continue

            allocations[item_name] = list(chosen)
            if any(ch != item_name for ch in chosen):
                uses_substitution = True

        if missing:
            return CraftingPlan(slots=[], missing=missing, uses_tag_substitution=uses_substitution)

        shape = getattr(recipe, "inShape", None)
        if not shape:
            logger.warning("[craft-mediator] Recipe has no inShape, cannot build slot plan.")
            return CraftingPlan(slots=[], missing=missing, uses_tag_substitution=uses_substitution)

        def safe_len(obj: Any) -> int:
            try:
                return len(obj)
            except Exception:
                try:
                    return int(obj.length)
                except Exception:
                    return 0

        max_rows = safe_len(shape)
        max_cols = safe_len(shape[0]) if max_rows > 0 else 0

        plan: List[Tuple[int, int, str]] = []
        allocations_copy: Dict[str, List[str]] = {k: list(v) for k, v in allocations.items()}

        for r in range(max_rows):
            row = shape[r]
            for c in range(max_cols):
                cell = row[c]
                if not cell:
                    continue
                candidates = self._extract_cell_candidates(cell, item_id_to_name)
                if not candidates:
                    continue
                target_name = candidates[0]
                if target_name in allocations_copy and allocations_copy[target_name]:
                    chosen_name = allocations_copy[target_name].pop(0)
                else:
                    # If recipe cell provides multiple options, pick what is available.
                    chosen_name = None
                    for cand in candidates:
                        if inv_norm.get(cand, 0) > 0:
                            chosen_name = cand
                            break
                    if not chosen_name:
                        chosen_name = target_name
                plan.append((r, c, chosen_name))

        return CraftingPlan(slots=plan, missing=missing, uses_tag_substitution=uses_substitution)
