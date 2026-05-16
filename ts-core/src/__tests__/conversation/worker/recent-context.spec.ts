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

describe("conversation/worker recent context 行为", () => {
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
});
