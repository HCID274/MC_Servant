/**
 * terrain-router 输出动作的单步执行器。
 * 将 walk / drop1 / jumpUp / placeUp1 / digWalk / digStepDown / digStepUp 翻译为
 * Mineflayer 的 setControlState + lookAt + dig / placeBlock 调用。
 */

import { Vec3 } from "vec3";
import type { SkillExecutionControl } from "../../../core-ports/skills.js";
import { prepareHandForMineDig } from "../dig-tool-policy.js";
import type { MineBlockFactReader } from "../facts/index.js";
import { waitForPromiseOrCondition } from "../progress-watchdog.js";
import type {
  MineflayerBlockHandle,
  MineflayerInventoryPort,
  MineflayerItemHandle,
  MineflayerMiningPort,
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
  MineflayerPlacementPort,
  MineflayerRegistryFacts,
} from "../types.js";
import { readMineflayerBlockAt } from "../world/index.js";
import {
  centerOnFoot,
  dropToFoot,
  isFootStepBotAtFoot,
  stepToFoot,
  waitUntilFootYReachedThenRecover,
} from "./foot-step.js";
import { tryLocalPathfinderMoveToFoot } from "./local-move-actuator.js";
import type { TerrainBlockPos, TerrainRouteAction } from "./router.js";
import {
  forgetSelfPlacedTerrainBlock,
  recordSelfPlacedTerrainBlock,
} from "./self-placed-memory.js";

type TerrainActionBot = MineflayerMovementPort &
  MineflayerMiningPort &
  MineflayerPlacementPort &
  MineflayerInventoryPort;

const MOVE_IDLE_TIMEOUT_MS = 15_000;
const DROP_IDLE_TIMEOUT_MS = 15_000;
const DIG_IDLE_TIMEOUT_MS = 15_000;
const LOOK_TIMEOUT_MS = 3_000;
const PLACE_TIMEOUT_MS = 3_000;
const PLACE_LOOK_TIMEOUT_MS = 250;
const PLACE_JUMP_TAP_MS = 50;
const PLACE_CENTER_TIMEOUT_MS = 1_500;
const POLL_MS = 50;
const POST_DIG_SETTLE_MS = 120;
const POST_DIG_VERIFY_TIMEOUT_MS = 1_000;
const POST_PLACE_VERIFY_TIMEOUT_MS = 1_500;
const DEFAULT_PLACE_UP_DELAYS_MS = Object.freeze([320, 340] as const);
const PLACE_UP_MAX_ROUNDS = 3;
const PLACE_UP_DELAYS_MS = readPlaceUpDelayQueue(process.env.TERRAIN_PLACE_UP_DELAYS_MS);
const PLACE_UP_DELAY_STATS = new Map<number, { successes: number; failures: number }>();

