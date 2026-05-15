import type { MineBlockFactReader } from "./block-facts.js";
import type { MineflayerInventoryPort } from "./types.js";

const MINE_HAND_TIMEOUT_MS = 5_000;

/** mine（挖掘） 执行前的工具准备策略；是否需要工具只读 registry（注册表） 事实。 */
export async function prepareHandForMineDig(input: {
  readonly bot: MineflayerInventoryPort;
  readonly facts: MineBlockFactReader;
  readonly blockName: string;
  readonly diagnostics: string[];
  readonly withTimeout: <TValue>(
    action: Promise<TValue>,
    timeoutMs: number,
    timeoutMessage: string,
  ) => Promise<TValue>;
}): Promise<void> {
  const requiredToolIds = input.facts.readRequiredHarvestToolIds(input.blockName);
  if (requiredToolIds.length > 0) {
    await equipHarvestTool(input);
    return;
  }

  await emptyHand(input);
}

async function equipHarvestTool(input: {
  readonly bot: MineflayerInventoryPort;
  readonly facts: MineBlockFactReader;
  readonly blockName: string;
  readonly diagnostics: string[];
  readonly withTimeout: <TValue>(
    action: Promise<TValue>,
    timeoutMs: number,
    timeoutMessage: string,
  ) => Promise<TValue>;
}): Promise<void> {
  const held = input.bot.heldItem;
  if (
    held !== null &&
    held !== undefined &&
    input.facts.isInventoryItemAllowedForBlock(held, input.blockName)
  ) {
    return;
  }

  const tool = input.bot.inventory
    ?.items()
    .find((item) => input.facts.isInventoryItemAllowedForBlock(item, input.blockName));
  if (tool === undefined || typeof input.bot.equip !== "function") {
    throw new Error(`not_equipped:${input.blockName}:requires_harvest_tool`);
  }

  await input.withTimeout(
    Promise.resolve(input.bot.equip(tool, "hand")),
    MINE_HAND_TIMEOUT_MS,
    `mine_equip_timeout:harvest_tool:${input.blockName}`,
  );
  input.diagnostics.push(`tool_policy:harvest_tool:${input.blockName}`);
}

async function emptyHand(input: {
  readonly bot: MineflayerInventoryPort;
  readonly blockName: string;
  readonly diagnostics: string[];
  readonly withTimeout: <TValue>(
    action: Promise<TValue>,
    timeoutMs: number,
    timeoutMessage: string,
  ) => Promise<TValue>;
}): Promise<void> {
  if (input.bot.heldItem === null || input.bot.heldItem === undefined) {
    return;
  }
  if (typeof input.bot.unequip !== "function") {
    input.diagnostics.push(`tool_policy:empty_hand_unavailable:${input.blockName}`);
    return;
  }

  await input.withTimeout(
    Promise.resolve(input.bot.unequip("hand")),
    MINE_HAND_TIMEOUT_MS,
    `mine_unequip_timeout:empty_hand:${input.blockName}`,
  );
  input.diagnostics.push(`tool_policy:empty_hand:${input.blockName}`);
}
