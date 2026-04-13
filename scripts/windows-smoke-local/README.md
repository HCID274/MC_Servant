# Windows Smoke Local

这个目录是给本地 Windows 被测端单独使用的。

它不假设阿里云和 Windows 共享同一个仓库路径，也不要求两边目录名一致。你可以把整个目录单独拷到 Windows 任意位置。

## 它负责什么

- 提供 WebSocket echo 服务，供阿里云客户端测 RTT 和断线
- 提供纯 TCP 接受端口，供阿里云客户端做 `tcp-connect` RTT 冒烟
- 配合你手工启动 `iperf3 -s`

## 它不负责什么

- 不负责主动发起测量
- 不负责保存云端的 RTT CSV
- 不负责 Tailscale 路径判定

## Windows 使用步骤

### 1. 安装依赖

```powershell
cd <windows_smoke_local_directory>
uv python install 3.12
uv sync
```

### 2. 启动 WebSocket echo

```powershell
cd <windows_smoke_local_directory>
uv run windows-ws-echo --host 0.0.0.0 --port 8765
```

### 3. 启动 TCP accept

如果你后面要让阿里云跑 `tcp-connect`，再开一个终端：

```powershell
cd <windows_smoke_local_directory>
uv run windows-tcp-accept --host 0.0.0.0 --port 8766
```

### 4. 启动 iperf3 server

如果你要做吞吐粗测，再开一个终端：

```powershell
iperf3 -s
```

## 给阿里云的信息

你只需要把下面两项告诉阿里云测量端：

- 你的 Windows Tailscale 名称或 Tailscale IP
- WebSocket 端口，默认 `8765`
- TCP accept 端口，默认 `8766`

如果还有 `iperf3`，再补：

- `iperf3` 端口，默认 `5201`
