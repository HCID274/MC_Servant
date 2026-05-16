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

describe("conversation/worker chat route 行为", () => {
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
