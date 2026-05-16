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

describe("sandbox runGoal/report 行为", () => {
  it("应通过 runGoal + report(task) 记录目标终态事实且不直接发送最终聊天", async () => {
    const chatCalls: unknown[] = [];
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          await reply('收到，我去挖石头喵~');
          const task = await runGoal('挖 2 个石头', async () => {
            const mined = await ensure(
              async () => mine('stone', 2),
              until.gained('cobblestone', 2),
            );
            if (mined.ok === false) { throw new Error(mined.error.code) }
          });
          await report(task);
        `,
        messageId: "T-070-goal-report",
      }),
      hostBridge: {
        ...createSatisfiedConditionFacade(),
        async executeBotSkill(skill, params) {
          return {
            skill,
            block_name: "stone",
            collected_item_name: "cobblestone",
            collected_count: params.count,
            world_key: "minecraft:overworld",
          };
        },
        async executeToolchainCapability() {
          throw new Error("ensure recovery should not run");
        },
        async writeChat(method, params) {
          chatCalls.push({ method, params });

          return { delivered: true };
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(chatCalls).toEqual([{ method: "say", params: { message: "收到，我去挖石头喵~" } }]);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      status: "ok",
      params: {
        message: "",
        goal_result: {
          kind: "goal_result",
          ok: true,
          name: "挖 2 个石头",
          condition: { kind: "gained", itemName: "cobblestone", count: 2 },
          summary: {
            target: "cobblestone",
            requested_count: 2,
            completed_count: 2,
            inventory_delta: [{ item_name: "cobblestone", count: 2 }],
            world_key: "minecraft:overworld",
          },
        },
      },
    });

    const summary = createTaskResultSummaryFromSandboxResult(
      createCodeJob({
        message_id: "T-070-goal-report",
        intent_epoch: 1,
        snapshot_ts: 1,
        priority: ExecPriority.Normal,
        code: "code",
      }),
      result,
    );
    expect(summary).toMatchObject({
      operation: "挖 2 个石头",
      status: "completed",
      target: "cobblestone",
      requested_count: 2,
      completed_count: 2,
      inventory_delta: [{ item_name: "cobblestone", count: 2 }],
      world_key: "minecraft:overworld",
    });
  });

  it("report(task) 应拒绝缺 completed_count 的成功 GoalResult", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          await report({
            kind: 'goal_result',
            ok: true,
            name: '空成功摘要',
            duration_ms: 1,
            summary: {},
          });
        `,
        messageId: "T-098-report-empty-success-summary",
      }),
      hostBridge: {
        async executeBotSkill() {
          throw new Error("skill should not run");
        },
        async writeChat() {
          throw new Error("chat should not run");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.step_results).toEqual([]);
    expect(result.error).toMatchObject({
      name: "UnhandledError",
      message: "GoalResult.summary.completed_count must be finite",
    });
  });

  it("runGoal 应聚合多动作目标里的背包增量并保留最终世界事实", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          await reply('收到，我去砍木头、挖石头并回来喵~');
          const task = await runGoal('砍木头、挖石头并返回主人身边', async () => {
            const wood = await cutTree(20);
            if (wood.ok === false) { throw new Error(wood.error.code) }
            const stone = await ensure(
              async () => mine('stone', 5),
              until.gained('cobblestone', 5),
            );
            if (stone.ok === false) { throw new Error(stone.error.code) }
            const p = owner.position;
            if (!p) { throw new Error('owner_position_missing') }
            await goTo(p.x, p.y, p.z);
          });
          await report(task);
        `,
        messageId: "T-070-multi-goal-report",
      }),
      task: {
        id: "T-070-multi-goal-report",
        userMessage: "砍20个木头，然后去挖5个石头，最后回到我这",
        intent: "code",
        owner: {
          online: true,
          position: { x: 1, y: 64, z: 2 },
        },
      },
      hostBridge: {
        ...createSatisfiedConditionFacade(),
        async executeBotSkill(skill, params) {
          if (skill === "cutTree") {
            return {
              skill: "cutTree",
              requested_count: params.count,
              collected_count: params.count,
              clusters: [{ log_block_name: "oak_log", collected_count: params.count }],
              world_key: "multiworld:resource",
            };
          }
          if (skill === "mine") {
            return {
              skill: "mine",
              block_name: "stone",
              collected_item_name: "cobblestone",
              collected_count: params.count,
              world_key: "multiworld:resource",
            };
          }
          if (skill === "goTo") {
            return {
              skill: "goTo",
              target: params,
              reached: true,
              world_key: "multiworld:resource",
            };
          }

          throw new Error(`unexpected skill ${skill}`);
        },
        async executeToolchainCapability() {
          throw new Error("ensure recovery should not run");
        },
        async writeChat() {
          return { delivered: true };
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          kind: "goal_result",
          ok: true,
          name: "砍木头、挖石头并返回主人身边",
          summary: {
            completed_count: 25,
            inventory_delta: [
              { item_name: "oak_log", count: 20 },
              { item_name: "cobblestone", count: 5 },
            ],
            world_key: "multiworld:resource",
          },
        },
      },
    });

    const summary = createTaskResultSummaryFromSandboxResult(
      createCodeJob({
        message_id: "T-070-multi-goal-report",
        intent_epoch: 1,
        snapshot_ts: 1,
        priority: ExecPriority.Normal,
        code: "code",
      }),
      result,
    );
    expect(summary).toMatchObject({
      operation: "砍木头、挖石头并返回主人身边",
      completed_count: 25,
      inventory_delta: [
        { item_name: "oak_log", count: 20 },
        { item_name: "cobblestone", count: 5 },
      ],
      world_key: "multiworld:resource",
    });
  });

  it("应让 report(task) 记录失败 GoalResult 后使任务进入 failed 终态", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          const task = await runGoal('挖铁矿', async () => {
            const mined = await ensure(
              async () => mine('iron_ore', 1),
              until.gained('raw_iron', 1),
            );
            if (mined.ok === false) { throw new Error(mined.error.code) }
          });
          await report(task);
        `,
        messageId: "T-070-goal-failed",
      }),
      hostBridge: {
        ...createSatisfiedConditionFacade(),
        async executeBotSkill() {
          const error = new Error("not_equipped");
          throw Object.assign(error, {
            error_code: "not_equipped",
            details: {
              failure_stage: "mine",
              world_key: "minecraft:overworld",
              target_progress: {
                action: "mine",
                target: "raw_iron",
                requested_count: 1,
                completed_count: 0,
              },
            },
          });
        },
        async executeToolchainCapability() {
          return {
            ok: false,
            error: {
              code: "not_equipped",
              message: "not_equipped",
              details: {
                failure_stage: "mine",
                world_key: "minecraft:overworld",
                target_progress: {
                  action: "mine",
                  target: "raw_iron",
                  requested_count: 1,
                  completed_count: 0,
                },
              },
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
      status: "ok",
      params: {
        goal_result: {
          ok: false,
          failure: {
            failure_code: "not_equipped",
            failure_stage: "mine",
          },
        },
      },
    });

    const summary = createTaskResultSummaryFromSandboxResult(
      createCodeJob({
        message_id: "T-070-goal-failed",
        intent_epoch: 1,
        snapshot_ts: 1,
        priority: ExecPriority.Normal,
        code: "code",
      }),
      result,
    );
    expect(summary).toMatchObject({
      operation: "挖铁矿",
      status: "failed",
      target: "raw_iron",
      requested_count: 1,
      completed_count: 0,
      world_key: "minecraft:overworld",
      failure: {
        failure_code: "not_equipped",
        recoverable: true,
      },
    });
  });

  it("runGoal 应保留 ensure 的最终资源条件证明，不被后续 goTo 动作稀释", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          const task = await runGoal('砍 5 个木头并返回主人身边', async () => {
            await ensure(async () => { await cutTree(5); }, until.gainedTag('logs', 5));
            await goTo(owner.position.x, owner.position.y, owner.position.z);
          });
          await report(task);
        `,
        messageId: "T-087-ensure-then-goto-summary",
      }),
      task: {
        id: "T-087-ensure-then-goto-summary",
        userMessage: "砍5个木头回来",
        intent: "code",
        owner: {
          online: true,
          position: { x: 8, y: 64, z: 2 },
        },
      },
      hostBridge: {
        captureConditionState: createSatisfiedConditionFacade().captureConditionState,
        evaluateCondition(input) {
          return createTestConditionEvaluation(input, 5, 5);
        },
        async executeBotSkill(skill) {
          if (skill === "cutTree") {
            return {
              skill: "cutTree",
              requested_count: 5,
              collected_count: 1,
              completed: true,
              status: "partial_action_summary",
              world_key: "minecraft:overworld",
              clusters: [
                { cluster_id: "tree-1", log_block_name: "runtime_log", collected_count: 1 },
              ],
              total_steps: 1,
            };
          }

          return {
            skill: "goTo",
            target: { x: 8, y: 64, z: 2 },
            reached: true,
            world_key: "minecraft:overworld",
            total_steps: 3,
            diagnostics: ["test_returned_to_owner"],
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          ok: true,
          condition: {
            kind: "gainedTag",
            tagName: "logs",
            count: 5,
          },
          summary: {
            target: "logs",
            requested_count: 5,
            completed_count: 5,
            inventory_delta: [{ item_name: "logs", count: 5 }],
          },
        },
      },
    });
  });
});
