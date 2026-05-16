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
describe("app/entrypoint online LLM diagnostics 行为", () => {
  it("应在真实在线入口把 triage（分诊） 解析失败落盘到 llm（大语言模型） JSONL（结构化日志）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const logsDir = await mkdtemp(join(tmpdir(), "ts-core-llm-diagnostics-"));
    const bootstrap = createAppBootstrapContract({
      botId: "bot-llm-parse-log-online",
      now: "2026-04-24T10:00:00.000Z",
      env: {
        LOGS_DIR: logsDir,
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
          fetch: async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content:
                        '{"intent":"task","priority":"urgent","reason":"旧单层 triage 输出"}',
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
            ),
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
    });

    let parseLogRuntimeClosed = false;

    try {
      if (processor === undefined) {
        throw new Error("conversation processor must be captured");
      }

      await expect(
        processor({
          data: createConversationWorkerTask({
            bot_id: "bot-llm-parse-log-online",
            message: {
              bot_id: "bot-llm-parse-log-online",
              message_id: "msg-online-parse-error",
              content: "api_key=sk-local-dev 去 10 64 -5",
              intent_epoch: 1,
              snapshot_ts: 1_713_952_800_000,
            },
          }),
        }),
      ).rejects.toThrow("triage must use composite schema");

      await runtime.close();
      parseLogRuntimeClosed = true;

      const logPath = join(logsDir, "llm", "2026-04-24", "triage-msg-online-parse-error.jsonl");
      const logText = await readFile(logPath, "utf8");
      const logLines = logText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);

      expect(logLines).toHaveLength(5);
      expect(logLines[0]).toMatchObject({
        stage: "triage",
        model: "bl-auto",
        msg_id: "msg-online-parse-error",
      });
      expect(logLines[3]).toMatchObject({
        role: "assistant",
        content: '{"intent":"task","priority":"urgent","reason":"旧单层 triage 输出"}',
      });
      expect(logLines[4]).toMatchObject({
        meta: {
          ok: false,
        },
        err: {
          message: "triage must use composite schema",
        },
      });
      expect(logText).toContain("<redacted>");
      expect(logText).not.toContain("sk-local-dev");
      const metricPath = join(logsDir, "metrics", "2026-04-24", "production-metrics.jsonl");
      const metricText = await readFile(metricPath, "utf8");
      const metricLines = metricText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);

      expect(metricLines).toHaveLength(1);
      expect(metricLines[0]).toMatchObject({
        schema_version: "ts-core.metric.v1",
        event_type: "llm.stage",
        message_id: "msg-online-parse-error",
        task_id: null,
        bot_id: "bot-llm-parse-log-online",
        source: "conversation_llm",
        stage: "triage",
        ok: false,
        error_code: "llm_stage_failed",
        model: "bl-auto",
      });
      expect(metricText).not.toContain("sk-local-dev");
    } finally {
      if (!parseLogRuntimeClosed) {
        await runtime.close();
      }
      await rm(logsDir, { recursive: true, force: true });
    }
  });

  it("应在真实在线入口异步写入 LLM（大语言模型） JSONL（结构化日志），慢写不阻塞分诊失败返回", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let releaseDiagnosticWrite: (() => void) | undefined;
    let diagnosticWriteStarted = false;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-llm-async-diagnostics-online",
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
          diagnostic_log_sink: async () => {
            diagnosticWriteStarted = true;
            await new Promise<void>((resolve) => {
              releaseDiagnosticWrite = resolve;
            });
          },
          fetch: async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content:
                        '{"intent":"task","priority":"urgent","reason":"旧单层 triage 输出"}',
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
            ),
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
    });

    try {
      if (processor === undefined) {
        throw new Error("conversation processor must be captured");
      }

      const result = await processor({
        data: createConversationWorkerTask({
          bot_id: "bot-llm-async-diagnostics-online",
          message: {
            bot_id: "bot-llm-async-diagnostics-online",
            message_id: "msg-online-async-diagnostics",
            content: "去 10 64 -5",
            intent_epoch: 1,
            snapshot_ts: 1_713_952_800_000,
          },
        }),
      }).then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : "unknown"),
      );

      expect(result).toContain("triage must use composite schema");

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(diagnosticWriteStarted).toBe(true);

      const status = await runtime.services.http.server.inject({
        method: "GET",
        url: "/api/status?bot_id=bot-llm-async-diagnostics-online",
      });
      expect(status.json()).toMatchObject({
        bot: {
          llm: {
            diagnostic_sink: {
              queued: 0,
              in_flight: true,
              dropped_count: 0,
              error_count: 0,
            },
          },
        },
      });

      releaseDiagnosticWrite?.();
    } finally {
      releaseDiagnosticWrite?.();
      await runtime.close();
    }
  });
});
