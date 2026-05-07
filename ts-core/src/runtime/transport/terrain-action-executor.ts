import { Vec3 } from "vec3";
import { isFootStepBotAtFoot, stepToFoot, waitUntilFootReached } from "./foot-step.js";
import type { MineBlockFactReader } from "./mine-block-facts.js";
import { prepareHandForMineDig } from "./mine-tool-policy.js";
import type { TerrainBlockPos, TerrainRouteAction } from "./terrain-router.js";
import type {
  MineflayerBlockHandle,
  MineflayerInventoryPort,
  MineflayerItemHandle,
  MineflayerMiningPort,
  MineflayerMovementPort,
  MineflayerPlacementPort,
  MineflayerRegistryFacts,
} from "./types.js";
import { readMineflayerBlockAt } from "./world-reader.js";

type TerrainActionBot = MineflayerMovementPort &
  MineflayerMiningPort &
  MineflayerPlacementPort &
  MineflayerInventoryPort;

const MOVE_TIMEOUT_MS = 5_000;
const DROP_TIMEOUT_MS = 6_000;
const DIG_TIMEOUT_MS = 10_000;
const LOOK_TIMEOUT_MS = 3_000;
const PLACE_TIMEOUT_MS = 3_000;
const PLACE_LOOK_TIMEOUT_MS = 250;
const PLACE_JUMP_TAP_MS = 50;
const PLACE_CENTER_TIMEOUT_MS = 1_500;
const PLACE_CENTER_TOLERANCE = 0.28;
const POLL_MS = 50;
const POST_DIG_SETTLE_MS = 120;
const POST_DIG_VERIFY_TIMEOUT_MS = 1_000;
const POST_PLACE_VERIFY_TIMEOUT_MS = 1_500;
const DEFAULT_PLACE_UP_DELAYS_MS = Object.freeze([110, 115, 120, 125] as const);
const PLACE_UP_DELAYS_MS = readPlaceUpDelayQueue(process.env.TERRAIN_PLACE_UP_DELAYS_MS);
const PLACE_UP_DELAY_STATS = new Map<number, { successes: number; failures: number }>();
const CENTER_PULSE_MS = 90;

export async function executeTerrainRouteAction(input: {
  readonly bot: TerrainActionBot;
  readonly facts: MineBlockFactReader;
  readonly action: TerrainRouteAction;
  readonly diagnostics: string[];
}): Promise<void> {
  switch (input.action.kind) {
    case "walk":
      await stepForward(
        input.bot,
        input.action.toFoot,
        { jump: false, kind: input.action.kind },
        MOVE_TIMEOUT_MS,
        input.diagnostics,
      );
      return;
    case "drop1":
      await stepForward(
        input.bot,
        input.action.toFoot,
        { jump: false, kind: input.action.kind },
        DROP_TIMEOUT_MS,
        input.diagnostics,
      );
      return;
    case "jumpUp":
      await stepForward(
        input.bot,
        input.action.toFoot,
        { jump: true, kind: input.action.kind },
        MOVE_TIMEOUT_MS,
        input.diagnostics,
      );
      return;
    case "placeUp1":
      for (const dig of input.action.digs) {
        await digSingleBlock(input.bot, input.facts, dig, input.diagnostics);
      }
      await placeUpOneBlock(input.bot, input.facts, input.action, input.diagnostics);
      return;
    case "digWalk":
      for (const dig of input.action.digs) {
        await digSingleBlock(input.bot, input.facts, dig, input.diagnostics);
      }
      await stepForward(
        input.bot,
        input.action.toFoot,
        { jump: false, kind: input.action.kind },
        MOVE_TIMEOUT_MS,
        input.diagnostics,
      );
      return;
    case "digStepDown":
      for (const dig of input.action.digs) {
        await digSingleBlock(input.bot, input.facts, dig, input.diagnostics);
      }
      await stepForward(
        input.bot,
        input.action.toFoot,
        { jump: true, kind: input.action.kind },
        DROP_TIMEOUT_MS,
        input.diagnostics,
      );
      return;
    case "digStepUp":
      for (const dig of input.action.digs) {
        await digSingleBlock(input.bot, input.facts, dig, input.diagnostics);
      }
      await stepForward(
        input.bot,
        input.action.toFoot,
        { jump: true, kind: input.action.kind },
        MOVE_TIMEOUT_MS,
        input.diagnostics,
      );
      return;
  }
}

export function isTerrainBotAtFoot(bot: TerrainActionBot, target: TerrainBlockPos): boolean {
  return isFootStepBotAtFoot(bot, target);
}

function isTerrainBotAtFootCenter(bot: TerrainActionBot, target: TerrainBlockPos): boolean {
  const pos = bot.entity?.position;
  if (pos === undefined) return false;
  return (
    isSameFootCell(bot, target) &&
    Math.hypot(pos.x - (target.x + 0.5), pos.z - (target.z + 0.5)) <= PLACE_CENTER_TOLERANCE
  );
}

