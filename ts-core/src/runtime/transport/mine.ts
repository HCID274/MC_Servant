import { Vec3 } from "vec3";
import {
  type MineSkillExecutionRequest,
  type MineSkillExecutionResult,
  type MineSkillTargetCandidate,
  createMineSkillExecutionResult,
} from "../../core-ports/skills.js";
import { stepToFoot } from "./foot-step.js";
import { executeMineRouteAction, isBotAtFoot } from "./mine-action-executor.js";
import { type MineBlockPos, type MineRouteTarget, planMineRoute } from "./mine-bfs.js";
import { type MineBlockFactReader, createMineBlockFactReader } from "./mine-block-facts.js";
import { type PlannedMineAction, planMineQueueWithDiagnostics } from "./mine-queue.js";
import { prepareHandForMineDig } from "./mine-tool-policy.js";
import type {
  MineflayerBlockHandle,
  MineflayerInventoryPort,
  MineflayerMiningPort,
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
  MineflayerPlacementPort,
  MineflayerVec3Like,
} from "./types.js";
import { canReadMineflayerBlockAt, readMineflayerBlockAt } from "./world-reader.js";

/** mine（挖掘） 技能需要的 Mineflayer（Minecraft 协议客户端） 能力端口。 */
export type MineflayerMinePort = MineflayerMovementPort &
  MineflayerMiningPort &
  MineflayerPlacementPort;
type MineflayerMineInventoryPort = MineflayerMinePort & MineflayerInventoryPort;

const MINE_SETTLE_MS = 250;
const MINE_DIG_TIMEOUT_MS = 10_000;
const MINE_LOOK_TIMEOUT_MS = 3_000;
const MINE_LEGACY_STEP_TIMEOUT_MS = 5_000;
const MINE_POLL_MS = 50;
const SCAN_RADIUS = 16;
const SCAN_COUNT = 32;
const POST_DIG_VERIFY_TIMEOUT_MS = 1_000;

/** 执行 mine（挖掘） 技能的 Mineflayer 适配器入口。 */
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

  input.pathfinder.stop?.();
  input.pathfinder.setGoal?.(null);

  const context: ExecutionContext = {
    bot: input.bot,
    params: input.params,
    facts,
    blockName,
    expectedDropName,
    inventoryBefore,
  };

  if (input.params.targets !== undefined) {
    return executeWithSuppliedTargets(context, input.params.targets);
  }
  return executeWithDynamicScan(context);
}

interface ExecutionContext {
  readonly bot: MineflayerMineInventoryPort;
  readonly params: Readonly<MineSkillExecutionRequest>;
  readonly facts: MineBlockFactReader;
  readonly blockName: string;
  readonly expectedDropName: string;
  readonly inventoryBefore: number;
}

