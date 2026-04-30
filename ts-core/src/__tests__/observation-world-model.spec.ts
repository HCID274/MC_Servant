import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import {
  type ThreatAssessment,
  ThreatLevel,
  ThreatRuleId,
  assessThreat,
  createEnvironmentSnapshot,
  createMinecraftDataFactsPort,
  createObservationReadBoundary,
  createReflexInterruptSource,
  createResourceIndex,
  createThreatDetectorInput,
  createWorldModelQueryBoundary,
  createWorldModelRefreshBoundary,
  queryBestResourceCluster,
  selectBestClusterCandidate,
} from "../index.js";
import type { InterruptSignal } from "../runtime/contracts.js";

interface MinecraftDataTestRegistry {
  readonly blocks: Readonly<
    Record<
      string,
      | {
          readonly id: number;
          readonly name: string;
          readonly displayName: string;
          readonly drops?: readonly number[];
        }
      | undefined
    >
  >;
  readonly blocksByName: Readonly<
    Record<
      string,
      | {
          readonly id: number;
          readonly name: string;
          readonly displayName: string;
          readonly drops?: readonly number[];
        }
      | undefined
    >
  >;
  readonly items: Readonly<
    Record<
      string,
      | {
          readonly id: number;
          readonly name: string;
          readonly displayName: string;
        }
      | undefined
    >
  >;
  readonly itemsByName: Readonly<
    Record<
      string,
      | {
          readonly id: number;
          readonly name: string;
          readonly displayName: string;
        }
      | undefined
    >
  >;
  readonly recipes: Readonly<
    Record<
      string,
      | readonly {
          readonly result: {
            readonly id: number;
            readonly count?: number;
          };
          readonly ingredients?: readonly number[];
        }[]
      | undefined
    >
  >;
}

