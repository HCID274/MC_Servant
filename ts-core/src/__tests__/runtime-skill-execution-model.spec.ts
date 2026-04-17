import { describe, expect, it } from "vitest";

import { ExecPriority, createSkillCallJob } from "../runtime/index.js";
import {
  SKILL_DIRECTORY,
  createGoToSkillExecutionResult,
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
        },
      }),
    ).rejects.toThrow("path not found");
  });
});
