import process from "node:process";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { createBot, type Bot, type BotEvents, type BotOptions } from "mineflayer";

const require = createRequire(import.meta.url);
const pathfinderModule = require("mineflayer-pathfinder") as typeof import("mineflayer-pathfinder");
const vec3Module = require("vec3") as {
  Vec3: new (x: number, y: number, z: number) => MineflayerPosition;
};
const { Movements, goals, pathfinder } = pathfinderModule;
const { Vec3 } = vec3Module;

type MineflayerAuthMode = NonNullable<BotOptions["auth"]>;
type MineflayerPosition = NonNullable<Bot["entity"]>["position"];
type MineflayerBlock = NonNullable<ReturnType<Bot["blockAt"]>>;

interface IntPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface PlannedStep {
  readonly position: IntPosition;
  readonly clearBlocks: readonly IntPosition[];
}

interface PlannedPath {
  readonly expandedNodes: number;
  readonly path: readonly PlannedStep[];
}

interface ProbeConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly auth?: MineflayerAuthMode;
  readonly version?: string;
  readonly loginCommand?: string;
  readonly readyCommand?: string;
  readonly expectedDimension?: string;
  readonly serverGroundResync: boolean;
  readonly initialPhysicsEnabled: boolean;
  readonly injectSyntheticSupport: boolean;
  readonly syntheticSupportRadius: number;
  readonly freezePhysicsAfterReadyMs: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly canDig: boolean;
  readonly digCost: number;
  readonly avoidCreepers: boolean;
  readonly range: number;
  readonly diagnoseSeconds: number;
  readonly goto: boolean;
  readonly ignoreExplosions: boolean;
  readonly timeoutMs: number;
  readonly spawnSettleMs: number;
}

interface PathUpdateSnapshot {
  readonly status?: string;
  readonly cost?: number;
  readonly time?: number;
  readonly visitedNodes?: number;
  readonly generatedNodes?: number;
  readonly path?: readonly unknown[];
}

interface ProbeRuntimeSignals {
  hasForcedMove(): boolean;
  hasSpawned(): boolean;
  resyncDimensionBounds(): void;
}

interface RawPositionPacket {
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  readonly yaw?: number;
  readonly pitch?: number;
  readonly flags?: number;
  readonly teleportId?: number;
}

interface RawExplosionPacket {
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  readonly radius?: number;
  readonly playerMotionX?: number;
  readonly playerMotionY?: number;
  readonly playerMotionZ?: number;
  readonly sound?: unknown;
  readonly soundId?: number;
  readonly probeTrailingData?: Buffer;
}

interface RawWorldIdentityPacket {
  readonly dimension?: unknown;
  readonly worldType?: unknown;
  readonly worldName?: unknown;
  readonly worldState?: {
    readonly dimension?: unknown;
    readonly name?: unknown;
  };
  readonly copyMetadata?: unknown;
}

type ProbeCustomPackets = Record<string, unknown>;

const explosionPacketWithTrailingData = [
  "container",
  [
    { name: "x", type: "f64" },
    { name: "y", type: "f64" },
    { name: "z", type: "f64" },
    { name: "radius", type: "f32" },
    {
      name: "affectedBlockOffsets",
      type: [
        "array",
        {
          countType: "varint",
          type: [
            "container",
            [
              { name: "x", type: "i8" },
              { name: "y", type: "i8" },
              { name: "z", type: "i8" },
            ],
          ],
        },
      ],
    },
    { name: "playerMotionX", type: "f32" },
    { name: "playerMotionY", type: "f32" },
    { name: "playerMotionZ", type: "f32" },
    { name: "block_interaction_type", type: "varint" },
    { name: "small_explosion_particle", type: "Particle" },
    { name: "large_explosion_particle", type: "Particle" },
    { name: "sound", type: "ItemSoundHolder" },
    { name: "probeTrailingData", type: "restBuffer" },
  ],
] as const;

const config = readProbeConfig(process.argv.slice(2), process.env);
const bot = createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  ...(config.auth === undefined ? {} : { auth: config.auth }),
  ...(config.version === undefined ? {} : { version: config.version }),
  physicsEnabled: config.initialPhysicsEnabled,
  customPackets: createProbeCustomPackets(),
});

bot.loadPlugin(pathfinder);
applyProbeGuards(bot, config);
const runtimeSignals = installProbeLogging(bot);

try {
  console.log(
    `[probe] connecting ${config.username}@${config.host}:${config.port}, target=(${config.x}, ${config.y}, ${config.z}), canDig=${config.canDig}, digCost=${config.digCost}`,
  );
  await waitForLoginOrSpawn(bot, config.timeoutMs);

  if (config.loginCommand !== undefined) {
    console.log("[probe] sending login command from MC_LOGIN_COMMAND");
    bot.chat(config.loginCommand);
    await delay(1000);
  }

  await waitForWorldReady(bot, runtimeSignals, config);
  if (config.readyCommand !== undefined && shouldRunReadyCommand(bot, config.expectedDimension)) {
    if (config.freezePhysicsAfterReadyMs > 0) {
      setPhysicsEnabled(bot, false, "before ready command");
    }
    console.log("[probe] sending ready command after initial world-ready checks");
    bot.chat(config.readyCommand);
    await waitForPostCommandSettle(bot, config);
  }
  if (config.expectedDimension !== undefined) {
    await waitForExpectedDimension(bot, config.expectedDimension, config.timeoutMs);
  }
  runtimeSignals.resyncDimensionBounds();
  if (config.serverGroundResync) {
    await maybeResyncGroundSupport(bot, config);
  }
  if (config.injectSyntheticSupport) {
    injectSyntheticSupport(bot, config.syntheticSupportRadius);
  }
  if (!config.initialPhysicsEnabled) {
    setPhysicsEnabled(bot, true, "after initial dimension settle");
  }
  if (config.freezePhysicsAfterReadyMs > 0) {
    console.log(`[probe] keeping physics frozen for ${config.freezePhysicsAfterReadyMs}ms after ready command`);
    await delay(config.freezePhysicsAfterReadyMs);
    setPhysicsEnabled(bot, true, "after ready command settle");
  }
  logBlockSnapshot(bot, config);
  await runPhysicsDiagnostics(bot, config.diagnoseSeconds);
  if (!config.goto) {
    console.log("[probe] diagnose completed, goto skipped");
    process.exitCode = 0;
  } else {
    await runGoToProbe(bot, config);
  }
  console.log("[probe] completed");
} catch (error) {
  console.error(`[probe] failed: ${formatError(error)}`);
  process.exitCode = 1;
} finally {
  bot.pathfinder?.stop();
  if (typeof bot.quit === "function") {
    bot.quit("go-to probe finished");
  } else {
    bot.end("go-to probe finished");
  }
}

