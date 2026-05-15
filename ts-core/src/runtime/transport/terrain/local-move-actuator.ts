import type { SkillExecutionControl } from "../../../core-ports/skills.js";
import { createProgressWatchdog } from "../progress-watchdog.js";
import type {
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderGoals,
  MineflayerPathfinderModule,
  MineflayerPlacementPort,
} from "../types.js";
import { centerOnFoot } from "./foot-step.js";

export interface LocalMoveFoot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const LOCAL_PATHFINDER_IDLE_TIMEOUT_MS = 1_500;
const LOCAL_PATHFINDER_CENTER_TIMEOUT_MS = 1_500;
const LOCAL_PATHFINDER_LOOK_TIMEOUT_MS = 3_000;
const LOCAL_PATHFINDER_POLL_MS = 50;
const LOCAL_PATHFINDER_REACH_DISTANCE = 0.8;
const LOCAL_PATHFINDER_PROGRESS_EPSILON = 0.05;

/**
 * 局部自然移动执行器：只让 mineflayer-pathfinder 处理不改地形的小位移。
 * 失败、超时或无进展时返回 false，由调用方回退到自研按键原语。
 */
export async function tryLocalPathfinderMoveToFoot(input: {
  readonly bot: MineflayerMovementPort & Pick<MineflayerPlacementPort, "lookAt">;
  readonly pathfinder?: MineflayerPathfinderApi;
  readonly pathfinderModule?: MineflayerPathfinderModule;
  readonly target: LocalMoveFoot;
  readonly diagnostics: string[];
  readonly diagnosticPrefix: string;
  readonly actionKind: string;
  readonly control: SkillExecutionControl;
}): Promise<boolean> {
  input.control.throwIfAborted();
  const pathfinder = input.pathfinder ?? input.bot.pathfinder;
  const pathfinderModule = input.pathfinderModule;
  const GoalBlock = resolveGoalBlock(pathfinderModule);
  if (
    pathfinder === undefined ||
    typeof pathfinder.goto !== "function" ||
    pathfinderModule === undefined ||
    GoalBlock === undefined ||
    input.bot.registry === undefined
  ) {
    input.diagnostics.push(
      `${input.diagnosticPrefix}_local_pathfinder_skipped:${input.actionKind}:unavailable`,
    );
    return false;
  }

  const goal = new GoalBlock(input.target.x, input.target.y, input.target.z);
  let settled = false;
  let rejected: unknown = null;
  const startedAt = Date.now();
  input.diagnostics.push(
    `${input.diagnosticPrefix}_local_pathfinder_start:${input.actionKind}:target=${posLabel(input.target)};from=${positionLabel(input.bot.entity?.position)}`,
  );

  try {
    const movements = new pathfinderModule.Movements(input.bot, input.bot.registry);
    configureNaturalMovements(movements);
    pathfinder.setMovements?.(movements);

    Promise.resolve(pathfinder.goto(goal)).then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        rejected = error;
      },
    );

    const watchdog = createProgressWatchdog({
      idleTimeoutMs: LOCAL_PATHFINDER_IDLE_TIMEOUT_MS,
      readProgress: () => readPositionProgress(input.bot),
      isProgressAdvanced: isPositionProgressAdvanced,
      describeProgress: describePositionProgress,
      createTimeoutMessage: ({ idleMs, currentProgress }) =>
        `${input.diagnosticPrefix}_local_pathfinder_stuck:${input.actionKind}:target=${posLabel(input.target)};current=${describePositionProgress(currentProgress)};idle_ms=${idleMs}`,
      diagnosticPrefix: input.diagnosticPrefix,
      diagnostics: input.diagnostics,
    });

    while (!isBotAtFoot(input.bot, input.target)) {
      input.control.throwIfAborted();
      watchdog.assertAlive();
      if (rejected !== null) {
        input.diagnostics.push(
          `${input.diagnosticPrefix}_local_pathfinder_failed:${input.actionKind}:${sanitizeDiagnostic(getErrorMessage(rejected))}`,
        );
        return false;
      }
      if (settled) break;
      await delay(LOCAL_PATHFINDER_POLL_MS);
    }

    if (isBotAtFoot(input.bot, input.target)) {
      await centerOnFoot({
        bot: input.bot,
        target: input.target,
        timeoutMs: LOCAL_PATHFINDER_CENTER_TIMEOUT_MS,
        lookTimeoutMs: LOCAL_PATHFINDER_LOOK_TIMEOUT_MS,
        diagnosticPrefix: input.diagnosticPrefix,
        actionKind: `${input.actionKind}_local_pathfinder_center`,
        diagnostics: input.diagnostics,
        throwIfAborted: () => input.control.throwIfAborted(),
      });
      input.diagnostics.push(
        `${input.diagnosticPrefix}_local_pathfinder_reached:${input.actionKind}:target=${posLabel(input.target)};elapsed_ms=${Date.now() - startedAt};pos=${positionLabel(input.bot.entity?.position)}`,
      );
      return true;
    }

    input.diagnostics.push(
      `${input.diagnosticPrefix}_local_pathfinder_not_reached:${input.actionKind}:target=${posLabel(input.target)};elapsed_ms=${Date.now() - startedAt};pos=${positionLabel(input.bot.entity?.position)}`,
    );
    return false;
  } catch (error) {
    if (shouldPropagateAbort(error, input.control)) {
      throw error;
    }
    input.diagnostics.push(
      `${input.diagnosticPrefix}_local_pathfinder_failed:${input.actionKind}:${sanitizeDiagnostic(getErrorMessage(error))}`,
    );
    return false;
  } finally {
    pathfinder.stop?.();
    pathfinder.setGoal?.(null);
    input.bot.clearControlStates?.();
  }
}

