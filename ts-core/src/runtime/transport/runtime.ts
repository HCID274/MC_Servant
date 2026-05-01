import type {
  ResourceRefreshRadius,
  RuntimeResourceBlockSummary,
  RuntimeResourceRefreshResult,
} from "../../core-ports/runtime.js";
import type {
  CollectSkillParams,
  EquipSkillParams,
  GoToSkillParams,
  MineSkillParams,
} from "../../core-ports/skills.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../../domain/invariants.js";
import { attachMineflayerBlockWorldCompatibility } from "./block-world-compat.js";
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
  MineflayerBlockHandle,
  MineflayerBotHandle,
  MineflayerEventSource,
  MineflayerRuntimeTransport,
  MineflayerRuntimeTransportDependencies,
  MineflayerTransportDescriptor,
  MineflayerTransportSnapshot,
  MineflayerTransportState,
} from "./types.js";
import { attachMineflayerEntityVelocityCompatibility } from "./velocity-compat.js";

const DEFAULT_MINEFLAYER_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_RESOURCE_SCAN_COUNT = 512;

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
  let removeBlockWorldCompatibilityListener: (() => void) | null = null;
  let removeDimensionBoundsListeners: (() => void) | null = null;
  let removeVelocityCompatibilityListener: (() => void) | null = null;
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
        removeBlockWorldCompatibilityListener = attachMineflayerBlockWorldCompatibility(bot, {
          worldDimensionMap: descriptor.world_dimension_map,
        });
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
        removeVelocityCompatibilityListener = attachMineflayerEntityVelocityCompatibility(bot);
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
    async refreshAroundBot(
      resourceKey: string,
      radius: ResourceRefreshRadius,
    ): Promise<RuntimeResourceRefreshResult> {
      const currentBot = getReadOnlyWorldReadyBot();

      if (currentBot === null) {
        return createRuntimeUnavailableResourceRefreshResult({
          resourceKey,
          radius,
          worldKey: bot === null ? "unknown" : createMineflayerWorldKey(bot),
          diagnostics:
            state !== "connected" || bot === null
              ? ["runtime_unavailable", "mineflayer_transport_not_connected"]
              : ["runtime_unavailable", "mineflayer_world_not_ready"],
        });
      }

      return executeMineflayerResourceRefresh({
        bot: currentBot,
        resourceKey,
        radius,
      });
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
    removeBlockWorldCompatibilityListener?.();
    removeBlockWorldCompatibilityListener = null;
    removeDimensionBoundsListeners?.();
    removeDimensionBoundsListeners = null;
    removeVelocityCompatibilityListener?.();
    removeVelocityCompatibilityListener = null;
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

  function getReadOnlyWorldReadyBot(): MineflayerBotHandle | null {
    if (state !== "connected" || bot === null) {
      return null;
    }

    if (!spawned && bot.entity?.position === undefined) {
      return null;
    }

    return bot;
  }
}