async function runGoToProbe(bot: Bot, config: ProbeConfig): Promise<void> {
  const movements = new Movements(bot);
  movements.canDig = config.canDig;
  movements.digCost = config.digCost;
  movements.allowEntityDetection = true;
  if (config.avoidCreepers) {
    movements.entitiesToAvoid.add("creeper");
    movements.entityCost = Math.max(movements.entityCost, 50);
  }
  bot.pathfinder.setMovements(movements);

  const goal =
    config.range === 0
      ? new goals.GoalBlock(config.x, config.y, config.z)
      : new goals.GoalNear(config.x, config.y, config.z, config.range);
  console.log("[probe] goto started");
  try {
    await bot.pathfinder.goto(goal);
    assertReachedTarget(bot, config);
  } catch (error) {
    console.log(`[probe] goto failed, starting direct-walk fallback: ${formatError(error)}`);
    const directWalkReached = await runDirectWalkFallback(
      bot,
      { x: config.x, y: config.y, z: config.z },
      config,
    );
    if (!directWalkReached) {
      throw new Error("direct-walk fallback timed out; dig fallback is disabled after physics desync");
    }
    assertReachedTarget(bot, config);
  }
}

async function runDirectWalkFallback(
  bot: Bot,
  target: IntPosition,
  config: Pick<ProbeConfig, "range" | "timeoutMs">,
): Promise<boolean> {
  const timeoutMs = Math.min(config.timeoutMs, 30_000);
  const startedAt = Date.now();
  const range = Math.max(config.range, 1);
  let lastLogAt = 0;

  try {
    while (Date.now() - startedAt < timeoutMs) {
      const position = bot.entity?.position;
      if (position === undefined) {
        return false;
      }

      const distanceSq =
        (position.x - target.x) ** 2 + (position.y - target.y) ** 2 + (position.z - target.z) ** 2;
      if (distanceSq <= range ** 2) {
        console.log(`[probe] direct-walk fallback reached at ${formatPosition(position)}`);
        return true;
      }

      if (Date.now() - lastLogAt > 2000) {
        lastLogAt = Date.now();
        console.log(`[probe] direct-walk moving pos=${formatPosition(position)} distance=${Math.sqrt(distanceSq).toFixed(2)}`);
      }

      await bot.lookAt(new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5), true);
      bot.setControlState("forward", true);
      bot.setControlState("sprint", true);
      bot.setControlState("jump", false);
      await delay(50);
    }
  } finally {
    clearControlStates(bot);
  }

  return false;
}

async function runLegacyStyleGoToFallback(
  bot: Bot,
  target: IntPosition,
  config: Pick<ProbeConfig, "timeoutMs">,
): Promise<void> {
  const start = toFeetPosition(bot);
  console.log(
    `[probe] fallback planning start=(${start.x}, ${start.y}, ${start.z}) target=(${target.x}, ${target.y}, ${target.z})`,
  );

  await clearBodySpace(bot, start, "start");
  const plan = planStandPath(bot, start, target);
  console.log(`[probe] fallback plan path=${plan.path.length} expanded=${plan.expandedNodes}`);

  for (let index = 1; index < plan.path.length; index += 1) {
    const previous = plan.path[index - 1];
    const step = plan.path[index];
    if (previous === undefined || step === undefined) {
      throw new Error("fallback path contains a missing step");
    }

    for (const clearBlock of transitionClearCandidates(previous.position, step.position)) {
      await digIfNeeded(bot, clearBlock, `transition:${index}`);
    }
    for (const clearBlock of step.clearBlocks) {
      await digIfNeeded(bot, clearBlock, `step:${index}`);
    }

    await moveOneStep(bot, previous.position, step.position, Math.min(config.timeoutMs, 8000));
    console.log(
      `[probe] fallback step ${index}/${plan.path.length - 1} reached=(${step.position.x}, ${step.position.y}, ${step.position.z})`,
    );
  }
}

function planStandPath(bot: Bot, start: IntPosition, target: IntPosition): PlannedPath {
  const bounds = buildFallbackBounds(start, target);
  const maxNodes = 80_000;
  const queue: Array<{ readonly position: IntPosition; readonly previousKey: string | null }> = [
    { position: start, previousKey: null },
  ];
  const visited = new Set([keyOf(start)]);
  const nodes = new Map<string, { readonly step: PlannedStep; readonly previousKey: string | null }>([
    [keyOf(start), { step: { position: start, clearBlocks: [] }, previousKey: null }],
  ]);
  let expandedNodes = 0;

  while (queue.length > 0) {
    const currentState = queue.shift();
    if (currentState === undefined) {
      break;
    }
    expandedNodes += 1;

    if (samePosition(currentState.position, target)) {
      return { expandedNodes, path: reconstructStandPath(nodes, keyOf(currentState.position)) };
    }
    if (expandedNodes > maxNodes) {
      throw new Error(`fallback path exceeded max nodes ${maxNodes}`);
    }

    for (const next of sortedStandNeighbors(currentState.position, target)) {
      if (!withinBounds(next, bounds)) {
        continue;
      }

      const nextKey = keyOf(next);
      if (visited.has(nextKey)) {
        continue;
      }

      const evaluation = evaluateStandCandidate(bot, next);
      if (!evaluation.ok) {
        continue;
      }

      visited.add(nextKey);
      nodes.set(nextKey, {
        step: { position: next, clearBlocks: evaluation.clearBlocks },
        previousKey: keyOf(currentState.position),
      });
      queue.push({ position: next, previousKey: keyOf(currentState.position) });
    }
  }

  throw new Error(`fallback found no stand path: expanded=${expandedNodes} visited=${visited.size}`);
}

function reconstructStandPath(
  nodes: ReadonlyMap<string, { readonly step: PlannedStep; readonly previousKey: string | null }>,
  endKey: string,
): readonly PlannedStep[] {
  const path: PlannedStep[] = [];
  let cursor: string | null = endKey;
  while (cursor !== null) {
    const node = nodes.get(cursor);
    if (node === undefined) {
      break;
    }
    path.push(node.step);
    cursor = node.previousKey;
  }
  return path.reverse();
}

function evaluateStandCandidate(
  bot: Bot,
  position: IntPosition,
): { readonly ok: true; readonly clearBlocks: readonly IntPosition[] } | { readonly ok: false } {
  const supportBlock = blockAtInt(bot, { x: position.x, y: position.y - 1, z: position.z });
  if (!isSolidBlock(supportBlock)) {
    return { ok: false };
  }

  const clearBlocks: IntPosition[] = [];
  for (const candidate of bodySpaceCandidates(position)) {
    const block = blockAtInt(bot, candidate);
    if (isPassableBlock(block)) {
      continue;
    }
    if (!isDigClearableBlock(block)) {
      return { ok: false };
    }
    clearBlocks.push(candidate);
  }

  return { ok: true, clearBlocks };
}

function sortedStandNeighbors(current: IntPosition, target: IntPosition): readonly IntPosition[] {
  return [
    { x: current.x + 1, y: current.y, z: current.z },
    { x: current.x - 1, y: current.y, z: current.z },
    { x: current.x, y: current.y, z: current.z + 1 },
    { x: current.x, y: current.y, z: current.z - 1 },
    { x: current.x + 1, y: current.y + 1, z: current.z },
    { x: current.x - 1, y: current.y + 1, z: current.z },
    { x: current.x, y: current.y + 1, z: current.z + 1 },
    { x: current.x, y: current.y + 1, z: current.z - 1 },
    { x: current.x + 1, y: current.y - 1, z: current.z },
    { x: current.x - 1, y: current.y - 1, z: current.z },
    { x: current.x, y: current.y - 1, z: current.z + 1 },
    { x: current.x, y: current.y - 1, z: current.z - 1 },
  ].sort((left, right) => distanceSquared(left, target) - distanceSquared(right, target));
}