const require = createRequire(import.meta.url);
const loadMinecraftData = require("minecraft-data") as (
  version: string,
) => MinecraftDataTestRegistry | null;

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
    const refreshResult = await refreshBoundary.refresh({
      snapshot_version: "snapshot-query",
      resource_key: "oak_log",
      radius: 16,
      reason: "manual",
    });

    expect(refreshResult.status).toBe("runtime_unavailable");
    expect(refreshResult.diagnostics).toEqual(["runtime_unavailable"]);
    await expect(
      refreshBoundary.refresh({
        snapshot_version: "snapshot-query",
        resource_key: "oak_log",
        reason: "manual",
      }),
    ).resolves.toMatchObject({
      status: "runtime_unavailable",
      radius: 16,
    });
  });

  it("应通过 ResourceIndex（资源索引） 按半径阶梯刷新并区分未命中、过期和命中", async () => {
    let now = 1_712_000_000;
    const calls: Array<{ resourceKey: string; radius: number }> = [];
    const resourceIndex = createResourceIndex({
      now: () => now,
      staleAfterMs: 10,
      refreshPort: {
        async refreshAroundBot(resourceKey, radius) {
          calls.push({ resourceKey, radius });

          return {
            resource_key: resourceKey,
            radius,
            status: radius === 16 ? "cache_miss" : "found",
            world_key: "multiworld:resource",
            snapshot_version: `resource-${radius}`,
            scanned_at: now,
            origin: { x: 0, y: 64, z: 0 },
            blocks:
              radius === 16
                ? []
                : [
                    {
                      block_name: "oak_log",
                      position: { x: 4, y: 64, z: 3 },
                      distance: 5,
                      resource_keys: [resourceKey],
                    },
                    {
                      block_name: "oak_log",
                      position: { x: 5, y: 64, z: 3 },
                      distance: 6,
                      resource_keys: [resourceKey],
                    },
                  ],
            diagnostics: radius === 16 ? ["cache_miss"] : [],
          };
        },
      },
    });

    expect(resourceIndex.queryClusters("tree").status).toBe("cache_miss");
    expect((await resourceIndex.refreshAroundBot("tree", 16)).status).toBe("cache_miss");
    const found = await resourceIndex.refreshAroundBot("tree", 32);

    expect(calls).toEqual([
      { resourceKey: "tree", radius: 16 },
      { resourceKey: "tree", radius: 32 },
    ]);
    expect(found.status).toBe("found");
    expect(found.clusters[0]?.block_count).toBe(2);
    expect(resourceIndex.queryClusters("tree").status).toBe("found");
    expect(resourceIndex.createPlannerSummary(["tree"])).toContain("tree: found");

    now += 11;

    expect(resourceIndex.queryClusters("tree").status).toBe("stale_snapshot");
  });

  it("ResourceIndex（资源索引） 应把 refreshPort（刷新端口） 异常转换为 runtime_unavailable（运行时不可用）", async () => {
    const resourceIndex = createResourceIndex({
      refreshPort: {
        async refreshAroundBot() {
          throw new Error("runtime closed");
        },
      },
    });

    await expect(resourceIndex.refreshAroundBot("tree", 16)).resolves.toMatchObject({
      resource_key: "tree",
      radius: 16,
      status: "runtime_unavailable",
      world_key: null,
      clusters: [],
      diagnostics: ["runtime_unavailable", "refresh_port_failed:runtime closed"],
    });
    expect(resourceIndex.queryClusters("tree").status).toBe("cache_miss");
  });

  it("应通过 minecraft-data 提供版本化只读 MC 事实查询", () => {
    const minecraftVersion = "1.20.4";
    const registry = loadMinecraftData(minecraftVersion);

    if (!registry) {
      throw new Error("Expected minecraft-data registry for test version");
    }

    const factsPort = createMinecraftDataFactsPort(minecraftVersion);
    const registryBlock = registry.blocksByName.oak_log;
    const registryItem = registry.itemsByName.oak_planks;

    if (!registryBlock || !registryItem) {
      throw new Error("Expected registry records for world-model fact tests");
    }

    const blockByName = factsPort.getBlockByName(registryBlock.name);
    const blockById = factsPort.getBlockById(registryBlock.id);
    const itemByName = factsPort.getItemByName(registryItem.name);
    const itemById = factsPort.getItemById(registryItem.id);
    const recipes = factsPort.queryRecipesByResultName(registryItem.name);
    const registryRecipes = registry.recipes[String(registryItem.id)] ?? [];

    if (!blockByName || !blockById || !itemByName || !itemById) {
      throw new Error("Expected block and item facts");
    }

    expect(factsPort.version).toBe(minecraftVersion);
    expect(blockByName).toMatchObject({
      id: registryBlock.id,
      name: registryBlock.name,
      display_name: registryBlock.displayName,
    });
    expect(blockById).toEqual(blockByName);
    expect(itemByName).toMatchObject({
      id: registryItem.id,
      name: registryItem.name,
      display_name: registryItem.displayName,
    });
    expect(itemById).toEqual(itemByName);
    expect(recipes.length).toBe(registryRecipes.length);
    expect(recipes[0]?.result).toEqual({
      id: registryItem.id,
      name: registryItem.name,
      count: registryRecipes[0]?.result.count ?? 1,
    });
    expect(recipes[0]?.ingredients).toEqual(registryRecipes[0]?.ingredients ?? []);

    expect(Object.isFrozen(factsPort)).toBe(true);
    expect(Object.isFrozen(blockByName)).toBe(true);
    expect(Object.isFrozen(blockByName.drops)).toBe(true);
    expect(Object.isFrozen(itemByName)).toBe(true);
    expect(Object.isFrozen(recipes)).toBe(true);
    expect(Object.isFrozen(recipes[0])).toBe(true);
    expect(Object.isFrozen(recipes[0]?.result)).toBe(true);
    expect(Object.isFrozen(recipes[0]?.ingredients)).toBe(true);
    expect(Reflect.set(blockByName as object, "name", "polluted")).toBe(false);
    expect(Reflect.set(blockByName.drops as object, "0", 999)).toBe(false);
    expect(Reflect.set(recipes[0]?.result as object, "count", 999)).toBe(false);

    const blockAfterMutationAttempt = factsPort.getBlockByName(registryBlock.name);
    const recipesAfterMutationAttempt = factsPort.queryRecipesByResultName(registryItem.name);

    expect(blockAfterMutationAttempt?.name).toBe(registryBlock.name);
    expect(blockAfterMutationAttempt?.drops).toEqual(registryBlock.drops ?? []);
    expect(recipesAfterMutationAttempt[0]?.result.count).toBe(
      registryRecipes[0]?.result.count ?? 1,
    );
  });

  it("应拒绝无效 minecraft-data 版本与非法输入，并对未命中返回空结果", () => {
    const factsPort = createMinecraftDataFactsPort("1.20.4");

    expect(() => createMinecraftDataFactsPort("not-a-minecraft-version")).toThrow(
      "Unsupported Minecraft data version: not-a-minecraft-version",
    );
    expect(() => createMinecraftDataFactsPort("   ")).toThrow(
      "minecraftVersion must be a non-empty string",
    );
    expect(() => factsPort.getBlockByName("")).toThrow("blockName must be a non-empty string");
    expect(() => factsPort.getItemByName("   ")).toThrow("itemName must be a non-empty string");
    expect(() => factsPort.getBlockById(-1)).toThrow("blockId must be a non-negative integer");
    expect(() => factsPort.getItemById(1.2)).toThrow("itemId must be a non-negative integer");
    expect(factsPort.getBlockByName("ts_core_missing_block")).toBeNull();
    expect(factsPort.getItemByName("ts_core_missing_item")).toBeNull();
    expect(factsPort.queryRecipesByResultName("ts_core_missing_item")).toEqual([]);
  });
});
