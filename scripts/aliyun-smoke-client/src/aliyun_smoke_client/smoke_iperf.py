"""阿里云 iperf3 粗测包装器。"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any

from .common import make_output_path, now_iso, write_json


def register_parser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    """注册 `smoke-iperf` 子命令。"""

    parser = subparsers.add_parser("smoke-iperf", help="执行 iperf3 短时粗测")
    parser.add_argument("--mode", required=True, help="结果标签，例如 tailscale 或 frp")
    parser.add_argument("--host", required=True, help="iperf3 server 主机")
    parser.add_argument("--port", type=int, default=5201, help="iperf3 server 端口，默认 5201")
    parser.add_argument("--duration", type=int, default=15, help="测试时长，默认 15 秒")
    parser.add_argument("--protocol", choices=("tcp", "udp"), default="tcp", help="测试协议")
    parser.add_argument("--udp-bandwidth", default="2M", help="UDP 模式下的带宽参数，默认 2M")
    parser.add_argument("--output", type=Path, help="输出 JSON 路径")
    parser.set_defaults(handler=run_from_args)


def run_from_args(args: argparse.Namespace) -> int:
    """执行 iperf3 并保存原始结果。"""

    output_path = args.output or make_output_path(f"aliyun-smoke-iperf-{args.mode}", "json")
    command = [
        "iperf3",
        "-c",
        args.host,
        "-p",
        str(args.port),
        "-J",
        "-t",
        str(args.duration),
    ]
    if args.protocol == "udp":
        command.extend(["-u", "-b", args.udp_bandwidth])

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
        print("未找到 iperf3 命令，请先安装 iperf3 并确保已加入 PATH")
        return 1

    parsed_stdout: dict[str, Any] | None = None
    stdout_text = completed.stdout.strip()
    if stdout_text:
        try:
            parsed_stdout = json.loads(stdout_text)
        except json.JSONDecodeError:
            parsed_stdout = None

    payload = {
        "executed_at": now_iso(),
        "mode": args.mode,
        "protocol": args.protocol,
        "command": command,
        "returncode": completed.returncode,
        "stdout_json": parsed_stdout,
        "stdout_text": stdout_text if parsed_stdout is None else "",
        "stderr": completed.stderr.strip(),
    }
    write_json(output_path, payload)

    print(f"saved_json={output_path}")
    if parsed_stdout is not None:
        summary = _extract_summary(parsed_stdout, protocol=args.protocol)
        print(f"summary {summary}")
    else:
        print(f"summary returncode={completed.returncode} stderr={completed.stderr.strip()}")

    return 0 if completed.returncode == 0 else completed.returncode


def _extract_summary(payload: dict[str, Any], *, protocol: str) -> str:
    """提取少量人工可读摘要。"""

    end = payload.get("end") or {}
    if protocol == "udp":
        udp_sum = end.get("sum") or {}
        bits_per_second = udp_sum.get("bits_per_second")
        lost_percent = udp_sum.get("lost_percent")
        return f"bits_per_second={_fmt(bits_per_second)} lost_percent={_fmt(lost_percent)}"

    received = end.get("sum_received") or {}
    bits_per_second = received.get("bits_per_second")
    retransmits = end.get("sum_sent", {}).get("retransmits")
    return f"bits_per_second={_fmt(bits_per_second)} retransmits={_fmt(retransmits)}"


def _fmt(value: Any) -> str:
    """统一格式化摘要值。"""

    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)
