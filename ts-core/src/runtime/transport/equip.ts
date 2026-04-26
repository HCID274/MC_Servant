import {
  type EquipSkillExecutionResult,
  type EquipSkillParams,
  createEquipSkillExecutionResult,
} from "../../core-ports/skills.js";
import { matchesMinecraftItemName } from "./naming.js";
import type { MineflayerInventoryPort } from "./types.js";

/** 执行 equip（装备） 技能的 Mineflayer（Minecraft 协议客户端） 适配器。 */
export async function executeMineflayerEquip(input: {
  readonly bot: MineflayerInventoryPort;
  readonly params: Readonly<EquipSkillParams>;
}): Promise<EquipSkillExecutionResult> {
  if (input.bot.inventory === undefined || typeof input.bot.inventory.items !== "function") {
    throw new Error("Mineflayer bot handle does not expose inventory for equip");
  }
  if (typeof input.bot.equip !== "function") {
    throw new Error("Mineflayer bot handle does not expose equip");
  }

  const item = input.bot.inventory
    .items()
    .find((candidate) => matchesMinecraftItemName(candidate, input.params.itemName));

  if (item === undefined) {
    throw new Error(`Mineflayer inventory does not contain ${input.params.itemName}`);
  }

  await input.bot.equip(item, input.params.destination ?? "hand");
  return createEquipSkillExecutionResult(input.params);
}
