import { describe, expect, it } from "vitest";

import {
  BotStatus,
  CORE_MODULE_NAMES,
  ConversationPriority,
  ExecutionTaskKind,
  MessageSource,
  RUNTIME_EVENT_TYPES,
  assertAppLifecyclePlan,
  assertNonEmptyString,
  cloneReadonlyValue,
  coreModuleBoundaries,
  createAppBootstrapContract,
  createAppProcessRuntime,
  createAppRuntimeResources,
  createAppRuntimeServices,
  createAppSmokeAssembly,
  createAppStartupSummary,
  createDataConfig,
  createDiagnosticsCatalog,
  createDrizzleKitConfigSnapshot,
  createDrizzleMigrationMetadata,
  createEnvironmentSnapshot,
  createExternalAuthExecutionPlan,
  createExternalAuthPublicState,
  createExternalAuthSecretBinding,
  createExternalAuthState,
  createHealthResponse,
  createInterfaceExternalAuthSnapshot,
  createInterfaceServerRuntime,
  createMessageQueueName,
  createMessageTriage,
  createMinecraftDataFactsPort,
  createMineflayerRuntimeTransport,
  createMineflayerTransportDescriptor,
  createObservationRuntimeCache,
  createPostgresConnectionDescriptor,
  createPostgresRuntimePoolConfig,
  createRedisConnectionDescriptor,
  createRedisKeyCatalog,
  createRedisRuntimeClientOptions,
  createRuntimeReadyGate,
  createRuntimeScaffold,
  createSandboxFacadeContract,
  createSessionRecord,
  createStatusResponse,
  createWorkerBullmqRuntime,
  createWorkerQueueCatalog,
  createWorldModelQueryBoundary,
  runDrizzleMigrations,
  toExecPriority,
} from "../index.js";

