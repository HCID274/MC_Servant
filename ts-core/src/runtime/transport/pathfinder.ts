import type {
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
} from "./types.js";

/** 为世界交互技能创建 pathfinder（寻路器） 执行上下文。 */
export async function createMineflayerPathfinderContext(input: {
  /** 当前 Bot（机器人） 移动能力端口。 */
  readonly bot: MineflayerMovementPort;
  /** 是否已经加载 pathfinder（寻路器） 插件。 */
  readonly pathfinderLoaded: boolean;
  /** 标记 pathfinder（寻路器） 已加载。 */
  readonly markPathfinderLoaded: () => void;
}): Promise<{
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
}> {
  const pathfinderModule = await loadMineflayerPathfinder();

  if (!input.pathfinderLoaded) {
    if (typeof input.bot.loadPlugin !== "function") {
      throw new Error("Mineflayer bot handle does not expose loadPlugin for pathfinder");
    }

    input.bot.loadPlugin(pathfinderModule.pathfinder);
    input.markPathfinderLoaded();
  }

  if (input.bot.pathfinder === undefined) {
    throw new Error("Mineflayer bot handle does not expose pathfinder after plugin load");
  }

  return {
    pathfinder: input.bot.pathfinder,
    pathfinderModule,
  };
}

/** 动态加载 Mineflayer 寻路插件。 */
async function loadMineflayerPathfinder(): Promise<MineflayerPathfinderModule> {
  return (await import("mineflayer-pathfinder")) as unknown as MineflayerPathfinderModule;
}
