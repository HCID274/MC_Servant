import type {
  EquipmentSummary,
  EquippedItemSummary,
  InventorySummary,
  MineflayerObservationInput,
  NearbyBlockSummary,
  NearbyEntityKind,
  NearbyEntitySummary,
  OwnerSnapshot,
  SnapshotPosition,
  WorldTimeSnapshot,
} from "../../core-ports/observation.js";
import type {
  ResourceRefreshRadius,
  RuntimeResourceBlockSemanticRole,
  RuntimeResourceBlockSummary,
  RuntimeResourceRefreshResult,
} from "../../core-ports/runtime.js";
import type {
  CollectSkillParams,
  CraftCapabilityParams,
  EquipSkillParams,
  GoToSkillParams,
  MineSkillExecutionRequest,
  PlaceCapabilityParams,
  SkillExecutionControl,
  ToolchainEnsureFacts,
  ToolchainEnsureInventoryItem,
  ToolchainMaterialSource,
} from "../../core-ports/skills.js";
import { NOOP_SKILL_EXECUTION_CONTROL } from "../../core-ports/skills.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../../domain/invariants.js";
import { attachMineflayerBlockWorldCompatibility } from "./block-world-compat.js";
import { executeMineflayerCollect } from "./collect.js";
import { executeMineflayerCraft } from "./craft.js";
import type { CraftingTablePlacementCache } from "./crafting-table.js";
import { executeMineflayerDigBlockAt } from "./dig-block.js";
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
import { readMineflayerWorldKey } from "./naming.js";
import { createMineflayerPathfinderContext } from "./pathfinder.js";
import { executeMineflayerPlaceCraftingTable } from "./placement.js";
import type {
  MineflayerBlockHandle,
  MineflayerBotHandle,
  MineflayerEntityHandle,
  MineflayerEventSource,
  MineflayerItemHandle,
  MineflayerRuntimeTransport,
  MineflayerRuntimeTransportDependencies,
  MineflayerTransportDescriptor,
  MineflayerTransportSnapshot,
  MineflayerTransportState,
  MineflayerVec3Like,
} from "./types.js";
import { attachMineflayerEntityVelocityCompatibility } from "./velocity-compat.js";
import { canReadMineflayerBlockAt, readMineflayerBlockAt } from "./world-reader.js";
import {
  attachMineflayerWorldStateReset,
  stopMineflayerActiveControl,
} from "./world-state-reset.js";

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
  let removeWorldStateResetListener: (() => void) | null = null;
  let spawned = false;
  let pathfinderLoaded = false;
  const craftingTableCache: CraftingTablePlacementCache = { position: null };
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
        removeWorldStateResetListener = attachMineflayerWorldStateReset(bot);
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
    async goTo(
      params: Readonly<GoToSkillParams>,
      control: SkillExecutionControl = NOOP_SKILL_EXECUTION_CONTROL,
    ) {
      control.throwIfAborted();
      const currentBot = ensureWorldInteractionReady("goTo");
      const { pathfinder, pathfinderModule } = await createPathfinderContext(currentBot);
      return executeMineflayerGoTo({
        bot: currentBot,
        pathfinder,
        pathfinderModule,
        params,
        worldKey: createMineflayerWorldKey(currentBot),
        control,
      });
    },
    async mine(
      params: Readonly<MineSkillExecutionRequest>,
      control: SkillExecutionControl = NOOP_SKILL_EXECUTION_CONTROL,
    ) {
      control.throwIfAborted();
      const currentBot = ensureWorldInteractionReady("mine");
      const { pathfinder, pathfinderModule } = await createPathfinderContext(currentBot);
      return executeMineflayerMine({
        bot: currentBot,
        pathfinder,
        pathfinderModule,
        params: { ...params, worldKey: createMineflayerWorldKey(currentBot) },
        control,
      });
    },
    async digBlockAt(
      position: Readonly<MineflayerVec3Like>,
      control: SkillExecutionControl = NOOP_SKILL_EXECUTION_CONTROL,
    ) {
      control.throwIfAborted();
      const currentBot = ensureWorldInteractionReady("digBlockAt");
      const { pathfinder, pathfinderModule } = await createPathfinderContext(currentBot);
      await executeMineflayerDigBlockAt({
        bot: currentBot,
        pathfinder,
        pathfinderModule,
        position,
        control,
      });
      control.throwIfAborted();
    },
    async collect(
      params: Readonly<CollectSkillParams>,
      control: SkillExecutionControl = NOOP_SKILL_EXECUTION_CONTROL,
    ) {
      control.throwIfAborted();
      const currentBot = ensureWorldInteractionReady("collect");
      const { pathfinder, pathfinderModule } = await createPathfinderContext(currentBot);
      return executeMineflayerCollect({
        bot: currentBot,
        pathfinder,
        pathfinderModule,
        params,
        worldKey: createMineflayerWorldKey(currentBot),
        control,
      });
    },
    async equip(
      params: Readonly<EquipSkillParams>,
      control: SkillExecutionControl = NOOP_SKILL_EXECUTION_CONTROL,
    ) {
      control.throwIfAborted();
      const currentBot = ensureWorldInteractionReady("equip");
      return executeMineflayerEquip({
        bot: currentBot,
        params,
        worldKey: createMineflayerWorldKey(currentBot),
      });
    },
    async craft(
      params: Readonly<CraftCapabilityParams>,
      control: SkillExecutionControl = NOOP_SKILL_EXECUTION_CONTROL,
    ) {
      control.throwIfAborted();
      const currentBot = ensureWorldInteractionReady("craft");
      return executeMineflayerCraft({
        bot: currentBot,
        params,
        worldKey: createMineflayerWorldKey(currentBot),
        craftingTableCache,
      });
    },
    async place(
      params: Readonly<PlaceCapabilityParams>,
      control: SkillExecutionControl = NOOP_SKILL_EXECUTION_CONTROL,
    ) {
      control.throwIfAborted();
      const currentBot = ensureWorldInteractionReady("place");
      const { pathfinder, pathfinderModule } = await createPathfinderContext(currentBot);
      return executeMineflayerPlaceCraftingTable({
        bot: currentBot,
        pathfinder,
        pathfinderModule,
        params,
        worldKey: createMineflayerWorldKey(currentBot),
        cache: craftingTableCache,
        control,
      });
    },
    createToolchainEnsureFacts(): ToolchainEnsureFacts {
      return createMineflayerToolchainEnsureFacts({
        getBot: getReadOnlyWorldReadyBot,
      });
    },
    stopCurrentAction(): void {
      if (bot === null || state !== "connected") {
        return;
      }

      stopMineflayerActiveControl(bot);
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
    getCurrentWorldKey(): string {
      return bot === null ? "unknown" : createMineflayerWorldKey(bot);
    },
    countInventoryItemsBySemanticRole(role: RuntimeResourceBlockSemanticRole): number {
      const currentBot = getReadOnlyWorldReadyBot();

      if (currentBot === null) {
        return 0;
      }

      return countMineflayerInventoryItemsBySemanticRole(currentBot, role);
    },
    readObservationInput(ownerName?: string): MineflayerObservationInput | null {
      const currentBot = getReadOnlyWorldReadyBot();

      if (currentBot === null) {
        return null;
      }

      return createMineflayerObservationInput({
        bot: currentBot,
        ...(ownerName === undefined ? {} : { ownerName }),
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
    removeWorldStateResetListener?.();
    removeWorldStateResetListener = null;
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
    skill: "goTo" | "mine" | "digBlockAt" | "collect" | "equip" | "craft" | "place",
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

  if (typeof input.bot.findBlocks !== "function" || !canReadMineflayerBlockAt(input.bot)) {
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
    .map((position) => readMineflayerBlockAt(input.bot, position))
    .filter((block): block is MineflayerBlockHandle => block !== null && block !== undefined)
    .filter((block) => blockMatchesResourceKey(input.bot, block, input.resourceKey))
    .map((block) =>
      createRuntimeResourceBlockSummary({
        bot: input.bot,
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
  readonly bot: MineflayerBotHandle;
  readonly block: MineflayerBlockHandle;
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly resourceKey: string;
}): RuntimeResourceBlockSummary {
  const position = input.block.position ?? input.origin;
  const targetDiagnostics: string[] = [];
  const isDiggable = canDigRuntimeResourceBlock(input.bot.registry, input.block, targetDiagnostics);
  const isReachable = canReachRuntimeResourceBlock(input.bot, input.block, targetDiagnostics);

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
    resource_tags: createRuntimeResourceTags(input.bot.registry, input.block),
    semantic_roles: createRuntimeResourceSemanticRoles(input.bot.registry, input.block),
    is_diggable: isDiggable,
    is_reachable: isReachable,
    target_diagnostics: targetDiagnostics,
  });
}

function createMineflayerWorldKey(bot: MineflayerBotHandle): string {
  return readMineflayerWorldKey(bot);
}

/** 从 Mineflayer（Minecraft 协议客户端） 当前状态创建 observation（观测）输入。 */
function createMineflayerObservationInput(input: {
  readonly bot: MineflayerBotHandle;
  readonly ownerName?: string;
}): MineflayerObservationInput {
  const now = Date.now();
  const botState = readMineflayerBotState(input.bot);

  return cloneReadonlyValue({
    timestamp: now,
    snapshot_version: `${botState.world_key}:${now}:mineflayer-live`,
    bot: botState,
    inventory: readMineflayerInventory(input.bot),
    equipment: readMineflayerEquipment(input.bot),
    nearby_entities: readMineflayerNearbyEntities(input.bot, botState.position),
    nearby_blocks: readMineflayerNearbyBlocks(input.bot, botState.position),
    ...(input.ownerName === undefined
      ? {}
      : { owner: readMineflayerOwner(input.bot, input.ownerName, botState.position) }),
    time: readMineflayerTime(input.bot),
  });
}

function readMineflayerBotState(bot: MineflayerBotHandle): MineflayerObservationInput["bot"] {
  const position = bot.entity?.position ?? { x: 0, y: 0, z: 0 };
  const botRecord = asPlainRecord(bot);
  const entityRecord = asPlainRecord(bot.entity);
  const velocityRecord = asPlainRecord(bot.entity?.velocity);

  return {
    position: createSnapshotPosition(position),
    world_key: createMineflayerWorldKey(bot),
    health: readNumber(botRecord.health, 20),
    food: readNumber(botRecord.food, 20),
    experience: readExperiencePoints(botRecord.experience),
    is_on_fire: readBoolean(entityRecord.isOnFire, readNumber(entityRecord.fire, 0) > 0),
    is_in_water: readBoolean(entityRecord.isInWater, false),
    y_velocity: readNumber(velocityRecord.y, 0),
  };
}

function readMineflayerInventory(bot: MineflayerBotHandle): InventorySummary {
  const items = (bot.inventory?.items() ?? [])
    .map((item, index) => createInventoryItemSummary(item, index))
    .filter((item): item is InventorySummary["items"][number] => item !== null);
  const totalItems = items.reduce((sum, item) => sum + item.count, 0);
  const freeSlots = bot.inventory?.emptySlotCount?.() ?? Math.max(0, 36 - items.length);

  return {
    items,
    total_items: totalItems,
    occupied_slots: items.length,
    free_slots: freeSlots,
  };
}

function createInventoryItemSummary(
  item: MineflayerItemHandle,
  fallbackSlot: number,
): InventorySummary["items"][number] | null {
  if (item.name === undefined || item.name.length === 0) {
    return null;
  }

  return {
    slot: fallbackSlot,
    item_name: item.name,
    count: item.count ?? 1,
  };
}

function readMineflayerEquipment(bot: MineflayerBotHandle): EquipmentSummary {
  const slots = bot.inventory?.slots ?? [];

  return {
    head: createEquippedItemSummary("head", slots[5] ?? null),
    chest: createEquippedItemSummary("chest", slots[6] ?? null),
    legs: createEquippedItemSummary("legs", slots[7] ?? null),
    feet: createEquippedItemSummary("feet", slots[8] ?? null),
    main_hand: createEquippedItemSummary("main_hand", bot.heldItem ?? null),
    off_hand: createEquippedItemSummary("off_hand", slots[45] ?? null),
    has_weapon_equipped: bot.heldItem?.name !== undefined,
  };
}

function createEquippedItemSummary(
  slot: EquippedItemSummary["slot"],
  item: MineflayerItemHandle | null | undefined,
): EquippedItemSummary | null {
  if (item?.name === undefined || item.name.length === 0) {
    return null;
  }

  return {
    slot,
    item_name: item.name,
    count: item.count ?? 1,
  };
}

function readMineflayerNearbyEntities(
  bot: MineflayerBotHandle,
  origin: SnapshotPosition,
): readonly NearbyEntitySummary[] {
  const botEntityId = bot.entity?.id;

  return Object.values(bot.entities ?? {})
    .filter((entity): entity is MineflayerEntityHandle => entity !== undefined)
    .filter((entity) => entity.position !== undefined && entity.id !== botEntityId)
    .map((entity) => createNearbyEntitySummary(entity, origin))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 16);
}

function createNearbyEntitySummary(
  entity: MineflayerEntityHandle,
  origin: SnapshotPosition,
): NearbyEntitySummary {
  const position = createSnapshotPosition(entity.position ?? origin);
  const kind = inferNearbyEntityKind(entity);
  const name = entity.username ?? entity.displayName ?? entity.name ?? "unknown";

  return {
    entity_id: String(entity.id ?? name),
    entity_type: entity.name ?? entity.objectType ?? "unknown",
    kind,
    display_name: name,
    position,
    distance: getDistance(origin, position),
  };
}

function inferNearbyEntityKind(entity: MineflayerEntityHandle): NearbyEntityKind {
  if (entity.username !== undefined || entity.name === "player") {
    return "player";
  }

  return "other";
}

function readMineflayerNearbyBlocks(
  bot: MineflayerBotHandle,
  origin: SnapshotPosition,
): readonly NearbyBlockSummary[] {
  if (!canReadMineflayerBlockAt(bot)) {
    return [];
  }

  return createNearbyBlockSamplePositions(origin)
    .map((position) => readMineflayerBlockAt(bot, position))
    .filter((block): block is MineflayerBlockHandle => block !== null && block !== undefined)
    .filter((block) => block.name !== undefined && block.name !== "air")
    .map((block) => createNearbyBlockSummary(block, origin))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 5);
}

function createNearbyBlockSamplePositions(origin: SnapshotPosition): readonly SnapshotPosition[] {
  const x = Math.floor(origin.x);
  const y = Math.floor(origin.y);
  const z = Math.floor(origin.z);

  return [
    { x, y: y - 1, z },
    { x: x + 1, y, z },
    { x: x - 1, y, z },
    { x, y, z: z + 1 },
    { x, y, z: z - 1 },
    { x: x + 1, y: y - 1, z },
    { x: x - 1, y: y - 1, z },
    { x, y: y - 1, z: z + 1 },
    { x, y: y - 1, z: z - 1 },
  ];
}

function createNearbyBlockSummary(
  block: MineflayerBlockHandle,
  origin: SnapshotPosition,
): NearbyBlockSummary {
  const position = createSnapshotPosition(block.position ?? origin);

  return {
    block_name: block.name ?? "unknown",
    position,
    distance: getDistance(origin, position),
  };
}

function readMineflayerOwner(
  bot: MineflayerBotHandle,
  ownerName: string,
  origin: SnapshotPosition,
): OwnerSnapshot {
  const playerEntity = readMineflayerPlayerEntity(bot, ownerName);

  if (playerEntity?.position === undefined) {
    return {
      name: ownerName,
      online: false,
      position: origin,
    };
  }

  return {
    name: ownerName,
    online: true,
    position: createSnapshotPosition(playerEntity.position),
  };
}

function readMineflayerPlayerEntity(
  bot: MineflayerBotHandle,
  ownerName: string,
): MineflayerEntityHandle | null {
  const players = asPlainRecord(asPlainRecord(bot).players);
  const player = asPlainRecord(players[ownerName]);
  const entity = player.entity;

  if (entity === undefined || entity === null || typeof entity !== "object") {
    return null;
  }

  return entity as MineflayerEntityHandle;
}

function readMineflayerTime(bot: MineflayerBotHandle): WorldTimeSnapshot {
  const time = asPlainRecord(asPlainRecord(bot).time);
  const timeOfDay = typeof time.timeOfDay === "number" ? time.timeOfDay : null;
  const phase = typeof time.isDay === "boolean" ? (time.isDay ? "day" : "night") : "unknown";

  return {
    phase,
    time_of_day: timeOfDay,
  };
}

function readExperiencePoints(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  return readNumber(asPlainRecord(value).points, 0);
}

function createSnapshotPosition(position: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): SnapshotPosition {
  return {
    x: position.x,
    y: position.y,
    z: position.z,
  };
}

function getDistance(left: SnapshotPosition, right: SnapshotPosition): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function blockMatchesResourceKey(
  bot: MineflayerBotHandle,
  block: MineflayerBlockHandle,
  resourceKey: string,
): boolean {
  const blockName = block.name ?? "";
  const normalizedResourceKey = stripMinecraftNamespace(resourceKey);
  const lookupNames = createResourceKeyLookupNames(resourceKey);

  if (
    lookupNames.some((name) => blockName === name || blockName === stripMinecraftNamespace(name))
  ) {
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

  return (
    registryTagValues.some((value) => value === block.type || value === block.name) ||
    blockMatchesRuntimeResourceFact(registry, block, resourceKey)
  );
}

function createRuntimeResourceSemanticRoles(
  registry: unknown,
  block: MineflayerBlockHandle,
): readonly RuntimeResourceBlockSemanticRole[] {
  return blockHasRuntimeResourceTag(registry, block, "logs") ||
    blockMatchesRuntimeResourceFact(registry, block, "tree")
    ? Object.freeze(["cut_tree_log"] as const)
    : Object.freeze([]);
}

function countMineflayerInventoryItemsBySemanticRole(
  bot: MineflayerBotHandle,
  role: RuntimeResourceBlockSemanticRole,
): number {
  const matchingItemIds = createInventoryItemIdsForSemanticRole(bot.registry, role);

  if (matchingItemIds.size === 0) {
    return 0;
  }

  return (bot.inventory?.items() ?? []).reduce(
    (sum, item) =>
      item.type !== undefined && matchingItemIds.has(item.type) ? sum + (item.count ?? 1) : sum,
    0,
  );
}

function createMineflayerToolchainEnsureFacts(source: {
  readonly getBot: () => MineflayerBotHandle | null;
}): ToolchainEnsureFacts {
  return Object.freeze({
    resolveRequiredEquipment(
      input: Parameters<ToolchainEnsureFacts["resolveRequiredEquipment"]>[0],
    ) {
      const bot = source.getBot();
      const blockName = readStringValue(input.failure.params.blockName);
      if (bot === null || blockName === null) {
        return null;
      }

      return resolveRequiredEquipmentFromRegistry(bot, blockName, input.inventory);
    },
    resolveMaterialSource(input: Parameters<ToolchainEnsureFacts["resolveMaterialSource"]>[0]) {
      const bot = source.getBot();
      return bot === null ? null : resolveMaterialSourceFromRegistry(bot.registry, input.itemName);
    },
    canCraft(input: Parameters<ToolchainEnsureFacts["canCraft"]>[0]) {
      const bot = source.getBot();
      return bot === null ? false : canCraftItemByName(bot, input.itemName);
    },
    resolveCraftingTableBlockName() {
      const bot = source.getBot();
      const registryRecord = asRecord(bot?.registry);
      const blocksByName = asRecord(registryRecord?.blocksByName);
      const table = asRecord(blocksByName?.crafting_table);
      const name = readStringValue(table?.name);
      return name ?? (table === undefined ? null : "crafting_table");
    },
    resolveBlockDropItemNames(
      input: Parameters<ToolchainEnsureFacts["resolveBlockDropItemNames"]>[0],
    ) {
      const bot = source.getBot();
      return bot === null
        ? Object.freeze([])
        : resolveBlockDropItemNamesFromRegistry(bot.registry, input.blockName);
    },
    countInventoryItemsByTag(
      input: Parameters<ToolchainEnsureFacts["countInventoryItemsByTag"]>[0],
    ) {
      const bot = source.getBot();
      return bot === null
        ? 0
        : countInventoryItemsByRegistryTag(bot.registry, input.tagName, input.inventory);
    },
  });
}

function resolveRequiredEquipmentFromRegistry(
  bot: MineflayerBotHandle,
  blockName: string,
  inventory: readonly ToolchainEnsureInventoryItem[],
): string | null {
  const allowedToolIds = readRequiredHarvestToolIdsFromRegistry(bot.registry, blockName);
  if (allowedToolIds.length === 0) {
    return null;
  }

  const candidates = allowedToolIds.flatMap((itemId) => {
    const itemName = readRegistryItemName(bot.registry, itemId);
    return itemName === null ? [] : [itemName];
  });
  if (candidates.length === 0) {
    return null;
  }

  const inventoryCounts = new Map(
    inventory.map((item) => [normalizeEnsureName(item.item_name), item.count] as const),
  );
  const inventoryCandidate = candidates.find(
    (itemName) => (inventoryCounts.get(normalizeEnsureName(itemName)) ?? 0) > 0,
  );
  if (inventoryCandidate !== undefined) {
    return inventoryCandidate;
  }

  return candidates.find((itemName) => canCraftItemByName(bot, itemName)) ?? candidates[0] ?? null;
}

function resolveMaterialSourceFromRegistry(
  registry: unknown,
  itemName: string,
): ToolchainMaterialSource | null {
  const normalizedItemName = normalizeEnsureName(itemName);
  const item = readRegistryItemFactByName(registry, normalizedItemName);
  if (item === undefined) {
    return null;
  }

  const candidates = readRegistryBlockFacts(registry)
    .filter((block) => readRegistryBlockDropIds(block).includes(item.id))
    .sort((left, right) => compareMaterialSourceBlocks(left, right, normalizedItemName));
  const logCandidate = candidates.find((block) => isCutTreeLogLikeBlockFact(block));
  if (logCandidate !== undefined) {
    const blockName = readStringValue(logCandidate.name);
    return Object.freeze({
      action: "cutTree" as const,
      itemName: normalizedItemName,
      ...(blockName === null ? {} : { blockName: normalizeEnsureName(blockName) }),
    });
  }

  const sourceBlock = candidates[0];
  const sourceBlockName = readStringValue(sourceBlock?.name);
  return sourceBlockName === null
    ? null
    : Object.freeze({
        action: "mine" as const,
        itemName: normalizedItemName,
        blockName: normalizeEnsureName(sourceBlockName),
      });
}

function resolveBlockDropItemNamesFromRegistry(
  registry: unknown,
  blockName: string,
): readonly string[] {
  const block = readRegistryBlockFactByName(registry, blockName);
  const dropNames = readRegistryBlockDropIds(block ?? {})
    .map((dropId) => readRegistryItemName(registry, dropId))
    .filter((name): name is string => name !== null);
  if (dropNames.length > 0) {
    return Object.freeze([...new Set(dropNames.map(normalizeEnsureName))]);
  }

  const item = readRegistryItemFactByName(registry, blockName);
  return item?.name === undefined
    ? Object.freeze([normalizeEnsureName(blockName)])
    : Object.freeze([normalizeEnsureName(item.name)]);
}

function countInventoryItemsByRegistryTag(
  registry: unknown,
  tagName: string,
  inventory: readonly ToolchainEnsureInventoryItem[],
): number {
  const matchingItemIds = createInventoryItemIdsForRegistryBlockTag(registry, tagName);
  if (matchingItemIds.size === 0) {
    return 0;
  }

  return inventory.reduce((sum, item) => {
    const fact = readRegistryItemFactByName(registry, item.item_name);
    return fact !== undefined && matchingItemIds.has(fact.id) ? sum + item.count : sum;
  }, 0);
}

function compareMaterialSourceBlocks(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  itemName: string,
): number {
  const leftName = normalizeEnsureName(readStringValue(left.name) ?? "");
  const rightName = normalizeEnsureName(readStringValue(right.name) ?? "");
  const leftSame = leftName === itemName ? 1 : 0;
  const rightSame = rightName === itemName ? 1 : 0;
  if (leftSame !== rightSame) {
    return leftSame - rightSame;
  }

  const leftDiggable = readBoolean(left.diggable, false) ? 0 : 1;
  const rightDiggable = readBoolean(right.diggable, false) ? 0 : 1;
  if (leftDiggable !== rightDiggable) {
    return leftDiggable - rightDiggable;
  }

  return (
    readNumber(left.id, Number.MAX_SAFE_INTEGER) - readNumber(right.id, Number.MAX_SAFE_INTEGER)
  );
}

function canCraftItemByName(bot: MineflayerBotHandle, itemName: string): boolean {
  if (typeof bot.recipesAll !== "function" && typeof bot.recipesFor !== "function") {
    return false;
  }

  return resolveCraftCandidateItemIds(bot.registry, itemName).some((itemId) => {
    const allRecipes = bot.recipesAll?.(itemId, null, true) ?? [];
    const readyRecipes = bot.recipesFor?.(itemId, null, 1, true) ?? [];
    return allRecipes.length > 0 || readyRecipes.length > 0;
  });
}

function resolveCraftCandidateItemIds(registry: unknown, itemName: string): readonly number[] {
  const normalized = normalizeEnsureName(itemName);
  const item = readRegistryItemFactByName(registry, normalized);
  return item === undefined ? Object.freeze([]) : Object.freeze([item.id]);
}

function readRequiredHarvestToolIdsFromRegistry(
  registry: unknown,
  blockName: string,
): readonly number[] {
  const block = readRegistryBlockFactByName(registry, blockName);
  const harvestTools = asRecord(block?.harvestTools);
  if (harvestTools === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    Object.keys(harvestTools)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value))
      .sort((left, right) => left - right),
  );
}

function readRegistryBlockFacts(registry: unknown): readonly Readonly<Record<string, unknown>>[] {
  const registryRecord = asRecord(registry);
  const blocksByName = asRecord(registryRecord?.blocksByName);
  return blocksByName === undefined
    ? Object.freeze([])
    : Object.freeze(
        Object.values(blocksByName).flatMap((value) => {
          const record = asRecord(value);
          return record === undefined ? [] : [record];
        }),
      );
}

function readRegistryBlockFactByName(
  registry: unknown,
  blockName: string,
): Readonly<Record<string, unknown>> | undefined {
  const registryRecord = asRecord(registry);
  const blocksByName = asRecord(registryRecord?.blocksByName);
  return asRecord(blocksByName?.[normalizeEnsureName(blockName)]);
}

function readRegistryItemFactByName(
  registry: unknown,
  itemName: string,
): Readonly<{ readonly id: number; readonly name?: string }> | undefined {
  const registryRecord = asRecord(registry);
  const itemsByName = asRecord(registryRecord?.itemsByName);
  const item = asRecord(itemsByName?.[normalizeEnsureName(itemName)]);
  const id = readNumber(item?.id, Number.NaN);
  return Number.isInteger(id)
    ? ({
        ...item,
        id,
        ...(readStringValue(item?.name) === null ? {} : { name: readStringValue(item?.name) }),
      } as Readonly<{ readonly id: number; readonly name?: string }>)
    : undefined;
}

function readRegistryItemName(registry: unknown, itemId: number): string | null {
  const registryRecord = asRecord(registry);
  const items = asRecord(registryRecord?.items);
  const item = asRecord(items?.[String(itemId)] ?? items?.[itemId]);
  const name = readStringValue(item?.name);
  return name === null ? null : normalizeEnsureName(name);
}

function normalizeEnsureName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/u, "")
    .replace(/[\s-]+/gu, "_");
}

function readStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function createInventoryItemIdsForSemanticRole(
  registry: unknown,
  role: RuntimeResourceBlockSemanticRole,
): ReadonlySet<number> {
  if (role !== "cut_tree_log") {
    return new Set();
  }

  const itemIds = new Set<number>();
  const registryRecord = asRecord(registry);
  const blocksByName = asRecord(registryRecord?.blocksByName);
  const itemsByName = asRecord(registryRecord?.itemsByName);

  if (blocksByName === undefined) {
    return itemIds;
  }

  for (const blockFact of Object.values(blocksByName)) {
    const fact = asRecord(blockFact);
    if (fact === undefined || !isCutTreeLogLikeBlockFact(fact)) {
      continue;
    }

    for (const dropId of readRegistryBlockDropIds(fact)) {
      itemIds.add(dropId);
    }

    const blockName = typeof fact.name === "string" ? fact.name : null;
    const itemFact = blockName === null ? undefined : asRecord(itemsByName?.[blockName]);
    const itemId = readNumber(itemFact?.id, Number.NaN);
    if (Number.isInteger(itemId)) {
      itemIds.add(itemId);
    }
  }

  return itemIds;
}

function createInventoryItemIdsForRegistryBlockTag(
  registry: unknown,
  tagName: string,
): ReadonlySet<number> {
  const normalizedTagName = normalizeEnsureName(tagName);
  const itemIds = new Set<number>();
  const registryRecord = asRecord(registry);
  const blocksByName = asRecord(registryRecord?.blocksByName);
  const itemsByName = asRecord(registryRecord?.itemsByName);

  if (blocksByName === undefined) {
    return itemIds;
  }

  for (const blockFact of Object.values(blocksByName)) {
    const fact = asRecord(blockFact);
    if (fact === undefined || !registryBlockHasTag(registry, fact, normalizedTagName)) {
      continue;
    }

    for (const dropId of readRegistryBlockDropIds(fact)) {
      itemIds.add(dropId);
    }

    const blockName = typeof fact.name === "string" ? normalizeEnsureName(fact.name) : null;
    const itemFact = blockName === null ? undefined : asRecord(itemsByName?.[blockName]);
    const itemId = readNumber(itemFact?.id, Number.NaN);
    if (Number.isInteger(itemId)) {
      itemIds.add(itemId);
    }
  }

  return itemIds;
}

