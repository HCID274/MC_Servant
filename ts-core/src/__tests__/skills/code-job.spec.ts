import { describe, expect, it } from "vitest";

import { ExecPriority, ExecutionTaskKind, SKILL_DIRECTORY } from "../../index.js";
import { createCodeJobForSkill } from "../helpers/test-code-job.js";

describe("skills/code job 构造", () => {
  it("应让语义 code job 构造与运行时任务共享同一套强类型目录", () => {
    const codeJob = createCodeJobForSkill({
      message_id: "msg-skill-call",
      intent_epoch: 3,
      snapshot_ts: 1_712_930_100,
      priority: ExecPriority.Urgent,
      skill: SKILL_DIRECTORY.cutTree,
      params: { count: 2 },
    });

    expect(codeJob.type).toBe(ExecutionTaskKind.Code);
    expect(codeJob.code).toContain("cutTree(2)");
    expect(Object.isFrozen(codeJob)).toBe(true);
  });
});
