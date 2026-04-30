import process from "node:process";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { createBot, type Bot, type BotOptions } from "mineflayer";
import {
  COLLECT_DEFAULT_RADIUS,
  COLLECT_MAX_RADIUS,
  COLLECT_MIN_RADIUS,
  type CollectSkillParams,
} from "../../src/core-ports/skills.js";
import {
  executeMineflayerCollect,
  type MineflayerCollectPort,
} from "../../src/runtime/transport/collect.js";
import { attachMineflayerDimensionBoundsSync } from "../../src/runtime/transport/runtime.js";
import type {
  MineflayerBotHandle,
  MineflayerPathfinderModule,
} from "../../src/runtime/transport/types.js";

const require = createRequire(import.meta.url);
const pathfinderModule = require("mineflayer-pathfinder") as typeof import("mineflayer-pathfinder");
const { pathfinder } = pathfinderModule;
const ANY_ITEM_NAME = "any";

type MineflayerAuthMode = NonNullable<BotOptions["auth"]>;
type Vec3Like = NonNullable<Bot["entity"]>["position"];

interface ProbeConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly auth?: MineflayerAuthMode;
  readonly version?: string;
  readonly loginCommand?: string;
  readonly readyCommand?: string;
  readonly expectedDimension?: string;
  readonly itemName: string;
  readonly radius: number;
  readonly scanRadius: number;
  readonly center?: Vec3Like;
  readonly timeoutMs: number;
  readonly spawnSettleMs: number;
}

interface ItemEntity {
  readonly id?: number | string;
  readonly objectType?: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly position?: Vec3Like;
  readonly item?: { readonly name?: string; readonly displayName?: string; readonly count?: number };
  readonly droppedItem?: {
    readonly name?: string;
    readonly displayName?: string;
    readonly count?: number;
  };
  readonly metadata?: readonly unknown[];
}

const config = readProbeConfig(process.argv.slice(2), process.env);
const bot = createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  ...(config.auth === undefined ? {} : { auth: config.auth }),
  ...(config.version === undefined ? {} : { version: config.version }),
});

const removeDimensionBoundsSync = attachMineflayerDimensionBoundsSync(
  bot as unknown as MineflayerBotHandle,
);
const rawEntityProbe = attachRawEntityProbe(bot);

bot.loadPlugin(pathfinder);

try {
  console.log(
    `[probe] connecting ${config.username}@${config.host}:${config.port}, item=${config.itemName}, radius=${config.radius}`,
  );
  await waitForLoginOrSpawn(bot, config.timeoutMs);

  if (config.loginCommand !== undefined) {
    console.log("[probe] sending login command from MC_LOGIN_COMMAND");
    bot.chat(config.loginCommand);
    await delay(1000);
  }

  await waitForWorldReady(bot, config);

  if (config.readyCommand !== undefined) {
    console.log("[probe] sending ready command from MC_GOTO_READY_COMMAND");
    bot.chat(config.readyCommand);
    await waitForWorldReady(bot, config);
  }

  if (config.expectedDimension !== undefined) {
    await waitForExpectedDimension(bot, config.expectedDimension, config.timeoutMs);
  }

  await runCollectProbe(bot, config);
  console.log("[probe] completed");
  process.exitCode = 0;
} catch (error) {
  console.error(`[probe] failed: ${formatError(error)}`);
  process.exitCode = 1;
} finally {
  rawEntityProbe.dispose();
  removeDimensionBoundsSync();
  bot.pathfinder?.stop();
  if (typeof bot.quit === "function") {
    bot.quit("collect probe finished");
  } else {
    bot.end("collect probe finished");
  }
}

async function runCollectProbe(bot: Bot, config: ProbeConfig): Promise<void> {
  const center = config.center ?? bot.entity.position;
  const params: CollectSkillParams = {
    ...(config.itemName === ANY_ITEM_NAME ? {} : { itemName: config.itemName }),
    center: {
      x: center.x,
      y: center.y,
      z: center.z,
    },
    radius: config.radius,
    timeoutMs: config.timeoutMs,
  };

  console.log(
    config.itemName === ANY_ITEM_NAME
      ? `[probe] calling main collect for all items center=${formatPosition(center)} radius=${config.radius}`
      : `[probe] calling main collect for ${config.itemName} center=${formatPosition(center)} radius=${config.radius}`,
  );
  logWorldState(bot);
  console.log(
    `[probe] diagnostic scan center=${formatPosition(center)} scanRadius=${config.scanRadius}`,
  );
  rawEntityProbe.logNear(center, config.scanRadius);
  logNearbyEntities(bot, center, config.scanRadius);
  const result = await executeMineflayerCollect({
    bot: bot as unknown as MineflayerCollectPort,
    pathfinder: bot.pathfinder,
    pathfinderModule: pathfinderModule as unknown as MineflayerPathfinderModule,
    params,
  });

  console.log(`[probe] main collect result ${JSON.stringify(result)}`);
}

