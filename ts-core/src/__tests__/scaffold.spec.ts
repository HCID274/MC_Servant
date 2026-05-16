import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

import { describe, expect, it } from "vitest";

import * as TsCoreExports from "../index.js";
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
  createSessionRecord,
  createStatusResponse,
  createWorkerBullmqRuntime,
  createWorkerQueueCatalog,
  createWorldModelQueryBoundary,
  runDrizzleMigrations,
  toExecPriority,
} from "../index.js";
import { createSandboxFacadeContract } from "../sandbox/legacy/index.js";

describe("TS Core 工程骨架", () => {
  it("应导出全部模块边界并与模块名清单一致", () => {
    const moduleNames = coreModuleBoundaries.map((boundary) => boundary.moduleName);

    expect(moduleNames).toEqual([...CORE_MODULE_NAMES]);
  });

  it("应保留基础状态枚举与任务类型枚举", () => {
    expect(BotStatus.IDLE).toBe("idle");
    expect(ExecutionTaskKind.Code).toBe("code");
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
    expect(runtimeScaffold.supportedTaskKinds).toContain(ExecutionTaskKind.Code);
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

  it("根入口不应自然暴露 legacy（旧兼容） 执行面", () => {
    expect("createSandboxFacadeContract" in TsCoreExports).toBe(false);
    expect("createSandboxFacadePromptIndex" in TsCoreExports).toBe(false);
    expect("createSkillCall" in TsCoreExports).toBe(false);
    expect("executeSkillInvocation" in TsCoreExports).toBe(false);
    expect("executeMineflayerCraft" in TsCoreExports).toBe(false);
  });

  it("应显式从 legacy（旧兼容） 入口读取迁移诊断契约", () => {
    const facadeContract = createSandboxFacadeContract();
    const diagnosticsCatalog = createDiagnosticsCatalog();

    expect(facadeContract.bot.goTo.aligned_skill).toBe("goTo");
    expect(facadeContract.chat.say.emits_step).toBe(true);
    expect(diagnosticsCatalog.channels.map((channel) => channel.channel)).toEqual([
      "tasks",
      "sandbox",
      "llm",
      "metrics",
    ]);
  });

  it("测试主路径不应自然依赖旧 SkillCall / Facade / legacy 执行入口", () => {
    const testsRoot = join(process.cwd(), "src", "__tests__");
    const allowedLegacyTestFiles = new Set(["scaffold.spec.ts"]);
    const legacyPatterns = [
      'from "../skills/' + "legacy/",
      'from "../core-ports/' + "legacy/",
      'from "../sandbox/' + "legacy/",
      "create" + "LegacySkillCall",
      "execute" + "SkillInvocation",
    ];

    const offenders = listTestFiles(testsRoot).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const relativePath = relative(testsRoot, file);
      if (relativePath.startsWith("legacy/") || allowedLegacyTestFiles.has(relativePath)) {
        return [];
      }

      return legacyPatterns
        .filter((pattern) => source.includes(pattern))
        .map((pattern) => `${relativePath}: ${pattern}`);
    });

    expect(offenders).toEqual([]);
  });

  it("旧 api.bot / api.chat 只能出现在负向或 LLM prompt 防回归测试中", () => {
    const testsRoot = join(process.cwd(), "src", "__tests__");
    const allowedOldApiTestFiles = new Set([
      "conversation-llm-planning-model.spec.ts",
      "report-llm-model.spec.ts",
      "sandbox/security-precheck.spec.ts",
      "scaffold.spec.ts",
    ]);
    const oldApiPatterns = ["api" + ".bot", "api" + ".chat"];

    const offenders = listTestFiles(testsRoot).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const relativePath = relative(testsRoot, file);
      if (allowedOldApiTestFiles.has(relativePath)) {
        return [];
      }

      return oldApiPatterns
        .filter((pattern) => source.includes(pattern))
        .map((pattern) => `${relativePath}: ${pattern}`);
    });

    expect(offenders).toEqual([]);
  });

  it("非 legacy 测试不应继续使用旧 code invocation 任务形态", () => {
    const testsRoot = join(process.cwd(), "src", "__tests__");
    const legacyCodeInvocationPattern = "code" + "Invocation";

    const offenders = listTestFiles(testsRoot).flatMap((file) => {
      const relativePath = relative(testsRoot, file);
      if (relativePath.startsWith("legacy/")) {
        return [];
      }

      const source = readFileSync(file, "utf8");
      return source.includes(legacyCodeInvocationPattern) ? [relativePath] : [];
    });

    expect(offenders).toEqual([]);
  });

  it("测试 fixture 应进入 helpers 或 legacy 目录，不能留在根层伪装主路径", () => {
    const testsRoot = join(process.cwd(), "src", "__tests__");
    const rootFixtureNames = new Set([
      "test-code-job.ts",
      "test-skill-proofs.ts",
      "skills-legacy-model.spec.ts",
      "runtime-skill-legacy-execution-model.spec.ts",
    ]);

    const offenders = listTestFiles(testsRoot)
      .map((file) => relative(testsRoot, file))
      .filter((relativePath) => {
        const parts = relativePath.split("/");
        return parts.length === 1 && rootFixtureNames.has(parts[0] ?? "");
      });

    expect(offenders).toEqual([]);
  });

  it("transport 根装配不应直接依赖 terrain 内部 self-placed memory", () => {
    const srcRoot = join(process.cwd(), "src");
    const forbiddenPattern = "terrain/" + "self-placed-memory";

    const offenders = listTestFiles(srcRoot).flatMap((file) => {
      const relativePath = relative(srcRoot, file);
      if (
        relativePath.startsWith("__tests__/") ||
        relativePath.startsWith("runtime/transport/terrain/")
      ) {
        return [];
      }

      const source = readFileSync(file, "utf8");
      return source.includes(forbiddenPattern) ? [relativePath] : [];
    });

    expect(offenders).toEqual([]);
  });

  it("在线源码不应依赖 legacy 或 test-only 出口", () => {
    const srcRoot = join(process.cwd(), "src");
    const offenders = collectStaticImports(srcRoot)
      .filter((edge) => !edge.source.startsWith("__tests__/"))
      .filter((edge) => !isLegacySourcePath(edge.source))
      .filter((edge) => {
        const target = edge.resolvedSourcePath;
        return target !== null && (isLegacySourcePath(target) || isTestOnlySourcePath(target));
      })
      .map(formatImportEdge);

    expect(offenders).toEqual([]);
  });

  it("测试侧 legacy/test-only 豁免应保持窄边界", () => {
    const srcRoot = join(process.cwd(), "src");
    const offenders = collectStaticImports(srcRoot)
      .filter((edge) => edge.source.startsWith("__tests__/"))
      .filter((edge) => {
        const target = edge.resolvedSourcePath;
        if (target === null) {
          return false;
        }

        if (isLegacySourcePath(target)) {
          return !(
            edge.source.startsWith("__tests__/legacy/") || edge.source === "__tests__/scaffold.spec"
          );
        }

        if (isTestOnlySourcePath(target)) {
          return !edge.source.startsWith("__tests__/runtime/transport/");
        }

        return false;
      })
      .map(formatImportEdge);

    expect(offenders).toEqual([]);
  });

  it("业务源码应通过 mining/terrain 公共入口访问地形与采矿能力", () => {
    const srcRoot = join(process.cwd(), "src");
    const offenders = collectStaticImports(srcRoot)
      .filter((edge) => !edge.source.startsWith("__tests__/runtime/transport/"))
      .filter((edge) => {
        const target = edge.resolvedSourcePath;
        if (target === null) {
          return false;
        }

        if (isRuntimeTransportMiningInternalPath(target)) {
          return !edge.source.startsWith("runtime/transport/mining/");
        }

        if (isRuntimeTransportTerrainInternalPath(target)) {
          return !edge.source.startsWith("runtime/transport/terrain/");
        }

        return false;
      })
      .map(formatImportEdge);

    expect(offenders).toEqual([]);
  });

  it("sandbox 外部不应直接 import host bridge 内部实现", () => {
    const srcRoot = join(process.cwd(), "src");
    const offenders = collectStaticImports(srcRoot)
      .filter((edge) => {
        const target = edge.resolvedSourcePath;
        if (target === null || !isSandboxHostBridgeInternalPath(target)) {
          return false;
        }

        return !edge.source.startsWith("sandbox/");
      })
      .map(formatImportEdge);

    expect(offenders).toEqual([]);
  });

  it("测试 proof helper 不应提供默认成功 proof", () => {
    const helpersRoot = join(process.cwd(), "src", "__tests__", "helpers");
    const offenders = listTestFiles(helpersRoot).flatMap((file) => {
      const relativePath = relative(helpersRoot, file);
      const source = readFileSync(file, "utf8");
      const provenFactoryMatches = [
        ...source.matchAll(/export function (createTestOnlyProven\w+)/gu),
      ];
      const missingProofFactories = provenFactoryMatches
        .filter(
          (match) => !source.slice(match.index ?? 0, (match.index ?? 0) + 240).includes("proof:"),
        )
        .map((match) => `${relativePath}: ${match[1]} missing proof parameter`);
      const defaultProofFactories = [...source.matchAll(/proof\s*:[\s\S]{0,160}=\s*\{/gu)].map(
        () => `${relativePath}: proof parameter has a default value`,
      );

      return [...missingProofFactories, ...defaultProofFactories];
    });

    expect(offenders).toEqual([]);
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

function listTestFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      return listTestFiles(path);
    }
    return entry.endsWith(".ts") ? [path] : [];
  });
}

