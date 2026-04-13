#!/bin/bash
# 自动预检脚本 — Coder 自检最后一步，必须全部通过才能标记待审查
# 技术栈：TypeScript (strict) + Biome + Vitest

set -e

# 切换到 ts-core 根目录
cd "$(dirname "$0")/.."

echo "===== 预检开始 ====="

echo "--- [1/3] TypeScript 类型检查 ---"
pnpm typecheck

echo "--- [2/3] Biome lint ---"
pnpm lint

echo "--- [3/3] Vitest 测试 ---"
pnpm test

echo "===== 预检全部通过 ====="
