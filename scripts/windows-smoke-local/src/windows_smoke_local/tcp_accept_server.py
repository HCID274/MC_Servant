"""Windows 本地 TCP accept 服务。"""

from __future__ import annotations

import argparse
import asyncio


def register_parser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    """注册 TCP accept 子命令。"""

    parser = subparsers.add_parser("tcp-accept", help="启动本地 TCP accept 服务")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址，默认 0.0.0.0")
    parser.add_argument("--port", type=int, default=8766, help="监听端口，默认 8766")
    parser.set_defaults(handler=run_from_args)


def run_from_args(args: argparse.Namespace) -> int:
    """启动服务直到手工停止。"""

    try:
        asyncio.run(run_server(host=args.host, port=args.port))
    except KeyboardInterrupt:
        print("windows_tcp_accept_stopped")
    return 0


async def run_server(*, host: str, port: int) -> None:
    """启动纯 TCP 接受服务，建立连接后立即关闭。"""

    async def handle_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await reader.read(1)
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(handle_connection, host=host, port=port)
    async with server:
        print(f"windows_tcp_accept_listening tcp://{host}:{port}")
        await server.serve_forever()