/** 执行单条地形寻路动作。 */
/** 执行地形寻路动作：根据动作类型分发到对应的 Mineflayer 操作。 */
export async function executeTerrainRouteAction(input: {
  readonly bot: TerrainActionBot;
  readonly facts: MineBlockFactReader;
  readonly action: TerrainRouteAction;
  readonly diagnostics: string[];
  readonly control: SkillExecutionControl;
  readonly pathfinder?: MineflayerPathfinderApi;
  readonly pathfinderModule?: MineflayerPathfinderModule;
}): Promise<void> {
  input.control.throwIfAborted();
  switch (input.action.kind) {
    case "walk":
      await stepForward(
        input.bot,
        input.action.toFoot,
        { jump: false, kind: input.action.kind },
        MOVE_IDLE_TIMEOUT_MS,
        input.diagnostics,
        input.control,
        input.pathfinder,
        input.pathfinderModule,
      );
      input.control.throwIfAborted();
      return;
    case "drop1":
      await dropToFoot({
        bot: input.bot,
        target: input.action.toFoot,
        timeoutMs: DROP_IDLE_TIMEOUT_MS,
        lookTimeoutMs: LOOK_TIMEOUT_MS,
        diagnosticPrefix: "terrain",
        actionKind: input.action.kind,
        diagnostics: input.diagnostics,
        throwIfAborted: () => input.control.throwIfAborted(),
      });
      input.control.throwIfAborted();
      return;
    case "jumpUp":
      await stepForward(
        input.bot,
        input.action.toFoot,
        { jump: true, kind: input.action.kind },
        MOVE_IDLE_TIMEOUT_MS,
        input.diagnostics,
        input.control,
        input.pathfinder,
        input.pathfinderModule,
      );
      input.control.throwIfAborted();
      return;
    case "placeUp1":
      for (const dig of input.action.digs) {
        input.control.throwIfAborted();
        await digSingleBlock(input.bot, input.facts, dig, input.diagnostics, input.control);
      }
      await placeUpOneBlock(input.bot, input.facts, input.action, input.diagnostics, input.control);
      input.control.throwIfAborted();
      return;
    case "digWalk":
      for (const dig of input.action.digs) {
        input.control.throwIfAborted();
        await digSingleBlock(input.bot, input.facts, dig, input.diagnostics, input.control);
      }
      await stepForward(
        input.bot,
        input.action.toFoot,
        { jump: false, kind: input.action.kind },
        MOVE_IDLE_TIMEOUT_MS,
        input.diagnostics,
        input.control,
        input.pathfinder,
        input.pathfinderModule,
      );
      input.control.throwIfAborted();
      return;
    case "digStepDown":
      for (const dig of input.action.digs) {
        input.control.throwIfAborted();
        await digSingleBlock(input.bot, input.facts, dig, input.diagnostics, input.control);
      }
      await dropToFoot({
        bot: input.bot,
        target: input.action.toFoot,
        timeoutMs: DROP_IDLE_TIMEOUT_MS,
        lookTimeoutMs: LOOK_TIMEOUT_MS,
        diagnosticPrefix: "terrain",
        actionKind: input.action.kind,
        diagnostics: input.diagnostics,
        throwIfAborted: () => input.control.throwIfAborted(),
      });
      input.control.throwIfAborted();
      return;
    case "digStepUp":
      for (const dig of input.action.digs) {
        input.control.throwIfAborted();
        await digSingleBlock(input.bot, input.facts, dig, input.diagnostics, input.control);
      }
      await stepForward(
        input.bot,
        input.action.toFoot,
        { jump: true, kind: input.action.kind },
        MOVE_IDLE_TIMEOUT_MS,
        input.diagnostics,
        input.control,
        input.pathfinder,
        input.pathfinderModule,
      );
      input.control.throwIfAborted();
      return;
    case "digDropSelfPlaced":
      await centerOnFootBeforeDigDrop(
        input.bot,
        readBotFoot(input.bot),
        input.diagnostics,
        input.control,
      );
      for (const dig of input.action.digs) {
        input.control.throwIfAborted();
        await digSingleBlock(input.bot, input.facts, dig, input.diagnostics, input.control);
      }
      await waitUntilFootYReachedThenRecover({
        bot: input.bot,
        target: input.action.toFoot,
        timeoutMs: DROP_IDLE_TIMEOUT_MS,
        lookTimeoutMs: LOOK_TIMEOUT_MS,
        diagnosticPrefix: "terrain",
        actionKind: input.action.kind,
        diagnostics: input.diagnostics,
        throwIfAborted: () => input.control.throwIfAborted(),
      });
      input.control.throwIfAborted();
      return;
  }
}

/** 判断 Bot 是否已到达目标脚位。 */
export function isTerrainBotAtFoot(bot: TerrainActionBot, target: TerrainBlockPos): boolean {
  return isFootStepBotAtFoot(bot, target);
}

/** 读取 Bot 当前脚位坐标（向下取整）。 */
function readBotFoot(bot: TerrainActionBot): TerrainBlockPos {
  const position = bot.entity?.position ?? { x: 0, y: 0, z: 0 };
  return freezePos({
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  });
}

