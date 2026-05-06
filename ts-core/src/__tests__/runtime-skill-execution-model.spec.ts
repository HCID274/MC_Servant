import { describe, expect, it, vi } from "vitest";

import { ExecPriority, createSkillCallJob } from "../runtime/index.js";
import {
  SKILL_DIRECTORY,
  createCollectSkillExecutionResult,
  createCutTreeSkillExecutor,
  createEquipSkillExecutionResult,
  createGoToSkillExecutionResult,
  createMineSkillExecutionResult,
  createMineSkillExecutor,
  executeSkillCallJob,
} from "../skills/index.js";
import { createResourceService } from "../world-model/index.js";

describe("runtime skill execution（运行时技能执行） 模型", () => {
  it("应通过可注入 movement adapter（移动适配器） 执行 goTo（前往坐标）", async () => {
    const targets: Array<{ x: number; y: number; z: number }> = [];
    const job = createSkillCallJob({
      message_id: "msg-skill-goto",
      intent_epoch: 1,
      snapshot_ts: 100,
      priority: ExecPriority.Normal,
      skill: SKILL_DIRECTORY.goTo,
      params: { x: 10, y: 64, z: -5 },
    });

    const result = await executeSkillCallJob({
      job,
      dependencies: {
        goToMovement: {
          async goTo(params) {
            targets.push({ ...params });

            return createGoToSkillExecutionResult(params);
          },
        },
        async mine(params) {
          return createMineSkillExecutionResult(params);
        },
        async collect(params) {
          return createCollectSkillExecutionResult(params);
        },
        async equip(params) {
          return createEquipSkillExecutionResult(params);
        },
      },
    });

    expect(targets).toEqual([{ x: 10, y: 64, z: -5 }]);
    expect(result).toEqual({
      skill: "goTo",
      target: { x: 10, y: 64, z: -5 },
      world_key: null,
      reached: true,
      total_steps: 1,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.target)).toBe(true);
  });

  it("应透出 movement adapter（移动适配器） 的失败，不允许静默成功", async () => {
    const job = createSkillCallJob({
      message_id: "msg-skill-goto-failed",
      intent_epoch: 1,
      snapshot_ts: 100,
      priority: ExecPriority.Normal,
      skill: SKILL_DIRECTORY.goTo,
      params: { x: 10, y: 64, z: -5 },
    });

    await expect(
      executeSkillCallJob({
        job,
        dependencies: {
          goToMovement: {
            async goTo() {
              throw new Error("path not found");
            },
          },
          async mine(params) {
            return createMineSkillExecutionResult(params);
          },
          async collect(params) {
            return createCollectSkillExecutionResult(params);
          },
          async equip(params) {
            return createEquipSkillExecutionResult(params);
          },
        },
      }),
    ).rejects.toThrow("path not found");
  });

  it("应通过可注入 adapter（适配器） 执行 mine（挖掘） / collect（捡拾） / equip（装备）", async () => {
    const calls: string[] = [];

    const mineJob = createSkillCallJob({
      message_id: "msg-skill-mine",
      intent_epoch: 1,
      snapshot_ts: 100,
      priority: ExecPriority.Normal,
      skill: SKILL_DIRECTORY.mine,
      params: { blockName: "stone", count: 2 },
    });
    const collectJob = createSkillCallJob({
      message_id: "msg-skill-collect",
      intent_epoch: 1,
      snapshot_ts: 100,
      priority: ExecPriority.Normal,
      skill: SKILL_DIRECTORY.collect,
      params: { itemName: "cobblestone", radius: 32 },
    });
    const equipJob = createSkillCallJob({
      message_id: "msg-skill-equip",
      intent_epoch: 1,
      snapshot_ts: 100,
      priority: ExecPriority.Normal,
      skill: SKILL_DIRECTORY.equip,
      params: { itemName: "stone_pickaxe", destination: "hand" },
    });

    const dependencies = {
      goToMovement: {
        async goTo(params: { readonly x: number; readonly y: number; readonly z: number }) {
          return createGoToSkillExecutionResult(params);
        },
      },
      async mine(params: { readonly blockName: string; readonly count: number }) {
        calls.push(`mine:${params.blockName}:${params.count}`);
        return createMineSkillExecutionResult(params);
      },
      async collect(params: { readonly itemName: string; readonly radius?: number }) {
        calls.push(`collect:${params.itemName}:${params.radius ?? 32}`);
        return createCollectSkillExecutionResult(params);
      },
      async equip(params: { readonly itemName: string; readonly destination?: "hand" }) {
        calls.push(`equip:${params.itemName}:${params.destination ?? "hand"}`);
        return createEquipSkillExecutionResult(params);
      },
    };

    await expect(executeSkillCallJob({ job: mineJob, dependencies })).resolves.toMatchObject({
      skill: "mine",
      block_name: "stone",
      mined_count: 2,
      total_steps: 2,
    });
    await expect(executeSkillCallJob({ job: collectJob, dependencies })).resolves.toMatchObject({
      skill: "collect",
      item_name: "cobblestone",
      radius: 32,
      total_steps: 1,
    });
    await expect(executeSkillCallJob({ job: equipJob, dependencies })).resolves.toMatchObject({
      skill: "equip",
      item_name: "stone_pickaxe",
      destination: "hand",
      total_steps: 1,
    });
    expect(calls).toEqual(["mine:stone:2", "collect:cobblestone:32", "equip:stone_pickaxe:hand"]);
  });

  it("mine（挖掘） stone（石头） 应检查工具并以 cobblestone（圆石） 背包增量完成", async () => {
    const inventory = new Map<string, number>();
    const mine = createMineSkillExecutor({
      resourceService: createResourceService(),
      equipment: {
        readMainHandItemName: () => "wooden_pickaxe",
      },
      miner: {
        async mine(params) {
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
  });

  it("mine（挖掘） 应在工具未装备或掉落未进入背包时结构化失败", async () => {
    const inventory = new Map<string, number>();
    const createMine = (tool: string | null) =>
      createMineSkillExecutor({
        resourceService: createResourceService(),
        equipment: {
          readMainHandItemName: () => tool,
        },
        miner: {
          async mine(params) {
            return createMineSkillExecutionResult(params, {
              world_key: "multiworld:resource",
              collected_item_name: "cobblestone",
              collected_count: 0,
              mined_count: params.count,
            });
          },
        },
      });

    await expect(createMine(null)({ blockName: "stone", count: 1 })).rejects.toThrow(
      "not_equipped:stone:main_hand_empty",
    );
    await expect(createMine("wooden_pickaxe")({ blockName: "stone", count: 1 })).rejects.toThrow(
      "drop_not_obtained:cobblestone:0/1",
    );
  });

  it("mine（挖掘） dirt（泥土） 等软方块不应要求主手工具", async () => {
    const mine = createMineSkillExecutor({
      resourceService: createResourceService(),
      equipment: {
        readMainHandItemName: () => null,
      },
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
      equipment: {
        readMainHandItemName: () => "stone_pickaxe",
      },
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
    const job = createSkillCallJob({
      message_id: "msg-skill-cut-tree",
      intent_epoch: 1,
      snapshot_ts: 100,
      priority: ExecPriority.Normal,
      skill: SKILL_DIRECTORY.cutTree,
      params: { count: 3 },
    });

    const result = await executeSkillCallJob({
      job,
      dependencies: {
        goToMovement: {
          async goTo(params) {
            return createGoToSkillExecutionResult(params);
          },
        },
        async mine(params) {
          return createMineSkillExecutionResult(params);
        },
        async collect(params) {
          return createCollectSkillExecutionResult(params);
        },
        async equip(params) {
          return createEquipSkillExecutionResult(params);
        },
        cutTree,
      },
    });

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
          return createCollectSkillExecutionResult(params);
        },
      },
      inventory: {
        readInventoryItems: () => [],
      },
    });

    await expect(cutTree({ count: 5 })).rejects.toThrow("附近木头不足：已获得 0/5 个原木");
  });

  it("cutTree（砍树） 强制 collect（捡拾） 失败时应让任务失败", async () => {
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
          return undefined;
        },
      },
      collector: {
        async collect() {
          throw new Error("forced collect failed");
        },
      },
      inventory: {
        readInventoryItems: () => [],
      },
    });

    await expect(cutTree({ count: 1 })).rejects.toThrow("forced collect failed");
  });

  it("cutTree（砍树） 默认应等待 1 秒再从最低原木位置 collect（捡拾）", async () => {
    vi.useFakeTimers();
    const inventory = new Map<string, number>();
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
        async digBlockAt() {
          return undefined;
        },
      },
      collector: {
        async collect(params) {
          collects.push({
            center: params.center === undefined ? undefined : { ...params.center },
          });
          inventory.set("cherry_log", 2);

          return createCollectSkillExecutionResult(params, {
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
