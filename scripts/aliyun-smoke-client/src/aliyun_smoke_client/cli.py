"""阿里云测量客户端入口。"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from . import smoke_iperf, smoke_ping, smoke_ws


def build_parser() -> argparse.ArgumentParser:
    """构建命令行解析器。"""

    parser = argparse.ArgumentParser(description="阿里云测量客户端")
    subparsers = parser.add_subparsers(dest="command", required=True)
    smoke_ping.register_parser(subparsers)
    smoke_ws.register_parser(subparsers)
    smoke_iperf.register_parser(subparsers)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """统一入口。"""

    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.handler(args))


def main_smoke_ping() -> int:
    """单命令入口。"""

    return main(["smoke-ping", *sys.argv[1:]])


def main_smoke_ws() -> int:
    """单命令入口。"""

    return main(["smoke-ws", *sys.argv[1:]])


def main_smoke_iperf() -> int:
    """单命令入口。"""

    return main(["smoke-iperf", *sys.argv[1:]])
