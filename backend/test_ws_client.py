# WebSocket Client Test Script
import asyncio
import json
import os
from pathlib import Path

import websockets


def _load_ws_token() -> str:
    token = os.getenv("MC_SERVANT_WS_ACCESS_TOKEN")
    if token:
        return token

    env_path = Path(__file__).with_name(".env")
    if not env_path.exists():
        return ""

    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.strip() == "MC_SERVANT_WS_ACCESS_TOKEN":
                return value.strip().strip('"').strip("'")
    except Exception:
        return ""

    return ""

async def test_llm():
    uri = 'ws://localhost:8765/ws/test_client'
    print('Connecting to WebSocket...')
    token = _load_ws_token()
    if not token:
        raise RuntimeError("Missing MC_SERVANT_WS_ACCESS_TOKEN (env or backend/.env).")

    async with websockets.connect(uri, additional_headers={"x-access-token": token}) as ws:
        print('Connected!')
        
        # Test cases
        tests = [
            '帮我盖个房子',
            '去挖点铁矿',
            '你好呀',
            '你在哪',
        ]
        
        for content in tests:
            msg = {
                'type': 'player_message',
                'player': 'TestPlayer',
                'npc': 'Alice',
                'content': content,
                'timestamp': 0
            }
            print(f'\n--- 发送: {content} ---')
            await ws.send(json.dumps(msg, ensure_ascii=False))
            
            resp = await ws.recv()
            data = json.loads(resp)
            print(f"响应: {data.get('content', 'N/A')}")
            print(f"动作: {data.get('action', 'N/A')}")

if __name__ == '__main__':
    asyncio.run(test_llm())
