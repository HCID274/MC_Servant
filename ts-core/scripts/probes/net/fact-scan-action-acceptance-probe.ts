import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  appendEvidence,
  createBaseEvidence,
  createEvidencePath,
  findNearestPlayer,
  formatEvidenceSummary,
} from "./fact-scan-common.js";
import {
  createProbeBot,
  fail,
  getPosition,
  prepareBot,
  readBaseConfig,
  readFlags,
  readStringFlag,
} from "./knockback-probe-common.js";

const probeId = "P4-1-action-acceptance-audit";
const flags = readFlags(process.argv.slice(2));
const config = readBaseConfig(process.argv.slice(2), process.env);
const action = readStringFlag(flags, process.env, "action", "TNET002_ACTION", "drop");
const bot = createProbeBot(config);
const rawLogPath = createEvidencePath(probeId);

try {
  console.log("[probe] 我在排除哪一环: P4 动作发出后被服务器静默拒绝。");
  await prepareBot(bot, config);
  const before = readInventoryFact();
  const result = await issueAction(action);
  await delay(2500);
  const after = readInventoryFact();
  const droppedNearby = countNearbyDroppedItems();
  const serverEffect =
    action === "drop"
      ? after.total_count < before.total_count || droppedNearby > 0
      : result.client_ack === "issued";
  const verdict = result.client_ack === "issued" && serverEffect ? "PASS" : "FAIL";

  appendEvidence(
    rawLogPath,
    createBaseEvidence({
      axis: "P4",
      probeId,
      config,
      bot,
      rawLogPath,
      verdict,
      playerPosition: findNearestPlayer(bot)?.position ?? "none",
      targetPosition: findNearestPlayer(bot)?.position ?? "none",
      evidence: {
        action_kind: action,
        issued_at_ms: result.issued_at_ms,
        client_ack: result.client_ack,
        client_error: result.client_error,
        before_inventory: before,
        after_inventory: after,
        nearby_dropped_items_after: droppedNearby,
        server_effect: serverEffect,
        final_observation:
          action === "drop" ? "inventory decreased or dropped item visible" : "issued only",
        rejection_hint: result.client_error ?? "none",
      },
    }),
  );

  formatEvidenceSummary({
    axis: "P4",
    verdict,
    worldLabel: config.worldLabel,
    details: `action=${action} client_ack=${result.client_ack} server_effect=${String(serverEffect)} raw=${rawLogPath}`,
  });
  process.exitCode = verdict === "PASS" ? 0 : 2;
} catch (error) {
  fail(error);
} finally {
  bot.quit("T-NET-002 P4 probe finished");
}

interface ActionResult {
  readonly issued_at_ms: number;
  readonly client_ack: "issued" | "not-issued";
  readonly client_error?: string;
}

async function issueAction(actionKind: string): Promise<ActionResult> {
  if (actionKind !== "drop") {
    return {
      issued_at_ms: Date.now(),
      client_ack: "not-issued",
      client_error: `unsupported minimal probe action（动作）: ${actionKind}`,
    };
  }
  const inventory = (
    bot as unknown as {
      readonly inventory?: { items(): readonly unknown[] };
      tossStack?(item: unknown): Promise<void> | void;
    }
  ).inventory;
  const tossStack = (bot as unknown as { tossStack?(item: unknown): Promise<void> | void })
    .tossStack;
  const firstItem = inventory?.items()[0];
  if (firstItem === undefined || tossStack === undefined) {
    return {
      issued_at_ms: Date.now(),
      client_ack: "not-issued",
      client_error: "no inventory item or tossStack（丢弃接口） unavailable",
    };
  }
  const issuedAt = Date.now();
  await tossStack.call(bot, firstItem);
  return { issued_at_ms: issuedAt, client_ack: "issued" };
}

function readInventoryFact(): Readonly<Record<string, unknown>> {
  const items =
    (
      bot as unknown as {
        readonly inventory?: {
          items(): ReadonlyArray<{ readonly count?: number; readonly name?: string }>;
        };
      }
    ).inventory?.items() ?? [];
  return {
    item_count: items.length,
    total_count: items.reduce((total, item) => total + (item.count ?? 0), 0),
    names: items.map((item) => item.name ?? "unknown"),
  };
}

function countNearbyDroppedItems(): number {
  const position = getPosition(bot);
  if (position === undefined) {
    return 0;
  }
  return Object.values(bot.entities).filter((entity) => {
    const entityPosition = entity.position;
    if (entityPosition === undefined) {
      return false;
    }
    const distanceSquared =
      (entityPosition.x - position.x) ** 2 +
      (entityPosition.y - position.y) ** 2 +
      (entityPosition.z - position.z) ** 2;
    return (
      distanceSquared <= 16 &&
      (entity.name === "item" ||
        entity.displayName === "Item" ||
        entity.displayName === "Item Stack")
    );
  }).length;
}
