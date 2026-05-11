import { Vec3 } from "vec3";
import {
  type MineSkillExecutionRequest,
  type MineSkillExecutionResult,
  type MineSkillTargetCandidate,
  type SkillExecutionControl,
  createMineSkillExecutionResult,
} from "../../core-ports/skills.js";
import { executeMineRouteAction, isBotAtFoot } from "./mine-action-executor.js";
import {
  type MineBlockPos,
  type MineRouteAction,
  type MineRouteTarget,
  planMineRoute,
} from "./mine-bfs.js";
import { type MineBlockFactReader, createMineBlockFactReader } from "./mine-block-facts.js";
import { prepareHandForMineDig } from "./mine-tool-policy.js";
import { waitForPromiseOrCondition } from "./progress-watchdog.js";
import { navigateTerrainToFoot } from "./terrain-navigation.js";
import type { TerrainRouteBudget } from "./terrain-router.js";
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
const MINE_DIG_IDLE_TIMEOUT_MS = 15_000;
const MINE_LOOK_TIMEOUT_MS = 3_000;
const MINE_POLL_MS = 50;
const SCAN_RADIUS = 16;
const SCAN_COUNT = 32;
const POST_DIG_VERIFY_TIMEOUT_MS = 1_000;
const MINE_DYNAMIC_FALLBACK_APPROACH_LIMIT = 8;
const MINE_SUPPLIED_FALLBACK_APPROACH_LIMIT = 16;
const MINE_DYNAMIC_FALLBACK_ROUTE_BUDGET: TerrainRouteBudget = Object.freeze({
  maxTotalExpandedStates: 24_000,
  maxPlanningMs: 400,
  phaseNoProgressStepLimits: Object.freeze({
    natural: 2,
    light_dig: 3,
    light_place: 3,
    relaxed: 4,
  }),
});
const MINE_SUPPLIED_FALLBACK_ROUTE_BUDGET: TerrainRouteBudget = Object.freeze({
  maxTotalExpandedStates: 32_000,
  maxPlanningMs: 400,
  phaseNoProgressStepLimits: Object.freeze({
    natural: 3,
    light_dig: 5,
    light_place: 5,
    relaxed: 8,
  }),
});

