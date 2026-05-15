import { describe, expect, it, vi } from "vitest";

import {
  createCollectSkillExecutionResult,
  createCutTreeSkillExecutor,
  createMineSkillExecutionResult,
  createMineSkillExecutor,
} from "../skills/index.js";
import { createResourceService } from "../world-model/index.js";

describe("runtime skill execution（运行时技能执行） 模型", () => {
  it("mine（挖掘） stone（石头） 应把工具准备交给 runtime（运行时） 并以背包增量完成", async () => {
    const inventory = new Map<string, number>();
    const calls: string[] = [];
    const mine = createMineSkillExecutor({
      resourceService: createResourceService({
        worldKeyPort: {
          getCurrentWorldKey: () => "multiworld:resource",
        },
      }),
      miner: {
        async mine(params) {
          calls.push(`mine:${params.blockName}:${params.count}:${params.worldKey}`);
          inventory.set("cobblestone", (inventory.get("cobblestone") ?? 0) + params.count);
          return createMineSkillExecutionResult(params, {
            world_key: "multiworld:resource",
            collected_item_name: "cobblestone",
            collected_count: params.count,
            mined_count: params.count,
            diagnostics: ["stair_bfs_phase:no_fill"],
          });
        },
      },
    });

    await expect(mine({ blockName: "stone", count: 2 })).resolves.toMatchObject({
      skill: "mine",
      block_name: "stone",
      world_key: "multiworld:resource",
      collected_item_name: "cobblestone",
      collected_count: 2,
      mined_count: 2,
      diagnostics: ["stair_bfs_phase:no_fill", "mine_completed_by_inventory_diff"],
    });
    expect(calls).toEqual(["mine:stone:2:multiworld:resource"]);
  });

  it("mine（挖掘） 在掉落物未进背包时应先 collect（捡拾） 再按剩余数量续挖", async () => {
    const inventory = new Map<string, number>([["cobblestone", 56]]);
    const calls: string[] = [];
    const mine = createMineSkillExecutor({
      resourceService: createResourceService({
        worldKeyPort: {
          getCurrentWorldKey: () => "multiworld:resource",
        },
      }),
      miner: {
        async mine(params) {
          calls.push(`mine:${params.blockName}:${params.count}:${params.worldKey}`);
          if (calls.filter((call) => call.startsWith("mine:")).length === 1) {
            throw Object.assign(
              new Error(
                "drop_not_obtained:cobblestone:0/10:planned queue completed without enough inventory diff",
              ),
              {
                details: {
                  expected_drop_name: "cobblestone",
                  collected_count: 0,
                  current_position: { x: -29.3, y: 110, z: -236.58 },
                },
              },
            );
          }

          inventory.set("cobblestone", (inventory.get("cobblestone") ?? 0) + params.count);
          return createMineSkillExecutionResult(params, {
            world_key: "multiworld:resource",
            collected_item_name: "cobblestone",
            collected_count: params.count,
            mined_count: params.count,
            diagnostics: [`mine_retry:${params.count}`],
            total_steps: params.count,
          });
        },
      },
      collector: {
        async collect(params) {
          calls.push(
            `collect:${params.itemName}:${params.radius}:${params.center?.x},${params.center?.y},${params.center?.z}`,
          );
          inventory.set("cobblestone", (inventory.get("cobblestone") ?? 0) + 2);
          return createCollectSkillExecutionResult(params, {
            collected: [{ name: "cobblestone", count: 2 }],
            total_steps: 1,
          });
        },
      },
      inventory: {
        readInventoryItems: () =>
          Array.from(inventory, ([item_name, count]) => ({
            item_name,
            count,
          })),
      },
    });

    await expect(mine({ blockName: "stone", count: 10 })).resolves.toMatchObject({
      skill: "mine",
      block_name: "stone",
      collected_item_name: "cobblestone",
      collected_count: 10,
      mined_count: 8,
      total_steps: 9,
      diagnostics: expect.arrayContaining([
        "mine_drop_collect_recovery_gain:cobblestone:2",
        "mine_completed_by_inventory_diff",
      ]),
    });
    expect(calls).toEqual([
      "mine:stone:10:multiworld:resource",
      "collect:cobblestone:16:-29.3,110,-236.58",
      "mine:stone:8:multiworld:resource",
    ]);
  });

  it("mine（挖掘） 应让 runtime（运行时） 处理工具缺失并保留结构化失败", async () => {
    const createMine = (mode: "not_equipped" | "drop_missing") =>
      createMineSkillExecutor({
        resourceService: createResourceService(),
        miner: {
          async mine(params) {
            if (mode === "not_equipped") {
              throw new Error(`not_equipped:${params.blockName}:requires_harvest_tool`);
            }
            return createMineSkillExecutionResult(params, {
              world_key: "multiworld:resource",
              collected_item_name: "cobblestone",
              collected_count: 0,
              mined_count: params.count,
            });
          },
        },
      });

    await expect(createMine("not_equipped")({ blockName: "stone", count: 1 })).rejects.toThrow(
      "runtime_mine_failed:not_equipped:stone:requires_harvest_tool",
    );
    await expect(createMine("drop_missing")({ blockName: "stone", count: 1 })).rejects.toThrow(
      "drop_not_obtained:cobblestone:0/1",
    );
  });

  it("mine（挖掘） dirt（泥土） 等软方块不应要求主手工具", async () => {
    const mine = createMineSkillExecutor({
      resourceService: createResourceService(),
      miner: {
        async mine(params) {
          return createMineSkillExecutionResult(params, {
            world_key: "multiworld:resource",
            collected_item_name: "dirt",
            collected_count: params.count,
            mined_count: params.count,
          });
        },
      },
    });

    await expect(mine({ blockName: "dirt", count: 2 })).resolves.toMatchObject({
      block_name: "dirt",
      collected_item_name: "dirt",
      collected_count: 2,
    });
  });

  it("mine（挖掘） ore（矿石） 应先走 ResourceService（资源服务） 刷新并按具体方块名处理", async () => {
    const inventory = new Map<string, number>();
    const refreshedKeys: string[] = [];
    const resourceService = createResourceService({
      worldKeyPort: {
        getCurrentWorldKey: () => "multiworld:resource",
      },
      refreshPort: {
        async refreshAroundBot(resourceKey, radius) {
          refreshedKeys.push(`${resourceKey}:${radius}`);
          return {
            resource_key: resourceKey,
            radius,
            status: "found",
            world_key: "multiworld:resource",
            snapshot_version: `ore-${radius}`,
            scanned_at: 1_712_002_000,
            origin: { x: 0, y: 64, z: 0 },
            blocks: [
              {
                block_name: "iron_ore",
                position: { x: 3, y: 63, z: 0 },
                distance: 3,
                resource_keys: [resourceKey],
                semantic_roles: [],
                is_diggable: true,
                is_reachable: true,
              },
            ],
            diagnostics: [],
          };
        },
      },
    });
    const mine = createMineSkillExecutor({
      resourceService,
      miner: {
        async mine(params) {
          expect(params).toMatchObject({
            blockName: "iron_ore",
            count: 1,
            worldKey: "multiworld:resource",
            targets: [
              {
                block_name: "iron_ore",
                position: { x: 3, y: 63, z: 0 },
              },
            ],
          });
          inventory.set("raw_iron", (inventory.get("raw_iron") ?? 0) + params.count);
          return createMineSkillExecutionResult(params, {
            world_key: "multiworld:resource",
            collected_item_name: "raw_iron",
            collected_count: params.count,
            mined_count: params.count,
          });
        },
      },
    });

    await expect(mine({ blockName: "iron_ore", count: 1 })).resolves.toMatchObject({
      block_name: "iron_ore",
      collected_item_name: "raw_iron",
      collected_count: 1,
    });
    expect(refreshedKeys).toEqual(["iron_ore:16"]);
  });

  it("cutTree（砍树） 应按资源簇推荐目标挖掘并用背包增量决定是否继续下一簇", async () => {
    const digs: Array<{ x: number; y: number; z: number }> = [];
    const collects: Array<{
      center: { x: number; y: number; z: number } | undefined;
      radius: number | undefined;
      itemName: string | undefined;
    }> = [];
    const inventory = new Map<string, number>();
    const resourceService = createResourceService({
      worldKeyPort: {
        getCurrentWorldKey: () => "multiworld:resource",
      },
      refreshPort: {
        async refreshAroundBot(resourceKey, radius) {
          return {
            resource_key: resourceKey,
            radius,
            status: "found",
            world_key: "multiworld:resource",
            snapshot_version: `cut-tree-${radius}`,
            scanned_at: 1_712_001_000,
            origin: { x: 0, y: 64, z: 0 },
            blocks: [
              {
                block_name: "oak_log",
                position: { x: 2, y: 64, z: 0 },
                distance: 2,
                resource_keys: [resourceKey],
                semantic_roles: ["cut_tree_log"],
                is_diggable: true,
                is_reachable: true,
              },
              {
                block_name: "oak_log",
                position: { x: 2, y: 65, z: 0 },
                distance: 2.5,
                resource_keys: [resourceKey],
                semantic_roles: ["cut_tree_log"],
                is_diggable: true,
                is_reachable: true,
              },
              {
                block_name: "birch_log",
                position: { x: 5, y: 64, z: 0 },
                distance: 5,
                resource_keys: [resourceKey],
                semantic_roles: ["cut_tree_log"],
                is_diggable: true,
                is_reachable: true,
              },
              {
                block_name: "birch_log",
                position: { x: 5, y: 65, z: 0 },
                distance: 5.5,
                resource_keys: [resourceKey],
                semantic_roles: ["cut_tree_log"],
                is_diggable: true,
                is_reachable: true,
              },
            ],
            diagnostics: [],
          };
        },
      },
    });
    const cutTree = createCutTreeSkillExecutor({
      resourceService,
      settleMs: 0,
      digger: {
        async digBlockAt(position) {
          digs.push({ ...position });
        },
      },
      collector: {
        async collect(params) {
          collects.push({
            center: params.center === undefined ? undefined : { ...params.center },
            radius: params.radius,
            itemName: params.itemName,
          });
          const itemName = collects.length === 1 ? "oak_log" : "birch_log";
          inventory.set(itemName, (inventory.get(itemName) ?? 0) + 2);

          return createCollectSkillExecutionResult(params, {
            world_key: "multiworld:resource",
            collected: [{ name: itemName, count: 2 }],
            total_steps: 1,
          });
        },
      },
      inventory: {
        readInventoryItems: () =>
          [...inventory.entries()].map(([item_name, count]) => ({ item_name, count })),
      },
    });
    const result = await cutTree({ count: 3 });

    expect(result).toMatchObject({
      skill: "cutTree",
      requested_count: 3,
      collected_count: 4,
      completed: true,
      status: "completed",
      world_key: "multiworld:resource",
    });
    expect(digs).toEqual([
      { x: 2, y: 64, z: 0 },
      { x: 5, y: 64, z: 0 },
    ]);
    expect(collects).toEqual([
      {
        center: { x: 2, y: 64, z: 0 },
        radius: 8,
        itemName: undefined,
      },
      {
        center: { x: 5, y: 64, z: 0 },
        radius: 8,
        itemName: undefined,
      },
    ]);
    expect(
      result.skill === "cutTree" ? result.clusters.map((cluster) => cluster.log_block_name) : [],
    ).toEqual(["oak_log", "birch_log"]);
    expect(resourceService.query("tree").clusters).toHaveLength(0);
  });

  it("cutTree（砍树） 附近木头不足时应失败而不是静默完成", async () => {
    const resourceService = createResourceService({
      worldKeyPort: {
        getCurrentWorldKey: () => "multiworld:empty",
      },
      refreshPort: {
        async refreshAroundBot(resourceKey, radius) {
          return {
            resource_key: resourceKey,
            radius,
            status: "not_found",
            world_key: "multiworld:empty",
            snapshot_version: `empty-${radius}`,
            scanned_at: 1_712_001_100,
            origin: { x: 0, y: 64, z: 0 },
            blocks: [],
            diagnostics: [],
          };
        },
      },
    });
    const cutTree = createCutTreeSkillExecutor({
      resourceService,
      settleMs: 0,
      digger: {
        async digBlockAt() {
          throw new Error("dig should not run");
        },
      },
      collector: {
        async collect(params) {
          return createCollectSkillExecutionResult(params, { collected: [] });
        },
      },
      inventory: {
        readInventoryItems: () => [],
      },
    });

    await expect(cutTree({ count: 5 })).rejects.toThrow("附近木头不足：已获得 0/5 个原木");
    await expect(cutTree({ count: 5 })).rejects.toMatchObject({
      error_code: "resource_not_found",
    });
  });

  it("cutTree（砍树） 每轮挖完后必须全量 collect（捡拾） 再按原木背包增量验收", async () => {
    const collectRequests: Array<{
      center?: { x: number; y: number; z: number };
      itemName?: string;
      radius?: number;
    }> = [];
    const inventory = new Map<string, number>();
    const resourceService = createResourceService({
      worldKeyPort: {
        getCurrentWorldKey: () => "multiworld:resource",
      },
      refreshPort: {
        async refreshAroundBot(resourceKey, radius) {
          return {
            resource_key: resourceKey,
            radius,
            status: "found",
            world_key: "multiworld:resource",
            snapshot_version: `cut-tree-collect-all-${radius}`,
            scanned_at: 1_712_001_150,
            origin: { x: 0, y: 64, z: 0 },
            blocks: [
              {
                block_name: "oak_log",
                position: { x: 2, y: 64, z: 0 },
                distance: 2,
                resource_keys: [resourceKey],
                semantic_roles: ["cut_tree_log"],
                is_diggable: true,
                is_reachable: true,
              },
            ],
            diagnostics: [],
          };
        },
      },
    });
    const cutTree = createCutTreeSkillExecutor({
      resourceService,
      settleMs: 0,
      digger: {
        async digBlockAt() {
          return undefined;
        },
      },
      collector: {
        async collect(params) {
          collectRequests.push({ ...params });
          inventory.set("oak_log", 1);
          inventory.set("oak_sapling", 1);
          return createCollectSkillExecutionResult(params, {
            world_key: "multiworld:resource",
            collected: [
              { name: "oak_log", count: 1 },
              { name: "oak_sapling", count: 1 },
            ],
            skipped: [],
            total_steps: 1,
          });
        },
      },
      inventory: {
        readInventoryItems: () =>
          [...inventory.entries()].map(([item_name, count]) => ({ item_name, count })),
      },
    });

    await expect(cutTree({ count: 1 })).resolves.toMatchObject({
      collected_count: 1,
      completed: true,
    });
    expect(collectRequests).toEqual([{ center: { x: 2, y: 64, z: 0 }, radius: 8 }]);
  });

  it("cutTree（砍树） 底层 digBlockAt 失败时应透出结构化失败码", async () => {
    const resourceService = createResourceService({
      worldKeyPort: {
        getCurrentWorldKey: () => "multiworld:resource",
      },
      refreshPort: {
        async refreshAroundBot(resourceKey, radius) {
          return {
            resource_key: resourceKey,
            radius,
            status: "found",
            world_key: "multiworld:resource",
            snapshot_version: `cut-tree-collect-failed-${radius}`,
            scanned_at: 1_712_001_200,
            origin: { x: 0, y: 64, z: 0 },
            blocks: [
              {
                block_name: "oak_log",
                position: { x: 2, y: 64, z: 0 },
                distance: 2,
                resource_keys: [resourceKey],
                semantic_roles: ["cut_tree_log"],
                is_diggable: true,
                is_reachable: true,
              },
            ],
            diagnostics: [],
          };
        },
      },
    });
    const cutTree = createCutTreeSkillExecutor({
      resourceService,
      settleMs: 0,
      digger: {
        async digBlockAt() {
          const error = new Error("forced dig failed") as Error & { error_code?: string };
          error.error_code = "unreachable_target";
          throw error;
        },
      },
      collector: {
        async collect() {
          throw new Error("collect should not run");
        },
      },
      inventory: {
        readInventoryItems: () => [],
      },
    });

    await expect(cutTree({ count: 1 })).rejects.toMatchObject({
      error_code: "unreachable_target",
    });
  });

  it("cutTree（砍树） 默认应等待 1 秒再从最低原木位置 collect（捡拾）", async () => {
    vi.useFakeTimers();
    const inventory = new Map<string, number>();
    const digs: Array<{ x: number; y: number; z: number }> = [];
    const collects: Array<{ center: { x: number; y: number; z: number } | undefined }> = [];
    const resourceService = createResourceService({
      worldKeyPort: {
        getCurrentWorldKey: () => "multiworld:resource",
      },
      refreshPort: {
        async refreshAroundBot(resourceKey, radius) {
          return {
            resource_key: resourceKey,
            radius,
            status: "found",
            world_key: "multiworld:resource",
            snapshot_version: `cut-tree-lowest-collect-${radius}`,
            scanned_at: 1_712_001_300,
            origin: { x: 0, y: 64, z: 0 },
            blocks: [
              {
                block_name: "cherry_log",
                position: { x: 10, y: 104, z: 10 },
                distance: 10,
                resource_keys: [resourceKey],
                semantic_roles: ["cut_tree_log"],
                is_diggable: true,
                is_reachable: true,
              },
              {
                block_name: "cherry_log",
                position: { x: 10, y: 111, z: 10 },
                distance: 11,
                resource_keys: [resourceKey],
                semantic_roles: ["cut_tree_log"],
                is_diggable: true,
                is_reachable: true,
              },
            ],
            diagnostics: [],
          };
        },
      },
    });
    const cutTree = createCutTreeSkillExecutor({
      resourceService,
      digger: {
        async digBlockAt(position) {
          digs.push({ ...position });
        },
      },
      collector: {
        async collect(params) {
          collects.push({
            center: params.center === undefined ? undefined : { ...params.center },
          });
          inventory.set("cherry_log", 2);

          return createCollectSkillExecutionResult(params, {
            world_key: "multiworld:resource",
            collected: [{ name: "cherry_log", count: 2 }],
            total_steps: 1,
          });
        },
      },
      inventory: {
        readInventoryItems: () =>
          [...inventory.entries()].map(([item_name, count]) => ({ item_name, count })),
      },
    });

    try {
      const promise = cutTree({ count: 1 });
      await vi.advanceTimersByTimeAsync(999);
      expect(digs).toEqual([{ x: 10, y: 104, z: 10 }]);
      expect(collects).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toMatchObject({
        collected_count: 2,
        completed: true,
      });
      expect(collects).toEqual([{ center: { x: 10, y: 104, z: 10 } }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