/** 放置一个方块：居中 → 清除目标 → 装备物品 → 跳跃 → 放置 → 验证。 */
async function placeUpOneBlock(
  bot: TerrainActionBot,
  facts: MineBlockFactReader,
  action: Extract<TerrainRouteAction, { readonly kind: "placeUp1" }>,
  diagnostics: string[],
  control: SkillExecutionControl,
): Promise<void> {
  control.throwIfAborted();
  const plannedLivePlaceAt = readBotFoot(bot);
  await centerOnFootBeforePlaceUp(bot, plannedLivePlaceAt, diagnostics, control);
  control.throwIfAborted();

  const livePlaceAt = readBotFoot(bot);
  const liveSupport = freezePos({ x: livePlaceAt.x, y: livePlaceAt.y - 1, z: livePlaceAt.z });
  const liveTargetFoot = freezePos({ x: livePlaceAt.x, y: livePlaceAt.y + 1, z: livePlaceAt.z });
  if (!samePos(livePlaceAt, action.placeAt) || !samePos(liveSupport, action.support)) {
    diagnostics.push(
      `terrain_place_up_rebased:planned=${posLabel(action.placeAt)};live=${posLabel(livePlaceAt)}`,
    );
  }

  const supportBlock = readMineflayerBlockAt(bot, liveSupport);
  if (supportBlock === null || supportBlock === undefined) {
    throw new Error(`terrain_place_support_missing:${posLabel(liveSupport)}`);
  }

  const placeAtBlock = readMineflayerBlockAt(bot, livePlaceAt);
  const directReplaceTargetName =
    placeAtBlock === null || placeAtBlock === undefined || isEmptyBlock(facts, placeAtBlock)
      ? null
      : facts.normalizeName(placeAtBlock.name);
  if (!isEmptyBlock(facts, placeAtBlock)) {
    if (placeAtBlock === null || placeAtBlock === undefined) {
      throw new Error(`terrain_place_target_unknown:${posLabel(livePlaceAt)}`);
    }
    await clearPlaceUpTargetBlock({
      bot,
      facts,
      pos: livePlaceAt,
      block: placeAtBlock,
      diagnostics,
      control,
      allowDirectReplace: true,
    });
  }

  if (typeof bot.equip !== "function") {
    throw new Error("terrain_place_equip_unavailable");
  }
  if (typeof bot._placeBlockWithOptions !== "function" && typeof bot.placeBlock !== "function") {
    throw new Error("terrain_place_block_unavailable");
  }

  await withTerrainActionTimeout(
    Promise.resolve(bot.lookAt?.(centerOfBlock(liveSupport), true)),
    LOOK_TIMEOUT_MS,
    `terrain_place_look_timeout:${posLabel(liveSupport)}`,
  );

  let lastError: unknown = null;
  for (let round = 1; round <= PLACE_UP_MAX_ROUNDS; round += 1) {
    control.throwIfAborted();
    diagnostics.push(`terrain_place_up_round_start:round=${round}/${PLACE_UP_MAX_ROUNDS}`);
    for (const delayMs of createPlaceUpDelayQueue()) {
      control.throwIfAborted();
      const attemptStartedAt = Date.now();
      try {
        const item = await ensurePlaceUpItemEquipped(bot, facts, diagnostics);
        await tapJump(bot, delayMs);
        await withTerrainActionTimeout(
          Promise.resolve(bot.lookAt?.(centerOfBlock(liveSupport), true)),
          PLACE_LOOK_TIMEOUT_MS,
          `terrain_place_relook_timeout:${posLabel(liveSupport)}:${delayMs}`,
        );
        const placeAttempt = withTerrainActionTimeout(
          placeUpWithMineflayer(bot, supportBlock),
          PLACE_TIMEOUT_MS,
          `terrain_place_timeout:${posLabel(livePlaceAt)}:${delayMs}`,
        );
        await placeAttempt;
        await waitUntilPlaced(bot, facts, livePlaceAt);
        await waitUntilPlaceUpFootReached({
          bot,
          target: liveTargetFoot,
          diagnostics,
          control,
        });
        recordPlaceUpDelay(delayMs, "success");
        recordSelfPlacedTerrainBlock(bot, livePlaceAt);
        diagnostics.push(
          `terrain_place_up_attempt:round=${round};delay=${delayMs};status=success;elapsed_ms=${Date.now() - attemptStartedAt};item=${facts.normalizeName(item.name)};pos=${posLabel(livePlaceAt)}`,
        );
        return;
      } catch (error) {
        lastError = error;
        recordPlaceUpDelay(delayMs, "failure");
        diagnostics.push(
          `terrain_place_up_attempt:round=${round};delay=${delayMs};status=failed;elapsed_ms=${Date.now() - attemptStartedAt};reason=${sanitizeDiagnostic(getErrorMessage(error))};pos=${posLabel(livePlaceAt)}`,
        );
        bot.setControlState?.("jump", false);
        await delay(120);
        const currentPlaceAtBlock = readMineflayerBlockAt(bot, livePlaceAt);
        if (isPlacedAfterFailedAttempt(facts, currentPlaceAtBlock, directReplaceTargetName)) {
          await waitUntilPlaceUpFootReached({
            bot,
            target: liveTargetFoot,
            diagnostics,
            control,
          });
          recordPlaceUpDelay(delayMs, "success");
          recordSelfPlacedTerrainBlock(bot, livePlaceAt);
          diagnostics.push(
            `terrain_place_up_attempt:round=${round};delay=${delayMs};status=verified_after_error;elapsed_ms=${Date.now() - attemptStartedAt};pos=${posLabel(livePlaceAt)}`,
          );
          return;
        }
        if (
          currentPlaceAtBlock !== null &&
          currentPlaceAtBlock !== undefined &&
          !isEmptyBlock(facts, currentPlaceAtBlock)
        ) {
          await clearPlaceUpTargetBlock({
            bot,
            facts,
            pos: livePlaceAt,
            block: currentPlaceAtBlock,
            diagnostics,
            control,
            allowDirectReplace: false,
          });
        }
      } finally {
        bot.setControlState?.("jump", false);
      }
    }
    diagnostics.push(`terrain_place_up_round_failed:round=${round}/${PLACE_UP_MAX_ROUNDS}`);
  }

  throw new Error(`terrain_place_up_failed:${getErrorMessage(lastError)}`);
}

