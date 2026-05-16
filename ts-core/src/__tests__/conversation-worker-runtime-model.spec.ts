import { describe, expect, it, vi } from "vitest";
import { createCodeJobForSkill } from "./test-code-job.js";

import {
  createConversationCompositeTriage,
  createConversationRecentContextStore,
} from "../conversation/index.js";
import {
  ConversationLlmChatError,
  ConversationLlmPlanError,
  ConversationLlmSkillNotEnabledError,
} from "../conversation/llm.js";
import {
  BotStatus,
  ExecPriority,
  createBotActorStateProjection,
  createCodeJob,
  createRecoveryChainId,
  createTaskResultSummary,
} from "../core-ports/index.js";
import type { EnvironmentSnapshot, InventorySummary } from "../core-ports/observation.js";
import { TaskHistoryStatus } from "../core-ports/tasking.js";
import { createTaskSummaryDraft } from "../data/index.js";
import { createPostgresBrainMemoryStore } from "../db/index.js";
import { ConversationPriority } from "../domain/contracts.js";
import { createGoToSkillExecutionResult } from "../skills/index.js";
import { createBotWorkerRuntime } from "../workers/bot-worker.js";
import { createBrainWorkerRuntime } from "../workers/brain-worker.js";
import {
  createBotWorkerActions,
  createBotWorkerTask,
  createConversationWorkerTask,
} from "../workers/contracts.js";
import {
  createConversationBotWorkerActionSink,
  createConversationWorkerRuntime,
} from "../workers/conversation-worker.js";
import { createConversationWorkerMemoryContext } from "../workers/conversation-worker/helpers.js";
import {
  persistAcceptedTaskHistory,
  persistTaskHistoryLifecycleAction,
} from "../workers/task-history-sink.js";

function createCompositeChatTriage() {
  return createConversationCompositeTriage({
    chat: {},
  });
}

function createCompositeTaskTriage(input: {
  readonly priority: ConversationPriority;
  readonly reason: string;
  readonly needs_memory_search?: boolean;
}) {
  return createConversationCompositeTriage({
    action: {
      intent: "task",
      priority: input.priority,
      reason: input.reason,
      ...(input.needs_memory_search === undefined
        ? {}
        : { needs_memory_search: input.needs_memory_search }),
    },
  });
}

function createCompositeCancelTriage(reason: string) {
  return createConversationCompositeTriage({
    cancel: {
      priority: "interrupt",
      reason,
    },
  });
}

function createFakeBrainMemoryDb(input: {
  readonly memoryRows: Record<string, unknown>[];
  readonly candidateRows: Record<string, unknown>[];
  readonly auditRows: Record<string, unknown>[];
}) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => input.memoryRows,
        }),
      }),
    }),
    insert: () => ({
      values: (row: unknown) => {
        const record = row as Record<string, unknown>;

        if (typeof record.confidence === "number") {
          input.candidateRows.push(record);

          return Promise.resolve(undefined);
        }
        if (typeof record.op === "string") {
          input.auditRows.push(record);

          return Promise.resolve(undefined);
        }

        return {
          async onConflictDoUpdate() {
            const existingIndex = input.memoryRows.findIndex(
              (memoryRow) => memoryRow.botId === record.botId && memoryRow.kind === record.kind,
            );
            const normalizedRow = {
              ...record,
              updatedAt:
                record.updatedAt instanceof Date
                  ? record.updatedAt
                  : new Date(String(record.updatedAt)),
            };

            if (existingIndex < 0) {
              input.memoryRows.push(normalizedRow);
            } else {
              input.memoryRows[existingIndex] = normalizedRow;
            }
          },
        };
      },
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: async () => values,
      }),
    }),
  };
}

