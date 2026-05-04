import { configureGoToMovements } from "./go-to.js";
import type {
  MineflayerMiningPort,
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
  MineflayerVec3Like,
} from "./types.js";
import { canReadMineflayerBlockAt, readMineflayerBlockAt } from "./world-reader.js";

/** 坐标挖掘需要的 Mineflayer（Minecraft 协议客户端） 能力端口。 */
export type MineflayerDigBlockAtPort = MineflayerMovementPort & MineflayerMiningPort;

/** 挖掘指定坐标的单个方块；调用方负责决定该坐标来自哪个资源簇。 */
export async function executeMineflayerDigBlockAt(input: {
  readonly bot: MineflayerDigBlockAtPort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly position: Readonly<MineflayerVec3Like>;
}): Promise<void> {
  if (!canReadMineflayerBlockAt(input.bot)) {
    throw new Error("Mineflayer bot handle does not expose blockAt for digBlockAt");
  }
  if (typeof input.bot.dig !== "function") {
    throw new Error("Mineflayer bot handle does not expose dig for digBlockAt");
  }

  const block = readMineflayerBlockAt(input.bot, input.position);

  if (block === null || block === undefined) {
    throw new Error("Mineflayer cannot load target block for digBlockAt");
  }

  const movements = new input.pathfinderModule.Movements(input.bot, input.bot.registry);
  const GoalNear = resolveGoalNearConstructor(input.pathfinderModule);
  configureGoToMovements(movements);
  input.pathfinder.setMovements?.(movements);
  await input.pathfinder.goto(
    new GoalNear(input.position.x, input.position.y, input.position.z, 1),
  );
  await input.bot.dig(block);
}

function resolveGoalNearConstructor(
  pathfinderModule: MineflayerPathfinderModule,
): new (
  x: number,
  y: number,
  z: number,
  range: number,
) => unknown {
  const moduleRecord = asRecord(pathfinderModule);
  const directGoals = asRecord(readRecordValue(moduleRecord, "goals"));
  const defaultGoals = asRecord(asRecord(readRecordValue(moduleRecord, "default"))?.goals);
  const goalNearConstructor = directGoals?.GoalNear ?? defaultGoals?.GoalNear;

  if (typeof goalNearConstructor !== "function") {
    throw new Error("mineflayer-pathfinder GoalNear constructor is unavailable");
  }

  return goalNearConstructor as new (
    x: number,
    y: number,
    z: number,
    range: number,
  ) => unknown;
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
  if (record === undefined || !Object.prototype.hasOwnProperty.call(record, key)) {
    return undefined;
  }

  try {
    return record[key];
  } catch {
    return undefined;
  }
}
