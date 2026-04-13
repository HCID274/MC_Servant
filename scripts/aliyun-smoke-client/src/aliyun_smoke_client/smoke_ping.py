"""阿里云 RTT 冒烟测试。"""

from __future__ import annotations

import argparse
import re
import socket
import subprocess
import time
from pathlib import Path
from typing import Any

from .common import compute_latency_stats, make_output_path, now_iso, write_csv_rows

TAILSCALE_RTT_PATTERN = re.compile(r"via (?P<path>.+?) in (?P<rtt_ms>\d+(?:\.\d+)?)ms", re.IGNORECASE)


def register_parser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    """注册 `smoke-ping` 子命令。"""

    parser = subparsers.add_parser("smoke-ping", help="执行 RTT 冒烟测试")
    parser.add_argument("--probe", choices=("tailscale", "tcp-connect"), required=True, help="探测方式")
    parser.add_argument("--mode", required=True, help="结果标签，例如 tailscale 或 frp")
    parser.add_argument("--target", required=True, help="目标主机名或 IP")
    parser.add_argument("--port", type=int, help="tcp-connect 模式下的端口")
    parser.add_argument("--interval", type=float, default=1.0, help="采样间隔，默认 1 秒")
    parser.add_argument("--duration", type=float, default=60.0, help="总时长，默认 60 秒")
    parser.add_argument("--timeout", type=float, default=5.0, help="单次超时，默认 5 秒")
    parser.add_argument("--output", type=Path, help="输出 CSV 路径")
    parser.set_defaults(handler=run_from_args)


def run_from_args(args: argparse.Namespace) -> int:
    """执行采样并保存结果。"""

    output_path = args.output or make_output_path(f"aliyun-smoke-ping-{args.mode}", "csv")
    rows = run_smoke_ping(
        probe=args.probe,
        mode=args.mode,
        target=args.target,
        port=args.port,
        interval=args.interval,
        duration=args.duration,
        timeout=args.timeout,
    )
    fieldnames = [
        "timestamp",
        "mode",
        "probe",
        "seq",
        "target",
        "port",
        "rtt_ms",
        "timeout",
        "path_type",
        "extra_path_info",
        "error",
    ]
    write_csv_rows(output_path, fieldnames, rows)

    rtts = [float(row["rtt_ms"]) for row in rows if row["rtt_ms"]]
    stats = compute_latency_stats(rtts)
    timeout_count = sum(1 for row in rows if row["timeout"] == "true")
    path_counts: dict[str, int] = {}
    for row in rows:
        path_type = row["path_type"] or "unknown"
        path_counts[path_type] = path_counts.get(path_type, 0) + 1

    print(f"saved_csv={output_path}")
    print(
        "summary "
        f"samples={len(rows)} success={len(rtts)} timeout={timeout_count} "
        f"min_ms={_fmt(stats['min_ms'])} avg_ms={_fmt(stats['avg_ms'])} "
        f"p95_ms={_fmt(stats['p95_ms'])} max_ms={_fmt(stats['max_ms'])} "
        f"avg_jitter_ms={_fmt(stats['avg_jitter_ms'])}"
    )
    print(f"path_counts={path_counts}")
    return 0


def run_smoke_ping(
    *,
    probe: str,
    mode: str,
    target: str,
    port: int | None,
    interval: float,
    duration: float,
    timeout: float,
) -> list[dict[str, str]]:
    """按固定节奏执行 RTT 采样。"""

    if probe == "tcp-connect" and port is None:
        raise ValueError("tcp-connect 模式必须提供 --port")

    sample_count = max(1, int(duration / interval))
    rows: list[dict[str, str]] = []
    next_tick = time.perf_counter()

    for seq in range(1, sample_count + 1):
        started_at = time.perf_counter()
        if probe == "tailscale":
            sample = _tailscale_probe(target=target, timeout=timeout)
        else:
            sample = _tcp_connect_probe(target=target, port=port or 0, timeout=timeout)

        rows.append(
            {
                "timestamp": now_iso(),
                "mode": mode,
                "probe": probe,
                "seq": str(seq),
                "target": target,
                "port": str(port or ""),
                "rtt_ms": _fmt(sample.get("rtt_ms")),
                "timeout": "true" if sample["timeout"] else "false",
                "path_type": str(sample.get("path_type", "")),
                "extra_path_info": str(sample.get("extra_path_info", "")),
                "error": str(sample.get("error", "")),
            }
        )

        next_tick += interval
        sleep_for = next_tick - time.perf_counter()
        if seq < sample_count and sleep_for > 0:
            time.sleep(sleep_for)
        elif seq < sample_count and sleep_for <= 0:
            next_tick = started_at

    return rows


def _tailscale_probe(*, target: str, timeout: float) -> dict[str, Any]:
    """调用 `tailscale ping` 采集路径类型与 RTT。"""

    command = [
        "tailscale",
        "ping",
        "--c",
        "1",
        "--timeout",
        f"{timeout}s",
        "--until-direct=false",
        target,
    ]
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError:
        return {
            "timeout": True,
            "rtt_ms": None,
            "path_type": "",
            "extra_path_info": "",
            "error": "未找到 tailscale 命令，请先确认 Tailscale CLI 已加入 PATH",
        }

    output = "\n".join(part for part in (completed.stdout.strip(), completed.stderr.strip()) if part).strip()
    matched = TAILSCALE_RTT_PATTERN.search(output)
    if matched:
        path_info = matched.group("path")
        return {
            "timeout": False,
            "rtt_ms": float(matched.group("rtt_ms")),
            "path_type": _classify_tailscale_path(path_info),
            "extra_path_info": path_info,
            "error": "",
        }

    return {
        "timeout": True,
        "rtt_ms": None,
        "path_type": "",
        "extra_path_info": "",
        "error": output or f"tailscale ping 失败，returncode={completed.returncode}",
    }


def _tcp_connect_probe(*, target: str, port: int, timeout: float) -> dict[str, Any]:
    """通过 TCP 建连时间近似测量 RTT。"""

    started = time.perf_counter()
    try:
        with socket.create_connection((target, port), timeout=timeout):
            rtt_ms = (time.perf_counter() - started) * 1000
            return {
                "timeout": False,
                "rtt_ms": rtt_ms,
                "path_type": "tcp-connect",
                "extra_path_info": f"{target}:{port}",
                "error": "",
            }
    except OSError as exc:
        return {
            "timeout": True,
            "rtt_ms": None,
            "path_type": "",
            "extra_path_info": "",
            "error": str(exc),
        }


def _classify_tailscale_path(path_info: str) -> str:
    """归一化 Tailscale 路径类型。"""

    normalized = path_info.strip().lower()
    if normalized.startswith("derp("):
        return "relay"
    if normalized.startswith("peer-relay("):
        return "peer-relay"
    if normalized in {"icmp", "tsmp"}:
        return normalized
    return "direct"


def _fmt(value: Any) -> str:
    """统一格式化浮点值。"""

    if value is None or value == "":
        return ""
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)
