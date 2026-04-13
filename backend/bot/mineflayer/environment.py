import asyncio
import json
import logging
from typing import Any, Dict, Optional, Tuple

from bot.runtime_rules import AIR_BLOCK_NAMES


logger = logging.getLogger(__name__)


class MineflayerEnvironmentMixin:
    """环境感知：实现 Bot 的空间探索、资源聚类分析、实体追踪及背包状态快照。"""

    def _parse_json_payload(self, payload: Any) -> Any:
        """格式化解析：将 JS 桥接层返回的原始字节或字符串转换为 Python 字典。"""
        if payload is None:
            return None
        text = payload.decode("utf-8", errors="ignore") if isinstance(payload, bytes) else str(payload)
        text = text.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            logger.debug("Parse environment snapshot payload failed for %s: %s", self._username, exc)
            return None

    def _parse_snapshot_payload(self, payload: Any) -> dict[str, Any]:
        """快照映射：确保环境数据以字典形式返回。"""
        parsed = self._parse_json_payload(payload)
        return parsed if isinstance(parsed, dict) else {}

    def _resource_cache_snapshot_sync(self) -> dict[str, Any]:
        """缓存检索：同步获取当前已扫描的资源缓存元数据及锚点状态。"""
        helper = self._resource_cache_helper
        method = getattr(helper, "getResourceCacheSnapshotJson", None) if helper is not None else None
        if not callable(method) or self._bot is None:
            return {}
        try:
            return self._parse_snapshot_payload(method(self._bot))
        except Exception as exc:
            logger.debug("Get resource cache snapshot failed for %s: %s", self._username, exc)
            return {}

    def _resource_cache_anchor_distance(self) -> Optional[float]:
        """位移检测：计算化身与资源扫描锚点间的欧氏距离，判断是否需要更新缓存。"""
        snapshot = self._resource_cache_snapshot_sync()
        anchor = snapshot.get("anchor") if isinstance(snapshot, dict) else None
        position = getattr(getattr(self._bot, "entity", None), "position", None)
        if not isinstance(anchor, dict) or position is None:
            return None
        try:
            dx = float(position.x) - float(anchor.get("x"))
            dy = float(position.y) - float(anchor.get("y"))
            dz = float(position.z) - float(anchor.get("z"))
        except Exception:
            return None
        return (dx * dx + dy * dy + dz * dz) ** 0.5

    def _refresh_resource_cache_sync(self, *, radius: int = 32) -> dict[str, Any]:
        """强制扫描：同步触发物理世界方块扫描并重建资源聚类。"""
        helper = self._resource_cache_helper
        method = getattr(helper, "refreshResourceCacheJson", None) if helper is not None else None
        if not callable(method) or self._bot is None:
            return {}
        payload = method(self._bot, {"radius": int(radius or 32)})
        return self._parse_snapshot_payload(payload)

    async def _refresh_resource_cache_async(self, *, radius: int = 32) -> dict[str, Any]:
        """异步扫描：在执行器线程中执行耗时的方块迭代，避免阻塞 asyncio 事件循环。"""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, lambda: self._refresh_resource_cache_sync(radius=radius))

    async def _schedule_resource_cache_refresh_if_needed(
        self,
        *,
        threshold: float = 16.0,
        radius: int = 32,
    ) -> None:
        """增量更新策略：根据位移距离自动决定是否启动后台扫描，维持空间感知的实时性。"""
        if not self.is_connected:
            return
        if self._resource_cache_refresh_task is not None and not self._resource_cache_refresh_task.done():
            return

        snapshot = self._resource_cache_snapshot_sync()
        version = int(snapshot.get("version", 0) or 0) if isinstance(snapshot, dict) else 0
        if version <= 0:
            await self._refresh_resource_cache_async(radius=radius)
            return

        distance = self._resource_cache_anchor_distance()
        if distance is None or distance <= float(threshold):
            return

        async def _runner() -> None:
            try:
                await self._refresh_resource_cache_async(radius=radius)
            except Exception as exc:
                logger.debug("Background resource cache refresh failed for %s: %s", self._username, exc)

        self._resource_cache_refresh_task = asyncio.create_task(_runner())

    def _query_best_resource_cluster_sync(
        self,
        resource_key: str,
        *,
        player_name: Optional[str] = None,
    ) -> dict[str, Any]:
        """聚类决策：基于距离与资源密度，查询当前视野内最理想的任务执行簇。"""
        helper = self._resource_cache_helper
        method = getattr(helper, "queryBestClusterJson", None) if helper is not None else None
        if not callable(method) or self._bot is None:
            return {}
        try:
            payload = method(self._bot, str(resource_key or ""), {"playerName": player_name or ""})
            return self._parse_snapshot_payload(payload)
        except Exception as exc:
            logger.debug("Query best resource cluster failed for %s: %s", self._username, exc)
            return {}

    def _query_resource_clusters_sync(
        self,
        resource_key: str,
        *,
        player_name: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """全量簇查询：检索特定资源名下所有的空间聚类详情。"""
        helper = self._resource_cache_helper
        method = getattr(helper, "queryClustersJson", None) if helper is not None else None
        if not callable(method) or self._bot is None:
            return []
        try:
            payload = method(self._bot, str(resource_key or ""), {"playerName": player_name or ""})
            parsed = self._parse_json_payload(payload)
        except Exception as exc:
            logger.debug("Query resource clusters failed for %s: %s", self._username, exc)
            return []
        if not isinstance(parsed, list):
            return []
        return [item for item in parsed if isinstance(item, dict)]

    def _resource_profile_sync(self, resource_key: str) -> dict[str, Any]:
        """配置对齐：获取特定资源的底层方块名、采集工具及优先级配置。"""
        helper = self._resource_cache_helper
        method = getattr(helper, "getResourceProfileJson", None) if helper is not None else None
        if not callable(method):
            return {}
        try:
            payload = method(str(resource_key or ""))
            return self._parse_snapshot_payload(payload)
        except Exception as exc:
            logger.debug("Get resource profile failed for %s: %s", self._username, exc)
            return {}

    def _resource_attempt_bucket(self, resource_key: str) -> Dict[str, set[str]]:
        """失败记忆：记录当前任务中已验证为“无法到达”或“采集失败”的坐标，防止死循环。"""
        normalized = str(resource_key or "").strip().lower()
        if normalized not in self._resource_attempt_state:
            self._resource_attempt_state[normalized] = {
                "failed_blocks": set(),
                "failed_clusters": set(),
            }
        return self._resource_attempt_state[normalized]

    def _reset_resource_attempt_state(self, resource_key: str) -> None:
        """记忆重置：清除特定资源的采集失败历史。"""
        normalized = str(resource_key or "").strip().lower()
        self._resource_attempt_state.pop(normalized, None)

    def _block_coord_key(self, position: dict[str, Any]) -> str:
        """坐标哈希：生成稳定的物理方块坐标字符串键。"""
        if not isinstance(position, dict):
            return ""
        try:
            return f"{int(position.get('x'))},{int(position.get('y'))},{int(position.get('z'))}"
        except Exception:
            return ""

    def _pick_cluster_candidate(
        self,
        resource_key: str,
        *,
        player_name: Optional[str] = None,
        attempt_key: Optional[str] = None,
        block_name_filter: Optional[set[str]] = None,
    ) -> tuple[Any, Optional[dict[str, Any]], Optional[dict[str, Any]]]:
        """候选者筛选：结合距离、密度与失败记录，选择下一个最佳采集目标。"""
        clusters = self._query_resource_clusters_sync(resource_key, player_name=player_name)
        if not clusters:
            return None, None, None

        bucket = self._resource_attempt_bucket(attempt_key or resource_key)
        failed_blocks = bucket["failed_blocks"]
        failed_clusters = bucket["failed_clusters"]
        normalized_filter = {
            str(name or "").strip()
            for name in (block_name_filter or set())
            if str(name or "").strip()
        }

        def _distance_score(block: dict[str, Any]) -> float:
            position = getattr(getattr(self._bot, "entity", None), "position", None)
            if position is None:
                return 0.0
            try:
                dx = float(position.x) - float(block.get("x"))
                dy = float(position.y) - float(block.get("y"))
                dz = float(position.z) - float(block.get("z"))
            except Exception:
                return 999999.0
            return dx * dx + dy * dy + dz * dz

        ordered_clusters = []
        for cluster in clusters:
            cluster_id = str(cluster.get("cluster_id") or "").strip()
            if cluster_id in failed_clusters:
                continue
            blocks = [item for item in list(cluster.get("blocks") or []) if isinstance(item, dict)]
            if normalized_filter:
                blocks = [
                    item for item in blocks if str(item.get("name") or "").strip() in normalized_filter
                ]
            if not blocks:
                continue
            candidate_blocks = [item for item in blocks if self._block_coord_key(item) not in failed_blocks]
            if not candidate_blocks:
                failed_clusters.add(cluster_id)
                continue
            candidate_blocks.sort(key=_distance_score)
            ordered_clusters.append((candidate_blocks[0], cluster, candidate_blocks))

        if not ordered_clusters:
            return None, None, None

        ordered_clusters.sort(key=lambda item: (_distance_score(item[0]), int(item[1].get("count", 0) or 0)))
        for _preferred_block, chosen_cluster, candidate_blocks in ordered_clusters:
            cluster_id = str(chosen_cluster.get("cluster_id") or "").strip()
            for candidate in candidate_blocks:
                block = self._block_at_position_dict(candidate)
                live_name = str(getattr(block, "name", "") or "").strip()
                expected_name = str(candidate.get("name") or "").strip()
                is_stale_candidate = (
                    block is None
                    or not live_name
                    or live_name in AIR_BLOCK_NAMES
                    or (expected_name and live_name != expected_name)
                )
                if is_stale_candidate:
                    failed_blocks.add(self._block_coord_key(candidate))
                    continue
                return block, chosen_cluster, candidate
            if cluster_id:
                failed_clusters.add(cluster_id)
        return None, None, None

    def _resolve_player_entity(self, player_name: Optional[str]) -> Any:
        """实体定位：查询并锁定特定的玩家对象，用于实现跟随或交互逻辑。"""
        players = getattr(self._bot, "players", None)
        if not players:
            return None

        candidate_names: list[str] = []
        if player_name:
            candidate_names.append(str(player_name))
        for name in players:
            if str(name).lower() == self._username.lower():
                continue
            if str(name) not in candidate_names:
                candidate_names.append(str(name))

        for name in candidate_names:
            player = self._lookup_player(name)
            entity = getattr(player, "entity", None) if player else None
            if entity is not None:
                return entity
        return None

    def _extract_inventory_counts(self) -> dict[str, int]:
        """背包盘点：扫描化身当前持有的所有物品，生成语义化的库存统计图。"""
        inventory = getattr(self._bot, "inventory", None)
        if inventory is None or not hasattr(inventory, "items"):
            return {}

        counts: dict[str, int] = {}
        try:
            for item in inventory.items():
                name = str(getattr(item, "name", "") or "").strip()
                if not name:
                    continue
                count = int(getattr(item, "count", 0) or 0)
                counts[name] = counts.get(name, 0) + count
        except Exception as exc:
            logger.debug("Inventory snapshot failed for %s: %s", self._username, exc)
            return {}
        return dict(sorted(counts.items()))

    def _extract_held_item(self) -> Optional[str]:
        """手持检查：识别化身当前主手选中的物品。"""
        held_item = getattr(self._bot, "heldItem", None)
        if held_item is None:
            return None
        name = str(getattr(held_item, "name", "") or "").strip()
        return name or None

    def _collect_environment_snapshot(
        self,
        player_name: Optional[str],
        horizontal_radius: int,
        vertical_radius: int,
        max_nearby_blocks: int,
    ) -> dict[str, Any]:
        """环境聚合：集成坐标、视野内实体、库存及自身状态，形成全量的环境感知快照。"""
        if not self.is_connected or self._bot is None or getattr(self._bot, "entity", None) is None:
            return {}

        helper = getattr(self._env_snapshot_helper, "getEnvironmentSnapshot", None)
        if callable(helper):
            try:
                payload = helper(
                    self._bot,
                    {
                        "playerName": player_name or "",
                        "horizontalRadius": horizontal_radius,
                        "verticalRadius": vertical_radius,
                        "maxEntries": max_nearby_blocks,
                        "findCount": max(max_nearby_blocks * 32, 256),
                    },
                )
                parsed = self._parse_snapshot_payload(payload)
                if parsed:
                    return parsed
            except Exception as exc:
                logger.debug("JS environment snapshot failed for %s: %s", self._username, exc)

        bot_pos = self._position_to_dict(self._bot.entity.position)
        player_entity = self._resolve_player_entity(player_name)
        player_pos = self._position_to_dict(player_entity.position) if player_entity is not None else {}
        health = getattr(self._bot, "health", None)
        food = getattr(self._bot, "food", None)
        return {
            "bot_pos": bot_pos,
            "player_pos": player_pos,
            "inventory": self._extract_inventory_counts(),
            "nearby_blocks": [],
            "equipped": self._extract_held_item(),
            "health": round(float(health), 2) if health is not None else None,
            "food": int(food) if food is not None else None,
        }

    async def get_environment_snapshot(
        self,
        player_name: Optional[str] = None,
        horizontal_radius: int = 6,
        vertical_radius: int = 2,
        max_nearby_blocks: int = 20,
    ) -> dict[str, Any]:
        """感知入口：异步拉取当前环境的全景数据，包含资源缓存的按需刷新逻辑。"""
        if not self.is_connected:
            return {}

        snapshot = self._resource_cache_snapshot_sync()
        if int(snapshot.get("version", 0) or 0) <= 0:
            try:
                await self._refresh_resource_cache_async(radius=32)
            except Exception as exc:
                logger.debug("Initial resource cache refresh failed for %s: %s", self._username, exc)
        else:
            await self._schedule_resource_cache_refresh_if_needed(radius=32)

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(
                None,
                lambda: self._collect_environment_snapshot(
                    player_name,
                    horizontal_radius,
                    vertical_radius,
                    max_nearby_blocks,
                ),
            )
        except Exception as exc:
            logger.debug("Get environment snapshot failed for %s: %s", self._username, exc)
            return {}

    async def get_position(self) -> Optional[Tuple[float, float, float]]:
        """实时坐标：获取化身当前的物理绝对坐标。"""
        self._clear_action_error()
        if not self.is_connected:
            self._set_action_error(
                source="python_adapter",
                action="status",
                target="self",
                stage="precheck",
                raw_name="BotNotConnected",
                raw_message="Bot not connected",
                retryable_hint=False,
            )
            return None
        try:
            pos = self._bot.entity.position
            return (pos.x, pos.y, pos.z)
        except Exception as exc:
            logger.error("Get position failed: %s", exc)
            self._set_action_error(
                source="mineflayer_core",
                action="status",
                target="self",
                stage="read_position",
                raw_name=type(exc).__name__ or "GetPositionError",
                raw_message=str(exc) or "Get position failed",
                retryable_hint=True,
            )
            return None
