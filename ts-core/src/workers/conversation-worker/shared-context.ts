import { createChatSnapshotContext, createPlannerSnapshotContext } from "../../conversation/llm.js";
import type { EnvironmentSnapshot, SnapshotPosition } from "../../core-ports/observation.js";
import type { ConversationWorkerTask } from "../contracts.js";
import type { ConversationWorkerRuntimeDependencies } from "./types.js";

/** prompt（提示词） 快照上下文构建结果。 */
export interface ConversationPromptSnapshotContext {
  /** 已渲染的 snapshot_context（快照上下文）。 */
  readonly snapshot_context?: string;
  /** `[背包变化]` 行内容；用于本地诊断日志。 */
  readonly inventory_change_context?: string;
  /** ConversationWorker（对话工作线程） 同轮快照中的主人坐标。 */
  readonly owner_position_at_message?: SnapshotPosition;
  /** prompt（提示词） 上下文 provider（提供器） 降级诊断。 */
  readonly provider_diagnostics: readonly ConversationPromptSnapshotProviderDiagnostic[];
  /** prompt（提示词） 渲染完成后必须调用，用于推进 inventory baseline（背包基线）。 */
  advanceInventoryBaseline(): void;
}

export interface ConversationPromptSnapshotProviderDiagnostic {
  readonly provider: "environment_snapshot";
  readonly error_summary: string;
}

/** 构建 Chat（闲聊） 路径共享 prompt（提示词） 快照上下文。 */
export async function createChatPromptSnapshotContext(input: {
  readonly task: ConversationWorkerTask;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly recent_context?: string;
}): Promise<ConversationPromptSnapshotContext> {
  const snapshotResult = await readEnvironmentSnapshot(input);
  const inventoryDiffContext = prepareInventoryDiffContext(input, snapshotResult.snapshot);
  const snapshotContext =
    snapshotResult.snapshot === null
      ? undefined
      : createChatSnapshotContext({
          snapshot: snapshotResult.snapshot,
          ...(input.recent_context === undefined ? {} : { recentContext: input.recent_context }),
          ...(inventoryDiffContext?.inventoryChangeContext === undefined
            ? {}
            : { inventoryChangeContext: inventoryDiffContext.inventoryChangeContext }),
        });

  return Object.freeze({
    ...(snapshotContext === undefined ? {} : { snapshot_context: snapshotContext }),
    ...(inventoryDiffContext?.inventoryChangeContext === undefined
      ? {}
      : { inventory_change_context: inventoryDiffContext.inventoryChangeContext }),
    ...createOwnerPositionAtMessageField(snapshotResult.snapshot),
    provider_diagnostics: snapshotResult.diagnostics,
    advanceInventoryBaseline() {
      inventoryDiffContext?.advanceBaseline();
    },
  });
}

/** 构建 Plan / Modify（规划/修改） 路径共享 prompt（提示词） 快照上下文。 */
export async function createPlanPromptSnapshotContext(input: {
  readonly task: ConversationWorkerTask;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly resource_context?: string;
  readonly recent_context?: string;
}): Promise<ConversationPromptSnapshotContext> {
  const snapshotResult = await readEnvironmentSnapshot(input);
  const inventoryDiffContext = prepareInventoryDiffContext(input, snapshotResult.snapshot);
  const snapshotContext = createPlannerSnapshotContext({
    snapshot: snapshotResult.snapshot,
    ...(input.resource_context === undefined ? {} : { resourceContext: input.resource_context }),
    ...(input.recent_context === undefined ? {} : { recentContext: input.recent_context }),
    ...(inventoryDiffContext?.inventoryChangeContext === undefined
      ? {}
      : { inventoryChangeContext: inventoryDiffContext.inventoryChangeContext }),
  });

  return Object.freeze({
    snapshot_context: snapshotContext,
    ...(inventoryDiffContext?.inventoryChangeContext === undefined
      ? {}
      : { inventory_change_context: inventoryDiffContext.inventoryChangeContext }),
    ...createOwnerPositionAtMessageField(snapshotResult.snapshot),
    provider_diagnostics: snapshotResult.diagnostics,
    advanceInventoryBaseline() {
      inventoryDiffContext?.advanceBaseline();
    },
  });
}

function createOwnerPositionAtMessageField(snapshot: EnvironmentSnapshot | null): {
  readonly owner_position_at_message?: SnapshotPosition;
} {
  return snapshot?.owner?.position === undefined
    ? {}
    : {
        owner_position_at_message: Object.freeze({
          x: snapshot.owner.position.x,
          y: snapshot.owner.position.y,
          z: snapshot.owner.position.z,
        }),
      };
}

async function readEnvironmentSnapshot(input: {
  readonly task: ConversationWorkerTask;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
}): Promise<{
  readonly snapshot: EnvironmentSnapshot | null;
  readonly diagnostics: readonly ConversationPromptSnapshotProviderDiagnostic[];
}> {
  if (input.dependencies.environmentSnapshotProvider === undefined) {
    return Object.freeze({ snapshot: null, diagnostics: Object.freeze([]) });
  }

  try {
    return Object.freeze({
      snapshot:
        (await input.dependencies.environmentSnapshotProvider({
          task: input.task,
        })) ?? null,
      diagnostics: Object.freeze([]),
    });
  } catch (error) {
    return Object.freeze({
      snapshot: null,
      diagnostics: Object.freeze([
        Object.freeze({
          provider: "environment_snapshot" as const,
          error_summary: summarizeError(error),
        }),
      ]),
    });
  }
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "unknown provider failure";
}

function prepareInventoryDiffContext(
  input: {
    readonly task: ConversationWorkerTask;
    readonly dependencies: ConversationWorkerRuntimeDependencies;
  },
  snapshot: EnvironmentSnapshot | null,
): ReturnType<
  NonNullable<ConversationWorkerRuntimeDependencies["inventoryDiffCache"]>["preparePromptContext"]
> | null {
  if (snapshot === null || input.dependencies.inventoryDiffCache === undefined) {
    return null;
  }

  return input.dependencies.inventoryDiffCache.preparePromptContext({
    bot_id: input.task.bot_id,
    inventory: snapshot.inventory,
  });
}