/** 等待放置后 Bot 脚位到达目标高度（放置成功后 Bot 会被抬高一格）。 */
async function waitUntilPlaceUpFootReached(input: {
  readonly bot: TerrainActionBot;
  readonly target: TerrainBlockPos;
  readonly diagnostics: string[];
  readonly control: SkillExecutionControl;
}): Promise<void> {
  await waitUntilFootYReachedThenRecover({
    bot: input.bot,
    target: input.target,
    timeoutMs: DROP_IDLE_TIMEOUT_MS,
    lookTimeoutMs: LOOK_TIMEOUT_MS,
    diagnosticPrefix: "terrain",
    actionKind: "placeUp1",
    transitionLabel: "place_up",
    diagnostics: input.diagnostics,
    throwIfAborted: () => input.control.throwIfAborted(),
  });
}

/** 短暂跳跃：按下跳跃键 → 等待 → 松开跳跃键 → 等待剩余延迟。 */
async function tapJump(bot: TerrainActionBot, placeDelayMs: number): Promise<void> {
  bot.setControlState?.("jump", true);
  await delay(Math.min(PLACE_JUMP_TAP_MS, placeDelayMs));
  bot.setControlState?.("jump", false);
  const remainingDelayMs = placeDelayMs - PLACE_JUMP_TAP_MS;
  if (remainingDelayMs > 0) {
    await delay(remainingDelayMs);
  }
}

