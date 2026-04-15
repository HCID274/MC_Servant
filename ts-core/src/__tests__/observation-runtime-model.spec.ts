import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  type MineflayerObservationInput,
  ThreatRuleId,
  createObservationRuntimeCache,
} from "../index.js";

function createMineflayerInput(input: {
  timestamp: number;
  version: string;
  health?: number;
  hostileDistance?: number;
}): MineflayerObservationInput {
  return {
    timestamp: input.timestamp,
    snapshot_version: input.version,
    bot: {
      position: { x: 0, y: 64, z: 0 },
      health: input.health ?? 20,
      food: 20,
      experience: 0,
      is_on_fire: false,
      is_in_water: false,
      y_velocity: 0,
    },
    inventory: {
      items: [{ slot: 0, item_name: "oak_log", count: 1 }],
      total_items: 1,
      occupied_slots: 1,
      free_slots: 35,
    },
    equipment: {
      head: null,
      chest: null,
      legs: null,
      feet: null,
      main_hand: { slot: "main_hand", item_name: "stone_sword", count: 1 },
      off_hand: null,
      has_weapon_equipped: true,
    },
    nearby_entities:
      input.hostileDistance === undefined
        ? []
        : [
            {
              entity_id: "zombie-runtime",
              entity_type: "zombie",
              kind: "hostile",
              display_name: "Zombie",
              position: { x: input.hostileDistance, y: 64, z: 0 },
              distance: input.hostileDistance,
            },
          ],
    nearby_blocks: [
      {
        block_name: "oak_log",
        position: { x: 2, y: 64, z: 2 },
        distance: 3,
        cluster_key: "oak-runtime",
      },
    ],
    owner: {
      position: { x: 1, y: 64, z: 1 },
      name: "hc-owner",
      online: true,
    },
  };
}

describe("observation（观测） 运行时缓存", () => {
  it("应基于 Mineflayer（Minecraft 协议客户端） 输入刷新只读快照并保持副本隔离", () => {
    const cache = createObservationRuntimeCache();
    const firstSnapshot = cache.refreshFromMineflayer(
      createMineflayerInput({
        timestamp: 1_712_100_000,
        version: "obs-runtime-1",
      }),
    );
    const firstInventoryItem = firstSnapshot.inventory.items[0];

    if (!firstInventoryItem) {
      throw new Error("expected inventory item");
    }

    expect(firstSnapshot.snapshot_version).toBe("obs-runtime-1");
    expect(Object.isFrozen(firstSnapshot.bot.position)).toBe(true);
    expect(Object.isFrozen(firstInventoryItem)).toBe(true);
    expect(Reflect.set(firstSnapshot.bot.position as object, "x", 999)).toBe(false);
    expect(Reflect.set(firstInventoryItem as object, "count", 999)).toBe(false);
    expect(cache.getSnapshot().bot.position.x).toBe(0);
    expect(cache.readBoundary.getOwnerSnapshot()?.name).toBe("hc-owner");
    expect(cache.readBoundary.getWorldView().nearestBlocks("oak_log")[0]?.cluster_key).toBe(
      "oak-runtime",
    );
  });

  it("应通过事件绑定刷新当前快照并复用威胁评估纯函数", () => {
    const eventSource = new EventEmitter();
    const cache = createObservationRuntimeCache();
    let nextInput = createMineflayerInput({
      timestamp: 1_712_100_100,
      version: "obs-runtime-event-1",
    });
    const subscription = cache.bindMineflayerEvents({
      eventSource,
      events: ["physicsTick"],
      readObservationInput: () => nextInput,
    });

    eventSource.emit("physicsTick");

    expect(cache.getSnapshot().snapshot_version).toBe("obs-runtime-event-1");

    nextInput = createMineflayerInput({
      timestamp: 1_712_100_101,
      version: "obs-runtime-threat",
      hostileDistance: 2,
    });

    eventSource.emit("physicsTick");

    const threat = cache.assessThreat();

    expect(threat?.rule_id).toBe(ThreatRuleId.HostileCloseArmed);
    expect(threat?.hostile_entities[0]?.entity_id).toBe("zombie-runtime");

    subscription.close();
    nextInput = createMineflayerInput({
      timestamp: 1_712_100_102,
      version: "obs-runtime-after-close",
    });
    eventSource.emit("physicsTick");

    expect(cache.getSnapshot().snapshot_version).toBe("obs-runtime-threat");
  });
});