function isSameFootCell(bot: TerrainActionBot, target: TerrainBlockPos): boolean {
  const pos = bot.entity?.position;
  if (pos === undefined) return false;
  return (
    Math.floor(pos.x) === target.x &&
    Math.floor(pos.y) === target.y &&
    Math.floor(pos.z) === target.z
  );
}

function readBotFoot(bot: TerrainActionBot): TerrainBlockPos {
  const position = bot.entity?.position ?? { x: 0, y: 0, z: 0 };
  return freezePos({
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  });
}

async function placeUpOneBlock(
  bot: TerrainActionBot,
  facts: MineBlockFactReader,
  action: Extract<TerrainRouteAction, { readonly kind: "placeUp1" }>,
  diagnostics: string[],
): Promise<void> {
  const plannedLivePlaceAt = readBotFoot(bot);
  await centerOnFootBeforePlaceUp(bot, plannedLivePlaceAt, diagnostics);

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
  if (!isEmptyBlock(facts, placeAtBlock)) {
    throw new Error(`terrain_place_target_occupied:${posLabel(livePlaceAt)}`);
  }

  const item = selectPlaceUpItem(bot);
  if (item === null) {
    throw new Error("terrain_place_item_missing");
  }
  if (typeof bot.equip !== "function") {
    throw new Error("terrain_place_equip_unavailable");
  }
  if (typeof bot._placeBlockWithOptions !== "function" && typeof bot.placeBlock !== "function") {
    throw new Error("terrain_place_block_unavailable");
  }

  await withTerrainActionTimeout(
    Promise.resolve(bot.equip(item, "hand")),
    PLACE_TIMEOUT_MS,
    `terrain_place_equip_timeout:${item.name ?? item.type ?? "unknown"}`,
  );
  await withTerrainActionTimeout(
    Promise.resolve(bot.lookAt?.(centerOfBlock(liveSupport), true)),
    LOOK_TIMEOUT_MS,
    `terrain_place_look_timeout:${posLabel(liveSupport)}`,
  );

  let lastError: unknown = null;
  for (const delayMs of createPlaceUpDelayQueue()) {
    const attemptStartedAt = Date.now();
    try {
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
      await waitUntilFootReached({
        bot,
        target: liveTargetFoot,
        timeoutMs: DROP_TIMEOUT_MS,
        diagnosticPrefix: "terrain",
      });
      recordPlaceUpDelay(delayMs, "success");
      diagnostics.push(
        `terrain_place_up_attempt:delay=${delayMs};status=success;elapsed_ms=${Date.now() - attemptStartedAt};item=${facts.normalizeName(item.name)};pos=${posLabel(livePlaceAt)}`,
      );
      return;
    } catch (error) {
      lastError = error;
      recordPlaceUpDelay(delayMs, "failure");
      diagnostics.push(
        `terrain_place_up_attempt:delay=${delayMs};status=failed;elapsed_ms=${Date.now() - attemptStartedAt};reason=${sanitizeDiagnostic(getErrorMessage(error))};pos=${posLabel(livePlaceAt)}`,
      );
      bot.setControlState?.("jump", false);
      await delay(120);
      if (!isEmptyBlock(facts, readMineflayerBlockAt(bot, livePlaceAt))) {
        await waitUntilFootReached({
          bot,
          target: liveTargetFoot,
          timeoutMs: DROP_TIMEOUT_MS,
          diagnosticPrefix: "terrain",
        });
        recordPlaceUpDelay(delayMs, "success");
        diagnostics.push(
          `terrain_place_up_attempt:delay=${delayMs};status=verified_after_error;elapsed_ms=${Date.now() - attemptStartedAt};pos=${posLabel(livePlaceAt)}`,
        );
        return;
      }
    } finally {
      bot.setControlState?.("jump", false);
    }
  }

  throw new Error(`terrain_place_up_failed:${getErrorMessage(lastError)}`);
}

async function tapJump(bot: TerrainActionBot, placeDelayMs: number): Promise<void> {
  bot.setControlState?.("jump", true);
  await delay(Math.min(PLACE_JUMP_TAP_MS, placeDelayMs));
  bot.setControlState?.("jump", false);
  const remainingDelayMs = placeDelayMs - PLACE_JUMP_TAP_MS;
  if (remainingDelayMs > 0) {
    await delay(remainingDelayMs);
  }
}

