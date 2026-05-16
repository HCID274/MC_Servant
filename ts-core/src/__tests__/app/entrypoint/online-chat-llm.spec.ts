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
describe("app/entrypoint online chat LLM 行为", () => {
  it("应在真实在线入口把闲聊消息接到 OpenAI（开放人工智能） 兼容 LLM（大语言模型） 并写回聊天", async () => {
    const events: string[] = [];
    const writes: string[] = [];
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const memoryProviderCalls: unknown[] = [];
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-llm-online",
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
            const requestBody =
              init?.body === undefined
                ? undefined
                : (JSON.parse(String(init.body)) as {
                    messages?: Array<{ role: string; content: string }>;
                  });
            const userMessage = requestBody?.messages?.at(-1)?.content ?? "";
            const assistantContent = userMessage.includes("Bot 状态：")
              ? '{"chat":{}}'
              : "当然可以，我在这里";

            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: assistantContent,
                    },
                  },
                ],
                usage: {
                  prompt_tokens: 12,
                  completion_tokens: 5,
                },
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
          memoryContextProvider: (input) => {
            memoryProviderCalls.push(input);

            return "历史：主人上次让 Bot 去过矿洞入口。";
          },
          createWorker: ({ processor: capturedProcessor }) => {
            processor = capturedProcessor;

            return {
              close: async () => undefined,
            };
          },
        },
      },
      write: (message) => {
        writes.push(message);
      },
    });

    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-llm-online",
        message: {
          bot_id: "bot-llm-online",
          message_id: "msg-online-chat",
          content: "你还记得上次的矿洞吗",
          intent_epoch: 1,
          snapshot_ts: 1_713_952_800_000,
        },
      }),
    });

    expect(bootstrap.llm).toEqual({
      enabled: true,
      provider: "openai_compatible",
      base_url: "http://127.0.0.1:8045/v1",
      model: "bl-auto",
      enable_thinking: false,
      reasoning_effort: "none",
      force_thinking_models: [],
      api_key_injected: true,
    });
    expect(llmRequests).toHaveLength(2);
    expect(llmRequests[0]).toEqual({
      url: "http://127.0.0.1:8045/v1/chat/completions",
      body: {
        model: "bl-auto",
        messages: expect.any(Array),
      },
    });
    expect(llmRequests[1]).toEqual({
      url: "http://127.0.0.1:8045/v1/chat/completions",
      body: {
        model: "bl-auto",
        messages: expect.any(Array),
      },
    });
    const chatRequestBody = llmRequests[1]?.body as {
      messages?: Array<{ role: string; content: string }>;
    };
    expect(memoryProviderCalls).toEqual([
      expect.objectContaining({
        bot_id: "bot-llm-online",
        message_id: "msg-online-chat",
        intent_epoch: 1,
        message_content: "你还记得上次的矿洞吗",
        route_kind: "chat_reply",
        query_reason: "composite_chat",
      }),
    ]);
    expect(chatRequestBody.messages?.[0]?.content).toContain(
      "记忆摘要：历史：主人上次让 Bot 去过矿洞入口。",
    );
    expect(chatRequestBody.messages?.[0]?.content).toContain(
      "[Bot] 位置:(0,0,0) 生命:20/20 饥饿:20/20 着火:否",
    );
    expect(chatRequestBody.messages?.[0]?.content).toContain("[世界] unknown");
    expect(chatRequestBody.messages?.[0]?.content).toContain("[主人] 离线");
    expect(chatRequestBody.messages?.[0]?.content).toContain("[背包] 空");
    expect(chatRequestBody.messages?.[0]?.content).toContain("[时间] 未知(unknown)");
    expect(chatRequestBody.messages?.[0]?.content).not.toContain("当前状态摘要：");
    expect(chatRequestBody.messages?.[0]?.content).not.toContain("世界交互：");
    expect(events).toContain("chat:当然可以，我在这里喵~");
    expect(writes).toContainEqual(
      expect.stringContaining(
        "TS Core LLM chat ok: model=bl-auto message_id=msg-online-chat request_ms=",
      ),
    );
    const statusResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/status?bot_id=bot-llm-online",
    });

    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toMatchObject({
      bot: {
        bot_id: "bot-llm-online",
        status: "idle",
        last_event_seq: 1,
        mineflayer: {
          connected: true,
          world_ready: true,
          username: "bot-online",
        },
        workers: {
          conversation: true,
          bot: true,
        },
        llm: {
          stage: "chat",
          message_id: "msg-online-chat",
          status: "ok",
          model: "bl-auto",
          log_ref: "llm/2026-04-24/chat-msg-online-chat.jsonl",
          created_at: "2026-04-24T10:00:00.000Z",
          metrics: {
            input_tokens: 12,
            output_tokens: 5,
            ttft_ms: null,
            ttft_unavailable: "non_streaming",
          },
        },
      },
    });
    expect(JSON.stringify(statusResponse.json())).not.toContain("sk-local-dev");
    const messageResponse = await runtime.services.http.server.inject({
      method: "POST",
      url: "/api/message",
      payload: {
        bot_id: "bot-llm-online",
        message_id: "msg-online-http",
        content: "HTTP 入口测试",
      },
    });
    const replayResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/replay?bot_id=bot-llm-online&after_seq=0&limit=10",
    });

    expect(messageResponse.statusCode).toBe(202);
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json()).toMatchObject({
      bot_id: "bot-llm-online",
      after_seq: 0,
      limit: 10,
      state: {
        last_event_seq: 2,
      },
      events: [
        {
          seq: 1,
          bot_id: "bot-llm-online",
          type: "chat.reply",
          payload: {
            message_id: "msg-online-chat",
            content: "当然可以，我在这里喵~",
          },
        },
        {
          seq: 2,
          bot_id: "bot-llm-online",
          type: "task.accepted",
          payload: {
            job_id: "job-online",
            message_id: "msg-online-http",
            epoch: 1,
          },
        },
      ],
    });
    const replayAfterSeqResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/replay?bot_id=bot-llm-online&after_seq=2&limit=10",
    });

    expect(replayAfterSeqResponse.json()).toMatchObject({
      events: [],
    });

    await runtime.close();
  });

  it("应在真实在线入口把 LLM（大语言模型） 失败摘要脱敏后再暴露到 status（状态接口）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const writes: string[] = [];
    const bootstrap = createAppBootstrapContract({
      botId: "bot-llm-error-online",
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
          fetch: async () => {
            throw new Error(
              "upstream failed LLM_API_KEY=sk-local-dev postgres://user:pg-pass@localhost/db redis://:redis-pass@localhost EasyAuth密码=hunter2",
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
      write: (message) => {
        writes.push(message);
      },
    });

    try {
      if (processor === undefined) {
        throw new Error("conversation processor must be captured");
      }

      await expect(
        processor({
          data: createConversationWorkerTask({
            bot_id: "bot-llm-error-online",
            message: {
              bot_id: "bot-llm-error-online",
              message_id: "msg-online-error",
              content: "触发失败",
              intent_epoch: 1,
              snapshot_ts: 1_713_952_800_000,
            },
          }),
        }),
      ).rejects.toThrow("sk-local-dev");

      const statusResponse = await runtime.services.http.server.inject({
        method: "GET",
        url: "/api/status?bot_id=bot-llm-error-online",
      });
      const statusBody = statusResponse.json();
      const statusText = JSON.stringify(statusBody);

      expect(statusResponse.statusCode).toBe(200);
      expect(statusBody).toMatchObject({
        bot: {
          llm: {
            stage: "triage",
            message_id: "msg-online-error",
            status: "error",
            model: "bl-auto",
            log_ref: "llm/2026-04-24/triage-msg-online-error.jsonl",
            error_summary: expect.stringContaining("<redacted>"),
          },
        },
      });
      expect(statusText).toContain("upstream failed");
      expect(statusText).not.toContain("sk-local-dev");
      expect(statusText).not.toContain("pg-pass");
      expect(statusText).not.toContain("redis-pass");
      expect(statusText).not.toContain("hunter2");
      expect(writes.join("\n")).not.toContain("sk-local-dev");
    } finally {
      await runtime.close();
    }
  });
});
