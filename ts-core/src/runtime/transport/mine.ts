import { Vec3 } from "vec3";
import {
  type MineSkillExecutionRequest,
  type MineSkillExecutionResult,
  createMineSkillExecutionResult,
} from "../../core-ports/skills.js";
import type { StairBFSBlockPos } from "../../domain/stair-bfs-planner.js";
import { createMineBlockFactReader } from "./mine-block-facts.js";
import type { PlannedMineAction } from "./mine-queue.js";
import { planMineQueue } from "./mine-queue.js";
import { prepareHandForMineDig } from "./mine-tool-policy.js";
import type {
  MineflayerControlState,
  MineflayerInventoryPort,
  MineflayerMiningPort,
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
  MineflayerPlacementPort,
} from "./types.js";
import { canReadMineflayerBlockAt, readMineflayerBlockAt } from "./world-reader.js";

/** mine（挖掘） 技能需要的 Mineflayer（Minecraft 协议客户端） 能力端口。 */
export type MineflayerMinePort = MineflayerMovementPort &
  MineflayerMiningPort &
  MineflayerPlacementPort;
type MineflayerMineInventoryPort = MineflayerMinePort & MineflayerInventoryPort;

const MINE_SETTLE_MS = 250;
const MINE_STEP_TIMEOUT_MS = 5_000;
const MINE_DIG_TIMEOUT_MS = 10_000;
const MINE_LOOK_TIMEOUT_MS = 3_000;
const MINE_MAX_NO_PROGRESS_ATTEMPTS = 2;
const MINE_STEP_POLL_MS = 50;

/** 执行 mine（挖掘） 技能的 Mineflayer（Minecraft 协议客户端） 适配器。 */
export async function executeMineflayerMine(input: {
  readonly bot: MineflayerMineInventoryPort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly params: Readonly<MineSkillExecutionRequest>;
}): Promise<MineSkillExecutionResult> {
  assertMineflayerMinePort(input.bot);

  const facts = createMineBlockFactReader(input.bot.registry);
  const blockName = facts.normalizeName(input.params.blockName);
  const expectedDropName = facts.resolveExpectedDropName(blockName);
  const inventoryBefore = countInventoryItem(input.bot, expectedDropName, facts.normalizeName);
  const diagnostics: string[] = [];
  let minedCount = 0;
  let collectedCount = 0;
  let totalSteps = 0;

  input.pathfinder.stop?.();
  input.pathfinder.setGoal?.(null);

  const queue = planMineQueue({
    bot: input.bot,
    facts,
    blockName,
    requiredTargetCount: input.params.count,
    ...(input.params.targets === undefined ? {} : { targets: input.params.targets }),
  });
  if (queue === null || queue.targetDigCount < input.params.count) {
    throw new Error(`unsafe_path:${blockName}:no_safe_route`);
  }

  for (const action of queue.actions) {
    if (action.kind === "move") {
      if (isBotAtMineFoot(input.bot, action.pos)) {
        continue;
      }
      await moveWithinMinedStair(input.bot, action.pos);
      totalSteps += 1;
      continue;
    }

    const standingPos = action.standingPos;
    if (standingPos !== undefined && !isBotAtMineFoot(input.bot, standingPos)) {
      await moveWithinMinedStair(input.bot, standingPos);
      totalSteps += 1;
    }

    const block = readMineflayerBlockAt(input.bot, action.pos);
    if (block === null || block === undefined || facts.normalizeName(block.name) === "air") {
      continue;
    }

    const currentBlockName = facts.normalizeName(block.name);
    await prepareHandForMineDig({
      bot: input.bot,
      facts,
      blockName: currentBlockName,
      diagnostics,
      withTimeout: withMineActionTimeout,
    });
    await withMineActionTimeout(
      Promise.resolve(input.bot.lookAt?.(centerOfBlock(action.pos), true)),
      MINE_LOOK_TIMEOUT_MS,
      `mine_look_timeout:${currentBlockName}:${positionLabel(action.pos)}`,
    );
    await withMineActionTimeout(
      Promise.resolve(input.bot.dig?.(block)),
      MINE_DIG_TIMEOUT_MS,
      `mine_dig_timeout:${currentBlockName}:${positionLabel(action.pos)}`,
    );
    await delay(120);
    if (currentBlockName === blockName) {
      minedCount += 1;
    }
    totalSteps += 1;
  }

  await sweepMinedTargetDrops({
    bot: input.bot,
    targetActions: queue.actions.filter(
      (action) => action.kind === "dig" && action.countsTowardTarget === true,
    ),
    expectedDropName,
    inventoryBefore,
    requiredCount: input.params.count,
    diagnostics,
    normalizeName: facts.normalizeName,
  });

  diagnostics.push(`stair_bfs_phase:${queue.phase}`);
  if (MINE_SETTLE_MS > 0) {
    await delay(MINE_SETTLE_MS);
  }
  collectedCount = Math.max(
    0,
    countInventoryItem(input.bot, expectedDropName, facts.normalizeName) - inventoryBefore,
  );
  if (collectedCount < input.params.count) {
    throw new Error(
      `drop_not_obtained:${expectedDropName}:${collectedCount}/${input.params.count}:planned queue completed without enough inventory diff`,
    );
  }

  return createMineSkillExecutionResult(input.params, {
    world_key: input.params.worldKey ?? null,
    collected_item_name: expectedDropName,
    collected_count: collectedCount,
    mined_count: minedCount,
    diagnostics,
    total_steps: totalSteps,
  });
}