function resolveGoalBlock(
  module: MineflayerPathfinderModule | undefined,
): MineflayerPathfinderGoals["GoalBlock"] | undefined {
  return (
    module?.goals?.GoalBlock ??
    module?.default?.goals?.GoalBlock ??
    module?.["module.exports"]?.goals?.GoalBlock
  );
}

function configureNaturalMovements(movements: unknown): void {
  const mutable = movements as Record<string, unknown>;
  mutable.canDig = false;
  mutable.allow1by1towers = false;
  mutable.scafoldingBlocks = [];
  mutable.digCost = Number.POSITIVE_INFINITY;
  mutable.placeCost = Number.POSITIVE_INFINITY;
}

function isBotAtFoot(bot: MineflayerMovementPort, target: LocalMoveFoot): boolean {
  const pos = bot.entity?.position;
  if (pos === undefined) return false;
  return (
    Math.floor(pos.x) === target.x &&
    Math.floor(pos.y) === target.y &&
    Math.floor(pos.z) === target.z &&
    Math.hypot(pos.x - (target.x + 0.5), pos.z - (target.z + 0.5)) <=
      LOCAL_PATHFINDER_REACH_DISTANCE
  );
}

interface PositionProgress {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function readPositionProgress(bot: MineflayerMovementPort): PositionProgress {
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
    LOCAL_PATHFINDER_PROGRESS_EPSILON
  );
}

function describePositionProgress(progress: PositionProgress): string {
  if (!Number.isFinite(progress.x)) return "unknown";
  return `${progress.x.toFixed(2)},${progress.y.toFixed(2)},${progress.z.toFixed(2)}`;
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

function posLabel(pos: LocalMoveFoot): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function sanitizeDiagnostic(value: string): string {
  return value.replace(/\s+/gu, "_").slice(0, 240);
}

function shouldPropagateAbort(error: unknown, control: SkillExecutionControl): boolean {
  return control.signal.aborted || isAbortError(error);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly name?: unknown }).name === "AbortError"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