interface RawEntityProbe {
  readonly logNear: (center: Vec3Like, radius: number) => void;
  readonly dispose: () => void;
}

interface RawEntityState {
  readonly id: number | string;
  readonly type?: unknown;
  readonly uuid?: unknown;
  readonly objectData?: unknown;
  readonly position?: Vec3Like;
  metadata?: unknown;
  destroyed?: boolean;
}

function attachRawEntityProbe(bot: Bot): RawEntityProbe {
  const client = (bot as unknown as { readonly _client?: RawPacketClient })._client;
  const rawEntities = new Map<number | string, RawEntityState>();

  if (client === undefined || typeof client.on !== "function") {
    return {
      logNear() {
        console.log("[probe] raw entity packet probe unavailable: no bot._client");
      },
      dispose() {
        return undefined;
      },
    };
  }

  const onSpawnEntity = (packet: unknown): void => {
    const id = readRawEntityId(packet);
    if (id === undefined) {
      return;
    }

    rawEntities.set(id, {
      id,
      type: readRecordValue(packet, "type"),
      uuid: readRecordValue(packet, "objectUUID") ?? readRecordValue(packet, "uuid"),
      objectData: readRecordValue(packet, "objectData"),
      position: readRawPacketPosition(packet),
    });
  };
  const onEntityMetadata = (packet: unknown): void => {
    const id = readRawEntityId(packet);
    if (id === undefined) {
      return;
    }

    const current = rawEntities.get(id) ?? { id };
    current.metadata = readRecordValue(packet, "metadata") ?? readRecordValue(packet, "entityMetadata");
    rawEntities.set(id, current);
  };
  const onEntityDestroy = (packet: unknown): void => {
    for (const id of readDestroyedEntityIds(packet)) {
      const current = rawEntities.get(id) ?? { id };
      current.destroyed = true;
      rawEntities.set(id, current);
    }
  };

  client.on("spawn_entity", onSpawnEntity);
  client.on("entity_metadata", onEntityMetadata);
  client.on("entity_destroy", onEntityDestroy);

  return {
    logNear(center, radius) {
      const radiusSquared = radius * radius;
      const near = [...rawEntities.values()].filter(
        (entity) =>
          entity.position !== undefined && distanceSquared(entity.position, center) <= radiusSquared,
      );
      console.log(`[probe] raw entity packets near radius=${radius}: ${near.length}`);
      for (const entity of near) {
        console.log(
          [
            "[probe] raw_entity",
            `id=${String(entity.id)}`,
            `type=${formatUnknown(entity.type)}`,
            `uuid=${formatUnknown(entity.uuid)}`,
            `objectData=${formatUnknown(entity.objectData)}`,
            `destroyed=${String(entity.destroyed === true)}`,
            `pos=${entity.position === undefined ? "unknown" : formatPosition(entity.position)}`,
            `metadataIds=${collectNumericIds(entity.metadata).join("|") || "none"}`,
          ].join(" "),
        );
      }
    },
    dispose() {
      client.off?.("spawn_entity", onSpawnEntity);
      client.off?.("entity_metadata", onEntityMetadata);
      client.off?.("entity_destroy", onEntityDestroy);
      client.removeListener?.("spawn_entity", onSpawnEntity);
      client.removeListener?.("entity_metadata", onEntityMetadata);
      client.removeListener?.("entity_destroy", onEntityDestroy);
    },
  };
}

interface RawPacketClient {
  on(eventName: string, listener: (packet: unknown) => void): unknown;
  off?(eventName: string, listener: (packet: unknown) => void): unknown;
  removeListener?(eventName: string, listener: (packet: unknown) => void): unknown;
}

