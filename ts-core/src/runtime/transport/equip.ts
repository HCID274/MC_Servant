import {
  type EquipSkillExecutionResult,
  type EquipSkillParams,
  type ToolchainFailureCode,
  createEquipSkillExecutionResult,
} from "../../core-ports/skills.js";
import { matchesMinecraftItemName, normalizeMinecraftName } from "./naming.js";
import type { MineflayerInventoryPort } from "./types.js";

const EQUIP_TIMEOUT_MS = 5_000;

/** 执行 equip（装备） 技能的 Mineflayer（Minecraft 协议客户端） 适配器。 */
export async function executeMineflayerEquip(input: {
  readonly bot: MineflayerInventoryPort;
  readonly params: Readonly<EquipSkillParams>;
}): Promise<EquipSkillExecutionResult> {
  if (input.bot.inventory === undefined || typeof input.bot.inventory.items !== "function") {
    throw createEquipFailure(
      "runtime_equip_failed",
      "Mineflayer bot handle does not expose inventory for equip",
      input.params,
    );
  }
  if (typeof input.bot.equip !== "function") {
    throw createEquipFailure(
      "runtime_equip_failed",
      "Mineflayer bot handle does not expose equip",
      input.params,
    );
  }

  const normalizedItemName = normalizeMinecraftName(input.params.itemName);

  if (
    input.bot.heldItem !== undefined &&
    input.bot.heldItem !== null &&
    matchesMinecraftItemName(input.bot.heldItem, normalizedItemName)
  ) {
    return createEquipSkillExecutionResult(
      { ...input.params, itemName: normalizedItemName },
      { status: "already_equipped", total_steps: 0 },
    );
  }

  const item = input.bot.inventory
    .items()
    .find((candidate) => matchesMinecraftItemName(candidate, normalizedItemName));

  if (item === undefined) {
    throw createEquipFailure(
      "missing_item",
      `Mineflayer inventory does not contain ${normalizedItemName}`,
      { ...input.params, itemName: normalizedItemName },
    );
  }

  try {
    const equipResult = await runEquipWithTimeout(
      () => input.bot.equip?.(item, input.params.destination ?? "hand"),
      EQUIP_TIMEOUT_MS,
    );
    if (
      equipResult === "timeout" &&
      (input.bot.heldItem === undefined ||
        input.bot.heldItem === null ||
        !matchesMinecraftItemName(input.bot.heldItem, normalizedItemName))
    ) {
      throw new Error(`Mineflayer equip timed out after ${EQUIP_TIMEOUT_MS}ms`);
    }
  } catch (error) {
    throw createEquipFailure(
      "runtime_equip_failed",
      error instanceof Error ? error.message : String(error),
      { ...input.params, itemName: normalizedItemName },
    );
  }

  return createEquipSkillExecutionResult({ ...input.params, itemName: normalizedItemName });
}

async function runEquipWithTimeout(
  operation: () => Promise<void> | void | undefined,
  timeoutMs: number,
): Promise<"completed" | "timeout"> {
  return Promise.race([
    Promise.resolve(operation()).then(() => "completed" as const),
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs);
    }),
  ]);
}

function createEquipFailure(
  code: ToolchainFailureCode,
  message: string,
  params: Readonly<EquipSkillParams>,
): Error {
  return Object.assign(new Error(message), {
    error_code: code,
    details: {
      item_name: params.itemName,
      destination: params.destination ?? "hand",
    },
  });
}