function buildFallbackBounds(start: IntPosition, target: IntPosition): {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
} {
  const spanX = Math.abs(target.x - start.x);
  const spanY = Math.abs(target.y - start.y);
  const spanZ = Math.abs(target.z - start.z);
  const horizontalPadding = Math.max(8, Math.min(Math.max(spanX, spanZ) + 8, 32));
  const verticalPadding = Math.max(6, Math.min(spanY + 6, 22));
  return {
    minX: Math.min(start.x, target.x) - horizontalPadding,
    maxX: Math.max(start.x, target.x) + horizontalPadding,
    minY: Math.min(start.y, target.y) - verticalPadding,
    maxY: Math.max(start.y, target.y) + verticalPadding,
    minZ: Math.min(start.z, target.z) - horizontalPadding,
    maxZ: Math.max(start.z, target.z) + horizontalPadding,
  };
}

function withinBounds(
  position: IntPosition,
  bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minY: number;
    readonly maxY: number;
    readonly minZ: number;
    readonly maxZ: number;
  },
): boolean {
  return (
    position.x >= bounds.minX &&
    position.x <= bounds.maxX &&
    position.y >= bounds.minY &&
    position.y <= bounds.maxY &&
    position.z >= bounds.minZ &&
    position.z <= bounds.maxZ
  );
}

function transitionClearCandidates(fromPosition: IntPosition, targetPosition: IntPosition): readonly IntPosition[] {
  const dx = targetPosition.x - fromPosition.x;
  const dy = targetPosition.y - fromPosition.y;
  const dz = targetPosition.z - fromPosition.z;
  if (dy > 0) {
    return [{ x: fromPosition.x, y: fromPosition.y + 2, z: fromPosition.z }];
  }
  if (dy < 0) {
    return [{ x: fromPosition.x + dx, y: fromPosition.y + 1, z: fromPosition.z + dz }];
  }
  return [];
}

async function clearBodySpace(bot: Bot, position: IntPosition, label: string): Promise<void> {
  for (const candidate of bodySpaceCandidates(position)) {
    await digIfNeeded(bot, candidate, `${label}:body`);
  }
}

function bodySpaceCandidates(position: IntPosition): readonly IntPosition[] {
  return [
    { x: position.x, y: position.y + 1, z: position.z },
    { x: position.x, y: position.y, z: position.z },
  ];
}

async function digIfNeeded(bot: Bot, position: IntPosition, reason: string): Promise<void> {
  const block = blockAtInt(bot, position);
  if (isPassableBlock(block)) {
    return;
  }
  if (!isDigClearableBlock(block)) {
    throw new Error(`fallback cannot clear block at ${keyOf(position)}`);
  }

  await equipBestHarvestTool(bot, block);
  console.log(`[probe] fallback dig ${reason} pos=(${position.x}, ${position.y}, ${position.z}) block=${block.name}`);
  await bot.dig(block);
  if (typeof bot.waitForTicks === "function") {
    await bot.waitForTicks(1);
  }
}

async function equipBestHarvestTool(bot: Bot, block: MineflayerBlock): Promise<void> {
  const tool = bot.pathfinder?.bestHarvestTool?.(block);
  if (tool === undefined || tool === null) {
    return;
  }
  await bot.equip(tool, "hand");
}

async function moveOneStep(
  bot: Bot,
  fromPosition: IntPosition,
  targetPosition: IntPosition,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  const dy = targetPosition.y - fromPosition.y;

  try {
    while (Date.now() - startedAt < timeoutMs) {
      if (reachedStand(bot, targetPosition)) {
        return;
      }

      await orientTowards(bot, targetPosition);
      bot.setControlState("forward", true);
      bot.setControlState("jump", dy > 0);
      bot.setControlState("sprint", false);
      bot.setControlState("sneak", false);
      await delay(50);
    }
  } finally {
    clearControlStates(bot);
  }

  throw new Error(
    `fallback step timeout from=${keyOf(fromPosition)} target=${keyOf(targetPosition)} current=${keyOf(toFeetPosition(bot))}`,
  );
}

async function orientTowards(bot: Bot, targetPosition: IntPosition): Promise<void> {
  await bot.lookAt(new Vec3(targetPosition.x + 0.5, targetPosition.y + 0.5, targetPosition.z + 0.5), true);
}

function reachedStand(bot: Bot, targetPosition: IntPosition): boolean {
  const position = bot.entity?.position;
  if (position === undefined) {
    return false;
  }
  const floored = position.floored();
  if (samePosition(floored, targetPosition)) {
    return true;
  }

  const dx = Math.abs(position.x - (targetPosition.x + 0.5));
  const dy = Math.abs(position.y - targetPosition.y);
  const dz = Math.abs(position.z - (targetPosition.z + 0.5));
  return dx <= 0.45 && dy <= 0.8 && dz <= 0.45;
}

function clearControlStates(bot: Bot): void {
  for (const state of ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const) {
    bot.setControlState(state, false);
  }
}

function blockAtInt(bot: Bot, position: IntPosition): MineflayerBlock | null {
  return bot.blockAt(new Vec3(position.x, position.y, position.z));
}

function toFeetPosition(bot: Bot): IntPosition {
  const position = bot.entity?.position;
  if (position === undefined) {
    throw new Error("Bot has no entity position");
  }
  return toIntPosition(position);
}

function toIntPosition(position: { readonly x: number; readonly y: number; readonly z: number }): IntPosition {
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  };
}

function samePosition(left: IntPosition, right: IntPosition): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function keyOf(position: IntPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function distanceSquared(left: IntPosition, right: IntPosition): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return dx * dx + dy * dy + dz * dz;
}

function isSolidBlock(block: MineflayerBlock | null): boolean {
  return block !== null && block.boundingBox === "block";
}

function isLiquidBlock(block: MineflayerBlock | null): boolean {
  return block !== null && Boolean((block as { readonly liquid?: boolean }).liquid);
}

function isPassableBlock(block: MineflayerBlock | null): boolean {
  return block === null || (!isSolidBlock(block) && !isLiquidBlock(block));
}

function isDigClearableBlock(block: MineflayerBlock | null): block is MineflayerBlock {
  return isPassableBlock(block) || Boolean(block?.diggable);
}