function logWorldState(bot: Bot): void {
  const game = bot.game as
    | {
        readonly dimension?: unknown;
        readonly minY?: unknown;
        readonly height?: unknown;
      }
    | undefined;
  console.log(
    [
      "[probe] world state",
      `dimension=${String(game?.dimension ?? "unknown")}`,
      `minY=${String(game?.minY ?? "unknown")}`,
      `height=${String(game?.height ?? "unknown")}`,
      `botPos=${bot.entity?.position === undefined ? "unknown" : formatPosition(bot.entity.position)}`,
    ].join(" "),
  );
}

function logNearbyEntities(bot: Bot, center: Vec3Like, radius: number): void {
  const radiusSquared = radius * radius;
  const entities = Object.values(bot.entities).filter((entity) => {
    const position = entity.position;

    return position !== undefined && distanceSquared(position, center) <= radiusSquared;
  });

  console.log(`[probe] nearby entities within radius=${radius}: ${entities.length}`);
  for (const entity of entities) {
    const record = entity as unknown as {
      readonly id?: unknown;
      readonly name?: unknown;
      readonly displayName?: unknown;
      readonly kind?: unknown;
      readonly type?: unknown;
      readonly item?: { readonly name?: unknown; readonly displayName?: unknown; readonly count?: unknown };
      readonly droppedItem?: {
        readonly name?: unknown;
        readonly displayName?: unknown;
        readonly count?: unknown;
      };
      readonly position?: Vec3Like;
      readonly metadata?: readonly unknown[];
    };
    console.log(
      [
        "[probe] entity",
        `id=${String(record.id ?? "unknown")}`,
        `name=${String(record.name ?? "unknown")}`,
        `displayName=${String(record.displayName ?? "unknown")}`,
        `kind=${String(record.kind ?? "unknown")}`,
        `type=${String(record.type ?? "unknown")}`,
        `pos=${record.position === undefined ? "unknown" : formatPosition(record.position)}`,
        `item=${String(record.item?.name ?? record.item?.displayName ?? "none")}`,
        `droppedItem=${String(record.droppedItem?.name ?? record.droppedItem?.displayName ?? "none")}`,
        `metadataIds=${collectNumericIds(record.metadata).join("|") || "none"}`,
      ].join(" "),
    );
  }
}

function readProbeConfig(argv: readonly string[], env: NodeJS.ProcessEnv): ProbeConfig {
  const values = parseArgs(argv);
  const radius = Number(values.radius ?? env.MC_COLLECT_RADIUS ?? String(COLLECT_DEFAULT_RADIUS));
  const scanRadius = Number(values.scanRadius ?? values.scan_radius ?? radius);
  const auth = readAuthMode(values.auth ?? env.MC_AUTH);
  const version = values.version ?? env.MC_VERSION;
  const externalAuthRequired =
    values.externalAuthRequired ?? env.MC_EXTERNAL_AUTH_REQUIRED ?? "false";
  const externalAuthSecret = values.externalAuthSecret ?? env.MC_EXTERNAL_AUTH_SECRET;
  const loginCommand =
    values.loginCommand ??
    env.MC_LOGIN_COMMAND ??
    (externalAuthRequired === "true" && externalAuthSecret !== undefined
      ? `/login ${externalAuthSecret}`
      : undefined);
  const readyCommand = values.readyCommand ?? env.MC_GOTO_READY_COMMAND;
  const expectedDimension = values.expectedDimension ?? env.MC_GOTO_EXPECTED_DIMENSION;
  const center = readCenter(values);

  if (!Number.isInteger(radius) || radius < COLLECT_MIN_RADIUS || radius > COLLECT_MAX_RADIUS) {
    throw new Error(
      `radius must be an integer from ${COLLECT_MIN_RADIUS} to ${COLLECT_MAX_RADIUS}`,
    );
  }
  if (
    !Number.isInteger(scanRadius) ||
    scanRadius < COLLECT_MIN_RADIUS ||
    scanRadius > COLLECT_MAX_RADIUS
  ) {
    throw new Error(
      `scanRadius must be an integer from ${COLLECT_MIN_RADIUS} to ${COLLECT_MAX_RADIUS}`,
    );
  }

  return {
    host: values.host ?? env.MC_HOST ?? "127.0.0.1",
    port: Number(values.port ?? env.MC_PORT ?? "25565"),
    username: values.username ?? env.MC_USERNAME ?? "ts-core-collect-probe",
    ...(auth === undefined ? {} : { auth }),
    ...(version === undefined ? {} : { version }),
    ...(loginCommand === undefined ? {} : { loginCommand }),
    ...(readyCommand === undefined ? {} : { readyCommand }),
    ...(expectedDimension === undefined ? {} : { expectedDimension }),
    itemName: values.item ?? env.MC_COLLECT_ITEM ?? "cobblestone",
    radius,
    scanRadius,
    ...(center === undefined ? {} : { center }),
    timeoutMs: Number(values.timeoutMs ?? env.MC_COLLECT_TIMEOUT_MS ?? "30000"),
    spawnSettleMs: Number(values.spawnSettleMs ?? env.MC_SPAWN_SETTLE_MS ?? "1000"),
  };
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg?.startsWith("--")) {
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const nextValue = argv[index + 1];

    if (rawKey === undefined) {
      continue;
    }

    if (inlineValue !== undefined) {
      result[rawKey] = inlineValue;
      continue;
    }

    if (nextValue !== undefined && !nextValue.startsWith("--")) {
      result[rawKey] = nextValue;
      index += 1;
    }
  }

  return result;
}

