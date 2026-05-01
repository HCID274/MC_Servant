import { appendFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import type { Bot } from "mineflayer";
import {
  attachMineflayerBlockWorldCompatibility,
  parseWorldDimensionMap,
} from "../../../src/runtime/transport/block-world-compat.js";
import { attachMineflayerDimensionBoundsSync } from "../../../src/runtime/transport/runtime.js";
import type { MineflayerBotHandle } from "../../../src/runtime/transport/types.js";
import {
  collectCommandFeedback,
  floorPoint,
  parsePointText,
  readDimension,
} from "./fact-scan-common.js";
import {
  type ProbeBaseConfig,
  type ProbePoint,
  createProbeBot,
  fail,
  getEventSource,
  getPacketSource,
  getPosition,
  prepareBot,
  readBaseConfig,
  readFlags,
  readOptionalStringFlag,
} from "./knockback-probe-common.js";

const require = createRequire(import.meta.url);
const vec3Module = require("vec3") as {
  Vec3: new (
    x: number,
    y: number,
    z: number,
  ) => { readonly x: number; readonly y: number; readonly z: number };
};
const { Vec3 } = vec3Module;
const evidenceDir = "/tmp/tnet003";
const probeId = "T-NET-003.1-block-fact-root-cause";
const flags = readFlags(process.argv.slice(2));
const config = readBaseConfig(process.argv.slice(2), process.env);
const bot = createProbeBot(config);
const adapterFixEnabled =
  readOptionalStringFlag(flags, process.env, "adapter-fix", "TNET003_ADAPTER_FIX") === "true";
const removeAdapterFix = adapterFixEnabled
  ? attachMineflayerBlockWorldCompatibility(bot as unknown as MineflayerBotHandle, {
      worldDimensionMap: parseWorldDimensionMap(process.env.MC_WORLD_DIMENSION_MAP),
    })
  : undefined;
const removeDimensionBoundsFix = adapterFixEnabled
  ? attachMineflayerDimensionBoundsSync(bot as unknown as MineflayerBotHandle)
  : undefined;
const rawLogPath = createEvidencePath(probeId);
const packetLog: PacketLogEntry[] = [];
const blockUpdates: BlockUpdateEntry[] = [];

try {
  console.log("[probe] 我在排除哪一环: T-NET-003.1 multiworld（多世界）方块事实失真根因。");
  await prepareBot(bot, config);
  const target = readTargetPoint();
  attachPacketProbes(bot);
  attachBlockUpdateProbe(bot);

  const control = await sampleCommandControl(target);
  const before = sampleLocalBlock(target);
  const h1 = await runH1(target, control);
  let h3: HypothesisResult | undefined;
  let h2: HypothesisResult | undefined;

  if (h1.verdict === "PASS") {
    h3 = await runH3(target, control);
  }
  const stopAfterH3 =
    readOptionalStringFlag(flags, process.env, "stop-after-h3", "TNET003_STOP_AFTER_H3") === "true";
  if (h1.verdict === "PASS" && h3?.verdict === "PASS" && !stopAfterH3) {
    h2 = runH2(target);
  }

  const rootCause =
    [h1, h3, h2].find((result): result is HypothesisResult => result?.verdict === "FAIL") ??
    undefined;
  const finalVerdict = rootCause === undefined ? "PASS" : "FAIL";
  const evidence = {
    task_id: "T-NET-003",
    probe_id: probeId,
    world_label: config.worldLabel,
    bot_dimension: readDimension(bot),
    bot_world_name: readMineflayerWorldName(bot),
    target_position: target,
    bot_position: getPosition(bot) ?? "unknown",
    timestamp_ms: Date.now(),
    verdict: finalVerdict,
    root_cause_hypothesis: rootCause?.hypothesis ?? "none",
    raw_log_path: rawLogPath,
    evidence: {
      control,
      before,
      after: sampleLocalBlock(target),
      h1,
      h3: h3 ?? "not-run-because-earlier-root-cause",
      h2:
        h2 ??
        (stopAfterH3
          ? "not-run-by-regression-stop-after-h3"
          : "not-run-because-earlier-root-cause"),
      packet_summary: summarizePackets(target),
      packet_samples: packetLog.slice(0, 40),
      block_update_samples: blockUpdates.slice(0, 20),
    },
  };
  appendJsonl(rawLogPath, evidence);
  console.log(
    `[probe] RESULT（结果） ${finalVerdict} world_label=${config.worldLabel} root=${rootCause?.hypothesis ?? "none"} raw=${rawLogPath}`,
  );
  process.exitCode = finalVerdict === "PASS" ? 0 : 2;
} catch (error) {
  fail(error);
} finally {
  removeAdapterFix?.();
  removeDimensionBoundsFix?.();
  bot.quit("T-NET-003.1 probe finished");
}

interface PacketLogEntry {
  readonly name: string;
  readonly timestamp_ms: number;
  readonly dimension: string;
  readonly mineflayer_world_name: string;
  readonly target_related: boolean;
  readonly summary: Readonly<Record<string, unknown>>;
}

interface BlockUpdateEntry {
  readonly timestamp_ms: number;
  readonly old_block: string;
  readonly new_block: string;
  readonly position: ProbePoint | "unknown";
  readonly target_related: boolean;
}

interface HypothesisResult {
  readonly hypothesis: "H1" | "H2" | "H3";
  readonly verdict: "PASS" | "FAIL";
  readonly evidence: Readonly<Record<string, unknown>>;
}

function readTargetPoint(): ProbePoint {
  const botPosition = getPosition(bot);
  const target =
    parsePointText(readOptionalStringFlag(flags, process.env, "target", "TNET003_TARGET")) ??
    (botPosition === undefined
      ? undefined
      : floorPoint({ x: botPosition.x, y: botPosition.y - 1, z: botPosition.z }));
  if (target === undefined) {
    throw new Error("missing --target x,y,z and bot position unavailable");
  }
  return target;
}

async function runH1(
  target: ProbePoint,
  control: Readonly<Record<string, unknown>>,
): Promise<HypothesisResult> {
  const assumedEvidencePath = readOptionalStringFlag(
    flags,
    process.env,
    "assume-h1-pass",
    "TNET003_ASSUME_H1_PASS",
  );
  if (assumedEvidencePath !== undefined) {
    return {
      hypothesis: "H1",
      verdict: "PASS",
      evidence: {
        assumed_from_prior_evidence: assumedEvidencePath,
        dimension_aligned: isDimensionAligned(control),
        mineflayer_world_name: readMineflayerWorldName(bot),
        bot_dimension: readDimension(bot),
      },
    };
  }
  const beforeCount = countTargetBlockPackets(target);
  const beforeUpdateCount = blockUpdates.length;
  const beforeBlockPacketCount = countPackets("block_change") + countPackets("multi_block_change");
  const waitMs = readWaitMs("h1-wait-ms", "TNET003_H1_WAIT_MS", config.durationMs);
  console.log(
    `[probe] H1: 请在 world_label=${config.worldLabel} 的 ${formatPoint(target)} 放/挖一次方块; 等待 ${waitMs}ms`,
  );
  await delay(waitMs);
  const targetPacketDelta = countTargetBlockPackets(target) - beforeCount;
  const blockPacketDelta =
    countPackets("block_change") + countPackets("multi_block_change") - beforeBlockPacketCount;
  const blockUpdateDelta = blockUpdates.length - beforeUpdateCount;
  const dimensionAligned = isDimensionAligned(control);
  const targetUpdateSeen = blockUpdates.some((entry) => entry.target_related);
  const anyChangeSeen = blockPacketDelta > 0 || blockUpdateDelta > 0;
  const verdict =
    dimensionAligned && (targetPacketDelta > 0 || targetUpdateSeen || anyChangeSeen)
      ? "PASS"
      : "FAIL";
  return {
    hypothesis: "H1",
    verdict,
    evidence: {
      pass_means:
        "adapter dimension key and Mineflayer world key can receive/apply target block changes",
      dimension_aligned: dimensionAligned,
      target_block_packet_delta: targetPacketDelta,
      block_packet_delta: blockPacketDelta,
      block_update_delta: blockUpdateDelta,
      target_block_update_seen: targetUpdateSeen,
      mineflayer_world_name: readMineflayerWorldName(bot),
      bot_dimension: readDimension(bot),
      root_if_fail:
        "dimension/world key mismatch or target block change is not entering Mineflayer cache path",
    },
  };
}

async function runH3(
  target: ProbePoint,
  control: Readonly<Record<string, unknown>>,
): Promise<HypothesisResult> {
  const switchCommand = readOptionalStringFlag(
    flags,
    process.env,
    "h3-switch-command",
    "TNET003_H3_SWITCH_COMMAND",
  );
  const returnCommand = readOptionalStringFlag(
    flags,
    process.env,
    "h3-return-command",
    "TNET003_H3_RETURN_COMMAND",
  );
  const manualMode =
    readOptionalStringFlag(flags, process.env, "h3-manual", "TNET003_H3_MANUAL") === "true";
  if (!manualMode && (switchCommand === undefined || returnCommand === undefined)) {
    return {
      hypothesis: "H3",
      verdict: "FAIL",
      evidence: {
        pass_means: "dimension switch clears or replaces Mineflayer chunk cache",
        missing_commands: true,
        root_if_fail:
          "cannot falsify H3 without explicit switch/return commands; provide --h3-switch-command and --h3-return-command",
      },
    };
  }

  const before = sampleLocalBlock(target);
  const beforeWorld = readMineflayerWorldName(bot);
  const beforeRespawnCount = countPackets("respawn");
  if (manualMode) {
    console.log("[probe] H3 manual（人工）: 请把 bot（机器人）切到非 resource world（非资源世界）");
  } else if (switchCommand !== undefined) {
    bot.chat(switchCommand);
  }
  await delay(readWaitMs("h3-switch-wait-ms", "TNET003_H3_SWITCH_WAIT_MS", 5000));
  const away = sampleLocalBlock(target);
  const awayWorld = readMineflayerWorldName(bot);
  if (manualMode) {
    console.log("[probe] H3 manual（人工）: 请把 bot（机器人）切回 resource world（资源世界）");
  } else if (returnCommand !== undefined) {
    bot.chat(returnCommand);
  }
  await delay(readWaitMs("h3-return-wait-ms", "TNET003_H3_RETURN_WAIT_MS", 5000));
  const returned = sampleLocalBlock(target);
  const afterWorld = readMineflayerWorldName(bot);
  const respawnDelta = countPackets("respawn") - beforeRespawnCount;
  const switchObserved = respawnDelta > 0 || beforeWorld !== awayWorld || awayWorld !== afterWorld;
  const returnedWorldMatches = worldMatchesServerDimension(
    afterWorld,
    String(control.server_dimension ?? ""),
  );
  const staleCarried =
    switchObserved &&
    before.block_key !== "unknown" &&
    away.block_key === before.block_key &&
    returned.block_key === before.block_key &&
    beforeWorld === afterWorld;
  return {
    hypothesis: "H3",
    verdict: switchObserved && !staleCarried && returnedWorldMatches ? "PASS" : "FAIL",
    evidence: {
      pass_means: "cross-world switch changes world key or clears old chunk cache",
      control_dimension: control.server_dimension ?? "unknown",
      before_world: beforeWorld,
      away_world: awayWorld,
      after_world: afterWorld,
      respawn_packet_delta: respawnDelta,
      switch_observed: switchObserved,
      returned_world_matches_server_dimension: returnedWorldMatches,
      before,
      away,
      returned,
      stale_carried: staleCarried,
      root_if_fail: h3FailureReason(switchObserved, staleCarried, returnedWorldMatches),
    },
  };
}

function runH2(target: ProbePoint): HypothesisResult {
  const summary = summarizePackets(target);
  const standardChangeSeen =
    Number(summary.target_block_change_packets) > 0 ||
    Number(summary.target_multi_block_change_packets) > 0;
  return {
    hypothesis: "H2",
    verdict: standardChangeSeen ? "PASS" : "FAIL",
    evidence: {
      pass_means: "server emits standard block_change or multi_block_change for target mutation",
      packet_summary: summary,
      root_if_fail:
        "server mutation did not appear as standard block change packet; H2 requires JAR push contract, not per-operation /execute",
    },
  };
}

async function sampleCommandControl(
  target: ProbePoint,
): Promise<Readonly<Record<string, unknown>>> {
  const marker = `TNET003_CONTROL_${Date.now()}`;
  const messages = await collectCommandFeedback({
    bot,
    command: `/tellraw @s {"text":"${marker}"}`,
  });
  const dimensionMarker = `TNET003_DIMENSION_${Date.now()}`;
  const dimension = readDimension(bot);
  const dimensionMessages = await collectCommandFeedback({
    bot,
    command: `/execute in ${dimension} run tellraw @s {"text":"${dimensionMarker}"}`,
  });
  const loadedMarker = `TNET003_LOADED_${Date.now()}`;
  const loadedMessages = await collectCommandFeedback({
    bot,
    command: `/execute in ${dimension} if loaded ${target.x} ${target.y} ${target.z} run tellraw @s {"text":"${loadedMarker}"}`,
  });
  return {
    command_available: messages.some((message) => message.includes(marker)),
    dimension_available: dimensionMessages.some((message) => message.includes(dimensionMarker)),
    target_loaded: loadedMessages.some((message) => message.includes(loadedMarker)),
    server_dimension: dimension,
    messages,
    dimension_messages: dimensionMessages,
    loaded_messages: loadedMessages,
  };
}

function attachPacketProbes(targetBot: Bot): void {
  const client = getPacketSource(targetBot);
  if (client === undefined) {
    throw new Error("bot._client unavailable; cannot observe raw packet（原始数据包）");
  }
  const names = [
    "login",
    "respawn",
    "map_chunk",
    "unload_chunk",
    "block_change",
    "multi_block_change",
  ] as const;
  for (const name of names) {
    client.on(name, (packet) => recordPacket(name, packet));
  }
}

function attachBlockUpdateProbe(targetBot: Bot): void {
  getEventSource(targetBot).on("blockUpdate", (oldBlock: unknown, newBlock: unknown) => {
    const oldRecord = asRecord(oldBlock);
    const newRecord = asRecord(newBlock);
    const position = readPoint(newRecord.position) ?? readPoint(oldRecord.position);
    blockUpdates.push({
      timestamp_ms: Date.now(),
      old_block: readBlockKey(oldBlock),
      new_block: readBlockKey(newBlock),
      position: position ?? "unknown",
      target_related: position === undefined ? false : sameBlock(position, readTargetPoint()),
    });
  });
}

function recordPacket(name: string, packet: unknown): void {
  const target = readTargetPoint();
  const packetPoints = packetBlockPoints(name, packet);
  const targetRelated =
    packetPoints.some((point) => sameBlock(point, target)) ||
    (name === "map_chunk" && packetChunkMatches(packet, target));
  packetLog.push({
    name,
    timestamp_ms: Date.now(),
    dimension: readDimension(bot),
    mineflayer_world_name: readMineflayerWorldName(bot),
    target_related: targetRelated,
    summary: packetSummary(name, packet, packetPoints),
  });
  if (targetRelated) {
    console.log(
      `[probe] target packet（目标数据包） ${name} world=${readMineflayerWorldName(bot)}`,
    );
  }
}

function sampleLocalBlock(target: ProbePoint): Readonly<Record<string, unknown>> {
  const block = bot.blockAt(toVec3(target) as Parameters<typeof bot.blockAt>[0]);
  return {
    block_position: target,
    block_key: readBlockKey(block),
    state_id: asRecord(block).stateId ?? "unknown",
    bot_dimension: readDimension(bot),
    mineflayer_world_name: readMineflayerWorldName(bot),
  };
}

function summarizePackets(target: ProbePoint): Readonly<Record<string, number>> {
  return {
    login_packets: countPackets("login"),
    respawn_packets: countPackets("respawn"),
    target_map_chunk_packets: packetLog.filter(
      (entry) => entry.name === "map_chunk" && entry.target_related,
    ).length,
    target_block_change_packets: packetLog.filter(
      (entry) => entry.name === "block_change" && entry.target_related,
    ).length,
    target_multi_block_change_packets: packetLog.filter(
      (entry) => entry.name === "multi_block_change" && entry.target_related,
    ).length,
    target_block_update_events: blockUpdates.filter((entry) =>
      entry.position === "unknown" ? false : sameBlock(entry.position, target),
    ).length,
  };
}

function countTargetBlockPackets(target: ProbePoint): number {
  return packetLog.filter(
    (entry) =>
      (entry.name === "block_change" || entry.name === "multi_block_change") &&
      entry.target_related &&
      sameChunkFromSummary(entry.summary, target),
  ).length;
}

function packetBlockPoints(name: string, packet: unknown): ProbePoint[] {
  if (name === "block_change") {
    const location = readPoint(asRecord(packet).location);
    return location === undefined ? [] : [location];
  }
  if (name !== "multi_block_change") {
    return [];
  }
  const record = asRecord(packet);
  const records = Array.isArray(record.records) ? record.records : [];
  const base = readMultiBlockBase(record);
  if (base === undefined) {
    return [];
  }
  return records.flatMap((entry) => readMultiBlockPoint(entry, base));
}

function readMultiBlockBase(packet: Readonly<Record<string, unknown>>): ProbePoint | undefined {
  const chunkCoordinates = readPoint(packet.chunkCoordinates);
  if (chunkCoordinates !== undefined) {
    return {
      x: chunkCoordinates.x * 16,
      y: chunkCoordinates.y * 16,
      z: chunkCoordinates.z * 16,
    };
  }
  const chunkX = readNumber(packet.chunkX);
  const chunkZ = readNumber(packet.chunkZ);
  if (chunkX === undefined || chunkZ === undefined) {
    return undefined;
  }
  return { x: chunkX * 16, y: 0, z: chunkZ * 16 };
}

function readMultiBlockPoint(entry: unknown, base: ProbePoint): ProbePoint[] {
  if (typeof entry === "number") {
    return [
      {
        x: base.x + ((entry >> 8) & 0x0f),
        y: base.y + (entry & 0x0f),
        z: base.z + ((entry >> 4) & 0x0f),
      },
    ];
  }
  const record = asRecord(entry);
  const horizontalPos = readNumber(record.horizontalPos);
  const y = readNumber(record.y);
  if (horizontalPos === undefined || y === undefined) {
    return [];
  }
  return [
    {
      x: base.x + ((horizontalPos >> 4) & 0x0f),
      y: base.y + y,
      z: base.z + (horizontalPos & 0x0f),
    },
  ];
}

function packetSummary(
  name: string,
  packet: unknown,
  packetPoints: readonly ProbePoint[],
): Readonly<Record<string, unknown>> {
  const record = asRecord(packet);
  return {
    name,
    dimension: record.dimension ?? asRecord(record.worldState).dimension ?? "none",
    world_name: record.worldName ?? asRecord(record.worldState).name ?? "none",
    x: record.x ?? "none",
    z: record.z ?? "none",
    location: readPoint(record.location) ?? "none",
    points: packetPoints.slice(0, 8),
  };
}

function packetChunkMatches(packet: unknown, target: ProbePoint): boolean {
  const record = asRecord(packet);
  const packetX = readNumber(record.x);
  const packetZ = readNumber(record.z);
  return packetX === Math.floor(target.x / 16) && packetZ === Math.floor(target.z / 16);
}

function sameChunkFromSummary(
  summary: Readonly<Record<string, unknown>>,
  target: ProbePoint,
): boolean {
  const points = Array.isArray(summary.points) ? summary.points : [];
  return points.some((point) => {
    const typedPoint = readPoint(point);
    return typedPoint === undefined ? false : sameBlock(typedPoint, target);
  });
}

function isDimensionAligned(control: Readonly<Record<string, unknown>>): boolean {
  const botDimension = readDimension(bot);
  const worldName = readMineflayerWorldName(bot);
  const serverDimension = String(control.server_dimension ?? "");
  return (
    Boolean(control.command_available) &&
    Boolean(control.dimension_available) &&
    Boolean(control.target_loaded) &&
    (serverDimension === botDimension || serverDimension === worldName)
  );
}

function readMineflayerWorldName(targetBot: Bot): string {
  const withGetter = targetBot as unknown as { readonly _getDimensionName?: () => string };
  return withGetter._getDimensionName?.() ?? readDimension(targetBot);
}

function worldMatchesServerDimension(worldName: string, serverDimension: string): boolean {
  if (serverDimension.length === 0) {
    return false;
  }
  return worldName === serverDimension || worldName === `minecraft:${serverDimension}`;
}

function h3FailureReason(
  switchObserved: boolean,
  staleCarried: boolean,
  returnedWorldMatches: boolean,
): string {
  if (!switchObserved) {
    return "probe control failed: no cross-world switch was observed";
  }
  if (staleCarried) {
    return "dimension switch kept the same Mineflayer world cache across worlds";
  }
  if (!returnedWorldMatches) {
    return "dimension switch returned bot.game.dimension but Mineflayer block worldName stayed on another world";
  }
  return "none";
}

function countPackets(name: string): number {
  return packetLog.filter((entry) => entry.name === name).length;
}

function readWaitMs(flagName: string, envName: string, fallback: number): number {
  const raw = readOptionalStringFlag(flags, process.env, flagName, envName);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid wait ms（等待毫秒） ${flagName}: ${raw}`);
  }
  return value;
}

function readBlockKey(block: unknown): string {
  const record = asRecord(block);
  const name = typeof record.name === "string" ? record.name : undefined;
  return name === undefined ? "unknown" : `minecraft:${name}`;
}

function readPoint(value: unknown): ProbePoint | undefined {
  const record = asRecord(value);
  const x = readNumber(record.x);
  const y = readNumber(record.y);
  const z = readNumber(record.z);
  if (x === undefined || y === undefined || z === undefined) {
    return undefined;
  }
  return { x, y, z };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sameBlock(left: ProbePoint, right: ProbePoint): boolean {
  return (
    Math.floor(left.x) === Math.floor(right.x) &&
    Math.floor(left.y) === Math.floor(right.y) &&
    Math.floor(left.z) === Math.floor(right.z)
  );
}

function formatPoint(point: ProbePoint): string {
  return `${point.x},${point.y},${point.z}`;
}

function toVec3(point: ProbePoint): InstanceType<typeof Vec3> {
  return new Vec3(point.x, point.y, point.z);
}

function createEvidencePath(name: string): string {
  mkdirSync(evidenceDir, { recursive: true });
  return join(evidenceDir, `${name}-${Date.now()}.jsonl`);
}

function appendJsonl(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
