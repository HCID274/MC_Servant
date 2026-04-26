import type {
  CollectSkillParams,
  EquipSkillParams,
  GoToSkillParams,
  MineSkillParams,
} from "../../core-ports/skills.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../../domain/invariants.js";
import { executeMineflayerCollect } from "./collect.js";
import { executeMineflayerEquip } from "./equip.js";
import { executeMineflayerGoTo } from "./go-to.js";
import {
  attachRuntimeStateListeners,
  createDefaultMineflayerBot,
  createMineflayerCreateBotOptions,
  createReadonlyMineflayerEventSource,
  stringifyMineflayerError,
  waitForMineflayerSpawn,
} from "./lifecycle.js";
import { executeMineflayerMine } from "./mine.js";
import { createMineflayerPathfinderContext } from "./pathfinder.js";
import type {
  MineflayerBotHandle,
  MineflayerEventSource,
  MineflayerRuntimeTransport,
  MineflayerRuntimeTransportDependencies,
  MineflayerTransportDescriptor,
  MineflayerTransportSnapshot,
  MineflayerTransportState,
} from "./types.js";

const DEFAULT_MINEFLAYER_CONNECT_TIMEOUT_MS = 30_000;

/** 创建 Mineflayer 运行时传输工厂。 */
export function createMineflayerRuntimeTransport<TBotId extends string>(
  descriptor: MineflayerTransportDescriptor<TBotId>,
  dependencies: MineflayerRuntimeTransportDependencies = {},
): MineflayerRuntimeTransport<TBotId> {
  let state: MineflayerTransportState = "idle";
  let bot: MineflayerBotHandle | null = null;
  let eventSource: MineflayerEventSource | null = null;
  let lastError: string | null = null;
  let removeRuntimeListeners: (() => void) | null = null;
  let spawned = false;
  let pathfinderLoaded = false;
  const createBot = dependencies.createBot ?? createDefaultMineflayerBot;
  const connectTimeoutMs = dependencies.connectTimeoutMs ?? DEFAULT_MINEFLAYER_CONNECT_TIMEOUT_MS;

  const createSnapshot = (): MineflayerTransportSnapshot<TBotId> =>
    cloneReadonlyValue({
      bot_id: descriptor.bot_id,
      state,
      connected: state === "connected",
      world_ready: spawned || bot?.entity?.position !== undefined,
      descriptor,
      username: bot?.username ?? descriptor.username,
      last_error: lastError,
    });

  return Object.freeze({
    descriptor,
    async connect(): Promise<MineflayerTransportSnapshot<TBotId>> {
      if (state === "connected") {
        return createSnapshot();
      }

      if (state === "connecting") {
        throw new Error("Mineflayer transport is already connecting");
      }

      state = "connecting";
      lastError = null;

      try {
        bot = await createBot(createMineflayerCreateBotOptions(descriptor));
        removeRuntimeListeners = attachRuntimeStateListeners(bot, {
          markSpawned() {
            spawned = true;
          },
          markDisconnected() {
            if (state !== "disconnecting") {
              state = "disconnected";
            }
          },
          markFailed(error) {
            state = "failed";
            lastError = stringifyMineflayerError(error);
          },
        });
        await waitForMineflayerSpawn(bot, connectTimeoutMs);
        state = "connected";
        eventSource = createReadonlyMineflayerEventSource(bot);

        return createSnapshot();
      } catch (error) {
        state = "failed";
        lastError = stringifyMineflayerError(error);
        cleanupMineflayerBot("ts-core connect failed before spawn");
        throw error;
      }
    },
    async disconnect(reason = "ts-core shutdown"): Promise<MineflayerTransportSnapshot<TBotId>> {
      if (state === "idle" || state === "disconnected") {
        state = "disconnected";
        return createSnapshot();
      }

      state = "disconnecting";

      try {
        cleanupMineflayerBot(reason);
      } finally {
        state = "disconnected";
      }

      return createSnapshot();
    },
    async chat(text: string): Promise<void> {
      assertNonEmptyString(text, "chat.text");

      if (state !== "connected" || bot === null) {
        throw new Error("Mineflayer transport must be connected before chat");
      }

      if (typeof bot.chat !== "function") {
        throw new Error("Mineflayer bot handle does not expose chat");
      }

      await bot.chat(text);
    },
    async goTo(params: Readonly<GoToSkillParams>) {
      const currentBot = ensureWorldInteractionReady("goTo");
      const { pathfinder, pathfinderModule } = await createPathfinderContext(currentBot);
      return executeMineflayerGoTo({ bot: currentBot, pathfinder, pathfinderModule, params });
    },
    async mine(params: Readonly<MineSkillParams>) {
      const currentBot = ensureWorldInteractionReady("mine");
      const { pathfinder, pathfinderModule } = await createPathfinderContext(currentBot);
      return executeMineflayerMine({ bot: currentBot, pathfinder, pathfinderModule, params });
    },
    async collect(params: Readonly<CollectSkillParams>) {
      const currentBot = ensureWorldInteractionReady("collect");
      const { pathfinder, pathfinderModule } = await createPathfinderContext(currentBot);
      return executeMineflayerCollect({ bot: currentBot, pathfinder, pathfinderModule, params });
    },
    async equip(params: Readonly<EquipSkillParams>) {
      const currentBot = ensureWorldInteractionReady("equip");
      return executeMineflayerEquip({ bot: currentBot, params });
    },
    getSnapshot(): MineflayerTransportSnapshot<TBotId> {
      return createSnapshot();
    },
    getEventSource(): MineflayerEventSource | null {
      return eventSource;
    },
  });

  function cleanupMineflayerBot(reason: string): void {
    const currentBot = bot;
    removeRuntimeListeners?.();
    removeRuntimeListeners = null;
    bot = null;
    eventSource = null;
    spawned = false;
    pathfinderLoaded = false;

    try {
      currentBot?.quit?.(reason);
      if (!currentBot?.quit) {
        currentBot?.end?.(reason);
      }
    } catch {
      // 清理路径不能覆盖连接失败或上层关闭的真实原因。
    }
  }

  async function createPathfinderContext(currentBot: MineflayerBotHandle) {
    return createMineflayerPathfinderContext({
      bot: currentBot,
      pathfinderLoaded,
      markPathfinderLoaded() {
        pathfinderLoaded = true;
      },
    });
  }

  function ensureWorldInteractionReady(
    skill: "goTo" | "mine" | "collect" | "equip",
  ): MineflayerBotHandle {
    if (state !== "connected" || bot === null) {
      throw new Error(`Mineflayer transport must be connected before ${skill}`);
    }

    if (!spawned && bot.entity?.position === undefined) {
      throw new Error(`Mineflayer transport must reach spawn before ${skill}`);
    }

    return bot;
  }
}