function readAuthMode(value: string | undefined): MineflayerAuthMode | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  if (value !== "offline" && value !== "microsoft" && value !== "mojang") {
    throw new Error("--auth must be offline, microsoft, or mojang");
  }

  return value as MineflayerAuthMode;
}

function readRawEntityId(packet: unknown): number | string | undefined {
  const value =
    readRecordValue(packet, "entityId") ??
    readRecordValue(packet, "entityID") ??
    readRecordValue(packet, "id");

  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

function readRawPacketPosition(packet: unknown): Vec3Like | undefined {
  const x = readRecordValue(packet, "x");
  const y = readRecordValue(packet, "y");
  const z = readRecordValue(packet, "z");

  return typeof x === "number" && typeof y === "number" && typeof z === "number"
    ? ({ x, y, z } as Vec3Like)
    : undefined;
}

function readDestroyedEntityIds(packet: unknown): readonly (number | string)[] {
  const candidates = [
    readRecordValue(packet, "entityIds"),
    readRecordValue(packet, "entityIDs"),
    readRecordValue(packet, "entities"),
    readRecordValue(packet, "entityId"),
  ];

  return Object.freeze(
    candidates.flatMap((candidate) => {
      if (Array.isArray(candidate)) {
        return candidate.filter(
          (value): value is number | string =>
            typeof value === "number" || typeof value === "string",
        );
      }

      return typeof candidate === "number" || typeof candidate === "string" ? [candidate] : [];
    }),
  );
}

function readRecordValue(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function readCenter(values: Record<string, string>): Vec3Like | undefined {
  if (values.x === undefined || values.y === undefined || values.z === undefined) {
    return undefined;
  }

  return {
    x: Number(values.x),
    y: Number(values.y),
    z: Number(values.z),
  } as Vec3Like;
}

function waitForLoginOrSpawn(bot: Bot, timeoutMs: number): Promise<void> {
  if (bot.entity !== undefined) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for login or spawn"));
    }, timeoutMs);
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      bot.off("login", onReady);
      bot.off("spawn", onReady);
      bot.off("error", onError);
    };

    bot.once("login", onReady);
    bot.once("spawn", onReady);
    bot.once("error", onError);
  });
}

async function waitForWorldReady(
  bot: Bot,
  config: Pick<ProbeConfig, "spawnSettleMs" | "timeoutMs">,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < config.timeoutMs) {
    if (bot.entity?.position !== undefined) {
      if (typeof bot.waitForChunksToLoad === "function") {
        console.log("[probe] waiting for chunks with bot.waitForChunksToLoad()");
        await withTimeout(bot.waitForChunksToLoad(), config.timeoutMs, "chunks to load");
      }

      if (typeof bot.waitForTicks === "function") {
        console.log("[probe] waiting 5 physics ticks after chunk load");
        await withTimeout(bot.waitForTicks(5), 10_000, "physics ticks");
      }

      console.log(`[probe] waiting ${config.spawnSettleMs}ms after world-ready checks`);
      await delay(config.spawnSettleMs);
      return;
    }

    await delay(100);
  }

  throw new Error("timed out waiting for world ready");
}

