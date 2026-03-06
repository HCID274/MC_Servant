from collections import deque
from math import sqrt
from typing import Dict, Iterable, List, Tuple


Point = Tuple[int, int, int]


def build_connected_clusters(points: Iterable[Point], max_step: int = 1) -> List[List[Point]]:
    """空间聚类：使用 BFS 算法将相邻的 3D 坐标点识别为独立的“资源簇”。"""
    remaining = set(points)
    clusters: List[List[Point]] = []
    if not remaining:
        return clusters

    step_sq = max_step * max_step

    # 遍历未分类点位。
    while remaining:
        root = remaining.pop()
        queue = deque([root])
        cluster = [root]
        while queue:
            cx, cy, cz = queue.popleft()
            neighbors = []
            # 距离检测：寻找半径范围内的联通点。
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
    """智能选簇：在多个备选资源点中，根据欧氏距离筛选出最优的执行目标。"""
    if not clusters:
        return []

    # 过滤微小簇：避免为了单一碎碎方块跑冤枉路。
    valid = [cluster for cluster in clusters if len(cluster) >= min_cluster_size]
    if not valid:
        return []

    ox, oy, oz = origin

    def cluster_distance(cluster: List[Point]) -> float:
        """测距仪：计算起始点到资源簇中最近方块的距离。"""
        distances = []
        for x, y, z in cluster:
            distances.append(sqrt((x - ox) ** 2 + (y - oy) ** 2 + (z - oz) ** 2))
        return min(distances) if distances else float("inf")

    return min(valid, key=cluster_distance)


def sort_cluster_for_mining(cluster: List[Point]) -> List[Point]:
    """采集排序：按照“从下往上、近处优先”的物理规律优化挖掘顺序。"""
    return sorted(cluster, key=lambda p: (p[1], p[0] * p[0] + p[2] * p[2]))


def point_from_snapshot(snapshot: Dict[str, Dict[str, float]]) -> Point:
    """坐标转换：将环境快照中的浮点坐标格式化为整数点位（Point）。"""
    pos = snapshot.get("bot_pos") or {}
    return (int(pos.get("x", 0)), int(pos.get("y", 0)), int(pos.get("z", 0)))

