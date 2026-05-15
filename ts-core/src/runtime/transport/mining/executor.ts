/**
 * mine（挖掘） 单步动作执行器：把 BFS 输出的 walk / drop / jumpUp / digWalk / digStep
 * 翻译成 Mineflayer 的 setControlState + lookAt + dig 调用。移动使用坐标进展心跳，
 * 挖掘使用方块变化心跳，避免还在推进的长动作被固定 wall-clock timeout 误杀。
 */
import { Vec3 } from "vec3";
import type { SkillExecutionControl } from "../../../core-ports/skills.js";
import { NOOP_SKILL_EXECUTION_CONTROL } from "../../../core-ports/skills.js";
import { dropToFoot, isFootStepBotAtFoot, stepToFoot } from "../foot-step.js";
import { tryLocalPathfinderMoveToFoot } from "../local-move-actuator.js";
import { waitForPromiseOrCondition } from "../progress-watchdog.js";
import type {
  MineflayerBlockHandle,
  MineflayerInventoryPort,
  MineflayerMiningPort,
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
  MineflayerPlacementPort,
} from "../types.js";
import { readMineflayerBlockAt } from "../world-reader.js";
import type { MineBlockFactReader } from "./facts.js";
import type { MineBlockPos, MineRouteAction } from "./planner.js";
import { prepareHandForMineDig } from "./tool-policy.js";

type MineActionBot = MineflayerMovementPort &
  MineflayerMiningPort &
  MineflayerPlacementPort &
  MineflayerInventoryPort;

const MOVE_IDLE_TIMEOUT_MS = 15_000;
const DROP_IDLE_TIMEOUT_MS = 15_000;
const DIG_IDLE_TIMEOUT_MS = 15_000;
const LOOK_TIMEOUT_MS = 3_000;
const POLL_MS = 50;
const POST_DIG_SETTLE_MS = 120;
const POST_DIG_VERIFY_TIMEOUT_MS = 1_000;

/** 执行单条 BFS 动作。 */
export async function executeMineRouteAction(input: {
  readonly bot: MineActionBot;
  readonly facts: MineBlockFactReader;
  readonly action: MineRouteAction;
  readonly diagnostics: string[];
  readonly control: SkillExecutionControl;
  readonly pathfinder?: MineflayerPathfinderApi;
  readonly pathfinderModule?: MineflayerPathfinderModule;
}): Promise<void> {
  const control = input.control ?? NOOP_SKILL_EXECUTION_CONTROL;
  control.throwIfAborted();
  switch (input.action.kind) {
    case "walk":
      await stepForward(
        input.bot,
        input.action.toFoot,
        { jump: false, kind: input.action.kind },
        MOVE_IDLE_TIMEOUT_MS,
        input.diagnostics,
        control,
        input.pathfinder,
        input.pathfinderModule,
      );
      control.throwIfAborted();
      return;
    case "drop1":
      await dropToFoot({
        bot: input.bot,
        target: input.action.toFoot,
        timeoutMs: DROP_IDLE_TIMEOUT_MS,
        lookTimeoutMs: LOOK_TIMEOUT_MS,
        diagnosticPrefix: "mine",
        actionKind: input.action.kind,
        diagnostics: input.diagnostics,
        throwIfAborted: () => control.throwIfAborted(),
      });
      control.throwIfAborted();
      return;
    case "jumpUp":
      await stepForward(
        input.bot,
        input.action.toFoot,
        { jump: true, kind: input.action.kind },
        MOVE_IDLE_TIMEOUT_MS,
        input.diagnostics,
        control,
        input.pathfinder,
        input.pathfinderModule,
      );
      control.throwIfAborted();
      return;
    case "digWalk":
      for (const dig of input.action.digs) {
        control.throwIfAborted();
        await digSingleBlock(input.bot, input.facts, dig, input.diagnostics, control);
      }
      await stepForward(
        input.bot,
        input.action.toFoot,
        { jump: false, kind: input.action.kind },
        MOVE_IDLE_TIMEOUT_MS,
        input.diagnostics,
        control,
        input.pathfinder,
        input.pathfinderModule,
      );
      control.throwIfAborted();
      return;
    case "digStepDown":
      for (const dig of input.action.digs) {
        control.throwIfAborted();
        await digSingleBlock(input.bot, input.facts, dig, input.diagnostics, control);
      }
      await dropToFoot({
        bot: input.bot,
        target: input.action.toFoot,
        timeoutMs: DROP_IDLE_TIMEOUT_MS,
        lookTimeoutMs: LOOK_TIMEOUT_MS,
        diagnosticPrefix: "mine",
        actionKind: input.action.kind,
        diagnostics: input.diagnostics,
        throwIfAborted: () => control.throwIfAborted(),
      });
      control.throwIfAborted();
      return;
    case "digStepUp":
      for (const dig of input.action.digs) {
        control.throwIfAborted();
        await digSingleBlock(input.bot, input.facts, dig, input.diagnostics, control);
      }
      await stepForward(
        input.bot,
        input.action.toFoot,
        { jump: true, kind: input.action.kind },
        MOVE_IDLE_TIMEOUT_MS,
        input.diagnostics,
        control,
        input.pathfinder,
        input.pathfinderModule,
      );
      control.throwIfAborted();
      return;
  }
}

