# LLM Recovery Planner
# LLM-driven recovery decisions (Phase 3+)

import asyncio
import json
import logging
from pathlib import Path
from typing import Dict, Any, Optional, TYPE_CHECKING

try:
    import json_repair
except ImportError:
    json_repair = None

from .recovery_planner import (
    IRecoveryPlanner,
    RecoveryDecision,
    RecoveryDecisionType,
    RecoveryContext,
)
from .interfaces import ActionStep
from .prompts.recovery import RECOVERY_SYSTEM_PROMPT
from config import settings

if TYPE_CHECKING:
    from ..llm.interfaces import ILLMClient

logger = logging.getLogger(__name__)

DEFAULT_HINTS_PATH = Path(__file__).parent.parent / "data" / "behavior_hints.txt"
DEFAULT_CLARIFY_TEMPLATE = "遇到问题 ({error_code})，请指示下一步操作。"

# 重试配置
MAX_RETRIES = 3


class LLMRecoveryPlanner(IRecoveryPlanner):
    """
    LLM-based recovery planner (separate from task planning).
    
    Features:
    - JSON repair: 使用 json-repair 库修复 LLM 返回的损坏 JSON
    - Retry mechanism: 最多重试 3 次
    """

    def __init__(self, llm_client: "ILLMClient", hints_path: Optional[Path] = None):
        self._llm = llm_client
        self._hints_path = hints_path or DEFAULT_HINTS_PATH
        self._behavior_hints = self._load_behavior_hints()
        logger.info(f"LLMRecoveryPlanner initialized with model: {llm_client.model_name}")

    async def recover(self, context: RecoveryContext) -> RecoveryDecision:
        """
        执行恢复决策，带重试机制
        
        使用 chat() 获取原始文本，然后用 json_repair 解析（更健壮）
        """
        payload = self._build_payload(context)
        system_prompt = RECOVERY_SYSTEM_PROMPT.format(
            behavior_hints=self._behavior_hints or "(none)"
        )

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False, default=str)},
        ]

        last_error = None
        
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                # 使用 chat() 获取原始文本，而非 chat_json()
                # 这样可以在 Python 侧用 json_repair 处理格式问题
                raw_response = await asyncio.wait_for(
                    self._llm.chat(
                        messages=messages,
                        max_tokens=512,
                        temperature=0.2,
                    ),
                    timeout=settings.llm_chat_timeout_seconds,
                )
                
                if not raw_response or not raw_response.strip():
                    logger.warning(f"[Recovery] Attempt {attempt}/{MAX_RETRIES}: Empty response")
                    if attempt < MAX_RETRIES:
                        messages.append({"role": "assistant", "content": "(empty)"})
                        messages.append({"role": "user", "content": "请返回 JSON 格式的恢复决策。"})
                        continue
                    return self._fallback_clarify(context, raw=None)
                
                # 用 json_repair 解析
                response = self._repair_json(raw_response)
                
                # 验证并解析响应
                decision = self._parse_response(context, response)
                
                # 如果解析成功（有有效的 decision），返回
                if decision.decision is not None:
                    if attempt > 1:
                        logger.info(f"[Recovery] Success on attempt {attempt}")
                    return decision
                    
            except Exception as e:
                last_error = e
                logger.warning(f"[Recovery] Attempt {attempt}/{MAX_RETRIES} failed: {e}")
                
                # 添加格式修正提示
                if attempt < MAX_RETRIES:
                    messages.append({
                        "role": "assistant",
                        "content": f"(parse error: {e})"
                    })
                    messages.append({
                        "role": "user", 
                        "content": '请只返回纯 JSON，格式如: {"decision": "act", "step": {"action": "craft", "params": {"item_name": "wooden_pickaxe"}}}。不要加任何解释文字。'
                    })
        
        # 所有重试失败
        logger.error(f"[Recovery] All {MAX_RETRIES} attempts failed, last error: {last_error}")
        return self._fallback_clarify(context, raw=None)

    def _repair_json(self, raw_str: str) -> Dict[str, Any]:
        """
        使用 json-repair 修复损坏的 JSON
        """
        if json_repair is None:
            # 如果库未安装，尝试标准解析
            return json.loads(raw_str)
        
        try:
            # 使用 json_repair 解析，保留非 ASCII 字符
            result = json_repair.repair_json(raw_str, return_objects=True, ensure_ascii=False)
            if isinstance(result, dict):
                return result
            elif isinstance(result, str):
                # 如果返回的还是字符串，再次尝试解析
                return json.loads(result)
            else:
                logger.warning(f"[Recovery] json_repair returned unexpected type: {type(result)}")
                return {}
        except Exception as e:
            logger.warning(f"[Recovery] json_repair failed: {e}")
            # 最后尝试标准解析
            return json.loads(raw_str)

    def _load_behavior_hints(self) -> str:
        try:
            if self._hints_path.exists():
                return self._hints_path.read_text(encoding="utf-8").strip()
        except Exception as e:
            logger.warning(f"Failed to load behavior_hints: {e}")
        return ""

    def _build_payload(self, context: RecoveryContext) -> Dict[str, Any]:
        # 简化 last_result（避免传递过大的对象）
        last_result_summary = None
        if context.last_result:
            if hasattr(context.last_result, 'action'):
                last_result_summary = {
                    "action": context.last_result.action,
                    "success": context.last_result.success,
                    "error_code": getattr(context.last_result, 'error_code', None),
                    "message": getattr(context.last_result, 'message', ''),
                }
            elif isinstance(context.last_result, dict):
                last_result_summary = context.last_result
        
        return {
            "goal": context.goal,
            "last_result": last_result_summary,
            "allowed_actions": context.allowed_actions,
            "attempt": context.attempt,
            "max_attempts": context.max_attempts,
            "user_reply": context.user_reply,
        }

    def _parse_response(self, context: RecoveryContext, response: Dict[str, Any]) -> RecoveryDecision:
        if not isinstance(response, dict):
            return self._fallback_clarify(context, raw=response)

        decision_raw = str(response.get("decision", "")).strip().lower()
        decision = self._parse_decision_type(decision_raw)

        if decision is None:
            logger.warning(f"[Recovery] Unknown decision type: {decision_raw}")
            return self._fallback_clarify(context, raw=response)

        if decision == RecoveryDecisionType.RETRY_SAME:
            return RecoveryDecision(decision=decision, raw=response)

        if decision == RecoveryDecisionType.CLARIFY:
            message = response.get("message") or self._default_clarify_message(context)
            return RecoveryDecision(decision=decision, message=message, raw=response)

        if decision == RecoveryDecisionType.ABORT:
            message = response.get("message") or "无法继续执行该任务。"
            return RecoveryDecision(decision=decision, message=message, raw=response)

        # act 或 new_step
        step_data = response.get("step")
        if not isinstance(step_data, dict):
            logger.warning(f"[Recovery] 'step' is not a dict: {step_data}")
            return self._fallback_clarify(context, raw=response)

        action = step_data.get("action", "")
        if not action:
            logger.warning(f"[Recovery] Missing 'action' in step")
            return self._fallback_clarify(context, raw=response)
        
        # 验证动作是否在允许列表中
        if context.allowed_actions and action not in set(context.allowed_actions):
            logger.warning(f"[Recovery] Action '{action}' not in allowed_actions: {context.allowed_actions}")
            return self._fallback_clarify(context, raw=response)

        step = ActionStep(
            action=action,
            params=step_data.get("params", {}) or {},
            description=step_data.get("description", "") or "",
        )

        return RecoveryDecision(decision=RecoveryDecisionType.NEW_STEP, step=step, raw=response)

    def _parse_decision_type(self, raw: str) -> Optional[RecoveryDecisionType]:
        # 支持多种别名
        mapping = {
            "act": RecoveryDecisionType.NEW_STEP,
            "new_step": RecoveryDecisionType.NEW_STEP,
            "retry_same": RecoveryDecisionType.RETRY_SAME,
            "retry": RecoveryDecisionType.RETRY_SAME,
            "clarify": RecoveryDecisionType.CLARIFY,
            "ask": RecoveryDecisionType.CLARIFY,
            "abort": RecoveryDecisionType.ABORT,
            "stop": RecoveryDecisionType.ABORT,
            "give_up": RecoveryDecisionType.ABORT,
        }
        return mapping.get(raw)

    def _default_clarify_message(self, context: RecoveryContext) -> str:
        error_code = None
        if context.last_result:
            if hasattr(context.last_result, 'error_code'):
                error_code = context.last_result.error_code
            elif isinstance(context.last_result, dict):
                error_code = context.last_result.get("error_code")
        return DEFAULT_CLARIFY_TEMPLATE.format(error_code=error_code or "UNKNOWN")

    def _fallback_clarify(self, context: RecoveryContext, raw: Optional[Dict[str, Any]]) -> RecoveryDecision:
        message = self._default_clarify_message(context)
        return RecoveryDecision(
            decision=RecoveryDecisionType.CLARIFY,
            message=message,
            raw=raw,
        )
