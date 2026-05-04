import type { MineflayerPathfinderGoals, MineflayerPathfinderModule } from "./types.js";

export type GoalBlockConstructor = new (x: number, y: number, z: number) => unknown;
export type GoalNearConstructor = new (x: number, y: number, z: number, range: number) => unknown;
export type GoalNearXZConstructor = new (x: number, z: number, range: number) => unknown;

/** 集中解析 mineflayer-pathfinder（Mineflayer 寻路插件） 的多种真实 goals（目标构造器） 导出形态。 */
export function resolvePathfinderGoals(
  pathfinderModule: MineflayerPathfinderModule,
): Readonly<MineflayerPathfinderGoals> {
  const moduleRecord = asRecord(pathfinderModule);
  const directGoals = readGoals(moduleRecord);
  const defaultGoals = readGoals(asRecord(readRecordValue(moduleRecord, "default")));
  const moduleExportsGoals = readGoals(asRecord(readRecordValue(moduleRecord, "module.exports")));

  return Object.freeze({
    ...(moduleExportsGoals ?? {}),
    ...(defaultGoals ?? {}),
    ...(directGoals ?? {}),
  });
}

export function resolveGoalBlockConstructor(
  pathfinderModule: MineflayerPathfinderModule,
): GoalBlockConstructor {
  const goalConstructor = resolvePathfinderGoals(pathfinderModule).GoalBlock;

  if (typeof goalConstructor !== "function") {
    throw new Error("mineflayer-pathfinder GoalBlock constructor is unavailable");
  }

  return goalConstructor;
}

export function resolveGoalNearConstructor(
  pathfinderModule: MineflayerPathfinderModule,
): GoalNearConstructor {
  const goalConstructor = resolvePathfinderGoals(pathfinderModule).GoalNear;

  if (typeof goalConstructor !== "function") {
    throw new Error("mineflayer-pathfinder GoalNear constructor is unavailable");
  }

  return goalConstructor;
}

export function resolveGoalNearXZConstructor(
  pathfinderModule: MineflayerPathfinderModule,
): GoalNearXZConstructor | undefined {
  const goalConstructor = resolvePathfinderGoals(pathfinderModule).GoalNearXZ;

  return typeof goalConstructor === "function" ? goalConstructor : undefined;
}

function readGoals(
  value: Readonly<Record<string, unknown>> | undefined,
): MineflayerPathfinderGoals | undefined {
  const goals = readRecordValue(value, "goals");

  return isPathfinderGoals(goals) ? goals : undefined;
}

function isPathfinderGoals(value: unknown): value is MineflayerPathfinderGoals {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.GoalBlock === undefined || typeof value.GoalBlock === "function") &&
    (value.GoalNear === undefined || typeof value.GoalNear === "function") &&
    (value.GoalNearXZ === undefined || typeof value.GoalNearXZ === "function")
  );
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function readRecordValue(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
): unknown {
  try {
    return record?.[key];
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
