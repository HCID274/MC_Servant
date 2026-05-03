import { createChatSnapshotContext, createPlannerSnapshotContext } from "../../conversation/llm.js";
import type { EnvironmentSnapshot } from "../../core-ports/observation.js";
import type { ConversationWorkerTask } from "../contracts.js";
import type { ConversationWorkerRuntimeDependencies } from "./types.js";

/** prompt（提示词） 快照上下文构建结果。 */
export interface ConversationPromptSnapshotContext {
  /** 已渲染的 snapshot_context（快照上下文）。 */
  readonly snapshot_context?: string;
  /** `[背包变化]` 行内容；用于本地诊断日志。 */
  readonly inventory_change_context?: string;
  /** prompt（提示词） 渲染完成后必须调用，用于推进 inventory baseline（背包基线）。 */
  advanceInventoryBaseline(): void;
}

/** 构建 Chat（闲聊） 路径共享 prompt（提示词） 快照上下文。 */
export async function createChatPromptSnapshotContext(input: {
  readonly task: ConversationWorkerTask;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly recent_context?: string;
}): Promise<ConversationPromptSnapshotContext> {
  const snapshot = await readEnvironmentSnapshot(input);
  const inventoryDiffContext = prepareInventoryDiffContext(input, snapshot);
  const snapshotContext =
    snapshot === null
      ? undefined
      : createChatSnapshotContext({
          snapshot,
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
  const snapshot = await readEnvironmentSnapshot(input);
  const inventoryDiffContext = prepareInventoryDiffContext(input, snapshot);
  const snapshotContext = createPlannerSnapshotContext({
    snapshot,
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
    advanceInventoryBaseline() {
      inventoryDiffContext?.advanceBaseline();
    },
  });
}

async function readEnvironmentSnapshot(input: {
  readonly task: ConversationWorkerTask;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
}): Promise<EnvironmentSnapshot | null> {
  if (input.dependencies.environmentSnapshotProvider === undefined) {
    return null;
  }

  try {
    return (
      (await input.dependencies.environmentSnapshotProvider({
        task: input.task,
      })) ?? null
    );
  } catch {
    return null;
  }
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