/** 非 ore 路径：扫附近候选 → BFS 规划 → 逐动作执行 → 终挖 → 检查背包 → 不够再扫。 */
async function executeWithDynamicScan(ctx: ExecutionContext): Promise<MineSkillExecutionResult> {
  const diagnostics: string[] = [];
  let totalSteps = 0;
  let minedCount = 0;
  let collected = 0;
  let attempts = 0;
  let lastCollected = 0;
  let stagnantAttempts = 0;
  const maxAttempts = Math.min(Math.max(ctx.params.count + 4, 4), 64);
  const maxStagnant = 2;

  while (collected < ctx.params.count && attempts < maxAttempts) {
    attempts += 1;

    const candidates = scanNearbyTargets(ctx);
    diagnostics.push(`mine_scan_attempt:${attempts};candidates:${candidates.length}`);
    if (candidates.length === 0) {
      throw createMineUnsafePathError({
        blockName: ctx.blockName,
        requestedCount: ctx.params.count,
        targetDigCount: minedCount,
        diagnostics,
        position: ctx.bot.entity?.position,
        reason: "no_visible_target",
      });
    }

    const startFoot = readBotFoot(ctx.bot);
    const planResult = planMineRoute({
      bot: ctx.bot,
      facts: ctx.facts,
      blockName: ctx.blockName,
      startFoot,
      targets: candidates,
    });
    diagnostics.push(...planResult.diagnostics);
    if (planResult.plan === null) {
      throw createMineUnsafePathError({
        blockName: ctx.blockName,
        requestedCount: ctx.params.count,
        targetDigCount: minedCount,
        diagnostics,
        position: ctx.bot.entity?.position,
        reason: "no_safe_route",
      });
    }
    diagnostics.push(
      `mine_plan_actions:${planResult.plan.actions.length};cost:${planResult.plan.cost}`,
    );

    try {
      for (const action of planResult.plan.actions) {
        const targetDigs = countTargetDigsInAction(ctx, action);
        await executeMineRouteAction({
          bot: ctx.bot,
          facts: ctx.facts,
          action,
          diagnostics,
        });
        minedCount += targetDigs;
        totalSteps += 1;
      }
      if (!isBotAtFoot(ctx.bot, planResult.plan.finalFoot)) {
        throw new Error(`mine_final_foot_mismatch:${posLabel(planResult.plan.finalFoot)}`);
      }
      const minedThisRound = await digFinalTarget(ctx, planResult.plan.target, diagnostics);
      if (minedThisRound) {
        minedCount += 1;
        totalSteps += 1;
      }
    } catch (error) {
      throw createMineExecutionStepError({
        cause: error,
        blockName: ctx.blockName,
        requestedCount: ctx.params.count,
        diagnostics,
        position: ctx.bot.entity?.position,
      });
    }

    collected = inventoryDiff(ctx);
    if (collected === lastCollected) {
      stagnantAttempts += 1;
      if (stagnantAttempts >= maxStagnant) {
        diagnostics.push(`mine_stagnant_break:attempts=${attempts}`);
        break;
      }
    } else {
      stagnantAttempts = 0;
      lastCollected = collected;
    }
  }

  if (MINE_SETTLE_MS > 0) await delay(MINE_SETTLE_MS);
  collected = inventoryDiff(ctx);

  if (collected < ctx.params.count) {
    throw createMineDropNotObtainedError({
      expectedDropName: ctx.expectedDropName,
      collectedCount: collected,
      requestedCount: ctx.params.count,
      blockName: ctx.blockName,
      diagnostics,
      position: ctx.bot.entity?.position,
    });
  }

  return createMineSkillExecutionResult(ctx.params, {
    world_key: ctx.params.worldKey ?? null,
    collected_item_name: ctx.expectedDropName,
    collected_count: collected,
    mined_count: minedCount,
    diagnostics,
    total_steps: totalSteps,
  });
}