/** 执行 mine（挖掘） 技能的 Mineflayer 适配器入口。 */
export async function executeMineflayerMine(input: {
  readonly bot: MineflayerMineInventoryPort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly params: Readonly<MineSkillExecutionRequest>;
  readonly control: SkillExecutionControl;
}): Promise<MineSkillExecutionResult> {
  input.control.throwIfAborted();
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
    control: input.control,
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
  readonly control: SkillExecutionControl;
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
    ctx.control.throwIfAborted();
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
      const fallbackSteps = await navigateTowardMineTargets({
        ctx,
        targets: candidates,
        diagnostics,
        diagnosticPrefix: "mine_dynamic_fallback",
        maxApproachFeet: MINE_DYNAMIC_FALLBACK_APPROACH_LIMIT,
        routeBudget: MINE_DYNAMIC_FALLBACK_ROUTE_BUDGET,
      });
      if (fallbackSteps <= 0) {
        throw createMineUnsafePathError({
          blockName: ctx.blockName,
          requestedCount: ctx.params.count,
          targetDigCount: minedCount,
          diagnostics,
          position: ctx.bot.entity?.position,
          reason: "no_safe_route",
        });
      }
      totalSteps += fallbackSteps;
      diagnostics.push(`mine_dynamic_fallback_steps:${fallbackSteps}`);
      continue;
    }
    diagnostics.push(
      `mine_plan_actions:${planResult.plan.actions.length};cost:${planResult.plan.cost}`,
    );

    try {
      for (const action of planResult.plan.actions) {
        ctx.control.throwIfAborted();
        const targetDigs = countTargetDigsInAction(ctx, action);
        await executeMineRouteAction({
          bot: ctx.bot,
          facts: ctx.facts,
          action,
          diagnostics,
          control: ctx.control,
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

/** supplied target 路径：资源簇目标也统一走自研 mine-bfs，禁止回退旧队列规划。 */
async function executeWithSuppliedTargets(
  ctx: ExecutionContext,
  targets: readonly MineSkillTargetCandidate[],
): Promise<MineSkillExecutionResult> {
  const diagnostics: string[] = [];
  let minedCount = 0;
  let totalSteps = 0;
  let collected = 0;
  let attempts = 0;
  const maxAttempts = Math.min(Math.max(ctx.params.count + targets.length, 4), 64);

  while (collected < ctx.params.count && attempts < maxAttempts) {
    ctx.control.throwIfAborted();
    attempts += 1;
    const candidates = readRemainingSuppliedTargets(ctx, targets);
    diagnostics.push(`mine_supplied_target_attempt:${attempts};candidates:${candidates.length}`);
    if (candidates.length === 0) {
      throw createMineUnsafePathError({
        blockName: ctx.blockName,
        requestedCount: ctx.params.count,
        targetDigCount: minedCount,
        diagnostics,
        position: ctx.bot.entity?.position,
        reason: minedCount > 0 ? "targets_exhausted" : "no_visible_target",
      });
    }

    const planResult = planMineRoute({
      bot: ctx.bot,
      facts: ctx.facts,
      blockName: ctx.blockName,
      startFoot: readBotFoot(ctx.bot),
      targets: candidates,
    });
    diagnostics.push(...planResult.diagnostics.map((entry) => `supplied:${entry}`));
    if (planResult.plan === null) {
      const fallbackSteps = await navigateTowardMineTargets({
        ctx,
        targets: candidates,
        diagnostics,
        diagnosticPrefix: "mine_supplied_fallback",
        maxApproachFeet: MINE_SUPPLIED_FALLBACK_APPROACH_LIMIT,
        routeBudget: MINE_SUPPLIED_FALLBACK_ROUTE_BUDGET,
      });
      if (fallbackSteps <= 0) {
        throw createMineUnsafePathError({
          blockName: ctx.blockName,
          requestedCount: ctx.params.count,
          targetDigCount: minedCount,
          diagnostics,
          position: ctx.bot.entity?.position,
          reason: "no_safe_route",
        });
      }
      totalSteps += fallbackSteps;
      diagnostics.push(`mine_supplied_fallback_steps:${fallbackSteps}`);
      continue;
    }
    diagnostics.push(
      `mine_supplied_plan_actions:${planResult.plan.actions.length};cost:${planResult.plan.cost}`,
    );

    try {
      for (const action of planResult.plan.actions) {
        ctx.control.throwIfAborted();
        const targetDigs = countTargetDigsInAction(ctx, action);
        await executeMineRouteAction({
          bot: ctx.bot,
          facts: ctx.facts,
          action,
          diagnostics,
          control: ctx.control,
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

    if (MINE_SETTLE_MS > 0) await delay(MINE_SETTLE_MS);
    collected = inventoryDiff(ctx);
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

function countTargetDigsInAction(ctx: ExecutionContext, action: MineRouteAction): number {
  if (!("digs" in action)) return 0;
  let count = 0;
  for (const dig of action.digs) {
    const block = readMineflayerBlockAt(ctx.bot, dig);
    if (block === null || block === undefined) continue;
    if (ctx.facts.normalizeName(block.name) === ctx.blockName) count += 1;
  }
  return count;
}

function readRemainingSuppliedTargets(
  ctx: ExecutionContext,
  targets: readonly MineSkillTargetCandidate[],
): readonly MineRouteTarget[] {
  const out: MineRouteTarget[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (ctx.facts.normalizeName(target.block_name) !== ctx.blockName) continue;
    const pos: MineBlockPos = freezeMinePos(target.position);
    const key = posLabel(pos);
    if (seen.has(key)) continue;
    seen.add(key);
    const block = readMineflayerBlockAt(ctx.bot, pos);
    if (block === null || block === undefined) continue;
    if (!ctx.facts.isDiggableBlock(block)) continue;
    if (ctx.facts.normalizeName(block.name) !== ctx.blockName) continue;
    out.push(Object.freeze({ position: pos, blockName: ctx.blockName }));
  }
  return Object.freeze(out);
}

async function navigateTowardMineTargets(input: {
  readonly ctx: ExecutionContext;
  readonly targets: readonly MineRouteTarget[];
  readonly diagnostics: string[];
  readonly diagnosticPrefix: string;
  readonly maxApproachFeet?: number;
  readonly routeBudget?: TerrainRouteBudget;
}): Promise<number> {
  const { ctx, targets, diagnostics, diagnosticPrefix } = input;
  const startFoot = readBotFoot(ctx.bot);
  const allApproachFeet = createMineTargetApproachFeet(startFoot, targets);
  const approachFeet =
    input.maxApproachFeet === undefined
      ? allApproachFeet
      : allApproachFeet.slice(0, input.maxApproachFeet);
  let lastError: unknown = null;
  diagnostics.push(
    `${diagnosticPrefix}_budget:approach_feet=${approachFeet.length}/${allApproachFeet.length};max_total_expanded=${input.routeBudget?.maxTotalExpandedStates ?? "default"};max_planning_ms=${input.routeBudget?.maxPlanningMs ?? "default"}`,
  );

  for (const targetFoot of approachFeet) {
    if (sameMinePos(startFoot, targetFoot)) continue;
    await delay(0);
    try {
      const result = await navigateTerrainToFoot({
        bot: ctx.bot,
        facts: ctx.facts,
        targetFoot,
        goalRange: 0,
        allowPlaceUp: true,
        allowDig: true,
        routeProfile: "mining",
        ...(input.routeBudget === undefined ? {} : { routeBudget: input.routeBudget }),
        diagnostics,
        diagnosticPrefix,
        control: ctx.control,
      });
      return result.totalSteps;
    } catch (error) {
      lastError = error;
      diagnostics.push(
        `${diagnosticPrefix}_rejected:${posLabel(targetFoot)}:${sanitizeDiagnostic(getErrorMessage(error))}`,
      );
    }
  }

  if (lastError !== null) {
    diagnostics.push(
      `${diagnosticPrefix}_failed:${sanitizeDiagnostic(getErrorMessage(lastError))}`,
    );
  }
  return 0;
}

function createMineTargetApproachFeet(
  startFoot: MineBlockPos,
  targets: readonly MineRouteTarget[],
): readonly MineBlockPos[] {
  const out: MineBlockPos[] = [];
  const seen = new Set<string>();
  const sortedTargets = [...targets].sort(
    (left, right) => distance(startFoot, left.position) - distance(startFoot, right.position),
  );

  for (const target of sortedTargets.slice(0, 8)) {
    for (const y of [target.position.y - 1, target.position.y]) {
      for (const offset of [
        { x: 1, z: 0 },
        { x: -1, z: 0 },
        { x: 0, z: 1 },
        { x: 0, z: -1 },
      ] as const) {
        const foot = freezeMinePos({
          x: target.position.x + offset.x,
          y,
          z: target.position.z + offset.z,
        });
        const key = posLabel(foot);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(foot);
      }
    }
  }

  return Object.freeze(
    out.sort((left, right) => distance(startFoot, left) - distance(startFoot, right)),
  );
}

function freezeMinePos(
  pos: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>,
): MineBlockPos {
  return Object.freeze({
    x: Math.floor(pos.x),
    y: Math.floor(pos.y),
    z: Math.floor(pos.z),
  });
}

async function digFinalTarget(
  ctx: ExecutionContext,
  pos: MineBlockPos,
  diagnostics: string[],
): Promise<boolean> {
  ctx.control.throwIfAborted();
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
  diagnostics.push(`mine_final_dig_start:${ctx.blockName}:${posLabel(pos)}`);
  await waitForPromiseOrCondition({
    promise: Promise.resolve(ctx.bot.dig?.(block)),
    condition: () => isBlockChanged(ctx.facts, readMineflayerBlockAt(ctx.bot, pos), ctx.blockName),
    idleTimeoutMs: MINE_DIG_IDLE_TIMEOUT_MS,
    pollMs: MINE_POLL_MS,
    timeoutMessage: () => `mine_dig_timeout:final:${posLabel(pos)}`,
    throwIfAborted: () => ctx.control.throwIfAborted(),
    diagnostics,
    diagnosticPrefix: `mine_final_dig:${ctx.blockName}:${posLabel(pos)}`,
  });
  ctx.control.throwIfAborted();
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

function centerOfBlock(pos: { readonly x: number; readonly y: number; readonly z: number }): Vec3 {
  return new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
}

function posLabel(pos: { readonly x: number; readonly y: number; readonly z: number }): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function sanitizeDiagnostic(value: string): string {
  return value.replace(/\s+/gu, "_").slice(0, 240);
}

function sameMinePos(
  left: { readonly x: number; readonly y: number; readonly z: number },
  right: { readonly x: number; readonly y: number; readonly z: number },
): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function distance(
  left: { readonly x: number; readonly y: number; readonly z: number },
  right: { readonly x: number; readonly y: number; readonly z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
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
      `drop_not_obtained:${input.expectedDropName}:${input.collectedCount}/${input.requestedCount}:mine route completed without enough inventory diff`,
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