async function centerOnFootBeforePlaceUp(
  bot: TerrainActionBot,
  foot: TerrainBlockPos,
  diagnostics: string[],
): Promise<void> {
  if (isTerrainBotAtFootCenter(bot, foot)) return;
  if (typeof bot.setControlState !== "function") {
    throw new Error("terrain_control_unavailable:setControlState");
  }

  const startedAt = Date.now();
  try {
    while (!isTerrainBotAtFootCenter(bot, foot)) {
      if (!isSameFootCell(bot, foot)) {
        throw new Error(
          `terrain_center_left_foot:${posLabel(foot)}:current=${positionLabel(bot.entity?.position)}`,
        );
      }
      if (Date.now() - startedAt >= PLACE_CENTER_TIMEOUT_MS) {
        throw new Error(
          `terrain_center_timeout:${posLabel(foot)}:current=${positionLabel(bot.entity?.position)}`,
        );
      }
      await withTerrainActionTimeout(
        Promise.resolve(bot.lookAt?.(centerOfFootTarget(foot), true)),
        LOOK_TIMEOUT_MS,
        `terrain_look_timeout:center:${posLabel(foot)}`,
      );
      bot.setControlState("forward", true);
      await delay(CENTER_PULSE_MS);
      bot.setControlState("forward", false);
      await delay(POLL_MS);
    }
    diagnostics.push(
      `terrain_place_up_centered:foot=${posLabel(foot)};elapsed_ms=${Date.now() - startedAt}`,
    );
  } finally {
    bot.setControlState("forward", false);
  }
}

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

async function digSingleBlock(
  bot: TerrainActionBot,
  facts: MineBlockFactReader,
  pos: TerrainBlockPos,
  diagnostics: string[],
): Promise<void> {
  const block = readMineflayerBlockAt(bot, pos);
  if (block === null || block === undefined) return;
  const name = facts.normalizeName(block.name);
  if (facts.isAirBlock(block)) return;
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
  await withTerrainActionTimeout(
    Promise.resolve(bot.dig?.(block)),
    DIG_TIMEOUT_MS,
    `terrain_dig_timeout:${name}:${posLabel(pos)}`,
  );
  await waitUntilBlockChanged(bot, facts, pos, name);
  diagnostics.push(`terrain_dig_verified:${name}:${posLabel(pos)}`);
}

async function stepForward(
  bot: TerrainActionBot,
  target: TerrainBlockPos,
  options: { readonly jump: boolean; readonly kind: TerrainRouteAction["kind"] },
  timeoutMs: number,
  diagnostics: string[],
): Promise<void> {
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

function positionLabel(
  pos:
    | {
        readonly x: number;
        readonly y: number;
        readonly z: number;
      }
    | undefined,
): string {
  if (pos === undefined) return "unknown";
  return `${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}`;
}

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

function readStackBucket(item: MineflayerItemHandle): number {
  const count = item.count ?? 1;
  if (count >= 32) return 0;
  if (count >= 8) return 1;
  return 2;
}

function readPlacementHardness(
  block: NonNullable<MineflayerRegistryFacts["blocksByName"]>[string],
): number {
  return typeof block?.hardness === "number" && Number.isFinite(block.hardness)
    ? block.hardness
    : 1;
}

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

async function waitUntilPlaced(
  bot: TerrainActionBot,
  facts: MineBlockFactReader,
  pos: TerrainBlockPos,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= POST_PLACE_VERIFY_TIMEOUT_MS) {
    if (!isEmptyBlock(facts, readMineflayerBlockAt(bot, pos))) return;
    await delay(POLL_MS);
  }
  throw new Error(`terrain_place_no_effect:${posLabel(pos)}`);
}

function isBlockChanged(
  facts: MineBlockFactReader,
  block: MineflayerBlockHandle | null | undefined,
  originalName: string,
): boolean {
  if (block === null || block === undefined) return true;
  const currentName = facts.normalizeName(block.name);
  return facts.isAirBlock(block) || currentName !== originalName;
}

function isEmptyBlock(
  facts: MineBlockFactReader,
  block: MineflayerBlockHandle | null | undefined,
): boolean {
  if (block === null || block === undefined) return false;
  return facts.isAirBlock(block);
}

function centerOfBlock(pos: TerrainBlockPos): Vec3 {
  return new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
}

function centerOfFootTarget(pos: TerrainBlockPos): Vec3 {
  return new Vec3(pos.x + 0.5, pos.y + 1, pos.z + 0.5);
}

function posLabel(pos: TerrainBlockPos): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function samePos(left: TerrainBlockPos, right: TerrainBlockPos): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function freezePos(pos: TerrainBlockPos): TerrainBlockPos {
  return Object.freeze({ x: pos.x, y: pos.y, z: pos.z });
}

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/u, "")
    .replace(/[\s-]+/gu, "_");
}

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function createPlaceUpDelayQueue(): readonly number[] {
  return PLACE_UP_DELAYS_MS;
}

function recordPlaceUpDelay(delayMs: number, status: "success" | "failure"): void {
  const current = PLACE_UP_DELAY_STATS.get(delayMs) ?? { successes: 0, failures: 0 };
  PLACE_UP_DELAY_STATS.set(delayMs, {
    successes: current.successes + (status === "success" ? 1 : 0),
    failures: current.failures + (status === "failure" ? 1 : 0),
  });
}

function sanitizeDiagnostic(value: string): string {
  return value.replaceAll(/[;\n\r]/gu, " ").slice(0, 160);
}
