import { Vec3 } from "vec3";
import { createProgressWatchdog } from "./progress-watchdog.js";
import type {
  MineflayerControlState,
  MineflayerMovementPort,
  MineflayerPlacementPort,
} from "./types.js";

export interface FootStepBlockPos {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

type FootStepBot = MineflayerMovementPort & Pick<MineflayerPlacementPort, "lookAt">;

const FOOT_STEP_POLL_MS = 50;
const FOOT_STEP_MOVE_PULSE_MS = 350;
const FOOT_STEP_NEAR_PULSE_MS = 120;
const FOOT_STEP_MICRO_PULSE_MS = 60;
const FOOT_STEP_MOVE_SETTLE_MS = 120;
const FOOT_STEP_HORIZONTAL_STOP_DISTANCE = 0.45;
const FOOT_STEP_OVERSHOOT_MARGIN = 0.35;
const FOOT_STEP_PROGRESS_EPSILON = 0.05;
const FOOT_CENTER_TOLERANCE = 0.28;
const FOOT_CENTER_PULSE_MS = 35;
const FOOT_CENTER_SETTLE_MS = 50;
const FOOT_CENTER_OVERSHOOT_MARGIN = 0.06;

/** 判定 bot 是否已经处在目标 foot block 内，并接近该格中心。 */
export function isFootStepBotAtFoot(bot: FootStepBot, target: FootStepBlockPos): boolean {
  const pos = bot.entity?.position;
  if (pos === undefined) return false;
  return (
    Math.floor(pos.x) === target.x &&
    Math.floor(pos.y) === target.y &&
    Math.floor(pos.z) === target.z &&
    readHorizontalDistance(bot, target) <= 0.8
  );
}

/** 判定 bot 是否已经处在目标 foot block 内，并足够接近该格中心。 */
export function isFootStepBotAtFootCenter(
  bot: FootStepBot,
  target: FootStepBlockPos,
  tolerance = FOOT_CENTER_TOLERANCE,
): boolean {
  return isSameFootCell(bot, target) && readHorizontalDistance(bot, target) <= tolerance;
}

/**
 * 低级脚位移动原语。
 *
 * 使用短脉冲前进 + 水平距离回退保护，避免 Mineflayer 控制键长按时越过目标后继续跑远。
 */
export async function stepToFoot(input: {
  readonly bot: FootStepBot;
  readonly target: FootStepBlockPos;
  readonly jump: boolean;
  readonly timeoutMs: number;
  readonly lookTimeoutMs: number;
  readonly diagnosticPrefix: string;
  readonly actionKind: string;
  readonly diagnostics?: string[];
}): Promise<void> {
  const { bot, target } = input;
  if (isFootStepBotAtFoot(bot, target)) return;
  if (typeof bot.setControlState !== "function") {
    throw new Error(`${input.diagnosticPrefix}_control_unavailable:setControlState`);
  }

  const controls: MineflayerControlState[] = ["forward"];
  if (input.jump) controls.push("jump");
  let bestHorizontal = readHorizontalDistance(bot, target);
  input.diagnostics?.push(
    `${input.diagnosticPrefix}_move_start:${input.actionKind}:target=${posLabel(target)};from=${positionLabel(bot.entity?.position)};jump=${input.jump}`,
  );
  const watchdog = createProgressWatchdog({
    idleTimeoutMs: input.timeoutMs,
    readProgress: () => readPositionProgress(bot),
    isProgressAdvanced: isPositionProgressAdvanced,
    describeProgress: describePositionProgress,
    createTimeoutMessage: ({ idleMs, lastProgress, currentProgress }) =>
      `${input.diagnosticPrefix}_step_stuck_timeout:${posLabel(input.target)}:current=${positionLabel(input.bot.entity?.position)};idle_ms=${idleMs};last_progress=${describePositionProgress(lastProgress)};current_progress=${describePositionProgress(currentProgress)};best_horizontal=${bestHorizontal.toFixed(2)};target_y=${input.target.y};current_y=${currentFootYLabel(input.bot)};y_matched=${isFootStepYMatched(input.bot, input.target)}`,
    diagnosticPrefix: input.diagnosticPrefix,
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
  });

  try {
    while (!isFootStepBotAtFoot(bot, target)) {
      watchdog.assertAlive();
      await withFootStepTimeout(
        Promise.resolve(bot.lookAt?.(centerOfFootTarget(target), true)),
        input.lookTimeoutMs,
        `${input.diagnosticPrefix}_look_timeout:move:${posLabel(target)}`,
      );

      for (const control of controls) bot.setControlState(control, true);
      const pulseStartedAt = Date.now();
      try {
        while (!isFootStepBotAtFoot(bot, target)) {
          watchdog.assertAlive();
          const horizontal = readHorizontalDistance(bot, target);
          if (horizontal < bestHorizontal) bestHorizontal = horizontal;
          if (isFootStepYMatched(bot, target) && horizontal <= FOOT_STEP_HORIZONTAL_STOP_DISTANCE) {
            break;
          }
          if (horizontal > bestHorizontal + FOOT_STEP_OVERSHOOT_MARGIN) break;
          if (Date.now() - pulseStartedAt >= readStepPulseMs(horizontal)) break;
          await delay(FOOT_STEP_POLL_MS);
        }
      } finally {
        for (const control of controls) bot.setControlState(control, false);
        bot.clearControlStates?.();
      }

      if (isFootStepBotAtFoot(bot, target)) break;
      watchdog.markProgressIfAdvanced();
      await delay(FOOT_STEP_MOVE_SETTLE_MS);
    }
    input.diagnostics?.push(
      `${input.diagnosticPrefix}_move_reached:${input.actionKind}:target=${posLabel(target)};elapsed_ms=${Date.now() - watchdog.startedAt};pos=${positionLabel(bot.entity?.position)}`,
    );
  } finally {
    for (const control of controls) bot.setControlState(control, false);
    bot.clearControlStates?.();
  }
}

/** 执行一格下落：先以 Y 到达为完成下落的信号，再用低速脚位移动纠偏 X/Z。 */
export async function dropToFoot(input: {
  readonly bot: FootStepBot;
  readonly target: FootStepBlockPos;
  readonly timeoutMs: number;
  readonly lookTimeoutMs: number;
  readonly diagnosticPrefix: string;
  readonly actionKind: string;
  readonly diagnostics?: string[];
  readonly throwIfAborted?: () => void;
}): Promise<void> {
  const { bot, target } = input;
  if (isFootStepBotAtFoot(bot, target)) return;
  if (typeof bot.setControlState !== "function") {
    throw new Error(`${input.diagnosticPrefix}_control_unavailable:setControlState`);
  }

  input.diagnostics?.push(
    `${input.diagnosticPrefix}_drop_start:${input.actionKind}:target=${posLabel(target)};from=${positionLabel(bot.entity?.position)}`,
  );
  const watchdog = createProgressWatchdog({
    idleTimeoutMs: input.timeoutMs,
    readProgress: () => readPositionProgress(bot),
    isProgressAdvanced: isPositionProgressAdvanced,
    describeProgress: describePositionProgress,
    createTimeoutMessage: ({ idleMs, lastProgress, currentProgress }) =>
      `${input.diagnosticPrefix}_drop_stuck_timeout:${posLabel(input.target)}:current=${positionLabel(input.bot.entity?.position)};idle_ms=${idleMs};last_progress=${describePositionProgress(lastProgress)};current_progress=${describePositionProgress(currentProgress)};target_y=${input.target.y};current_y=${currentFootYLabel(input.bot)};y_matched=${isFootStepYMatched(input.bot, input.target)}`,
    diagnosticPrefix: input.diagnosticPrefix,
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
  });

  try {
    while (!isFootStepYMatched(bot, target)) {
      input.throwIfAborted?.();
      watchdog.assertAlive();
      await withFootStepTimeout(
        Promise.resolve(bot.lookAt?.(centerOfFootTarget(target), true)),
        input.lookTimeoutMs,
        `${input.diagnosticPrefix}_look_timeout:drop:${posLabel(target)}`,
      );

      bot.setControlState("forward", true);
      const pulseStartedAt = Date.now();
      try {
        while (!isFootStepYMatched(bot, target)) {
          input.throwIfAborted?.();
          watchdog.assertAlive();
          if (Date.now() - pulseStartedAt >= FOOT_STEP_MICRO_PULSE_MS) break;
          await delay(FOOT_STEP_POLL_MS);
        }
      } finally {
        bot.setControlState("forward", false);
        bot.clearControlStates?.();
      }

      if (isFootStepYMatched(bot, target)) break;
      watchdog.markProgressIfAdvanced();
      await delay(FOOT_STEP_MOVE_SETTLE_MS);
    }
  } finally {
    bot.setControlState("forward", false);
    bot.clearControlStates?.();
  }

  await waitUntilFootYReachedThenRecover({
    bot,
    target,
    timeoutMs: input.timeoutMs,
    lookTimeoutMs: input.lookTimeoutMs,
    diagnosticPrefix: input.diagnosticPrefix,
    actionKind: input.actionKind,
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
    ...(input.throwIfAborted === undefined ? {} : { throwIfAborted: input.throwIfAborted }),
  });
  input.diagnostics?.push(
    `${input.diagnosticPrefix}_move_reached:${input.actionKind}:target=${posLabel(target)};elapsed_ms=${Date.now() - watchdog.startedAt};pos=${positionLabel(bot.entity?.position)}`,
  );
}

/**
 * 将 bot 精确移动到 foot 中心附近。
 *
 * 这个原语复用 stepToFoot 的回退能力：居中短脉冲一旦把 bot 推出当前 foot，
 * 不再直接失败，而是先回到目标 foot，再继续小步居中。
 */
export async function centerOnFoot(input: {
  readonly bot: FootStepBot;
  readonly target: FootStepBlockPos;
  readonly timeoutMs: number;
  readonly lookTimeoutMs: number;
  readonly diagnosticPrefix: string;
  readonly actionKind: string;
  readonly tolerance?: number;
  readonly diagnostics?: string[];
  readonly throwIfAborted?: () => void;
}): Promise<void> {
  const { bot, target } = input;
  const tolerance = input.tolerance ?? FOOT_CENTER_TOLERANCE;
  if (isFootStepBotAtFootCenter(bot, target, tolerance)) return;
  if (typeof bot.setControlState !== "function") {
    throw new Error(`${input.diagnosticPrefix}_control_unavailable:setControlState`);
  }

  const startedAt = Date.now();
  let bestHorizontal = readHorizontalDistance(bot, target);
  input.diagnostics?.push(
    `${input.diagnosticPrefix}_center_start:${input.actionKind}:target=${posLabel(target)};from=${positionLabel(bot.entity?.position)};tolerance=${tolerance}`,
  );

  try {
    while (!isFootStepBotAtFootCenter(bot, target, tolerance)) {
      input.throwIfAborted?.();
      const remainingMs = input.timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw new Error(
          `${input.diagnosticPrefix}_center_timeout:${posLabel(target)}:current=${positionLabel(bot.entity?.position)}`,
        );
      }

      if (!isSameFootCell(bot, target)) {
        input.diagnostics?.push(
          `${input.diagnosticPrefix}_center_recover_foot:${input.actionKind}:target=${posLabel(target)};current=${positionLabel(bot.entity?.position)}`,
        );
        await stepToFoot({
          bot,
          target,
          jump: false,
          timeoutMs: remainingMs,
          lookTimeoutMs: input.lookTimeoutMs,
          diagnosticPrefix: input.diagnosticPrefix,
          actionKind: `${input.actionKind}_center_recover`,
          ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
        });
        bestHorizontal = readHorizontalDistance(bot, target);
        continue;
      }

      await withFootStepTimeout(
        Promise.resolve(bot.lookAt?.(centerOfFootTarget(target), true)),
        input.lookTimeoutMs,
        `${input.diagnosticPrefix}_look_timeout:center:${posLabel(target)}`,
      );

      bot.setControlState("forward", true);
      const pulseStartedAt = Date.now();
      try {
        while (!isFootStepBotAtFootCenter(bot, target, tolerance)) {
          input.throwIfAborted?.();
          if (!isSameFootCell(bot, target)) break;
          const horizontal = readHorizontalDistance(bot, target);
          if (horizontal < bestHorizontal) bestHorizontal = horizontal;
          if (horizontal > bestHorizontal + FOOT_CENTER_OVERSHOOT_MARGIN) break;
          if (Date.now() - pulseStartedAt >= FOOT_CENTER_PULSE_MS) break;
          await delay(FOOT_STEP_POLL_MS);
        }
      } finally {
        bot.setControlState("forward", false);
        bot.clearControlStates?.();
      }

      await delay(FOOT_CENTER_SETTLE_MS);
    }

    input.diagnostics?.push(
      `${input.diagnosticPrefix}_center_reached:${input.actionKind}:target=${posLabel(target)};elapsed_ms=${Date.now() - startedAt};pos=${positionLabel(bot.entity?.position)}`,
    );
  } finally {
    bot.setControlState("forward", false);
    bot.clearControlStates?.();
  }
}

