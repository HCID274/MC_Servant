import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { type Bot, type BotOptions, createBot } from "mineflayer";

export type MineflayerAuthMode = NonNullable<BotOptions["auth"]>;

export interface ProbeBaseConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly auth?: MineflayerAuthMode;
  readonly version?: string;
  readonly loginCommand?: string;
  readonly readyCommand?: string;
  readonly expectedDimension?: string;
  readonly worldLabel: string;
  readonly durationMs: number;
  readonly timeoutMs: number;
  readonly settleMs: number;
}

export interface ProbePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface MutableProbePoint {
  x: number;
  y: number;
  z: number;
}

export interface ProbeEventSource {
  on(eventName: string, listener: (...args: readonly unknown[]) => void): unknown;
  off?(eventName: string, listener: (...args: readonly unknown[]) => void): unknown;
  removeListener?(eventName: string, listener: (...args: readonly unknown[]) => void): unknown;
}

export interface ProbePacketSource {
  on(eventName: string, listener: (packet: unknown) => void): unknown;
  off?(eventName: string, listener: (packet: unknown) => void): unknown;
  removeListener?(eventName: string, listener: (packet: unknown) => void): unknown;
}

export interface ProbeSignal {
  readonly name: string;
  count: number;
  lastAtMs?: number;
}

export function readBaseConfig(argv: readonly string[], env: NodeJS.ProcessEnv): ProbeBaseConfig {
  const flags = readFlags(argv);
  return {
    host: readStringFlag(flags, env, "host", "MC_HOST", "127.0.0.1"),
    port: readNumberFlag(flags, env, "port", "MC_PORT", 25565),
    username: readStringFlag(flags, env, "username", "MC_USERNAME", "knockback_probe"),
    auth: readOptionalStringFlag(flags, env, "auth", "MC_AUTH") as MineflayerAuthMode | undefined,
    version: readOptionalStringFlag(flags, env, "version", "MC_VERSION"),
    loginCommand: readOptionalStringFlag(flags, env, "login-command", "MC_LOGIN_COMMAND"),
    readyCommand: readOptionalStringFlag(flags, env, "ready-command", "MC_READY_COMMAND"),
    expectedDimension: readOptionalStringFlag(
      flags,
      env,
      "expected-dimension",
      "MC_EXPECTED_DIMENSION",
    ),
    worldLabel: readStringFlag(flags, env, "world-label", "MC_WORLD_LABEL", "unknown"),
    durationMs: readNumberFlag(flags, env, "duration-ms", "MC_PROBE_DURATION_MS", 30_000),
    timeoutMs: readNumberFlag(flags, env, "timeout-ms", "MC_PROBE_TIMEOUT_MS", 30_000),
    settleMs: readNumberFlag(flags, env, "settle-ms", "MC_PROBE_SETTLE_MS", 1500),
  };
}

export function createProbeBot(config: ProbeBaseConfig): Bot {
  return createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    ...(config.auth === undefined ? {} : { auth: config.auth }),
    ...(config.version === undefined ? {} : { version: config.version }),
  });
}

export async function prepareBot(bot: Bot, config: ProbeBaseConfig): Promise<void> {
  console.log(
    `[probe] connecting ${config.username}@${config.host}:${config.port} world_label=${config.worldLabel}`,
  );
  await waitForLoginOrSpawn(bot, config.timeoutMs);
  if (config.loginCommand !== undefined) {
    console.log("[probe] sending loginCommand（登录命令）");
    bot.chat(config.loginCommand);
    await delay(1000);
  }
  await waitForWorldReady(bot, config.timeoutMs);
  if (config.readyCommand !== undefined) {
    console.log("[probe] sending readyCommand（就绪命令）");
    bot.chat(config.readyCommand);
    await delay(1000);
    await waitForWorldReady(bot, config.timeoutMs);
  }
  if (config.expectedDimension !== undefined) {
    await waitForExpectedDimension(bot, config.expectedDimension, config.timeoutMs);
  }
  if (config.settleMs > 0) {
    console.log(`[probe] waiting settle（稳定等待） ${config.settleMs}ms`);
    await delay(config.settleMs);
  }
}

export function getEventSource(bot: Bot): ProbeEventSource {
  return bot as unknown as ProbeEventSource;
}

export function getPacketSource(bot: Bot): ProbePacketSource | undefined {
  const withClient = bot as unknown as { readonly _client?: ProbePacketSource };
  return withClient._client;
}

export function getBotEntityId(bot: Bot): number | string | undefined {
  return bot.entity?.id;
}

export function getPosition(bot: Bot): ProbePoint | undefined {
  return clonePoint(bot.entity?.position);
}

export function getVelocity(bot: Bot): ProbePoint | undefined {
  const entity = bot.entity as unknown as { readonly velocity?: ProbePoint } | undefined;
  return clonePoint(entity?.velocity);
}

export function getMutableVelocity(bot: Bot): MutableProbePoint | undefined {
  const entity = bot.entity as unknown as { velocity?: MutableProbePoint } | undefined;
  return entity?.velocity;
}

export function clonePoint(point: ProbePoint | undefined): ProbePoint | undefined {
  if (point === undefined) {
    return undefined;
  }
  return { x: point.x, y: point.y, z: point.z };
}

