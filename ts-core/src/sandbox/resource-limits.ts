import type { SandboxExecutionResourceLimits, StaticCheckError } from "./contracts.js";
import { assertPositiveInteger, createSandboxError } from "./validators.js";

const FORBIDDEN_SANDBOX_PATTERNS = Object.freeze([
  { name: "import", pattern: /\bimport(?:\s|\()/ },
  { name: "require", pattern: /\brequire\s*\(/ },
  { name: "process", pattern: /\bprocess\b/ },
  { name: "globalThis", pattern: /\bglobalThis\b/ },
  { name: "sandbox_internal_bridge", pattern: /\b__sandbox[A-Za-z0-9_]*\b/ },
  { name: "eval", pattern: /\beval\s*\(/ },
  { name: "Function", pattern: /\bFunction\s*\(/ },
  { name: "filesystem", pattern: /\b(?:fs|node:fs)\b/ },
  {
    name: "network",
    pattern: /\b(?:net|node:net|http|node:http|https|node:https|fetch|WebSocket)\b/,
  },
] as const);

/** 默认的 sandbox（沙箱执行） 资源限制。 */
export const DEFAULT_SANDBOX_RESOURCE_LIMITS = Object.freeze({
  memory_limit_mb: 128,
  timeout_ms: 120_000,
  script_timeout_ms: 115_000,
  max_sleep_ms: 10_000,
  abort_cleanup_timeout_ms: 500,
} as const satisfies SandboxExecutionResourceLimits);

/**
 * 创建沙箱资源限制对象。
 *
 * 资源限制只负责执行边界，不承载动作语义。
 */
export function createSandboxResourceLimits(
  input: Partial<SandboxExecutionResourceLimits> = {},
): Readonly<SandboxExecutionResourceLimits> {
  const resourceLimits = {
    memory_limit_mb: input.memory_limit_mb ?? DEFAULT_SANDBOX_RESOURCE_LIMITS.memory_limit_mb,
    timeout_ms: input.timeout_ms ?? DEFAULT_SANDBOX_RESOURCE_LIMITS.timeout_ms,
    script_timeout_ms: input.script_timeout_ms ?? DEFAULT_SANDBOX_RESOURCE_LIMITS.script_timeout_ms,
    max_sleep_ms: input.max_sleep_ms ?? DEFAULT_SANDBOX_RESOURCE_LIMITS.max_sleep_ms,
    abort_cleanup_timeout_ms:
      input.abort_cleanup_timeout_ms ?? DEFAULT_SANDBOX_RESOURCE_LIMITS.abort_cleanup_timeout_ms,
  };

  assertPositiveInteger(resourceLimits.memory_limit_mb, "memory_limit_mb");
  assertPositiveInteger(resourceLimits.timeout_ms, "timeout_ms");
  assertPositiveInteger(resourceLimits.script_timeout_ms, "script_timeout_ms");
  assertPositiveInteger(resourceLimits.max_sleep_ms, "max_sleep_ms");
  assertPositiveInteger(resourceLimits.abort_cleanup_timeout_ms, "abort_cleanup_timeout_ms");

  if (resourceLimits.script_timeout_ms >= resourceLimits.timeout_ms) {
    throw new Error("script_timeout_ms must be shorter than timeout_ms");
  }

  return Object.freeze(resourceLimits);
}

/**
 * 对沙箱源码执行静态预检。
 *
 * 该检查只作为进入 isolated-vm 前的第一道硬边界，真正能力仍由 host bridge 注入控制。
 */
export function checkSandboxSourceStaticPolicy(code: string): StaticCheckError | null {
  if (code.trim().length === 0) {
    throw new Error("code must be a non-empty string");
  }

  for (const forbidden of FORBIDDEN_SANDBOX_PATTERNS) {
    if (forbidden.pattern.test(code)) {
      return createSandboxError({
        name: "StaticCheckError",
        message: `Forbidden sandbox capability detected: ${forbidden.name}`,
        recoverable: false,
        violation: forbidden.name,
      });
    }
  }

  return null;
}