function installProbeLogging(bot: Bot): ProbeRuntimeSignals {
  let spawned = false;
  let forcedMove = false;
  let rawWorldIdentity: string | undefined;
  let rawDimensionType: string | undefined;
  const rawClient = (
    bot as {
      readonly _client?: {
        on(eventName: string, listener: (packet: unknown) => void): void;
        write?(eventName: string, packet: unknown): void;
      };
    }
  )._client;
  if (rawClient?.write !== undefined) {
    const originalWrite = rawClient.write.bind(rawClient);
    rawClient.write = (eventName: string, packet: unknown) => {
      if (
        eventName === "position" ||
        eventName === "position_look" ||
        eventName === "look" ||
        eventName === "teleport_confirm"
      ) {
        console.log(`[probe] client_write ${eventName} ${formatClientPacket(packet)}`);
      }
      originalWrite(eventName, packet);
    };
  }

  rawClient?.on("login", (packet) => {
    rawWorldIdentity = readPacketWorldIdentity(packet);
    rawDimensionType = readPacketDimensionType(packet) ?? rawDimensionType;
    scheduleDimensionBoundsSync(bot, packet);
    console.log(`[probe] packet_login_world ${formatWorldPacket(packet)}`);
  });
  rawClient?.on("respawn", (packet) => {
    const nextWorldIdentity = readPacketWorldIdentity(packet);
    rawDimensionType = readPacketDimensionType(packet) ?? rawDimensionType;
    scheduleDimensionBoundsSync(bot, packet);
    console.log(`[probe] packet_respawn_world ${formatWorldPacket(packet)}`);
    if (
      rawWorldIdentity !== undefined &&
      nextWorldIdentity !== undefined &&
      rawWorldIdentity !== nextWorldIdentity
    ) {
      clearMineflayerWorldCache(
        bot,
        `raw world changed ${rawWorldIdentity} -> ${nextWorldIdentity}`,
      );
    }
    rawWorldIdentity = nextWorldIdentity ?? rawWorldIdentity;
  });

  rawClient?.on("position", (packet) => {
    const positionPacket = packet as RawPositionPacket;
    console.log(
      [
        "[probe] packet_position",
        `x=${formatOptionalNumber(positionPacket.x)}`,
        `y=${formatOptionalNumber(positionPacket.y)}`,
        `z=${formatOptionalNumber(positionPacket.z)}`,
        `yaw=${formatOptionalNumber(positionPacket.yaw)}`,
        `pitch=${formatOptionalNumber(positionPacket.pitch)}`,
        `flags=${positionPacket.flags ?? "unknown"}`,
        `teleportId=${positionPacket.teleportId ?? "unknown"}`,
      ].join(" "),
    );
  });
  rawClient?.on("explosion", (packet) => {
    const explosionPacket = packet as RawExplosionPacket;
    const trailingHex = explosionPacket.probeTrailingData?.toString("hex") ?? "";
    const trailingText =
      explosionPacket.probeTrailingData === undefined || explosionPacket.probeTrailingData.length === 0
        ? ""
        : explosionPacket.probeTrailingData
            .toString("utf8")
            .replaceAll("\u0000", "")
            .replaceAll("\n", "\\n")
            .slice(0, 120);
    console.log(
      [
        "[probe] packet_explosion",
        `x=${formatOptionalNumber(explosionPacket.x)}`,
        `y=${formatOptionalNumber(explosionPacket.y)}`,
        `z=${formatOptionalNumber(explosionPacket.z)}`,
        `radius=${formatOptionalNumber(explosionPacket.radius)}`,
        `motion=(${formatOptionalNumber(explosionPacket.playerMotionX)},${formatOptionalNumber(explosionPacket.playerMotionY)},${formatOptionalNumber(explosionPacket.playerMotionZ)})`,
        `soundId=${explosionPacket.soundId ?? "inline"}`,
        `trailing=${explosionPacket.probeTrailingData?.length ?? 0}`,
        trailingHex.length === 0 ? "trailingHex=none" : `trailingHex=${trailingHex}`,
        trailingText.length === 0 ? "trailingText=none" : `trailingText=${trailingText}`,
      ].join(" "),
    );
  });

  bot.on("login", () => {
    console.log("[probe] login");
  });
  bot.on("spawn", () => {
    spawned = true;
    const position = bot.entity?.position;
    console.log(`[probe] spawn at ${position === undefined ? "unknown" : formatPosition(position)}`);
  });
  bot.on("respawn", () => {
    const position = bot.entity?.position;
    console.log(`[probe] respawn at ${position === undefined ? "unknown" : formatPosition(position)} dimension=${getCurrentDimension(bot) ?? "unknown"}`);
  });
  bot.on("message", (message) => {
    console.log(`[probe] message: ${String(message)}`);
  });
  bot.on("forcedMove", () => {
    forcedMove = true;
    const position = bot.entity?.position;
    console.log(
      `[probe] forcedMove at ${position === undefined ? "unknown" : formatPosition(position)}`,
    );
  });
  bot.on("kicked", (reason) => {
    console.log(`[probe] kicked: ${String(reason)}`);
  });
  bot.on("end", (reason) => {
    console.log(`[probe] end: ${String(reason ?? "")}`);
  });
  bot.on("error", (error) => {
    console.log(`[probe] error: ${formatError(error)}`);
  });
  bot.on("path_update", (rawUpdate) => {
    const update = rawUpdate as PathUpdateSnapshot;
    console.log(
      [
        `[probe] path_update status=${update.status ?? "unknown"}`,
        `path=${update.path?.length ?? 0}`,
        `cost=${update.cost ?? "unknown"}`,
        `visited=${update.visitedNodes ?? "unknown"}`,
        `generated=${update.generatedNodes ?? "unknown"}`,
        `time=${update.time ?? "unknown"}`,
      ].join(" "),
    );
  });
  bot.on("goal_reached", () => {
    const position = bot.entity?.position;
    console.log(
      `[probe] goal_reached at ${position === undefined ? "unknown" : formatPosition(position)}`,
    );
  });
  bot.on("path_reset", (reason) => {
    console.log(`[probe] path_reset reason=${String(reason)}`);
  });
  bot.on("path_stop", () => {
    console.log("[probe] path_stop");
  });

  return {
    hasForcedMove: () => forcedMove,
    hasSpawned: () => spawned,
    resyncDimensionBounds: () => {
      if (rawDimensionType !== undefined) {
        syncDimensionBoundsFromType(bot, rawDimensionType);
      }
    },
  };
}

function applyProbeGuards(
  bot: Bot,
  config: Pick<ProbeConfig, "ignoreExplosions">,
): void {
  if (!config.ignoreExplosions) {
    return;
  }

  const rawClient = (
    bot as unknown as {
      readonly _client?: {
        listeners(eventName: string): Function[];
        removeListener(eventName: string, listener: (packet: unknown) => void): void;
        on(eventName: string, listener: (packet: unknown) => void): void;
      };
    }
  )._client;
  const listeners = rawClient?.listeners("explosion") ?? [];
  console.log(`[probe] removing ${listeners.length} explosion listeners for probe safety`);
  for (const listener of listeners) {
    rawClient?.removeListener("explosion", listener as (packet: unknown) => void);
  }
  rawClient?.on("explosion", () => {
    console.log("[probe] explosion ignored for probe safety");
  });
}

function createProbeCustomPackets(): ProbeCustomPackets {
  return {
    "1.20": {
      play: {
        toClient: {
          types: {
            packet_explosion: explosionPacketWithTrailingData,
          },
        },
      },
    },
  };
}

function waitForLoginOrSpawn(bot: Bot, timeoutMs: number): Promise<void> {
  return waitForAnyBotEvent(bot, ["login", "spawn"], timeoutMs, "login or spawn");
}