/** 判定 bot 是否已抵达目标 foot block 的中心格区。 */
export function isBotAtFoot(bot: MineActionBot, target: MineBlockPos): boolean {
  return isFootStepBotAtFoot(bot, target);
}

async function digSingleBlock(
  bot: MineActionBot,
  facts: MineBlockFactReader,
  pos: MineBlockPos,
  diagnostics: string[],
  control: SkillExecutionControl,
): Promise<void> {
  const block = readMineflayerBlockAt(bot, pos);
  if (block === null || block === undefined) return;
  const name = facts.normalizeName(block.name);
  if (facts.isAirBlock(block)) return;
  if (typeof bot.canDigBlock === "function" && !bot.canDigBlock(block)) {
    throw new Error(`mine_dig_out_of_reach:${name}:${posLabel(pos)}`);
  }

  await prepareHandForMineDig({
    bot,
    facts,
    blockName: name,
    diagnostics,
    withTimeout: withMineActionTimeout,
  });
  await withMineActionTimeout(
    Promise.resolve(bot.lookAt?.(centerOfBlock(pos), true)),
    LOOK_TIMEOUT_MS,
    `mine_look_timeout:dig:${posLabel(pos)}`,
  );
  await waitForPromiseOrCondition({
    promise: Promise.resolve(bot.dig?.(block)),
    condition: () => isBlockChanged(facts, readMineflayerBlockAt(bot, pos), name),
    idleTimeoutMs: DIG_IDLE_TIMEOUT_MS,
    pollMs: POLL_MS,
    timeoutMessage: () => `mine_dig_timeout:${name}:${posLabel(pos)}`,
    throwIfAborted: () => control.throwIfAborted(),
    diagnostics,
    diagnosticPrefix: `mine_dig:${name}:${posLabel(pos)}`,
  });
  await waitUntilBlockChanged(bot, facts, pos, name);
  diagnostics.push(`mine_dig_verified:${name}:${posLabel(pos)}`);
}

async function stepForward(
  bot: MineActionBot,
  target: MineBlockPos,
  options: { readonly jump: boolean; readonly kind: MineRouteAction["kind"] },
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
      diagnosticPrefix: "mine",
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
    diagnosticPrefix: "mine",
    actionKind: options.kind,
    diagnostics,
  });
}

function centerOfBlock(pos: MineBlockPos): Vec3 {
  return new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
}

function posLabel(pos: MineBlockPos): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

async function waitUntilBlockChanged(
  bot: MineActionBot,
  facts: MineBlockFactReader,
  pos: MineBlockPos,
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
  throw new Error(`mine_dig_no_effect:${originalName}:${posLabel(pos)}`);
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

async function withMineActionTimeout<T>(
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
