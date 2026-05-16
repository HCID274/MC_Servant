import {
  BotStatus,
  ConversationLlmChatError,
  ConversationLlmPlanError,
  ConversationLlmSkillNotEnabledError,
  ConversationPriority,
  type EnvironmentSnapshot,
  ExecPriority,
  type InventorySummary,
  TaskHistoryStatus,
  createBotActorStateProjection,
  createBotWorkerActions,
  createBotWorkerRuntime,
  createBotWorkerTask,
  createBrainWorkerRuntime,
  createCodeJob,
  createCodeJobForSkill,
  createCompositeCancelTriage,
  createCompositeChatTriage,
  createCompositeTaskTriage,
  createConversationBotWorkerActionSink,
  createConversationCompositeTriage,
  createConversationRecentContextStore,
  createConversationWorkerMemoryContext,
  createConversationWorkerRuntime,
  createConversationWorkerTask,
  createEnvironmentSnapshotFixture,
  createFakeBrainMemoryDb,
  createGoToSkillExecutionResult,
  createInventorySummaryFixture,
  createPostgresBrainMemoryStore,
  createRecoveryChainId,
  createTaskResultSummary,
  createTaskSummaryDraft,
  describe,
  expect,
  it,
  persistAcceptedTaskHistory,
  persistTaskHistoryLifecycleAction,
  vi,
} from "./fixture.js";

describe("conversation/worker continuation recovery 行为", () => {
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
});
