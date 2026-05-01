#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/compose.yaml"
ENV_FILE="$ROOT_DIR/ts-core/.env"
ENV_EXAMPLE="$ROOT_DIR/ts-core/.env.example"
DATA_VOLUME="ts-core_ts-core-postgres-data"

info() {
  printf '[INFO] %s\n' "$1"
}

fail() {
  printf '[ERROR] %s\n' "$1" >&2
  exit 1
}

ensure_env_file_for_compose() {
  if [[ -f "$ENV_FILE" ]]; then
    return
  fi

  if [[ -f "$ENV_EXAMPLE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    info "已从 ts-core/.env.example 创建 ts-core/.env，用于执行 Compose（编排）停止命令。"
    return
  fi

  fail "缺少 env（环境变量）文件: $ENV_FILE"
}

confirm_reset_data() {
  if [[ ! -t 0 ]]; then
    fail "--reset-data 需要交互式终端二次确认。"
  fi

  printf '将删除 PostgreSQL（数据库）named volume（命名卷） %s。输入 DELETE 确认: ' "$DATA_VOLUME"
  local answer
  read -r answer

  if [[ "$answer" != "DELETE" ]]; then
    fail "未确认删除，已取消。"
  fi
}

main() {
  local reset_data=false

  case "${1:-}" in
    "")
      ;;
    --reset-data)
      reset_data=true
      ;;
    *)
      fail "未知参数: $1；可用参数: --reset-data"
      ;;
  esac

  command -v docker >/dev/null 2>&1 || fail "未找到 Docker（容器引擎）命令。"
  docker compose version >/dev/null 2>&1 || fail "未找到 Docker Compose（编排）插件。"
  ensure_env_file_for_compose

  if [[ "$reset_data" == true ]]; then
    confirm_reset_data
  fi

  info "停止 TS Core（TS 单核心）三件套，默认保留 volume（卷）..."
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down

  if [[ "$reset_data" == true ]]; then
    if docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then
      docker volume rm "$DATA_VOLUME" >/dev/null
      info "已删除 PostgreSQL（数据库）named volume（命名卷）: $DATA_VOLUME"
    else
      info "PostgreSQL（数据库）named volume（命名卷）不存在: $DATA_VOLUME"
    fi
  fi
}

main "$@"
