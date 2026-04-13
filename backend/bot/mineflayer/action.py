import asyncio
import json
import logging
import math
import time
from typing import Any, Optional

from bot.interfaces import BotActionError
from bot.runtime_rules import AIR_BLOCK_NAMES


logger = logging.getLogger(__name__)


def _is_missing_required_tool_message(message: str) -> bool:
    normalized = str(message or "").strip().lower()
    return "noitem" in normalized or "harvestable tool" in normalized


class MineflayerActionMixin:
    """物理动作扩展：封装方块交互（挖掘、放置）、工具选择、背包原子盘点及掉落物补捡逻辑。"""

    def _find_block_by_name(self, block_name: str, max_distance: int = 32) -> Any:
        """方块寻址：在物理世界中检索指定名称的方块实例。"""
        try:
            block_info = self._mcData.blocksByName[block_name]
        except Exception:
            return None
        return self._bot.findBlock({"matching": block_info.id, "maxDistance": max_distance})

    def _block_at_position_dict(self, position: dict[str, Any]) -> Any:
        """坐标反查：将 Python 坐标字典转换为物理世界的方块对象。"""
        if not isinstance(position, dict):
            return None
        try:
            x = int(position.get("x"))
            y = int(position.get("y"))
            z = int(position.get("z"))
        except Exception:
            return None
        try:
            return self._bot.blockAt(self._Vec3(x, y, z))
        except Exception:
            return None

    def _find_inventory_item(self, item_name: str) -> Any:
        """物品定位：在化身背包中查找指定名称的物品堆栈。"""
        if self._js_bridge_faulted:
            return None
        try:
            inventory = getattr(self._bot, "inventory", None)
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="inventory")
            return None
        if inventory is None or not hasattr(inventory, "items"):
            return None
        try:
            for item in inventory.items():
                if str(getattr(item, "name", "") or "").strip() == item_name:
                    return item
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="inventory.items")
            return None
        return None

    def _inventory_item_count(self, item_name: str) -> int:
        """单品盘点：统计背包中特定物品的总堆栈数量。"""
        if self._js_bridge_faulted:
            return 0
        try:
            inventory = getattr(self._bot, "inventory", None)
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="inventory")
            return 0
        if inventory is None or not hasattr(inventory, "items"):
            return 0
        total = 0
        try:
            for item in inventory.items():
                if str(getattr(item, "name", "") or "").strip() != item_name:
                    continue
                total += int(getattr(item, "count", 0) or 0)
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="inventory.items")
            return 0
        return total

    def _inventory_total_count(self, item_names: list[str]) -> int:
        """组合盘点：统计一组物品在背包中的累计总量。"""
        unique_names = [str(name or "").strip() for name in item_names if str(name or "").strip()]
        if not unique_names:
            return 0
        return sum(self._inventory_item_count(item_name) for item_name in dict.fromkeys(unique_names))

    def _is_planks_name(self, item_name: str) -> bool:
        """木板族识别：判定物品名是否属于可互换的木板家族。"""
        normalized = str(item_name or "").strip()
        return normalized.endswith("_planks")

    def _planks_item_names(self) -> list[str]:
        """木板名录：导出当前版本所有合法木板物品名。"""
        items_by_name = getattr(self._mcData, "itemsByName", None)
        if items_by_name is None:
            return []
        try:
            raw_names = list(items_by_name.keys())
        except Exception:
            raw_names = []
        names = []
        for name in raw_names:
            normalized = str(name or "").strip()
            if self._is_planks_name(normalized):
                names.append(normalized)
        return sorted(dict.fromkeys(names))

    def _is_log_name(self, item_name: str) -> bool:
        """原木语义识别：判定方块名是否属于原木类资源。"""
        normalized = str(item_name or "").strip()
        return normalized.endswith("_log") and not normalized.startswith("stripped_") and normalized != "any_log"

    def _log_block_names(self) -> list[str]:
        """原木名录：导出当前游戏版本所有合法的原木方块名。"""
        blocks_by_name = getattr(self._mcData, "blocksByName", None)
        if blocks_by_name is None:
            return []
        try:
            raw_names = list(blocks_by_name.keys())
        except Exception:
            raw_names = []
        names = []
        for name in raw_names:
            normalized = str(name or "").strip()
            if self._is_log_name(normalized):
                names.append(normalized)
        return sorted(dict.fromkeys(names))

    def _inventory_log_count(self) -> int:
        """原木库存统计：累计背包内所有种类原木的总数。"""
        if self._js_bridge_faulted:
            return 0
        try:
            inventory = getattr(self._bot, "inventory", None)
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="inventory")
            return 0
        if inventory is None or not hasattr(inventory, "items"):
            return 0
        total = 0
        try:
            for item in inventory.items():
                name = str(getattr(item, "name", "") or "").strip()
                if not self._is_log_name(name):
                    continue
                total += int(getattr(item, "count", 0) or 0)
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="inventory.items")
            return 0
        return total

    def _block_name_at(self, x: int, y: int, z: int) -> str:
        """坐标点读：获取特定坐标方块的语义名称。"""
        try:
            block = self._bot.blockAt(self._Vec3(x, y, z))
        except Exception:
            return ""
        return str(getattr(block, "name", "") or "").strip()

    def _held_item_name(self) -> str:
        """主手确认：获取化身当前选中的物品名。"""
        if self._js_bridge_faulted:
            return ""
        try:
            held_item = getattr(self._bot, "heldItem", None)
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="heldItem")
            return ""
        return str(getattr(held_item, "name", "") or "").strip()

    def _held_item_can_harvest(self, block: Any) -> Optional[bool]:
        """采集工具匹配：验证当前持有的工具是否能有效开采指定方块。"""
        if self._js_bridge_faulted:
            return None
        try:
            held_item = getattr(self._bot, "heldItem", None)
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="heldItem")
            return None
        if held_item is None or block is None:
            return None
        try:
            held_item_type = getattr(held_item, "type", None)
            if held_item_type is None:
                return None
            return bool(block.canHarvest(held_item_type))
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="heldItem.canHarvest")
            return None

    def _inventory_counts_for(self, item_names: list[str]) -> dict[str, int]:
        """局部盘点：获取指定物品清单的库存映射表。"""
        unique_names = [str(name or "").strip() for name in item_names if str(name or "").strip()]
        if not unique_names:
            return {}
        return {
            item_name: self._inventory_item_count(item_name)
            for item_name in dict.fromkeys(unique_names)
        }

    def _inventory_debug_snapshot(self) -> dict[str, int]:
        """调试盘点：导出当前背包快照，供异常留痕与状态校验使用。"""
        if self._js_bridge_faulted:
            return {}
        extractor = getattr(self, "_extract_inventory_counts", None)
        if not callable(extractor):
            return {}
        try:
            return dict(extractor())
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="inventory.snapshot")
            return {}

    def _inventory_family_count(self, family_name: str) -> int:
        """族群盘点：统计原木/木板等同族可互换物品的总数。"""
        normalized = str(family_name or "").strip()
        if normalized == "planks":
            return sum(self._inventory_item_count(item_name) for item_name in self._planks_item_names())
        if normalized == "any_log":
            return self._inventory_log_count()
        return self._inventory_item_count(normalized)

    def _sync_world_state(self, duration_seconds: float) -> None:
        """状态对齐：在阻塞线程中短暂等待服务端回包，给 Mineflayer 状态同步留时间。"""
        remaining = max(float(duration_seconds or 0.0), 0.0)
        while remaining > 0:
            slice_seconds = min(0.2, remaining)
            time.sleep(slice_seconds)
            remaining -= slice_seconds

    def _proxy_call_timeout_seconds(
        self,
        action_timeout_seconds: Optional[float],
        *,
        minimum_seconds: float = 15.0,
        maximum_seconds: float = 90.0,
    ) -> float:
        """桥接超时对齐：显式覆盖 javascript.Proxy 默认 10s Barrier 超时。"""
        timeout_seconds = float(action_timeout_seconds or 0.0)
        if timeout_seconds <= 0:
            return minimum_seconds
        return min(max(timeout_seconds, minimum_seconds), maximum_seconds)

    def _wait_until(
        self,
        predicate,
        *,
        timeout_seconds: float,
        poll_interval: float = 0.2,
    ) -> bool:
        """条件阻塞：轮询等待物理世界或背包状态达到预期。"""
        timeout_seconds = max(float(timeout_seconds or 0.0), 0.0)
        deadline = time.perf_counter() + timeout_seconds
        while True:
            try:
                if predicate():
                    return True
            except Exception:
                pass
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                break
            self._sync_world_state(min(float(poll_interval or 0.2), remaining))
        try:
            return bool(predicate())
        except Exception:
            return False

    def _force_inventory_refresh(
        self,
        *,
        reason: str,
        timeout_seconds: float = 1.5,
    ) -> dict[str, int]:
        """库存重读：等待服务端槽位同步后再次读取背包，降低本地缓存滞后的误判概率。"""
        if self._js_bridge_faulted:
            logger.warning("[inventory.refresh] skipped for %s because JS bridge is degraded", self._username)
            return {}
        timeout_seconds = max(float(timeout_seconds or 0.0), 0.0)
        logger.info("[inventory.refresh] bot=%s reason=%s timeout=%.2fs", self._username, reason, timeout_seconds)
        try:
            update_held_item = getattr(self._bot, "updateHeldItem", None)
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="updateHeldItem")
            return {}
        if callable(update_held_item):
            try:
                update_held_item()
            except Exception as exc:
                self._mark_js_bridge_fault(exc, context="updateHeldItem")
                return {}
        self._sync_world_state(timeout_seconds)
        if callable(update_held_item):
            try:
                update_held_item()
            except Exception as exc:
                self._mark_js_bridge_fault(exc, context="updateHeldItem")
                return {}
        return self._inventory_debug_snapshot()

    def _wait_for_inventory_growth(
        self,
        item_names: list[str],
        *,
        before_count: int,
        timeout_seconds: float,
    ) -> bool:
        """增量等待：阻塞直到目标物品数量相较基线出现实质增长。"""
        unique_names = [str(name or "").strip() for name in item_names if str(name or "").strip()]
        if not unique_names:
            return False
        return self._wait_until(
            lambda: self._inventory_total_count(unique_names) > before_count,
            timeout_seconds=timeout_seconds,
            poll_interval=0.15,
        )

    def _wait_for_item_count(
        self,
        item_name: str,
        *,
        minimum_count: int,
        timeout_seconds: float,
    ) -> bool:
        """结果等待：阻塞直到指定物品数量达到目标阈值。"""
        normalized_name = str(item_name or "").strip()
        if not normalized_name:
            return False
        return self._wait_until(
            lambda: self._inventory_item_count(normalized_name) >= int(minimum_count),
            timeout_seconds=timeout_seconds,
            poll_interval=0.15,
        )

    def _wait_for_item_count_at_most(
        self,
        item_name: str,
        *,
        maximum_count: int,
        timeout_seconds: float,
    ) -> bool:
        """减量等待：阻塞直到指定物品数量下降到目标上限以内。"""
        normalized_name = str(item_name or "").strip()
        if not normalized_name:
            return False
        return self._wait_until(
            lambda: self._inventory_item_count(normalized_name) <= int(maximum_count),
            timeout_seconds=timeout_seconds,
            poll_interval=0.15,
        )

    def _wait_for_held_item(
        self,
        item_name: str,
        *,
        timeout_seconds: float,
    ) -> bool:
        """装备等待：阻塞直到主手物品切换为预期目标。"""
        normalized_name = str(item_name or "").strip()
        if not normalized_name:
            return False
        return self._wait_until(
            lambda: self._held_item_name() == normalized_name,
            timeout_seconds=timeout_seconds,
            poll_interval=0.1,
        )

    def _block_debug_payload(self, block: Any) -> dict[str, Any]:
        """物理快照：封装方块的完整属性，供执行流审计与错误分析使用。"""
        if block is None:
            return {}
        payload: dict[str, Any] = {}
        try:
            payload["name"] = str(getattr(block, "name", "") or "").strip()
        except Exception:
            payload["name"] = ""
        try:
            payload["display_name"] = str(getattr(block, "displayName", "") or "").strip()
        except Exception:
            payload["display_name"] = ""
        try:
            payload["type"] = int(getattr(block, "type"))
        except Exception:
            payload["type"] = None
        try:
            payload["diggable"] = bool(getattr(block, "diggable"))
        except Exception:
            payload["diggable"] = None
        try:
            position = getattr(block, "position", None)
            payload["position"] = self._position_to_dict(position) if position is not None else None
        except Exception:
            payload["position"] = None
        return payload

    def _compact_cluster_payload(self, cluster_context: Optional[dict[str, Any]]) -> dict[str, Any]:
        """簇上下文摘要：压缩聚类信息，减少追踪日志的冗余。"""
        if not isinstance(cluster_context, dict):
            return {}
        return {
            "resource_key": cluster_context.get("resource_key"),
            "cluster_id": cluster_context.get("cluster_id"),
            "count": cluster_context.get("count"),
            "distance": cluster_context.get("distance"),
            "anchor": cluster_context.get("anchor"),
        }

    def _safe_to_break(self, block: Any) -> Optional[bool]:
        """物理破坏检查：验证方块在当前权限下是否可挖掘。"""
        if block is None:
            return None
        try:
            return bool(getattr(block, "diggable"))
        except Exception:
            return None

    def _drop_entity_count_near_position(self, position: Any, radius: float = 4.0) -> int:
        """物理证据采集：统计目标坐标附近的掉落物数量。"""
        if position is None:
            return 0
        count = 0
        for entity in self._iter_entities():
            try:
                if str(getattr(entity, "name", "") or "").strip() != "item":
                    continue
                entity_pos = getattr(entity, "position", None)
                if entity_pos is None:
                    continue
                if float(entity_pos.distanceTo(position)) <= radius:
                    count += 1
            except Exception:
                continue
        return count

    def _iter_entities(self) -> list[Any]:
        """实体迭代：稳定枚举世界中的物理实体，处理 JS/Python 对象的兼容性。"""
        if self._js_bridge_faulted:
            return []
        try:
            entities = getattr(self._bot, "entities", None)
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="entities")
            return []
        if entities is None:
            return []
        try:
            values = list(getattr(entities, "values", lambda: [])())
            if values:
                return values
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="entities.values")
            pass
        try:
            return list(dict(entities).values())
        except Exception as exc:
            self._mark_js_bridge_fault(exc, context="entities")
            return []

    def _drop_entity_item_name(self, entity: Any) -> str:
        """实体语义转换：从掉落物实体的元数据中解析出物品名称。"""
        metadata = getattr(entity, "metadata", None)
        if not metadata:
            return ""
        try:
            item = metadata[8]
            return str(getattr(item, "name", "") or "").strip()
        except Exception:
            return ""

    def _drop_entities_near_position(
        self,
        position: Any,
        *,
        radius: float = 6.0,
        target_name_filter: Optional[set[str]] = None,
    ) -> list[Any]:
        """空间实体检索：查询特定范围内符合条件的掉落物集合。"""
        if position is None:
            return []
        matches = []
        normalized_filter = {
            str(name or "").strip()
            for name in (target_name_filter or set())
            if str(name or "").strip()
        }
        for entity in self._iter_entities():
            try:
                if str(getattr(entity, "name", "") or "").strip() != "item":
                    continue
                entity_pos = getattr(entity, "position", None)
                if entity_pos is None or float(entity_pos.distanceTo(position)) > radius:
                    continue
                item_name = self._drop_entity_item_name(entity)
                if normalized_filter and item_name not in normalized_filter:
                    continue
                matches.append(entity)
            except Exception:
                continue
        return matches

    def _mine_inventory_targets(
        self,
        target_name: str,
        *,
        profile: Optional[dict[str, Any]] = None,
        selected_block_name: Optional[str] = None,
    ) -> list[str]:
        """结果预期推导：根据挖掘目标预测动作成功后应出现的背包物品名。"""
        normalized_target = str(target_name or "").strip()
        selected = str(selected_block_name or "").strip()
        names: list[str] = []
        configured_targets = profile.get("success_targets") if isinstance(profile, dict) else None
        if isinstance(configured_targets, list):
            names.extend(str(name or "").strip() for name in configured_targets if str(name or "").strip())
        if normalized_target == "any_log":
            if self._is_log_name(selected):
                names.append(selected)
            else:
                names.extend(self._log_block_names())
        else:
            if normalized_target:
                names.append(normalized_target)
            if selected and selected != normalized_target:
                names.append(selected)
        return list(dict.fromkeys(names))

    def _block_replaced_or_removed_after_collect(
        self,
        *,
        expected_block_name: str,
        live_block_name: str,
    ) -> bool:
        """破坏判定：只要原坐标不再是原目标方块，就视为方块已被成功破坏或被其他方块顶替。"""
        expected = str(expected_block_name or "").strip()
        live = str(live_block_name or "").strip()
        if not live or live in AIR_BLOCK_NAMES:
            return True
        if not expected:
            return False
        return live != expected

    def _collect_resource_key(self, target_name: str) -> str:
        """资源键对齐：将采集目标名称映射为统一的资源分类键。"""
        normalized = str(target_name or "").strip()
        if self._is_log_name(normalized):
            return "any_log"
        return normalized

    def _collect_target_name_filter(self, target_name: str) -> Optional[set[str]]:
        """过滤器生成：生成用于掉落物检索的精确匹配集合。"""
        normalized = str(target_name or "").strip()
        if self._is_log_name(normalized):
            return {normalized}
        return None

    def _block_vertical_delta(self, block: Any) -> Optional[int]:
        """高度差估算：比较 bot 脚下格与目标方块的 Y 轴差值。"""
        position = getattr(block, "position", None) if block is not None else None
        bot_position = getattr(getattr(self._bot, "entity", None), "position", None)
        if position is None or bot_position is None:
            return None
        try:
            return abs(int(getattr(position, "y")) - math.floor(float(getattr(bot_position, "y"))))
        except Exception:
            return None

    def _stair_mining_options(self, block: Any) -> dict[str, Any]:
        """楼梯采矿参数：按当前起终点跨度动态放宽搜索边界与节点预算。"""
        position = getattr(block, "position", None) if block is not None else None
        bot_position = getattr(getattr(self._bot, "entity", None), "position", None)
        if position is None or bot_position is None:
            return {
                "stepTimeoutMs": 0,
            }

        try:
            span_x = abs(int(getattr(position, "x")) - math.floor(float(getattr(bot_position, "x"))))
            span_y = abs(int(getattr(position, "y")) - math.floor(float(getattr(bot_position, "y"))))
            span_z = abs(int(getattr(position, "z")) - math.floor(float(getattr(bot_position, "z"))))
        except Exception:
            return {
                "stepTimeoutMs": 0,
            }

        horizontal_padding = max(8, min(max(span_x, span_z) // 2 + 8, 28))
        if span_y >= 6:
            horizontal_padding = max(horizontal_padding, min(max(span_x, span_z) + 8, 32))
        vertical_padding = max(6, min(span_y + (6 if span_y >= 6 else 4), 22))
        estimated_volume = (
            (span_x + 2 * horizontal_padding + 1)
            * (span_y + 2 * vertical_padding + 1)
            * (span_z + 2 * horizontal_padding + 1)
        )
        state_multiplier = 4 if span_y >= 6 else 2
        max_nodes = min(max(int(estimated_volume * state_multiplier), 40000 if span_y >= 6 else 20000), 240000)
        return {
            "horizontalPadding": horizontal_padding,
            "verticalPadding": vertical_padding,
            "maxNodes": max_nodes,
            "spiralThreshold": 6 if span_y >= 6 else 8,
            "stepTimeoutMs": 0,
        }

    def _should_use_stair_mining(
        self,
        *,
        profile: Optional[dict[str, Any]],
        block: Any,
    ) -> bool:
        """采矿策略选择：矿脉资源或垂直差过大时，改走手写楼梯采矿。"""
        vertical_delta = self._block_vertical_delta(block)
        if vertical_delta is not None and vertical_delta > 3:
            return True
        profile_name = str((profile or {}).get("profile") or "").strip()
        return profile_name == "ore_vein"

    def _execute_stair_mining_collect(self, block: Any) -> dict[str, Any]:
        """楼梯采矿执行：调用 JS 侧 BFS + 单步移动执行器，并回传诊断 JSON。"""
        helper = getattr(self, "_stair_mining_helper", None)
        if helper is None:
            raise RuntimeError("Stair mining helper is unavailable")
        position = getattr(block, "position", None) if block is not None else None
        if position is None:
            raise RuntimeError("Target block position is unavailable for stair mining")

        result = helper.executeStairPathToBlockJson(
            {
                "x": int(getattr(position, "x")),
                "y": int(getattr(position, "y")),
                "z": int(getattr(position, "z")),
            },
            self._stair_mining_options(block),
            timeout=None,
        )
        diagnostics = self._decode_json_diagnostics(result)
        if diagnostics.get("ok") is True:
            return diagnostics
        raise RuntimeError(json.dumps(diagnostics, ensure_ascii=False, sort_keys=True))

    def _stair_execution_error_name_message(self, diagnostics: dict[str, Any]) -> tuple[str, str]:
        """楼梯采矿错误归一：从 JS 诊断中提取稳定错误名，便于执行层正确分级。"""
        if not isinstance(diagnostics, dict):
            return "MineFailed", ""
        error_type = str(diagnostics.get("error_type") or "").strip()
        error_message = str(diagnostics.get("error_message") or "").strip()
        if _is_missing_required_tool_message(error_message):
            return "NoItem", error_message
        return error_type or "MineFailed", error_message

    def _collect_proxy_timeout_seconds(
        self,
        action_timeout_seconds: Optional[float],
    ) -> float:
        """超时参数对齐：确保 JS 层的执行超时设定在合理阈值内。"""
        timeout_seconds = float(action_timeout_seconds or 0)
        if timeout_seconds <= 0:
            return 60.0
        return max(timeout_seconds, 60.0)

    def _collectblock_collect(self, target: Any, *, proxy_timeout_seconds: Optional[float]) -> None:
        """物理采集：触发 collectblock 插件执行到目标的路径规划与拾取。"""
        self._bot.collectBlock.collect(
            target,
            {"ignoreNoPath": False},
            timeout=None,
        )

    def _collect_block_with_progress_watchdog(
        self,
        target: Any,
        *,
        success_targets: list[str],
        action_timeout_seconds: Optional[float],
    ) -> dict[str, Any]:
        """采集看门狗：仅当位置或目标入包持续无进展 7 秒时才中断采集。"""
        helper = getattr(self, "_collect_watchdog_helper", None)
        if helper is None:
            self._collectblock_collect(target, proxy_timeout_seconds=action_timeout_seconds)
            return {}
        stall_timeout_ms = 7000
        poll_interval_ms = 250
        result = helper.collectBlockWithProgressWatchdog(
            target,
            {
                "successTargets": list(success_targets),
                "stallTimeoutMs": stall_timeout_ms,
                "pollIntervalMs": poll_interval_ms,
            },
            timeout=None,
        )
        try:
            return json.loads(str(result or "").strip() or "{}")
        except Exception:
            return {"raw_result": str(result or "")}

    def _decode_json_diagnostics(self, payload: Any) -> dict[str, Any]:
        """诊断解码：兼容 JS 侧 diagnosticsJson 缺失或损坏时的安全降级。"""
        text = str(payload or "").strip()
        if not text:
            return {}
        try:
            return json.loads(text)
        except Exception:
            return {"raw_diagnostics": text}

    def _equip_best_tool_for_block(
        self,
        block: Any,
        *,
        action_timeout_seconds: Optional[float] = None,
    ) -> Optional[BotActionError]:
        """采前装备：在进入 collectblock 前显式切换到可挖该方块的最佳工具。"""
        if block is None:
            return None
        tool_plugin = getattr(self._bot, "tool", None)
        equip_for_block = getattr(tool_plugin, "equipForBlock", None) if tool_plugin is not None else None
        if not callable(equip_for_block):
            logger.debug("mine pre-equip skipped because bot.tool.equipForBlock is unavailable")
            if self._held_item_can_harvest(block):
                return None
            return BotActionError(
                source="mineflayer_tool",
                action="mine",
                target=str(getattr(block, "name", "") or "").strip(),
                stage="equip_tool",
                raw_name="NoItem",
                raw_message="Bot does not have a harvestable tool and mineflayer-tool is unavailable",
                position=self._get_current_position_dict(),
                target_position=self._position_to_dict(getattr(block, "position", None))
                if getattr(block, "position", None) is not None
                else None,
                extra={
                    "held_item_before": self._held_item_name(),
                    "block": self._block_debug_payload(block),
                },
                retryable_hint=False,
            )
        try:
            equip_for_block(
                block,
                {
                    "requireHarvest": True,
                    "getFromChest": False,
                    "maxTools": 2,
                },
                timeout=None,
            )
        except Exception as exc:
            if self._held_item_can_harvest(block) and not _is_missing_required_tool_message(str(exc or "")):
                return None
            return BotActionError(
                source="mineflayer_tool",
                action="mine",
                target=str(getattr(block, "name", "") or "").strip(),
                stage="equip_tool",
                raw_name=self._coerce_js_error_name(exc, "EquipToolFailed"),
                raw_message=self._coerce_js_error_message(exc, "Failed to equip best tool before mining"),
                position=self._get_current_position_dict(),
                target_position=self._position_to_dict(getattr(block, "position", None))
                if getattr(block, "position", None) is not None
                else None,
                extra={
                    "held_item_before": self._held_item_name(),
                    "block": self._block_debug_payload(block),
                },
                retryable_hint=False,
            )

        self._force_inventory_refresh(reason=f"mine_equip:{getattr(block, 'name', 'unknown')}", timeout_seconds=0.35)
        return None

    def _face_tracked_player_before_drop(
        self,
        *,
        action_timeout_seconds: Optional[float] = None,
    ) -> None:
        """交付朝向：真实 toss 前优先面向当前绑定主人，提高交付观感。"""
        tracked_player_name = self._resolve_tracked_player_name("master")
        master_player = self._lookup_player(tracked_player_name)
        if not master_player or not getattr(master_player, "entity", None):
            return
        try:
            eye_pos = master_player.entity.position.offset(0, 1.6, 0)
            try:
                self._bot.lookAt(
                    eye_pos,
                    True,
                    timeout=self._proxy_call_timeout_seconds(
                        action_timeout_seconds,
                        minimum_seconds=10.0,
                        maximum_seconds=30.0,
                    ),
                )
            except TypeError:
                self._bot.lookAt(eye_pos, True)
        except Exception as exc:
            logger.debug(
                "Best-effort lookAt before drop failed for %s: %s",
                tracked_player_name or "master",
                exc,
            )

    def _inventory_gain_detected(self, item_names: list[str], before_count: int) -> bool:
        """背包变动监测：验证动作执行后目标物品数量是否实质性增加。"""
        return self._inventory_total_count(item_names) > before_count

    def _equip_item(
        self,
        item: Any,
        *,
        item_name: str,
        destination: str = "hand",
        action_timeout_seconds: Optional[float] = None,
    ) -> Optional[BotActionError]:
        """装备闭环：调用底层 equip 后等待主手状态真正切换完成。"""
        normalized_name = str(item_name or "").strip()
        try:
            self._bot.equip(
                item,
                destination,
                timeout=self._proxy_call_timeout_seconds(
                    action_timeout_seconds,
                    minimum_seconds=15.0,
                    maximum_seconds=45.0,
                ),
            )
        except Exception as exc:
            if destination == "hand" and self._held_item_name() == normalized_name:
                logger.info(
                    "Equip action for %s raised %s but held item already matched; treating as success",
                    normalized_name,
                    type(exc).__name__ or "EquipFailed",
                )
                return None
            return BotActionError(
                source="mineflayer_core",
                action="equip",
                target=normalized_name,
                stage="execute",
                raw_name=self._coerce_js_error_name(exc, "EquipFailed"),
                raw_message=self._coerce_js_error_message(exc, f"Equip failed for {normalized_name}"),
                position=self._get_current_position_dict(),
                retryable_hint=True,
            )

        if destination != "hand":
            return None

        equip_timeout = min(max(float(action_timeout_seconds or 1.5), 0.5), 5.0)
        if self._wait_for_held_item(normalized_name, timeout_seconds=equip_timeout):
            return None

        self._force_inventory_refresh(reason=f"equip:{normalized_name}", timeout_seconds=min(1.0, equip_timeout))
        if self._held_item_name() == normalized_name:
            return None

        return BotActionError(
            source="mineflayer_core",
            action="equip",
            target=normalized_name,
            stage="postcheck",
            raw_name="EquipStateMismatch",
            raw_message=f"Equip returned but held item never switched to {normalized_name}",
            position=self._get_current_position_dict(),
            extra={
                "expected_item": normalized_name,
                "held_item_after": self._held_item_name(),
                "inventory": self._inventory_debug_snapshot(),
            },
            retryable_hint=True,
        )

    def _placement_succeeded(
        self,
        *,
        block_name: str,
        target_x: int,
        target_y: int,
        target_z: int,
        before_inventory_count: int,
    ) -> bool:
        """放置校验：通过坐标点读与背包消耗双重确认放置动作是否成功。"""
        target_name = self._block_name_at(target_x, target_y, target_z)
        after_inventory_count = self._inventory_item_count(block_name)
        return target_name == block_name and after_inventory_count < before_inventory_count

    def _recipe_requires_crafting_table(self, recipe: Any) -> bool:
        """配方工作台判定：基于 minecraft-data 配方维度判断是否必须依赖 3x3 合成台。"""
        if recipe is None:
            return False
        in_shape = getattr(recipe, "inShape", None)
        if in_shape is not None:
            try:
                rows = list(in_shape)
            except Exception:
                rows = []
            width = 0
            for row in rows:
                try:
                    width = max(width, len(list(row)))
                except Exception:
                    continue
            return len(rows) > 2 or width > 2
        ingredients = getattr(recipe, "ingredients", None)
        if ingredients is not None:
            try:
                return len(list(ingredients)) > 4
            except Exception:
                return False
        return False

    def _item_requires_crafting_table(self, item_id: Any) -> bool:
        """物品工作台判定：扫描 minecraft-data 的候选配方，判断是否至少存在 3x3 合成需求。"""
        recipes_by_id = getattr(self._mcData, "recipes", None)
        if recipes_by_id is None:
            return False
        try:
            recipes = recipes_by_id[item_id]
        except Exception:
            return False
        try:
            iterable = list(recipes or [])
        except Exception:
            iterable = []
        return any(self._recipe_requires_crafting_table(recipe) for recipe in iterable)

    def _select_craft_recipe(
        self,
        item_info: Any,
        *,
        crafting_table: Any,
        craft_count: int,
        recipe_requires_table: bool,
        action_timeout_seconds: Optional[float],
    ) -> tuple[Any, dict[str, Any]]:
        """配方选择：由 JS 侧直接操作 Mineflayer 原生 Recipe，并保留库存刷新重试。"""
        item_name = str(getattr(item_info, "name", "") or "").strip()
        diagnostics: dict[str, Any] = {
            "pre_refresh_attempts": [],
            "fallback": None,
        }
        selector = getattr(self, "_craft_recipe_helper", None)
        if selector is None:
            return None, diagnostics

        def select_once(phase: str) -> tuple[Any, dict[str, Any]]:
            try:
                result = selector.selectCraftRecipe(
                    item_name,
                    max(int(craft_count or 1), 1),
                    crafting_table,
                )
            except Exception as exc:
                return None, {
                    "phase": phase,
                    "selector_error": str(exc),
                    "inventory": self._inventory_debug_snapshot(),
                }
            recipe = getattr(result, "recipe", None) if result is not None else None
            raw_diagnostics = getattr(result, "diagnosticsJson", "") if result is not None else ""
            try:
                details = json.loads(str(raw_diagnostics or "").strip() or "{}")
            except Exception:
                details = {"raw_diagnostics": str(raw_diagnostics or "")}
            details["phase"] = phase
            details["inventory"] = self._inventory_debug_snapshot()
            return recipe, details

        recipe, initial_details = select_once("initial")
        diagnostics["pre_refresh_attempts"].append(initial_details)
        if recipe is not None:
            diagnostics["fallback"] = initial_details.get("fallback")
            diagnostics["recipes_all_count"] = initial_details.get("recipes_all_count", 0)
            return recipe, diagnostics

        refresh_timeout = 0.6 if action_timeout_seconds is None else min(max(float(action_timeout_seconds) / 20.0, 0.25), 1.0)
        refreshed_inventory = self._force_inventory_refresh(
            reason=f"craft_precheck:{item_name}",
            timeout_seconds=refresh_timeout,
        )
        recipe, refreshed_details = select_once("after_inventory_refresh")
        refreshed_details["inventory"] = refreshed_inventory
        diagnostics["pre_refresh_attempts"].append(refreshed_details)
        if recipe is not None:
            diagnostics["fallback"] = refreshed_details.get("fallback")
            diagnostics["recipes_all_count"] = refreshed_details.get("recipes_all_count", 0)
            return recipe, diagnostics

        diagnostics["recipes_all_count"] = refreshed_details.get("recipes_all_count", initial_details.get("recipes_all_count", 0))
        diagnostics["fallback"] = refreshed_details.get("fallback") or initial_details.get("fallback")
        if diagnostics["fallback"]:
            logger.info(
                "[craft.recipe_fallback] bot=%s item=%s strategy=%s canonical_items=%s chosen_item=%s required_total=%s",
                self._username,
                item_name,
                diagnostics["fallback"].get("strategy"),
                diagnostics["fallback"].get("canonical_items"),
                diagnostics["fallback"].get("chosen_item"),
                diagnostics["fallback"].get("required_total"),
            )
        return None, diagnostics

    def _ensure_crafting_table_for_craft(
        self,
        *,
        item_name: str,
        recipe_requires_table: bool,
        action_timeout_seconds: Optional[float] = None,
    ) -> tuple[Any, Optional[BotActionError]]:
        """工作台前置校验：复用现成工作台；若计划缺少放置步骤，则直接显式失败。"""
        normalized_item = str(item_name or "").strip()
        del action_timeout_seconds
        if not recipe_requires_table:
            logger.info(
                "[craft.workbench] bot=%s item=%s strategy=handcraft",
                self._username,
                normalized_item,
            )
            return None, None

        crafting_table = self._find_block_by_name("crafting_table", max_distance=8)
        if crafting_table is not None:
            logger.info(
                "[craft.workbench] bot=%s item=%s strategy=planner_or_world_ready nearby_table=true",
                self._username,
                normalized_item,
            )
            return crafting_table, None

        inventory_crafting_table_count = self._inventory_item_count("crafting_table")
        missing_strategy = (
            "planner_missing_place_step"
            if inventory_crafting_table_count > 0
            else "planner_missing_table_chain"
        )
        raw_message = (
            f"Crafting {normalized_item} requires a nearby crafting_table, "
            "but none was found; planner must place the carried crafting_table first"
            if inventory_crafting_table_count > 0
            else f"Crafting {normalized_item} requires a nearby crafting_table, "
            "but none was found and inventory has no crafting_table"
        )
        logger.info(
            "[craft.workbench] bot=%s item=%s strategy=%s nearby_table=false inventory_crafting_table_count=%s result=fail",
            self._username,
            normalized_item,
            missing_strategy,
            inventory_crafting_table_count,
        )
        return None, BotActionError(
            source="mineflayer_core",
            action="craft",
            target=normalized_item,
            stage="resolve_recipe",
            raw_name="MissingCraftingTable",
            raw_message=raw_message,
            position=self._get_current_position_dict(),
            extra={
                "craft_workbench_strategy": missing_strategy,
                "inventory_crafting_table_count": inventory_crafting_table_count,
            },
            retryable_hint=True,
        )

    def _nearest_drop_entity(self) -> Any:
        """最近物证：锁定物理化身身边的最近掉落物品。"""
        position = getattr(getattr(self._bot, "entity", None), "position", None)
        if position is None:
            return None
        best_entity = None
        best_distance = None
        for entity in self._iter_entities():
            try:
                if str(getattr(entity, "name", "") or "").strip() != "item":
                    continue
                entity_pos = getattr(entity, "position", None)
                if entity_pos is None:
                    continue
                distance = float(entity_pos.distanceTo(position))
                if best_distance is None or distance < best_distance:
                    best_distance = distance
                    best_entity = entity
            except Exception:
                continue
        return best_entity

    def _drop_entity_debug_payload(self, entity: Any) -> dict[str, Any]:
        """实体调试快照：封装掉落物实体状态。"""
        if entity is None:
            return {}
        return {
            "name": str(getattr(entity, "name", "") or "").strip(),
            "item_name": self._drop_entity_item_name(entity),
            "position": self._position_to_dict(getattr(entity, "position", None))
            if getattr(entity, "position", None) is not None
            else None,
        }

    def _drop_entity_still_exists(self, entity: Any) -> bool:
        """实体存活校验：确认指定 ID 的掉落物是否仍在世界中。"""
        entity_id = getattr(entity, "id", None)
        if entity_id is None:
            return False
        for current in self._iter_entities():
            if getattr(current, "id", None) == entity_id:
                return True
        return False

    def _is_path_planning_timeout(self, exc: Exception) -> bool:
        """路径规划异常判定：识别是否因无法生成路径或执行超时导致的物理失败。"""
        message = str(exc or "").lower()
        return "goalfollow" in message or "path" in message or "timeout" in message

    def _approach_drop_entity_for_pickup(
        self,
        entity: Any,
        *,
        proxy_timeout_seconds: Optional[float],
    ) -> bool:
        """实体趋近：尝试物理靠近并拾取特定的掉落实体。"""
        try:
            self._collectblock_collect(entity, proxy_timeout_seconds=proxy_timeout_seconds)
            return True
        except Exception as exc:
            if not self._is_path_planning_timeout(exc):
                return False
            position = getattr(entity, "position", None)
            if position is None:
                return False
            try:
                goal = self._pathfinder.goals.GoalNear(position.x, position.y, position.z, 1.0)
                self._bot.pathfinder.setGoal(goal)
                time.sleep(1.0)
                return True
            except Exception:
                return False

    def _approach_anchor_for_pickup(
        self,
        anchor_position: Any,
        *,
        proxy_timeout_seconds: Optional[float],
    ) -> bool:
        """锚点趋近：靠近方块破坏后的中心点，触发物理吸取掉落物。"""
        if anchor_position is None:
            return False
        try:
            goal = self._pathfinder.goals.GoalNear(
                anchor_position.x,
                anchor_position.y,
                anchor_position.z,
                1.0,
            )
            self._bot.pathfinder.setGoal(goal)
            time.sleep(min(2.0, self._collect_proxy_timeout_seconds(proxy_timeout_seconds) / 30.0))
            return True
        except Exception:
            return False

    def _collect_expected_drops_after_break(
        self,
        *,
        success_targets: list[str],
        before_count: int,
        anchor_position: Any,
        proxy_timeout_seconds: Optional[float],
        search_radius: float = 6.0,
    ) -> bool:
        """物理补收逻辑：当方块确已破坏但背包未增量时，主动执行空间补拣，确保动作终态一致性。"""
        logger.info(
            "[mine.post_collect] try anchor pickup bot=%s radius=%.1f",
            self._username,
            float(search_radius),
        )
        self._approach_anchor_for_pickup(anchor_position, proxy_timeout_seconds=proxy_timeout_seconds)
        if self._inventory_gain_detected(success_targets, before_count):
            logger.info("[mine.post_collect] inventory gained after approaching anchor")
            return True

        nearby_drops = self._drop_entities_near_position(
            anchor_position,
            radius=search_radius,
            target_name_filter=set(success_targets),
        )
        if not nearby_drops:
            bot_position = getattr(getattr(self._bot, "entity", None), "position", None)
            nearby_drops = self._drop_entities_near_position(
                bot_position,
                radius=search_radius,
                target_name_filter=set(success_targets),
            )
        for entity in nearby_drops:
            logger.info(
                "[mine.post_collect] nearby_drop bot=%s payload=%s",
                self._username,
                self._drop_entity_debug_payload(entity),
            )
            if self._approach_drop_entity_for_pickup(
                entity,
                proxy_timeout_seconds=proxy_timeout_seconds,
            ):
                if self._inventory_gain_detected(success_targets, before_count):
                    logger.info("[mine.post_collect] inventory gained after pickup")
                    return True
        return self._inventory_gain_detected(success_targets, before_count)

    def _do_collect_block(
        self,
        target_name: str,
        *,
        action_timeout_seconds: Optional[float] = None,
    ) -> Optional[BotActionError]:
        normalized_target = str(target_name or "").strip()
        collect_resource_key = self._collect_resource_key(normalized_target)
        target_name_filter = self._collect_target_name_filter(normalized_target)
        attempt_key = normalized_target or collect_resource_key
        profile = self._resource_profile_sync(collect_resource_key)
        cluster_context = None
        selected_block_payload: Optional[dict[str, Any]] = None
        if isinstance(profile, dict) and profile.get("resource_key"):
            logger.info(
                "[mine.route] bot=%s target=%s resource_key=%s name_filter=%s mode=cluster",
                self._username,
                normalized_target,
                collect_resource_key,
                sorted(target_name_filter) if target_name_filter else [],
            )
            block, cluster_context, selected_block_payload = self._pick_cluster_candidate(
                collect_resource_key,
                attempt_key=attempt_key,
                block_name_filter=target_name_filter,
            )
            if block is None:
                self._refresh_resource_cache_sync(radius=int(profile.get("radius", 32) or 32))
                block, cluster_context, selected_block_payload = self._pick_cluster_candidate(
                    collect_resource_key,
                    attempt_key=attempt_key,
                    block_name_filter=target_name_filter,
                )
        else:
            logger.info(
                "[mine.route] bot=%s target=%s resource_key=%s name_filter=%s mode=plain_block",
                self._username,
                normalized_target,
                collect_resource_key,
                sorted(target_name_filter) if target_name_filter else [],
            )
            block = self._find_block_by_name(normalized_target)
        if block is None:
            return BotActionError(
                source="mineflayer_core",
                action="mine",
                target=normalized_target,
                stage="resolve_target",
                raw_name="TargetNotVisible",
                raw_message=f"Target block not found: {normalized_target}",
                position=self._get_current_position_dict(),
                extra={
                    "resource_cluster": cluster_context or {},
                    "selected_block": selected_block_payload or {},
                    "collect_resource_key": collect_resource_key,
                },
                retryable_hint=True,
            )
        selected_block_name = ""
        if isinstance(selected_block_payload, dict):
            selected_block_name = str(selected_block_payload.get("name") or "").strip()
        if not selected_block_name:
            selected_block_name = str(getattr(block, "name", "") or "").strip()
        success_targets = self._mine_inventory_targets(
            normalized_target,
            profile=profile,
            selected_block_name=selected_block_name,
        )
        equip_error = self._equip_best_tool_for_block(
            block,
            action_timeout_seconds=action_timeout_seconds,
        )
        if equip_error is not None:
            return equip_error
        execution_strategy = "stair_mining" if self._should_use_stair_mining(profile=profile, block=block) else "collect_watchdog"
        vertical_delta = self._block_vertical_delta(block)
        logger.info(
            "[mine.precheck] bot=%s target=%s selected_block=%s held_item=%s can_harvest=%s success_targets=%s strategy=%s vertical_delta=%s cluster=%s",
            self._username,
            normalized_target,
            selected_block_payload or self._block_debug_payload(block),
            self._held_item_name() or "<empty>",
            self._held_item_can_harvest(block),
            success_targets,
            execution_strategy,
            vertical_delta,
            self._compact_cluster_payload(cluster_context),
        )
        pickup_search_radius = 8.0 if normalized_target == "any_log" or self._is_log_name(selected_block_name) else 6.0
        if normalized_target == "any_log":
            before_count = self._inventory_log_count()
            before_counts = {"any_log": before_count}
        else:
            before_count = self._inventory_total_count(success_targets)
            before_counts = self._inventory_counts_for(success_targets)
        nearby_drop_count_before = self._drop_entity_count_near_position(getattr(block, "position", None))
        collect_started_at = time.perf_counter()
        collect_watchdog_diagnostics: dict[str, Any] = {}
        try:
            if execution_strategy == "stair_mining":
                collect_watchdog_diagnostics = self._execute_stair_mining_collect(block)
            else:
                collect_watchdog_diagnostics = self._collect_block_with_progress_watchdog(
                    block,
                    success_targets=success_targets,
                    action_timeout_seconds=action_timeout_seconds,
                )
            duration_ms = int((time.perf_counter() - collect_started_at) * 1000)
            selected_block_position = selected_block_payload
            if selected_block_position is None and getattr(block, "position", None) is not None:
                selected_block_position = self._position_to_dict(getattr(block, "position", None))
            live_block_after = (
                self._block_at_position_dict(selected_block_position)
                if selected_block_position is not None
                else block
            )
            if normalized_target == "any_log":
                after_count = self._inventory_log_count()
                after_counts = {"any_log": after_count}
            else:
                after_counts = self._inventory_counts_for(success_targets)
                after_count = self._inventory_total_count(success_targets)
            live_block_after_name = str(getattr(live_block_after, "name", "") or "").strip()
            expected_block_name = selected_block_name or normalized_target
            block_replaced_or_removed = self._block_replaced_or_removed_after_collect(
                expected_block_name=expected_block_name,
                live_block_name=live_block_after_name,
            )
            post_collect_succeeded = False
            if (
                after_count <= before_count
                and block_replaced_or_removed
            ):
                post_collect_succeeded = self._collect_expected_drops_after_break(
                    success_targets=success_targets,
                    before_count=before_count,
                    anchor_position=getattr(block, "position", None),
                    proxy_timeout_seconds=action_timeout_seconds,
                    search_radius=pickup_search_radius,
                )
                if normalized_target == "any_log":
                    after_count = self._inventory_log_count()
                    after_counts = {"any_log": after_count}
                else:
                    after_counts = self._inventory_counts_for(success_targets)
                    after_count = self._inventory_total_count(success_targets)
            refreshed_inventory_snapshot: dict[str, int] = {}
            if (
                after_count <= before_count
                and block_replaced_or_removed
            ):
                refreshed_inventory_snapshot = self._force_inventory_refresh(
                    reason=f"mine:{normalized_target}",
                    timeout_seconds=1.5 if action_timeout_seconds is None else min(max(float(action_timeout_seconds) / 8.0, 0.8), 2.5),
                )
                if normalized_target == "any_log":
                    after_count = self._inventory_log_count()
                    after_counts = {"any_log": after_count}
                else:
                    after_counts = self._inventory_counts_for(success_targets)
                    after_count = self._inventory_total_count(success_targets)
            delta_count = after_count - before_count
            nearby_drop_count_after = self._drop_entity_count_near_position(getattr(block, "position", None))
            postcheck_payload = {
                "bot": self._username,
                "target": target_name,
                "duration_ms": duration_ms,
                "before_total_count": before_count,
                "after_total_count": after_count,
                "delta_count": delta_count,
                "before_counts": before_counts,
                "after_counts": after_counts,
                "success_targets": success_targets,
                "execution_strategy": execution_strategy,
                "selected_block": selected_block_payload or self._block_debug_payload(block),
                "live_block_after": self._block_debug_payload(live_block_after),
                "block_replaced_or_removed": block_replaced_or_removed,
                "held_item_after": self._held_item_name(),
                "held_item_can_harvest_after": self._held_item_can_harvest(block),
                "safe_to_break_after": self._safe_to_break(block),
                "nearby_drop_count_before": nearby_drop_count_before,
                "nearby_drop_count_after": nearby_drop_count_after,
                "pickup_scan_radius": pickup_search_radius,
                "cluster": self._compact_cluster_payload(cluster_context),
            }
            if collect_watchdog_diagnostics:
                postcheck_payload[execution_strategy] = collect_watchdog_diagnostics
            if post_collect_succeeded:
                postcheck_payload["post_collect"] = {"inventory_gain_detected": True}
            if refreshed_inventory_snapshot:
                postcheck_payload["inventory_after_forced_refresh"] = refreshed_inventory_snapshot
            suspicious_reasons: list[str] = []
            if delta_count <= 0:
                suspicious_reasons.append("inventory_not_increased")
            if not block_replaced_or_removed:
                suspicious_reasons.append(f"target_block_after={live_block_after_name}")
            if nearby_drop_count_after > int(nearby_drop_count_before or 0):
                suspicious_reasons.append("drops_left_near_target")
            if suspicious_reasons:
                postcheck_payload["suspicious_reasons"] = suspicious_reasons
                if after_count < before_count:
                    logger.warning(
                        "[mine.post_collect] inventory_count_regressed bot=%s target=%s before_counts=%s after_counts=%s selected_block=%s",
                        self._username,
                        normalized_target,
                        before_counts,
                        after_counts,
                        selected_block_payload or self._block_debug_payload(block),
                    )
                if delta_count <= 0:
                    logger.warning(
                        "[mine.post_collect] no_collection_after_refresh bot=%s target=%s success_targets=%s target_pos=%s live_after=%s pickup_radius=%.1f inventory=%s",
                        self._username,
                        normalized_target,
                        success_targets,
                        self._position_to_dict(getattr(block, "position", None))
                        if getattr(block, "position", None) is not None
                        else None,
                        live_block_after_name or "<unknown>",
                        pickup_search_radius,
                        refreshed_inventory_snapshot or self._inventory_debug_snapshot(),
                    )
                    if selected_block_payload:
                        self._resource_attempt_bucket(attempt_key)["failed_blocks"].add(
                            self._block_coord_key(selected_block_payload)
                        )
                    return BotActionError(
                        source="mineflayer_collectblock",
                        action="mine",
                        target=normalized_target,
                        stage="postcheck",
                        raw_name="BlockBrokenNoCollection",
                        raw_message=(
                            f"Target block {selected_block_name or normalized_target} disappeared or was replaced, "
                            "but no inventory gain or collectible drop was observed even after inventory refresh"
                        ),
                        position=self._get_current_position_dict(),
                        target_position=self._position_to_dict(getattr(block, "position", None))
                        if getattr(block, "position", None) is not None
                        else None,
                        extra={
                            "resource_cluster": cluster_context or {},
                            "selected_block": selected_block_payload or {},
                            "postcheck": postcheck_payload,
                            "collect_resource_key": collect_resource_key,
                        },
                        retryable_hint=True,
                    )
            if isinstance(profile, dict) and profile.get("resource_key"):
                try:
                    self._refresh_resource_cache_sync(radius=int(profile.get("radius", 32) or 32))
                except Exception as refresh_exc:
                    logger.debug("Resource cache refresh after mine success failed for %s: %s", self._username, refresh_exc)
                self._reset_resource_attempt_state(attempt_key)
            return None
        except Exception as exc:
            logger.exception("Mine action crashed before collect completed for %s", normalized_target)
            if self._inventory_gain_detected(success_targets, before_count):
                logger.info(
                    "Mine action for %s raised %s but inventory increased; treating as success",
                    normalized_target,
                    type(exc).__name__ or "MineFailed",
                )
                if isinstance(profile, dict) and profile.get("resource_key"):
                    try:
                        self._refresh_resource_cache_sync(radius=int(profile.get("radius", 32) or 32))
                    except Exception as refresh_exc:
                        logger.debug("Resource cache refresh after recovered mine success failed for %s: %s", self._username, refresh_exc)
                    self._reset_resource_attempt_state(attempt_key)
                return None
            if selected_block_payload:
                self._resource_attempt_bucket(attempt_key)["failed_blocks"].add(
                    self._block_coord_key(selected_block_payload)
                )
            execution_diagnostics = (
                self._decode_json_diagnostics(str(exc))
                if execution_strategy == "stair_mining"
                else self._decode_json_diagnostics(getattr(exc, "diagnosticsJson", ""))
            )
            raw_name = self._coerce_js_error_name(exc, "MineFailed")
            raw_message = self._coerce_js_error_message(exc, f"Mine failed for {normalized_target}")
            if execution_strategy == "stair_mining":
                stair_raw_name, stair_raw_message = self._stair_execution_error_name_message(execution_diagnostics)
                if stair_raw_name:
                    raw_name = stair_raw_name
                if stair_raw_message:
                    raw_message = stair_raw_message
            error_extra = {
                "resource_cluster": cluster_context or {},
                "selected_block": selected_block_payload or {},
                "collect_resource_key": collect_resource_key,
                "execution_strategy": execution_strategy,
            }
            if execution_diagnostics:
                error_extra[execution_strategy] = execution_diagnostics
            return BotActionError(
                source="mineflayer_collectblock",
                action="mine",
                target=normalized_target,
                stage="execute",
                raw_name=raw_name,
                raw_message=raw_message,
                position=self._get_current_position_dict(),
                target_position=self._position_to_dict(getattr(block, "position", None))
                if getattr(block, "position", None) is not None
                else None,
                extra=error_extra,
                retryable_hint=not _is_missing_required_tool_message(raw_message),
            )

    def _do_craft(
        self,
        item_name: str,
        count: int,
        *,
        action_timeout_seconds: Optional[float] = None,
    ) -> Optional[BotActionError]:
        try:
            item_info = self._mcData.itemsByName[item_name]
        except Exception:
            return BotActionError(
                source="python_adapter",
                action="craft",
                target=item_name,
                stage="resolve_item",
                raw_name="UnknownItem",
                raw_message=f"Unknown craft item: {item_name}",
                position=self._get_current_position_dict(),
                retryable_hint=False,
            )

        crafting_table = self._find_block_by_name("crafting_table", max_distance=8)
        recipes_without_table = list(self._bot.recipesFor(item_info.id, None, 1, None) or [])
        recipes_with_table = list(self._bot.recipesFor(item_info.id, None, 1, crafting_table) or []) if crafting_table is not None else []
        recipe = recipes_without_table[0] if recipes_without_table else (recipes_with_table[0] if recipes_with_table else None)
        recipe_requires_table = self._recipe_requires_crafting_table(recipe) if recipe is not None else self._item_requires_crafting_table(item_info.id)
        selected_crafting_table, crafting_table_error = self._ensure_crafting_table_for_craft(
            item_name=item_name,
            recipe_requires_table=recipe_requires_table,
            action_timeout_seconds=action_timeout_seconds,
        )
        if crafting_table_error is not None:
            return crafting_table_error
        recipe, recipe_diagnostics = self._select_craft_recipe(
            item_info,
            crafting_table=selected_crafting_table,
            craft_count=max(int(count or 1), 1),
            recipe_requires_table=recipe_requires_table,
            action_timeout_seconds=action_timeout_seconds,
        )
        logger.info(
            "[craft.precheck] bot=%s item=%s requires_table=%s nearby_table=%s diagnostics=%s",
            self._username,
            item_name,
            recipe_requires_table,
            bool(selected_crafting_table),
            recipe_diagnostics,
        )
        if recipe is None:
            return BotActionError(
                source="mineflayer_core",
                action="craft",
                target=item_name,
                stage="resolve_recipe",
                raw_name="MissingRecipe",
                raw_message=f"No craftable recipe available for {item_name}",
                position=self._get_current_position_dict(),
                extra={"recipe_diagnostics": recipe_diagnostics},
                retryable_hint=False,
            )

        before_count = self._inventory_item_count(item_name)
        before_inventory = self._inventory_debug_snapshot()
        expected_minimum_count = before_count + max(int(count or 1), 1)
        try:
            self._bot.craft(
                recipe,
                count,
                selected_crafting_table,
                timeout=self._proxy_call_timeout_seconds(
                    action_timeout_seconds,
                    minimum_seconds=20.0,
                    maximum_seconds=90.0,
                ),
            )
            craft_timeout = 1.5 if action_timeout_seconds is None else min(max(float(action_timeout_seconds), 1.5), 30.0)
            if self._wait_for_item_count(
                item_name,
                minimum_count=expected_minimum_count,
                timeout_seconds=craft_timeout,
            ):
                return None
            after_inventory = self._force_inventory_refresh(
                reason=f"craft:{item_name}",
                timeout_seconds=min(1.5, craft_timeout / 2.0),
            )
            after_count = self._inventory_item_count(item_name)
            if after_count >= expected_minimum_count:
                return None
            return BotActionError(
                source="mineflayer_core",
                action="craft",
                target=item_name,
                stage="postcheck",
                raw_name="CraftStateMismatch",
                raw_message=(
                    f"Craft returned but inventory did not gain the expected {item_name} "
                    f"(before={before_count}, after={after_count}, expected_at_least={expected_minimum_count})"
                ),
                position=self._get_current_position_dict(),
                extra={
                    "before_inventory": before_inventory,
                    "after_inventory": after_inventory,
                    "requested_count": int(count or 1),
                    "crafting_table": self._block_debug_payload(selected_crafting_table),
                },
                retryable_hint=True,
            )
        except Exception as exc:
            after_count = self._inventory_item_count(item_name)
            if after_count >= expected_minimum_count:
                logger.info(
                    "Craft action for %s raised %s but inventory already increased; treating as success",
                    item_name,
                    type(exc).__name__ or "CraftFailed",
                )
                return None
            return BotActionError(
                source="mineflayer_core",
                action="craft",
                target=item_name,
                stage="execute",
                raw_name=self._coerce_js_error_name(exc, "CraftFailed"),
                raw_message=self._coerce_js_error_message(exc, f"Craft failed for {item_name}"),
                position=self._get_current_position_dict(),
                retryable_hint=False,
            )

    def _do_drop(
        self,
        item_name: str,
        count: int,
        *,
        action_timeout_seconds: Optional[float] = None,
    ) -> Optional[BotActionError]:
        normalized_name = str(item_name or "").strip()
        requested_count = max(int(count or 1), 1)
        item = self._find_inventory_item(normalized_name)
        if item is None:
            return BotActionError(
                source="python_adapter",
                action="drop",
                target=normalized_name,
                stage="resolve_inventory",
                raw_name="ItemNotInInventory",
                raw_message=f"Item not in inventory: {normalized_name}",
                position=self._get_current_position_dict(),
                retryable_hint=False,
            )

        before_count = self._inventory_item_count(normalized_name)
        if before_count < requested_count:
            return BotActionError(
                source="python_adapter",
                action="drop",
                target=normalized_name,
                stage="resolve_inventory",
                raw_name="InsufficientItemCount",
                raw_message=(
                    f"Inventory has only {before_count} {normalized_name}, "
                    f"cannot drop requested {requested_count}"
                ),
                position=self._get_current_position_dict(),
                extra={"available_count": before_count, "requested_count": requested_count},
                retryable_hint=False,
            )

        before_inventory = self._inventory_debug_snapshot()
        expected_after_count = before_count - requested_count
        drop_timeout = 1.5 if action_timeout_seconds is None else min(max(float(action_timeout_seconds), 1.5), 30.0)
        try:
            self._face_tracked_player_before_drop(action_timeout_seconds=action_timeout_seconds)
            stack_count = int(getattr(item, "count", 0) or 0)
            if stack_count == requested_count:
                self._bot.tossStack(item, timeout=None)
            else:
                item_type = getattr(item, "type", None)
                if item_type is None:
                    return BotActionError(
                        source="mineflayer_core",
                        action="drop",
                        target=normalized_name,
                        stage="resolve_inventory",
                        raw_name="UnknownItem",
                        raw_message=f"Cannot resolve item type for {normalized_name}",
                        position=self._get_current_position_dict(),
                        retryable_hint=False,
                    )
                metadata = getattr(item, "metadata", None)
                self._bot.toss(item_type, metadata, requested_count, timeout=None)

            if self._wait_for_item_count_at_most(
                normalized_name,
                maximum_count=expected_after_count,
                timeout_seconds=drop_timeout,
            ):
                return None

            after_inventory = self._force_inventory_refresh(
                reason=f"drop:{normalized_name}",
                timeout_seconds=min(1.2, drop_timeout / 2.0),
            )
            after_count = self._inventory_item_count(normalized_name)
            if after_count <= expected_after_count:
                return None
            return BotActionError(
                source="mineflayer_core",
                action="drop",
                target=normalized_name,
                stage="postcheck",
                raw_name="DropStateMismatch",
                raw_message=(
                    f"Drop returned but inventory for {normalized_name} did not decrease enough "
                    f"(before={before_count}, after={after_count}, expected_at_most={expected_after_count})"
                ),
                position=self._get_current_position_dict(),
                extra={
                    "before_inventory": before_inventory,
                    "after_inventory": after_inventory,
                    "requested_count": requested_count,
                },
                retryable_hint=True,
            )
        except Exception as exc:
            after_count = self._inventory_item_count(normalized_name)
            if after_count <= expected_after_count:
                logger.info(
                    "Drop action for %s raised %s but inventory already decreased; treating as success",
                    normalized_name,
                    type(exc).__name__ or "DropFailed",
                )
                return None
            return BotActionError(
                source="mineflayer_core",
                action="drop",
                target=normalized_name,
                stage="execute",
                raw_name=self._coerce_js_error_name(exc, "DropFailed"),
                raw_message=self._coerce_js_error_message(exc, f"Drop failed for {normalized_name}"),
                position=self._get_current_position_dict(),
                extra={"requested_count": requested_count},
                retryable_hint=True,
            )

    def _do_pickup(
        self,
        item_name: Optional[str],
        *,
        action_timeout_seconds: Optional[float] = None,
    ) -> Optional[BotActionError]:
        normalized_name = str(item_name or "").strip()
        if normalized_name:
            owned_count = (
                self._inventory_total_count(self._log_block_names())
                if normalized_name == "any_log"
                else self._inventory_item_count(normalized_name)
            )
            if owned_count > 0:
                logger.info(
                    "Pickup action for %s skipped because inventory already contains the item",
                    normalized_name,
                )
                return None

        target_entity = self._nearest_drop_entity()
        if target_entity is None:
            return BotActionError(
                source="mineflayer_core",
                action="pick_up",
                target=normalized_name or "nearest_drop",
                stage="resolve_target",
                raw_name="NoNearbyDrop",
                raw_message=f"No nearby drop found for {normalized_name or 'nearest_drop'}",
                position=self._get_current_position_dict(),
                retryable_hint=True,
            )
        try:
            self._collectblock_collect(
                target_entity,
                proxy_timeout_seconds=action_timeout_seconds,
            )
            return None
        except Exception as exc:
            return BotActionError(
                source="mineflayer_collectblock",
                action="pick_up",
                target=normalized_name or "nearest_drop",
                stage="execute",
                raw_name=self._coerce_js_error_name(exc, "PickupFailed"),
                raw_message=self._coerce_js_error_message(
                    exc,
                    f"Pickup failed for {normalized_name or 'nearest_drop'}",
                ),
                position=self._get_current_position_dict(),
                retryable_hint=True,
            )

    def _do_place_nearby(
        self,
        block_name: str,
        *,
        action_timeout_seconds: Optional[float] = None,
    ) -> Optional[BotActionError]:
        item = self._find_inventory_item(block_name)
        if item is None:
            return BotActionError(
                source="python_adapter",
                action="place",
                target=block_name,
                stage="resolve_inventory",
                raw_name="ItemNotInInventory",
                raw_message=f"Item not in inventory: {block_name}",
                position=self._get_current_position_dict(),
                retryable_hint=False,
            )

        before_inventory_count = self._inventory_item_count(block_name)
        before_inventory = self._inventory_debug_snapshot()
        equip_error = self._equip_item(
            item,
            item_name=block_name,
            destination="hand",
            action_timeout_seconds=min(max(float(action_timeout_seconds or 2.0), 0.5), 5.0),
        )
        if equip_error is not None:
            return equip_error
        settle_seconds = min(max(float(action_timeout_seconds or 1.5) / 10.0, 0.25), 0.5)
        self._sync_world_state(settle_seconds)
        position = getattr(self._bot.entity, "position", None)
        if position is None:
            return BotActionError(
                source="mineflayer_core",
                action="place",
                target=block_name,
                stage="resolve_position",
                raw_name="TargetNotVisible",
                raw_message="Bot position unavailable while placing block",
                position=self._get_current_position_dict(),
                retryable_hint=True,
            )

        base_x = int(math.floor(position.x))
        base_y = int(math.floor(position.y))
        base_z = int(math.floor(position.z))
        occupied_positions = {
            (base_x, base_y, base_z),
            (base_x, base_y + 1, base_z),
        }
        invalid_support_names = set(AIR_BLOCK_NAMES) | {"water", "flowing_water", "lava", "flowing_lava"}
        valid_candidates: list[tuple[int, int, int, int, Any]] = []
        for dy in (-1, 0, 1):
            for dx in range(-2, 3):
                for dz in range(-2, 3):
                    target_x = base_x + dx
                    target_y = base_y + dy
                    target_z = base_z + dz
                    if (target_x, target_y, target_z) in occupied_positions:
                        logger.debug(
                            "Skipping place candidate for %s at (%s, %s, %s) because it overlaps bot hitbox blocks %s",
                            block_name,
                            target_x,
                            target_y,
                            target_z,
                            sorted(occupied_positions),
                        )
                        continue
                    dist_sq = dx * dx + dy * dy + dz * dz
                    if dist_sq == 0 or dist_sq > 9:
                        continue
                    target_block = self._bot.blockAt(self._Vec3(target_x, target_y, target_z))
                    target_name = str(getattr(target_block, "name", "") or "").strip()
                    if target_block is None or (target_name and target_name not in AIR_BLOCK_NAMES):
                        continue
                    reference = self._bot.blockAt(self._Vec3(target_x, target_y - 1, target_z))
                    reference_name = str(getattr(reference, "name", "") or "").strip()
                    if reference is None or reference_name in invalid_support_names:
                        continue
                    valid_candidates.append((dist_sq, target_x, target_y, target_z, reference))

        valid_candidates.sort(key=lambda item: (item[0], abs(item[2] - base_y), abs(item[1] - base_x) + abs(item[3] - base_z)))
        last_error: Optional[BotActionError] = None
        if not valid_candidates:
            logger.warning("No legal 3D placement slot found nearby for %s around (%s, %s, %s)", block_name, base_x, base_y, base_z)
        for _, target_x, target_y, target_z, reference in valid_candidates:
            place_timeout = 1.5 if action_timeout_seconds is None else min(max(float(action_timeout_seconds), 1.5), 10.0)
            try:
                self._bot.placeBlock(
                    reference,
                    self._Vec3(0, 1, 0),
                    timeout=self._proxy_call_timeout_seconds(
                        action_timeout_seconds,
                        minimum_seconds=15.0,
                        maximum_seconds=45.0,
                    ),
                )
                if self._wait_until(
                    lambda: self._placement_succeeded(
                        block_name=block_name,
                        target_x=target_x,
                        target_y=target_y,
                        target_z=target_z,
                        before_inventory_count=before_inventory_count,
                    ),
                    timeout_seconds=place_timeout,
                    poll_interval=0.15,
                ):
                    return None
                after_inventory = self._force_inventory_refresh(
                    reason=f"place:{block_name}",
                    timeout_seconds=min(1.2, place_timeout / 2.0),
                )
                if self._placement_succeeded(
                    block_name=block_name,
                    target_x=target_x,
                    target_y=target_y,
                    target_z=target_z,
                    before_inventory_count=before_inventory_count,
                ):
                    return None
                last_error = BotActionError(
                    source="mineflayer_core",
                    action="place",
                    target=block_name,
                    stage="postcheck",
                    raw_name="PlaceStateMismatch",
                    raw_message=(
                        f"Place returned but block {block_name} did not appear at "
                        f"({target_x}, {target_y}, {target_z})"
                    ),
                    position=self._get_current_position_dict(),
                    target_position={"x": float(target_x), "y": float(target_y), "z": float(target_z)},
                    extra={
                        "before_inventory": before_inventory,
                        "after_inventory": after_inventory,
                        "reference_block": self._block_debug_payload(reference),
                    },
                    retryable_hint=True,
                )
                logger.debug(
                    "Place postcheck failed for %s at (%s, %s, %s); trying next candidate",
                    block_name,
                    target_x,
                    target_y,
                    target_z,
                )
                continue
            except Exception as exc:
                if self._wait_until(
                    lambda: self._placement_succeeded(
                        block_name=block_name,
                        target_x=target_x,
                        target_y=target_y,
                        target_z=target_z,
                        before_inventory_count=before_inventory_count,
                    ),
                    timeout_seconds=min(1.0, place_timeout),
                    poll_interval=0.1,
                ):
                    logger.info(
                        "Place action for %s raised %s but block appeared at (%s, %s, %s); treating as success",
                        block_name,
                        type(exc).__name__ or "PlaceFailed",
                        target_x,
                        target_y,
                        target_z,
                    )
                    return None
                last_error = BotActionError(
                    source="mineflayer_core",
                    action="place",
                    target=block_name,
                    stage="execute",
                    raw_name=self._coerce_js_error_name(exc, "PlaceFailed"),
                    raw_message=self._coerce_js_error_message(exc, f"Place failed for {block_name}"),
                    position=self._get_current_position_dict(),
                    target_position={"x": float(target_x), "y": float(target_y), "z": float(target_z)},
                    extra={"reference_block": self._block_debug_payload(reference)},
                    retryable_hint=True,
                )
                logger.debug(
                    "Place execution failed for %s at (%s, %s, %s): %s; trying next candidate",
                    block_name,
                    target_x,
                    target_y,
                    target_z,
                    exc,
                )
                continue

        if last_error is not None:
            return last_error

        return BotActionError(
            source="python_adapter",
            action="place",
            target=block_name,
            stage="resolve_target",
            raw_name="NoNearbyPlacement",
            raw_message=f"No nearby placement slot for {block_name}",
            position=self._get_current_position_dict(),
            retryable_hint=True,
        )

    async def mine(self, block_type: str, count: int = 1, timeout: float = 120.0) -> bool:
        self._clear_action_error()
        if not self.is_connected:
            self._set_action_error(
                source="python_adapter",
                action="mine",
                target=block_type,
                stage="precheck",
                raw_name="BotNotConnected",
                raw_message="Bot not connected",
                retryable_hint=False,
            )
            return False
        profile = self._resource_profile_sync(block_type)
        if isinstance(profile, dict) and profile.get("resource_key"):
            snapshot = self._resource_cache_snapshot_sync()
            if int(snapshot.get("version", 0) or 0) <= 0:
                try:
                    await self._refresh_resource_cache_async(radius=int(profile.get("radius", 32) or 32))
                except Exception as exc:
                    logger.debug("Resource cache refresh before mine failed for %s: %s", self._username, exc)
            else:
                await self._schedule_resource_cache_refresh_if_needed(radius=int(profile.get("radius", 32) or 32))
        try:
            loop = asyncio.get_event_loop()
            requested_count = max(int(count or 1), 1)
            for _ in range(requested_count):
                action_error = await loop.run_in_executor(
                    None,
                    lambda: self._do_collect_block(block_type, action_timeout_seconds=timeout),
                )
                if action_error is not None:
                    self._last_action_error = action_error
                    return False
            return True
        except Exception as exc:
            logger.exception("Mine coroutine failed for %s", block_type)
            self._set_action_error(
                source="mineflayer_collectblock",
                action="mine",
                target=block_type,
                stage="execute",
                raw_name=self._coerce_js_error_name(exc, "MineFailed"),
                raw_message=self._coerce_js_error_message(exc, f"Mine failed for {block_type}"),
                retryable_hint=True,
            )
            return False

    async def craft(self, item_name: str, count: int = 1, timeout: float = 30.0) -> bool:
        self._clear_action_error()
        if not self.is_connected:
            self._set_action_error(
                source="python_adapter",
                action="craft",
                target=item_name,
                stage="precheck",
                raw_name="BotNotConnected",
                raw_message="Bot not connected",
                retryable_hint=False,
            )
            return False
        try:
            loop = asyncio.get_event_loop()
            action_error = await loop.run_in_executor(
                None,
                lambda: self._do_craft(item_name, count, action_timeout_seconds=timeout),
            )
            if action_error is not None:
                self._last_action_error = action_error
                return False
            return True
        except Exception as exc:
            self._set_action_error(
                source="mineflayer_core",
                action="craft",
                target=item_name,
                stage="execute",
                raw_name=self._coerce_js_error_name(exc, "CraftFailed"),
                raw_message=self._coerce_js_error_message(exc, f"Craft failed for {item_name}"),
                retryable_hint=False,
            )
            return False

    async def drop(self, item_name: str, count: int = 1, timeout: float = 30.0) -> bool:
        self._clear_action_error()
        if not self.is_connected:
            self._set_action_error(
                source="python_adapter",
                action="drop",
                target=item_name,
                stage="precheck",
                raw_name="BotNotConnected",
                raw_message="Bot not connected",
                retryable_hint=False,
            )
            return False
        try:
            loop = asyncio.get_event_loop()
            action_error = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    lambda: self._do_drop(item_name, count, action_timeout_seconds=timeout),
                ),
                timeout=max(float(timeout or 0.0), 1.0) + 2.0,
            )
            if action_error is not None:
                self._last_action_error = action_error
                return False
            return True
        except asyncio.TimeoutError:
            self._set_action_error(
                source="mineflayer_core",
                action="drop",
                target=item_name,
                stage="execute",
                raw_name="DropTimeout",
                raw_message=f"Drop timed out for {item_name}",
                retryable_hint=True,
            )
            return False
        except Exception as exc:
            self._set_action_error(
                source="mineflayer_core",
                action="drop",
                target=item_name,
                stage="execute",
                raw_name=self._coerce_js_error_name(exc, "DropFailed"),
                raw_message=self._coerce_js_error_message(exc, f"Drop failed for {item_name}"),
                retryable_hint=True,
            )
            return False

    async def pickup(
        self,
        target: Optional[str] = None,
        count: int = -1,
        radius: int = 16,
        timeout: float = 60.0,
    ) -> bool:
        del count, radius
        self._clear_action_error()
        if not self.is_connected:
            self._set_action_error(
                source="python_adapter",
                action="pick_up",
                target=target or "nearest_drop",
                stage="precheck",
                raw_name="BotNotConnected",
                raw_message="Bot not connected",
                retryable_hint=False,
            )
            return False
        try:
            loop = asyncio.get_event_loop()
            action_error = await loop.run_in_executor(
                None,
                lambda: self._do_pickup(target, action_timeout_seconds=timeout),
            )
            if action_error is not None:
                self._last_action_error = action_error
                return False
            return True
        except Exception as exc:
            self._set_action_error(
                source="mineflayer_collectblock",
                action="pick_up",
                target=target or "nearest_drop",
                stage="execute",
                raw_name=self._coerce_js_error_name(exc, "PickupFailed"),
                raw_message=self._coerce_js_error_message(exc, f"Pickup failed for {target or 'nearest_drop'}"),
                retryable_hint=True,
            )
            return False

    async def place_nearby(self, block_name: str, timeout: float = 10.0) -> bool:
        self._clear_action_error()
        if not self.is_connected:
            self._set_action_error(
                source="python_adapter",
                action="place",
                target=block_name,
                stage="precheck",
                raw_name="BotNotConnected",
                raw_message="Bot not connected",
                retryable_hint=False,
            )
            return False
        try:
            loop = asyncio.get_event_loop()
            action_error = await loop.run_in_executor(
                None,
                lambda: self._do_place_nearby(block_name, action_timeout_seconds=timeout),
            )
            if action_error is not None:
                self._last_action_error = action_error
                return False
            return True
        except Exception as exc:
            self._set_action_error(
                source="mineflayer_core",
                action="place",
                target=block_name,
                stage="execute",
                raw_name=self._coerce_js_error_name(exc, "PlaceFailed"),
                raw_message=self._coerce_js_error_message(exc, f"Place failed for {block_name}"),
                retryable_hint=True,
            )
            return False
