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

describe("conversation/worker metrics 与旁路副作用行为", () => {
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
});
