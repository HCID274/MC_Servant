import { Vec3 } from "vec3";
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
const FOOT_STEP_MOVE_SETTLE_MS = 120;
const FOOT_STEP_HORIZONTAL_STOP_DISTANCE = 0.45;
const FOOT_STEP_OVERSHOOT_MARGIN = 0.35;

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
  const startedAt = Date.now();
  let bestHorizontal = readHorizontalDistance(bot, target);
  input.diagnostics?.push(
    `${input.diagnosticPrefix}_move_start:${input.actionKind}:target=${posLabel(target)};from=${positionLabel(bot.entity?.position)};jump=${input.jump}`,
  );

  try {
    while (!isFootStepBotAtFoot(bot, target)) {
      assertFootStepNotTimedOut(input, startedAt, bestHorizontal);
      await withFootStepTimeout(
        Promise.resolve(bot.lookAt?.(centerOfFootTarget(target), true)),
        input.lookTimeoutMs,
        `${input.diagnosticPrefix}_look_timeout:move:${posLabel(target)}`,
      );

      for (const control of controls) bot.setControlState(control, true);
      const pulseStartedAt = Date.now();
      try {
        while (!isFootStepBotAtFoot(bot, target)) {
          assertFootStepNotTimedOut(input, startedAt, bestHorizontal);
          const horizontal = readHorizontalDistance(bot, target);
          if (horizontal < bestHorizontal) bestHorizontal = horizontal;
          if (isFootStepYMatched(bot, target) && horizontal <= FOOT_STEP_HORIZONTAL_STOP_DISTANCE) {
            break;
          }
          if (horizontal > bestHorizontal + FOOT_STEP_OVERSHOOT_MARGIN) break;
          if (Date.now() - pulseStartedAt >= FOOT_STEP_MOVE_PULSE_MS) break;
          await delay(FOOT_STEP_POLL_MS);
        }
      } finally {
        for (const control of controls) bot.setControlState(control, false);
        bot.clearControlStates?.();
      }

      if (isFootStepBotAtFoot(bot, target)) break;
      await delay(FOOT_STEP_MOVE_SETTLE_MS);
    }
    input.diagnostics?.push(
      `${input.diagnosticPrefix}_move_reached:${input.actionKind}:target=${posLabel(target)};elapsed_ms=${Date.now() - startedAt};pos=${positionLabel(bot.entity?.position)}`,
    );
  } finally {
    for (const control of controls) bot.setControlState(control, false);
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

function assertFootStepNotTimedOut(
  input: {
    readonly bot: FootStepBot;
    readonly target: FootStepBlockPos;
    readonly timeoutMs: number;
    readonly diagnosticPrefix: string;
  },
  startedAt: number,
  bestHorizontal: number,
): void {
  if (Date.now() - startedAt < input.timeoutMs) return;
  throw new Error(
    `${input.diagnosticPrefix}_step_timeout:${posLabel(input.target)}:current=${positionLabel(input.bot.entity?.position)};best_horizontal=${bestHorizontal.toFixed(2)};target_y=${input.target.y};current_y=${currentFootYLabel(input.bot)};y_matched=${isFootStepYMatched(input.bot, input.target)}`,
  );
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

function isFootStepYMatched(bot: FootStepBot, target: FootStepBlockPos): boolean {
  const pos = bot.entity?.position;
  return pos !== undefined && Math.floor(pos.y) === target.y;
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
