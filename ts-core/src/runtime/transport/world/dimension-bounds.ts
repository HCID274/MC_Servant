import type { MineflayerBotHandle } from "../types.js";

interface MineflayerDimensionBounds {
  readonly minY: number;
  readonly height: number;
}

/** 为 Mineflayer 同步真实维度高度边界，避免 Multiworld 下区块 Y 轴错位。 */
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
