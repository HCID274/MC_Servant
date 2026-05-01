import type { MineflayerBotHandle } from "./types.js";

interface RespawnWorldPacket {
  dimension?: string;
  worldName?: string;
  worldState?: {
    dimension?: string;
    name?: string;
  };
}

export interface MineflayerBlockWorldCompatibilityOptions {
  readonly worldDimensionMap?: Readonly<Record<string, string>>;
}

interface PrependableProtocolEventSource {
  prependListener?(eventName: string, listener: (packet: unknown) => void): unknown;
  on(eventName: string, listener: (packet: unknown) => void): unknown;
  off?(eventName: string, listener: (packet: unknown) => void): unknown;
  removeListener?(eventName: string, listener: (packet: unknown) => void): unknown;
}

/**
 * 修正 Mineflayer（Minecraft 协议客户端） blocks plugin（方块插件） 在 Multiworld（多世界） 下
 * 用 dimension（维度类型） 而非 worldName（世界名） 判断是否切换世界的问题。
 */
export function attachMineflayerBlockWorldCompatibility(
  bot: MineflayerBotHandle,
  options: MineflayerBlockWorldCompatibilityOptions = {},
): () => void {
  const client = bot._client as PrependableProtocolEventSource | undefined;
  if (client === undefined) {
    return () => undefined;
  }

  let currentDimensionType: string | undefined;
  let currentWorldName: string | undefined;
  const worldDimensionMap = options.worldDimensionMap ?? {};

  const recordWorldPacket = (packet: unknown): RespawnWorldPacket => {
    const record = packet as RespawnWorldPacket;
    currentWorldName = readWorldName(record) ?? currentWorldName;
    currentDimensionType =
      resolveWorldDimensionType(currentWorldName, worldDimensionMap) ??
      readDimensionType(record) ??
      currentDimensionType;
    return record;
  };
  const normalizeRespawnWorldPacket = (packet: unknown): void => {
    const record = recordWorldPacket(packet);
    normalizeLegacyRespawnWorld(record, worldDimensionMap);
    normalizeWorldStateRespawnWorld(record, worldDimensionMap);
  };
  const prepareChunkDimension = (): void => {
    const parserDimension = stripMinecraftNamespace(currentDimensionType);
    if (bot.game === undefined || parserDimension === undefined) {
      return;
    }

    const restoredDimension = stripMinecraftNamespace(currentWorldName) ?? bot.game.dimension;
    bot.game.dimension = parserDimension;
    queueMicrotask(() => {
      if (bot.game !== undefined && restoredDimension !== undefined) {
        bot.game.dimension = restoredDimension;
      }
    });
  };

  const addListener = client.prependListener?.bind(client) ?? client.on.bind(client);
  const listeners = [
    ["login", recordWorldPacket],
    ["respawn", normalizeRespawnWorldPacket],
    ["map_chunk", prepareChunkDimension],
    ["map_chunk_bulk", prepareChunkDimension],
  ] as const;
  for (const [eventName, listener] of listeners) {
    addListener(eventName, listener);
  }

  return () => {
    for (const [eventName, listener] of listeners) {
      client.off?.(eventName, listener);
      client.removeListener?.(eventName, listener);
    }
  };
}

function readDimensionType(packet: RespawnWorldPacket): string | undefined {
  return packet.worldState?.dimension ?? packet.dimension;
}

function readWorldName(packet: RespawnWorldPacket): string | undefined {
  return packet.worldState?.name ?? packet.worldName;
}

function normalizeLegacyRespawnWorld(
  packet: RespawnWorldPacket,
  worldDimensionMap: Readonly<Record<string, string>>,
): void {
  const worldName = packet.worldName;
  if (worldName === undefined) {
    return;
  }

  if (
    !shouldUseWorldNameCache(worldName, packet.dimension, worldDimensionMap) ||
    packet.dimension === worldName
  ) {
    return;
  }

  packet.dimension = worldName;
}

function normalizeWorldStateRespawnWorld(
  packet: RespawnWorldPacket,
  worldDimensionMap: Readonly<Record<string, string>>,
): void {
  const worldName = packet.worldState?.name;
  if (
    packet.worldState === undefined ||
    worldName === undefined ||
    !shouldUseWorldNameCache(worldName, packet.worldState.dimension, worldDimensionMap) ||
    packet.worldState.dimension === worldName
  ) {
    return;
  }

  packet.worldState.dimension = worldName;
}

export function parseWorldDimensionMap(
  input: string | undefined,
): Readonly<Record<string, string>> {
  if (input === undefined || input.trim().length === 0) {
    return Object.freeze({});
  }

  const entries: Record<string, string> = {};
  for (const rawEntry of input.split(/[;,]/u)) {
    if (rawEntry.trim().length === 0) {
      continue;
    }

    const separatorIndex = rawEntry.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error("MC_WORLD_DIMENSION_MAP entries must use world=dimension");
    }

    const worldName = rawEntry.slice(0, separatorIndex).trim();
    const dimensionType = normalizeDimensionType(rawEntry.slice(separatorIndex + 1).trim());

    if (worldName.length === 0 || dimensionType === undefined) {
      throw new Error("MC_WORLD_DIMENSION_MAP entries must not contain blank world or dimension");
    }

    entries[worldName] = dimensionType;
  }

  return Object.freeze(entries);
}

function shouldUseWorldNameCache(
  worldName: string | undefined,
  dimensionType: string | undefined,
  worldDimensionMap: Readonly<Record<string, string>>,
): boolean {
  if (worldName === undefined || worldName === dimensionType) {
    return false;
  }

  if (Object.keys(worldDimensionMap).length === 0) {
    return isNamespacedWorldName(worldName);
  }

  return resolveWorldDimensionType(worldName, worldDimensionMap) !== undefined;
}

function resolveWorldDimensionType(
  worldName: string | undefined,
  worldDimensionMap: Readonly<Record<string, string>>,
): string | undefined {
  if (worldName === undefined) {
    return undefined;
  }

  const candidates = [worldName];
  const namespaceSeparatorIndex = worldName.indexOf(":");
  if (namespaceSeparatorIndex !== -1) {
    candidates.push(worldName.slice(namespaceSeparatorIndex + 1));
  } else {
    candidates.push(`multiworld:${worldName}`);
  }

  for (const candidate of candidates) {
    const dimensionType = normalizeDimensionType(worldDimensionMap[candidate]);
    if (dimensionType !== undefined) {
      return dimensionType;
    }
  }

  return undefined;
}

function normalizeDimensionType(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (trimmed === "overworld" || trimmed === "the_nether" || trimmed === "the_end") {
    return `minecraft:${trimmed}`;
  }

  return trimmed;
}

function isNamespacedWorldName(value: unknown): value is string {
  return typeof value === "string" && value.includes(":");
}

function stripMinecraftNamespace(value: string | undefined): string | undefined {
  return value?.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
}