/** 放置前居中：将 Bot 移动到目标脚位中心，确保放置位置准确。 */
async function centerOnFootBeforePlaceUp(
  bot: TerrainActionBot,
  foot: TerrainBlockPos,
  diagnostics: string[],
  control: SkillExecutionControl,
): Promise<void> {
  const startedAt = Date.now();
  await centerOnFoot({
    bot,
    target: foot,
    timeoutMs: PLACE_CENTER_TIMEOUT_MS,
    lookTimeoutMs: LOOK_TIMEOUT_MS,
    diagnosticPrefix: "terrain",
    actionKind: "placeUp1",
    diagnostics,
    throwIfAborted: () => control.throwIfAborted(),
  });
  diagnostics.push(
    `terrain_place_up_centered:foot=${posLabel(foot)};elapsed_ms=${Date.now() - startedAt}`,
  );
}

/** 挖掘下落前居中：将 Bot 移动到目标脚位中心，确保下落位置准确。 */
async function centerOnFootBeforeDigDrop(
  bot: TerrainActionBot,
  foot: TerrainBlockPos,
  diagnostics: string[],
  control: SkillExecutionControl,
): Promise<void> {
  const startedAt = Date.now();
  await centerOnFoot({
    bot,
    target: foot,
    timeoutMs: PLACE_CENTER_TIMEOUT_MS,
    lookTimeoutMs: LOOK_TIMEOUT_MS,
    diagnosticPrefix: "terrain",
    actionKind: "digDropSelfPlaced",
    diagnostics,
    throwIfAborted: () => control.throwIfAborted(),
  });
  diagnostics.push(
    `terrain_dig_drop_centered:foot=${posLabel(foot)};elapsed_ms=${Date.now() - startedAt}`,
  );
}

/** 调用 Mineflayer 放置方块（优先使用 _placeBlockWithOptions，否则 fallback 到 placeBlock）。 */
function placeUpWithMineflayer(
  bot: TerrainActionBot,
  supportBlock: MineflayerBlockHandle,
): Promise<unknown> {
  const faceVector = new Vec3(0, 1, 0);
  if (typeof bot._placeBlockWithOptions === "function") {
    return Promise.resolve(
      bot._placeBlockWithOptions(supportBlock, faceVector, {
        forceLook: true,
        swingArm: "right",
      }),
    );
  }

  return Promise.resolve(bot.placeBlock?.(supportBlock, faceVector));
}

/** 挖掘单个方块：检查可达性 → 装备工具 → 看向目标 → 执行挖掘 → 验证方块已变化。 */
async function digSingleBlock(
  bot: TerrainActionBot,
  facts: MineBlockFactReader,
  pos: TerrainBlockPos,
  diagnostics: string[],
  control: SkillExecutionControl,
): Promise<void> {
  const block = readMineflayerBlockAt(bot, pos);
  if (block === null || block === undefined) return;
  const name = facts.normalizeName(block.name);
  if (facts.isLiteralAirBlock(block)) return;
  if (typeof bot.canDigBlock === "function" && !bot.canDigBlock(block)) {
    throw new Error(`terrain_dig_out_of_reach:${name}:${posLabel(pos)}`);
  }

  await prepareHandForMineDig({
    bot,
    facts,
    blockName: name,
    diagnostics,
    withTimeout: withTerrainActionTimeout,
  });
  await withTerrainActionTimeout(
    Promise.resolve(bot.lookAt?.(centerOfBlock(pos), true)),
    LOOK_TIMEOUT_MS,
    `terrain_look_timeout:dig:${posLabel(pos)}`,
  );
  await waitForPromiseOrCondition({
    promise: Promise.resolve(bot.dig?.(block)),
    condition: () => isBlockChanged(facts, readMineflayerBlockAt(bot, pos), name),
    idleTimeoutMs: DIG_IDLE_TIMEOUT_MS,
    pollMs: POLL_MS,
    timeoutMessage: () => `terrain_dig_timeout:${name}:${posLabel(pos)}`,
    throwIfAborted: () => control.throwIfAborted(),
    diagnostics,
    diagnosticPrefix: `terrain_dig:${name}:${posLabel(pos)}`,
  });
  await waitUntilBlockChanged(bot, facts, pos, name);
  forgetSelfPlacedTerrainBlock(bot, pos);
  diagnostics.push(`terrain_dig_verified:${name}:${posLabel(pos)}`);
}