/** 等待外部物理过程把 bot 带到目标脚位，例如垫高后服务器同步位置。 */
export async function waitUntilFootReached(input: {
  readonly bot: FootStepBot;
  readonly target: FootStepBlockPos;
  readonly timeoutMs: number;
  readonly diagnosticPrefix: string;
}): Promise<void> {
  const startedAt = Date.now();
  while (!isFootStepBotAtFoot(input.bot, input.target)) {
    if (Date.now() - startedAt >= input.timeoutMs) {
      throw new Error(
        `${input.diagnosticPrefix}_step_timeout:${posLabel(input.target)}:current=${positionLabel(input.bot.entity?.position)}`,
      );
    }
    await delay(FOOT_STEP_POLL_MS);
  }
}

/** 等待 Y 落到目标层；若 X/Z 受物理漂移影响，再复用脚位移动原语纠偏。 */
export async function waitUntilFootYReachedThenRecover(input: {
  readonly bot: FootStepBot;
  readonly target: FootStepBlockPos;
  readonly timeoutMs: number;
  readonly lookTimeoutMs: number;
  readonly diagnosticPrefix: string;
  readonly actionKind: string;
  readonly transitionLabel?: string;
  readonly diagnostics?: string[];
  readonly throwIfAborted?: () => void;
}): Promise<void> {
  const transitionLabel = input.transitionLabel ?? "drop";
  const startedAt = Date.now();
  while (!isFootStepYMatched(input.bot, input.target)) {
    input.throwIfAborted?.();
    if (Date.now() - startedAt >= input.timeoutMs) {
      throw new Error(
        `${input.diagnosticPrefix}_${transitionLabel}_y_timeout:${posLabel(input.target)}:current=${positionLabel(input.bot.entity?.position)}`,
      );
    }
    await delay(FOOT_STEP_POLL_MS);
  }

  input.diagnostics?.push(
    `${input.diagnosticPrefix}_${transitionLabel}_y_reached:${input.actionKind}:target=${posLabel(input.target)};elapsed_ms=${Date.now() - startedAt};pos=${positionLabel(input.bot.entity?.position)}`,
  );
  if (isFootStepBotAtFoot(input.bot, input.target)) return;

  input.diagnostics?.push(
    `${input.diagnosticPrefix}_${transitionLabel}_recover_foot:${input.actionKind}:target=${posLabel(input.target)};current=${positionLabel(input.bot.entity?.position)}`,
  );
  await stepToFoot({
    bot: input.bot,
    target: input.target,
    jump: false,
    timeoutMs: input.timeoutMs,
    lookTimeoutMs: input.lookTimeoutMs,
    diagnosticPrefix: input.diagnosticPrefix,
    actionKind: `${input.actionKind}_${transitionLabel}_recover`,
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
  });
}

