# Perception Cache - SSOT for recent scans

import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .interfaces import ScanResult


@dataclass
class PerceptionCache:
    entities: Dict[str, List[ScanResult]] = field(default_factory=dict)
    blocks: Dict[str, List[ScanResult]] = field(default_factory=dict)
    updated_at: float = 0.0

    def update_entities(self, results: List[ScanResult]) -> None:
        grouped: Dict[str, List[ScanResult]] = {}
        for result in results:
            grouped.setdefault(result.id, []).append(result)
        for items in grouped.values():
            items.sort(key=lambda r: r.distance)
        self.entities = grouped
        self.updated_at = time.time()

    def update_blocks(self, results: List[ScanResult]) -> None:
        grouped: Dict[str, List[ScanResult]] = {}
        for result in results:
            grouped.setdefault(result.id, []).append(result)
        for items in grouped.values():
            items.sort(key=lambda r: r.distance)
        self.blocks = grouped
        self.updated_at = time.time()

    def get_cached_entities(self, candidate_ids: List[str]) -> List[ScanResult]:
        results: List[ScanResult] = []
        for cid in candidate_ids:
            results.extend(self.entities.get(cid, []))
        results.sort(key=lambda r: r.distance)
        return results

    def get_cached_blocks(self, candidate_ids: List[str]) -> List[ScanResult]:
        results: List[ScanResult] = []
        for cid in candidate_ids:
            results.extend(self.blocks.get(cid, []))
        results.sort(key=lambda r: r.distance)
        return results


_cache: Optional[PerceptionCache] = None


def get_perception_cache() -> PerceptionCache:
    global _cache
    if _cache is None:
        _cache = PerceptionCache()
    return _cache
