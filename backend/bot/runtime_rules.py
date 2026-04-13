import json
from functools import lru_cache
from pathlib import Path
from typing import Any


DATA_DIR = Path(__file__).resolve().parents[1] / "data"


@lru_cache(maxsize=1)
def load_runtime_rules() -> dict[str, Any]:
    """规则加载：从持久化配置中读取物理世界常量（如空气方块定义、脚手架选材）。"""
    path = DATA_DIR / "runtime_rules.json"
    return json.loads(path.read_text(encoding="utf-8"))


AIR_BLOCK_NAMES = set(load_runtime_rules().get("air_block_names") or [])
"""物理真空定义：在碰撞检测与方块破坏校验中被视为“空气”的方块名单。"""

SCAFFOLD_BLOCK_NAMES = list(load_runtime_rules().get("scaffold_block_names") or [])
"""路径规划支护：脚手架算法优先选用的物理方块列表。"""
