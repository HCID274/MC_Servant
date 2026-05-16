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
describe("app/entrypoint online task planning 行为", () => {
  it("应在真实在线入口把自然语言坐标任务接到 LLM（大语言模型） 分诊与规划，并入 goTo（前往坐标） 执行队列", async () => {
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const queueAdds: Array<{ name: string; jobName: string; data: unknown; options: unknown }> = [];
    const taskHistoryInserts: unknown[] = [];
    const memoryProviderCalls: unknown[] = [];
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-plan-online",
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
            const assistantContent = userMessage.includes("主人的指令：")
              ? '{"code":"await reply(\\"收到，我这就过去喵~\\"); const task = await runGoal(\\"去目标坐标\\", async () => { await goTo(10,64,-5); }); await report(task);"}'
              : '{"action":{"intent":"task","priority":"urgent","reason":"主人给了明确坐标移动指令"}}';

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
            createDrizzle: () => ({
              insert: () => ({
                values: (row: unknown) => ({
                  onConflictDoNothing: async () => {
                    taskHistoryInserts.push(row);
                  },
                }),
              }),
              update: () => ({
                set: () => ({
                  where: async () => undefined,
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
          memoryContextProvider: (input) => {
            memoryProviderCalls.push(input);

            return "历史：主人上次要求到点后汇报坐标。";
          },
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
        bot_id: "bot-plan-online",
        message: {
          bot_id: "bot-plan-online",
          message_id: "msg-online-plan",
          content: "请去坐标 x=10 y=64 z=-5",
          intent_epoch: 3,
          snapshot_ts: 1_713_952_800_002,
        },
      }),
    });

    expect(llmRequests).toHaveLength(2);
    expect(memoryProviderCalls).toEqual([
      expect.objectContaining({
        bot_id: "bot-plan-online",
        message_id: "msg-online-plan",
        intent_epoch: 3,
        message_content: "请去坐标 x=10 y=64 z=-5",
        route_kind: "plan_exec",
        query_reason: "主人给了明确坐标移动指令",
      }),
    ]);
    const planRequestBody = llmRequests[1]?.body as {
      messages?: Array<{ role: string; content: string }>;
    };
    expect(planRequestBody.messages?.[1]?.content).toContain(
      "记忆摘要：历史：主人上次要求到点后汇报坐标。",
    );
    expect(queueAdds).toEqual([
      {
        name: "bot:bot-plan-online:exec",
        jobName: "bot",
        data: expect.objectContaining({
          worker: "bot",
          bot_id: "bot-plan-online",
          exec_job: expect.objectContaining({
            message_id: "msg-online-plan",
            priority: "urgent",
            type: "code",
            code: expect.stringContaining("goTo(10,64,-5)"),
          }),
        }),
        options: {
          jobId: "msg-online-plan",
          priority: 1,
        },
      },
      {
        name: "brain",
        jobName: "brain",
        data: expect.objectContaining({
          worker: "brain",
          payload: expect.objectContaining({
            kind: "conversation_fact",
            bot_id: "bot-plan-online",
            message_id: "msg-online-plan",
            owner_text: "请去坐标 x=10 y=64 z=-5",
            route_kind: "plan_exec",
          }),
        }),
        options: {
          jobId: "conversation-fact-msg-online-plan",
        },
      },
    ]);
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-plan-online",
      message_id: "msg-online-plan",
      exec_type: "code",
      priority: "urgent",
    });
    expect(taskHistoryInserts).toEqual([
      expect.objectContaining({
        id: "msg-online-plan",
        botId: "bot-plan-online",
        status: TaskHistoryStatus.Accepted,
        type: "code",
        codeRef: expect.stringMatching(/^sandbox\/\d{4}-\d{2}-\d{2}\/msg-online-plan\.code\.ts$/u),
        logRef: expect.stringMatching(/^sandbox\/\d{4}-\d{2}-\d{2}\/msg-online-plan\.jsonl$/u),
      }),
    ]);
    const statusResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/status?bot_id=bot-plan-online",
    });

    expect(statusResponse.json()).toMatchObject({
      bot: {
        llm: {
          stage: "plan",
          message_id: "msg-online-plan",
          status: "ok",
          model: "bl-auto",
          log_ref: "llm/2026-04-24/plan-msg-online-plan.jsonl",
        },
      },
    });

    await runtime.close();
  });

  it("应在真实在线入口把 mine（挖掘）/collect（捡拾）/cutTree（砍树）/equip（装备） 规划成代码任务", async () => {
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const queueAdds: Array<{ name: string; jobName: string; data: unknown; options: unknown }> = [];
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-skill-online",
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
            const currentInstruction = userMessage.split("主人的指令：").at(-1) ?? userMessage;
            let assistantContent =
              '{"action":{"intent":"task","priority":"normal","reason":"主人给了明确技能指令"}}';

            if (userMessage.includes("主人的指令：")) {
              if (currentInstruction.includes("挖两块石头")) {
                assistantContent =
                  '{"code":"await reply(\\"收到，我去挖石头喵~\\"); const task = await runGoal(\\"挖石头\\", async () => { const result = await mine(\\"stone\\", 2); if (result.ok === false) { throw new Error(result.error.code); } }); await report(task);"}';
              } else if (currentInstruction.includes("把地上的圆石捡起来")) {
                assistantContent =
                  '{"code":"await reply(\\"收到，我去捡圆石喵~\\"); const task = await runGoal(\\"捡圆石\\", async () => { const result = await collect(\\"cobblestone\\", 32); if (result.ok === false) { throw new Error(result.error.code); } }); await report(task);"}';
              } else if (currentInstruction.includes("把石镐拿在手上")) {
                assistantContent =
                  '{"code":"await reply(\\"收到，我先把石镐拿在手上喵~\\"); const task = await runGoal(\\"装备石镐\\", async () => { const result = await equip(\\"stone_pickaxe\\", \\"hand\\"); if (result.ok === false) { throw new Error(result.error.code); } }); await report(task);"}';
              } else if (currentInstruction.includes("砍 12 块木头")) {
                assistantContent =
                  '{"code":"await reply(\\"收到，我去砍 12 块木头喵~\\"); const task = await runGoal(\\"砍 12 块木头\\", async () => { const result = await cutTree(12); if (result.ok === false) { throw new Error(result.error.code); } }); await report(task);"}';
              } else {
                assistantContent =
                  '{"code":"await reply(\\"暂时无法规划喵~\\"); const task = await runGoal(\\"无法规划\\", async () => { throw new Error(\\"unsupported_capability\\"); }); await report(task);"}';
              }
            }

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
        bot_id: "bot-skill-online",
        message: {
          bot_id: "bot-skill-online",
          message_id: "msg-online-mine",
          content: "去挖两块石头",
          intent_epoch: 5,
          snapshot_ts: 1_713_952_800_010,
        },
      }),
    });
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-skill-online",
        message: {
          bot_id: "bot-skill-online",
          message_id: "msg-online-collect",
          content: "把地上的圆石捡起来",
          intent_epoch: 6,
          snapshot_ts: 1_713_952_800_011,
        },
      }),
    });
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-skill-online",
        message: {
          bot_id: "bot-skill-online",
          message_id: "msg-online-equip",
          content: "把石镐拿在手上",
          intent_epoch: 7,
          snapshot_ts: 1_713_952_800_012,
        },
      }),
    });
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-skill-online",
        message: {
          bot_id: "bot-skill-online",
          message_id: "msg-online-cut-tree",
          content: "砍 12 块木头",
          intent_epoch: 8,
          snapshot_ts: 1_713_952_800_013,
        },
      }),
    });

    expect(llmRequests).toHaveLength(8);
    expect(queueAdds).toEqual([
      {
        name: "bot:bot-skill-online:exec",
        jobName: "bot",
        data: expect.objectContaining({
          worker: "bot",
          bot_id: "bot-skill-online",
          exec_job: expect.objectContaining({
            message_id: "msg-online-mine",
            priority: "normal",
            type: "code",
            code: expect.stringContaining('mine("stone", 2)'),
          }),
        }),
        options: {
          jobId: "msg-online-mine",
          priority: 5,
        },
      },
      {
        name: "brain",
        jobName: "brain",
        data: expect.objectContaining({
          worker: "brain",
          payload: expect.objectContaining({
            kind: "conversation_fact",
            bot_id: "bot-skill-online",
            message_id: "msg-online-mine",
            owner_text: "去挖两块石头",
            route_kind: "plan_exec",
          }),
        }),
        options: {
          jobId: "conversation-fact-msg-online-mine",
        },
      },
      {
        name: "bot:bot-skill-online:exec",
        jobName: "bot",
        data: expect.objectContaining({
          worker: "bot",
          bot_id: "bot-skill-online",
          exec_job: expect.objectContaining({
            message_id: "msg-online-collect",
            priority: "normal",
            type: "code",
            code: expect.stringContaining('collect("cobblestone", 32)'),
          }),
        }),
        options: {
          jobId: "msg-online-collect",
          priority: 5,
        },
      },
      {
        name: "brain",
        jobName: "brain",
        data: expect.objectContaining({
          worker: "brain",
          payload: expect.objectContaining({
            kind: "conversation_fact",
            bot_id: "bot-skill-online",
            message_id: "msg-online-collect",
            owner_text: "把地上的圆石捡起来",
            route_kind: "plan_exec",
          }),
        }),
        options: {
          jobId: "conversation-fact-msg-online-collect",
        },
      },
      {
        name: "bot:bot-skill-online:exec",
        jobName: "bot",
        data: expect.objectContaining({
          worker: "bot",
          bot_id: "bot-skill-online",
          exec_job: expect.objectContaining({
            message_id: "msg-online-equip",
            priority: "normal",
            type: "code",
            code: expect.stringContaining('equip("stone_pickaxe", "hand")'),
          }),
        }),
        options: {
          jobId: "msg-online-equip",
          priority: 5,
        },
      },
      {
        name: "brain",
        jobName: "brain",
        data: expect.objectContaining({
          worker: "brain",
          payload: expect.objectContaining({
            kind: "conversation_fact",
            bot_id: "bot-skill-online",
            message_id: "msg-online-equip",
            owner_text: "把石镐拿在手上",
            route_kind: "plan_exec",
          }),
        }),
        options: {
          jobId: "conversation-fact-msg-online-equip",
        },
      },
      {
        name: "bot:bot-skill-online:exec",
        jobName: "bot",
        data: expect.objectContaining({
          worker: "bot",
          bot_id: "bot-skill-online",
          exec_job: expect.objectContaining({
            message_id: "msg-online-cut-tree",
            priority: "normal",
            type: "code",
            code: expect.stringContaining("cutTree(12)"),
          }),
        }),
        options: {
          jobId: "msg-online-cut-tree",
          priority: 5,
        },
      },
      {
        name: "brain",
        jobName: "brain",
        data: expect.objectContaining({
          worker: "brain",
          payload: expect.objectContaining({
            kind: "conversation_fact",
            bot_id: "bot-skill-online",
            message_id: "msg-online-cut-tree",
            owner_text: "砍 12 块木头",
            route_kind: "plan_exec",
          }),
        }),
        options: {
          jobId: "conversation-fact-msg-online-cut-tree",
        },
      },
    ]);
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-skill-online",
      message_id: "msg-online-mine",
      exec_type: "code",
      priority: "normal",
    });
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-skill-online",
      message_id: "msg-online-collect",
      exec_type: "code",
      priority: "normal",
    });
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-skill-online",
      message_id: "msg-online-equip",
      exec_type: "code",
      priority: "normal",
    });
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-skill-online",
      message_id: "msg-online-cut-tree",
      exec_type: "code",
      priority: "normal",
    });

    await runtime.close();
  });
});