/** 执行 Mineflayer（Minecraft 协议客户端） 只读资源扫描。 */
async function executeMineflayerResourceRefresh(input: {
  readonly bot: MineflayerBotHandle;
  readonly resourceKey: string;
  readonly radius: ResourceRefreshRadius;
}): Promise<RuntimeResourceRefreshResult> {
  const origin = input.bot.entity?.position;
  const worldKey = createMineflayerWorldKey(input.bot);
  const scannedAt = Date.now();
  const snapshotVersion = `${worldKey}:${scannedAt}:${input.resourceKey}:${input.radius}`;

  if (origin === undefined) {
    return createRuntimeResourceRefreshResult({
      input,
      status: "runtime_unavailable",
      worldKey,
      snapshotVersion,
      scannedAt,
      origin: { x: 0, y: 0, z: 0 },
      blocks: [],
      diagnostics: ["runtime_unavailable", "bot_position_unavailable"],
    });
  }

  if (typeof input.bot.findBlocks !== "function" || typeof input.bot.blockAt !== "function") {
    return createRuntimeResourceRefreshResult({
      input,
      status: "runtime_unavailable",
      worldKey,
      snapshotVersion,
      scannedAt,
      origin,
      blocks: [],
      diagnostics: ["runtime_unavailable", "mineflayer_block_query_unavailable"],
    });
  }

  let positions: readonly { readonly x: number; readonly y: number; readonly z: number }[];

  try {
    positions = await input.bot.findBlocks({
      matching: (block) => blockMatchesResourceKey(input.bot, block, input.resourceKey),
      maxDistance: input.radius,
      count: DEFAULT_RESOURCE_SCAN_COUNT,
    });
  } catch (error) {
    return createRuntimeResourceRefreshResult({
      input,
      status: "runtime_unavailable",
      worldKey,
      snapshotVersion,
      scannedAt,
      origin,
      blocks: [],
      diagnostics: [
        "runtime_unavailable",
        `resource_refresh_failed:${stringifyMineflayerError(error)}`,
      ],
    });
  }

  const blocks = positions
    .map((position) => input.bot.blockAt?.(position))
    .filter((block): block is MineflayerBlockHandle => block !== null && block !== undefined)
    .filter((block) => blockMatchesResourceKey(input.bot, block, input.resourceKey))
    .map((block) =>
      createRuntimeResourceBlockSummary({
        block,
        origin,
        resourceKey: input.resourceKey,
      }),
    )
    .sort((left, right) => left.distance - right.distance);
  const unsupportedResourceKey =
    blocks.length === 0 && !registryCanResolveResourceKey(input.bot.registry, input.resourceKey);

  return createRuntimeResourceRefreshResult({
    input,
    status:
      blocks.length > 0
        ? "found"
        : unsupportedResourceKey
          ? "unsupported_resource_key"
          : "cache_miss",
    worldKey,
    snapshotVersion,
    scannedAt,
    origin,
    blocks,
    diagnostics:
      blocks.length > 0
        ? []
        : unsupportedResourceKey
          ? [`unsupported_resource_key:${input.resourceKey}`]
          : ["cache_miss"],
  });
}

function createRuntimeUnavailableResourceRefreshResult(input: {
  readonly resourceKey: string;
  readonly radius: ResourceRefreshRadius;
  readonly worldKey: string;
  readonly diagnostics: readonly string[];
}): RuntimeResourceRefreshResult {
  const scannedAt = Date.now();

  return cloneReadonlyValue({
    resource_key: input.resourceKey,
    radius: input.radius,
    status: "runtime_unavailable",
    world_key: input.worldKey,
    snapshot_version: `${input.worldKey}:${scannedAt}:${input.resourceKey}:${input.radius}`,
    scanned_at: scannedAt,
    origin: {
      x: 0,
      y: 0,
      z: 0,
    },
    blocks: [],
    diagnostics: input.diagnostics,
  });
}

function createRuntimeResourceRefreshResult(input: {
  readonly input: {
    readonly resourceKey: string;
    readonly radius: ResourceRefreshRadius;
  };
  readonly status: RuntimeResourceRefreshResult["status"];
  readonly worldKey: string;
  readonly snapshotVersion: string;
  readonly scannedAt: number;
  readonly origin: MineflayerBotHandle["entity"] extends { position?: infer TPosition }
    ? NonNullable<TPosition>
    : { readonly x: number; readonly y: number; readonly z: number };
  readonly blocks: readonly RuntimeResourceBlockSummary[];
  readonly diagnostics: readonly string[];
}): RuntimeResourceRefreshResult {
  return cloneReadonlyValue({
    resource_key: input.input.resourceKey,
    radius: input.input.radius,
    status: input.status,
    world_key: input.worldKey,
    snapshot_version: input.snapshotVersion,
    scanned_at: input.scannedAt,
    origin: {
      x: input.origin.x,
      y: input.origin.y,
      z: input.origin.z,
    },
    blocks: input.blocks,
    diagnostics: input.diagnostics,
  });
}

