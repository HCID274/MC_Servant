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

describe("app/entrypoint server bridge 与 websocket", () => {
  it("应把 server-bridge 主人发话时坐标透传到 BrainWorker rubric（评分规则）", async () => {
    const rubricInputs: unknown[] = [];
    let fakeBot: FakeEntrypointMineflayerBot | undefined;
    let conversationProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let brainProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let capturedBrainTask: BrainWorkerTask | undefined;
    const serverBridge = createAppServerBridgeConfigFromEnvironment({
      env: {
        SERVER_BRIDGE_ACCESS_TOKEN: "local-dev-token",
        SERVER_BRIDGE_CONVERSATION_ENABLED: "true",
      },
    });

    if (serverBridge === undefined) {
      throw new Error("test server bridge config must be enabled");
    }

    const runtime = await startAppOnlineRuntime({
      bootstrap: createAppBootstrapContract({
        botId: "bot-owner-position-memory",
        now: "2026-05-03T00:00:00.000Z",
      }),
      dependencies: {
        serverBridge: {
          ...serverBridge,
          now: () => "2026-05-03T00:00:10.000Z",
        },
        brainWorker: {
          now: () => new Date("2026-05-03T00:01:00.000Z"),
          async generateEmbedding() {
            return [0.1, 0.2, 0.3];
          },
          async persistTaskEvent() {
            return undefined;
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

              return [
                {
                  kind: "MEMORY",
                  content: "家的位置坐标：x=120, y=64, z=-300",
                  confidence: 0.91,
                  reason: "主人发话时站在这里",
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
          async insertMemoryCandidate() {
            return undefined;
          },
          async decideMemoryCandidate() {
            return undefined;
          },
          async writeBotMemory() {
            return undefined;
          },
          async appendMemoryAudit() {
            return undefined;
          },
          createWorker: ({ processor }) => {
            brainProcessor = processor;

            return {
              close: async () => undefined,
            };
          },
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
              add: async (_jobName, data, options) => {
                if (name === "msg:bot-owner-position-memory") {
                  setTimeout(() => {
                    void conversationProcessor?.({ data });
                  }, 0);
                }
                if (name === "bot:bot-owner-position-memory:exec") {
                  throw new Error("location memory must not enter bot exec queue");
                }
                if (name === "brain") {
                  capturedBrainTask = data as BrainWorkerTask;
                }

                return { id: String(options?.jobId ?? "job-online") };
              },
              close: async () => undefined,
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalListen = server.listen.bind(server);
              const originalClose = server.close.bind(server);

              server.listen = async () => originalListen({ host: "127.0.0.1", port: 0 });
              server.close = async () => originalClose();

              return server;
            },
          },
        },
        runtime: {
          transport: {
            createBot: () => {
              fakeBot = new FakeEntrypointMineflayerBot([]);
              fakeBot.setOwnerPosition("Steve", { x: 120, y: 64, z: -300 });

              setTimeout(() => fakeBot?.emit("spawn"), 0);

              return fakeBot;
            },
          },
        },
        botWorker: {
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
        conversationWorker: {
          triage: () =>
            createConversationCompositeTriage({
              chat: {},
            }),
          replyGenerator: () =>
            Promise.resolve({
              mode: "llm" as const,
              reply: "我记住这里了喵~",
            }),
          createWorker: ({ processor }) => {
            conversationProcessor = processor;

            return {
              close: async () => undefined,
            };
          },
        },
      },
    });
    const socket = new WebSocket(
      `${runtime.listen_address.replace(/^http/, "ws")}/ws/server-bridge`,
      {
        headers: {
          Authorization: "Bearer local-dev-token",
        },
      },
    );

    try {
      await waitForWsOpen(socket);
      socket.send(
        JSON.stringify({
          type: "hello",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          mod_id: "mcservant",
          mod_version: "0.4.0",
          connected_at: "2026-05-03T00:00:01.000Z",
          instance_id: "local-fabric-01",
        }),
      );
      expect(JSON.parse(await readNextWsText(socket))).toMatchObject({
        type: "ack",
        ack_type: "hello",
      });

      socket.send(
        JSON.stringify({
          type: "player_message",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          instance_id: "local-fabric-01",
          message_id: "msg-owner-position-memory",
          player_uuid: "00000000-0000-0000-0000-000000000001",
          player_name: "Steve",
          content: "这里是我们的家",
          timestamp: "2026-05-03T00:00:03.000Z",
        }),
      );
      expect(JSON.parse(await readNextWsText(socket))).toMatchObject({
        type: "ack",
        ack_type: "player_message",
      });
      await expect
        .poll(() => capturedBrainTask?.payload)
        .toMatchObject({
          kind: "conversation_fact",
          owner_position_at_message: { x: 120, y: 64, z: -300 },
        });

      fakeBot?.setOwnerPosition("Steve", { x: 999, y: 70, z: 999 });
      await brainProcessor?.({ data: capturedBrainTask });
      expect(rubricInputs).toMatchObject([
        {
          source: "conversation_fact",
          owner_text: "这里是我们的家",
          owner_position: { x: 120, y: 64, z: -300 },
        },
      ]);
    } finally {
      socket.close();
      await waitForWsClose(socket);
      await runtime.close();
    }
  });

  it("应在真实在线入口装配 server-bridge WebSocket 并写入 /api/replay", async () => {
    const queueAdds: Array<{ queue: string; jobId: unknown }> = [];
    const serverBridge = createAppServerBridgeConfigFromEnvironment({
      env: {
        SERVER_BRIDGE_ACCESS_TOKEN: "local-dev-token",
      },
    });

    if (serverBridge === undefined) {
      throw new Error("test server bridge config must be enabled");
    }

    const bootstrap = createAppBootstrapContract({
      botId: "bot-bridge-online",
      now: "2026-04-27T00:00:00.000Z",
    });
    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        brainWorker: createNoopBrainWorkerDependencies(),
        serverBridge: {
          ...serverBridge,
          now: () => "2026-04-27T00:00:10.000Z",
          eventIdFactory: () => "server-bridge-event",
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
              add: async (_jobName, _data, options) => {
                queueAdds.push({ queue: name, jobId: options?.jobId });

                return { id: "job-online" };
              },
              close: async () => undefined,
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalListen = server.listen.bind(server);
              const originalClose = server.close.bind(server);

              server.listen = async () => originalListen({ host: "127.0.0.1", port: 0 });
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
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
      },
    });
    const socket = new WebSocket(
      `${runtime.listen_address.replace(/^http/, "ws")}/ws/server-bridge`,
      {
        headers: {
          Authorization: "Bearer local-dev-token",
        },
      },
    );

    try {
      await waitForWsOpen(socket);

      socket.send(
        JSON.stringify({
          type: "hello",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          mod_id: "mcservant",
          mod_version: "0.4.0",
          connected_at: "2026-04-27T00:00:01.000Z",
          instance_id: "local-fabric-01",
        }),
      );
      const helloAck = JSON.parse(await readNextWsText(socket));

      socket.send(
        JSON.stringify({
          type: "heartbeat",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          instance_id: "local-fabric-01",
          sequence: 1,
          timestamp: "2026-04-27T00:00:02.000Z",
          state: "CONNECTED",
        }),
      );
      const heartbeatAck = JSON.parse(await readNextWsText(socket));

      socket.send(
        JSON.stringify({
          type: "player_message",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          instance_id: "local-fabric-01",
          message_id: "msg-svs-online-1",
          player_uuid: "00000000-0000-0000-0000-000000000001",
          player_name: "Steve",
          content: "hello",
          timestamp: "2026-04-27T00:00:03.000Z",
        }),
      );
      const playerAck = JSON.parse(await readNextWsText(socket));
      const replayResponse = await runtime.services.http.server.inject({
        method: "GET",
        url: "/api/replay?bot_id=bot-bridge-online&after_seq=0&limit=10",
      });
      const replayBody = replayResponse.json();
      const replayText = JSON.stringify(replayBody);

      expect(helloAck).toMatchObject({ type: "ack", ack_type: "hello" });
      expect(heartbeatAck).toMatchObject({ type: "ack", ack_type: "heartbeat" });
      expect(playerAck).toMatchObject({ type: "ack", ack_type: "player_message" });
      expect(replayResponse.statusCode).toBe(200);
      expect(replayBody).toMatchObject({
        bot_id: "bot-bridge-online",
        after_seq: 0,
        limit: 10,
        state: {
          last_event_seq: 4,
        },
        events: [
          {
            seq: 1,
            bot_id: "bot-bridge-online",
            type: "server_bridge.connected",
            payload: {
              runtime_effect: "observe_only",
              connection_state: "connected",
            },
          },
          {
            seq: 2,
            bot_id: "bot-bridge-online",
            type: "server_bridge.hello",
            payload: {
              runtime_effect: "observe_only",
              mod_id: "mcservant",
              instance_id: "local-fabric-01",
            },
          },
          {
            seq: 3,
            bot_id: "bot-bridge-online",
            type: "server_bridge.heartbeat",
            payload: {
              runtime_effect: "observe_only",
              sequence: 1,
              state: "CONNECTED",
            },
          },
          {
            seq: 4,
            bot_id: "bot-bridge-online",
            type: "server_bridge.player_message",
            payload: {
              runtime_effect: "observe_only",
              message_id: "msg-svs-online-1",
              player_uuid: "00000000-0000-0000-0000-000000000001",
              player_name: "Steve",
              content: "hello",
            },
          },
        ],
      });
      expect(replayText).not.toContain("local-dev-token");
      expect(queueAdds).toEqual([]);
    } finally {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
        await waitForWsClose(socket);
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
      await runtime.close();
    }
  });

  it("应在显式启用后把 /svs 玩家消息接入 ConversationWorker 并经 BotActor 写回聊天", async () => {
    const chats: string[] = [];
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const interrupts: unknown[] = [];
    const queueAdds: Array<{ queue: string; jobName: string; jobId: unknown; data: unknown }> = [];
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const serverBridge = createAppServerBridgeConfigFromEnvironment({
      env: {
        SERVER_BRIDGE_ACCESS_TOKEN: "local-dev-token",
        SERVER_BRIDGE_CONVERSATION_ENABLED: "true",
      },
    });

    if (serverBridge === undefined) {
      throw new Error("test server bridge config must be enabled");
    }

    const bootstrap = createAppBootstrapContract({
      botId: "bot-bridge-conversation",
      now: "2026-04-27T00:00:00.000Z",
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
            const assistantContent = userMessage.includes("Bot 状态：") ? '{"chat":{}}' : "你好呀";

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
          now: () => new Date("2026-04-27T00:00:10.000Z"),
        },
        serverBridge: {
          ...serverBridge,
          now: () => "2026-04-27T00:00:10.000Z",
          eventIdFactory: () => "server-bridge-conversation-event",
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
                queueAdds.push({ queue: name, jobName, jobId: options?.jobId, data });
                if (name === "msg:bot-bridge-conversation") {
                  setTimeout(() => {
                    void processor?.({ data });
                  }, 0);
                }

                return { id: String(options?.jobId ?? "job-online") };
              },
              close: async () => undefined,
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalListen = server.listen.bind(server);
              const originalClose = server.close.bind(server);

              server.listen = async () => originalListen({ host: "127.0.0.1", port: 0 });
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
          interruptRuntimeSink: async ({ signal }) => {
            interrupts.push(signal);
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
    const socket = new WebSocket(
      `${runtime.listen_address.replace(/^http/, "ws")}/ws/server-bridge`,
      {
        headers: {
          Authorization: "Bearer local-dev-token",
        },
      },
    );

    try {
      await waitForWsOpen(socket);
      socket.send(
        JSON.stringify({
          type: "hello",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          mod_id: "mcservant",
          mod_version: "0.4.0",
          connected_at: "2026-04-27T00:00:01.000Z",
          instance_id: "local-fabric-01",
        }),
      );
      expect(JSON.parse(await readNextWsText(socket))).toMatchObject({
        type: "ack",
        ack_type: "hello",
      });

      socket.send(
        JSON.stringify({
          type: "player_message",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          instance_id: "local-fabric-01",
          message_id: "msg-svs-chat",
          player_uuid: "00000000-0000-0000-0000-000000000001",
          player_name: "Steve",
          content: "你好",
          timestamp: "2026-04-27T00:00:03.000Z",
        }),
      );
      expect(JSON.parse(await readNextWsText(socket))).toMatchObject({
        type: "ack",
        ack_type: "player_message",
      });
      await expect.poll(() => chats).toContain("chat:你好呀喵~");

      socket.send(
        JSON.stringify({
          type: "player_message",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          instance_id: "local-fabric-01",
          message_id: "msg-svs-cancel",
          player_uuid: "00000000-0000-0000-0000-000000000001",
          player_name: "Steve",
          content: "取消",
          timestamp: "2026-04-27T00:00:04.000Z",
        }),
      );
      expect(JSON.parse(await readNextWsText(socket))).toMatchObject({
        type: "ack",
        ack_type: "player_message",
      });
      await expect.poll(() => chats).toContain("chat:好的，已经停下来了喵~");
      const replayResponse = await runtime.services.http.server.inject({
        method: "GET",
        url: "/api/replay?bot_id=bot-bridge-conversation&after_seq=0&limit=20",
      });
      const replayBody = replayResponse.json();

      await expect
        .poll(() => queueAdds.map((item) => [item.queue, item.jobName, item.jobId]))
        .toEqual([
          ["msg:bot-bridge-conversation", "conversation", "msg-svs-chat"],
          ["brain", "brain", "conversation-fact-msg-svs-chat"],
        ]);
      expect(queueAdds.map((item) => [item.queue, item.jobName, item.jobId])).toEqual([
        ["msg:bot-bridge-conversation", "conversation", "msg-svs-chat"],
        ["brain", "brain", "conversation-fact-msg-svs-chat"],
      ]);
      expect(
        queueAdds
          .filter((item) => item.queue === "brain")
          .every((item) => typeof item.jobId === "string" && !item.jobId.includes(":")),
      ).toBe(true);
      expect(llmRequests).toHaveLength(2);
      expect(interrupts).toEqual([]);
      expect(replayBody.events.map((event: { type: string }) => event.type)).toEqual([
        "server_bridge.connected",
        "server_bridge.hello",
        "server_bridge.player_message",
        "task.accepted",
        "chat.reply",
        "server_bridge.player_message",
        "chat.reply",
      ]);
      expect(replayBody.events).toContainEqual(
        expect.objectContaining({
          type: "task.accepted",
          payload: expect.objectContaining({
            job_id: "msg-svs-chat",
            message_id: "msg-svs-chat",
            source: "server_bridge",
          }),
        }),
      );
    } finally {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
        await waitForWsClose(socket);
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
      await runtime.close();
    }
  });

  it("应把在线 blockUpdate（方块更新） 自动接入 ResourceService（资源服务） 缓存更新", async () => {
    let now = 1_712_000_300;
    const eventSource = new EventEmitter();
    const resourceService = createResourceService({
      now: () => now,
      worldKeyPort: {
        getCurrentWorldKey: () => "multiworld:resource",
      },
      refreshPort: {
        async refreshAroundBot(resourceKey, radius) {
          return {
            resource_key: resourceKey,
            radius,
            status: "found",
            world_key: "multiworld:resource",
            snapshot_version: "resource-online-block-update",
            scanned_at: now,
            origin: { x: 0, y: 64, z: 0 },
            blocks: [
              {
                block_name: "oak_log",
                position: { x: 0, y: 64, z: 0 },
                distance: 1,
                resource_keys: [resourceKey],
              },
              {
                block_name: "oak_log",
                position: { x: 1, y: 64, z: 0 },
                distance: 2,
                resource_keys: [resourceKey],
              },
              {
                block_name: "oak_log",
                position: { x: 2, y: 64, z: 0 },
                distance: 3,
                resource_keys: [resourceKey],
              },
            ],
            diagnostics: [],
          };
        },
      },
    });
    await resourceService.refresh("tree", 16);
    expect(resourceService.query("tree").clusters.map((cluster) => cluster.block_count)).toEqual([
      3,
    ]);

    const subscription = bindOnlineResourceServiceBlockUpdates({
      runtime: {
        observation: createObservationRuntimeCache(),
        transport: {
          getEventSource: () => eventSource,
          readObservationInput: () => null,
        },
      },
      resourceService,
      readOwnerName: () => undefined,
    });

    now += 1;
    eventSource.emit(
      "blockUpdate",
      { name: "oak_log", position: { x: 1, y: 64, z: 0 } },
      { name: "air", position: { x: 1, y: 64, z: 0 } },
    );

    expect(
      resourceService
        .query("tree")
        .clusters.map((cluster) => cluster.block_count)
        .sort(),
    ).toEqual([1, 1]);

    subscription?.close();
    now += 1;
    eventSource.emit(
      "blockUpdate",
      { name: "oak_log", position: { x: 0, y: 64, z: 0 } },
      { name: "air", position: { x: 0, y: 64, z: 0 } },
    );

    expect(
      resourceService
        .query("tree")
        .clusters.map((cluster) => cluster.block_count)
        .sort(),
    ).toEqual([1, 1]);
  });
});
