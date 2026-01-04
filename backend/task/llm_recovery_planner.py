# LLM Recovery Planner
# LLM-driven recovery decisions (Phase 3+)

import json
import logging
from pathlib import Path
from typing import Dict, Any, Optional, TYPE_CHECKING

from .recovery_planner import (
    IRecoveryPlanner,
    RecoveryDecision,
    RecoveryDecisionType,
    RecoveryContext,
)
from .interfaces import ActionStep
from .prompts.recovery import RECOVERY_SYSTEM_PROMPT

if TYPE_CHECKING:
    from ..llm.interfaces import ILLMClient

logger = logging.getLogger(__name__)

DEFAULT_HINTS_PATH = Path(__file__).parent.parent / "data" / "behavior_hints.txt"
DEFAULT_CLARIFY_TEMPLATE = "遇到问题 ({error_code})，请指示下一步操作。"


class LLMRecoveryPlanner(IRecoveryPlanner):
    """
    LLM-based recovery planner (separate from task planning).
    """

    def __init__(self, llm_client: "ILLMClient", hints_path: Optional[Path] = None):
        self._llm = llm_client
        self._hints_path = hints_path or DEFAULT_HINTS_PATH
        self._behavior_hints = self._load_behavior_hints()
        logger.info(f"LLMRecoveryPlanner initialized with model: {llm_client.model_name}")

    async def recover(self, context: RecoveryContext) -> RecoveryDecision:
        payload = self._build_payload(context)
        system_prompt = RECOVERY_SYSTEM_PROMPT.format(
            behavior_hints=self._behavior_hints or "(none)"
        )

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False, default=str)},
        ]

        try:
            response = await self._llm.chat_json(
                messages=messages,
                max_tokens=512,
                temperature=0.2,
            )
        except Exception as e:
            logger.error(f"LLM recovery failed: {e}")
            return self._fallback_clarify(context, raw=None)

        return self._parse_response(context, response)

    def _load_behavior_hints(self) -> str:
        try:
            if self._hints_path.exists():
                return self._hints_path.read_text(encoding="utf-8").strip()
        except Exception as e:
            logger.warning(f"Failed to load behavior_hints: {e}")
        return ""

    def _build_payload(self, context: RecoveryContext) -> Dict[str, Any]:
        return {
            "goal": context.goal,
            "last_action": context.last_action,
            "last_result": context.last_result,
            "bot_state": context.bot_state,
            "recent_steps": context.recent_steps,
            "allowed_actions": context.allowed_actions,
            "attempt": context.attempt,
            "max_attempts": context.max_attempts,
            "is_final_attempt": context.is_final_attempt,
            "user_reply": context.user_reply,
        }

    def _parse_response(self, context: RecoveryContext, response: Dict[str, Any]) -> RecoveryDecision:
        if not isinstance(response, dict):
            return self._fallback_clarify(context, raw=response)

        decision_raw = str(response.get("decision", "")).strip().lower()
        decision = self._parse_decision_type(decision_raw)

        if decision is None:
            return self._fallback_clarify(context, raw=response)

        if decision == RecoveryDecisionType.RETRY_SAME:
            return RecoveryDecision(decision=decision, raw=response)

        if decision == RecoveryDecisionType.CLARIFY:
            message = response.get("message") or self._default_clarify_message(context)
            return RecoveryDecision(decision=decision, message=message, raw=response)

        if decision == RecoveryDecisionType.ABORT:
            message = response.get("message") or "无法继续执行该任务。"
            return RecoveryDecision(decision=decision, message=message, raw=response)

        step_data = response.get("step")
        if not isinstance(step_data, dict):
            return self._fallback_clarify(context, raw=response)

        action = step_data.get("action", "")
        if not action or action not in set(context.allowed_actions):
            return self._fallback_clarify(context, raw=response)

        step = ActionStep(
            action=action,
            params=step_data.get("params", {}) or {},
            description=step_data.get("description", "") or "",
        )

        return RecoveryDecision(decision=decision, step=step, raw=response)

    def _parse_decision_type(self, raw: str) -> Optional[RecoveryDecisionType]:
        for dt in RecoveryDecisionType:
            if dt.value == raw:
                return dt
        return None

    def _default_clarify_message(self, context: RecoveryContext) -> str:
        error_code = None
        if context.last_result and isinstance(context.last_result, dict):
            error_code = context.last_result.get("error_code")
        return DEFAULT_CLARIFY_TEMPLATE.format(error_code=error_code or "UNKNOWN")

    def _fallback_clarify(self, context: RecoveryContext, raw: Optional[Dict[str, Any]]) -> RecoveryDecision:
        message = self._default_clarify_message(context)
        return RecoveryDecision(
            decision=RecoveryDecisionType.CLARIFY,
            message=message,
            raw=raw,
        )