describe("ConversationWorker（对话工作线程） 真实运行时", () => {
  it("应由 conversation（对话） 侧 sink（汇点） 消费 sandbox finalize（沙盒终态） 并写入最近上下文", async () => {
    const store = createConversationRecentContextStore({ now: () => 10 });
    const sink = createConversationBotWorkerActionSink({ recentContextStore: store });
    const task = createBotWorkerTask({
      bot_id: "bot-cw",
      exec_job: createCodeJob({
        message_id: "msg-sandbox-failed",
        intent_epoch: 1,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        code: "await goTo(1, 64, 1)",
      }),
    });

    for (const action of createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 1,
      duration_ms: 1,
      error: {
        name: "Error",
        message: "path blocked\nwith stack details",
      },
      sandbox_result: {
        error: {
          name: "Error",
          message: "path blocked\nwith stack details",
        },
      },
    })) {
      await sink(action);
    }

    expect(store.getRounds()).toEqual([
      {
        aggregate_key: "message:msg-sandbox-failed",
        message_id: "msg-sandbox-failed",
        lines: ["报错：path blocked with stack details"],
      },
    ]);
  });

  it("应消费 chat（闲聊） 消息并通过 BotActor（机器人执行代理） sink（汇点） 广播回复", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const replyLogs: unknown[] = [];
    const injectedStateContexts: Array<string | undefined> = [];
    let projectionCalls = 0;
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        actorStateProjectionProvider: () => {
          projectionCalls += 1;

          return createBotActorStateProjection({
            status: BotStatus.EXECUTING,
            ready: false,
            world_ready: true,
            current_task: {
              kind: "code",
              message_id: "msg-mine",
            },
          });
        },
        replyGenerator: (input) => {
          injectedStateContexts.push(input.state_context);

          return {
            mode: "llm",
            reply: "我听到啦",
            diagnostics: {
              stage: "chat",
              model: "bl-auto",
              message_id: "msg-chat",
              log_ref: "llm/2026-04-24/chat-msg-chat.jsonl",
              created_at: "2026-04-24T10:00:00.000Z",
              ok: true,
              lines: [],
            },
          };
        },
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
        conversationReplyLogSink: async (record) => {
          replyLogs.push(record);
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-chat",
          content: "你好",
          intent_epoch: 1,
          snapshot_ts: 100,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-chat",
        content: "我听到啦喵~",
      },
    ]);
    expect(projectionCalls).toBe(1);
    expect(injectedStateContexts).toEqual([
      "当前状态：executing；ready：否；世界交互：已就绪；正在执行代码（消息 msg-mine）",
    ]);
    expect(replyLogs).toEqual([
      expect.objectContaining({
        bot_id: "bot-cw",
        message_id: "msg-chat",
        owner_message: "你好",
        route_kind: "chat_reply",
        reply_mode: "llm",
        reply: "我听到啦喵~",
        contexts: {
          state_context:
            "当前状态：executing；ready：否；世界交互：已就绪；正在执行代码（消息 msg-mine）",
        },
        llm_diagnostics: expect.objectContaining({
          stage: "chat",
          message_id: "msg-chat",
        }),
      }),
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "llm.chat.diagnostic",
      bot_id: "bot-cw",
      stage: "chat",
      message_id: "msg-chat",
      model: "bl-auto",
      log_ref: "llm/2026-04-24/chat-msg-chat.jsonl",
      created_at: "2026-04-24T10:00:00.000Z",
      ok: true,
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "chat.reply",
      bot_id: "bot-cw",
      message_id: "msg-chat",
      content: "我听到啦喵~",
    });
  });

  it("应由执行终态摘要把 code（技能调用） 失败胶囊写入最近上下文", async () => {
    const store = createConversationRecentContextStore({ now: () => 10 });
    const sink = createConversationBotWorkerActionSink({ recentContextStore: store });
    const task = createBotWorkerTask({
      bot_id: "bot-cw",
      owner_text: "挖 5 个石头",
      exec_job: createCodeJobForSkill({
        message_id: "msg-skill-failed-capsule",
        intent_epoch: 1,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        skill: "mine",
        params: { blockName: "stone", count: 5 },
      }),
    });

    for (const action of createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 0,
      duration_ms: 1,
      error: {
        name: "Error",
        message: "not_equipped:stone",
      },
      result_summary: createTaskResultSummary({
        task_type: task.exec_job.type,
        operation: "mine",
        target: "stone",
        requested_count: 5,
        completed_count: 0,
        failure: {
          failure_code: "not_equipped",
          failure_stage: "mine",
          message: "not_equipped:stone",
          recoverable: true,
          target_progress: {
            action: "mine",
            target: "stone",
            requested_count: 5,
            completed_count: 0,
          },
        },
      }),
    })) {
      await sink(action);
    }

    expect(store.getLatestFailureCapsule()).toMatchObject({
      goal: "mine stone x5",
      failed_action: "mine",
      failure_code: "not_equipped",
      retry_guard: '不要原样重复 mine("stone", 5)',
    });
    expect(store.getLatestFailureCapsuleInfo()).toMatchObject({
      message_id: "msg-skill-failed-capsule",
      recovery_chain_id: createRecoveryChainId({
        bot_id: "bot-cw",
        message_id: "msg-skill-failed-capsule",
      }),
      recovery_class: "recoverable",
      replan_count: 0,
    });
  });

  it("应由执行终态摘要把 code（沙箱代码） 失败胶囊写入最近上下文", async () => {
    const store = createConversationRecentContextStore({ now: () => 10 });
    const sink = createConversationBotWorkerActionSink({ recentContextStore: store });
    const task = createBotWorkerTask({
      bot_id: "bot-cw",
      owner_text: "去挖铁",
      exec_job: createCodeJob({
        message_id: "msg-sandbox-failed-capsule",
        intent_epoch: 1,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        code: 'await mine("iron_ore", 1)',
      }),
    });

    for (const action of createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 1,
      duration_ms: 1,
      error: {
        name: "Error",
        message: "resource_not_found:iron_ore",
      },
      result_summary: createTaskResultSummary({
        task_type: task.exec_job.type,
        operation: "mine",
        target: "iron_ore",
        requested_count: 1,
        completed_count: 0,
        failure: {
          failure_code: "resource_not_found",
          failure_stage: "mine",
          message: "resource_not_found:iron_ore",
          recoverable: true,
          target_progress: {
            action: "mine",
            target: "iron_ore",
            requested_count: 1,
            completed_count: 0,
          },
        },
      }),
    })) {
      await sink(action);
    }

    expect(store.render({ latestFailureCapsuleOnly: true })).toContain(
      '避免重复：不要原样重复 mine("iron_ore", 1)',
    );
    expect(store.getLatestFailureCapsule()).toMatchObject({
      failure_code: "resource_not_found",
      hint: "可尝试 deepslate_iron_ore 或汇报附近无矿",
    });
  });

  it("应在下一轮 chat（闲聊） prompt（提示词）构建期注入合并后的最近上下文", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const recentContexts: Array<string | undefined> = [];
    const store = createConversationRecentContextStore({ now: () => 0 });
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        recentContextStore: store,
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        actorStateProjectionProvider: () =>
          createBotActorStateProjection({
            status: BotStatus.IDLE,
            ready: true,
            world_ready: true,
            recent_events: [
              {
                message_id: "msg-1",
                line: "collect 成功,捡到 shield x1",
                timestamp: 30,
              },
            ],
          }),
        replyGenerator: (input) => {
          recentContexts.push(input.recent_context);

          return `第 ${recentContexts.length} 次回复`;
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    for (const message of [
      { id: "msg-1", content: "去捡盾牌" },
      { id: "msg-2", content: "你刚刚捡到了什么" },
    ]) {
      await processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: message.id,
            content: message.content,
            intent_epoch: 1,
            snapshot_ts: 100,
          },
        }),
      });
    }

    expect(recentContexts[0]).toBeUndefined();
    expect(recentContexts[1]).toContain("主人：去捡盾牌");
    expect(recentContexts[1]).toContain("Bot：第 1 次回复喵~");
    expect(recentContexts[1]).toContain("执行结果：collect 成功,捡到 shield x1");
    expect(recentContexts[1]).not.toContain("你刚刚捡到了什么");
  });

  it("失败后 continuation（继续任务） 应向 Plan（规划） 注入短 Failure Capsule（失败胶囊）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const recentContexts: Array<string | undefined> = [];
    const enqueuedExecTasks: unknown[] = [];
    const store = createConversationRecentContextStore({ now: () => 0 });
    store.appendOwnerMessage({ message_id: "msg-prev-failed", text: "去挖铁" });
    store.appendSandboxCode({
      message_id: "msg-prev-failed",
      code: 'await mine("iron_ore", 1); await report("done")',
    });
    store.appendFailureCapsule({
      message_id: "msg-prev-failed",
      capsule: {
        goal: "挖 iron_ore x1",
        failed_action: "mine",
        failure_code: "resource_not_found",
        progress: "raw_iron 0/1",
        retry_guard: '不要原样重复 mine("iron_ore", 1)',
        hint: "可尝试 deepslate_iron_ore 或汇报附近无矿",
      },
    });
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        recentContextStore: store,
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "continue_previous_failure",
          }),
        environmentSnapshotProvider: () => createEnvironmentSnapshotFixture([]),
        planner: (input) => {
          recentContexts.push(input.recent_context);

          return {
            code: 'await reply("我换深层铁矿试试喵~"); const deep = await mine("deepslate_iron_ore", 1); if (!deep.ok) { await report(`挖铁失败: ${deep.error.code}喵~`); throw new Error(deep.error.code); } await report("挖铁完成喵~");',
          };
        },
        enqueueExecTaskSink: async ({ task }) => {
          enqueuedExecTasks.push(task);
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-continue",
          content: "继续，想办法",
          intent_epoch: 2,
          snapshot_ts: 100,
        },
      }),
    });

    expect(recentContexts[0]).toContain("[上一轮失败]");
    expect(recentContexts[0]).toContain('避免重复：不要原样重复 mine("iron_ore", 1)');
    expect(recentContexts[0]).not.toContain("沙盒TS");
    expect(enqueuedExecTasks).toHaveLength(1);
    expect(
      (
        enqueuedExecTasks[0] as {
          readonly exec_job: {
            readonly recovery_chain_id?: string;
            readonly replan_count?: number;
          };
        }
      ).exec_job,
    ).toMatchObject({
      recovery_chain_id: createRecoveryChainId({
        bot_id: "bot-cw",
        message_id: "msg-prev-failed",
      }),
      replan_count: 1,
    });
  });

  it("continuation（继续任务） 失败后再次 continuation 应保持恢复链并递增重规划次数", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const enqueuedExecTasks: unknown[] = [];
    const store = createConversationRecentContextStore({ now: () => 0 });
    const sink = createConversationBotWorkerActionSink({ recentContextStore: store });
    const recoveryChainId = createRecoveryChainId({
      bot_id: "bot-cw",
      message_id: "msg-root-failed",
    });
    const failedContinuationTask = createBotWorkerTask({
      bot_id: "bot-cw",
      owner_text: "继续做，换个办法",
      exec_job: createCodeJob({
        message_id: "msg-continuation-failed",
        intent_epoch: 2,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        code: 'await collect("sample_target", 1)',
        recovery_chain_id: recoveryChainId,
        replan_count: 1,
      }),
    });

    for (const action of createBotWorkerActions({
      task: failedContinuationTask,
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 1,
      duration_ms: 1,
      error: {
        name: "Error",
        message: "not_equipped:sample_target",
      },
      result_summary: createTaskResultSummary({
        task_type: failedContinuationTask.exec_job.type,
        operation: "collect",
        target: "sample_target",
        requested_count: 1,
        completed_count: 0,
        failure: {
          failure_code: "not_equipped",
          failure_stage: "collect",
          message: "not_equipped:sample_target",
          recoverable: true,
          target_progress: {
            action: "collect",
            target: "sample_target",
            requested_count: 1,
            completed_count: 0,
          },
        },
      }),
    })) {
      await sink(action);
    }

    expect(store.getLatestFailureCapsuleInfo()).toMatchObject({
      message_id: "msg-continuation-failed",
      recovery_chain_id: recoveryChainId,
      recovery_class: "recoverable",
      replan_count: 1,
    });

    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        recentContextStore: store,
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "continue_after_failed_continuation",
          }),
        environmentSnapshotProvider: () => createEnvironmentSnapshotFixture([]),
        planner: () => ({
          code: 'await report("继续恢复中喵~");',
        }),
        enqueueExecTaskSink: async ({ task }) => {
          enqueuedExecTasks.push(task);
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-continuation-next",
          content: "继续做",
          intent_epoch: 3,
          snapshot_ts: 100,
        },
      }),
    });

    expect(enqueuedExecTasks).toHaveLength(1);
    expect(
      (
        enqueuedExecTasks[0] as {
          readonly exec_job: {
            readonly recovery_chain_id?: string;
            readonly replan_count?: number;
          };
        }
      ).exec_job,
    ).toMatchObject({
      recovery_chain_id: recoveryChainId,
      replan_count: 2,
    });
  });

  it("失败后全新任务不应启用 Failure Capsule only（仅失败胶囊） 渲染例外", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const recentContexts: Array<string | undefined> = [];
    const enqueuedExecTasks: unknown[] = [];
    const store = createConversationRecentContextStore({ now: () => 0 });
    store.appendOwnerMessage({ message_id: "msg-prev-failed-new-task", text: "去挖铁" });
    store.appendSandboxCode({
      message_id: "msg-prev-failed-new-task",
      code: 'await mine("iron_ore", 1); await report("done")',
    });
    store.appendSandboxError({
      message_id: "msg-prev-failed-new-task",
      text: "resource_not_found:iron_ore",
    });
    store.appendFailureCapsule({
      message_id: "msg-prev-failed-new-task",
      capsule: {
        goal: "挖 iron_ore x1",
        failed_action: "mine",
        failure_code: "resource_not_found",
        progress: "raw_iron 0/1",
        retry_guard: '不要原样重复 mine("iron_ore", 1)',
        hint: "可尝试 deepslate_iron_ore 或汇报附近无矿",
      },
    });
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        recentContextStore: store,
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "new_cut_tree_task",
          }),
        environmentSnapshotProvider: () => createEnvironmentSnapshotFixture([]),
        planner: (input) => {
          recentContexts.push(input.recent_context);

          return {
            code: 'await reply("我去砍木头喵~"); await cutTree(5); await report("砍木头完成喵~");',
          };
        },
        enqueueExecTaskSink: async ({ task }) => {
          enqueuedExecTasks.push(task);
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-new-task-after-failure",
          content: "砍 5 个木头",
          intent_epoch: 2,
          snapshot_ts: 100,
        },
      }),
    });

    expect(recentContexts[0]).toContain("主人：去挖铁");
    expect(recentContexts[0]).toContain("沙盒TS：");
    expect(recentContexts[0]).toContain('await mine("iron_ore", 1)');
    expect(recentContexts[0]).toContain("报错：resource_not_found:iron_ore");
    expect(enqueuedExecTasks).toHaveLength(1);
  });

  it("实现阻塞失败后的 continuation（继续任务） 应直接汇报阻塞，不再进入 Plan（规划）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: string[] = [];
    const store = createConversationRecentContextStore({ now: () => 0 });
    store.appendFailureCapsule({
      message_id: "msg-runtime-blocked",
      capsule: {
        goal: "挖 iron_ore x1",
        failed_action: "mine",
        failure_code: "runtime_adapter_error",
        progress: "raw_iron 0/1",
        retry_guard: '不要原样重复 mine("iron_ore", 1)',
        hint: "运行时适配异常，需要查看诊断日志",
      },
    });
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        recentContextStore: store,
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "continue_previous_failure",
          }),
        planner: () => {
          throw new Error("planner must not run for implementation blocker");
        },
        broadcastReplySink: async ({ content }) => {
          replies.push(content);
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-continue-blocked",
          content: "继续",
          intent_epoch: 2,
          snapshot_ts: 100,
        },
      }),
    });

    expect(replies[0]).toContain("runtime_adapter_error");
    expect(replies[0]).toContain("已停止");
  });

  it("continuation（继续任务） 不得原样重复 retry_guard（重复保护） 中的 code（技能调用）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: string[] = [];
    const enqueuedExecTasks: unknown[] = [];
    const metrics: unknown[] = [];
    const store = createConversationRecentContextStore({ now: () => 0 });
    store.appendFailureCapsule({
      message_id: "msg-repeat-failed",
      capsule: {
        goal: "挖 stone x5",
        failed_action: "mine",
        failure_code: "not_equipped",
        progress: "stone 0/5",
        retry_guard: '不要原样重复 mine("stone", 5)',
        hint: "先调用 equip 或 ensure 工具链准备所需工具",
      },
    });
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        recentContextStore: store,
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "continue_previous_failure",
          }),
        environmentSnapshotProvider: () => createEnvironmentSnapshotFixture([]),
        planner: () => ({
          // legacy（旧兼容） negative fixture（反例夹具）：用于确认 retry_guard 不会放行旧裸调用。
          code: 'await reply("我继续挖石头喵~"); await mine("stone", 5); await report("挖石头完成喵~");',
        }),
        enqueueExecTaskSink: async ({ task }) => {
          enqueuedExecTasks.push(task);
        },
        broadcastReplySink: async ({ content }) => {
          replies.push(content);
        },
        productionMetricSink: async (line) => {
          metrics.push(line);
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-repeat-continue",
          content: "再试试",
          intent_epoch: 2,
          snapshot_ts: 100,
        },
      }),
    });

    expect(enqueuedExecTasks).toHaveLength(0);
    expect(replies.at(-1)).toContain('不要原样重复 mine("stone", 5)');
    expect(metrics.at(-1)).toMatchObject({
      event_type: "conversation.plan_discarded",
      error_code: "retry_guard_repeated",
      recovery_chain_id: createRecoveryChainId({
        bot_id: "bot-cw",
        message_id: "msg-repeat-failed",
      }),
      recovery_class: "recoverable",
      replan_count: 1,
    });
  });

  it("生产指标写入失败只能作为旁路 fallback，不能阻断已规划任务入队", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const enqueuedExecTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "unit_metric_side_effect_failure",
          }),
        planner: () => ({
          code: 'const task = await runGoal("测试", async () => {}); await report(task);',
        }),
        enqueueExecTaskSink: async ({ task }) => {
          enqueuedExecTasks.push(task);
        },
        broadcastReplySink: async () => undefined,
        productionMetricSink: async () => {
          throw new Error("metric disk unavailable");
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-metric-side-effect-failed",
          content: "去测试",
          intent_epoch: 2,
          snapshot_ts: 100,
        },
      }),
    });

    expect(enqueuedExecTasks).toHaveLength(1);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-cw",
      message_id: "msg-metric-side-effect-failed",
      exec_type: "code",
      priority: "normal",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[conversation-worker] production metric sink failed",
      expect.objectContaining({
        event_type: "conversation.plan_accepted",
        error_summary: "metric disk unavailable",
      }),
    );
    warnSpy.mockRestore();
  });

  it("prompt（提示词） 最近上下文窗口应限制为最近 5 轮原文", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const recentContexts: Array<string | undefined> = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        replyGenerator: (input) => {
          recentContexts.push(input.recent_context);

          return "收到";
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    for (let index = 1; index <= 7; index += 1) {
      await processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: `msg-window-${index}`,
            content: `第 ${index} 轮`,
            intent_epoch: index,
            snapshot_ts: 100 + index,
          },
        }),
      });
    }

    const lastPromptContext = recentContexts.at(-1);
    expect(lastPromptContext).not.toContain("第 1 轮");
    expect(lastPromptContext).toContain("第 2 轮");
    expect(lastPromptContext).toContain("第 6 轮");
    expect(lastPromptContext).not.toContain("第 7 轮");
  });

  it("应让 Chat（闲聊） 约定地点进入 Brain（大脑）并让后续 Plan（规划）使用约定时坐标", async () => {
    let conversationProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let brainProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const memoryRows: Record<string, unknown>[] = [];
    const candidateRows: Record<string, unknown>[] = [];
    const auditRows: Record<string, unknown>[] = [];
    const brainMemoryStore = createPostgresBrainMemoryStore({
      db: createFakeBrainMemoryDb({ memoryRows, candidateRows, auditRows }),
    });
    const rubricInputs: unknown[] = [];
    const enqueuedExecTasks: unknown[] = [];
    const snapshots = [
      createEnvironmentSnapshotFixture([], { x: -24.8, y: 105, z: -15.6 }),
      createEnvironmentSnapshotFixture([], { x: 88, y: 70, z: 99 }),
    ];
    const brainRuntime = createBrainWorkerRuntime({
      queue: {
        name: "brain",
        connection: {},
      },
      dependencies: {
        now: () => new Date("2026-05-03T02:00:00.000Z"),
        async generateEmbedding() {
          throw new Error("chat fact should not write task_events");
        },
        async persistTaskEvent() {
          throw new Error("chat fact should not persist task_events");
        },
        llm: {
          model: "bl-auto",
          async generateFailureTakeaway() {
            throw new Error("failure takeaway should not run");
          },
          async generateSessionTakeaway() {
            throw new Error("session takeaway should not run");
          },
          async compressRollingSummary(content) {
            return content;
          },
          async generateMemoryCandidates(input) {
            rubricInputs.push(input);
            if (input.owner_text !== "这里以后就是秘密基地") {
              return [];
            }

            return [
              {
                kind: "MEMORY",
                content: `秘密基地坐标：x=${input.owner_position?.x}, y=${input.owner_position?.y}, z=${input.owner_position?.z}`,
                confidence: 0.95,
                reason: "主人命名当前位置",
              },
            ];
          },
          async resolveMemoryCapacity() {
            throw new Error("capacity should not run");
          },
        },
        loadBotMemory: brainMemoryStore.loadBotMemory,
        insertMemoryCandidate: brainMemoryStore.insertMemoryCandidate,
        decideMemoryCandidate: brainMemoryStore.decideMemoryCandidate,
        writeBotMemory: brainMemoryStore.writeBotMemory,
        appendMemoryAudit: brainMemoryStore.appendMemoryAudit,
        createWorker: ({ processor }) => {
          brainProcessor = processor;

          return {
            close: async () => undefined,
          };
        },
      },
    });
    const conversationRuntime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor }) => {
          conversationProcessor = processor;

          return {
            close: async () => undefined,
          };
        },
        triage: ({ task }) =>
          task.message.content === "去秘密基地"
            ? createCompositeTaskTriage({
                priority: ConversationPriority.Normal,
                reason: "owner_target_secret_base",
              })
            : createCompositeChatTriage(),
        environmentSnapshotProvider: () =>
          snapshots.shift() ?? createEnvironmentSnapshotFixture([]),
        brainContextProvider: () => ({
          memory: {
            USER: "",
            MEMORY: typeof memoryRows[0]?.content === "string" ? String(memoryRows[0].content) : "",
            SKILL: "",
          },
        }),
        replyGenerator: () => "我记住了",
        planner: (input) => {
          expect(input.brain_context).toContain("秘密基地坐标：x=-24.8, y=105, z=-15.6");
          expect(input.brain_context).not.toContain("x=88");

          return {
            code: 'await reply("我去秘密基地喵~"); await goTo(-24.8,105,-15.6); await report("已到达秘密基地喵~");',
          };
        },
        enqueueBrainFactSink: async ({ task }) => {
          await brainProcessor?.({ data: task });
        },
        enqueueExecTaskSink: async ({ task }) => {
          enqueuedExecTasks.push(task);
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await brainRuntime.start();
    await conversationRuntime.start();
    await conversationProcessor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-secret-base-chat",
          content: "这里以后就是秘密基地",
          intent_epoch: 1,
          snapshot_ts: 100,
        },
      }),
    });
    await conversationProcessor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-go-secret-base",
          content: "去秘密基地",
          intent_epoch: 2,
          snapshot_ts: 101,
        },
      }),
    });

    expect(candidateRows).toHaveLength(1);
    expect(candidateRows[0]).toEqual(
      expect.objectContaining({
        id: "memory-candidate:conversation-fact:bot-cw:msg-secret-base-chat:0",
        botId: "bot-cw",
        kind: "MEMORY",
        content: "秘密基地坐标：x=-24.8, y=105, z=-15.6",
        confidence: 0.95,
        status: "pending",
      }),
    );
    expect(memoryRows).toHaveLength(1);
    expect(memoryRows[0]).toEqual(
      expect.objectContaining({
        botId: "bot-cw",
        kind: "MEMORY",
        content: "秘密基地坐标：x=-24.8, y=105, z=-15.6",
      }),
    );
    expect(rubricInputs).toEqual([
      expect.objectContaining({
        source: "conversation_fact",
        owner_text: "这里以后就是秘密基地",
        route_kind: "chat_reply",
        owner_position: { x: -24.8, y: 105, z: -15.6 },
      }),
      expect.objectContaining({
        source: "conversation_fact",
        owner_text: "去秘密基地",
        route_kind: "plan_exec",
        owner_position: { x: 88, y: 70, z: 99 },
      }),
    ]);
    expect(enqueuedExecTasks).toEqual([
      expect.objectContaining({
        owner_text: "去秘密基地",
        owner_position_at_message: { x: 88, y: 70, z: 99 },
        exec_job: expect.objectContaining({
          type: "code",
          code: expect.stringContaining("goTo(-24.8,105,-15.6)"),
        }),
      }),
    ]);

    await conversationRuntime.close();
    await brainRuntime.close();
  });

  it("Brain fact（大脑事实）入队失败不得截断 Chat（闲聊）回复日志", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const replyLogs: unknown[] = [];
    const brainDiagnostics: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        replyGenerator: () => "我记住了",
        environmentSnapshotProvider: () => createEnvironmentSnapshotFixture([]),
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
        conversationReplyLogSink: async (entry) => {
          replyLogs.push(entry);
        },
        enqueueBrainFactSink: async () => {
          throw new Error("brain queue unavailable");
        },
        brainDiagnosticSink: async (record) => {
          brainDiagnostics.push(record);
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-chat-fact-fail",
          content: "这里定义为日月川了",
          intent_epoch: 1,
          snapshot_ts: 100,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-chat-fact-fail",
        content: "我记住了喵~",
      },
    ]);
    expect(replyLogs).toEqual([
      expect.objectContaining({
        message_id: "msg-chat-fact-fail",
        reply: "我记住了喵~",
      }),
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "brain.fact.enqueue_failed",
      bot_id: "bot-cw",
      message_id: "msg-chat-fact-fail",
      route_kind: "chat_reply",
      error_summary: "brain queue unavailable",
    });
    expect(brainDiagnostics).toEqual([
      expect.objectContaining({
        log_ref: expect.stringMatching(
          /^brain\/\d{4}-\d{2}-\d{2}\/fact-enqueue-failed-msg-chat-fact-fail\.jsonl$/u,
        ),
        lines: [
          expect.objectContaining({
            event: "brain.fact.enqueue_failed",
            bot_id: "bot-cw",
            message_id: "msg-chat-fact-fail",
            route_kind: "chat_reply",
            error: {
              name: "Error",
              message: "brain queue unavailable",
            },
          }),
        ],
      }),
    ]);

    await runtime.close();
  });

  it("Brain fact（大脑事实）入队失败不得阻塞 Plan（规划）执行任务入队", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const enqueuedExecTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "owner_target_named_place",
          }),
        environmentSnapshotProvider: () => createEnvironmentSnapshotFixture([]),
        planner: () => ({
          code: 'await reply("我去日月川喵~"); await goTo(10,64,20); await report("已到达日月川喵~");',
        }),
        enqueueExecTaskSink: async ({ task }) => {
          enqueuedExecTasks.push(task);
        },
        enqueueBrainFactSink: async () => {
          throw new Error("brain queue unavailable");
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-plan-fact-fail",
          content: "去登上日月川",
          intent_epoch: 2,
          snapshot_ts: 101,
        },
      }),
    });

    expect(enqueuedExecTasks).toEqual([
      expect.objectContaining({
        exec_job: expect.objectContaining({
          message_id: "msg-plan-fact-fail",
          type: "code",
          code: expect.stringContaining("goTo(10,64,20)"),
        }),
      }),
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-cw",
      message_id: "msg-plan-fact-fail",
      exec_type: "code",
      priority: "normal",
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "brain.fact.enqueue_failed",
      bot_id: "bot-cw",
      message_id: "msg-plan-fact-fail",
      route_kind: "plan_exec",
      error_summary: "brain queue unavailable",
    });

    await runtime.close();
  });

  it("Brain fact（大脑事实）与诊断汇点双失败也不得截断 Chat（闲聊）主路径", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const replyLogs: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        replyGenerator: () => "我记住了",
        environmentSnapshotProvider: () => createEnvironmentSnapshotFixture([]),
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
        conversationReplyLogSink: async (entry) => {
          replyLogs.push(entry);
        },
        enqueueBrainFactSink: async () => {
          throw new Error("brain queue unavailable");
        },
        brainDiagnosticSink: async () => {
          throw new Error("brain diagnostic unavailable");
        },
      },
    });

    await runtime.start();
    expect(processor).toBeDefined();
    await expect(
      processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: "msg-chat-fact-diagnostic-fail",
            content: "这里定义为日月川了",
            intent_epoch: 1,
            snapshot_ts: 100,
          },
        }),
      }),
    ).resolves.toBeUndefined();

    expect(replies).toEqual([
      {
        message_id: "msg-chat-fact-diagnostic-fail",
        content: "我记住了喵~",
      },
    ]);
    expect(replyLogs).toEqual([
      expect.objectContaining({
        message_id: "msg-chat-fact-diagnostic-fail",
        reply: "我记住了喵~",
      }),
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "brain.fact.enqueue_failed",
      bot_id: "bot-cw",
      message_id: "msg-chat-fact-diagnostic-fail",
      route_kind: "chat_reply",
      error_summary: "brain queue unavailable",
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "brain.fact.diagnostic_failed",
      bot_id: "bot-cw",
      message_id: "msg-chat-fact-diagnostic-fail",
      route_kind: "chat_reply",
      enqueue_error_summary: "brain queue unavailable",
      diagnostic_error_summary: "brain diagnostic unavailable",
    });

    await runtime.close();
  });

  it("Brain fact（大脑事实）与诊断汇点双失败也不得阻塞 Plan（规划）执行入队", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const enqueuedExecTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "owner_target_named_place",
          }),
        environmentSnapshotProvider: () => createEnvironmentSnapshotFixture([]),
        planner: () => ({
          code: 'await reply("我去日月川喵~"); await goTo(10,64,20); await report("已到日月川喵~");',
        }),
        enqueueExecTaskSink: async ({ task }) => {
          enqueuedExecTasks.push(task);
        },
        enqueueBrainFactSink: async () => {
          throw new Error("brain queue unavailable");
        },
        brainDiagnosticSink: async () => {
          throw new Error("brain diagnostic unavailable");
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    expect(processor).toBeDefined();
    await expect(
      processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: "msg-plan-fact-diagnostic-fail",
            content: "去登上日月川",
            intent_epoch: 2,
            snapshot_ts: 101,
          },
        }),
      }),
    ).resolves.toBeUndefined();

    expect(enqueuedExecTasks).toEqual([
      expect.objectContaining({
        exec_job: expect.objectContaining({
          message_id: "msg-plan-fact-diagnostic-fail",
          type: "code",
          code: expect.stringContaining("goTo(10,64,20)"),
        }),
      }),
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-cw",
      message_id: "msg-plan-fact-diagnostic-fail",
      exec_type: "code",
      priority: "normal",
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "brain.fact.enqueue_failed",
      bot_id: "bot-cw",
      message_id: "msg-plan-fact-diagnostic-fail",
      route_kind: "plan_exec",
      error_summary: "brain queue unavailable",
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "brain.fact.diagnostic_failed",
      bot_id: "bot-cw",
      message_id: "msg-plan-fact-diagnostic-fail",
      route_kind: "plan_exec",
      enqueue_error_summary: "brain queue unavailable",
      diagnostic_error_summary: "brain diagnostic unavailable",
    });

    await runtime.close();
  });

  it("应串起 ConversationWorker / BotWorker / BrainWorker（三工作线程）并写入 task_history 与 task_events", async () => {
    let conversationProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let botProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let brainProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const memoryRows: Record<string, unknown>[] = [];
    const candidateRows: Record<string, unknown>[] = [];
    const auditRows: Record<string, unknown>[] = [];
    const taskHistoryRows: Record<string, unknown>[] = [];
    const taskHistoryUpdates: Record<string, unknown>[] = [];
    const taskEventRows: Record<string, unknown>[] = [];
    const snapshots = [
      createEnvironmentSnapshotFixture([], { x: 10, y: 64, z: 20 }),
      createEnvironmentSnapshotFixture([], { x: 80, y: 64, z: 80 }),
    ];
    const taskHistoryStore = {
      async insertAccepted(record: Record<string, unknown>) {
        taskHistoryRows.push({ ...record });
      },
      async markStarted(patch: Record<string, unknown>) {
        taskHistoryUpdates.push({ ...patch });
        const row = taskHistoryRows.find((candidate) => candidate.id === patch.id);
        if (row !== undefined) {
          row.status = TaskHistoryStatus.Started;
        }
      },
      async markTerminal(patch: Record<string, unknown>) {
        taskHistoryUpdates.push({ ...patch });
        const row = taskHistoryRows.find((candidate) => candidate.id === patch.id);
        if (row !== undefined) {
          row.status = patch.status;
        }
      },
      async markDiscarded(input: { readonly id: string; readonly discarded_at: string }) {
        taskHistoryUpdates.push({ ...input, status: TaskHistoryStatus.Discarded });
        const row = taskHistoryRows.find((candidate) => candidate.id === input.id);
        if (row !== undefined) {
          row.status = TaskHistoryStatus.Discarded;
        }
      },
    };
    const brainMemoryStore = createPostgresBrainMemoryStore({
      db: createFakeBrainMemoryDb({ memoryRows, candidateRows, auditRows }),
    });
    const brainRuntime = createBrainWorkerRuntime({
      queue: {
        name: "brain",
        connection: {},
      },
      dependencies: {
        now: () => new Date("2026-05-04T01:00:00.000Z"),
        async generateEmbedding() {
          return [0.1, 0.2, 0.3];
        },
        async persistTaskEvent(draft) {
          expect(taskHistoryRows.some((row) => row.id === draft.task_id)).toBe(true);
          taskEventRows.push({ ...draft });
        },
        llm: {
          model: "bl-auto",
          async generateFailureTakeaway() {
            throw new Error("failure takeaway should not run");
          },
          async generateSessionTakeaway() {
            throw new Error("session takeaway should not run");
          },
          async compressRollingSummary(content) {
            return content;
          },
          async generateMemoryCandidates(input) {
            if (input.owner_text !== "这里定义为日月川了") {
              return [];
            }

            return [
              {
                kind: "MEMORY",
                content: `日月川坐标：x=${input.owner_position?.x}, y=${input.owner_position?.y}, z=${input.owner_position?.z}`,
                confidence: 0.95,
                reason: "主人命名当前位置",
              },
            ];
          },
          async resolveMemoryCapacity() {
            throw new Error("capacity should not run");
          },
        },
        loadBotMemory: brainMemoryStore.loadBotMemory,
        insertMemoryCandidate: brainMemoryStore.insertMemoryCandidate,
        decideMemoryCandidate: brainMemoryStore.decideMemoryCandidate,
        writeBotMemory: brainMemoryStore.writeBotMemory,
        appendMemoryAudit: brainMemoryStore.appendMemoryAudit,
        createWorker: ({ processor }) => {
          brainProcessor = processor;

          return {
            close: async () => undefined,
          };
        },
      },
    });
    const botRuntime = createBotWorkerRuntime({
      queue: {
        name: "bot:bot-cw:exec",
        connection: {},
      },
      dependencies: {
        actor: {
          async executeCode(job) {
            return {
              result: {
                status: TaskHistoryStatus.Completed,
                job_id: job.message_id,
                bot_id: "bot-cw",
                intent_epoch: job.intent_epoch,
                log_ref: "sandbox/2026-05-04/msg-sandbox.jsonl",
                phase_logs: [],
                step_results: [
                  {
                    action: "report",
                    status: "ok",
                    params: {
                      goal_result: {
                        kind: "goal_result",
                        ok: true,
                        name: "goTo",
                        duration_ms: 42,
                        summary: {
                          target: "日月川",
                          completed_count: 1,
                        },
                      },
                    },
                    result: {
                      goal_result: {
                        kind: "goal_result",
                        ok: true,
                        name: "goTo",
                        duration_ms: 42,
                        summary: {
                          target: "日月川",
                          completed_count: 1,
                        },
                      },
                    },
                  },
                ],
                summary: {
                  terminal_status: TaskHistoryStatus.Completed,
                  total_steps: 1,
                  duration_ms: 42,
                },
              },
              snapshot: {} as never,
            };
          },
        },
        now: (() => {
          const values = [1000, 1042];

          return () => values.shift() ?? 1042;
        })(),
        actionSink: async (action) => {
          await persistTaskHistoryLifecycleAction({
            action,
            taskHistoryStore,
            now: () => new Date("2026-05-04T01:00:01.000Z"),
          });
          if (action.type === "enqueue_brain") {
            await brainProcessor?.({ data: action.task });
          }
        },
        createWorker: ({ processor }) => {
          botProcessor = processor;

          return {
            close: async () => undefined,
          };
        },
      },
    });
    const conversationRuntime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor }) => {
          conversationProcessor = processor;

          return {
            close: async () => undefined,
          };
        },
        triage: ({ task }) =>
          task.message.content === "去登上日月川"
            ? createCompositeTaskTriage({
                priority: ConversationPriority.Normal,
                reason: "owner_target_named_place",
              })
            : createCompositeChatTriage(),
        environmentSnapshotProvider: () =>
          snapshots.shift() ?? createEnvironmentSnapshotFixture([]),
        brainContextProvider: () => ({
          memory: {
            USER: "",
            MEMORY: typeof memoryRows[0]?.content === "string" ? String(memoryRows[0].content) : "",
            SKILL: "",
          },
        }),
        replyGenerator: () => "我记住了",
        planner: (input) => {
          expect(input.brain_context).toContain("日月川坐标：x=10, y=64, z=20");

          return {
            code: 'await reply("我去日月川喵~"); await goTo(10,64,20); await report("已到日月川喵~");',
          };
        },
        enqueueBrainFactSink: async ({ task }) => {
          await brainProcessor?.({ data: task });
        },
        enqueueExecTaskSink: async ({ task }) => {
          await persistAcceptedTaskHistory({
            bot_id: task.bot_id,
            task,
            taskHistoryStore,
            now: () => new Date("2026-05-04T01:00:00.000Z"),
          });
          await botProcessor?.({ data: task });
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await brainRuntime.start();
    await botRuntime.start();
    await conversationRuntime.start();
    await conversationProcessor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-sun-moon-river",
          content: "这里定义为日月川了",
          intent_epoch: 1,
          snapshot_ts: 100,
        },
      }),
    });
    await conversationProcessor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-go-sun-moon-river",
          content: "去登上日月川",
          intent_epoch: 2,
          snapshot_ts: 101,
        },
      }),
    });

    expect(memoryRows).toEqual([
      expect.objectContaining({
        kind: "MEMORY",
        content: "日月川坐标：x=10, y=64, z=20",
      }),
    ]);
    expect(taskHistoryRows).toEqual([
      expect.objectContaining({
        id: "msg-go-sun-moon-river",
        status: TaskHistoryStatus.Completed,
      }),
    ]);
    expect(taskHistoryUpdates).toEqual([
      expect.objectContaining({
        id: "msg-go-sun-moon-river",
        status: TaskHistoryStatus.Started,
      }),
      expect.objectContaining({
        id: "msg-go-sun-moon-river",
        status: TaskHistoryStatus.Completed,
      }),
    ]);
    expect(taskEventRows).toEqual([
      expect.objectContaining({
        task_id: "msg-go-sun-moon-river",
        owner_text: "去登上日月川",
        embedding: [0.1, 0.2, 0.3],
      }),
    ]);

    await conversationRuntime.close();
    await botRuntime.close();
    await brainRuntime.close();
  });

  it("Plan（规划） cannot_plan（无法规划） 时应统一失败，不再改写成对话事实", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const brainFacts: unknown[] = [];
    const enqueuedExecTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "LLM 误把地点记忆当任务",
          }),
        environmentSnapshotProvider: () =>
          createEnvironmentSnapshotFixture([], { x: 7.7, y: 118, z: -35.6 }),
        planner: () => {
          throw new ConversationLlmPlanError("conversation_fact");
        },
        enqueueBrainFactSink: async ({ task }) => {
          brainFacts.push(task);
        },
        enqueueExecTaskSink: async ({ task }) => {
          enqueuedExecTasks.push(task);
        },
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-canyon-top",
          content: "记住这里为峡谷之巅",
          intent_epoch: 12,
          snapshot_ts: 300,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-canyon-top",
        content: "抱歉，这次我还没能规划出可执行的技能任务喵~",
      },
    ]);
    expect(enqueuedExecTasks).toEqual([]);
    expect(brainFacts).toEqual([]);
    expect(runtime.getEvents()).toContainEqual({
      type: "chat.reply",
      bot_id: "bot-cw",
      message_id: "msg-canyon-top",
      content: "抱歉，这次我还没能规划出可执行的技能任务喵~",
    });
    expect(runtime.getEvents().some((event) => event.type === "task.accepted")).toBe(false);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.discarded",
      bot_id: "bot-cw",
      message_id: "msg-canyon-top",
      status: TaskHistoryStatus.Discarded,
      reason: "planner_failed",
    });
  });

  it("应让 Chat / Plan / Plan（三路） 按路径出口顺序递推 inventory diff（背包差异） baseline（基线）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const inventoryChanges: Array<string | undefined> = [];
    const snapshotContexts: string[] = [];
    const triages = [
      createCompositeChatTriage(),
      createCompositeTaskTriage({
        priority: ConversationPriority.Normal,
        reason: "unit_plan_inventory",
      }),
      createCompositeTaskTriage({
        priority: ConversationPriority.Urgent,
        reason: "unit_replace_inventory",
      }),
    ];
    const snapshots = [
      createEnvironmentSnapshotFixture([["oak_log", 1]]),
      createEnvironmentSnapshotFixture([
        ["oak_log", 6],
        ["cobblestone", 4],
      ]),
      createEnvironmentSnapshotFixture([
        ["oak_log", 4],
        ["cobblestone", 4],
        ["iron_ingot", 2],
      ]),
    ];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => triages.shift() ?? createCompositeChatTriage(),
        environmentSnapshotProvider: () => {
          const snapshot = snapshots.shift();

          if (snapshot === undefined) {
            throw new Error("unexpected snapshot read");
          }

          return snapshot;
        },
        replyGenerator: (input) => {
          inventoryChanges.push(input.inventory_change_context);
          if (input.snapshot_context !== undefined) {
            snapshotContexts.push(input.snapshot_context);
          }

          return "看到背包了";
        },
        planner: (input) => {
          inventoryChanges.push(input.inventory_change_context);
          if (input.snapshot_context !== undefined) {
            snapshotContexts.push(input.snapshot_context);
          }

          return {
            code: 'await reply("收到，我去执行喵~"); await goTo(1,64,-3); await report("已执行喵~");',
          };
        },
        interruptRuntimeSink: async () => undefined,
        broadcastReplySink: async () => undefined,
        enqueueExecTaskSink: async () => undefined,
      },
    });

    await runtime.start();
    for (const message of [
      { id: "msg-inventory-chat", content: "现在背包如何" },
      { id: "msg-inventory-plan", content: "去坐标 1 64 -3" },
      { id: "msg-inventory-replace", content: "改成快点过去" },
    ]) {
      await processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: message.id,
            content: message.content,
            intent_epoch: 1,
            snapshot_ts: 100,
          },
        }),
      });
    }

    expect(inventoryChanges).toEqual([
      undefined,
      "oak_log+5, cobblestone+4",
      "oak_log-2, iron_ingot+2",
    ]);
    expect(snapshotContexts[0]).not.toContain("[背包变化]");
    expect(snapshotContexts[1]).toContain("[背包变化] oak_log+5, cobblestone+4");
    expect(snapshotContexts[2]).toContain("[背包变化] oak_log-2, iron_ingot+2");
  });

  it("Cancel（取消） 路径不应读写 inventory diff cache（背包差异缓存）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let snapshotReads = 0;
    const inventoryChanges: Array<string | undefined> = [];
    const triages = [
      createCompositeCancelTriage("unit_cancel_inventory"),
      createCompositeChatTriage(),
    ];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => triages.shift() ?? createCompositeChatTriage(),
        environmentSnapshotProvider: () => {
          snapshotReads += 1;

          return createEnvironmentSnapshotFixture([["oak_log", 5]]);
        },
        replyGenerator: (input) => {
          inventoryChanges.push(input.inventory_change_context);

          return "取消后闲聊";
        },
        interruptRuntimeSink: async () => undefined,
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    for (const message of [
      { id: "msg-inventory-cancel", content: "停下" },
      { id: "msg-inventory-chat-after-cancel", content: "背包变化了吗" },
    ]) {
      await processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: message.id,
            content: message.content,
            intent_epoch: 1,
            snapshot_ts: 100,
          },
        }),
      });
    }

    expect(snapshotReads).toBe(1);
    expect(inventoryChanges).toEqual([undefined]);
  });

  it("应在状态投影读取失败时降级为无状态闲聊", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const stateContexts: Array<string | undefined> = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        actorStateProjectionProvider: () => {
          throw new Error("projection source unavailable");
        },
        replyGenerator: (input) => {
          stateContexts.push(input.state_context);

          return "无状态回复";
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-chat-projection-failed",
          content: "你在干嘛",
          intent_epoch: 1,
          snapshot_ts: 100,
        },
      }),
    });

    expect(stateContexts).toEqual([undefined]);
    expect(runtime.getEvents()).toContainEqual({
      type: "conversation.context_provider_failed",
      bot_id: "bot-cw",
      message_id: "msg-chat-projection-failed",
      route_kind: "chat_reply",
      provider: "actor_state",
      error_summary: "projection source unavailable",
    });
  });

  it("应只在 chat（闲聊） 路由需要 memory（记忆） 时读取并注入 memory_context（记忆上下文）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const memoryCalls: unknown[] = [];
    const memoryContexts: Array<string | undefined> = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        memoryContextProvider: (input) => {
          memoryCalls.push(input);

          return createConversationWorkerMemoryContext({
            results: [
              {
                summary: createTaskSummaryDraft({
                  task_id: "msg-memory-older",
                  bot_id: "bot-cw",
                  message_id: "msg-memory-older",
                  intent: "旧矿洞探索",
                  status: TaskHistoryStatus.Completed,
                  summary: "主人上次让 Bot 标记了矿洞入口。",
                  created_at: "2026-04-25T00:00:00.000Z",
                }),
                score: 0.4,
              },
              {
                summary: createTaskSummaryDraft({
                  task_id: "msg-memory-newer",
                  bot_id: "bot-cw",
                  message_id: "msg-memory-newer",
                  intent: "矿洞返回",
                  status: TaskHistoryStatus.Interrupted,
                  summary: "Bot 因取消指令中断返回。",
                  created_at: "2026-04-26T00:00:00.000Z",
                }),
                score: 0.9,
              },
            ],
            limit: 1,
            char_budget: 120,
          });
        },
        replyGenerator: (input) => {
          memoryContexts.push(input.memory_context);

          return "记得";
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-chat-memory",
          content: "你还记得上次的矿洞吗",
          intent_epoch: 9,
          snapshot_ts: 108,
        },
      }),
    });
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-chat-no-memory",
          content: "今天你好呀",
          intent_epoch: 10,
          snapshot_ts: 109,
        },
      }),
    });

    expect(memoryCalls).toEqual([
      expect.objectContaining({
        bot_id: "bot-cw",
        message_id: "msg-chat-memory",
        intent_epoch: 9,
        message_content: "你还记得上次的矿洞吗",
        route_kind: "chat_reply",
        query_reason: "composite_chat",
        limit: 5,
        char_budget: 800,
      }),
    ]);
    expect(memoryContexts).toEqual(["[interrupted] 矿洞返回: Bot 因取消指令中断返回。", undefined]);
  });

  it("应只记录 cancel（取消） 路径，不写入 Mineflayer（Minecraft 协议客户端） 聊天", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const interrupts: Array<{ bot_id: string; signal: unknown }> = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeCancelTriage("owner_cancel"),
        replyGenerator: () => {
          throw new Error("cancel route must not call reply generator");
        },
        actorStateProjectionProvider: () => {
          throw new Error("cancel route must not call actor state projection provider");
        },
        interruptRuntimeSink: async (interrupt) => {
          interrupts.push(interrupt);
        },
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-cancel",
          content: "取消",
          intent_epoch: 2,
          snapshot_ts: 101,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-cancel",
        content: "好的，已经停下来了喵~",
      },
    ]);
    expect(interrupts).toEqual([
      {
        bot_id: "bot-cw",
        signal: {
          source: {
            type: "triage",
            intent_epoch: 2,
          },
          reason: "owner_cancel",
        },
      },
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "chat.reply",
      bot_id: "bot-cw",
      message_id: "msg-cancel",
      content: "好的，已经停下来了喵~",
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "cancel.logged",
      bot_id: "bot-cw",
      message_id: "msg-cancel",
      reason: "owner_cancel",
    });
  });

  it("应在无 planner（规划器） 时丢弃 task（任务） 路径且不入执行队列", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "needs_planner",
          }),
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-task",
          content: "去砍树",
          intent_epoch: 3,
          snapshot_ts: 102,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-task",
        content: "抱歉，这次我还没能规划出可执行的技能任务喵~",
      },
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "chat.reply",
      bot_id: "bot-cw",
      message_id: "msg-task",
      content: "抱歉，这次我还没能规划出可执行的技能任务喵~",
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "task.discarded",
      bot_id: "bot-cw",
      message_id: "msg-task",
      status: "discarded",
      reason: "planner_unavailable",
    });
  });

  it("应通过 planner（规划器） 把自然语言移动任务转换为 goTo（前往坐标） 执行队列任务", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const enqueuedTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Urgent,
            reason: "llm_task_goto",
          }),
        planner: async () => ({
          code: 'await reply("收到，我这就去目标坐标喵~"); await goTo(10,64,-5); await report("已到目标坐标喵~");',
        }),
        actorStateProjectionProvider: () => {
          throw new Error("plan route must not call actor state projection provider");
        },
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
        enqueueExecTaskSink: async ({ task, priority }) => {
          enqueuedTasks.push({ task, priority });
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-goto",
          content: "请去坐标 x=10 y=64 z=-5",
          intent_epoch: 4,
          snapshot_ts: 103,
        },
      }),
    });

    expect(replies).toEqual([]);
    expect(enqueuedTasks).toHaveLength(1);
    expect(enqueuedTasks[0]).toMatchObject({
      priority: 1,
      task: {
        worker: "bot",
        bot_id: "bot-cw",
        queue: "bot:bot-cw:exec",
        exec_job: {
          message_id: "msg-goto",
          intent_epoch: 4,
          snapshot_ts: 103,
          priority: "urgent",
          type: "code",
          code: expect.stringContaining("goTo(10,64,-5)"),
        },
      },
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-cw",
      message_id: "msg-goto",
      exec_type: "code",
      priority: "urgent",
    });
  });

  it("应在 plan（规划） 路径读取 memory（记忆） 与资源摘要，并在 provider（提供器） 失败时降级", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const memoryContexts: Array<string | undefined> = [];
    const resourceContexts: Array<string | undefined> = [];
    let callCount = 0;
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "unit_plan_memory",
          }),
        memoryContextProvider: () => {
          callCount += 1;

          if (callCount === 2) {
            throw new Error("memory backend unavailable");
          }

          return "历史：主人之前要求先装备镐子。";
        },
        resourceContextProvider: (input) => {
          if (input.message_id === "msg-plan-memory-fallback") {
            throw new Error("resource index unavailable");
          }

          return "resources: tree: found 1 cluster(s): tree-a count=3 nearest=6.0 radius=16";
        },
        planner: async (input) => {
          memoryContexts.push(input.memory_context);
          resourceContexts.push(input.resource_context);

          return {
            code: 'await reply("收到，我去目标坐标喵~"); await goTo(1,64,-3); await report("已到目标坐标喵~");',
          };
        },
        broadcastReplySink: async () => undefined,
        enqueueExecTaskSink: async () => undefined,
      },
    });

    await runtime.start();
    for (const messageId of ["msg-plan-memory", "msg-plan-memory-fallback"]) {
      await processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: messageId,
            content: "去挖一块石头",
            intent_epoch: 11,
            snapshot_ts: 110,
          },
        }),
      });
    }

    expect(memoryContexts).toEqual(["历史：主人之前要求先装备镐子。", undefined]);
    expect(resourceContexts).toEqual([
      "resources: tree: found 1 cluster(s): tree-a count=3 nearest=6.0 radius=16",
      undefined,
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-cw",
      message_id: "msg-plan-memory-fallback",
      exec_type: "code",
      priority: "normal",
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "conversation.context_provider_failed",
      bot_id: "bot-cw",
      message_id: "msg-plan-memory-fallback",
      route_kind: "plan_exec",
      provider: "memory",
      error_summary: "memory backend unavailable",
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "conversation.context_provider_failed",
      bot_id: "bot-cw",
      message_id: "msg-plan-memory-fallback",
      route_kind: "plan_exec",
      provider: "resource",
      error_summary: "resource index unavailable",
    });
  });

  it("plan（规划）上下文 provider（提供器）失败时必须留下结构化诊断", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const plannerInputs: Array<{
      readonly brain_context?: string;
      readonly recent_context?: string;
      readonly snapshot_context?: string;
    }> = [];
    const baseRecentContextStore = createConversationRecentContextStore();
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "unit_plan_provider_diagnostics",
          }),
        recentContextStore: {
          ...baseRecentContextStore,
          getLatestFailureCapsuleInfo: () => {
            throw new Error("recent failure capsule unavailable");
          },
          render: () => {
            throw new Error("recent timeline unavailable");
          },
        },
        brainContextProvider: (input) => {
          if (input.include_skill) {
            throw new Error("brain context unavailable");
          }

          return null;
        },
        environmentSnapshotProvider: () => {
          throw new Error("snapshot unavailable");
        },
        planner: async (input) => {
          plannerInputs.push({
            brain_context: input.brain_context,
            recent_context: input.recent_context,
            snapshot_context: input.snapshot_context,
          });

          return {
            code: 'const task = await runGoal("测试", async () => {}); await report(task);',
          };
        },
        broadcastReplySink: async () => undefined,
        enqueueExecTaskSink: async () => undefined,
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-plan-provider-diagnostics",
          content: "去测试",
          intent_epoch: 12,
          snapshot_ts: 111,
        },
      }),
    });

    expect(plannerInputs).toEqual([
      {
        brain_context: undefined,
        recent_context: undefined,
        snapshot_context: expect.stringContaining("observation unavailable"),
      },
    ]);
    expect(runtime.getEvents()).toEqual(
      expect.arrayContaining([
        {
          type: "conversation.context_provider_failed",
          bot_id: "bot-cw",
          message_id: "msg-plan-provider-diagnostics",
          route_kind: "plan_exec",
          provider: "recent",
          error_summary: "recent failure capsule unavailable",
        },
        {
          type: "conversation.context_provider_failed",
          bot_id: "bot-cw",
          message_id: "msg-plan-provider-diagnostics",
          route_kind: "plan_exec",
          provider: "recent",
          error_summary: "recent timeline unavailable",
        },
        {
          type: "conversation.context_provider_failed",
          bot_id: "bot-cw",
          message_id: "msg-plan-provider-diagnostics",
          route_kind: "plan_exec",
          provider: "brain",
          error_summary: "brain context unavailable",
        },
        {
          type: "conversation.context_provider_failed",
          bot_id: "bot-cw",
          message_id: "msg-plan-provider-diagnostics",
          route_kind: "plan_exec",
          provider: "environment_snapshot",
          error_summary: "snapshot unavailable",
        },
      ]),
    );
  });

  it("明确动作进入 plan 时不应把 search 工具传给 planner，历史引用才允许传入", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const searchToolStates: boolean[] = [];
    let needsSearch = false;
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: needsSearch ? "owner_referenced_history" : "explicit_mine_action",
            needs_memory_search: needsSearch,
          }),
        environmentSnapshotProvider: () => createEnvironmentSnapshotFixture([]),
        brainSearchTool: async () => ({ hits: [] }),
        planner: async (input) => {
          searchToolStates.push(input.search_tool !== undefined);

          return {
            code: 'await reply("收到"); const task = await runGoal("挖石头", async () => {}); await report(task);',
          };
        },
        enqueueExecTaskSink: async () => undefined,
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    for (const [messageId, shouldSearch] of [
      ["msg-explicit-mine", false],
      ["msg-history-flow", true],
    ] as const) {
      needsSearch = shouldSearch;
      await processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: messageId,
            content: shouldSearch ? "按以前流程挖矿" : "挖1个石头",
            intent_epoch: shouldSearch ? 13 : 12,
            snapshot_ts: 111,
          },
        }),
      });
    }

    expect(searchToolStates).toEqual([false, true]);
  });

  it("应按 cancel（取消）→chat（闲聊）→action（动作） 顺序派发 composite triage（复合分诊）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const calls: string[] = [];
    const replies: Array<{ message_id: string; content: string }> = [];
    const enqueuedTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createConversationCompositeTriage({
            cancel: {
              reason: "owner_composite_cancel",
              priority: "interrupt",
            },
            chat: {},
            action: {
              intent: "task",
              priority: ConversationPriority.Urgent,
              reason: "owner_composite_goto",
            },
          }),
        interruptRuntimeSink: async () => {
          calls.push("interrupt");
        },
        broadcastReplySink: async (reply) => {
          calls.push(`reply:${reply.content}`);
          replies.push(reply);
        },
        replyGenerator: () => {
          calls.push("chat");

          return "Stage 2 收到";
        },
        planner: async () => {
          calls.push("planner");

          return {
            code: 'await reply("收到，我这就去目标坐标喵~"); await goTo(1,64,-3); await report("已到目标坐标喵~");',
          };
        },
        enqueueExecTaskSink: async ({ task, priority }) => {
          calls.push("enqueue");
          enqueuedTasks.push({ task, priority });
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-composite",
          content: "停下当前任务，回我一句知道了，然后去坐标 1 64 -3",
          intent_epoch: 7,
          snapshot_ts: 106,
        },
      }),
    });

    expect(calls).toEqual(["interrupt", "chat", "reply:Stage 2 收到喵~", "planner", "enqueue"]);
    expect(replies).toEqual([
      {
        message_id: "msg-composite",
        content: "Stage 2 收到喵~",
      },
    ]);
    expect(enqueuedTasks).toHaveLength(1);
    expect(enqueuedTasks[0]).toMatchObject({
      priority: 1,
      task: {
        exec_job: {
          message_id: "msg-composite",
          priority: "urgent",
          type: "code",
          code: expect.stringContaining("goTo(1,64,-3)"),
        },
      },
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "cancel.logged",
      bot_id: "bot-cw",
      message_id: "msg-composite",
      reason: "owner_composite_cancel",
    });
    expect(runtime.getEvents().filter((event) => event.type === "chat.reply")).toEqual([
      {
        type: "chat.reply",
        bot_id: "bot-cw",
        message_id: "msg-composite",
        content: "Stage 2 收到喵~",
      },
    ]);
  });

  it("应在普通新任务误带 cancel 时只入队 action（动作）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const calls: string[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createConversationCompositeTriage({
            cancel: {
              reason: "LLM 误判新任务需要重置状态",
              priority: "interrupt",
            },
            action: {
              intent: "task",
              priority: ConversationPriority.Urgent,
              reason: "挖石头后回来",
            },
          }),
        interruptRuntimeSink: async () => {
          calls.push("interrupt");
        },
        planner: async () => {
          calls.push("planner");

          return {
            code: 'await reply("收到，我去挖石头再回来喵~"); const task = await runGoal("挖石头并返回", async () => { await mine("stone", 10); const p = owner.position; if (!p) { throw new Error("owner_position_missing"); } await goTo(p.x, p.y, p.z); }); await report(task);',
          };
        },
        enqueueExecTaskSink: async () => {
          calls.push("enqueue");
        },
        broadcastReplySink: async (reply) => {
          calls.push(`reply:${reply.content}`);
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-mine-return",
          content: "去挖10个石头,然后回来",
          intent_epoch: 8,
          snapshot_ts: 107,
        },
      }),
    });

    expect(calls).toEqual(["planner", "enqueue"]);
    expect(runtime.getEvents().filter((event) => event.type === "cancel.logged")).toEqual([]);
  });

  it("应让无显式文本的 composite chat（复合闲聊） 复用状态上下文闲聊路径", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const stateContexts: Array<string | undefined> = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createConversationCompositeTriage({
            chat: {},
          }),
        actorStateProjectionProvider: () =>
          createBotActorStateProjection({
            status: BotStatus.EXECUTING,
            ready: false,
            world_ready: true,
            current_task: {
              kind: "code",
              message_id: "msg-goto",
            },
          }),
        replyGenerator: (input) => {
          stateContexts.push(input.state_context);

          return "我正在去目标点";
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-composite-reply",
          content: "你在干嘛",
          intent_epoch: 8,
          snapshot_ts: 107,
        },
      }),
    });

    expect(stateContexts).toEqual([
      "当前状态：executing；ready：否；世界交互：已就绪；正在执行代码（消息 msg-goto）",
    ]);
  });

  it("应在 planner（规划器） 失败时回模板失败回执且不入执行队列", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const enqueuedTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "llm_task_invalid_plan",
          }),
        planner: async () => {
          throw new Error("planner returned invalid goTo payload");
        },
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
        enqueueExecTaskSink: async ({ task, priority }) => {
          enqueuedTasks.push({ task, priority });
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-plan-failed",
          content: "帮我走到矿洞门口",
          intent_epoch: 5,
          snapshot_ts: 104,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-plan-failed",
        content: "抱歉，这次我还没能规划出可执行的技能任务喵~",
      },
    ]);
    expect(enqueuedTasks).toEqual([]);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.discarded",
      bot_id: "bot-cw",
      message_id: "msg-plan-failed",
      status: "discarded",
      reason: "planner_failed",
    });
  });

  it("应接受 planner（规划器） 产出的 ensure（确保） 挖石头代码并入执行队列", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const enqueuedTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "llm_task_mine",
          }),
        planner: async () => ({
          code: 'await reply("收到，我去挖石头喵~"); const result = await ensure(async () => mine("stone", 2), until.gained("cobblestone", 2)); if (result.ok === false) { await report(`挖石头失败: ${result.error.code}喵~`); throw new Error(result.error.code); } await report("挖石头完成喵~");',
        }),
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
        enqueueExecTaskSink: async ({ task, priority }) => {
          enqueuedTasks.push({ task, priority });
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-mine",
          content: "去挖两块石头",
          intent_epoch: 6,
          snapshot_ts: 105,
        },
      }),
    });

    expect(replies).toEqual([]);
    expect(enqueuedTasks).toHaveLength(1);
    expect(enqueuedTasks[0]).toMatchObject({
      priority: 5,
      task: {
        worker: "bot",
        bot_id: "bot-cw",
        queue: "bot:bot-cw:exec",
        exec_job: {
          message_id: "msg-mine",
          intent_epoch: 6,
          snapshot_ts: 105,
          priority: "normal",
          type: "code",
          code: expect.stringContaining('ensure(async () => mine("stone", 2)'),
        },
      },
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-cw",
      message_id: "msg-mine",
      exec_type: "code",
      priority: "normal",
    });
  });

  it("应把 planner（规划器） 抛出的未启用技能错误记录为 skill_not_enabled（技能未启用）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const enqueuedTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "llm_task_disabled_skill",
          }),
        planner: async () => {
          throw new ConversationLlmSkillNotEnabledError(
            "skill has not passed independent validation",
            { skill: "mine" },
          );
        },
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
        enqueueExecTaskSink: async ({ task, priority }) => {
          enqueuedTasks.push({ task, priority });
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-disabled-skill-error",
          content: "去挖两块石头",
          intent_epoch: 7,
          snapshot_ts: 106,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-disabled-skill-error",
        content:
          "这个技能还没有通过验收，当前允许执行 goTo 前往坐标、collect 捡拾、cutTree 砍树、equip 装备和 place 放置工作台喵~",
      },
    ]);
    expect(enqueuedTasks).toEqual([]);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.discarded",
      bot_id: "bot-cw",
      message_id: "msg-disabled-skill-error",
      status: "discarded",
      reason: "skill_not_enabled",
    });
  });

  it("应把 planner（规划器） 失败时的完整 LLM diagnostics（大语言模型诊断） 写入本地对话日志", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replyLogs: unknown[] = [];
    const diagnostics = Object.freeze({
      stage: "plan" as const,
      model: "bl-auto",
      message_id: "msg-plan-failed",
      log_ref: "llm/2026-05-03/plan-msg-plan-failed.jsonl",
      created_at: "2026-05-03T02:44:15.000Z",
      ok: false,
      error_summary: "planner cannot determine a valid executable skill",
      lines: Object.freeze([
        Object.freeze({
          t: 1_777_776_255,
          role: "user" as const,
          content: "环境快照：[附近掉落物] Item(item,1格)\n主人的指令：把这个东西捡起来",
        }),
      ]),
    });
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "unit_plan_error_log",
          }),
        planner: async () => {
          throw new ConversationLlmPlanError("planner cannot determine", { diagnostics });
        },
        conversationReplyLogSink: async (record) => {
          replyLogs.push(record);
        },
        broadcastReplySink: async () => undefined,
        enqueueExecTaskSink: async () => undefined,
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-plan-failed",
          content: "把这个东西捡起来",
          intent_epoch: 8,
          snapshot_ts: 107,
        },
      }),
    });

    expect(replyLogs).toHaveLength(1);
    expect(replyLogs[0]).toMatchObject({
      message_id: "msg-plan-failed",
      reply_mode: "template",
      reply: "抱歉，这次我还没能规划出可执行的技能任务喵~",
      llm_diagnostics: diagnostics,
    });
  });

  it("应在闲聊 LLM（大语言模型） 失败时记录诊断后继续抛错", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        replyGenerator: () => {
          throw new ConversationLlmChatError(
            "upstream overload",
            Object.freeze({
              stage: "chat",
              model: "bl-auto",
              message_id: "msg-chat-failed",
              log_ref: "llm/2026-04-24/chat-msg-chat-failed.jsonl",
              created_at: "2026-04-24T10:00:00.000Z",
              ok: false,
              error_summary: "upstream overload",
              lines: Object.freeze([]),
            }),
          );
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();

    await expect(
      processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: "msg-chat-failed",
            content: "你好",
            intent_epoch: 5,
            snapshot_ts: 104,
          },
        }),
      }),
    ).rejects.toThrow("upstream overload");

    expect(runtime.getEvents()).toContainEqual({
      type: "llm.chat.diagnostic",
      bot_id: "bot-cw",
      stage: "chat",
      message_id: "msg-chat-failed",
      model: "bl-auto",
      log_ref: "llm/2026-04-24/chat-msg-chat-failed.jsonl",
      created_at: "2026-04-24T10:00:00.000Z",
      ok: false,
      error_summary: "upstream overload",
    });
  });
});

