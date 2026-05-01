#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/compose.yaml"
ENV_FILE="$ROOT_DIR/ts-core/.env"
ENV_EXAMPLE="$ROOT_DIR/ts-core/.env.example"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

info() {
  printf '[INFO] %s\n' "$1"
}

warn() {
  printf '[WARN] %s\n' "$1" >&2
}

fail() {
  printf '[ERROR] %s\n' "$1" >&2
  exit 1
}

ensure_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    return
  fi

  if [[ ! -f "$ENV_EXAMPLE" ]]; then
    fail "缺少 env（环境变量）样例文件: $ENV_EXAMPLE"
  fi

  cp "$ENV_EXAMPLE" "$ENV_FILE"
  info "已从 ts-core/.env.example 创建 ts-core/.env；如需连接外部服务，请先编辑该文件。"
}

read_env_value() {
  local key="$1"
  awk -F= -v key="$key" '
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[ \t"'\''"]+|[ \t"'\''"]+$/, "", value)
      print value
    }
  ' "$ENV_FILE" | tail -n 1
}

require_non_empty_env() {
  local key="$1"
  local value
  value="$(read_env_value "$key")"

  if [[ -z "$value" ]]; then
    fail "ts-core/.env 中 $key 不能为空。"
  fi
}

check_docker_engine() {
  command -v docker >/dev/null 2>&1 || fail "未找到 Docker（容器引擎）命令。"
  docker info >/dev/null 2>&1 || fail "Docker（容器引擎）未运行，先启动 Docker Desktop 或 dockerd。"
  docker compose version >/dev/null 2>&1 || fail "未找到 Docker Compose（编排）插件。"
}

service_health() {
  local service="$1"
  local container_id
  container_id="$("${COMPOSE[@]}" ps -q "$service")"

  if [[ -z "$container_id" ]]; then
    printf 'missing'
    return
  fi

  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id"
}

print_failure_context() {
  local service="$1"
  warn "$service 未进入 healthy（健康）状态，最近日志如下："
  "${COMPOSE[@]}" logs --tail=80 "$service" >&2 || true
}

wait_for_healthy_services() {
  local services=(postgres redis app)
  local deadline=$((SECONDS + 240))

  info "等待 PostgreSQL（数据库）、Redis（缓存）、app（应用）进入 healthy（健康）状态..."
  while (( SECONDS < deadline )); do
    local all_healthy=1

    for service in "${services[@]}"; do
      local health
      health="$(service_health "$service")"

      case "$health" in
        healthy)
          ;;
        unhealthy|exited|dead|missing)
          print_failure_context "$service"
          fail "$service 状态为 $health。"
          ;;
        *)
          all_healthy=0
          ;;
      esac
    done

    if (( all_healthy == 1 )); then
      info "三服务均已 healthy（健康）。"
      return
    fi

    sleep 5
  done

  for service in "${services[@]}"; do
    print_failure_context "$service"
  done
  fail "等待 healthy（健康）超时。"
}

probe_minecraft_server() {
  local host port
  host="$(read_env_value MC_HOST)"
  port="$(read_env_value MC_PORT)"
  host="${host:-127.0.0.1}"
  port="${port:-25565}"

  if timeout 2 bash -c "</dev/tcp/$host/$port" >/dev/null 2>&1; then
    info "Minecraft（我的世界）服务端端口可达: $host:$port"
  else
    warn "Minecraft（我的世界）服务端端口暂不可达: $host:$port；Compose（编排）不会管理该服务，请确认宿主机服务端已启动。"
  fi
}

print_status() {
  info "当前 Compose（编排）服务状态："
  "${COMPOSE[@]}" ps
  cat <<'EOF'

关键端口:
  app（应用）HTTP（超文本传输协议）: http://127.0.0.1:3000/api/health
  PostgreSQL（数据库）: 127.0.0.1:5432
  Redis（缓存）: 127.0.0.1:6379

常用命令:
  查看日志: docker compose --env-file ./ts-core/.env -f compose.yaml logs -f app
  停止服务: ./stop-ts-core.sh
  停止并重置数据库: ./stop-ts-core.sh --reset-data
EOF
}

main() {
  ensure_env_file
  require_non_empty_env PG_DATABASE
  require_non_empty_env PG_USER
  require_non_empty_env PG_PASSWORD
  check_docker_engine

  info "校验 Compose（编排）配置..."
  "${COMPOSE[@]}" config >/dev/null

  info "启动 TS Core（TS 单核心）三件套..."
  "${COMPOSE[@]}" up -d --build
  wait_for_healthy_services
  probe_minecraft_server
  print_status
}

main "$@"
