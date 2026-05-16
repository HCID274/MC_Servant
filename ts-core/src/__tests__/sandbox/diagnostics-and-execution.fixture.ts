import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AbortError,
  ExecPriority,
  ExecutionTaskKind,
  TaskHistoryStatus,
  type TaskLifecycleEvent,
  createAsyncDiagnosticSink,
  createCodeJob,
  createDiagnosticsCatalog,
  createLlmDiagnosticSummary,
  createLlmLogLine,
  createLlmLogRef,
  createLocalConversationReplyLogSink,
  createSandboxCodeRef,
  createSandboxError,
  createSandboxExecutionFailure,
  createSandboxExecutionInterrupted,
  createSandboxExecutionRequest,
  createSandboxExecutionSuccess,
  createSandboxExperienceDraft,
  createSandboxLogLine,
  createSandboxLogRef,
  createSandboxResourceLimits,
  createSandboxStepResult,
  createTaskLifecycleSummaryJsonlLine,
  createTaskLogLine,
  createTaskLogRef,
  createTaskStartedLifecycleEvent,
  createTaskTerminalLifecycleEvent,
  executeCodeRequest,
} from "../../index.js";
import {
  SANDBOX_BOT_METHOD_NAMES,
  SANDBOX_FACADE_SECTIONS,
  SANDBOX_FORBIDDEN_DEMO_METHOD_NAMES,
  SANDBOX_READONLY_SECTIONS,
  type SANDBOX_STEP_ACTION_NAMES,
  SANDBOX_TOOLCHAIN_CAPABILITY_NAMES,
  SANDBOX_TOOLCHAIN_FAILURE_CODES,
  type SandboxExecutionRequest,
  type SandboxStepParamsByAction,
  type SandboxToolchainCapabilityParamsByName,
} from "../../sandbox/contracts.js";
import { createTaskResultSummaryFromSandboxResult } from "../../workers/task-result-summary/index.js";

// @ts-expect-error `dig`（挖掘） 不是 Phase 1（第一阶段） 可记录动作。
export const invalidStepAction: (typeof SANDBOX_STEP_ACTION_NAMES)[number] = "dig";
void invalidStepAction;

// @ts-expect-error `goTo`（移动） 的参数必须是坐标结构。
export const invalidGoToParams: SandboxStepParamsByAction["goTo"] = {
  blockName: "oak_log",
  count: 1,
};
void invalidGoToParams;

// @ts-expect-error `SandboxExecutionRequest.type` 固定为 `code`（沙箱代码）。
export const invalidSandboxRequestType: SandboxExecutionRequest["type"] = ExecutionTaskKind.Code;
void invalidSandboxRequestType;

// @ts-expect-error `AbortError`（中断错误） 固定不可恢复。
export const invalidAbortRecoverable: AbortError["recoverable"] = true;
void invalidAbortRecoverable;

export const validCraftParams: SandboxToolchainCapabilityParamsByName["craft"] = {
  itemName: "stone_pickaxe",
  count: 1,
};

export function createSatisfiedConditionFacade() {
  const state = Object.freeze({
    world_key: "minecraft:overworld",
    inventory: Object.freeze([]),
    main_hand_item_name: null,
    nearby_block_names: Object.freeze(["crafting_table"]),
  });

  return Object.freeze({
    captureConditionState() {
      return state;
    },
    evaluateCondition(input: {
      readonly condition: Readonly<Record<string, unknown>>;
      readonly baseline: typeof state;
      readonly current: typeof state;
    }) {
      const targetCount = typeof input.condition.count === "number" ? input.condition.count : 1;
      const resolvedTarget =
        readTestConditionTarget(input.condition) ??
        readTestConditionBlock(input.condition) ??
        "target";
      return Object.freeze({
        ok: true,
        condition: input.condition,
        completed_count: targetCount,
        target_count: targetCount,
        missing_count: 0,
        resolved_targets: Object.freeze([resolvedTarget]),
        baseline: input.baseline,
        current: input.current,
      });
    },
  });
}

export function readTestConditionTarget(
  condition: Readonly<Record<string, unknown>>,
): string | null {
  return typeof condition.itemName === "string"
    ? condition.itemName
    : typeof condition.tagName === "string"
      ? condition.tagName
      : null;
}

export function readTestConditionBlock(
  condition: Readonly<Record<string, unknown>>,
): string | null {
  return typeof condition.blockName === "string" ? condition.blockName : null;
}

export function createTestConditionEvaluation(
  input: {
    readonly condition: Readonly<Record<string, unknown>>;
    readonly baseline: Readonly<Record<string, unknown>>;
    readonly current: Readonly<Record<string, unknown>>;
  },
  completed: number,
  target: number,
) {
  const resolvedTarget =
    readTestConditionTarget(input.condition) ?? readTestConditionBlock(input.condition) ?? "target";
  return Object.freeze({
    ok: completed >= target,
    condition: input.condition,
    completed_count: completed,
    target_count: target,
    missing_count: Math.max(0, target - completed),
    resolved_targets: Object.freeze([resolvedTarget]),
    baseline: input.baseline,
    current: input.current,
  });
}
void validCraftParams;

// @ts-expect-error `craft`（合成） 参数不接受坐标；放置坐标属于 `place`（放置） 能力。
export const invalidCraftParams: SandboxToolchainCapabilityParamsByName["craft"] = { x: 1 };
void invalidCraftParams;

export function createRuntimeSandboxRequest(input: {
  code: string;
  messageId?: string;
  resourceLimits?: Parameters<typeof createSandboxResourceLimits>[0];
}) {
  return createSandboxExecutionRequest({
    job_id: input.messageId ?? "T-027",
    bot_id: "bot-027",
    intent_epoch: 1,
    snapshot_ts: 1_712_930_001,
    code: input.code,
    log_ref: createSandboxLogRef({
      date: "2026-04-13",
      job_id: input.messageId ?? "T-027",
    }),
    resource_limits: input.resourceLimits,
  });
}

export {
  describe,
  expect,
  it,
  ExecPriority,
  ExecutionTaskKind,
  TaskHistoryStatus,
  createAsyncDiagnosticSink,
  createCodeJob,
  createDiagnosticsCatalog,
  createLlmDiagnosticSummary,
  createLlmLogLine,
  createLlmLogRef,
  createLocalConversationReplyLogSink,
  createSandboxCodeRef,
  createSandboxError,
  createSandboxExecutionFailure,
  createSandboxExecutionInterrupted,
  createSandboxExecutionRequest,
  createSandboxExecutionSuccess,
  createSandboxExperienceDraft,
  createSandboxLogLine,
  createSandboxLogRef,
  createSandboxResourceLimits,
  createSandboxStepResult,
  createTaskLifecycleSummaryJsonlLine,
  createTaskLogLine,
  createTaskLogRef,
  createTaskStartedLifecycleEvent,
  createTaskTerminalLifecycleEvent,
  executeCodeRequest,
  SANDBOX_BOT_METHOD_NAMES,
  SANDBOX_FACADE_SECTIONS,
  SANDBOX_FORBIDDEN_DEMO_METHOD_NAMES,
  SANDBOX_READONLY_SECTIONS,
  SANDBOX_TOOLCHAIN_CAPABILITY_NAMES,
  SANDBOX_TOOLCHAIN_FAILURE_CODES,
  createTaskResultSummaryFromSandboxResult,
};

export type {
  AbortError,
  TaskLifecycleEvent,
  SANDBOX_STEP_ACTION_NAMES,
  SandboxExecutionRequest,
  SandboxStepParamsByAction,
  SandboxToolchainCapabilityParamsByName,
};
