import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class BehaviorThresholds:
    owner_fallback_distance: int = 50
    goto_owner_reached_distance: int = 5
    default_search_radius: int = 24
    default_gather_count: int = 32
    max_action_retries_l1: int = 3
    max_l1_failures_before_unstuck_l2: int = 3


class BehaviorRules:
    """
    行为规则库（Rule-Based Constraints）

    设计目标：
    - 将确定性阈值/关键词/恢复策略配置化，避免写死在 prompt 或代码里
    - 允许“默认值优先”的懒惰澄清策略
    """

    def __init__(self, path: Optional[Union[str, Path]] = None):
        if path is None:
            path = Path(__file__).parent.parent / "data" / "behavior_rules.json"
        self._path = Path(path)
        self._raw: Dict[str, Any] = {}
        self.thresholds = BehaviorThresholds()
        self.deictic_anchor_keywords: List[str] = []
        self._load()

    def _load(self) -> None:
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                self._raw = json.load(f)
        except FileNotFoundError:
            logger.warning(f"[BehaviorRules] File not found: {self._path} (using defaults)")
            self._raw = {}
        except Exception as e:
            logger.error(f"[BehaviorRules] Failed to load {self._path}: {e} (using defaults)")
            self._raw = {}

        t = self._raw.get("thresholds", {}) if isinstance(self._raw, dict) else {}
        if isinstance(t, dict):
            self.thresholds = BehaviorThresholds(
                owner_fallback_distance=int(t.get("owner_fallback_distance", self.thresholds.owner_fallback_distance)),
                goto_owner_reached_distance=int(t.get("goto_owner_reached_distance", self.thresholds.goto_owner_reached_distance)),
                default_search_radius=int(t.get("default_search_radius", self.thresholds.default_search_radius)),
                default_gather_count=int(t.get("default_gather_count", self.thresholds.default_gather_count)),
                max_action_retries_l1=int(t.get("max_action_retries_l1", self.thresholds.max_action_retries_l1)),
                max_l1_failures_before_unstuck_l2=int(
                    t.get("max_l1_failures_before_unstuck_l2", self.thresholds.max_l1_failures_before_unstuck_l2)
                ),
            )

        kws = self._raw.get("deictic_anchor_keywords", [])
        if isinstance(kws, list):
            self.deictic_anchor_keywords = [str(x) for x in kws if isinstance(x, (str, int, float))]
        else:
            self.deictic_anchor_keywords = []

    def is_owner_anchor_intent(self, text: str) -> bool:
        if not text:
            return False
        for k in self.deictic_anchor_keywords:
            if k and k in text:
                return True
        return False


