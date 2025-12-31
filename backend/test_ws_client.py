# WebSocket Client Test Script
import asyncio
import websockets
import json

async def test_llm():
    uri = 'ws://localhost:8765/ws/test_client'
    print('Connecting to WebSocket...')
    
    async with websockets.connect(uri) as ws:
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
