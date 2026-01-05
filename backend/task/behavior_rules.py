import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Union

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class BehaviorThresholds:
    owner_fallback_distance: int = 50
    goto_owner_reached_distance: int = 5
    default_search_radius: int = 24
    default_gather_count: int = 32
    default_max_ticks: int = 20  # 采集任务的最大 tick 数
    max_action_retries_l1: int = 3
    max_l1_failures_before_unstuck_l2: int = 3


class BehaviorRules:
    """
    行为规则库（Rule-Based Constraints）

    设计目标：
    - 将确定性阈值/关键词/恢复策略配置化，避免写死在 prompt 或代码里
    - 允许"默认值优先"的懒惰澄清策略
    """

    def __init__(self, path: Optional[Union[str, Path]] = None):
        if path is None:
            path = Path(__file__).parent.parent / "data" / "behavior_rules.json"
        self._path = Path(path)
        self._raw: Dict[str, Any] = {}
        self.thresholds = BehaviorThresholds()
        self.deictic_anchor_keywords: List[str] = []
        self._inline_tactics: Set[str] = set()
        self._push_stack_strategies: Set[str] = set()
        self._error_code_overrides: Dict[str, Dict[str, str]] = {}
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
                default_max_ticks=int(t.get("default_max_ticks", self.thresholds.default_max_ticks)),
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

        # 加载策略分类
        strat_class = self._raw.get("strategy_classification", {})
        if isinstance(strat_class, dict):
            inline = strat_class.get("inline_tactics", [])
            self._inline_tactics = set(inline) if isinstance(inline, list) else set()
            push = strat_class.get("push_stack_strategies", [])
            self._push_stack_strategies = set(push) if isinstance(push, list) else set()

        # 加载错误码覆盖
        recovery = self._raw.get("recovery", {})
        if isinstance(recovery, dict):
            overrides = recovery.get("error_code_overrides", {})
            if isinstance(overrides, dict):
                self._error_code_overrides = overrides

    def is_owner_anchor_intent(self, text: str) -> bool:
        if not text:
            return False
        for k in self.deictic_anchor_keywords:
            if k and k in text:
                return True
        return False

    # ========================================================================
    # Convenience Properties (直接访问阈值)
    # ========================================================================

    @property
    def owner_fallback_distance(self) -> int:
        return self.thresholds.owner_fallback_distance

    @property
    def goto_owner_reached_distance(self) -> int:
        return self.thresholds.goto_owner_reached_distance

    @property
    def default_search_radius(self) -> int:
        return self.thresholds.default_search_radius

    @property
    def default_gather_count(self) -> int:
        return self.thresholds.default_gather_count

    @property
    def max_action_retries_l1(self) -> int:
        return self.thresholds.max_action_retries_l1

    @property
    def max_l1_failures_before_l2(self) -> int:
        return self.thresholds.max_l1_failures_before_unstuck_l2

    # ========================================================================
    # Strategy Classification
    # ========================================================================

    def is_inline_strategy(self, strategy_type: str) -> bool:
        """判断策略是否应内联执行"""
        return strategy_type in self._inline_tactics

    def is_push_stack_strategy(self, strategy_type: str) -> bool:
        """判断策略是否应压栈执行"""
        return strategy_type in self._push_stack_strategies

    def get_error_code_override(self, error_code: str) -> Optional[Dict[str, str]]:
        """获取错误码的级别覆盖配置"""
        return self._error_code_overrides.get(error_code)

    # ========================================================================
    # Phase 3+: 瞬态错误判定
    # ========================================================================

    # 瞬态错误: 可能因环境波动导致，值得本地重试
    TRANSIENT_ERROR_CODES = {
        "TIMEOUT",
        "PATH_INTERRUPTED",
        "ENTITY_NOT_FOUND",
        "BLOCK_NOT_FOUND",
    }

    def is_transient_error(self, error_code: str) -> bool:
        """判断错误码是否为瞬态错误（值得本地重试）"""
        if not error_code:
            return False
        return error_code.upper() in self.TRANSIENT_ERROR_CODES

    @property
    def max_retries_per_action(self) -> int:
        """每个动作的最大重试次数"""
        return self.thresholds.max_action_retries_l1