function registryBlockHasTag(
  registry: unknown,
  blockFact: Readonly<Record<string, unknown>>,
  normalizedTagName: string,
): boolean {
  const directTags = readBlockDirectTags(blockFact.tags as MineflayerBlockHandle["tags"]);
  if (directTags.has(normalizedTagName)) {
    return true;
  }

  const blockId = readNumber(blockFact.id, Number.NaN);
  if (!Number.isInteger(blockId)) {
    return false;
  }

  const blockTags = asRecord(asRecord(asRecord(registry)?.tags)?.blocks);
  const values = normalizeRegistryTagValue(blockTags?.[normalizedTagName]);
  return values.includes(blockId);
}

function readRegistryBlockDropIds(fact: Readonly<Record<string, unknown>>): readonly number[] {
  return Array.isArray(fact.drops)
    ? Object.freeze(fact.drops.filter((dropId): dropId is number => Number.isInteger(dropId)))
    : Object.freeze([]);
}

function canDigRuntimeResourceBlock(
  registry: unknown,
  block: MineflayerBlockHandle,
  diagnostics: string[],
): boolean {
  if (block.diggable === false) {
    diagnostics.push("not_diggable");
    return false;
  }

  if (block.diggable === true) {
    return true;
  }

  const fact = readRegistryBlockFact(registry, block);
  if (readBoolean(fact?.diggable, false)) {
    return true;
  }

  diagnostics.push("diggable_fact_unavailable");
  return false;
}

