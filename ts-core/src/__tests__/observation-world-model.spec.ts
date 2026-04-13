import { describe, expect, it } from "vitest";

import {
  type ThreatAssessment,
  ThreatLevel,
  ThreatRuleId,
  assessThreat,
  createEnvironmentSnapshot,
  createObservationReadBoundary,
  createReflexInterruptSource,
  createThreatDetectorInput,
  createWorldModelQueryBoundary,
  createWorldModelRefreshBoundary,
  queryBestResourceCluster,
  selectBestClusterCandidate,
} from "../index.js";
import type { InterruptSignal } from "../runtime/contracts.js";

describe("observation 与 world-model 契约", () => {
  it("应合并 Mineflayer 与 Bridge 的双数据源快照字段", () => {
    const snapshot = createEnvironmentSnapshot({
      mineflayer: {
        timestamp: 1_712_000_000,
        snapshot_version: "snapshot-v1",
        bot: {
          position: { x: 1, y: 64, z: 2 },
          health: 20,
          food: 18,
          experience: 7,
          is_on_fire: false,
          is_in_water: false,
          y_velocity: 0,
        },
        inventory: {
          items: [{ slot: 0, item_name: "oak_log", count: 12 }],
          total_items: 12,
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
        nearby_entities: [
          {
            entity_id: "zombie-1",
            entity_type: "zombie",
            kind: "hostile",
            display_name: "Zombie",
            position: { x: 4, y: 64, z: 2 },
            distance: 3,
          },
        ],
        nearby_blocks: [
          {
            block_name: "oak_log",
            position: { x: 5, y: 64, z: 5 },
            distance: 6,
          },
        ],
        owner: {
          position: { x: 2, y: 64, z: 2 },
          name: "hc-owner",
          online: true,
        },
      },
      bridge: {
        nearby_entities: [
          {
            entity_id: "skeleton-1",
            entity_type: "skeleton",
            kind: "hostile",
            display_name: "Skeleton",
            position: { x: 8, y: 64, z: 2 },
            distance: 7,
          },
        ],
        nearby_blocks: [
          {
            block_name: "oak_log",
            position: { x: 5, y: 64, z: 5 },
            distance: 6,
            cluster_key: "cluster-oak",
          },
        ],
        server_extended: {
          global_entity_count: 48,
          chunk_loaded_count: 96,
          tps: 19.8,
        },
      },
    });

    expect(snapshot.snapshot_version).toBe("snapshot-v1");
    expect(snapshot.owner?.name).toBe("hc-owner");
    expect(snapshot.server_extended?.tps).toBeCloseTo(19.8);
    expect(snapshot.nearby_entities.map((entity) => entity.entity_id)).toEqual([
      "zombie-1",
      "skeleton-1",
    ]);
    expect(snapshot.nearby_blocks[0]?.cluster_key).toBe("cluster-oak");
  });

  it("应让威胁评估结果与 runtime 的 reflex 中断来源直接对齐", () => {
    const snapshot = createEnvironmentSnapshot({
      mineflayer: {
        timestamp: 1_712_000_100,
        snapshot_version: "snapshot-threat",
        bot: {
          position: { x: 1, y: 64, z: 1 },
          health: 20,
          food: 18,
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
        nearby_entities: [
          {
            entity_id: "zombie-1",
            entity_type: "zombie",
            kind: "hostile",
            display_name: "Zombie",
            position: { x: 3, y: 64, z: 1 },
            distance: 2,
          },
        ],
        nearby_blocks: [],
      },
    });
    const threatInput = createThreatDetectorInput(snapshot);
    const threat = assessThreat(threatInput);

    expect(threat).not.toBeNull();
    expect(threat?.rule_id).toBe(ThreatRuleId.HostileCloseArmed);
    expect(threat?.level).toBe(ThreatLevel.Fight);

    if (!threat) {
      throw new Error("Expected a threat assessment");
    }

    const signal: InterruptSignal = {
      source: createReflexInterruptSource(threat),
      reason: "reflex:fight",
    };

    expect(signal.source.type).toBe("reflex");
    if (signal.source.type !== "reflex") {
      throw new Error("Expected reflex interrupt source");
    }
    expect(signal.source.threat).toBe(threat);
  });

  it("应返回不会污染 observation 内部状态的快照副本，并按读取时返回最新 owner", async () => {
    let currentSnapshot = createEnvironmentSnapshot({
      mineflayer: {
        timestamp: 1_712_000_200,
        snapshot_version: "snapshot-query",
        bot: {
          position: { x: 0, y: 64, z: 0 },
          health: 20,
          food: 20,
          experience: 1,
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
          main_hand: null,
          off_hand: null,
          has_weapon_equipped: false,
        },
        nearby_entities: [],
        nearby_blocks: [
          {
            block_name: "oak_log",
            position: { x: 2, y: 64, z: 2 },
            distance: 3,
            cluster_key: "oak-a",
          },
        ],
      },
    });
    const observation = createObservationReadBoundary({
      getCurrentSnapshot() {
        return currentSnapshot;
      },
    });
    const firstSnapshot = observation.getSnapshot();
    const firstInventoryItem = firstSnapshot.inventory.items[0];

    if (!firstInventoryItem) {
      throw new Error("Expected an inventory item in the first snapshot");
    }

    expect(Object.isFrozen(firstSnapshot.bot)).toBe(true);
    expect(Object.isFrozen(firstSnapshot.bot.position)).toBe(true);
    expect(Object.isFrozen(firstInventoryItem)).toBe(true);
    expect(Reflect.set(firstSnapshot.bot.position as object, "x", 999)).toBe(false);
    expect(Reflect.set(firstInventoryItem as object, "count", 999)).toBe(false);

    const secondSnapshot = observation.getSnapshot();

    expect(secondSnapshot).not.toBe(firstSnapshot);
    expect(secondSnapshot.bot).not.toBe(firstSnapshot.bot);
    expect(secondSnapshot.bot.position.x).toBe(0);
    expect(secondSnapshot.inventory.items[0]?.count).toBe(1);

    currentSnapshot = createEnvironmentSnapshot({
      mineflayer: {
        timestamp: 1_712_000_201,
        snapshot_version: "snapshot-query-2",
        bot: {
          position: { x: 9, y: 65, z: 9 },
          health: 19,
          food: 18,
          experience: 2,
          is_on_fire: false,
          is_in_water: false,
          y_velocity: 0,
        },
        inventory: {
          items: [{ slot: 0, item_name: "oak_log", count: 2 }],
          total_items: 2,
          occupied_slots: 1,
          free_slots: 35,
        },
        equipment: {
          head: null,
          chest: null,
          legs: null,
          feet: null,
          main_hand: null,
          off_hand: null,
          has_weapon_equipped: false,
        },
        nearby_entities: [],
        nearby_blocks: [
          {
            block_name: "oak_log",
            position: { x: 10, y: 65, z: 10 },
            distance: 2,
            cluster_key: "oak-b",
          },
        ],
        owner: {
          position: { x: 12, y: 65, z: 12 },
          name: "hc-owner",
          online: true,
        },
      },
    });

    expect(observation.getOwnerSnapshot()?.position.x).toBe(12);
    expect(observation.getWorldView().nearestBlocks("oak_log", 8, 2)[0]?.cluster_key).toBe("oak-b");
  });

  it("应拒绝旧的弱类型 threat 入口，并暴露只读 world-model 查询边界", async () => {
    const strictThreat: ThreatAssessment = {
      rule_id: ThreatRuleId.HostileCloseArmed,
      level: ThreatLevel.Fight,
      reason: "hostile_close_armed",
      interrupt_required: true,
      detected_at: 1_712_000_300,
      hostile_entities: [],
      bot_state: {
        health: 20,
        is_on_fire: false,
        y_velocity: 0,
        has_weapon_equipped: true,
      },
    };
    void strictThreat;

    const invalidThreatLevel: ThreatAssessment = {
      rule_id: ThreatRuleId.HostileCloseArmed,
      // @ts-expect-error "high" 不再是合法威胁等级。
      level: "high",
      reason: "legacy",
      interrupt_required: true,
      detected_at: 1,
      hostile_entities: [],
      bot_state: {
        health: 20,
        is_on_fire: false,
        y_velocity: 0,
        has_weapon_equipped: true,
      },
    };
    void invalidThreatLevel;

    // @ts-expect-error 最小载荷不再允许进入 reflex 中断来源。
    const invalidLegacyThreat: ThreatAssessment = {
      level: ThreatLevel.Fight,
    };
    void invalidLegacyThreat;

    const profile = {
      resource_key: "oak_log",
      block_names: ["oak_log"],
      search_radius: 32,
      cluster_radius: 4,
      max_candidates: 5,
    } as const;

    const queryBoundary = createWorldModelQueryBoundary({
      anchor: { x: 0, y: 64, z: 0 },
      snapshot_version: "snapshot-query",
      clusters: [
        {
          resource_key: "oak_log",
          cluster_id: "oak-a",
          snapshot_version: "snapshot-query",
          centroid: { x: 3, y: 64, z: 3 },
          block_count: 4,
          nearest_distance: 3,
          average_distance: 4,
          candidates: [
            {
              block_name: "oak_log",
              position: { x: 2, y: 64, z: 2 },
              distance: 3,
              score: 10,
              is_exposed: true,
            },
            {
              block_name: "oak_log",
              position: { x: 3, y: 64, z: 3 },
              distance: 4,
              score: 12,
              is_exposed: false,
            },
          ],
        },
        {
          resource_key: "coal_ore",
          cluster_id: "coal-a",
          snapshot_version: "snapshot-query",
          centroid: { x: 12, y: 20, z: 12 },
          block_count: 8,
          nearest_distance: 18,
          average_distance: 20,
          candidates: [],
        },
      ],
    });
    const queriedClusters = queryBoundary.queryClusters("oak_log");
    const firstCluster = queriedClusters[0];

    if (!firstCluster) {
      throw new Error("Expected a queried cluster");
    }

    const bestCluster = queryBestResourceCluster({
      context: {
        anchor: { x: 0, y: 64, z: 0 },
        snapshot_version: "snapshot-query",
        clusters: queriedClusters,
      },
      profile,
    });

    if (!bestCluster) {
      throw new Error("Expected a best cluster result");
    }

    const bestCandidate = selectBestClusterCandidate({
      cluster: bestCluster.cluster,
    });
    const refreshBoundary = createWorldModelRefreshBoundary();

    expect(Object.isFrozen(queriedClusters)).toBe(true);
    expect(Object.isFrozen(firstCluster)).toBe(true);
    expect(Object.isFrozen(firstCluster.centroid)).toBe(true);
    expect(Object.isFrozen(firstCluster.candidates)).toBe(true);
    expect(Object.isFrozen(firstCluster.candidates[0])).toBe(true);
    expect(Object.isFrozen(firstCluster.candidates[0]?.position)).toBe(true);
    expect(Reflect.set(firstCluster.centroid as object, "x", 999)).toBe(false);
    expect(Reflect.set(firstCluster.candidates[0]?.position as object, "x", 999)).toBe(false);

    expect(Object.isFrozen(bestCluster)).toBe(true);
    expect(Object.isFrozen(bestCluster.profile)).toBe(true);
    expect(Object.isFrozen(bestCluster.profile.block_names)).toBe(true);
    expect(Object.isFrozen(bestCluster.cluster)).toBe(true);
    expect(Object.isFrozen(bestCluster.cluster.centroid)).toBe(true);
    expect(Reflect.set(bestCluster.cluster.centroid as object, "x", 888)).toBe(false);

    expect(Object.isFrozen(bestCandidate)).toBe(true);
    expect(Object.isFrozen(bestCandidate?.candidate)).toBe(true);
    expect(Object.isFrozen(bestCandidate?.candidate.position)).toBe(true);
    expect(Reflect.set(bestCandidate?.candidate.position as object, "x", 777)).toBe(false);

    const queriedClustersAfterMutation = queryBoundary.queryClusters("oak_log");
    const bestClusterAfterMutation = queryBoundary.queryBestCluster(profile);
    const bestCandidateAfterMutation = queryBoundary.selectBestBlock(firstCluster);

    expect(bestCluster.cluster.cluster_id).toBe("oak-a");
    expect(bestCandidate?.candidate.position).toEqual({ x: 2, y: 64, z: 2 });
    expect(queriedClustersAfterMutation[0]?.centroid.x).toBe(3);
    expect(queriedClustersAfterMutation[0]?.candidates[0]?.position.x).toBe(2);
    expect(bestClusterAfterMutation?.cluster.centroid.x).toBe(3);
    expect(bestCandidateAfterMutation?.candidate.position.x).toBe(2);
    expect("refresh" in queryBoundary).toBe(false);
    await expect(
      refreshBoundary.refresh({
        snapshot_version: "snapshot-query",
        resource_key: "oak_log",
        reason: "manual",
      }),
    ).rejects.toThrow("World-model refresh is intentionally not implemented in Phase 1");
  });
});
