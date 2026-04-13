"""阿里云测量客户端共用工具。"""

from __future__ import annotations

import csv
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

PROJECT_DIR = Path(__file__).resolve().parents[2]
RESULTS_DIR = PROJECT_DIR / "results"


def now_iso() -> str:
    """返回带时区的 ISO 时间戳。"""

    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def make_output_path(prefix: str, suffix: str) -> Path:
    """生成默认输出路径。"""

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return RESULTS_DIR / f"{prefix}-{stamp}.{suffix}"


def ensure_parent(path: Path) -> None:
    """确保输出目录存在。"""

    path.parent.mkdir(parents=True, exist_ok=True)


def write_csv_rows(path: Path, fieldnames: Sequence[str], rows: Sequence[dict[str, Any]]) -> None:
    """写入 CSV 结果。"""

    ensure_parent(path)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    """写入 JSON 结果。"""

    ensure_parent(path)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def percentile(values: Sequence[float], ratio: float) -> float | None:
    """按离散样本计算百分位值。"""

    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * ratio) - 1))
    return ordered[index]


def compute_latency_stats(values: Sequence[float]) -> dict[str, float | int | None]:
    """计算最小 RTT 统计。"""

    if not values:
        return {
            "samples": 0,
            "min_ms": None,
            "avg_ms": None,
            "p95_ms": None,
            "max_ms": None,
            "avg_jitter_ms": None,
        }

    jitter_values = [abs(curr - prev) for prev, curr in zip(values, values[1:])]
    return {
        "samples": len(values),
        "min_ms": min(values),
        "avg_ms": sum(values) / len(values),
        "p95_ms": percentile(values, 0.95),
        "max_ms": max(values),
        "avg_jitter_ms": (sum(jitter_values) / len(jitter_values)) if jitter_values else 0.0,
    }