function createRuntimeResourceBlockSummary(input: {
  readonly block: MineflayerBlockHandle;
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly resourceKey: string;
}): RuntimeResourceBlockSummary {
  const position = input.block.position ?? input.origin;

  return cloneReadonlyValue({
    block_name: input.block.name ?? "unknown",
    position: {
      x: position.x,
      y: position.y,
      z: position.z,
    },
    distance: Math.hypot(
      position.x - input.origin.x,
      position.y - input.origin.y,
      position.z - input.origin.z,
    ),
    resource_keys: [input.resourceKey],
  });
}

function createMineflayerWorldKey(bot: MineflayerBotHandle): string {
  return bot.game?.dimension ?? "unknown";
}

function blockMatchesResourceKey(
  bot: MineflayerBotHandle,
  block: MineflayerBlockHandle,
  resourceKey: string,
): boolean {
  const blockName = block.name ?? "";
  const normalizedResourceKey = stripMinecraftNamespace(resourceKey);

  if (blockName === resourceKey || blockName === normalizedResourceKey) {
    return true;
  }

  return blockHasRuntimeResourceTag(bot.registry, block, resourceKey);
}

function blockHasRuntimeResourceTag(
  registry: unknown,
  block: MineflayerBlockHandle,
  resourceKey: string,
): boolean {
  const directTags = readBlockDirectTags(block.tags);
  const tagNames = createResourceKeyLookupNames(resourceKey);

  if (tagNames.some((tag) => directTags.has(tag))) {
    return true;
  }

  const registryTagValues = getRegistryResourceTagIds(registry, resourceKey);

  return registryTagValues.some((value) => value === block.type || value === block.name);
}

function registryCanResolveResourceKey(registry: unknown, resourceKey: string): boolean {
  const registryRecord = asRecord(registry);
  const blocksByName = asRecord(registryRecord?.blocksByName);

  return (
    createResourceKeyLookupNames(resourceKey).some((name) => blocksByName?.[name] !== undefined) ||
    getRegistryResourceTagIds(registry, resourceKey).length > 0
  );
}

function readBlockDirectTags(tags: MineflayerBlockHandle["tags"]): ReadonlySet<string> {
  if (Array.isArray(tags)) {
    return new Set(tags);
  }

  const record = asRecord(tags);

  if (record === undefined) {
    return new Set();
  }

  return new Set(
    Object.entries(record)
      .filter(([, value]) => Boolean(value))
      .map(([key]) => key),
  );
}

function getRegistryResourceTagIds(
  registry: unknown,
  resourceKey: string,
): readonly (number | string)[] {
  const registryRecord = asRecord(registry);
  const blockTags =
    asRecord(registryRecord?.blockTags) ??
    asRecord(registryRecord?.blocksByTag) ??
    asRecord(asRecord(registryRecord?.tags)?.blocks);
  const tagNames = createResourceKeyLookupNames(resourceKey);

  if (blockTags === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    tagNames.flatMap((tagName) => normalizeRegistryTagValue(blockTags[tagName])),
  );
}

function createResourceKeyLookupNames(resourceKey: string): readonly string[] {
  const names = new Set<string>([resourceKey]);
  const normalizedResourceKey = stripMinecraftNamespace(resourceKey);

  names.add(normalizedResourceKey);

  if (!resourceKey.includes(":")) {
    names.add(`minecraft:${resourceKey}`);
  }

  return Object.freeze([...names]);
}

function normalizeRegistryTagValue(value: unknown): readonly (number | string)[] {
  if (Array.isArray(value)) {
    return Object.freeze(
      value.filter(
        (entry): entry is number | string => typeof entry === "number" || typeof entry === "string",
      ),
    );
  }

  const record = asRecord(value);

  if (record === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    Object.entries(record)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([key]) => {
        const numericKey = Number(key);
        return Number.isInteger(numericKey) ? numericKey : key;
      }),
  );
}

function stripMinecraftNamespace(value: string): string {
  return value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
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
