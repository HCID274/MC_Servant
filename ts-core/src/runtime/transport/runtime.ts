import type {
  ResourceRefreshRadius,
  RuntimeResourceBlockSemanticRole,
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
} from "../../core-ports/skills.js";
import { NOOP_SKILL_EXECUTION_CONTROL } from "../../core-ports/skills.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../../domain/invariants.js";
import { attachMineflayerBlockWorldCompatibility } from "./block-world-compat.js";
import { executeMineflayerCollect } from "./collect.js";
import { executeMineflayerCraft } from "./craft.js";
import type { CraftingTablePlacementCache } from "./crafting-table.js";
import { executeMineflayerDigBlockAt } from "./dig-block.js";
import { executeMineflayerEquip } from "./equip.js";
import {
  countMineflayerInventoryItemsBySemanticRole,
  createMineflayerToolchainEnsureFacts,
} from "./facts/index.js";
import { executeMineflayerGoTo } from "./go-to.js";
import {
  attachRuntimeStateListeners,
  createDefaultMineflayerBot,
  createMineflayerCreateBotOptions,
  createReadonlyMineflayerEventSource,
  stringifyMineflayerError,
  waitForMineflayerSpawn,
} from "./lifecycle.js";
import { executeMineflayerMine } from "./mining/index.js";
import { readMineflayerWorldKey } from "./naming.js";
import { createMineflayerPathfinderContext } from "./pathfinder.js";
import { executeMineflayerPlaceCraftingTable } from "./placement.js";
import { shouldExcludeTerrainResourceBlock } from "./terrain/index.js";
import type {
  MineflayerBotHandle,
  MineflayerEventSource,
  MineflayerRuntimeTransport,
  MineflayerRuntimeTransportDependencies,
  MineflayerTransportDescriptor,
  MineflayerTransportSnapshot,
  MineflayerTransportState,
  MineflayerVec3Like,
} from "./types.js";
import { attachMineflayerEntityVelocityCompatibility } from "./velocity-compat.js";
import {
  attachMineflayerDimensionBoundsSync,
  attachMineflayerWorldStateReset,
  createMineflayerObservationInput,
  createRuntimeUnavailableResourceRefreshResult,
  executeMineflayerResourceRefresh,
  stopMineflayerActiveControl,
} from "./world/index.js";

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
        shouldExcludeBlock: (block) =>
          block.position === undefined
            ? false
            : shouldExcludeTerrainResourceBlock(currentBot, block.position),
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
    readObservationInput(ownerName?: string) {
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
    } catch (error) {
      // 清理路径不能覆盖连接失败或上层关闭的真实原因。
      console.warn("[runtime-transport] bot close cleanup failed", {
        reason,
        error_summary: summarizeError(error),
      });
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

function createMineflayerWorldKey(bot: MineflayerBotHandle): string {
  return readMineflayerWorldKey(bot);
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
