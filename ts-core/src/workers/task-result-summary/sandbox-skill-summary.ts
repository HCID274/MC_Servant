import { ExecutionTaskKind } from "../../core-ports/foundation.js";
import {
  type TaskResultInventoryDelta,
  type TaskResultSummary,
  createTaskResultSummary,
} from "../../core-ports/task-result.js";
import {
  asRecord,
  createInventoryDelta,
  createUnknownCompletionSkillSummary,
  isRecord,
  knownRecordFields,
  readCollectedCount,
  readNumber,
  readOptionalString,
  readStringArray,
} from "./summary-facts.js";

export function readSandboxSkillResult(value: unknown): TaskResultSummary | null {
  if (!isRecord(value) || typeof value.skill !== "string") {
    return null;
  }

  switch (value.skill) {
    case "mine":
      return readMineSandboxSkillResult(value);
    case "collect":
      return readCollectSandboxSkillResult(value);
    case "equip":
      return readEquipSandboxSkillResult(value);
    case "goTo":
      return readGoToSandboxSkillResult(value);
    default:
      return null;
  }
}

function readMineSandboxSkillResult(value: Readonly<Record<string, unknown>>): TaskResultSummary {
  const target = readOptionalString(value.block_name);
  const completedCount = readNumber(value.collected_count);
  const minedCount = readNumber(value.mined_count);
  const collectedItemName = readOptionalString(value.collected_item_name);
  const missingFields = [
    ...(collectedItemName === undefined ? ["collected_item_name"] : []),
    ...(completedCount === undefined ? ["collected_count"] : []),
    ...(minedCount === undefined ? ["mined_count"] : []),
  ];
  if (
    missingFields.length > 0 ||
    completedCount === undefined ||
    minedCount === undefined ||
    collectedItemName === undefined
  ) {
    return createUnknownCompletionSkillSummary({
      skill: "mine",
      knownFields: knownRecordFields(value),
      missingFields,
      ...(target === undefined ? {} : { target }),
      ...(readOptionalString(value.world_key) === undefined
        ? {}
        : { worldKey: readOptionalString(value.world_key) }),
    });
  }

  const worldKey = readOptionalString(value.world_key);
  const inventoryDelta = createInventoryDelta(collectedItemName, completedCount);
  return createTaskResultSummary({
    task_type: ExecutionTaskKind.Code,
    operation: "mine",
    ...(target === undefined ? {} : { target }),
    completed_count: completedCount,
    ...(inventoryDelta === undefined ? {} : { inventory_delta: inventoryDelta }),
    ...(worldKey === undefined ? {} : { world_key: worldKey }),
    details: { mined_count: minedCount },
  });
}

function readCollectSandboxSkillResult(
  value: Readonly<Record<string, unknown>>,
): TaskResultSummary {
  const completedCount = readCollectedCount(value.collected);
  if (!Array.isArray(value.collected)) {
    return createUnknownCompletionSkillSummary({
      skill: "collect",
      target: readOptionalString(value.item_name) ?? "all_items",
      knownFields: knownRecordFields(value),
      missingFields: ["collected"],
      ...(readOptionalString(value.world_key) === undefined
        ? {}
        : { worldKey: readOptionalString(value.world_key) }),
    });
  }
  const worldKey = readOptionalString(value.world_key);
  return createTaskResultSummary({
    task_type: ExecutionTaskKind.Code,
    operation: "collect",
    target: readOptionalString(value.item_name) ?? "all_items",
    completed_count: completedCount ?? 0,
    inventory_delta: value.collected.flatMap((item): TaskResultInventoryDelta[] => {
      const record = asRecord(item);
      if (record === null) {
        return [];
      }
      const itemName = readOptionalString(record.name);
      const count = readNumber(record.count);
      return itemName === undefined || count === undefined || count <= 0
        ? []
        : [{ item_name: itemName, count }];
    }),
    ...(worldKey === undefined ? {} : { world_key: worldKey }),
  });
}

function readEquipSandboxSkillResult(value: Readonly<Record<string, unknown>>): TaskResultSummary {
  const target = readOptionalString(value.item_name);
  const worldKey = readOptionalString(value.world_key);
  return createTaskResultSummary({
    task_type: ExecutionTaskKind.Code,
    operation: "equip",
    ...(target === undefined ? {} : { target }),
    completed_count: 1,
    ...(worldKey === undefined ? {} : { world_key: worldKey }),
  });
}

function readGoToSandboxSkillResult(value: Readonly<Record<string, unknown>>): TaskResultSummary {
  const worldKey = readOptionalString(value.world_key);
  const diagnostics = readStringArray(value.diagnostics);
  const totalSteps = readNumber(value.total_steps);
  return createTaskResultSummary({
    task_type: ExecutionTaskKind.Code,
    operation: "goTo",
    completed_count: 1,
    ...(worldKey === undefined ? {} : { world_key: worldKey }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    details: {
      ...(totalSteps === undefined ? {} : { total_steps: totalSteps }),
    },
  });
}
