import { describe, expect, it } from "vitest";

import { ExecPriority, TaskHistoryStatus, createSkillCallJob } from "../index.js";
import { SKILL_DIRECTORY, createGoToSkillExecutionResult } from "../skills/index.js";
import { createBotWorkerRuntime } from "../workers/bot-worker.js";
import { createBotWorkerTask } from "../workers/contracts.js";

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
});
