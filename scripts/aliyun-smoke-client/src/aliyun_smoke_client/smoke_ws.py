"""阿里云 WebSocket echo 冒烟测试。"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

import websockets
from websockets.asyncio.client import ClientConnection

from .common import compute_latency_stats, make_output_path, now_iso, write_csv_rows


def register_parser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    """注册 `smoke-ws` 子命令。"""

    parser = subparsers.add_parser("smoke-ws", help="执行 WebSocket echo 冒烟测试")
    parser.add_argument("--mode", required=True, help="结果标签，例如 tailscale 或 frp")
    parser.add_argument("--url", required=True, help="目标 WebSocket 地址")
    parser.add_argument("--interval", type=float, default=1.0, help="发送间隔，默认 1 秒")
    parser.add_argument("--duration", type=float, default=60.0, help="总时长，默认 60 秒")
    parser.add_argument("--connect-timeout", type=float, default=5.0, help="连接超时秒数")
    parser.add_argument("--recv-timeout", type=float, default=10.0, help="单次回包超时秒数")
    parser.add_argument("--output", type=Path, help="输出 CSV 路径")
    parser.set_defaults(handler=run_from_args)


def run_from_args(args: argparse.Namespace) -> int:
    """执行命令并输出摘要。"""

    output_path = args.output or make_output_path(f"aliyun-smoke-ws-{args.mode}", "csv")
    rows = asyncio.run(
        run_smoke_ws(
            mode=args.mode,
            url=args.url,
            interval=args.interval,
            duration=args.duration,
            connect_timeout=args.connect_timeout,
            recv_timeout=args.recv_timeout,
        )
    )
    fieldnames = [
        "timestamp",
        "mode",
        "seq",
        "send_ts_ms",
        "recv_ts_ms",
        "rtt_ms",
        "timeout",
        "reconnect_count",
        "error",
    ]
    write_csv_rows(output_path, fieldnames, rows)

    rtts = [float(row["rtt_ms"]) for row in rows if row["rtt_ms"]]
    stats = compute_latency_stats(rtts)
    timeout_count = sum(1 for row in rows if row["timeout"] == "true")
    reconnect_count = max((int(row["reconnect_count"]) for row in rows), default=0)
    print(f"saved_csv={output_path}")
    print(
        "summary "
        f"samples={len(rows)} success={len(rtts)} timeout={timeout_count} reconnect={reconnect_count} "
        f"min_ms={_fmt(stats['min_ms'])} avg_ms={_fmt(stats['avg_ms'])} "
        f"p95_ms={_fmt(stats['p95_ms'])} max_ms={_fmt(stats['max_ms'])} "
        f"avg_jitter_ms={_fmt(stats['avg_jitter_ms'])}"
    )
    return 0


async def run_smoke_ws(
    *,
    mode: str,
    url: str,
    interval: float,
    duration: float,
    connect_timeout: float,
    recv_timeout: float,
) -> list[dict[str, str]]:
    """按固定节奏发送 echo 消息并记录 RTT。"""

    sample_count = max(1, int(duration / interval))
    rows: list[dict[str, str]] = []
    connection: ClientConnection | None = None
    reconnect_count = 0
    next_tick = time.perf_counter()

    try:
        for seq in range(1, sample_count + 1):
            send_wall_ms = time.time_ns() // 1_000_000
            monotonic_started = time.perf_counter()

            try:
                if connection is None:
                    connection = await _open_connection(url=url, connect_timeout=connect_timeout)
                    if seq > 1:
                        reconnect_count += 1

                payload = {
                    "seq": seq,
                    "mode": mode,
                    "send_ts_ms": send_wall_ms,
                }
                await connection.send(json.dumps(payload, ensure_ascii=False))
                echoed = await asyncio.wait_for(connection.recv(), timeout=recv_timeout)
                recv_wall_ms = time.time_ns() // 1_000_000
                rtt_ms = (time.perf_counter() - monotonic_started) * 1000
                _validate_echo(seq=seq, raw_message=echoed)
                rows.append(
                    {
                        "timestamp": now_iso(),
                        "mode": mode,
                        "seq": str(seq),
                        "send_ts_ms": str(send_wall_ms),
                        "recv_ts_ms": str(recv_wall_ms),
                        "rtt_ms": _fmt(rtt_ms),
                        "timeout": "false",
                        "reconnect_count": str(reconnect_count),
                        "error": "",
                    }
                )
            except Exception as exc:
                rows.append(
                    {
                        "timestamp": now_iso(),
                        "mode": mode,
                        "seq": str(seq),
                        "send_ts_ms": str(send_wall_ms),
                        "recv_ts_ms": "",
                        "rtt_ms": "",
                        "timeout": "true",
                        "reconnect_count": str(reconnect_count),
                        "error": str(exc),
                    }
                )
                if connection is not None:
                    await connection.close()
                connection = None

            next_tick += interval
            sleep_for = next_tick - time.perf_counter()
            if seq < sample_count and sleep_for > 0:
                await asyncio.sleep(sleep_for)
            elif seq < sample_count and sleep_for <= 0:
                next_tick = monotonic_started
    finally:
        if connection is not None:
            await connection.close()

    return rows


async def _open_connection(*, url: str, connect_timeout: float) -> ClientConnection:
    """建立 WebSocket 连接。"""

    return await asyncio.wait_for(
        websockets.connect(
            url,
            open_timeout=connect_timeout,
            ping_interval=20,
            ping_timeout=20,
            max_size=2**20,
        ),
        timeout=connect_timeout,
    )


def _validate_echo(*, seq: int, raw_message: str | bytes) -> None:
    """确认回包中仍包含原始序号。"""

    if isinstance(raw_message, bytes):
        raw_message = raw_message.decode("utf-8", errors="replace")
    parsed = json.loads(raw_message)
    if parsed.get("seq") != seq:
        raise ValueError(f"echo 序号不匹配，expected={seq}, actual={parsed.get('seq')}")


def _fmt(value: float | None) -> str:
    """统一格式化浮点值。"""

    if value is None:
        return ""
    return f"{value:.3f}"
