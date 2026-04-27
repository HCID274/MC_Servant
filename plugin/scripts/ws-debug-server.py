#!/usr/bin/env python3
"""Minimal local WebSocket debug server for MCServant Fabric bridge."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import socket
import struct
import sys
from datetime import datetime, timezone


GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_until(sock: socket.socket, marker: bytes) -> bytes:
    data = bytearray()
    while marker not in data:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("connection closed during handshake")
        data.extend(chunk)
    return bytes(data)


def parse_headers(raw: bytes) -> tuple[str, dict[str, str]]:
    text = raw.decode("iso-8859-1")
    head = text.split("\r\n\r\n", 1)[0]
    lines = head.split("\r\n")
    request_line = lines[0]
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            name, value = line.split(":", 1)
            headers[name.lower()] = value.strip()
    return request_line, headers


def accept_key(client_key: str) -> str:
    digest = hashlib.sha1((client_key + GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def send_handshake(sock: socket.socket, headers: dict[str, str]) -> None:
    key = headers.get("sec-websocket-key")
    if not key:
        raise ValueError("missing Sec-WebSocket-Key")
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept_key(key)}\r\n"
        "\r\n"
    )
    sock.sendall(response.encode("ascii"))


def recv_exact(sock: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ConnectionError("connection closed")
        data.extend(chunk)
    return bytes(data)


def read_frame(sock: socket.socket) -> tuple[int, bytes]:
    first, second = recv_exact(sock, 2)
    opcode = first & 0x0F
    masked = (second & 0x80) != 0
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", recv_exact(sock, 8))[0]
    mask = recv_exact(sock, 4) if masked else b"\x00\x00\x00\x00"
    payload = bytearray(recv_exact(sock, length))
    if masked:
        for index in range(length):
            payload[index] ^= mask[index % 4]
    return opcode, bytes(payload)


def write_text_frame(sock: socket.socket, payload: dict[str, object]) -> None:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    header = bytearray([0x81])
    if len(body) < 126:
        header.append(len(body))
    elif len(body) <= 0xFFFF:
        header.append(126)
        header.extend(struct.pack("!H", len(body)))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", len(body)))
    sock.sendall(bytes(header) + body)


def write_close_frame(sock: socket.socket) -> None:
    sock.sendall(b"\x88\x00")


def redact_sensitive(value: object) -> object:
    if isinstance(value, dict):
        result: dict[str, object] = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if "token" in lowered or "authorization" in lowered or "secret" in lowered:
                result[str(key)] = "[redacted]"
            else:
                result[str(key)] = redact_sensitive(item)
        return result
    if isinstance(value, list):
        return [redact_sensitive(item) for item in value]
    return value


def handle_client(conn: socket.socket, addr: tuple[str, int], path: str) -> None:
    raw = read_until(conn, b"\r\n\r\n")
    request_line, headers = parse_headers(raw)
    requested_path = request_line.split(" ")[1] if " " in request_line else ""
    print(f"[bridge-debug] client={addr[0]}:{addr[1]} path={requested_path}")
    print(f"[bridge-debug] authorization_present={'authorization' in headers}")
    if requested_path != path:
        print(f"[bridge-debug] warning: expected path {path}")
    send_handshake(conn, headers)
    print("[bridge-debug] websocket accepted")

    while True:
        opcode, payload = read_frame(conn)
        if opcode == 0x8:
            print("[bridge-debug] close received")
            write_close_frame(conn)
            return
        if opcode == 0x9:
            continue
        if opcode != 0x1:
            print(f"[bridge-debug] ignored opcode={opcode}")
            continue
        text = payload.decode("utf-8", errors="replace")
        try:
            frame = json.loads(text)
        except json.JSONDecodeError:
            frame = {"type": "unparseable", "raw": text}
        frame_type = frame.get("type", "unknown")
        safe_frame = redact_sensitive(frame)
        print(f"[bridge-debug] frame type={frame_type} body={json.dumps(safe_frame, ensure_ascii=False)}")
        write_text_frame(
            conn,
            {
                "type": "ack",
                "ack_type": frame_type,
                "timestamp": utc_now(),
            },
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Run local MCServant bridge WebSocket debug server.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--path", default="/ws/server-bridge")
    args = parser.parse_args()

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((args.host, args.port))
        server.listen(1)
        print(f"[bridge-debug] listening ws://{args.host}:{args.port}{args.path}")
        while True:
            conn, addr = server.accept()
            with conn:
                try:
                    handle_client(conn, addr, args.path)
                except (ConnectionError, OSError, ValueError) as exc:
                    print(f"[bridge-debug] client ended: {exc}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