function createEnvironmentSnapshotFixture(
  inventoryItems: readonly (readonly [string, number])[],
  ownerPosition: EnvironmentSnapshot["owner"]["position"] = { x: 1, y: 64, z: 1 },
): EnvironmentSnapshot {
  return Object.freeze({
    timestamp: 1,
    snapshot_version: "inventory-diff-test",
    bot: {
      position: { x: 0, y: 64, z: 0 },
      world_key: "overworld",
      health: 20,
      food: 20,
      experience: 0,
      is_on_fire: false,
      is_in_water: false,
      y_velocity: 0,
    },
    inventory: createInventorySummaryFixture(inventoryItems),
    equipment: {
      head: null,
      chest: null,
      legs: null,
      feet: null,
      main_hand: null,
      off_hand: null,
      has_weapon_equipped: false,
    },
    nearby_entities: [],
    nearby_blocks: [],
    owner: {
      position: ownerPosition,
      name: "owner",
      online: true,
    },
    time: {
      phase: "day",
      time_of_day: 1000,
    },
    server_extended: {
      global_entity_count: 0,
      chunk_loaded_count: 0,
      tps: 20,
    },
  });
}

function createInventorySummaryFixture(
  items: readonly (readonly [string, number])[],
): InventorySummary {
  const entries = items.map(([itemName, count], index) =>
    Object.freeze({
      slot: index,
      item_name: itemName,
      count,
    }),
  );

  return Object.freeze({
    items: entries,
    total_items: entries.reduce((sum, item) => sum + item.count, 0),
    occupied_slots: entries.length,
    free_slots: 36 - entries.length,
  });
}
