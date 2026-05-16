import { describe, expect, it } from "vitest";
import { createTestOnlyProvenMineResult } from "../helpers/test-skill-proofs.js";

import {
  SKILL_DIRECTORY,
  createCollectSkillExecutionResult,
  createEquipSkillExecutionResult,
  createGoToSkillExecutionResult,
} from "../../skills/index.js";
import { executeSkillInvocation } from "../../skills/legacy/execution.js";

describe("legacy/test-only runtime skill invocation 执行入口", () => {
  it("应通过可注入 movement adapter 执行旧 goTo 调用夹具", async () => {
    const targets: Array<{ x: number; y: number; z: number }> = [];
    const invocation = {
      skill: SKILL_DIRECTORY.goTo,
      params: { x: 10, y: 64, z: -5 },
    } as const;

    const result = await executeSkillInvocation({
      invocation,
      dependencies: {
        goToMovement: {
          async goTo(params) {
            targets.push({ ...params });

            return createGoToSkillExecutionResult(params);
          },
        },
        async mine(params) {
          return createTestOnlyProvenMineResult(params, {
            collectedItemName: "test_runtime_drop",
            collectedCount: params.count,
            minedCount: params.count,
          });
        },
        async collect(params) {
          return createCollectSkillExecutionResult(params, { collected: [] });
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

  it("应透出旧 movement adapter 失败，不允许静默成功", async () => {
    const invocation = {
      skill: SKILL_DIRECTORY.goTo,
      params: { x: 10, y: 64, z: -5 },
    } as const;

    await expect(
      executeSkillInvocation({
        invocation,
        dependencies: {
          goToMovement: {
            async goTo() {
              throw new Error("path not found");
            },
          },
          async mine(params) {
            return createTestOnlyProvenMineResult(params, {
              collectedItemName: "test_runtime_drop",
              collectedCount: params.count,
              minedCount: params.count,
            });
          },
          async collect(params) {
            return createCollectSkillExecutionResult(params, { collected: [] });
          },
          async equip(params) {
            return createEquipSkillExecutionResult(params);
          },
        },
      }),
    ).rejects.toThrow("path not found");
  });

  it("应通过可注入 adapter 执行旧 mine / collect / equip 调用夹具", async () => {
    const calls: string[] = [];

    const mineInvocation = {
      skill: SKILL_DIRECTORY.mine,
      params: { blockName: "stone", count: 2 },
    } as const;
    const collectInvocation = {
      skill: SKILL_DIRECTORY.collect,
      params: { itemName: "cobblestone", radius: 32 },
    } as const;
    const equipInvocation = {
      skill: SKILL_DIRECTORY.equip,
      params: { itemName: "stone_pickaxe", destination: "hand" },
    } as const;

    const dependencies = {
      goToMovement: {
        async goTo(params: { readonly x: number; readonly y: number; readonly z: number }) {
          return createGoToSkillExecutionResult(params);
        },
      },
      async mine(params: { readonly blockName: string; readonly count: number }) {
        calls.push(`mine:${params.blockName}:${params.count}`);
        return createTestOnlyProvenMineResult(params, {
          collectedItemName: "test_runtime_drop",
          collectedCount: params.count,
          minedCount: params.count,
        });
      },
      async collect(params: { readonly itemName: string; readonly radius?: number }) {
        calls.push(`collect:${params.itemName}:${params.radius ?? 32}`);
        return createCollectSkillExecutionResult(params, { collected: [] });
      },
      async equip(params: { readonly itemName: string; readonly destination?: "hand" }) {
        calls.push(`equip:${params.itemName}:${params.destination ?? "hand"}`);
        return createEquipSkillExecutionResult(params);
      },
    };

    await expect(
      executeSkillInvocation({ invocation: mineInvocation, dependencies }),
    ).resolves.toMatchObject({
      skill: "mine",
      block_name: "stone",
      mined_count: 2,
      total_steps: 2,
    });
    await expect(
      executeSkillInvocation({ invocation: collectInvocation, dependencies }),
    ).resolves.toMatchObject({
      skill: "collect",
      item_name: "cobblestone",
      radius: 32,
      total_steps: 1,
    });
    await expect(
      executeSkillInvocation({ invocation: equipInvocation, dependencies }),
    ).resolves.toMatchObject({
      skill: "equip",
      item_name: "stone_pickaxe",
      destination: "hand",
      total_steps: 1,
    });
    expect(calls).toEqual(["mine:stone:2", "collect:cobblestone:32", "equip:stone_pickaxe:hand"]);
  });
});