async function waitForWorldReady(
  bot: Bot,
  signals: ProbeRuntimeSignals,
  config: Pick<ProbeConfig, "spawnSettleMs" | "timeoutMs">,
): Promise<void> {
  if (!signals.hasSpawned() && !hasPositiveHealth(bot)) {
    await waitForAnyBotEvent(bot, ["spawn"], config.timeoutMs, "spawn");
  }

  if (!signals.hasForcedMove()) {
    try {
      await waitForAnyBotEvent(bot, ["forcedMove"], Math.min(config.timeoutMs, 10_000), "forcedMove");
    } catch (error) {
      console.log(`[probe] forcedMove wait warning: ${formatError(error)}`);
    }
  }

  if (typeof bot.waitForChunksToLoad === "function") {
    console.log("[probe] waiting for chunks with bot.waitForChunksToLoad()");
    await withTimeout(bot.waitForChunksToLoad(), config.timeoutMs, "chunks to load");
  }

  if (typeof bot.waitForTicks === "function" && isPhysicsEnabled(bot)) {
    console.log("[probe] waiting 5 physics ticks after chunk load");
    await withTimeout(bot.waitForTicks(5), 10_000, "physics ticks");
  }

  console.log(`[probe] waiting ${config.spawnSettleMs}ms after world-ready checks`);
  await delay(config.spawnSettleMs);
}

async function waitForPostCommandSettle(
  bot: Bot,
  config: Pick<ProbeConfig, "spawnSettleMs" | "timeoutMs">,
): Promise<void> {
  if (typeof bot.waitForTicks === "function" && isPhysicsEnabled(bot)) {
    console.log("[probe] waiting 20 physics ticks after ready command");
    await withTimeout(bot.waitForTicks(20), 10_000, "post-command physics ticks");
  } else {
    await delay(1000);
  }

  if (typeof bot.waitForChunksToLoad === "function") {
    console.log("[probe] waiting for chunks after ready command");
    await withTimeout(bot.waitForChunksToLoad(), config.timeoutMs, "post-command chunks to load");
  }

  console.log(`[probe] waiting ${config.spawnSettleMs}ms after ready command`);
  await delay(config.spawnSettleMs);
}

function shouldRunReadyCommand(bot: Bot, expectedDimension: string | undefined): boolean {
  if (expectedDimension === undefined) {
    return true;
  }

  const normalizedExpectedDimension = expectedDimension.trim();
  if (normalizedExpectedDimension.length === 0) {
    return true;
  }

  const currentDimension = getCurrentDimension(bot);
  if (currentDimension === normalizedExpectedDimension) {
    console.log(`[probe] ready command skipped: already in expected dimension ${currentDimension}`);
    return false;
  }

  console.log(
    `[probe] ready command needed: current dimension=${currentDimension ?? "unknown"} expected=${normalizedExpectedDimension}`,
  );
  return true;
}

async function waitForExpectedDimension(
  bot: Bot,
  expectedDimension: string,
  timeoutMs: number,
): Promise<void> {
  const normalizedExpectedDimension = expectedDimension.trim();
  if (normalizedExpectedDimension.length === 0) {
    throw new Error("--expected-dimension must not be empty");
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const currentDimension = getCurrentDimension(bot);
    if (currentDimension === normalizedExpectedDimension) {
      console.log(`[probe] dimension confirmed: ${currentDimension}`);
      return;
    }

    if (typeof bot.waitForTicks === "function") {
      await withTimeout(bot.waitForTicks(5), 10_000, "dimension settle ticks");
    } else {
      await delay(250);
    }
  }

  throw new Error(
    `Timed out waiting for dimension=${normalizedExpectedDimension}; current=${getCurrentDimension(bot) ?? "unknown"}`,
  );
}

async function maybeResyncGroundSupport(
  bot: Bot,
  config: Pick<ProbeConfig, "expectedDimension" | "syntheticSupportRadius" | "timeoutMs">,
): Promise<void> {
  const position = bot.entity?.position;
  if (position === undefined) {
    console.log("[probe] server ground resync skipped: no bot position");
    return;
  }

  const dimension = config.expectedDimension ?? getCurrentDimension(bot);
  if (dimension === undefined) {
    console.log("[probe] server ground resync skipped: no dimension");
    return;
  }

  const feet = position.floored();
  const belowPosition = feet.offset(0, -1, 0);
  const localBelow = bot.blockAt(belowPosition);
  if (!isPassableBlock(localBelow)) {
    console.log(
      `[probe] server ground resync skipped: local below already solid name=${localBelow?.name ?? "unknown"}`,
    );
    return;
  }

  const serverBelowIsAir = await probeServerAirState(bot, dimension, belowPosition, config.timeoutMs);
  if (serverBelowIsAir) {
    console.log("[probe] server ground resync skipped: server also reports air below");
    return;
  }

  injectSyntheticSupport(bot, config.syntheticSupportRadius);
  console.log(
    `[probe] server ground resync applied at (${belowPosition.x}, ${belowPosition.y}, ${belowPosition.z})`,
  );
}

