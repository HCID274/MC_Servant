import asyncio
import logging
from typing import List, Optional, Tuple

from config import settings

from .call_logger import get_llm_call_logger
from .interfaces import ILLMClient
from .openrouter_client import OpenRouterClient
from .qwen_client import QwenClient
from .router import LLMRoute, WeightedRoundRobinLLM

logger = logging.getLogger(__name__)


def _parse_models(primary: str, extra: str) -> List[str]:
    items: List[str] = []
    if primary and primary.strip():
        items.append(primary.strip())
    if extra and extra.strip():
        items.extend([m.strip() for m in extra.split(",") if m.strip()])
    deduped: List[str] = []
    seen = set()
    for item in items:
        if item not in seen:
            seen.add(item)
            deduped.append(item)
    return deduped


def _build_qwen_client(call_logger) -> Optional[QwenClient]:
    if not settings.openai_api_key:
        return None
    return QwenClient(
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        model=settings.openai_model,
        call_logger=call_logger,
    )


def _build_openrouter_clients(call_logger) -> Tuple[Optional[ILLMClient], List[OpenRouterClient]]:
    if not settings.openrouter_api_key:
        return None, []
    models = _parse_models(settings.openrouter_model, settings.openrouter_models)
    if not models:
        return None, []
    clients = [
        OpenRouterClient(
            api_key=settings.openrouter_api_key,
            base_url=settings.openrouter_base_url,
            model=model,
            reasoning_enabled=settings.openrouter_reasoning_enabled,
            call_logger=call_logger,
        )
        for model in models
    ]
    if len(clients) == 1:
        return clients[0], clients
    router = WeightedRoundRobinLLM(
        routes=[LLMRoute(client=client, weight=1) for client in clients],
        label="openrouter-rr",
    )
    return router, clients


async def _preflight(clients: List[Tuple[str, ILLMClient]]) -> None:
    timeout = max(1, int(settings.llm_preflight_timeout_seconds))
    fail_fast = settings.llm_preflight_fail_fast
    for name, client in clients:
        try:
            await asyncio.wait_for(
                client.chat(
                    messages=[{"role": "user", "content": "ping"}],
                    max_tokens=4,
                    temperature=0.0,
                ),
                timeout=timeout,
            )
            logger.info(f"LLM preflight ok: {name}")
        except Exception as e:
            logger.warning(f"LLM preflight failed: {name}: {e}")
            if fail_fast:
                raise


async def create_llm_client() -> Optional[ILLMClient]:
    call_logger = get_llm_call_logger(settings.llm_call_log_path)

    qwen_client = _build_qwen_client(call_logger)
    openrouter_router, openrouter_clients = _build_openrouter_clients(call_logger)

    if settings.llm_preflight_enabled:
        preflight_targets: List[Tuple[str, ILLMClient]] = []
        if qwen_client:
            preflight_targets.append((f"qwen:{qwen_client.model_name}", qwen_client))
        for client in openrouter_clients:
            preflight_targets.append((f"openrouter:{client.model_name}", client))
        if preflight_targets:
            await _preflight(preflight_targets)

    provider = (settings.llm_provider or "auto").strip().lower()

    if provider == "qwen":
        if not qwen_client:
            logger.warning("LLM provider set to qwen but openai_api_key is missing")
        return qwen_client
    if provider == "openrouter":
        if not openrouter_router:
            logger.warning("LLM provider set to openrouter but openrouter_api_key/models are missing")
        return openrouter_router

    if provider not in ("auto", "weighted"):
        logger.warning(f"Unknown llm_provider '{settings.llm_provider}', using auto")

    if qwen_client and openrouter_router:
        routes: List[LLMRoute] = []
        if settings.llm_qwen_weight > 0:
            routes.append(LLMRoute(client=qwen_client, weight=settings.llm_qwen_weight))
        if settings.llm_openrouter_weight > 0:
            routes.append(LLMRoute(client=openrouter_router, weight=settings.llm_openrouter_weight))
        if len(routes) == 1:
            return routes[0].client
        if len(routes) >= 2:
            return WeightedRoundRobinLLM(routes=routes, label="llm-router")
        return None

    return qwen_client or openrouter_router
