import { describe, expect, it } from "vitest";

import { ExecPriority, createSkillCallJob } from "../runtime/index.js";
import {
  SKILL_DIRECTORY,
  createCollectSkillExecutionResult,
  createEquipSkillExecutionResult,
  createGoToSkillExecutionResult,
  createMineSkillExecutionResult,
  executeSkillCallJob,
} from "../skills/index.js";

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
      params: { itemName: "cobblestone", radius: 6 },
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
        calls.push(`collect:${params.itemName}:${params.radius ?? 8}`);
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
      radius: 6,
      total_steps: 1,
    });
    await expect(executeSkillCallJob({ job: equipJob, dependencies })).resolves.toMatchObject({
      skill: "equip",
      item_name: "stone_pickaxe",
      destination: "hand",
      total_steps: 1,
    });
    expect(calls).toEqual(["mine:stone:2", "collect:cobblestone:6", "equip:stone_pickaxe:hand"]);
  });
});
