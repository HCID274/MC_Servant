# Aliyun Smoke Client

这个目录是给阿里云 Linux 测量端单独使用的。

它不假设 Windows 和阿里云共享同一个仓库路径，也不要求你在云端保留 Windows 那份目录。你可以只把这个目录单独上传到阿里云。

## 它负责什么

- 采集 Tailscale RTT 与路径类型
- 采集 WebSocket echo RTT、超时、重连
- 包装 `iperf3 -J` 结果

## 它不负责什么

- 不在云端启动 WebSocket 服务
- 不提供本地被测端服务

## 阿里云使用步骤

### 1. 安装依赖

```bash
cd <aliyun_smoke_client_directory>
uv python install 3.12
uv sync
```

### 2. 先人工确认 Tailscale

```bash
tailscale status
tailscale ping --c 1 --until-direct=false <windows_tailnet_name_or_ip>
```

### 3. 跑 60 秒 RTT 冒烟

```bash
cd <aliyun_smoke_client_directory>
uv run aliyun-smoke-ping \
  --probe tailscale \
  --mode tailscale \
  --target <windows_tailnet_name_or_ip> \
  --duration 60 \
  --interval 1
```

### 4. 跑 60 秒 WebSocket echo

```bash
cd <aliyun_smoke_client_directory>
uv run aliyun-smoke-ws \
  --mode tailscale \
  --url ws://<windows_tailnet_ip>:8765 \
  --duration 60 \
  --interval 1
```

### 5. 跑 15 秒 iperf3 粗测

```bash
cd <aliyun_smoke_client_directory>
uv run aliyun-smoke-iperf \
  --mode tailscale \
  --host <windows_tailnet_ip> \
  --port 5201 \
  --duration 15
```

## 输出文件

结果默认写到当前目录下的 `results/`：

- `aliyun-smoke-ping`: CSV
- `aliyun-smoke-ws`: CSV
- `aliyun-smoke-iperf`: JSON

## 后续切 FRP

后面如果你测 FRP，不换代码，只改目标地址与 `--mode frp`：

- `aliyun-smoke-ping`: 用 `--probe tcp-connect` 加 Windows 侧专门开的 TCP accept 端口，或 FRP 暴露的对应 TCP 端口
- `aliyun-smoke-ws`: 用 FRP 暴露的 WebSocket 地址
- `aliyun-smoke-iperf`: 用 FRP 转发的 `iperf3` 端口
