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

describe("conversation/worker worker integration 行为", () => {
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
});
