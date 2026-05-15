import type { SkillExecutionControl } from "../../core-ports/skills.js";
import { createMineBlockFactReader } from "./block-facts.js";
import { navigateTerrainToFoot } from "./terrain/index.js";
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

/** 坐标挖掘需要的 Mineflayer（Minecraft 协议客户端） 能力端口。 */
export type MineflayerDigBlockAtPort = MineflayerMovementPort &
  MineflayerMiningPort &
  MineflayerPlacementPort &
  MineflayerInventoryPort;

const DIG_APPROACH_RANGE = 2;
const DIG_APPROACH_Y_RANGE = 2;
const DIRECT_DIG_FALLBACK_REACH = 4.5;

/** 挖掘指定坐标的单个方块；调用方负责决定该坐标来自哪个资源簇。 */
export async function executeMineflayerDigBlockAt(input: {
  readonly bot: MineflayerDigBlockAtPort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly position: Readonly<MineflayerVec3Like>;
  readonly control: SkillExecutionControl;
}): Promise<void> {
  input.control.throwIfAborted();
  if (!canReadMineflayerBlockAt(input.bot)) {
    throw new Error("Mineflayer bot handle does not expose blockAt for digBlockAt");
  }
  if (typeof input.bot.dig !== "function") {
    throw new Error("Mineflayer bot handle does not expose dig for digBlockAt");
  }
  input.pathfinder.stop?.();
  input.pathfinder.setGoal?.(null);
  void input.pathfinderModule;

  const block = readMineflayerBlockAt(input.bot, input.position);

  if (block === null || block === undefined) {
    throw new Error("Mineflayer cannot load target block for digBlockAt");
  }

  if (canDigTargetFromCurrentPosition(input.bot, block, input.position)) {
    await input.bot.dig(block);
    input.control.throwIfAborted();
    return;
  }

  await approachDigTarget(input);
  input.control.throwIfAborted();
  const currentBlock = readMineflayerBlockAt(input.bot, input.position);

  if (currentBlock === null || currentBlock === undefined) {
    throw new Error("Mineflayer cannot load target block after digBlockAt approach");
  }
  if (!canDigTargetFromCurrentPosition(input.bot, currentBlock, input.position)) {
    throw createDigBlockError(
      `dig_block_target_out_of_reach_after_approach:${formatPosition(input.position)}`,
      input.position,
      Object.freeze([]),
    );
  }

  await input.bot.dig(currentBlock);
  input.control.throwIfAborted();
}

/** 接近挖掘目标：通过地形导航移动到目标附近，使目标进入挖掘范围。 */
async function approachDigTarget(input: {
  readonly bot: MineflayerDigBlockAtPort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly position: Readonly<MineflayerVec3Like>;
  readonly control: SkillExecutionControl;
}): Promise<void> {
  void input.pathfinder;
  void input.pathfinderModule;
  const diagnostics: string[] = [];
  const facts = createMineBlockFactReader(input.bot.registry);
  try {
    await navigateTerrainToFoot({
      bot: input.bot,
      facts,
      targetFoot: resolveDigApproachFoot(input.position),
      goalRange: DIG_APPROACH_RANGE,
      goalYRange: DIG_APPROACH_Y_RANGE,
      allowPlaceUp: true,
      allowDig: true,
      diagnostics,
      diagnosticPrefix: "dig_block",
      control: input.control,
    });
  } catch (error) {
    throw withDigBlockApproachDetails(error, input.position, diagnostics);
  }
}

/** 计算挖掘目标的脚位坐标（向下取整）。 */
function resolveDigApproachFoot(position: Readonly<MineflayerVec3Like>): {
  readonly x: number;
  readonly y: number;
  readonly z: number;
} {
  return Object.freeze({
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  });
}

/** 判断当前 Bot 位置是否可以直接挖掘目标（无需移动）。 */
function canDigTargetFromCurrentPosition(
  bot: MineflayerDigBlockAtPort,
  block: MineflayerBlockHandle,
  fallbackPosition: Readonly<MineflayerVec3Like>,
): boolean {
  if (typeof bot.canDigBlock === "function") {
    return bot.canDigBlock(block);
  }

  const botPosition = bot.entity?.position;
  const blockPosition = block.position ?? fallbackPosition;
  if (botPosition === undefined) {
    return false;
  }

  return (
    Math.hypot(
      blockPosition.x + 0.5 - botPosition.x,
      blockPosition.y + 0.5 - (botPosition.y + 1.65),
      blockPosition.z + 0.5 - botPosition.z,
    ) <= DIRECT_DIG_FALLBACK_REACH
  );
}

/** 在错误上附加挖掘目标的详细信息，便于诊断。 */
function withDigBlockApproachDetails(
  error: unknown,
  position: Readonly<MineflayerVec3Like>,
  diagnostics: readonly string[],
): Error {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  return createDigBlockError(wrapped.message, position, diagnostics, wrapped);
}

/** 创建挖掘方块的结构化错误，携带错误码、目标坐标和诊断信息。 */
function createDigBlockError(
  message: string,
  position: Readonly<MineflayerVec3Like>,
  diagnostics: readonly string[],
  cause?: Error,
): Error {
  const wrapped = cause ?? new Error(message);
  const enriched = wrapped as Error & {
    error_code?: string;
    details?: Readonly<Record<string, unknown>>;
  };
  if (enriched.message !== message) {
    enriched.message = message;
  }
  enriched.error_code = "unreachable_target";
  const existingDetails =
    typeof enriched.details === "object" && enriched.details !== null ? enriched.details : {};
  enriched.details = Object.freeze({
    ...existingDetails,
    failure_stage: "digBlockAt",
    target_block: Object.freeze({
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
    }),
    diagnostics: Object.freeze([...diagnostics]),
  });
  return enriched;
}

/** 坐标格式化为整数字符串（x,y,z）。 */
function formatPosition(position: Readonly<MineflayerVec3Like>): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}
