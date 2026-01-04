import asyncio
from dataclasses import dataclass
from typing import List

from .interfaces import ILLMClient


@dataclass(frozen=True)
class LLMRoute:
    client: ILLMClient
    weight: int


class WeightedRoundRobinLLM(ILLMClient):
    def __init__(self, routes: List[LLMRoute], label: str) -> None:
        sequence: List[ILLMClient] = []
        for route in routes:
            if route.weight > 0:
                sequence.extend([route.client] * route.weight)
        if not sequence:
            raise ValueError("LLM router requires at least one weighted client")
        self._sequence = sequence
        self._label = label
        self._pos = 0
        self._lock = asyncio.Lock()

    @property
    def model_name(self) -> str:
        return self._label

    async def _pick(self) -> ILLMClient:
        async with self._lock:
            client = self._sequence[self._pos]
            self._pos = (self._pos + 1) % len(self._sequence)
            return client

    async def chat(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        temperature: float = 0.7,
    ) -> str:
        client = await self._pick()
        return await client.chat(messages, max_tokens=max_tokens, temperature=temperature)

    async def chat_json(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        temperature: float = 0.3,
    ) -> dict:
        client = await self._pick()
        return await client.chat_json(messages, max_tokens=max_tokens, temperature=temperature)