export function horizontalDistance(a: ProbePoint | undefined, b: ProbePoint | undefined): number {
  if (a === undefined || b === undefined) {
    return 0;
  }
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function horizontalSpeed(velocity: ProbePoint | undefined): number {
  if (velocity === undefined) {
    return 0;
  }
  return Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
}

export function formatPoint(point: ProbePoint | undefined): string {
  if (point === undefined) {
    return "unknown";
  }
  return `${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)}`;
}

export function formatWorld(bot: Bot, config: Pick<ProbeBaseConfig, "worldLabel">): string {
  const game = bot.game as { readonly dimension?: string } | undefined;
  return `world_label=${config.worldLabel} dimension=${game?.dimension ?? "unknown"}`;
}

export function markSignal(signal: ProbeSignal): void {
  signal.count += 1;
  signal.lastAtMs = Date.now();
}

export function createSignal(name: string): ProbeSignal {
  return { name, count: 0 };
}

export function readPacketEntityId(packet: unknown): number | string | undefined {
  const record = asRecord(packet);
  return (
    readNumberOrString(record, "entityId") ??
    readNumberOrString(record, "entityID") ??
    readNumberOrString(record, "id")
  );
}

export function readPacketVelocity(packet: unknown): ProbePoint | undefined {
  const record = asRecord(packet);
  const nestedVelocity = asRecord(record.velocity);
  const x =
    readPacketVelocityNumber(nestedVelocity, "x") ??
    readPacketVelocityNumber(record, "velocityX") ??
    readPacketVelocityNumber(record, "x");
  const y =
    readPacketVelocityNumber(nestedVelocity, "y") ??
    readPacketVelocityNumber(record, "velocityY") ??
    readPacketVelocityNumber(record, "y");
  const z =
    readPacketVelocityNumber(nestedVelocity, "z") ??
    readPacketVelocityNumber(record, "velocityZ") ??
    readPacketVelocityNumber(record, "z");
  if (x === undefined || y === undefined || z === undefined) {
    return undefined;
  }
  return { x, y, z };
}

export function readPacketStatus(packet: unknown): number | undefined {
  const record = asRecord(packet);
  return readNumber(record, "entityStatus") ?? readNumber(record, "status");
}

export function readPacketPosition(packet: unknown): ProbePoint | undefined {
  const record = asRecord(packet);
  const x = readNumber(record, "x");
  const y = readNumber(record, "y");
  const z = readNumber(record, "z");
  if (x === undefined || y === undefined || z === undefined) {
    return undefined;
  }
  return { x, y, z };
}

export function formatPacketKeys(packet: unknown): string {
  return Object.keys(asRecord(packet)).sort().join("|") || "none";
}

export function parseBooleanText(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (["1", "true", "yes", "y"].includes(value.toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "n"].includes(value.toLowerCase())) {
    return false;
  }
  return undefined;
}

export function readFlags(argv: readonly string[]): ReadonlyMap<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (rawKey === undefined || rawKey.length === 0) {
      continue;
    }
    if (inlineValue !== undefined) {
      flags.set(rawKey, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(rawKey, next);
      index += 1;
    } else {
      flags.set(rawKey, "true");
    }
  }
  return flags;
}

export function readStringFlag(
  flags: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv,
  flagName: string,
  envName: string,
  defaultValue: string,
): string {
  return readOptionalStringFlag(flags, env, flagName, envName) ?? defaultValue;
}

export function readOptionalStringFlag(
  flags: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv,
  flagName: string,
  envName: string,
): string | undefined {
  const value = flags.get(flagName) ?? env[envName];
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return value.trim();
}

export function readNumberFlag(
  flags: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv,
  flagName: string,
  envName: string,
  defaultValue: number,
): number {
  const rawValue = flags.get(flagName) ?? env[envName];
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return defaultValue;
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid number for --${flagName}: ${rawValue}`);
  }
  return value;
}

export function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[probe] failed: ${message}`);
  process.exit(1);
}

async function waitForLoginOrSpawn(bot: Bot, timeoutMs: number): Promise<void> {
  await Promise.race([
    waitForAnyBotEvent(bot, ["spawn", "login"], timeoutMs, "login/spawn"),
    (async () => {
      while (bot.entity?.position === undefined) {
        await delay(100);
      }
    })(),
  ]);
}

async function waitForWorldReady(bot: Bot, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (bot.entity?.position !== undefined) {
      return;
    }
    await delay(100);
  }
  throw new Error("timed out waiting for world-ready（世界就绪）");
}

async function waitForExpectedDimension(
  bot: Bot,
  expectedDimension: string,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const game = bot.game as { readonly dimension?: string } | undefined;
    if (game?.dimension === expectedDimension) {
      console.log(`[probe] dimension（维度） confirmed: ${expectedDimension}`);
      return;
    }
    await delay(100);
  }
  const game = bot.game as { readonly dimension?: string } | undefined;
  throw new Error(
    `timed out waiting for dimension（维度） ${expectedDimension}; current=${game?.dimension ?? "unknown"}`,
  );
}

function waitForAnyBotEvent(
  bot: Bot,
  eventNames: readonly string[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  const eventSource = getEventSource(bot);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    const listeners = eventNames.map((eventName) => {
      const listener = (): void => {
        cleanup();
        resolve();
      };
      eventSource.on(eventName, listener);
      return { eventName, listener };
    });
    const cleanup = (): void => {
      clearTimeout(timeout);
      for (const entry of listeners) {
        eventSource.off?.(entry.eventName, entry.listener);
        eventSource.removeListener?.(entry.eventName, entry.listener);
      }
    };
  });
}

function readPacketVelocityNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = readNumber(record, key);
  if (value === undefined) {
    return undefined;
  }
  return Math.abs(value) > 10 ? value / 8000 : value;
}

function readNumber(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNumberOrString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | string | undefined {
  const value = record[key];
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  return undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  return value as Readonly<Record<string, unknown>>;
}