describe("TS Core 工程骨架", () => {
  it("应导出全部模块边界并与模块名清单一致", () => {
    const moduleNames = coreModuleBoundaries.map((boundary) => boundary.moduleName);

    expect(moduleNames).toEqual([...CORE_MODULE_NAMES]);
  });

  it("应保留基础状态枚举与任务类型枚举", () => {
    expect(BotStatus.IDLE).toBe("idle");
    expect(ExecutionTaskKind.SkillCall).toBe("skill_call");
    expect(MessageSource.Web).toBe("web");
    expect(toExecPriority(ConversationPriority.Interrupt)).toBeNull();
    expect(() => assertNonEmptyString("bot-root", "botId")).not.toThrow();
    expect(Object.isFrozen(cloneReadonlyValue({ ok: true }))).toBe(true);
  });

  it("应能创建最小运行时骨架对象", () => {
    const runtimeScaffold = createRuntimeScaffold();

    expect(runtimeScaffold.defaultStatus).toBe(BotStatus.INITIALIZING);
    expect(runtimeScaffold.externalAuth.status).toBe("not_required");
    expect(runtimeScaffold.readyGate.status).toBe("blocked");
    expect(runtimeScaffold.supportedTaskKinds).toContain(ExecutionTaskKind.SkillCall);
    expect(runtimeScaffold.supportedTaskKinds).not.toContain("conversation");
    expect(runtimeScaffold.interruptTemplate.source.type).toBe("system");
    expect(RUNTIME_EVENT_TYPES).toContain("task.started");
  });

  it("应从根入口导出 observation 与 world-model 的真实契约构造器", () => {
    const snapshot = createEnvironmentSnapshot({
      mineflayer: {
        timestamp: 1,
        snapshot_version: "root-export",
        bot: {
          position: { x: 0, y: 64, z: 0 },
          health: 20,
          food: 20,
          experience: 0,
          is_on_fire: false,
          is_in_water: false,
          y_velocity: 0,
        },
        inventory: {
          items: [],
          total_items: 0,
          occupied_slots: 0,
          free_slots: 36,
        },
        equipment: {
          head: null,
          chest: null,
          legs: null,
          feet: null,
          main_hand: null,
          off_hand: null,
          has_weapon_equipped: false,
        },
        nearby_entities: [],
        nearby_blocks: [],
      },
    });
    const worldModel = createWorldModelQueryBoundary({
      anchor: snapshot.bot.position,
      snapshot_version: snapshot.snapshot_version,
      clusters: [],
    });

    expect(snapshot.snapshot_version).toBe("root-export");
    expect(worldModel.queryClusters("oak_log")).toEqual([]);
    expect(createMinecraftDataFactsPort("1.20.4").getBlockByName("oak_log")?.name).toBe("oak_log");
  });

  it("应从根入口导出 interfaces（接口层） 的最小纯契约", () => {
    const session = createSessionRecord({
      id: "session-root",
      owner_id: "owner-root",
      bot_id: "bot-root",
      token: "token-root",
      expires_at: "2026-04-20T00:00:00.000Z",
      created_at: "2026-04-13T00:00:00.000Z",
    });
    const health = createHealthResponse("2026-04-13T00:00:00.000Z");
    const status = createStatusResponse({
      bot: {
        bot_id: session.bot_id,
        status: BotStatus.IDLE,
        intent_epoch: 3,
        last_event_seq: 9,
        updated_at: "2026-04-13T00:00:00.000Z",
      },
    });
    const authSnapshot = createInterfaceExternalAuthSnapshot({
      status: BotStatus.INITIALIZING,
      external_auth: createExternalAuthState({
        status: "pending",
        secret: createExternalAuthSecretBinding({
          source: "env",
          reference: "MC_EXTERNAL_AUTH_SECRET",
          secret: "hunter2",
        }),
      }),
    });

    expect(session.bot_id).toBe("bot-root");
    expect(health.status).toBe("ok");
    expect(status.bot.status).toBe(BotStatus.IDLE);
    expect(authSnapshot.state.action_summary?.command_preview).toBe("/login <redacted>");
  });

  it("应从根入口导出 sandbox（沙箱） 与 diagnostics（诊断） 契约", () => {
    const facadeContract = createSandboxFacadeContract();
    const diagnosticsCatalog = createDiagnosticsCatalog();

    expect(facadeContract.bot.goTo.aligned_skill).toBe("goTo");
    expect(facadeContract.chat.say.emits_step).toBe(true);
    expect(diagnosticsCatalog.channels.map((channel) => channel.channel)).toEqual([
      "tasks",
      "sandbox",
      "llm",
    ]);
  });

  it("应从根入口导出 conversation（对话） 与 workers（工作线程） 契约", () => {
    const triage = createMessageTriage({
      intent: "task",
      priority: "urgent",
      reason: "root_export",
    });
    const queueCatalog = createWorkerQueueCatalog("bot-root");

    expect(triage.intent).toBe("task");
    expect(queueCatalog.conversation.queue).toBe(createMessageQueueName("bot-root"));
    expect(queueCatalog.bot.queue).toBe("bot:bot-root:exec");
    expect(queueCatalog.brain.queue).toBe("brain");
    expect(typeof createWorkerBullmqRuntime).toBe("function");
  });

  it("应从根入口导出 db（数据库） 与 data（数据） 的基础设施契约", () => {
    const config = createDataConfig({
      env: {
        LOGS_BASE_DIR: "./root-logs",
        EMBEDDING_DIMENSIONS: "1536",
      },
    });
    const postgres = createPostgresConnectionDescriptor(config.postgres);
    const redisConnection = createRedisConnectionDescriptor(config.redis);
    const redisKeys = createRedisKeyCatalog("bot-root");
    const migrations = createDrizzleMigrationMetadata({ postgres });
    const drizzleKitConfig = createDrizzleKitConfigSnapshot(migrations);

    expect(config.logs.baseDir).toBe("./root-logs");
    expect(config.embedding.dimensions).toBe(1536);
    expect(createPostgresRuntimePoolConfig(postgres).host).toBe("localhost");
    expect(redisConnection.bullmq_compatible).toBe(true);
    expect(createRedisRuntimeClientOptions().maxRetriesPerRequest).toBeNull();
    expect(redisKeys.intentEpoch).toBe("bot:bot-root:intent_epoch");
    expect(redisKeys.queues.exec).toBe("bull:bot:bot-root:exec:*");
    expect(migrations.migrationsDirectory).toBe("src/db/migrations");
    expect(drizzleKitConfig.schema).toBe("src/data/schema.ts");
    expect(typeof runDrizzleMigrations).toBe("function");
  });

  it("应从根入口导出 app（应用装配） 的组合根契约", () => {
    const bootstrap = createAppBootstrapContract({
      botId: "bot-root",
      now: "2026-04-14T00:00:00.000Z",
    });
    const smoke = createAppSmokeAssembly({
      botId: "bot-root",
      now: "2026-04-14T00:00:00.000Z",
    });

    expect(() => assertAppLifecyclePlan(bootstrap.lifecycle)).not.toThrow();
    expect(bootstrap.interfaces.routes[0].path).toBe("/api/health");
    expect(bootstrap.migrations.entrypoint).toBe("src/db/migrate.ts");
    expect(bootstrap.resources.redis.reuse_for).toBe("bullmq_shared_connection");
    expect(bootstrap.services.http.listen).toEqual({
      host: "0.0.0.0",
      port: 3000,
    });
    expect(bootstrap.runtime.initial_status).toBe(BotStatus.INITIALIZING);
    expect(bootstrap.auth.state.status).toBe("not_required");
    expect(smoke.runtime.initial_status).toBe(BotStatus.INITIALIZING);
    expect(smoke.resources.close_order).toEqual(["redis", "postgres"]);
    expect(smoke.runtime_resources.close_order).toEqual([
      "bot_actor",
      "mineflayer_transport",
      "observation",
    ]);
    expect(smoke.services.close_order).toEqual(["http", "workers"]);
    expect(smoke.health.status).toBe("ok");
    expect(createAppStartupSummary(bootstrap).io_boundary.connects_real_io).toBe(false);
    expect(typeof createAppRuntimeResources).toBe("function");
    expect(typeof createAppRuntimeServices).toBe("function");
    expect(typeof createAppProcessRuntime).toBe("function");
    expect(typeof createInterfaceServerRuntime).toBe("function");
    expect(typeof createMineflayerRuntimeTransport).toBe("function");
    expect(typeof createObservationRuntimeCache).toBe("function");
    expect(createMineflayerTransportDescriptor({ botId: "bot-root" }).host).toBe("localhost");
  });

  it("应从根入口导出外部认证执行计划、脱敏状态与就绪门控", () => {
    const secret = createExternalAuthSecretBinding({
      source: "env",
      reference: "MC_EXTERNAL_AUTH_SECRET",
      secret: "hunter2",
    });
    const pendingState = createExternalAuthState({
      status: "pending",
      secret,
    });
    const executionPlan = createExternalAuthExecutionPlan(pendingState, secret);
    const publicState = createExternalAuthPublicState(pendingState);
    const readyGate = createRuntimeReadyGate({
      status: BotStatus.INITIALIZING,
      externalAuth: pendingState,
    });

    expect(pendingState).not.toHaveProperty("secret");
    expect(executionPlan.next_action?.command).toBe("/login hunter2");
    expect(publicState.action_summary?.command_preview).toBe("/login <redacted>");
    expect(readyGate.blocked_by).toContain("external_auth_pending");
  });
});