function centerOfFootTarget(pos: FootStepBlockPos): Vec3 {
  return new Vec3(pos.x + 0.5, pos.y + 1, pos.z + 0.5);
}

function posLabel(pos: FootStepBlockPos): string {
  return `${pos.x},${pos.y},${pos.z}`;
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

function readHorizontalDistance(bot: FootStepBot, target: FootStepBlockPos): number {
  const pos = bot.entity?.position;
  if (pos === undefined) return Number.POSITIVE_INFINITY;
  return Math.hypot(pos.x - (target.x + 0.5), pos.z - (target.z + 0.5));
}

function isSameFootCell(bot: FootStepBot, target: FootStepBlockPos): boolean {
  const pos = bot.entity?.position;
  if (pos === undefined) return false;
  return (
    Math.floor(pos.x) === target.x &&
    Math.floor(pos.y) === target.y &&
    Math.floor(pos.z) === target.z
  );
}

interface PositionProgress {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function readPositionProgress(bot: FootStepBot): PositionProgress {
  const pos = bot.entity?.position;
  return {
    x: pos?.x ?? Number.NaN,
    y: pos?.y ?? Number.NaN,
    z: pos?.z ?? Number.NaN,
  };
}

function isPositionProgressAdvanced(
  previous: PositionProgress,
  current: PositionProgress,
): boolean {
  if (!Number.isFinite(previous.x) || !Number.isFinite(current.x)) return false;
  return (
    Math.hypot(current.x - previous.x, current.y - previous.y, current.z - previous.z) >=
    FOOT_STEP_PROGRESS_EPSILON
  );
}

function describePositionProgress(progress: PositionProgress): string {
  if (!Number.isFinite(progress.x)) return "unknown";
  return `${progress.x.toFixed(2)},${progress.y.toFixed(2)},${progress.z.toFixed(2)}`;
}

function isFootStepYMatched(bot: FootStepBot, target: FootStepBlockPos): boolean {
  const pos = bot.entity?.position;
  return pos !== undefined && Math.floor(pos.y) === target.y;
}

function readStepPulseMs(horizontal: number): number {
  if (horizontal <= FOOT_STEP_HORIZONTAL_STOP_DISTANCE) return FOOT_STEP_MICRO_PULSE_MS;
  if (horizontal <= 1.2) return FOOT_STEP_NEAR_PULSE_MS;
  return FOOT_STEP_MOVE_PULSE_MS;
}

function currentFootYLabel(bot: FootStepBot): string {
  const pos = bot.entity?.position;
  if (pos === undefined) return "unknown";
  return String(Math.floor(pos.y));
}

async function withFootStepTimeout<T>(
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