async function probeServerAirState(
  bot: Bot,
  dimension: string,
  position: { readonly x: number; readonly y: number; readonly z: number },
  timeoutMs: number,
): Promise<boolean> {
  const marker = `probe-air-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const airMarker = `${marker}:air`;
  const solidMarker = `${marker}:solid`;
  const messagePromise = waitForMatchingMessage(bot, [airMarker, solidMarker], Math.min(timeoutMs, 10_000));

  bot.chat(
    `/execute in ${dimension} if block ${position.x} ${position.y} ${position.z} minecraft:air run tellraw @s {"text":"${airMarker}"}`,
  );
  bot.chat(
    `/execute in ${dimension} unless block ${position.x} ${position.y} ${position.z} minecraft:air run tellraw @s {"text":"${solidMarker}"}`,
  );

  const matched = await messagePromise;
  console.log(
    `[probe] server block probe pos=(${position.x}, ${position.y}, ${position.z}) result=${matched === airMarker ? "air" : "solid"}`,
  );
  return matched === airMarker;
}

function waitForMatchingMessage(
  bot: Bot,
  markers: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for message markers=${markers.join(",")}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      bot.removeListener("message", onMessage);
      bot.removeListener("end", onEnd);
      bot.removeListener("kicked", onKicked);
      bot.removeListener("error", onError);
    };

    const settle = (finish: () => void) => {
      cleanup();
      finish();
    };

    const onMessage = (message: unknown) => {
      const raw = String(message);
      const marker = markers.find((candidate) => raw.includes(candidate));
      if (marker !== undefined) {
        settle(() => resolve(marker));
      }
    };
    const onEnd = (reason: unknown) =>
      settle(() => reject(new Error(`Bot ended before marker message: ${String(reason ?? "")}`)));
    const onKicked = (reason: unknown) =>
      settle(() => reject(new Error(`Bot kicked before marker message: ${String(reason)}`)));
    const onError = (error: unknown) => settle(() => reject(error));

    bot.on("message", onMessage);
    bot.once("end", onEnd);
    bot.once("kicked", onKicked);
    bot.once("error", onError);
  });
}

function getCurrentDimension(bot: Bot): string | undefined {
  const game = bot.game as { readonly dimension?: string } | undefined;
  return game?.dimension?.trim() || undefined;
}

function hasPositiveHealth(bot: Bot): boolean {
  const health = (bot as { readonly health?: number }).health;
  return health !== undefined && Number.isFinite(health) && health > 0;
}

function waitForAnyBotEvent(
  bot: Bot,
  eventNames: readonly string[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanupCallbacks: Array<() => void> = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      for (const callback of cleanupCallbacks) {
        callback();
      }
    };

    const settle = (finish: () => void) => {
      cleanup();
      finish();
    };

    for (const eventName of eventNames) {
      const listener = () => settle(resolve);
      bot.once(eventName as keyof BotEvents, listener);
      cleanupCallbacks.push(() => bot.removeListener(eventName as keyof BotEvents, listener));
    }

    const onEnd = (reason: unknown) =>
      settle(() => reject(new Error(`Bot ended before ${label}: ${String(reason ?? "")}`)));
    const onKicked = (reason: unknown) =>
      settle(() => reject(new Error(`Bot kicked before ${label}: ${String(reason)}`)));
    const onError = (error: unknown) => settle(() => reject(error));

    bot.once("end", onEnd);
    bot.once("kicked", onKicked);
    bot.once("error", onError);
    cleanupCallbacks.push(
      () => bot.removeListener("end", onEnd),
      () => bot.removeListener("kicked", onKicked),
      () => bot.removeListener("error", onError),
    );
  });
}

function setPhysicsEnabled(bot: Bot, enabled: boolean, reason: string): void {
  const target = bot as Bot & { physicsEnabled?: boolean };
  target.physicsEnabled = enabled;
  console.log(`[probe] physicsEnabled=${String(enabled)} reason=${reason}`);
}

function isPhysicsEnabled(bot: Bot): boolean {
  return Boolean((bot as Bot & { physicsEnabled?: boolean }).physicsEnabled);
}

function injectSyntheticSupport(bot: Bot, radius: number): void {
  const position = bot.entity?.position;
  if (position === undefined) {
    console.log("[probe] synthetic support skipped: no bot position");
    return;
  }

  const feet = position.floored();
  const supportY = feet.y - 1;
  const clampedRadius = Math.max(0, Math.min(radius, 16));
  for (let dz = -clampedRadius; dz <= clampedRadius; dz += 1) {
    for (let dx = -clampedRadius; dx <= clampedRadius; dx += 1) {
      const columnFeet = { x: feet.x + dx, y: feet.y, z: feet.z + dz };
      const stateId = selectSyntheticSupportStateId(bot, columnFeet);
      bot.world.setBlockStateId(new Vec3(columnFeet.x, supportY, columnFeet.z), stateId);
    }
  }
  console.log(`[probe] injected synthetic support radius=${clampedRadius} at y=${supportY}`);
}

function selectSyntheticSupportStateId(bot: Bot, feet: IntPosition): number {
  for (let offsetY = 0; offsetY <= 4; offsetY += 1) {
    const sample = bot.blockAt(new Vec3(feet.x, feet.y + offsetY, feet.z));
    const sampleStateId = (sample as { readonly stateId?: number } | null)?.stateId;
    if (sample !== null && sample.boundingBox === "block" && typeof sampleStateId === "number") {
      return sampleStateId;
    }
  }

  const stone = (bot.registry as { readonly blocksByName?: Record<string, { readonly defaultState?: number }> })
    .blocksByName?.stone;
  return stone?.defaultState ?? 1;
}

function formatClientPacket(packet: unknown): string {
  if (packet === null || typeof packet !== "object") {
    return String(packet);
  }

  const entries = Object.entries(packet as Record<string, unknown>).map(([key, value]) => {
    if (typeof value === "number") {
      return `${key}=${Number.isFinite(value) ? value.toFixed(2) : String(value)}`;
    }
    if (typeof value === "object" && value !== null) {
      return `${key}=${JSON.stringify(value)}`;
    }
    return `${key}=${String(value)}`;
  });
  return entries.join(" ");
}

function formatWorldPacket(packet: unknown): string {
  const worldPacket = packet as RawWorldIdentityPacket;
  return [
    `identity=${readPacketWorldIdentity(packet) ?? "unknown"}`,
    `dimension=${formatUnknownPacketValue(readPacketDimensionType(packet))}`,
    `worldType=${formatUnknownPacketValue(worldPacket.worldType)}`,
    `worldName=${formatUnknownPacketValue(worldPacket.worldState?.name ?? worldPacket.worldName)}`,
    `copyMetadata=${formatUnknownPacketValue(worldPacket.copyMetadata)}`,
  ].join(" ");
}

function readPacketWorldIdentity(packet: unknown): string | undefined {
  if (packet === null || typeof packet !== "object") {
    return undefined;
  }

  const worldPacket = packet as RawWorldIdentityPacket;
  const value = worldPacket.worldState?.name ?? worldPacket.worldName ?? worldPacket.dimension;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readPacketDimensionType(packet: unknown): string | undefined {
  if (packet === null || typeof packet !== "object") {
    return undefined;
  }

  const worldPacket = packet as RawWorldIdentityPacket;
  const value = worldPacket.worldState?.dimension ?? worldPacket.dimension ?? worldPacket.worldType;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function scheduleDimensionBoundsSync(bot: Bot, packet: unknown): void {
  syncDimensionBoundsFromPacket(bot, packet);
  queueMicrotask(() => syncDimensionBoundsFromPacket(bot, packet));
  setTimeout(() => syncDimensionBoundsFromPacket(bot, packet), 0);
}

function syncDimensionBoundsFromPacket(bot: Bot, packet: unknown): void {
  const dimensionType = readPacketDimensionType(packet);
  if (dimensionType === undefined) {
    return;
  }

  syncDimensionBoundsFromType(bot, dimensionType);
}

function syncDimensionBoundsFromType(bot: Bot, dimensionType: string): void {
  const dimensionData = findRegistryDimensionData(bot, dimensionType);
  if (dimensionData === undefined) {
    console.log(`[probe] dimension bounds unavailable for type=${dimensionType}`);
    return;
  }

  const minY = readRecordNumber(dimensionData, "minY") ?? readRecordNumber(dimensionData, "min_y");
  const height =
    readRecordNumber(dimensionData, "height") ?? readRecordNumber(dimensionData, "logical_height");
  if (minY === undefined || height === undefined) {
    console.log(`[probe] dimension bounds invalid for type=${dimensionType}`);
    return;
  }

  const mutableGame = bot.game as { minY?: number; height?: number };
  mutableGame.minY = minY;
  mutableGame.height = height;
  syncLoadedWorldColumnBounds(bot, minY, height);
  console.log(`[probe] dimension bounds synced type=${dimensionType} minY=${minY} height=${height}`);
}

function syncLoadedWorldColumnBounds(bot: Bot, minY: number, height: number): void {
  const world = bot.world as
    | {
        readonly async?: {
          readonly columns?: Record<string, unknown>;
        };
      }
    | undefined;
  const columns = Object.values(world?.async?.columns ?? {});
  for (const column of columns) {
    if (column !== null && typeof column === "object") {
      const mutableColumn = column as { minY?: number; worldHeight?: number; numSections?: number };
      mutableColumn.minY = minY;
      mutableColumn.worldHeight = height;
      mutableColumn.numSections = height >> 4;
    }
  }
}

function findRegistryDimensionData(bot: Bot, dimensionType: string): Record<string, unknown> | undefined {
  const registry = bot.registry as {
    readonly dimensionsByName?: Record<string, unknown>;
  };
  const dimensionsByName = registry.dimensionsByName;
  if (dimensionsByName === undefined) {
    return undefined;
  }

  const candidates = [
    dimensionType,
    dimensionType.replace(/^minecraft:/, ""),
    dimensionType.includes(":") ? dimensionType.slice(dimensionType.indexOf(":") + 1) : dimensionType,
  ];
  for (const candidate of candidates) {
    const value = dimensionsByName[candidate];
    if (value !== undefined && value !== null && typeof value === "object") {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function readRecordNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatUnknownPacketValue(value: unknown): string {
  if (value === undefined) {
    return "unknown";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function clearMineflayerWorldCache(bot: Bot, reason: string): void {
  const world = bot.world as
    | {
        unloadColumn?(chunkX: number, chunkZ: number): void;
        readonly async?: {
          readonly columns?: Record<string, unknown>;
        };
      }
    | undefined;
  const columnKeys = Object.keys(world?.async?.columns ?? {});
  let cleared = 0;
  for (const key of columnKeys) {
    const [chunkXText, chunkZText] = key.split(",");
    const chunkX = Number(chunkXText);
    const chunkZ = Number(chunkZText);
    if (!Number.isInteger(chunkX) || !Number.isInteger(chunkZ)) {
      continue;
    }
    world?.unloadColumn?.(chunkX, chunkZ);
    cleared += 1;
  }
  console.log(`[probe] cleared world cache columns=${cleared} reason=${reason}`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
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

function readProbeConfig(args: readonly string[], env: NodeJS.ProcessEnv): ProbeConfig {
  if (args.includes("--help") || args.includes("-h")) {
    printUsageAndExit();
  }

  const named = readNamedArgs(args);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const x = readNumber("x", named.x ?? positional[0]);
  const y = readNumber("y", named.y ?? positional[1]);
  const z = readNumber("z", named.z ?? positional[2]);

  const externalAuthRequired =
    named.externalAuthRequired ?? env.MC_EXTERNAL_AUTH_REQUIRED ?? "false";
  const externalAuthSecret = named.externalAuthSecret ?? env.MC_EXTERNAL_AUTH_SECRET;
  const loginCommand =
    named.loginCommand ??
    env.MC_LOGIN_COMMAND ??
    (externalAuthRequired === "true" && externalAuthSecret !== undefined
      ? `/login ${externalAuthSecret}`
      : undefined);
  const readyCommand = named.readyCommand ?? env.MC_GOTO_READY_COMMAND;
  const expectedDimension = named.expectedDimension ?? env.MC_GOTO_EXPECTED_DIMENSION;

  return {
    host: named.host ?? env.MC_HOST ?? "127.0.0.1",
    port: readInteger("port", named.port ?? env.MC_PORT ?? "25565"),
    username: named.username ?? env.MC_USERNAME ?? "ts-core-goto-probe",
    auth: readAuthMode(named.auth ?? env.MC_AUTH),
    version: named.version ?? env.MC_VERSION,
    loginCommand,
    readyCommand,
    expectedDimension,
    serverGroundResync: readBoolean(
      "server-ground-resync",
      named.serverGroundResync ?? env.MC_GOTO_SERVER_GROUND_RESYNC ?? "false",
    ),
    initialPhysicsEnabled: readBoolean(
      "initial-physics-enabled",
      named.initialPhysicsEnabled ?? env.MC_GOTO_INITIAL_PHYSICS_ENABLED ?? "true",
    ),
    injectSyntheticSupport: readBoolean(
      "inject-synthetic-support",
      named.injectSyntheticSupport ?? env.MC_GOTO_INJECT_SYNTHETIC_SUPPORT ?? "false",
    ),
    syntheticSupportRadius: readInteger(
      "synthetic-support-radius",
      named.syntheticSupportRadius ?? env.MC_GOTO_SYNTHETIC_SUPPORT_RADIUS ?? "1",
    ),
    freezePhysicsAfterReadyMs: readInteger(
      "freeze-physics-after-ready-ms",
      named.freezePhysicsAfterReadyMs ?? env.MC_GOTO_FREEZE_PHYSICS_AFTER_READY_MS ?? "0",
    ),
    x,
    y,
    z,
    canDig: readBoolean("can-dig", named.canDig ?? env.MC_GOTO_CAN_DIG ?? "false"),
    digCost: readNumber("dig-cost", named.digCost ?? env.MC_GOTO_DIG_COST ?? "10"),
    avoidCreepers: readBoolean(
      "avoid-creepers",
      named.avoidCreepers ?? env.MC_GOTO_AVOID_CREEPERS ?? "true",
    ),
    range: readNumber("range", named.range ?? env.MC_GOTO_RANGE ?? "2"),
    diagnoseSeconds: readInteger(
      "diagnose-seconds",
      named.diagnoseSeconds ?? env.MC_GOTO_DIAGNOSE_SECONDS ?? "0",
    ),
    goto: readBoolean("goto", named.goto ?? env.MC_GOTO_RUN_GOTO ?? "true"),
    ignoreExplosions: readBoolean(
      "ignore-explosions",
      named.ignoreExplosions ?? env.MC_GOTO_IGNORE_EXPLOSIONS ?? "false",
    ),
    timeoutMs: readInteger("timeout-ms", named.timeoutMs ?? env.MC_GOTO_TIMEOUT_MS ?? "60000"),
    spawnSettleMs: readInteger(
      "spawn-settle-ms",
      named.spawnSettleMs ?? env.MC_GOTO_SPAWN_SETTLE_MS ?? "3000",
    ),
  };
}

function readNamedArgs(args: readonly string[]): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith("--")) {
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex >= 0) {
      values[toCamelCase(arg.slice(2, equalsIndex))] = arg.slice(equalsIndex + 1);
      continue;
    }

    const nextArg = args[index + 1];
    if (nextArg === undefined || nextArg.startsWith("--")) {
      values[toCamelCase(arg.slice(2))] = "true";
      continue;
    }

    values[toCamelCase(arg.slice(2))] = nextArg;
    index += 1;
  }

  return values;
}

function readNumber(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Missing or invalid --${name}`);
  }

  return parsed;
}

