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

usage() {
  cat <<'EOF'
用法:
  ./dev-infra.sh [up|run|down|status]

命令:
  up      启动 PostgreSQL（数据库）+ Redis（缓存），并确保 Docker（容器）app（应用）未运行
  run     启动 infra（基础设施）后，在前台运行本地 TS Core（TypeScript 核心）并持续输出日志
  down    停止并移除 PostgreSQL（数据库）+ Redis（缓存）容器，保留 PostgreSQL（数据库）volume（卷）
  status  查看当前 Compose（编排）服务状态
EOF
}

ensure_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    return
  fi

  if [[ ! -f "$ENV_EXAMPLE" ]]; then
    fail "缺少 env（环境变量）样例文件: $ENV_EXAMPLE"
  fi

  cp "$ENV_EXAMPLE" "$ENV_FILE"
  info "已从 ts-core/.env.example 创建 ts-core/.env；本地 TS Core（TypeScript 核心）启动前请按需编辑。"
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
  local services=(postgres redis)
  local deadline=$((SECONDS + 180))

  info "等待 PostgreSQL（数据库）和 Redis（缓存）进入 healthy（健康）状态..."
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
      info "PostgreSQL（数据库）和 Redis（缓存）均已 healthy（健康）。"
      return
    fi

    sleep 3
  done

  for service in "${services[@]}"; do
    print_failure_context "$service"
  done
  fail "等待 healthy（健康）超时。"
}

ensure_docker_app_stopped() {
  local app_container
  app_container="$("${COMPOSE[@]}" ps -aq app)"

  if [[ -z "$app_container" ]]; then
    return
  fi

  info "开发模式只保留 infra（基础设施）；正在停止并移除 Docker（容器）app（应用）容器..."
  "${COMPOSE[@]}" rm --stop --force app >/dev/null
}

start_infra() {
  local print_steps="${1:-1}"

  ensure_env_file
  require_non_empty_env PG_DATABASE
  require_non_empty_env PG_USER
  require_non_empty_env PG_PASSWORD
  check_docker_engine

  info "校验 Compose（编排）配置..."
  "${COMPOSE[@]}" config >/dev/null

  ensure_docker_app_stopped

  info "启动开发 infra（基础设施）：PostgreSQL（数据库）+ Redis（缓存）..."
  "${COMPOSE[@]}" up -d postgres redis
  wait_for_healthy_services
  print_status

  if [[ "$print_steps" == "1" ]]; then
    print_local_ts_steps
  fi
}

run_local_ts() {
  start_infra 0
  command -v pnpm >/dev/null 2>&1 || fail "未找到 pnpm（包管理器）命令。请先启用 Corepack（包管理器代理）或安装 pnpm。"

  info "前台运行本地 TS Core（TypeScript 核心）；按 Ctrl+C 停止后端日志输出。"
  cd "$ROOT_DIR/ts-core"
  set -a
  source "$ENV_FILE"
  set +a
  exec pnpm dev
}

stop_infra() {
  ensure_env_file
  check_docker_engine

  info "停止开发 infra（基础设施），保留 PostgreSQL（数据库）volume（卷）..."
  "${COMPOSE[@]}" stop postgres redis >/dev/null || true
  "${COMPOSE[@]}" rm --force postgres redis >/dev/null || true
  print_status
}

print_status() {
  info "当前 Compose（编排）服务状态："
  "${COMPOSE[@]}" ps postgres redis app
}

print_local_ts_steps() {
  cat <<'EOF'

本地 TS Core（TypeScript 核心）启动:
  cd ts-core
  pnpm install
  set -a && source .env && set +a
  pnpm dev

常用命令:
  查看 infra（基础设施）日志: docker compose --env-file ./ts-core/.env -f compose.yaml logs -f postgres redis
  查看状态: ./dev-infra.sh status
  停止 infra（基础设施）: ./dev-infra.sh down
  全 Docker（容器）验收模式: ./start-ts-core.sh
EOF
}

main() {
  local command="${1:-up}"

  case "$command" in
    up)
      start_infra
      ;;
    run)
      run_local_ts
      ;;
    down)
      stop_infra
      ;;
    status)
      ensure_env_file
      check_docker_engine
      print_status
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage >&2
      fail "未知命令: $command"
      ;;
  esac
}

main "$@"
