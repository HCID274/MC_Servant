# Recovery policy for movement failures

from __future__ import annotations

from typing import Optional

from .interfaces import ActionStep


class RecoveryPolicy:
    def __init__(self, vertical_gap_threshold: int = 4) -> None:
        self._vertical_gap_threshold = int(vertical_gap_threshold)

    def should_emergency_recover(self, stuck_ticks: int, max_ticks: int, cached_action: Optional[ActionStep]) -> bool:
        if stuck_ticks < max_ticks:
            return False
        if not cached_action:
            return False
        return cached_action.action in ("goto", "mine", "explore", "patrol")

    def emergency_step(self, timeout: float = 60.0, reason: str = "") -> ActionStep:
        description = reason or "Emergency recovery: climb to surface"
        return ActionStep(
            action="climb_to_surface",
            params={"timeout": float(timeout)},
            description=description,
        )

    def move_error_step(
        self,
        error_code: str,
        height_gap: Optional[int],
        attempt_count: int,
    ) -> Optional[ActionStep]:
        if error_code == "SUCCESS":
            return None
        if attempt_count < 1:
            return None

        move_errors = ["PATH_BLOCKED", "TARGET_NOT_FOUND", "TIMEOUT", "RECOVERY_FAILED", "EXECUTION_ERROR"]
        if error_code not in move_errors:
            return None

        if height_gap is None or height_gap < self._vertical_gap_threshold:
            return None

        return self.emergency_step(
            timeout=60.0,
            reason=f"Vertical gap {height_gap} with move error ({error_code}), climb to surface",
        )
