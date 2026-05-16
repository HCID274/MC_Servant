import {
  type AppRuntimeCoreResources,
  BotStatus,
  type BotWorkerTask,
  type BrainWorkerRuntimeDependencies,
  type BrainWorkerTask,
  ConversationLlmPlanError,
  ConversationPriority,
  EventEmitter,
  ExecPriority,
  ExecutionTaskKind,
  FakeEntrypointMineflayerBot,
  Fastify,
  type MineflayerBotHandle,
  SERVER_BRIDGE_PROTOCOL_VERSION,
  TaskHistoryStatus,
  WebSocket,
  bindOnlineResourceServiceBlockUpdates,
  createAppBootstrapContract,
  createAppExternalAuthSecretFromEnvironment,
  createAppServerBridgeConfigFromEnvironment,
  createAppStartupSummary,
  createBotWorkerActions,
  createBotWorkerTask,
  createBrainTaskCard,
  createBrainWorkerTask,
  createCodeJob,
  createCodeJobForSkill,
  createCollectSkillExecutionResult,
  createConversationCompositeTriage,
  createConversationWorkerTask,
  createCutTreeSkillExecutionResult,
  createEquipSkillExecutionResult,
  createExternalAuthExecutionPlan,
  createExternalAuthState,
  createFakeIntentEpochRedisClient,
  createGoToSkillExecutionResult,
  createMineSkillExecutionResult,
  createMineflayerTransportDescriptor,
  createNoopBrainWorkerDependencies,
  createObservationRuntimeCache,
  createOnlineConversationActorStateProjectionProvider,
  createRealtimeEventFromBotWorkerAction,
  createRealtimeEventFromConversationReply,
  createResourceService,
  createRuntimeReadyGate,
  createTaskFailureResultSummary,
  createTaskResultReporter,
  createTaskResultSummaryFromSandboxResult,
  createTaskResultSummaryFromSkillResult,
  describe,
  expect,
  it,
  join,
  mkdtemp,
  readFile,
  readFileSync,
  readNextWsText,
  renderAppStartupSummary,
  resolve,
  rm,
  runAppEntrypoint,
  startAppOnlineRuntime,
  tmpdir,
  waitForWsClose,
  waitForWsOpen,
} from "./fixture.js";