/** 向前移动一步：调用 foot-step 模块的 stepToFoot 实现。 */
async function stepForward(
  bot: TerrainActionBot,
  target: TerrainBlockPos,
  options: { readonly jump: boolean; readonly kind: TerrainRouteAction["kind"] },
  timeoutMs: number,
  diagnostics: string[],
  control: SkillExecutionControl,
  pathfinder?: MineflayerPathfinderApi,
  pathfinderModule?: MineflayerPathfinderModule,
): Promise<void> {
  if (
    await tryLocalPathfinderMoveToFoot({
      bot,
      target,
      diagnostics,
      diagnosticPrefix: "terrain",
      actionKind: options.kind,
      control,
      ...(pathfinder === undefined ? {} : { pathfinder }),
      ...(pathfinderModule === undefined ? {} : { pathfinderModule }),
    })
  ) {
    return;
  }
  await stepToFoot({
    bot,
    target,
    jump: options.jump,
    timeoutMs,
    lookTimeoutMs: LOOK_TIMEOUT_MS,
    diagnosticPrefix: "terrain",
    actionKind: options.kind,
    diagnostics,
  });
}

/** 从背包中选择最适合放置的方块物品（优先数量多、硬度低、名称排序靠前）。 */
function selectPlaceUpItem(bot: TerrainActionBot): MineflayerItemHandle | null {
  const registry = bot.registry as MineflayerRegistryFacts | undefined;
  const blocksByName = registry?.blocksByName;
  const items = bot.inventory?.items() ?? [];
  const candidates = items.flatMap((item) => {
    if (item.name === undefined || (item.count ?? 0) <= 0) return [];
    const block = blocksByName?.[normalizeName(item.name)];
    if (block === undefined) return [];
    if (block.falling === true) return [];
    if (block.boundingBox !== undefined && block.boundingBox !== "block") return [];
    return [{ item, block }];
  });
  candidates.sort((left, right) => comparePlaceUpCandidates(left, right));
  return candidates[0]?.item ?? null;
}

/** 确保放置物品已装备到主手；如果没有则从背包选择并装备。 */
async function ensurePlaceUpItemEquipped(
  bot: TerrainActionBot,
  facts: MineBlockFactReader,
  diagnostics: string[],
): Promise<MineflayerItemHandle> {
  if (isPlaceUpItem(bot, bot.heldItem)) {
    return bot.heldItem;
  }

  const item = selectPlaceUpItem(bot);
  if (item === null) {
    throw new Error("terrain_place_item_missing");
  }
  if (typeof bot.equip !== "function") {
    throw new Error("terrain_place_equip_unavailable");
  }

  await withTerrainActionTimeout(
    Promise.resolve(bot.equip(item, "hand")),
    PLACE_TIMEOUT_MS,
    `terrain_place_equip_timeout:${item.name ?? item.type ?? "unknown"}`,
  );
  diagnostics.push(`terrain_place_item_equipped:${facts.normalizeName(item.name)}`);
  return item;
}

/** 判断物品是否为可放置方块（非掉落方块、非非完整方块）。 */
function isPlaceUpItem(
  bot: TerrainActionBot,
  item: MineflayerItemHandle | null | undefined,
): item is MineflayerItemHandle {
  if (item === null || item === undefined || item.name === undefined || (item.count ?? 0) <= 0) {
    return false;
  }
  const registry = bot.registry as MineflayerRegistryFacts | undefined;
  const block = registry?.blocksByName?.[normalizeName(item.name)];
  if (block === undefined) return false;
  if (block.falling === true) return false;
  return block.boundingBox === undefined || block.boundingBox === "block";
}

