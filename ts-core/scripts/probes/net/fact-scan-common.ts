import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Bot } from "mineflayer";
import {
  type ProbeBaseConfig,
  type ProbeEventSource,
  type ProbePoint,
  formatPoint,
  formatWorld,
  getEventSource,
  getPosition,
} from "./knockback-probe-common.js";

export const TNET002_EVIDENCE_DIR = "/tmp/tnet002";

export interface FactScanEvidence {
  readonly task_id: "T-NET-002";
  readonly axis: "P1" | "P2" | "P3" | "P4";
  readonly probe_id: string;
  readonly world_label: string;
  readonly bot_world_name: string;
  readonly bot_dimension: string;
  readonly server_world_name: string;
  readonly server_dimension: string;
  readonly bot_position: ProbePoint | "unknown";
  readonly player_position: ProbePoint | "unknown" | "none";
  readonly target_position: ProbePoint | "unknown" | "none";
  readonly timestamp_ms: number;
  readonly verdict: "PASS" | "FAIL";
  readonly raw_log_path: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface NearbyPlayerFact {
  readonly name: string;
  readonly position?: ProbePoint;
  readonly entityId?: number | string;
}

export function createEvidencePath(probeId: string): string {
  mkdirSync(TNET002_EVIDENCE_DIR, { recursive: true });
  return join(TNET002_EVIDENCE_DIR, `${probeId}-${Date.now()}.jsonl`);
}

export function appendEvidence(path: string, evidence: FactScanEvidence): void {
  appendFileSync(path, `${JSON.stringify(evidence)}\n`, "utf8");
  console.log(
    `[probe] evidence（证据） path=${path} axis=${evidence.axis} verdict=${evidence.verdict}`,
  );
}

export function createBaseEvidence(input: {
  readonly axis: FactScanEvidence["axis"];
  readonly probeId: string;
  readonly config: ProbeBaseConfig;
  readonly bot: Bot;
  readonly rawLogPath: string;
  readonly verdict: FactScanEvidence["verdict"];
  readonly playerPosition?: ProbePoint | "unknown" | "none";
  readonly targetPosition?: ProbePoint | "unknown" | "none";
  readonly serverWorldName?: string;
  readonly serverDimension?: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}): FactScanEvidence {
  return {
    task_id: "T-NET-002",
    axis: input.axis,
    probe_id: input.probeId,
    world_label: input.config.worldLabel,
    bot_world_name: readWorldName(input.bot),
    bot_dimension: readDimension(input.bot),
    server_world_name: input.serverWorldName ?? "unavailable",
    server_dimension: input.serverDimension ?? "unavailable",
    bot_position: getPosition(input.bot) ?? "unknown",
    player_position: input.playerPosition ?? "none",
    target_position: input.targetPosition ?? "none",
    timestamp_ms: Date.now(),
    verdict: input.verdict,
    raw_log_path: input.rawLogPath,
    evidence: input.evidence,
  };
}

export async function collectCommandFeedback(input: {
  readonly bot: Bot;
  readonly command: string;
  readonly waitMs?: number;
}): Promise<readonly string[]> {
  const messages: string[] = [];
  const eventSource = getEventSource(input.bot);
  const listener = (...args: readonly unknown[]): void => {
    const text = args.find((arg): arg is string => typeof arg === "string");
    if (text !== undefined) {
      messages.push(text);
    }
  };
  eventSource.on("messagestr", listener);
  eventSource.on("message", listener);
  input.bot.chat(input.command);
  await delay(input.waitMs ?? 1500);
  removeListener(eventSource, "messagestr", listener);
  removeListener(eventSource, "message", listener);
  return messages;
}

export function findNearestPlayer(bot: Bot): NearbyPlayerFact | undefined {
  const botPosition = getPosition(bot);
  if (botPosition === undefined) {
    return undefined;
  }
  const players = Object.values(bot.players)
    .filter((player) => player.username !== bot.username && player.entity?.position !== undefined)
    .map((player) => ({
      name: player.username,
      position: clonePoint(player.entity?.position),
      entityId: player.entity?.id,
    }))
    .sort((left, right) => {
      return (
        distanceSquared(botPosition, left.position) - distanceSquared(botPosition, right.position)
      );
    });
  return players[0];
}

export function readDimension(bot: Bot): string {
  const game = bot.game as { readonly dimension?: string } | undefined;
  return game?.dimension ?? "unknown";
}

export function readWorldName(bot: Bot): string {
  const game = bot.game as { readonly worldName?: string; readonly dimension?: string } | undefined;
  return game?.worldName ?? game?.dimension ?? "unknown";
}

export function clonePoint(point: ProbePoint | undefined): ProbePoint | undefined {
  if (point === undefined) {
    return undefined;
  }
  return { x: point.x, y: point.y, z: point.z };
}

export function floorPoint(point: ProbePoint): ProbePoint {
  return {
    x: Math.floor(point.x),
    y: Math.floor(point.y),
    z: Math.floor(point.z),
  };
}

export function parsePointText(value: string | undefined): ProbePoint | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`invalid point（坐标） value: ${value}`);
  }
  return { x: parts[0] as number, y: parts[1] as number, z: parts[2] as number };
}

export function hasInvalidNumber(value: unknown): boolean {
  if (typeof value === "number") {
    return !Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasInvalidNumber(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => hasInvalidNumber(item));
  }
  return false;
}

export function shapeDigest(value: unknown, depth = 0): unknown {
  if (depth > 2) {
    return typeof value;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [shapeDigest(value[0], depth + 1)];
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 16)
        .map(([key, entry]) => [key, shapeDigest(entry, depth + 1)]),
    );
  }
  return typeof value;
}

export function formatEvidenceSummary(input: {
  readonly axis: string;
  readonly verdict: "PASS" | "FAIL";
  readonly worldLabel: string;
  readonly details: string;
}): void {
  console.log(
    `[probe] RESULT（结果） ${input.axis} ${input.verdict} world_label=${input.worldLabel} evidence=${input.details}`,
  );
}

export function formatPositionForLog(point: ProbePoint | undefined): string {
  return formatPoint(point);
}

function removeListener(
  eventSource: ProbeEventSource,
  eventName: string,
  listener: (...args: readonly unknown[]) => void,
): void {
  eventSource.off?.(eventName, listener);
  eventSource.removeListener?.(eventName, listener);
}

function distanceSquared(left: ProbePoint | undefined, right: ProbePoint | undefined): number {
  if (left === undefined || right === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
}