describe("app/entrypoint online runtime 装配", () => {
  it("应按真实在线入口顺序启动 HTTP（超文本传输协议） 、Mineflayer（Minecraft 协议客户端） 与 ConversationWorker（对话工作线程） 并逆序关闭", async () => {
    const events: string[] = [];
    const env = {
      MC_EXTERNAL_AUTH_REQUIRED: "true",
      MC_EXTERNAL_AUTH_SECRET: "hunter2",
    };
    const bootstrap = createAppBootstrapContract({
      botId: "bot-online",
      now: "2026-04-15T00:00:00.000Z",
      env,
    });
    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        brainWorker: createNoopBrainWorkerDependencies(),
        infrastructure: {
          postgres: {
            createPool: () => ({
              end: async () => {
                events.push("postgres.close");
              },
            }),
            createDrizzle: () => ({}),
            warmupPool: async () => {
              events.push("postgres.ready");
            },
          },
          redis: {
            createClient: () => createFakeIntentEpochRedisClient(),
            connectClient: async () => {
              events.push("redis.ready");
            },
            closeClient: async () => {
              events.push("redis.close");
            },
          },
        },
        services: {
          workers: {
            createQueue: ({ name }) => ({
              name,
              add: async () => ({ id: "job-online" }),
              close: async () => {
                events.push(`queue.close:${name}`);
              },
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalClose = server.close.bind(server);

              server.listen = async () => {
                events.push("http.listen");

                return "http://127.0.0.1:0";
              };
              server.close = async () => {
                events.push("http.close");

                return originalClose();
              };

              return server;
            },
          },
        },
        runtime: {
          externalAuthSecret: createAppExternalAuthSecretFromEnvironment({ env }),
          transport: {
            createBot: () => {
              events.push("mineflayer.create");
              const bot = new FakeEntrypointMineflayerBot(events);

              setTimeout(() => bot.emit("spawn"), 0);

              return bot;
            },
          },
        },
        botWorker: {
          createWorker: () => {
            events.push("bot.worker.start");

            return {
              close: async () => {
                events.push("bot.worker.close");
              },
            };
          },
        },
        conversationWorker: {
          createWorker: () => {
            events.push("conversation.worker.start");

            return {
              close: async () => {
                events.push("conversation.worker.close");
              },
            };
          },
        },
      },
    });

    expect(runtime.listen_address).toBe("http://127.0.0.1:0");
    expect(events).toEqual([
      "postgres.ready",
      "redis.ready",
      "http.listen",
      "mineflayer.create",
      "chat:/login hunter2",
      "bot.worker.start",
      "conversation.worker.start",
    ]);
    expect(bootstrap.auth.state.status).toBe("pending");
    expect(runtime.runtime.actor.getSnapshot().external_auth.status).toBe("authenticated");
    const statusResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/status?bot_id=bot-online",
    });
    const replayResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/replay?bot_id=bot-online&after_seq=0&limit=10",
    });
    const publicOnlineText = JSON.stringify({
      status: statusResponse.json(),
      replay: replayResponse.json(),
    });

    expect(publicOnlineText).not.toContain("hunter2");
    expect(publicOnlineText).not.toContain("/login hunter2");

    await runtime.close();

    expect(events.slice(7)).toEqual([
      "conversation.worker.close",
      "bot.worker.close",
      "mineflayer.quit",
      "http.close",
      "queue.close:brain",
      "queue.close:bot:bot-online:exec",
      "queue.close:msg:bot-online",
      "redis.close",
      "postgres.close",
    ]);
  });

  it("应在在线入口用显式 embedding endpoint（向量端点）驱动 BrainWorker（大脑工作线程）持久化 task_events（任务事件）", async () => {
    const events: string[] = [];
    const embeddingRequests: Array<{ url: string; body: unknown }> = [];
    const persistedDrafts: unknown[] = [];
    const appMemoryWrites: unknown[] = [];
    const appCandidateWrites: unknown[] = [];
    const appAuditWrites: unknown[] = [];
    let brainProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-online-brain",
      now: "2026-05-03T00:00:00.000Z",
      env: {
        EMBEDDING_DIMENSIONS: "3",
      },
    });
    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        embedding: {
          endpoint_url: "https://embedding.local/v1/embeddings",
          api_key: "sk-embedding",
          model: "text-embedding-v4",
          fetch: async (url, init) => {
            embeddingRequests.push({
              url: String(url),
              body: JSON.parse(String(init?.body)),
            });

            return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
              status: 200,
            });
          },
        },
        brainWorker: {
          now: () => new Date("2026-05-03T01:00:00.000Z"),
          async persistTaskEvent(draft) {
            persistedDrafts.push(draft);
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
            async generateMemoryCandidates() {
              return [
                {
                  kind: "MEMORY",
                  content: "主基地旁边有盾牌补给点",
                  confidence: 0.9,
                  reason: "稳定地点事实",
                },
              ];
            },
            async resolveMemoryCapacity() {
              throw new Error("capacity should not run");
            },
          },
          async loadBotMemory() {
            return {
              USER: "",
              MEMORY: "",
              SKILL: "",
            };
          },
          async insertMemoryCandidate(candidate) {
            appCandidateWrites.push(candidate);
          },
          async decideMemoryCandidate() {
            return undefined;
          },
          async writeBotMemory(memory) {
            appMemoryWrites.push(memory);
          },
          async appendMemoryAudit(audit) {
            appAuditWrites.push(audit);
          },
          createWorker: ({ processor }) => {
            brainProcessor = processor;
            events.push("brain.worker.start");

            return {
              close: async () => {
                events.push("brain.worker.close");
              },
            };
          },
        },
        infrastructure: {
          postgres: {
            createPool: () => ({
              end: async () => {
                events.push("postgres.close");
              },
            }),
            createDrizzle: () => ({}),
            warmupPool: async () => {
              events.push("postgres.ready");
            },
          },
          redis: {
            createClient: () => createFakeIntentEpochRedisClient(),
            connectClient: async () => {
              events.push("redis.ready");
            },
            closeClient: async () => {
              events.push("redis.close");
            },
          },
        },
        services: {
          workers: {
            createQueue: ({ name }) => ({
              name,
              add: async () => ({ id: "job-online-brain" }),
              close: async () => {
                events.push(`queue.close:${name}`);
              },
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();

              server.listen = async () => "http://127.0.0.1:0";

              return server;
            },
          },
        },
        runtime: {
          transport: {
            createBot: () => {
              const bot = new FakeEntrypointMineflayerBot(events);

              setTimeout(() => bot.emit("spawn"), 0);

              return bot;
            },
          },
        },
        botWorker: {
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
        conversationWorker: {
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
      },
    });

    await brainProcessor?.({
      data: createBrainWorkerTask({
        bot_id: "bot-online-brain",
        message_id: "msg-online-brain",
        intent_epoch: 3,
        status: TaskHistoryStatus.Completed,
        owner_text: "把这个东西捡起来",
        task_card: createBrainTaskCard({
          task_id: "msg-online-brain",
          message_id: "msg-online-brain",
          intent_epoch: 3,
          snapshot_ts: 100,
          priority: ExecPriority.Normal,
          owner_text: "把这个东西捡起来",
          execution: {
            type: ExecutionTaskKind.Code,
            skill: "collect",
            params: {},
          },
          result: {
            status: TaskHistoryStatus.Completed,
            duration_ms: 1000,
            total_steps: 1,
          },
        }),
      }),
    });

    expect(embeddingRequests).toEqual([
      {
        url: "https://embedding.local/v1/embeddings",
        body: {
          model: "text-embedding-v4",
          input: "把这个东西捡起来",
          dimensions: 3,
        },
      },
    ]);
    expect(persistedDrafts).toEqual([
      expect.objectContaining({
        id: "task-event:bot-online-brain:msg-online-brain",
        task_id: "msg-online-brain",
        bot_id: "bot-online-brain",
        message_id: "msg-online-brain",
        owner_text: "把这个东西捡起来",
        embedding: [0.1, 0.2, 0.3],
        created_at: "2026-05-03T01:00:00.000Z",
      }),
    ]);
    expect(appCandidateWrites).toMatchObject([
      {
        id: "memory-candidate:task-event:bot-online-brain:msg-online-brain:0",
        kind: "MEMORY",
        content: "主基地旁边有盾牌补给点",
        status: "pending",
      },
    ]);
    expect(appMemoryWrites).toEqual([
      {
        bot_id: "bot-online-brain",
        kind: "MEMORY",
        content: "主基地旁边有盾牌补给点",
        updated_at: "2026-05-03T01:00:00.000Z",
      },
    ]);
    expect(appAuditWrites).toMatchObject([
      {
        kind: "MEMORY",
        op: "insert",
        candidate_id: "memory-candidate:task-event:bot-online-brain:msg-online-brain:0",
      },
    ]);
    expect(runtime.brain_worker.getEvents()).toEqual([
      {
        type: "brain.task_event.persisted",
        bot_id: "bot-online-brain",
        message_id: "msg-online-brain",
        task_id: "msg-online-brain",
        event_id: "task-event:bot-online-brain:msg-online-brain",
        status: TaskHistoryStatus.Completed,
      },
      {
        type: "brain.memory_candidate.recorded",
        bot_id: "bot-online-brain",
        candidate_id: "memory-candidate:task-event:bot-online-brain:msg-online-brain:0",
        kind: "MEMORY",
        status: "pending",
      },
      {
        type: "brain.memory.promoted",
        bot_id: "bot-online-brain",
        candidate_id: "memory-candidate:task-event:bot-online-brain:msg-online-brain:0",
        kind: "MEMORY",
        op: "insert",
      },
    ]);

    await runtime.close();
  });

  it("应在真实在线入口组合 BotWorker（机器人工作线程） actionSink（动作汇点） 并写入 replay（补拉）", async () => {
    const customActions: string[] = [];
    const taskHistoryUpdates: unknown[] = [];
    let botProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-worker-replay-online",
      now: "2026-04-25T00:00:00.000Z",
    });

    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        brainWorker: createNoopBrainWorkerDependencies(),
        infrastructure: {
          postgres: {
            createPool: () => ({
              end: async () => undefined,
            }),
            createDrizzle: () => ({
              insert: () => ({
                values: () => ({
                  onConflictDoNothing: async () => undefined,
                }),
              }),
              update: () => ({
                set: (values: unknown) => ({
                  where: async () => {
                    taskHistoryUpdates.push(values);
                  },
                }),
              }),
            }),
            warmupPool: async () => undefined,
          },
          redis: {
            createClient: () => createFakeIntentEpochRedisClient(),
            connectClient: async () => undefined,
            closeClient: async () => undefined,
          },
        },
        services: {
          workers: {
            createQueue: ({ name }) => ({
              name,
              add: async () => ({ id: "job-online" }),
              close: async () => undefined,
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalClose = server.close.bind(server);

              server.listen = async () => "http://127.0.0.1:0";
              server.close = async () => originalClose();

              return server;
            },
          },
        },
        runtime: {
          transport: {
            createBot: () => {
              const bot = new FakeEntrypointMineflayerBot([]);

              setTimeout(() => bot.emit("spawn"), 0);

              return bot;
            },
          },
        },
        botWorker: {
          currentIntentEpoch: () => 2,
          actionSink: async (action) => {
            customActions.push(action.type);
          },
          createWorker: ({ processor: capturedProcessor }) => {
            botProcessor = capturedProcessor;

            return {
              close: async () => undefined,
            };
          },
        },
        conversationWorker: {
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
      },
    });

    await botProcessor?.({
      data: createBotWorkerTask({
        bot_id: "bot-worker-replay-online",
        exec_job: createCodeJob({
          message_id: "msg-stale-task",
          intent_epoch: 1,
          snapshot_ts: 100,
          priority: ExecPriority.Normal,
          code: "return true",
        }),
      }),
    });

    const replayResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/replay?bot_id=bot-worker-replay-online&after_seq=0&limit=10",
    });
    const statusResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/status?bot_id=bot-worker-replay-online",
    });

    expect(customActions).toEqual(["emit_task_lifecycle"]);
    expect(taskHistoryUpdates).toEqual([
      expect.objectContaining({
        status: TaskHistoryStatus.Discarded,
        finishedAt: expect.any(Date),
      }),
    ]);
    expect(replayResponse.json()).toMatchObject({
      events: [
        {
          seq: 1,
          bot_id: "bot-worker-replay-online",
          type: "task.discarded",
          payload: {
            job_id: "msg-stale-task",
            status: "discarded",
            message_id: "msg-stale-task",
            discard_reason: "intent_epoch_stale",
            current_epoch: 2,
          },
        },
      ],
    });
    expect(statusResponse.json()).toMatchObject({
      bot: {
        last_event_seq: 1,
        workers: {
          conversation: true,
          bot: true,
        },
      },
    });

    await runtime.close();
  });
});