async function waitForExpectedDimension(
  bot: Bot,
  expectedDimension: string,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const currentDimension = getCurrentDimension(bot);

    if (currentDimension === expectedDimension) {
      console.log(`[probe] dimension confirmed: ${currentDimension}`);
      return;
    }

    await delay(250);
  }

  throw new Error(
    `timed out waiting for dimension=${expectedDimension}; current=${getCurrentDimension(bot) ?? "unknown"}`,
  );
}

function findItemEntities(
  bot: Bot,
  itemName: string,
  center: Vec3Like,
  radius: number,
): readonly ItemEntity[] {
  const radiusSquared = radius * radius;
  const targets = Object.values(bot.entities)
    .flatMap((entity): ItemEntity[] => {
      const candidate = entity as unknown as ItemEntity;

      return (
        candidate.position !== undefined &&
        distanceSquared(candidate.position, center) <= radiusSquared &&
        matchesItemEntity(bot, candidate, itemName)
      )
        ? [candidate]
        : [];
    })
    .sort(
      (left, right) =>
        distanceSquared(left.position as Vec3Like, bot.entity.position) -
        distanceSquared(right.position as Vec3Like, bot.entity.position),
    );

  return Object.freeze(targets);
}

function matchesItemEntity(bot: Bot, entity: ItemEntity, itemName: string): boolean {
  if (itemName === ANY_ITEM_NAME) {
    return true;
  }

  const names = [
    entity.name,
    entity.displayName,
    entity.item?.name,
    entity.item?.displayName,
    entity.droppedItem?.name,
    entity.droppedItem?.displayName,
  ].filter((value): value is string => typeof value === "string");
  const expected = normalizeName(itemName);

  if (names.some((name) => normalizeName(name) === expected)) {
    return true;
  }

  const itemId = bot.registry.itemsByName[expected]?.id;

  return typeof itemId === "number" && collectNumericIds(entity.metadata).includes(itemId);
}

function collectNumericIds(value: unknown): readonly number[] {
  if (typeof value === "number") {
    return Object.freeze([value]);
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.flatMap((item) => [...collectNumericIds(item)]));
  }

  if (typeof value !== "object" || value === null) {
    return Object.freeze([]);
  }

  return Object.freeze(
    Object.entries(value).flatMap(([key, nested]) =>
      (key === "itemId" || key === "id") && typeof nested === "number"
        ? [nested]
        : [...collectNumericIds(nested)],
    ),
  );
}

function countInventory(bot: Bot, itemName: string): number {
  if (itemName === ANY_ITEM_NAME) {
    return bot.inventory.items().reduce((total, item) => total + item.count, 0);
  }

  const expected = normalizeName(itemName);

  return bot.inventory.items().reduce((total, item) => {
    const itemMatches =
      normalizeName(item.name) === expected || normalizeName(item.displayName ?? "") === expected;

    return total + (itemMatches ? item.count : 0);
  }, 0);
}

function countInventoryByName(bot: Bot): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const item of bot.inventory.items()) {
    const name = normalizeName(item.name);
    counts.set(name, (counts.get(name) ?? 0) + item.count);
  }

  return counts;
}

function diffInventoryCounts(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): ReadonlyArray<readonly [string, number]> {
  const diff: Array<readonly [string, number]> = [];

  for (const [name, count] of after.entries()) {
    const delta = count - (before.get(name) ?? 0);

    if (delta > 0) {
      diff.push(Object.freeze([name, delta] as const));
    }
  }

  return diff;
}

function formatInventoryCounts(counts: ReadonlyMap<string, number>): string {
  const entries = [...counts.entries()];

  if (entries.length === 0) {
    return "empty";
  }

  return entries.map(([name, count]) => `${name}:${count}`).join(",");
}

function formatInventoryDiff(diff: ReadonlyArray<readonly [string, number]>): string {
  return diff.map(([name, count]) => `${name}:+${count}`).join(",");
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/^minecraft:/u, "").replaceAll(" ", "_");
}

function distanceSquared(a: Vec3Like, b: Vec3Like): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

function getCurrentDimension(bot: Bot): string | undefined {
  const game = bot.game as { readonly dimension?: unknown } | undefined;

  return typeof game?.dimension === "string" ? game.dimension : undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function formatPosition(position: Vec3Like): string {
  return `(${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)})`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatUnknown(value: unknown): string {
  if (value === undefined) {
    return "unknown";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}