function canReachRuntimeResourceBlock(
  bot: MineflayerBotHandle,
  block: MineflayerBlockHandle,
  diagnostics: string[],
): boolean {
  if (typeof bot.canSeeBlock === "function") {
    const canSee = bot.canSeeBlock(block);

    if (!canSee) {
      diagnostics.push("line_of_sight_blocked");
      diagnostics.push("reachability_deferred_to_skill");
    }

    return true;
  }

  diagnostics.push("reachability_deferred_to_skill");
  return true;
}

function createRuntimeResourceTags(
  registry: unknown,
  block: MineflayerBlockHandle,
): readonly string[] {
  const tags = new Set(readBlockDirectTags(block.tags));
  const registryRecord = asRecord(registry);
  const blockTags =
    asRecord(registryRecord?.blockTags) ??
    asRecord(registryRecord?.blocksByTag) ??
    asRecord(asRecord(registryRecord?.tags)?.blocks);

  if (blockTags !== undefined) {
    for (const [tagName, value] of Object.entries(blockTags)) {
      const entries = normalizeRegistryTagValue(value);

      if (entries.some((entry) => entry === block.type || entry === block.name)) {
        tags.add(tagName);
      }
    }
  }

  return Object.freeze([...tags].sort());
}

function registryCanResolveResourceKey(registry: unknown, resourceKey: string): boolean {
  const registryRecord = asRecord(registry);
  const blocksByName = asRecord(registryRecord?.blocksByName);

  return (
    createResourceKeyLookupNames(resourceKey).some((name) => blocksByName?.[name] !== undefined) ||
    getRegistryResourceTagIds(registry, resourceKey).length > 0 ||
    registryCanResolveResourceFact(registry, resourceKey)
  );
}