interface StaticImportEdge {
  readonly source: string;
  readonly line: number;
  readonly specifier: string;
  readonly resolvedSourcePath: string | null;
}

function collectStaticImports(srcRoot: string): StaticImportEdge[] {
  return listTestFiles(srcRoot).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const sourcePath = toSourcePath(relative(srcRoot, file));

    return source.split("\n").flatMap((line, index) =>
      readImportSpecifiersFromLine(line).map((specifier) => ({
        source: sourcePath,
        line: index + 1,
        specifier,
        resolvedSourcePath: resolveSourceImport(srcRoot, file, specifier),
      })),
    );
  });
}

function readImportSpecifiersFromLine(line: string): string[] {
  return [
    ...line.matchAll(/\bfrom\s+["']([^"']+)["']/gu),
    ...line.matchAll(/^\s*import\s+["']([^"']+)["']/gu),
    ...line.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gu),
  ].map((match) => String(match[1]));
}

function resolveSourceImport(
  srcRoot: string,
  importerFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const resolved = normalize(join(dirname(importerFile), specifier));
  return toSourcePath(relative(srcRoot, resolved));
}

function toSourcePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/\.(?:ts|tsx|js|jsx)$/u, "")
    .replace(/\/index$/u, "/index");
}

function isLegacySourcePath(path: string): boolean {
  return path.split("/").includes("legacy");
}

function isTestOnlySourcePath(path: string): boolean {
  return path.endsWith("/test-only") || path.split("/").includes("test-only");
}

function isRuntimeTransportMiningInternalPath(path: string): boolean {
  return path.startsWith("runtime/transport/mining/") && path !== "runtime/transport/mining/index";
}

function isRuntimeTransportTerrainInternalPath(path: string): boolean {
  return (
    path.startsWith("runtime/transport/terrain/") && path !== "runtime/transport/terrain/index"
  );
}

function isSandboxHostBridgeInternalPath(path: string): boolean {
  return (
    path === "sandbox/host-call" ||
    path === "sandbox/host-call-params" ||
    path === "sandbox/host-call-report"
  );
}

function formatImportEdge(edge: StaticImportEdge): string {
  return `${edge.source}:${edge.line} -> ${edge.specifier}`;
}
