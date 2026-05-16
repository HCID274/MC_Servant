import { describe, expect, it, vi } from "vitest";
import { createCodeJobForSkill } from "../../helpers/test-code-job.js";

import {
  createConversationCompositeTriage,
  createConversationRecentContextStore,
} from "../../../conversation/index.js";
import {
  ConversationLlmChatError,
  ConversationLlmPlanError,
  ConversationLlmSkillNotEnabledError,
} from "../../../conversation/llm.js";
import {
  BotStatus,
  ExecPriority,
  createBotActorStateProjection,
  createCodeJob,
  createRecoveryChainId,
  createTaskResultSummary,
} from "../../../core-ports/index.js";
import type { EnvironmentSnapshot, InventorySummary } from "../../../core-ports/observation.js";
import { TaskHistoryStatus } from "../../../core-ports/tasking.js";
import { createTaskSummaryDraft } from "../../../data/index.js";
import { createPostgresBrainMemoryStore } from "../../../db/index.js";
import { ConversationPriority } from "../../../domain/contracts.js";
import { createGoToSkillExecutionResult } from "../../../skills/index.js";
import { createBotWorkerRuntime } from "../../../workers/bot-worker.js";
import { createBrainWorkerRuntime } from "../../../workers/brain-worker.js";
import {
  createBotWorkerActions,
  createBotWorkerTask,
  createConversationWorkerTask,
} from "../../../workers/contracts.js";
import {
  createConversationBotWorkerActionSink,
  createConversationWorkerRuntime,
} from "../../../workers/conversation-worker.js";
import { createConversationWorkerMemoryContext } from "../../../workers/conversation-worker/helpers.js";
import {
  persistAcceptedTaskHistory,
  persistTaskHistoryLifecycleAction,
} from "../../../workers/task-history-sink.js";

export function createCompositeChatTriage() {
  return createConversationCompositeTriage({
    chat: {},
  });
}

export function createCompositeTaskTriage(input: {
  readonly priority: ConversationPriority;
  readonly reason: string;
  readonly needs_memory_search?: boolean;
}) {
  return createConversationCompositeTriage({
    action: {
      intent: "task",
      priority: input.priority,
      reason: input.reason,
      ...(input.needs_memory_search === undefined
        ? {}
        : { needs_memory_search: input.needs_memory_search }),
    },
  });
}

export function createCompositeCancelTriage(reason: string) {
  return createConversationCompositeTriage({
    cancel: {
      priority: "interrupt",
      reason,
    },
  });
}

export function createFakeBrainMemoryDb(input: {
  readonly memoryRows: Record<string, unknown>[];
  readonly candidateRows: Record<string, unknown>[];
  readonly auditRows: Record<string, unknown>[];
}) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => input.memoryRows,
        }),
      }),
    }),
    insert: () => ({
      values: (row: unknown) => {
        const record = row as Record<string, unknown>;

        if (typeof record.confidence === "number") {
          input.candidateRows.push(record);

          return Promise.resolve(undefined);
        }
        if (typeof record.op === "string") {
          input.auditRows.push(record);

          return Promise.resolve(undefined);
        }

        return {
          async onConflictDoUpdate() {
            const existingIndex = input.memoryRows.findIndex(
              (memoryRow) => memoryRow.botId === record.botId && memoryRow.kind === record.kind,
            );
            const normalizedRow = {
              ...record,
              updatedAt:
                record.updatedAt instanceof Date
                  ? record.updatedAt
                  : new Date(String(record.updatedAt)),
            };

            if (existingIndex < 0) {
              input.memoryRows.push(normalizedRow);
            } else {
              input.memoryRows[existingIndex] = normalizedRow;
            }
          },
        };
      },
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: async () => values,
      }),
    }),
  };
}
export function createEnvironmentSnapshotFixture(
  inventoryItems: readonly (readonly [string, number])[],
  ownerPosition: EnvironmentSnapshot["owner"]["position"] = { x: 1, y: 64, z: 1 },
): EnvironmentSnapshot {
  return Object.freeze({
    timestamp: 1,
    snapshot_version: "inventory-diff-test",
    bot: {
      position: { x: 0, y: 64, z: 0 },
      world_key: "overworld",
      health: 20,
      food: 20,
      experience: 0,
      is_on_fire: false,
      is_in_water: false,
      y_velocity: 0,
    },
    inventory: createInventorySummaryFixture(inventoryItems),
    equipment: {
      head: null,
      chest: null,
      legs: null,
      feet: null,
      main_hand: null,
      off_hand: null,
      has_weapon_equipped: false,
    },
    nearby_entities: [],
    nearby_blocks: [],
    owner: {
      position: ownerPosition,
      name: "owner",
      online: true,
    },
    time: {
      phase: "day",
      time_of_day: 1000,
    },
    server_extended: {
      global_entity_count: 0,
      chunk_loaded_count: 0,
      tps: 20,
    },
  });
}

export function createInventorySummaryFixture(
  items: readonly (readonly [string, number])[],
): InventorySummary {
  const entries = items.map(([itemName, count], index) =>
    Object.freeze({
      slot: index,
      item_name: itemName,
      count,
    }),
  );

  return Object.freeze({
    items: entries,
    total_items: entries.reduce((sum, item) => sum + item.count, 0),
    occupied_slots: entries.length,
    free_slots: 36 - entries.length,
  });
}

export {
  describe,
  expect,
  it,
  vi,
  createCodeJobForSkill,
  createConversationCompositeTriage,
  createConversationRecentContextStore,
  ConversationLlmChatError,
  ConversationLlmPlanError,
  ConversationLlmSkillNotEnabledError,
  BotStatus,
  ExecPriority,
  createBotActorStateProjection,
  createCodeJob,
  createRecoveryChainId,
  createTaskResultSummary,
  TaskHistoryStatus,
  createTaskSummaryDraft,
  createPostgresBrainMemoryStore,
  ConversationPriority,
  createGoToSkillExecutionResult,
  createBotWorkerRuntime,
  createBrainWorkerRuntime,
  createBotWorkerActions,
  createBotWorkerTask,
  createConversationWorkerTask,
  createConversationBotWorkerActionSink,
  createConversationWorkerRuntime,
  createConversationWorkerMemoryContext,
  persistAcceptedTaskHistory,
  persistTaskHistoryLifecycleAction,
};

export type { EnvironmentSnapshot, InventorySummary };
