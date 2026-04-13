"""Windows 本地命令入口。"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from . import tcp_accept_server, ws_echo_server


def build_parser() -> argparse.ArgumentParser:
    """构建命令行解析器。"""

    parser = argparse.ArgumentParser(description="Windows 本地被测端工具")
    subparsers = parser.add_subparsers(dest="command", required=True)
    ws_echo_server.register_parser(subparsers)
    tcp_accept_server.register_parser(subparsers)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """统一入口。"""

    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.handler(args))


def main_ws_echo() -> int:
    """单命令入口。"""

    return main(["ws-echo", *sys.argv[1:]])


def main_tcp_accept() -> int:
    """单命令入口。"""

    return main(["tcp-accept", *sys.argv[1:]])