function blockMatchesRuntimeResourceFact(
  registry: unknown,
  block: MineflayerBlockHandle,
  resourceKey: string,
): boolean {
  const normalizedResourceKey = stripMinecraftNamespace(resourceKey);

  if (normalizedResourceKey !== "tree" && normalizedResourceKey !== "logs") {
    return false;
  }

  const fact = readRegistryBlockFact(registry, block);

  return isCutTreeLogLikeBlockFact(fact);
}

function registryCanResolveResourceFact(registry: unknown, resourceKey: string): boolean {
  const normalizedResourceKey = stripMinecraftNamespace(resourceKey);

  if (normalizedResourceKey !== "tree" && normalizedResourceKey !== "logs") {
    return false;
  }

  const registryRecord = asRecord(registry);
  const blocksByName = asRecord(registryRecord?.blocksByName);

  return blocksByName === undefined
    ? false
    : Object.values(blocksByName).some((fact) => isCutTreeLogLikeBlockFact(asRecord(fact)));
}

function readRegistryBlockFact(
  registry: unknown,
  block: MineflayerBlockHandle,
): Record<string, unknown> | undefined {
  const registryRecord = asRecord(registry);
  const blocksByName = asRecord(registryRecord?.blocksByName);
  const blocksById = asRecord(registryRecord?.blocks);
  const blockName = block.name;

  if (blockName !== undefined && blockName.length > 0) {
    const byName = asRecord(blocksByName?.[blockName]);

    if (byName !== undefined) {
      return byName;
    }
  }

  if (block.type !== undefined) {
    return asRecord(blocksById?.[String(block.type)] ?? blocksById?.[block.type]);
  }

  return undefined;
}

function isCutTreeLogLikeBlockFact(fact: Record<string, unknown> | undefined): boolean {
  if (fact === undefined) {
    return false;
  }

  const material = fact.material;
  const states = Array.isArray(fact.states) ? fact.states : [];
  const hasAxisState = states.some((state) => {
    const stateRecord = asRecord(state);

    return stateRecord?.name === "axis";
  });

  return material === "mineable/axe" && hasAxisState && readBoolean(fact.diggable, true);
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

  for (const alias of readRuntimeResourceKeyAliases(resourceKey)) {
    names.add(alias);
    names.add(stripMinecraftNamespace(alias));

    if (!alias.includes(":")) {
      names.add(`minecraft:${alias}`);
    }
  }

  return Object.freeze([...names]);
}

function readRuntimeResourceKeyAliases(resourceKey: string): readonly string[] {
  const normalizedResourceKey = stripMinecraftNamespace(resourceKey);

  return normalizedResourceKey === "tree" ? Object.freeze(["logs"] as const) : Object.freeze([]);
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