/** 清除放置目标位置的方块（如果是可替换方块则跳过，否则挖掘）。 */
async function clearPlaceUpTargetBlock(input: {
  readonly bot: TerrainActionBot;
  readonly facts: MineBlockFactReader;
  readonly pos: TerrainBlockPos;
  readonly block: MineflayerBlockHandle;
  readonly diagnostics: string[];
  readonly control: SkillExecutionControl;
  readonly allowDirectReplace: boolean;
}): Promise<void> {
  const blockName = input.facts.normalizeName(input.block.name);
  if (input.allowDirectReplace && isReplaceablePlaceTarget(input.block)) {
    input.diagnostics.push(`terrain_place_target_replaceable:${blockName}:${posLabel(input.pos)}`);
    return;
  }

  if (!input.facts.isDiggableBlock(input.block)) {
    throw new Error(`terrain_place_target_occupied:${posLabel(input.pos)}:${blockName}`);
  }

  input.diagnostics.push(`terrain_place_target_clear_start:${blockName}:${posLabel(input.pos)}`);
  input.control.throwIfAborted();
  await digSingleBlock(input.bot, input.facts, input.pos, input.diagnostics, input.control);
  input.control.throwIfAborted();

  const current = readMineflayerBlockAt(input.bot, input.pos);
  if (isEmptyBlock(input.facts, current) || isReplaceablePlaceTarget(current)) {
    input.diagnostics.push(`terrain_place_target_clear_done:${blockName}:${posLabel(input.pos)}`);
    return;
  }

  throw new Error(`terrain_place_target_clear_failed:${posLabel(input.pos)}:${blockName}`);
}

/** 判断方块是否为可替换的放置目标（无碰撞箱，如草、花等）。 */
function isReplaceablePlaceTarget(block: MineflayerBlockHandle | null | undefined): boolean {
  if (block === null || block === undefined) return false;
  if (Array.isArray(block.shapes)) return block.shapes.length === 0;
  return false;
}

/** 判断放置失败后目标位置是否已被其他方块占据（可能是其他 Bot 放置的）。 */
function isPlacedAfterFailedAttempt(
  facts: MineBlockFactReader,
  block: MineflayerBlockHandle | null | undefined,
  previousTargetName: string | null,
): boolean {
  if (block === null || block === undefined || isEmptyBlock(facts, block)) return false;
  const currentName = facts.normalizeName(block.name);
  return previousTargetName === null || currentName !== previousTargetName;
}

/** 比较两个放置候选物品的优先级（堆叠数量 → 硬度 → 名称）。 */
function comparePlaceUpCandidates(
  left: {
    readonly item: MineflayerItemHandle;
    readonly block: NonNullable<MineflayerRegistryFacts["blocksByName"]>[string];
  },
  right: {
    readonly item: MineflayerItemHandle;
    readonly block: NonNullable<MineflayerRegistryFacts["blocksByName"]>[string];
  },
): number {
  const leftBucket = readStackBucket(left.item);
  const rightBucket = readStackBucket(right.item);
  if (leftBucket !== rightBucket) return leftBucket - rightBucket;

  const leftHardness = readPlacementHardness(left.block);
  const rightHardness = readPlacementHardness(right.block);
  if (leftHardness !== rightHardness) return leftHardness - rightHardness;

  const countDiff = (right.item.count ?? 1) - (left.item.count ?? 1);
  if (countDiff !== 0) return countDiff;

  return normalizeName(left.item.name ?? "").localeCompare(normalizeName(right.item.name ?? ""));
}

/** 读取物品堆叠数量分桶（≥32 → 0，≥8 → 1，其他 → 2），用于排序。 */
function readStackBucket(item: MineflayerItemHandle): number {
  const count = item.count ?? 1;
  if (count >= 32) return 0;
  if (count >= 8) return 1;
  return 2;
}

/** 读取方块硬度值（用于排序，硬度越低越容易放置）。 */
function readPlacementHardness(
  block: NonNullable<MineflayerRegistryFacts["blocksByName"]>[string],
): number {
  return typeof block?.hardness === "number" && Number.isFinite(block.hardness)
    ? block.hardness
    : 1;
}

