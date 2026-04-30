import { describe, expect, it } from "vitest";

import {
  ExecPriority,
  TaskHistoryStatus,
  createSandboxCodeJob,
  createSkillCallJob,
} from "../index.js";
import {
  SKILL_DIRECTORY,
  createCollectSkillExecutionResult,
  createGoToSkillExecutionResult,
} from "../skills/index.js";
import { createBotWorkerRuntime } from "../workers/bot-worker.js";
import {
  type BotWorkerAction,
  createBotWorkerActions,
  createBotWorkerTask,
} from "../workers/contracts.js";

describe("BotWorker（机器人工作线程） 真实运行时", () => {
  it("应串行消费执行任务并通过 BotActor（机器人执行代理） 执行 goTo（前往坐标）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const executedMessages: string[] = [];
    const actions: string[] = [];
    const runtime = createBotWorkerRuntime({
      queue: {
        name: "bot:bot-worker:exec",
        connection: {},
      },
      dependencies: {
        actor: {
          async executeSkill(job) {
            executedMessages.push(job.message_id);

            return {
              result: createGoToSkillExecutionResult(job.params),
              snapshot: {} as never,
            };
          },
          async executeSandboxCode() {
            throw new Error("sandbox should not run");
          },
        },
        now: (() => {
          const values = [1000, 1042];

          return () => values.shift() ?? 1042;
        })(),
        actionSink: async (action) => {
          actions.push(action.type);
        },
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
      },
    });
    const task = createBotWorkerTask({
      bot_id: "bot-worker",
      exec_job: createSkillCallJob({
        message_id: "msg-worker-goto",
        intent_epoch: 1,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        skill: SKILL_DIRECTORY.goTo,
        params: { x: 10, y: 64, z: -5 },
      }),
    });

    await runtime.start();
    await processor?.({ data: task });

    expect(executedMessages).toEqual(["msg-worker-goto"]);
    expect(actions).toEqual(["emit_task_lifecycle", "emit_task_lifecycle", "enqueue_brain"]);
    expect(runtime.getEvents()).toEqual([
      {
        type: "task.started",
        bot_id: "bot-worker",
        message_id: "msg-worker-goto",
        status: TaskHistoryStatus.Started,
      },
      {
        type: "task.completed",
        bot_id: "bot-worker",
        message_id: "msg-worker-goto",
        status: TaskHistoryStatus.Completed,
        total_steps: 1,
      },
    ]);
  });

  it("应把 BotActor（机器人执行代理） 执行失败记录为 failed（已失败） 并继续抛错", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const runtime = createBotWorkerRuntime({
      queue: {
        name: "bot:bot-worker:exec",
        connection: {},
      },
      dependencies: {
        actor: {
          async executeSkill() {
            throw new Error("path not found");
          },
          async executeSandboxCode() {
            throw new Error("sandbox should not run");
          },
        },
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
      },
    });
    const task = createBotWorkerTask({
      bot_id: "bot-worker",
      exec_job: createSkillCallJob({
        message_id: "msg-worker-failed",
        intent_epoch: 1,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        skill: SKILL_DIRECTORY.goTo,
        params: { x: 10, y: 64, z: -5 },
      }),
    });

    await runtime.start();
    await expect(processor?.({ data: task })).rejects.toThrow("path not found");

    expect(runtime.getEvents()).toContainEqual({
      type: "task.failed",
      bot_id: "bot-worker",
      message_id: "msg-worker-failed",
      status: TaskHistoryStatus.Failed,
      error: {
        name: "Error",
        message: "path not found",
      },
    });
  });

  it("应在 intent_epoch（意图纪元） 过期时丢弃任务且不调用 BotActor（机器人执行代理）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let executeCount = 0;
    const runtime = createBotWorkerRuntime({
      queue: {
        name: "bot:bot-worker:exec",
        connection: {},
      },
      dependencies: {
        actor: {
          async executeSkill(job) {
            executeCount += 1;

            return {
              result: createGoToSkillExecutionResult(job.params),
              snapshot: {} as never,
            };
          },
          async executeSandboxCode() {
            throw new Error("sandbox should not run");
          },
        },
        currentIntentEpoch: () => 2,
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
      },
    });
    const task = createBotWorkerTask({
      bot_id: "bot-worker",
      exec_job: createSkillCallJob({
        message_id: "msg-worker-stale",
        intent_epoch: 1,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        skill: SKILL_DIRECTORY.goTo,
        params: { x: 10, y: 64, z: -5 },
      }),
    });

    await runtime.start();
    await processor?.({ data: task });

    expect(executeCount).toBe(0);
    expect(runtime.getEvents()).toEqual([
      {
        type: "task.discarded",
        bot_id: "bot-worker",
        message_id: "msg-worker-stale",
        status: TaskHistoryStatus.Discarded,
        reason: "intent_epoch_stale",
      },
    ]);
  });

  it("应拒绝未启用 equip（装备） 技能且不调用 BotActor（机器人执行代理）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const executedSkills: string[] = [];
    const runtime = createBotWorkerRuntime({
      queue: {
        name: "bot:bot-worker:exec",
        connection: {},
      },
      dependencies: {
        actor: {
          async executeSkill(job) {
            executedSkills.push(job.skill);

            return {
              result: createGoToSkillExecutionResult({ x: 0, y: 64, z: 0 }),
              snapshot: {} as never,
            };
          },
          async executeSandboxCode() {
            throw new Error("sandbox should not run");
          },
        },
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
      },
    });
    const task = createBotWorkerTask({
      bot_id: "bot-worker",
      exec_job: createSkillCallJob({
        message_id: "msg-worker-equip",
        intent_epoch: 1,
        snapshot_ts: 110,
        priority: ExecPriority.Normal,
        skill: SKILL_DIRECTORY.equip,
        params: { itemName: "stone_pickaxe", destination: "hand" },
      }),
    });

    await runtime.start();
    await expect(processor?.({ data: task })).rejects.toThrow(/not enabled in T-046/);

    expect(executedSkills).toEqual([]);
    expect(runtime.getEvents()).toEqual([
      {
        type: "task.failed",
        bot_id: "bot-worker",
        message_id: "msg-worker-equip",
        status: TaskHistoryStatus.Failed,
        error: {
          name: "Error",
          message: "Skill has not passed independent validation and is not enabled in T-046: equip",
        },
      },
    ]);
  });

  it("应允许已通过单技能验收的 collect（捡拾） 进入 BotActor（机器人执行代理）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const executedSkills: string[] = [];
    const runtime = createBotWorkerRuntime({
      queue: {
        name: "bot:bot-worker:exec",
        connection: {},
      },
      dependencies: {
        actor: {
          async executeSkill(job) {
            executedSkills.push(job.skill);

            if (job.skill !== SKILL_DIRECTORY.collect) {
              throw new Error("expected collect skill");
            }

            return {
              result: createCollectSkillExecutionResult(job.params, {
                center: { x: 0, y: 64, z: 0 },
                collected: [{ name: "cobblestone", count: 1 }],
                total_steps: 1,
              }),
              snapshot: {} as never,
            };
          },
          async executeSandboxCode() {
            throw new Error("sandbox should not run");
          },
        },
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
      },
    });
    const task = createBotWorkerTask({
      bot_id: "bot-worker",
      exec_job: createSkillCallJob({
        message_id: "msg-worker-collect",
        intent_epoch: 1,
        snapshot_ts: 111,
        priority: ExecPriority.Normal,
        skill: SKILL_DIRECTORY.collect,
        params: { itemName: "cobblestone", radius: 8 },
      }),
    });

    await runtime.start();
    await processor?.({ data: task });

    expect(executedSkills).toEqual(["collect"]);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.completed",
      bot_id: "bot-worker",
      message_id: "msg-worker-collect",
      status: TaskHistoryStatus.Completed,
      total_steps: 1,
    });
  });

  it("应把 sandbox_code（沙箱代码） 任务交给 BotActor（机器人执行代理） 执行", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const executedMessages: string[] = [];
    const actions: BotWorkerAction[] = [];
    const runtime = createBotWorkerRuntime({
      queue: {
        name: "bot:bot-worker:exec",
        connection: {},
      },
      dependencies: {
        actor: {
          async executeSkill() {
            throw new Error("skill should not run");
          },
          async executeSandboxCode(job) {
            executedMessages.push(job.message_id);

            return {
              result: {
                status: TaskHistoryStatus.Completed,
                job_id: job.message_id,
                bot_id: "bot-worker",
                intent_epoch: job.intent_epoch,
                log_ref: "sandbox/2026-04-13/msg-worker-sandbox.jsonl",
                phase_logs: [
                  {
                    t: 1,
                    phase: "sandbox_complete",
                    steps: 1,
                    ms: 12,
                  },
                ],
                step_results: [],
                summary: {
                  terminal_status: TaskHistoryStatus.Completed,
                  total_steps: 1,
                  duration_ms: 12,
                },
              },
              snapshot: {} as never,
            };
          },
        },
        actionSink: async (action) => {
          actions.push(action);
        },
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
      },
    });
    const task = createBotWorkerTask({
      bot_id: "bot-worker",
      exec_job: createSandboxCodeJob({
        message_id: "msg-worker-sandbox",
        intent_epoch: 1,
        snapshot_ts: 120,
        priority: ExecPriority.Normal,
        code: "await api.chat.say('hello')",
      }),
    });

    await runtime.start();
    await processor?.({ data: task });

    expect(executedMessages).toEqual(["msg-worker-sandbox"]);
    expect(actions.map((action) => action.type)).toEqual([
      "emit_task_lifecycle",
      "emit_task_lifecycle",
      "enqueue_brain",
      "persist_sandbox_experience",
    ]);
    const experienceAction = actions.find((action) => action.type === "persist_sandbox_experience");
    expect(experienceAction).toMatchObject({
      type: "persist_sandbox_experience",
      experience: {
        bot_id: "bot-worker",
        message_id: "msg-worker-sandbox",
        intent_epoch: 1,
        status: TaskHistoryStatus.Completed,
        total_steps: 1,
        log_ref: "sandbox/2026-04-13/msg-worker-sandbox.jsonl",
      },
    });
    if (experienceAction?.type !== "persist_sandbox_experience") {
      throw new Error("expected sandbox experience action");
    }
    expect(experienceAction.experience.code_hash).toMatch(/^sha256:/);
    expect(Object.isFrozen(experienceAction.experience)).toBe(true);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.completed",
      bot_id: "bot-worker",
      message_id: "msg-worker-sandbox",
      status: TaskHistoryStatus.Completed,
      total_steps: 1,
    });
  });

  it("应只为 sandbox_code（沙箱代码） 真实终态生成 sandbox experience（沙箱经验）动作", () => {
    const sandboxTask = createBotWorkerTask({
      bot_id: "bot-worker",
      exec_job: createSandboxCodeJob({
        message_id: "msg-worker-sandbox-exp",
        intent_epoch: 3,
        snapshot_ts: 130,
        priority: ExecPriority.Normal,
        code: "await api.chat.say('password=hunter2 sk-local-dev')",
      }),
    });
    const skillTask = createBotWorkerTask({
      bot_id: "bot-worker",
      exec_job: createSkillCallJob({
        message_id: "msg-worker-skill-exp",
        intent_epoch: 3,
        snapshot_ts: 130,
        priority: ExecPriority.Normal,
        skill: SKILL_DIRECTORY.goTo,
        params: { x: 1, y: 64, z: 1 },
      }),
    });
    const completedActions = createBotWorkerActions({
      task: sandboxTask,
      phase: "terminal",
      status: TaskHistoryStatus.Completed,
      total_steps: 1,
      duration_ms: 10,
      sandbox_result: {
        log_ref: "sandbox/2026-04-26/msg-worker-sandbox-exp.jsonl",
        code_ref: "sandbox/2026-04-26/msg-worker-sandbox-exp.code.ts",
      },
    });
    const failedActions = createBotWorkerActions({
      task: sandboxTask,
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 2,
      duration_ms: 20,
      error: {
        name: "FacadeCallError",
        message: "failed with sk-local-dev password=hunter2",
        error_code: "path_not_found",
      },
      last_step: "goTo",
      sandbox_result: {
        log_ref: "sandbox/2026-04-26/msg-worker-sandbox-exp-failed.jsonl",
      },
    });
    const interruptedActions = createBotWorkerActions({
      task: sandboxTask,
      phase: "terminal",
      status: TaskHistoryStatus.Interrupted,
      total_steps: 1,
      duration_ms: 30,
      interrupt_source: {
        type: "control",
        command: "cancel",
      },
      reason: "owner requested cancel",
      sandbox_result: {
        log_ref: "sandbox/2026-04-26/msg-worker-sandbox-exp-interrupted.jsonl",
      },
    });
    const skillTerminalActions = createBotWorkerActions({
      task: skillTask,
      phase: "terminal",
      status: TaskHistoryStatus.Completed,
      total_steps: 1,
      duration_ms: 10,
    });
    const startedActions = createBotWorkerActions({
      task: sandboxTask,
      phase: "started",
    });
    const discardedActions = createBotWorkerActions({
      task: sandboxTask,
      phase: "discarded",
      discard_reason: "intent_epoch_stale",
      current_epoch: 4,
    });

    expect(completedActions.map((action) => action.type)).toEqual([
      "emit_task_lifecycle",
      "enqueue_brain",
      "persist_sandbox_experience",
    ]);
    expect(failedActions.at(-1)).toMatchObject({
      type: "persist_sandbox_experience",
      experience: {
        status: TaskHistoryStatus.Failed,
        error: {
          name: "FacadeCallError",
          error_code: "path_not_found",
        },
      },
    });
    expect(interruptedActions.at(-1)).toMatchObject({
      type: "persist_sandbox_experience",
      experience: {
        status: TaskHistoryStatus.Interrupted,
        error: {
          name: "AbortError",
          recoverable: false,
        },
      },
    });
    expect(JSON.stringify(failedActions.at(-1))).not.toContain("sk-local-dev");
    expect(JSON.stringify(failedActions.at(-1))).not.toContain("hunter2");
    expect(skillTerminalActions.map((action) => action.type)).toEqual([
      "emit_task_lifecycle",
      "enqueue_brain",
    ]);
    expect(startedActions.map((action) => action.type)).toEqual(["emit_task_lifecycle"]);
    expect(discardedActions.map((action) => action.type)).toEqual(["emit_task_lifecycle"]);
  });
});