function assertMineflayerMinePort(bot: MineflayerMineInventoryPort): void {
  if (!canReadMineflayerBlockAt(bot)) {
    throw new Error("Mineflayer bot handle does not expose blockAt for mine");
  }
  if (typeof bot.dig !== "function") {
    throw new Error("Mineflayer bot handle does not expose dig for mine");
  }
}

function countInventoryItem(
  bot: MineflayerMineInventoryPort,
  itemName: string,
  normalizeName: (value: string | undefined) => string,
): number {
  return (bot.inventory?.items() ?? []).reduce(
    (sum, item) => (normalizeName(item.name) === itemName ? sum + (item.count ?? 1) : sum),
    0,
  );
}

async function sweepMinedTargetDrops(input: {
  readonly bot: MineflayerMineInventoryPort;
  readonly targetActions: readonly PlannedMineAction[];
  readonly expectedDropName: string;
  readonly inventoryBefore: number;
  readonly requiredCount: number;
  readonly diagnostics: string[];
  readonly normalizeName: (value: string | undefined) => string;
}): Promise<void> {
  for (const action of input.targetActions) {
    const collectedCount = Math.max(
      0,
      countInventoryItem(input.bot, input.expectedDropName, input.normalizeName) -
        input.inventoryBefore,
    );
    if (collectedCount >= input.requiredCount) {
      return;
    }

    const pickupPos = action.standingPos ?? action.pos;
    if (isBotAtMineFoot(input.bot, pickupPos)) {
      await delay(150);
      continue;
    }

    try {
      await moveWithinMinedStair(input.bot, pickupPos);
      await delay(150);
    } catch (error) {
      input.diagnostics.push(`pickup_sweep_failed:${getErrorMessage(error)}`);
    }
  }
}

async function moveWithinMinedStair(
  bot: MineflayerMineInventoryPort,
  target: StairBFSBlockPos,
): Promise<void> {
  if (isBotAtMineFoot(bot, target)) {
    return;
  }
  if (typeof bot.setControlState !== "function") {
    throw new Error("mine_control_unavailable:setControlState");
  }

  const startedAt = Date.now();
  const controls: MineflayerControlState[] = ["forward"];
  const startY = bot.entity?.position?.y ?? target.y;
  if (target.y > startY + 0.25) {
    controls.push("jump");
  }

  try {
    await withMineActionTimeout(
      Promise.resolve(bot.lookAt?.(centerOfFootTarget(target), true)),
      MINE_LOOK_TIMEOUT_MS,
      `mine_look_timeout:move:${positionLabel(target)}`,
    );

    for (const control of controls) {
      bot.setControlState(control, true);
    }

    while (!isBotAtMineFoot(bot, target)) {
      if (Date.now() - startedAt >= MINE_STEP_TIMEOUT_MS) {
        throw new Error(`mine_step_timeout:${positionLabel(target)}`);
      }
      await delay(MINE_STEP_POLL_MS);
    }
  } finally {
    for (const control of controls) {
      bot.setControlState(control, false);
    }
    bot.clearControlStates?.();
  }
}

function isBotAtMineFoot(bot: MineflayerMineInventoryPort, target: StairBFSBlockPos): boolean {
  const position = bot.entity?.position;
  if (position === undefined) {
    return false;
  }

  return (
    Math.hypot(position.x - (target.x + 0.5), position.z - (target.z + 0.5)) <= 0.8 &&
    Math.abs(position.y - target.y) <= 0.75
  );
}

function centerOfBlock(pos: Readonly<StairBFSBlockPos>): Vec3 {
  return new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
}

function centerOfFootTarget(pos: Readonly<StairBFSBlockPos>): Vec3 {
  return new Vec3(pos.x + 0.5, pos.y + 1, pos.z + 0.5);
}

function positionLabel(pos: Readonly<StairBFSBlockPos>): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withMineActionTimeout<TValue>(
  action: Promise<TValue>,
  timeoutMs: number,
  timeoutMessage: string,
  onTimeout?: () => void,
): Promise<TValue> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([action, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
