import {
  ExecPriority,
  ExecutionTaskKind,
  TaskHistoryStatus,
  createCodeJob,
  createRuntimeSandboxRequest,
  createSandboxError,
  createSandboxExecutionFailure,
  createSandboxExecutionInterrupted,
  createSandboxExecutionSuccess,
  createSandboxResourceLimits,
  createSatisfiedConditionFacade,
  createTaskResultSummaryFromSandboxResult,
  createTestConditionEvaluation,
  describe,
  executeCodeRequest,
  expect,
  invalidAbortRecoverable,
  invalidCraftParams,
  invalidGoToParams,
  invalidSandboxRequestType,
  invalidStepAction,
  it,
  validCraftParams,
} from "./diagnostics-and-execution.fixture.js";

void validCraftParams;
void invalidAbortRecoverable;
void invalidCraftParams;
void invalidGoToParams;
void invalidSandboxRequestType;
void invalidStepAction;

describe("sandbox completion proof 行为", () => {
  it("直接 mine（挖掘） 少拿到目标掉落物时不得汇报成功", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          const task = await runGoal('强语义挖掘', async () => {
            await mine('target_block', 5);
          });
          await report(task);
        `,
        messageId: "T-085-mine-direct-insufficient",
      }),
      hostBridge: {
        async executeBotSkill() {
          return {
            skill: "mine",
            block_name: "target_block",
            collected_item_name: "runtime_drop",
            collected_count: 3,
            mined_count: 3,
            total_steps: 1,
            world_key: "minecraft:overworld",
            diagnostics: ["test_runtime_drop_shortfall"],
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          ok: false,
          failure: {
            failure_code: "condition_not_met",
            details: {
              target_progress: {
                action: "mine",
                target: "target_block",
                requested_count: 5,
                completed_count: 3,
              },
            },
          },
        },
      },
    });
  });

  it("直接 mine（挖掘） 返回 ok 但缺少完成证明时应转为 unknown_completion", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          const task = await runGoal('缺证明挖掘', async () => {
            await mine('target_block', 2);
          });
          await report(task);
        `,
        messageId: "T-085-mine-unknown-completion",
      }),
      hostBridge: {
        async executeBotSkill() {
          return {
            ok: true,
            data: {
              skill: "mine",
              block_name: "target_block",
              world_key: "minecraft:overworld",
            },
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          ok: false,
          failure: {
            failure_code: "unknown_completion",
            details: {
              reason: "mine result lacks inventory completion proof",
            },
          },
        },
      },
    });
    const summary = createTaskResultSummaryFromSandboxResult(
      createCodeJob({
        message_id: "T-085-mine-unknown-completion",
        intent_epoch: 1,
        snapshot_ts: 1,
        priority: ExecPriority.Normal,
        code: "code",
      }),
      result,
    );
    expect(summary).toMatchObject({
      status: "failed",
      failure: {
        failure_code: "unknown_completion",
      },
    });
  });

  it("sandbox skill 兼容摘要路径不得把缺 proof 的 mine / collect 包装成完成", () => {
    const sandboxJob = createCodeJob({
      message_id: "T-088-summary-proof",
      intent_epoch: 1,
      snapshot_ts: 1,
      priority: ExecPriority.Normal,
      code: "code",
    });
    const createCompletedSandboxResult = (resultRecord: Readonly<Record<string, unknown>>) =>
      ({
        status: TaskHistoryStatus.Completed,
        summary: { total_steps: 1, duration_ms: 1 },
        step_results: [
          {
            action: resultRecord.skill,
            status: "ok",
            params: {},
            result: resultRecord,
          },
        ],
      }) as unknown as Parameters<typeof createTaskResultSummaryFromSandboxResult>[1];

    expect(
      createTaskResultSummaryFromSandboxResult(
        sandboxJob,
        createCompletedSandboxResult({ skill: "mine", block_name: "stone" }),
      ),
    ).toMatchObject({
      status: "failed",
      failure: { failure_code: "unknown_completion" },
      details: { missing_fields: ["collected_item_name", "collected_count", "mined_count"] },
    });
    expect(
      createTaskResultSummaryFromSandboxResult(
        sandboxJob,
        createCompletedSandboxResult({
          skill: "mine",
          block_name: "stone",
          collected_item_name: "cobblestone",
          collected_count: 5,
          mined_count: 5,
          world_key: "minecraft:overworld",
        }),
      ),
    ).toMatchObject({
      status: "completed",
      operation: "mine",
      target: "stone",
      completed_count: 5,
      inventory_delta: [{ item_name: "cobblestone", count: 5 }],
      world_key: "minecraft:overworld",
    });
    expect(
      createTaskResultSummaryFromSandboxResult(
        sandboxJob,
        createCompletedSandboxResult({
          skill: "collect",
          item_name: null,
          collected: [{ name: "oak_log", count: 2 }],
        }),
      ),
    ).toMatchObject({
      status: "completed",
      operation: "collect",
      target: "all_items",
      completed_count: 2,
      inventory_delta: [{ item_name: "oak_log", count: 2 }],
    });
    expect(
      createTaskResultSummaryFromSandboxResult(
        sandboxJob,
        createCompletedSandboxResult({ skill: "collect", item_name: null }),
      ),
    ).toMatchObject({
      status: "failed",
      failure: { failure_code: "unknown_completion" },
      details: { missing_fields: ["collected"] },
    });
  });

  it("sandbox code 正常结束但没有 report/toolchain/skill proof 时不得包装成完成", () => {
    const sandboxJob = createCodeJob({
      message_id: "T-100-summary-no-completion-proof",
      intent_epoch: 1,
      snapshot_ts: 1,
      priority: ExecPriority.Normal,
      code: "await sleep(1)",
    });
    const result = {
      status: TaskHistoryStatus.Completed,
      summary: { total_steps: 1, duration_ms: 1 },
      step_results: [
        {
          action: "sleep",
          status: "ok",
          params: {},
          result: { ok: true },
        },
      ],
    } as unknown as Parameters<typeof createTaskResultSummaryFromSandboxResult>[1];

    expect(createTaskResultSummaryFromSandboxResult(sandboxJob, result)).toMatchObject({
      status: "failed",
      operation: "sleep",
      completed_count: 0,
      failure: {
        failure_code: "unknown_completion",
        failure_stage: "sleep",
        message: "sandbox result lacks completion proof",
        recoverable: false,
      },
      details: {
        reason: "completed sandbox result lacks report/toolchain/skill completion proof",
        total_steps: 1,
      },
    });
  });

  it("sandbox terminal failure 缺显式 recoverable 时应使用统一失败分类口径", () => {
    const sandboxJob = createCodeJob({
      message_id: "T-093-terminal-recoverable",
      intent_epoch: 1,
      snapshot_ts: 1,
      priority: ExecPriority.Normal,
      code: "code",
    });
    const createFailedSandboxResult = (errorCode: string) =>
      ({
        status: TaskHistoryStatus.Failed,
        summary: { total_steps: 1, duration_ms: 1 },
        step_results: [
          {
            action: "mine",
            status: "error",
            params: { blockName: "stone", count: 1 },
            error: {
              error_code: errorCode,
              message: `${errorCode}:stone`,
              details: {
                failure_stage: "mine",
                target_progress: {
                  action: "mine",
                  target: "stone",
                  requested_count: 1,
                  completed_count: 0,
                },
              },
            },
          },
        ],
        error: {
          error_code: errorCode,
          message: `${errorCode}:stone`,
          details: {
            failure_stage: "mine",
            target_progress: {
              action: "mine",
              target: "stone",
              requested_count: 1,
              completed_count: 0,
            },
          },
        },
      }) as unknown as Parameters<typeof createTaskResultSummaryFromSandboxResult>[1];

    expect(
      createTaskResultSummaryFromSandboxResult(
        sandboxJob,
        createFailedSandboxResult("not_equipped"),
      ),
    ).toMatchObject({
      status: "failed",
      failure: {
        failure_code: "not_equipped",
        recoverable: true,
      },
    });
    expect(
      createTaskResultSummaryFromSandboxResult(
        sandboxJob,
        createFailedSandboxResult("unknown_completion"),
      ),
    ).toMatchObject({
      status: "failed",
      failure: {
        failure_code: "unknown_completion",
        recoverable: false,
      },
    });
  });

  it("cutTree（砍树） count 以原木获得数量为准，少拿到原木必须失败", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          const task = await runGoal('强语义砍树', async () => {
            await cutTree(5);
          });
          await report(task);
        `,
        messageId: "T-085-cut-tree-insufficient",
      }),
      hostBridge: {
        async executeBotSkill() {
          return {
            skill: "cutTree",
            requested_count: 5,
            collected_count: 4,
            completed: false,
            status: "insufficient",
            world_key: "minecraft:overworld",
            clusters: [{ cluster_id: "tree-1", log_block_name: "runtime_log", collected_count: 4 }],
            diagnostics: ["test_cut_tree_shortfall"],
            total_steps: 1,
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          ok: false,
          failure: {
            failure_code: "condition_not_met",
            details: {
              target_progress: {
                action: "cutTree",
                target: "runtime_log",
                requested_count: 5,
                completed_count: 4,
              },
            },
          },
        },
      },
    });
  });

  it("ensure（确保） 应在 action 成功但 condition 不满足时返回结构化失败", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          const task = await runGoal('检查条件', async () => {
            await ensure(async () => { await collect(); }, until.has('cobblestone', 1));
          });
          await report(task);
        `,
        messageId: "T-081-condition-not-met",
      }),
      hostBridge: {
        captureConditionState: createSatisfiedConditionFacade().captureConditionState,
        evaluateCondition(input) {
          return createTestConditionEvaluation(input, 0, 1);
        },
        async executeBotSkill() {
          return { skill: "collect", collected: [], skipped: [], total_steps: 1 };
        },
        async executeToolchainCapability() {
          return {
            ok: false,
            error: {
              code: "condition_not_met",
              message: "condition_not_met",
              world_key: "minecraft:overworld",
            },
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          ok: false,
          failure: {
            failure_code: "condition_not_met",
          },
        },
      },
    });
  });

  it("ensure（确保） 应在恢复后重新检查 condition 并成功", async () => {
    const calls: unknown[] = [];
    let evaluations = 0;
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "const task = await runGoal('恢复后满足', async () => { await ensure(async () => { await collect(); }, until.has('cobblestone', 1)); }); await report(task);",
        messageId: "T-081-condition-recovered",
      }),
      hostBridge: {
        captureConditionState: createSatisfiedConditionFacade().captureConditionState,
        evaluateCondition(input) {
          evaluations += 1;
          return createTestConditionEvaluation(input, evaluations >= 2 ? 1 : 0, 1);
        },
        async executeBotSkill() {
          return { skill: "collect", collected: [], skipped: [], total_steps: 1 };
        },
        async executeToolchainCapability(capability, params) {
          calls.push({ capability, params });
          return {
            ok: true,
            data: { completed_count: 1, world_key: "minecraft:overworld", actions: [] },
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(calls).toEqual([
      {
        capability: "ensure",
        params: expect.objectContaining({
          failure: expect.objectContaining({ code: "condition_not_met" }),
        }),
      },
    ]);
  });

  it("ensure 未满足资源条件时不得继续执行后续 goTo 并伪装完成", async () => {
    const skillCalls: string[] = [];
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
	          const task = await runGoal('挖 5 个石头并返回主人身边', async () => {
	            await ensure(async () => { await mine('stone', 5); }, until.gainedDropOf('stone', 5));
	            await goTo(owner.position.x, owner.position.y, owner.position.z);
	          });
	          await report(task);
	        `,
        messageId: "T-101-ensure-failure-stops-goto",
      }),
      task: {
        id: "T-101-ensure-failure-stops-goto",
        userMessage: "挖5个石头然后回来",
        intent: "code",
        owner: {
          online: true,
          position: { x: 8, y: 64, z: 2 },
        },
      },
      hostBridge: {
        captureConditionState: createSatisfiedConditionFacade().captureConditionState,
        evaluateCondition(input) {
          return createTestConditionEvaluation(input, 1, 5);
        },
        async executeBotSkill(skill, params) {
          skillCalls.push(skill);
          if (skill === "mine") {
            return {
              skill: "mine",
              block_name: "stone",
              collected_item_name: "cobblestone",
              collected_count: 1,
              requested_count: params.count,
              world_key: "minecraft:overworld",
            };
          }
          if (skill === "goTo") {
            return {
              skill: "goTo",
              reached: true,
              world_key: "minecraft:overworld",
            };
          }
          throw new Error(`unexpected skill ${skill}`);
        },
        async executeToolchainCapability() {
          return {
            ok: true,
            data: { completed_count: 1, world_key: "minecraft:overworld", actions: [] },
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(skillCalls).toEqual(["mine", "mine", "mine"]);
    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          ok: false,
          failure: {
            failure_code: "condition_not_met",
          },
        },
      },
    });
  });

  it("ensure（确保） 应在恢复后仍不满足 condition 时保留 condition_not_met 失败", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "const task = await runGoal('恢复后仍不满足', async () => { await ensure(async () => { await collect(); }, until.has('cobblestone', 1)); }); await report(task);",
        messageId: "T-081-condition-still-missing",
      }),
      hostBridge: {
        captureConditionState: createSatisfiedConditionFacade().captureConditionState,
        evaluateCondition(input) {
          return createTestConditionEvaluation(input, 0, 1);
        },
        async executeBotSkill() {
          return { skill: "collect", collected: [], skipped: [], total_steps: 1 };
        },
        async executeToolchainCapability() {
          return {
            ok: true,
            data: { completed_count: 1, world_key: "minecraft:overworld", actions: [] },
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          ok: false,
          failure: {
            failure_code: "condition_not_met",
          },
        },
      },
    });
  });

  it("应把 place（放置） 工具链结构化失败升级为沙箱失败", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await place('crafting_table')",
        messageId: "T-056-place-failed",
      }),
      hostBridge: {
        async executeBotSkill() {
          throw new Error("unexpected skill call");
        },
        async executeToolchainCapability() {
          return {
            ok: false,
            error: {
              code: "missing_materials",
              message: "Inventory does not contain enough recipe ingredients",
              world_key: "minecraft:overworld",
            },
          };
        },
        async writeChat() {
          throw new Error("unexpected chat call");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.error).toMatchObject({
      name: "FacadeCallError",
      error_code: "missing_materials",
    });
    expect(result.step_results[0]).toMatchObject({
      action: "place",
      status: "err",
    });
  });
});
