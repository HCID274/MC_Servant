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

describe("conversation/worker plan exec 行为", () => {
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
});