/** ore 路径：保留 HEAD 的 targeted BFS 队列执行模型，不动。 */
async function executeWithSuppliedTargets(
  ctx: ExecutionContext,
  targets: readonly MineSkillTargetCandidate[],
): Promise<MineSkillExecutionResult> {
  const diagnostics: string[] = [];
  let minedCount = 0;
  let totalSteps = 0;

  const plan = planMineQueueWithDiagnostics({
    bot: ctx.bot,
    facts: ctx.facts,
    blockName: ctx.blockName,
    requiredTargetCount: ctx.params.count,
    targets,
  });
  const queue = plan.queue;
  if (queue === null || queue.targetDigCount < ctx.params.count) {
    throw createMineUnsafePathError({
      blockName: ctx.blockName,
      requestedCount: ctx.params.count,
      targetDigCount: queue?.targetDigCount ?? 0,
      diagnostics: plan.diagnostics,
      position: ctx.bot.entity?.position,
    });
  }

  for (const action of queue.actions) {
    if (action.kind === "move") {
      if (isBotAtFoot(ctx.bot, action.pos)) continue;
      await legacyMoveWithinMinedStair(ctx.bot, action.pos, diagnostics);
      totalSteps += 1;
      continue;
    }

    const standingPos = action.standingPos;
    if (standingPos !== undefined && !isBotAtFoot(ctx.bot, standingPos)) {
      await legacyMoveWithinMinedStair(ctx.bot, standingPos, diagnostics);
      totalSteps += 1;
    }

    const block = readMineflayerBlockAt(ctx.bot, action.pos);
    if (block === null || block === undefined || ctx.facts.normalizeName(block.name) === "air") {
      continue;
    }

    const currentBlockName = ctx.facts.normalizeName(block.name);
    await prepareHandForMineDig({
      bot: ctx.bot,
      facts: ctx.facts,
      blockName: currentBlockName,
      diagnostics,
      withTimeout: legacyTimeout,
    });
    await legacyTimeout(
      Promise.resolve(ctx.bot.lookAt?.(centerOfBlock(action.pos), true)),
      MINE_LOOK_TIMEOUT_MS,
      `mine_look_timeout:${currentBlockName}:${posLabel(action.pos)}`,
    );
    await legacyTimeout(
      Promise.resolve(ctx.bot.dig?.(block)),
      MINE_DIG_TIMEOUT_MS,
      `mine_dig_timeout:${currentBlockName}:${posLabel(action.pos)}`,
    );
    await delay(120);
    if (currentBlockName === ctx.blockName) {
      minedCount += 1;
    }
    totalSteps += 1;
  }

  await legacySweepDrops({
    bot: ctx.bot,
    targetActions: queue.actions.filter(
      (action) => action.kind === "dig" && action.countsTowardTarget === true,
    ),
    expectedDropName: ctx.expectedDropName,
    inventoryBefore: ctx.inventoryBefore,
    requiredCount: ctx.params.count,
    diagnostics,
    normalizeName: ctx.facts.normalizeName,
  });

  diagnostics.push(`stair_bfs_phase:${queue.phase}`);
  if (MINE_SETTLE_MS > 0) await delay(MINE_SETTLE_MS);
  const collected = Math.max(
    0,
    countInventoryItem(ctx.bot, ctx.expectedDropName, ctx.facts.normalizeName) -
      ctx.inventoryBefore,
  );
  if (collected < ctx.params.count) {
    throw createMineDropNotObtainedError({
      expectedDropName: ctx.expectedDropName,
      collectedCount: collected,
      requestedCount: ctx.params.count,
      blockName: ctx.blockName,
      diagnostics,
      position: ctx.bot.entity?.position,
    });
  }

  return createMineSkillExecutionResult(ctx.params, {
    world_key: ctx.params.worldKey ?? null,
    collected_item_name: ctx.expectedDropName,
    collected_count: collected,
    mined_count: minedCount,
    diagnostics,
    total_steps: totalSteps,
  });
}

