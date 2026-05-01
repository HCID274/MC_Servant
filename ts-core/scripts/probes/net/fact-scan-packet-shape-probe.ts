import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  appendEvidence,
  createBaseEvidence,
  createEvidencePath,
  findNearestPlayer,
  formatEvidenceSummary,
  hasInvalidNumber,
  shapeDigest,
} from "./fact-scan-common.js";
import {
  createProbeBot,
  fail,
  formatPacketKeys,
  getPacketSource,
  getPosition,
  prepareBot,
  readBaseConfig,
} from "./knockback-probe-common.js";

const probeId = "P2-1-packet-shape-smoke";
const config = readBaseConfig(process.argv.slice(2), process.env);
const bot = createProbeBot(config);
const rawLogPath = createEvidencePath(probeId);
const packets = new Map<string, PacketSample[]>();
const watchedPackets = [
  "rel_entity_move",
  "entity_move_look",
  "entity_look",
  "entity_teleport",
  "entity_metadata",
  "update_health",
  "entity_equipment",
  "window_items",
  "set_slot",
] as const;

try {
  console.log("[probe] 我在排除哪一环: P2 Mineflayer 1.20.4 packet（数据包）字段形状不兼容。");
  await prepareBot(bot, config);
  const client = getPacketSource(bot);
  if (client === undefined) {
    throw new Error("bot._client unavailable; cannot observe raw packet（原始数据包）");
  }

  for (const packetName of watchedPackets) {
    client.on(packetName, (packet) => recordPacket(packetName, packet));
  }

  console.log(
    "[probe] 请靠近 bot（机器人）并切换一次手持/装备；脚本会监听 position/metadata/health/equipment/inventory。",
  );
  await delay(config.durationMs);

  const normalizedFact = readNormalizedFact();
  const invalid = hasInvalidNumber(normalizedFact);
  const categorySummary = summarizeCategories();
  const hasShapeMismatch = [...packets.values()].flat().some((sample) => sample.keys.length === 0);
  const verdict = invalid || hasShapeMismatch ? "FAIL" : "PASS";

  appendEvidence(
    rawLogPath,
    createBaseEvidence({
      axis: "P2",
      probeId,
      config,
      bot,
      rawLogPath,
      verdict,
      playerPosition: findNearestPlayer(bot)?.position ?? "none",
      targetPosition: findNearestPlayer(bot)?.position ?? "none",
      evidence: {
        watched_packets: watchedPackets,
        category_summary: categorySummary,
        packet_samples: Object.fromEntries(packets.entries()),
        normalized_fact: normalizedFact,
        invalid_fact_marker: invalid ? "NaN" : "none",
        shape_mismatch: hasShapeMismatch,
      },
    }),
  );

  formatEvidenceSummary({
    axis: "P2",
    verdict,
    worldLabel: config.worldLabel,
    details: `invalid=${String(invalid)} packets=${JSON.stringify(categorySummary)} raw=${rawLogPath}`,
  });
  process.exitCode = verdict === "PASS" ? 0 : 2;
} catch (error) {
  fail(error);
} finally {
  bot.quit("T-NET-002 P2 probe finished");
}

interface PacketSample {
  readonly packet_name: string;
  readonly keys: string;
  readonly shape: unknown;
}

function recordPacket(packetName: string, packet: unknown): void {
  const current = packets.get(packetName) ?? [];
  if (current.length >= 3) {
    return;
  }
  current.push({
    packet_name: packetName,
    keys: formatPacketKeys(packet),
    shape: shapeDigest(packet),
  });
  packets.set(packetName, current);
  console.log(`[probe] packet（数据包） ${packetName} keys=${formatPacketKeys(packet)}`);
}

function summarizeCategories(): Record<string, number | string> {
  return {
    entity_position:
      (packets.get("rel_entity_move")?.length ?? 0) +
      (packets.get("entity_move_look")?.length ?? 0) +
      (packets.get("entity_look")?.length ?? 0) +
      (packets.get("entity_teleport")?.length ?? 0),
    entity_metadata: packets.get("entity_metadata")?.length ?? "not-triggered",
    health: packets.get("update_health")?.length ?? "not-triggered",
    equipment: packets.get("entity_equipment")?.length ?? "not-triggered",
    window_inventory:
      (packets.get("window_items")?.length ?? 0) + (packets.get("set_slot")?.length ?? 0) ||
      "not-triggered",
  };
}

function readNormalizedFact(): Readonly<Record<string, unknown>> {
  const nearestPlayer = findNearestPlayer(bot);
  return {
    bot_position: getPosition(bot),
    health: (bot as unknown as { readonly health?: number }).health,
    food: (bot as unknown as { readonly food?: number }).food,
    held_item: (bot as unknown as { readonly heldItem?: unknown }).heldItem ?? "none",
    inventory_items:
      (
        bot as unknown as { readonly inventory?: { items(): readonly unknown[] } }
      ).inventory?.items() ?? [],
    nearest_player: nearestPlayer ?? "none",
  };
}
