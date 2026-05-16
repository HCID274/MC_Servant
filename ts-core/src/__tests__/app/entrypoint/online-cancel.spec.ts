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
describe("app/entrypoint online cancel 行为", () => {
  it("应在真实在线入口把修改诉求表达为 cancel（取消） + task（任务） 并进入新规划", async () => {
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const queueAdds: Array<{ name: string; jobName: string; data: unknown; options: unknown }> = [];
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-replace-online",
      now: "2026-04-24T10:00:00.000Z",
      env: {
        LLM_BASE_URL: "http://127.0.0.1:8045/v1",
        LLM_API_KEY: "sk-local-dev",
        LLM_MODEL: "bl-auto",
      },
    });

    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        brainWorker: createNoopBrainWorkerDependencies(),
        llm: {
          api_key: "sk-local-dev",
          fetch: async (url, init) => {
            llmRequests.push({
              url: String(url),
              body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
            });

            const assistantContent =
              llmRequests.length === 1
                ? '{"cancel":{"reason":"主人要求替换当前移动目标","priority":"interrupt"},"action":{"intent":"task","priority":"urgent","reason":"主人要求去新坐标"}}'
                : '{"code":"await reply(\\"收到，我改去新的目标坐标喵~\\"); const task = await runGoal(\\"去新的目标坐标\\", async () => { await goTo(10,64,-5); }); await report(task);"}';

            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: assistantContent,
                    },
                  },
                ],
              }),
              {
                status: 200,
                headers: {
                  "content-type": "application/json",
                },
              },
            );
          },
          now: () => new Date("2026-04-24T10:00:00.000Z"),
        },
        infrastructure: {
          postgres: {
            createPool: () => ({
              end: async () => undefined,
            }),
            createDrizzle: () => ({}),
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
              add: async (jobName: string, data: unknown, options: unknown) => {
                queueAdds.push({ name, jobName, data, options });

                return { id: "job-online" };
              },
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
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
        conversationWorker: {
          createWorker: ({ processor: capturedProcessor }) => {
            processor = capturedProcessor;

            return {
              close: async () => undefined,
            };
          },
        },
      },
    });

    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-replace-online",
        message: {
          bot_id: "bot-replace-online",
          message_id: "msg-online-replace",
          content: "把刚才的目标改成去 10 64 -5",
          intent_epoch: 4,
          snapshot_ts: 1_713_952_800_003,
        },
      }),
    });

    expect(llmRequests).toHaveLength(2);
    expect(queueAdds).toHaveLength(2);
    expect(queueAdds[0]).toMatchObject({
      name: "bot:bot-replace-online:exec",
      jobName: "bot",
      data: {
        bot_id: "bot-replace-online",
        exec_job: {
          message_id: "msg-online-replace",
          type: "code",
          code: expect.stringContaining("goTo(10,64,-5)"),
          priority: "urgent",
        },
      },
      options: {
        jobId: "msg-online-replace",
        priority: 1,
      },
    });
    expect(queueAdds[1]).toMatchObject({
      name: "brain",
      jobName: "brain",
      data: {
        worker: "brain",
        payload: expect.objectContaining({
          kind: "conversation_fact",
          bot_id: "bot-replace-online",
          message_id: "msg-online-replace",
          owner_text: "把刚才的目标改成去 10 64 -5",
          route_kind: "plan_exec",
        }),
      },
      options: {
        jobId: "conversation-fact-msg-online-replace",
      },
    });
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "cancel.logged",
      bot_id: "bot-replace-online",
      message_id: "msg-online-replace",
      reason: "主人要求替换当前移动目标",
    });
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-replace-online",
      message_id: "msg-online-replace",
      exec_type: "code",
      priority: "urgent",
    });
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "chat.reply",
      bot_id: "bot-replace-online",
      message_id: "msg-online-replace",
      content: "好的，已经停下来了喵~",
    });
    expect(llmRequests[1]).toEqual({
      url: "http://127.0.0.1:8045/v1/chat/completions",
      body: expect.objectContaining({
        model: "bl-auto",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("主人的指令：把刚才的目标改成去 10 64 -5"),
          }),
        ]),
      }),
    });

    await runtime.close();
  });

  it("应在真实在线入口把 cancel（取消） 走 control fast-path（控制快路径） 且不入队", async () => {
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const queueAdds: unknown[] = [];
    const chats: string[] = [];
    const customBroadcasts: unknown[] = [];
    const bootstrap = createAppBootstrapContract({
      botId: "bot-cancel-online",
      now: "2026-04-24T10:00:00.000Z",
      env: {
        LLM_BASE_URL: "http://127.0.0.1:8045/v1",
        LLM_API_KEY: "sk-local-dev",
        LLM_MODEL: "bl-auto",
      },
    });

    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        brainWorker: createNoopBrainWorkerDependencies(),
        llm: {
          api_key: "sk-local-dev",
          fetch: async (url, init) => {
            llmRequests.push({
              url: String(url),
              body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
            });

            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: "不应触发",
                    },
                  },
                ],
              }),
              {
                status: 200,
                headers: {
                  "content-type": "application/json",
                },
              },
            );
          },
          now: () => new Date("2026-04-24T10:00:00.000Z"),
        },
        infrastructure: {
          postgres: {
            createPool: () => ({
              end: async () => undefined,
            }),
            createDrizzle: () => ({}),
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
              add: async (jobName, data, options) => {
                queueAdds.push({ name, jobName, data, options });

                return { id: "job-online" };
              },
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
              const bot = new FakeEntrypointMineflayerBot(chats);

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
          broadcastReplySink: async (reply) => {
            customBroadcasts.push(reply);
          },
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
      },
    });

    const response = await runtime.services.http.server.inject({
      method: "POST",
      url: "/api/message",
      payload: {
        bot_id: "bot-cancel-online",
        message_id: "msg-online-cancel",
        content: "取消",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: true,
      bot_id: "bot-cancel-online",
      job_id: "msg-online-cancel",
      message_id: "msg-online-cancel",
    });
    expect(queueAdds).toEqual([]);
    expect(llmRequests).toEqual([]);
    expect(customBroadcasts).toEqual([
      {
        message_id: "msg-online-cancel",
        content: "好的，已经停下来了喵~",
      },
    ]);
    expect(chats).toEqual(["chat:好的，已经停下来了喵~"]);
    expect(runtime.conversation_worker.getEvents()).toEqual([]);
    const replayResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/replay?bot_id=bot-cancel-online&after_seq=0&limit=10",
    });

    expect(replayResponse.json()).toMatchObject({
      events: [
        {
          seq: 1,
          bot_id: "bot-cancel-online",
          type: "chat.reply",
          payload: {
            message_id: "msg-online-cancel",
            content: "好的，已经停下来了喵~",
          },
        },
      ],
    });
    const statusResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/status?bot_id=bot-cancel-online",
    });

    expect(statusResponse.json()).toMatchObject({
      bot: {
        intent_epoch: 1,
      },
    });

    await runtime.close();
  });
});