/** 等待方块变化：轮询检查目标位置的方块是否已变为预期状态。 */
async function waitUntilBlockChanged(
  bot: TerrainActionBot,
  facts: MineBlockFactReader,
  pos: TerrainBlockPos,
  originalName: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= POST_DIG_VERIFY_TIMEOUT_MS) {
    const current = readMineflayerBlockAt(bot, pos);
    if (isBlockChanged(facts, current, originalName)) {
      await delay(POST_DIG_SETTLE_MS);
      return;
    }
    await delay(POLL_MS);
  }
  throw new Error(`terrain_dig_no_effect:${originalName}:${posLabel(pos)}`);
}

/** 等待方块放置成功：轮询检查目标位置是否不再是空气。 */
async function waitUntilPlaced(
  bot: TerrainActionBot,
  facts: MineBlockFactReader,
  pos: TerrainBlockPos,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= POST_PLACE_VERIFY_TIMEOUT_MS) {
    const block = readMineflayerBlockAt(bot, pos);
    if (!isEmptyBlock(facts, block) && !isReplaceablePlaceTarget(block)) return;
    await delay(POLL_MS);
  }
  throw new Error(`terrain_place_no_effect:${posLabel(pos)}`);
}

/** 判断方块是否已变化（变为空气或名称不同）。 */
function isBlockChanged(
  facts: MineBlockFactReader,
  block: MineflayerBlockHandle | null | undefined,
  originalName: string,
): boolean {
  if (block === null || block === undefined) return true;
  const currentName = facts.normalizeName(block.name);
  return facts.isLiteralAirBlock(block) || currentName !== originalName;
}

/** 判断方块是否为空气（包括 null/undefined）。 */
function isEmptyBlock(
  facts: MineBlockFactReader,
  block: MineflayerBlockHandle | null | undefined,
): boolean {
  if (block === null || block === undefined) return false;
  return facts.isLiteralAirBlock(block);
}

/** 计算方块中心坐标（+0.5 偏移）。 */
function centerOfBlock(pos: TerrainBlockPos): Vec3 {
  return new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
}

/** 坐标格式化为日志标签（x,y,z）。 */
function posLabel(pos: TerrainBlockPos): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

/** 判断两个坐标是否相同。 */
function samePos(left: TerrainBlockPos, right: TerrainBlockPos): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

/** 冻结坐标对象为不可变实例。 */
function freezePos(pos: TerrainBlockPos): TerrainBlockPos {
  return Object.freeze({ x: pos.x, y: pos.y, z: pos.z });
}

/** 标准化方块名称：去除命名空间、转小写、空格和连字符转下划线。 */
function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/u, "")
    .replace(/[\s-]+/gu, "_");
}

/** 带超时的 Promise 包装器：如果 promise 未在指定时间内完成则抛出错误。 */
async function withTerrainActionTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/** 延迟指定毫秒。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从错误对象中提取错误消息。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 解析 TERRAIN_PLACE_UP_DELAYS_MS 环境变量为延迟队列。 */
function readPlaceUpDelayQueue(value: string | undefined): readonly number[] {
  if (value === undefined || value.trim().length === 0) {
    return DEFAULT_PLACE_UP_DELAYS_MS;
  }

  const parsed = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 250);

  return parsed.length === 0 ? DEFAULT_PLACE_UP_DELAYS_MS : Object.freeze(parsed);
}

/** 创建默认的放置延迟队列。 */
function createPlaceUpDelayQueue(): readonly number[] {
  return PLACE_UP_DELAYS_MS;
}

/** 记录放置延迟的成功/失败统计。 */
function recordPlaceUpDelay(delayMs: number, status: "success" | "failure"): void {
  const current = PLACE_UP_DELAY_STATS.get(delayMs) ?? { successes: 0, failures: 0 };
  PLACE_UP_DELAY_STATS.set(delayMs, {
    successes: current.successes + (status === "success" ? 1 : 0),
    failures: current.failures + (status === "failure" ? 1 : 0),
  });
}

/** 清理诊断字符串：移除分号和换行符，截断到 160 字符。 */
function sanitizeDiagnostic(value: string): string {
  return value.replaceAll(/[;\n\r]/gu, " ").slice(0, 160);
}