function scanNearbyTargets(ctx: ExecutionContext): readonly MineRouteTarget[] {
  if (typeof ctx.bot.findBlocks !== "function") return [];
  const matcher = (block: { readonly name?: string; readonly diggable?: boolean }): boolean =>
    block.diggable !== false && ctx.facts.normalizeName(block.name) === ctx.blockName;
  let positions: readonly MineflayerVec3Like[];
  try {
    const result = ctx.bot.findBlocks({
      matching: matcher,
      maxDistance: SCAN_RADIUS,
      count: SCAN_COUNT,
    });
    positions = Array.isArray(result) ? (result as readonly MineflayerVec3Like[]) : [];
  } catch {
    return [];
  }

  const targets: MineRouteTarget[] = [];
  const seen = new Set<string>();
  for (const position of positions) {
    const pos: MineBlockPos = {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
    };
    const key = `${pos.x}:${pos.y}:${pos.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const block = readMineflayerBlockAt(ctx.bot, pos);
    if (block === null || block === undefined) continue;
    if (block.diggable === false) continue;
    if (ctx.facts.normalizeName(block.name) !== ctx.blockName) continue;
    targets.push({ position: pos, blockName: ctx.blockName });
  }
  return Object.freeze(targets);
}

function countTargetDigsInAction(
  ctx: ExecutionContext,
  action: import("./mine-bfs.js").MineRouteAction,
): number {
  if (!("digs" in action)) return 0;
  let count = 0;
  for (const dig of action.digs) {
    const block = readMineflayerBlockAt(ctx.bot, dig);
    if (block === null || block === undefined) continue;
    if (ctx.facts.normalizeName(block.name) === ctx.blockName) count += 1;
  }
  return count;
}

async function digFinalTarget(
  ctx: ExecutionContext,
  pos: MineBlockPos,
  diagnostics: string[],
): Promise<boolean> {
  const block = readMineflayerBlockAt(ctx.bot, pos);
  if (block === null || block === undefined) return false;
  if (ctx.facts.normalizeName(block.name) !== ctx.blockName) return false;
  if (typeof ctx.bot.canDigBlock === "function" && !ctx.bot.canDigBlock(block)) {
    throw new Error(`mine_dig_out_of_reach:${ctx.blockName}:${posLabel(pos)}`);
  }

  await prepareHandForMineDig({
    bot: ctx.bot,
    facts: ctx.facts,
    blockName: ctx.blockName,
    diagnostics,
    withTimeout: legacyTimeout,
  });
  await legacyTimeout(
    Promise.resolve(ctx.bot.lookAt?.(centerOfBlock(pos), true)),
    MINE_LOOK_TIMEOUT_MS,
    `mine_look_timeout:final:${posLabel(pos)}`,
  );
  await legacyTimeout(
    Promise.resolve(ctx.bot.dig?.(block)),
    MINE_DIG_TIMEOUT_MS,
    `mine_dig_timeout:final:${posLabel(pos)}`,
  );
  await waitUntilBlockChanged(ctx.bot, ctx.facts, pos, ctx.blockName);
  diagnostics.push(`mine_final_dig_verified:${ctx.blockName}:${posLabel(pos)}`);
  return true;
}

function inventoryDiff(ctx: ExecutionContext): number {
  return Math.max(
    0,
    countInventoryItem(ctx.bot, ctx.expectedDropName, ctx.facts.normalizeName) -
      ctx.inventoryBefore,
  );
}

function readBotFoot(bot: MineflayerMineInventoryPort): MineBlockPos {
  const position = bot.entity?.position ?? { x: 0, y: 0, z: 0 };
  return Object.freeze({
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
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

async function legacySweepDrops(input: {
  readonly bot: MineflayerMineInventoryPort;
  readonly targetActions: readonly PlannedMineAction[];
  readonly expectedDropName: string;
  readonly inventoryBefore: number;
  readonly requiredCount: number;
  readonly diagnostics: string[];
  readonly normalizeName: (value: string | undefined) => string;
}): Promise<void> {
  for (const action of input.targetActions) {
    const collected = Math.max(
      0,
      countInventoryItem(input.bot, input.expectedDropName, input.normalizeName) -
        input.inventoryBefore,
    );
    if (collected >= input.requiredCount) return;

    const pickupPos = action.standingPos ?? action.pos;
    if (isBotAtFoot(input.bot, pickupPos)) {
      await delay(150);
      continue;
    }

    try {
      await legacyMoveWithinMinedStair(input.bot, pickupPos, input.diagnostics);
      await delay(150);
    } catch (error) {
      input.diagnostics.push(`pickup_sweep_failed:${getErrorMessage(error)}`);
    }
  }
}

async function legacyMoveWithinMinedStair(
  bot: MineflayerMineInventoryPort,
  target: { readonly x: number; readonly y: number; readonly z: number },
  diagnostics: string[],
): Promise<void> {
  if (isBotAtFoot(bot, target)) return;

  const startY = bot.entity?.position?.y ?? target.y;
  await stepToFoot({
    bot,
    target,
    jump: target.y > startY + 0.25,
    timeoutMs: MINE_LEGACY_STEP_TIMEOUT_MS,
    lookTimeoutMs: MINE_LOOK_TIMEOUT_MS,
    diagnosticPrefix: "mine",
    actionKind: "legacyMove",
    diagnostics,
  });
}

function centerOfBlock(pos: { readonly x: number; readonly y: number; readonly z: number }): Vec3 {
  return new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
}

function posLabel(pos: { readonly x: number; readonly y: number; readonly z: number }): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

async function waitUntilBlockChanged(
  bot: MineflayerMineInventoryPort,
  facts: MineBlockFactReader,
  pos: MineBlockPos,
  originalName: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= POST_DIG_VERIFY_TIMEOUT_MS) {
    const current = readMineflayerBlockAt(bot, pos);
    if (isBlockChanged(facts, current, originalName)) {
      await delay(150);
      return;
    }
    await delay(MINE_POLL_MS);
  }
  throw new Error(`mine_dig_no_effect:${originalName}:${posLabel(pos)}`);
}

function isBlockChanged(
  facts: MineBlockFactReader,
  block: MineflayerBlockHandle | null | undefined,
  originalName: string,
): boolean {
  if (block === null || block === undefined) return true;
  const currentName = facts.normalizeName(block.name);
  return (
    currentName === "air" ||
    currentName === "cave_air" ||
    currentName === "void_air" ||
    currentName !== originalName
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function legacyTimeout<TValue>(
  action: Promise<TValue>,
  timeoutMs: number,
  message: string,
): Promise<TValue> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([action, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createMineDropNotObtainedError(input: {
  readonly expectedDropName: string;
  readonly collectedCount: number;
  readonly requestedCount: number;
  readonly blockName: string;
  readonly diagnostics: readonly string[];
  readonly position: { readonly x: number; readonly y: number; readonly z: number } | undefined;
}): Error {
  return Object.assign(
    new Error(
      `drop_not_obtained:${input.expectedDropName}:${input.collectedCount}/${input.requestedCount}:planned queue completed without enough inventory diff`,
    ),
    {
      error_code: "drop_not_obtained",
      details: {
        failure_stage: "mine",
        block_name: input.blockName,
        expected_drop_name: input.expectedDropName,
        requested_count: input.requestedCount,
        collected_count: input.collectedCount,
        ...(input.position === undefined
          ? {}
          : {
              current_position: {
                x: input.position.x,
                y: input.position.y,
                z: input.position.z,
              },
            }),
        diagnostics: input.diagnostics,
      },
    },
  );
}

function createMineExecutionStepError(input: {
  readonly cause: unknown;
  readonly blockName: string;
  readonly requestedCount: number;
  readonly diagnostics: readonly string[];
  readonly position: { readonly x: number; readonly y: number; readonly z: number } | undefined;
}): Error {
  const message = getErrorMessage(input.cause);
  return Object.assign(new Error(message), {
    error_code: message.split(":")[0] ?? "mine_execution_failed",
    details: {
      failure_stage: "mine",
      block_name: input.blockName,
      requested_count: input.requestedCount,
      ...(input.position === undefined
        ? {}
        : {
            current_position: {
              x: input.position.x,
              y: input.position.y,
              z: input.position.z,
            },
          }),
      diagnostics: input.diagnostics,
    },
  });
}

function createMineUnsafePathError(input: {
  readonly blockName: string;
  readonly requestedCount: number;
  readonly targetDigCount: number;
  readonly diagnostics: readonly string[];
  readonly position: { readonly x: number; readonly y: number; readonly z: number } | undefined;
  readonly reason?: string;
}): Error {
  const reason = input.reason ?? "no_safe_route";
  return Object.assign(new Error(`unsafe_path:${input.blockName}:${reason}`), {
    error_code: "unsafe_path",
    details: {
      block_name: input.blockName,
      requested_count: input.requestedCount,
      planned_target_dig_count: input.targetDigCount,
      reason,
      ...(input.position === undefined
        ? {}
        : {
            current_position: {
              x: input.position.x,
              y: input.position.y,
              z: input.position.z,
            },
          }),
      diagnostics: input.diagnostics,
    },
  });
}
