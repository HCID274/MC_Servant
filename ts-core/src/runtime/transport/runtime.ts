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
  let removeDimensionBoundsListeners: (() => void) | null = null;
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
        removeDimensionBoundsListeners = attachMineflayerDimensionBoundsSync(bot);
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
    removeDimensionBoundsListeners?.();
    removeDimensionBoundsListeners = null;
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

interface MineflayerDimensionBounds {
  readonly minY: number;
  readonly height: number;
}

/** 为 Mineflayer（Minecraft 协议客户端） 同步真实维度高度边界，避免 Multiworld（多世界） 下区块 Y 轴错位。 */
export function attachMineflayerDimensionBoundsSync(bot: MineflayerBotHandle): () => void {
  const client = bot._client;

  if (client === undefined || typeof client.on !== "function") {
    return () => undefined;
  }

  const syncFromPacket = (packet: unknown): void => {
    scheduleDimensionBoundsSync(bot, packet);
  };

  client.on("login", syncFromPacket);
  client.on("respawn", syncFromPacket);
  scheduleDimensionBoundsSync(bot, undefined);

  return () => {
    client.off?.("login", syncFromPacket);
    client.off?.("respawn", syncFromPacket);
    client.removeListener?.("login", syncFromPacket);
    client.removeListener?.("respawn", syncFromPacket);
  };
}

function scheduleDimensionBoundsSync(bot: MineflayerBotHandle, packet: unknown): void {
  const sync = (): void => {
    syncDimensionBounds(bot, packet);
  };

  sync();
  queueMicrotask(sync);
  setTimeout(sync, 0);
}

function syncDimensionBounds(bot: MineflayerBotHandle, packet: unknown): void {
  const dimensionType = readPacketDimensionType(packet);
  const bounds =
    readDimensionBoundsFromValue(readRecordValue(packet, "dimension")) ??
    findRegistryDimensionBounds(bot.registry, dimensionType);

  if (bounds === undefined || bot.game === undefined) {
    return;
  }

  bot.game.minY = bounds.minY;
  bot.game.height = bounds.height;
}

function findRegistryDimensionBounds(
  registry: unknown,
  dimensionType: string | undefined,
): MineflayerDimensionBounds | undefined {
  const registryRecord = asRecord(registry);
  const dimensionsByName = asRecord(registryRecord?.dimensionsByName);
  const names = createDimensionLookupNames(dimensionType);

  for (const name of names) {
    const bounds = readDimensionBoundsFromValue(dimensionsByName?.[name]);

    if (bounds !== undefined) {
      return bounds;
    }
  }

  return undefined;
}

function createDimensionLookupNames(dimensionType: string | undefined): readonly string[] {
  if (dimensionType === undefined) {
    return Object.freeze([]);
  }

  const names = [dimensionType];
  const namespaceSeparatorIndex = dimensionType.indexOf(":");

  if (namespaceSeparatorIndex !== -1) {
    names.push(dimensionType.slice(namespaceSeparatorIndex + 1));
  }

  return Object.freeze(names);
}

function readPacketDimensionType(packet: unknown): string | undefined {
  const dimension = readRecordValue(packet, "dimension");

  if (typeof dimension === "string" && dimension.includes(":")) {
    return dimension;
  }

  const worldType = readRecordValue(packet, "worldType");

  if (typeof worldType === "string" && worldType.includes(":")) {
    return worldType;
  }

  return undefined;
}

function readDimensionBoundsFromValue(value: unknown): MineflayerDimensionBounds | undefined {
  const record = asRecord(value);

  if (record === undefined) {
    return undefined;
  }

  const minY = readRecordNumber(record, "minY") ?? readRecordNumber(record, "min_y");
  const height = readRecordNumber(record, "height");

  if (minY === undefined || height === undefined) {
    return undefined;
  }

  return Object.freeze({ minY, height });
}

function readRecordNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRecordValue(value: unknown, key: string): unknown {
  return asRecord(value)?.[key];
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
