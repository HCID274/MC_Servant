"""Windows 本地 WebSocket echo 服务。"""

from __future__ import annotations

import argparse
import asyncio

from websockets.asyncio.server import serve


def register_parser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    """注册 WebSocket echo 子命令。"""

    parser = subparsers.add_parser("ws-echo", help="启动本地 WebSocket echo 服务")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址，默认 0.0.0.0")
    parser.add_argument("--port", type=int, default=8765, help="监听端口，默认 8765")
    parser.set_defaults(handler=run_from_args)


def run_from_args(args: argparse.Namespace) -> int:
    """启动服务直到手工停止。"""

    try:
        asyncio.run(run_server(host=args.host, port=args.port))
    except KeyboardInterrupt:
        print("windows_ws_echo_stopped")
    return 0


async def run_server(*, host: str, port: int) -> None:
    """启动原样回显服务。"""

    async def echo_handler(websocket) -> None:
        async for message in websocket:
            await websocket.send(message)

    async with serve(echo_handler, host=host, port=port):
        print(f"windows_ws_echo_listening ws://{host}:{port}")
        await asyncio.Future()
