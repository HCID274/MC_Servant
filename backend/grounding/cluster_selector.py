from collections import deque
from math import sqrt
from typing import Dict, Iterable, List, Tuple


Point = Tuple[int, int, int]


def build_connected_clusters(points: Iterable[Point], max_step: int = 1) -> List[List[Point]]:
    """
    构建 3D 点簇（BFS）。
    - 用于后续 mine 语义下的“资源坨”识别。
    - 当前提供纯算法层能力，执行层后续按需接入。
    """
    remaining = set(points)
    clusters: List[List[Point]] = []
    if not remaining:
        return clusters

    step_sq = max_step * max_step

    while remaining:
        root = remaining.pop()
        queue = deque([root])
        cluster = [root]
        while queue:
            cx, cy, cz = queue.popleft()
            neighbors = []
            for px, py, pz in list(remaining):
                dx = px - cx
                dy = py - cy
                dz = pz - cz
                if dx * dx + dy * dy + dz * dz <= step_sq:
                    neighbors.append((px, py, pz))
            for n in neighbors:
                remaining.remove(n)
                queue.append(n)
                cluster.append(n)
        clusters.append(cluster)

    return clusters


def choose_nearest_cluster(
    clusters: List[List[Point]],
    origin: Point,
    min_cluster_size: int = 1,
) -> List[Point]:
    """选择最近簇；支持最小簇过滤。"""
    if not clusters:
        return []

    valid = [cluster for cluster in clusters if len(cluster) >= min_cluster_size]
    if not valid:
        return []

    ox, oy, oz = origin

    def cluster_distance(cluster: List[Point]) -> float:
        distances = []
        for x, y, z in cluster:
            distances.append(sqrt((x - ox) ** 2 + (y - oy) ** 2 + (z - oz) ** 2))
        return min(distances) if distances else float("inf")

    return min(valid, key=cluster_distance)


def sort_cluster_for_mining(cluster: List[Point]) -> List[Point]:
    """按执行友好顺序排序：先低 Y，再近平面距离。"""
    return sorted(cluster, key=lambda p: (p[1], p[0] * p[0] + p[2] * p[2]))


def point_from_snapshot(snapshot: Dict[str, Dict[str, float]]) -> Point:
    pos = snapshot.get("bot_pos") or {}
    return (int(pos.get("x", 0)), int(pos.get("y", 0)), int(pos.get("z", 0)))