function readInteger(name: string, value: string | undefined): number {
  const parsed = readNumber(name, value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`--${name} must be an integer`);
  }

  return parsed;
}

function readBoolean(name: string, value: string | undefined): boolean {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`--${name} must be true or false`);
}

function readAuthMode(value: string | undefined): MineflayerAuthMode | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  if (value === "offline" || value === "microsoft" || value === "mojang") {
    return value;
  }

  throw new Error("--auth must be offline, microsoft, or mojang");
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function formatPosition(position: { readonly x: number; readonly y: number; readonly z: number }) {
  return `(${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)})`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

function assertReachedTarget(bot: Bot, config: ProbeConfig): void {
  const position = bot.entity?.position;
  if (position === undefined) {
    throw new Error("Bot has no entity position after goto");
  }

  const floored = position.floored();
  const distance =
    (position.x - config.x) ** 2 + (position.y - config.y) ** 2 + (position.z - config.z) ** 2;
  if (config.range > 0 && distance <= config.range ** 2) {
    return;
  }

  if (config.range === 0 && floored.x === config.x && floored.y === config.y && floored.z === config.z) {
    return;
  }

  throw new Error(
    `Pathfinder finished before reaching target: current=${formatPosition(position)}, target=(${config.x}, ${config.y}, ${config.z})`,
  );
}

function logBlockSnapshot(bot: Bot, config: ProbeConfig): void {
  const position = bot.entity?.position;
  if (position === undefined) {
    console.log("[probe] block_snapshot skipped: no bot position");
    return;
  }

  logBotStateSnapshot(bot);
  const current = position.floored();
  const samples = [
    ["feet", current],
    ["below", current.offset(0, -1, 0)],
    ["head", current.offset(0, 1, 0)],
    ["target", current.offset(config.x - current.x, config.y - current.y, config.z - current.z)],
    [
      "target_below",
      current.offset(config.x - current.x, config.y - 1 - current.y, config.z - current.z),
    ],
  ] as const;

  for (const [label, samplePosition] of samples) {
    const block = bot.blockAt(samplePosition);
    console.log(
      `[probe] block_${label} pos=(${samplePosition.x}, ${samplePosition.y}, ${samplePosition.z}) name=${block?.name ?? "unknown"} type=${block?.type ?? "unknown"} stateId=${formatBlockStateId(block)}`,
    );
  }

  logColumnSnapshot(bot, current, "current");
  logAreaColumns(bot, current, "current", 1);
  const target = new Vec3(config.x, config.y, config.z);
  logColumnSnapshot(bot, target, "target");
}

async function runPhysicsDiagnostics(bot: Bot, seconds: number): Promise<void> {
  if (seconds <= 0) {
    return;
  }

  for (let index = 0; index < seconds; index += 1) {
    const position = bot.entity?.position;
    const velocity = bot.entity?.velocity;
    const onGround = Boolean((bot.entity as { readonly onGround?: boolean } | undefined)?.onGround);
    if (position === undefined) {
      console.log(`[probe] physics t=${index}s position=unknown`);
    } else {
      const current = position.floored();
      const feet = bot.blockAt(current);
      const below = bot.blockAt(current.offset(0, -1, 0));
      const head = bot.blockAt(current.offset(0, 1, 0));
      console.log(
        [
          `[probe] physics t=${index}s`,
          `pos=${formatPosition(position)}`,
          `vel=${velocity === undefined ? "unknown" : formatPosition(velocity)}`,
          `onGround=${onGround}`,
          `feet=${feet?.name ?? "unknown"}`,
          `below=${below?.name ?? "unknown"}`,
          `head=${head?.name ?? "unknown"}`,
        ].join(" "),
      );
    }
    await delay(1000);
  }
}

function printUsageAndExit(): never {
  console.log(`Usage:
  pnpm exec tsx scripts/probes/go-to-probe.ts --x <x> --y <y> --z <z>
  pnpm exec tsx scripts/probes/go-to-probe.ts <x> <y> <z>

Options:
  --host <host>              Minecraft server host, default MC_HOST or 127.0.0.1
  --port <port>              Minecraft server port, default MC_PORT or 25565
  --username <name>          Bot username, default MC_USERNAME or ts-core-goto-probe
  --auth <auth>              Mineflayer auth mode, default MC_AUTH
  --version <version>        Minecraft protocol version, default MC_VERSION
  --login-command <command>  Optional chat command after login, default MC_LOGIN_COMMAND
  --ready-command <command>  Optional command after world ready, default MC_GOTO_READY_COMMAND
  --expected-dimension <id>  Optional dimension id to confirm before goto, default MC_GOTO_EXPECTED_DIMENSION
  --server-ground-resync <true|false>  Query server truth for the block below and patch local support when desynced, default false
  --initial-physics-enabled <true|false>  Initial physics mode, default MC_GOTO_INITIAL_PHYSICS_ENABLED or true
  --inject-synthetic-support <true|false>  Inject local support blocks under bot for diagnostics, default false
  --synthetic-support-radius <number>  Radius for synthetic support patch, default 1
  --freeze-physics-after-ready-ms <number>  Freeze physics around ready command, default MC_GOTO_FREEZE_PHYSICS_AFTER_READY_MS or 0
  --can-dig <true|false>     Whether pathfinder may dig blocks, default MC_GOTO_CAN_DIG or false
  --dig-cost <number>        Pathfinder dig cost, default MC_GOTO_DIG_COST or 10
  --avoid-creepers <bool>    Avoid creepers during pathing, default true
  --range <number>           GoalNear range; use 0 for exact GoalBlock, default MC_GOTO_RANGE or 2
  --diagnose-seconds <n>     Print position and nearby blocks before goto, default 0
  --goto <true|false>        Run goto after diagnostics, default true
  --ignore-explosions <bool> Ignore explosion packets inside probe, default false
  --timeout-ms <number>      Login/spawn timeout, default MC_GOTO_TIMEOUT_MS or 60000
  --spawn-settle-ms <number> Delay after spawn before pathing, default MC_GOTO_SPAWN_SETTLE_MS or 3000
`);
  process.exit(0);
}

function logBotStateSnapshot(bot: Bot): void {
  const position = bot.entity?.position;
  const velocity = bot.entity?.velocity;
  const onGround = Boolean((bot.entity as { readonly onGround?: boolean } | undefined)?.onGround);
  const game = bot.game as
    | {
        readonly dimension?: string;
        readonly gameMode?: string;
        readonly levelType?: string;
        readonly hardcore?: boolean;
        readonly minY?: number;
        readonly height?: number;
      }
    | undefined;
  console.log(
    [
      "[probe] bot_state",
      `version=${bot.version ?? "unknown"}`,
      `dimension=${game?.dimension ?? "unknown"}`,
      `gameMode=${game?.gameMode ?? "unknown"}`,
      `levelType=${game?.levelType ?? "unknown"}`,
      `minY=${game?.minY ?? "unknown"}`,
      `height=${game?.height ?? "unknown"}`,
      `hardcore=${String(game?.hardcore ?? false)}`,
      `onGround=${onGround}`,
      `pos=${position === undefined ? "unknown" : formatPosition(position)}`,
      `vel=${velocity === undefined ? "unknown" : formatPosition(velocity)}`,
    ].join(" "),
  );
}

function formatBlockStateId(block: MineflayerBlock | null): string {
  const stateId = (block as { readonly stateId?: unknown } | null)?.stateId;
  return typeof stateId === "number" ? String(stateId) : "unknown";
}

function logAreaColumns(
  bot: Bot,
  center: { readonly x: number; readonly y: number; readonly z: number },
  label: string,
  radius: number,
): void {
  for (let dz = -radius; dz <= radius; dz += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx === 0 && dz === 0) {
        continue;
      }
      logColumnSnapshot(bot, new Vec3(center.x + dx, center.y, center.z + dz), `${label}_${dx}_${dz}`);
    }
  }
}

function logColumnSnapshot(
  bot: Bot,
  center: { readonly x: number; readonly y: number; readonly z: number },
  label: string,
): void {
  const baseY = Math.floor(center.y);
  for (let dy = -2; dy <= 3; dy += 1) {
    const samplePosition = new Vec3(Math.floor(center.x), baseY + dy, Math.floor(center.z));
    const block = bot.blockAt(samplePosition);
    console.log(
      [
        `[probe] column_${label}`,
        `pos=(${samplePosition.x}, ${samplePosition.y}, ${samplePosition.z})`,
        `name=${block?.name ?? "unknown"}`,
        `type=${block?.type ?? "unknown"}`,
        `stateId=${formatBlockStateId(block)}`,
        `bbox=${block?.boundingBox ?? "unknown"}`,
      ].join(" "),
    );
  }
}

function formatOptionalNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "unknown";
  }
  return value.toFixed(2);
}
