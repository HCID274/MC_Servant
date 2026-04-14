import { describe, expect, it } from "vitest";

import {
  BotStatus,
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_LOGS_BASE_DIR,
  EVENT_LOG_RETENTION_DAYS,
  ExecutionTaskKind,
  JSONL_RETENTION_DAYS,
  POSTGRES_EXTENSION_CONTRACTS,
  POSTGRES_SCHEMA_CONTRACT,
  createBotConfigOverlay,
  createBotStateCache,
  createDataConfig,
  createDrizzleMigrationMetadata,
  createPostgresConnectionDescriptor,
  createRedisKeyCatalog,
} from "../index.js";

describe("db 与配置契约", () => {
  it("应统一解析环境变量默认值、主名与历史别名", () => {
    const defaults = createDataConfig();
    const aliased = createDataConfig({
      env: {
        LOGS_DIR: "./legacy-logs",
        EVENT_RETENTION: "45",
        TASK_LOG_RETENTION: "120",
        SANDBOX_LOG_RETENTION: "33",
        LLM_LOG_RETENTION: "14",
        EMBED_DIM: "1536",
        PG_PORT: "6543",
        PG_POOL_MIN: "4",
        PG_POOL_MAX: "12",
        REDIS_URL: "redis://cache:6379",
      },
    });
    const canonicalWins = createDataConfig({
      env: {
        LOGS_BASE_DIR: "./canonical-logs",
        LOGS_DIR: "./legacy-logs",
      },
    });

    expect(defaults.logs.baseDir).toBe(DEFAULT_LOGS_BASE_DIR);
    expect(defaults.logs.retention.eventLogDays).toBe(EVENT_LOG_RETENTION_DAYS);
    expect(defaults.logs.retention.taskLogDays).toBe(JSONL_RETENTION_DAYS.tasks);
    expect(defaults.logs.retention.sandboxLogDays).toBe(JSONL_RETENTION_DAYS.sandbox);
    expect(defaults.embedding.dimensions).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
    expect(aliased.logs.baseDir).toBe("./legacy-logs");
    expect(aliased.logs.retention.eventLogDays).toBe(45);
    expect(aliased.logs.retention.taskLogDays).toBe(120);
    expect(aliased.logs.retention.sandboxLogDays).toBe(33);
    expect(aliased.logs.retention.llmLogDays).toBe(14);
    expect(aliased.embedding.dimensions).toBe(1536);
    expect(aliased.postgres.port).toBe(6543);
    expect(aliased.postgres.pool.min).toBe(4);
    expect(aliased.postgres.pool.max).toBe(12);
    expect(aliased.redis.url).toBe("redis://cache:6379");
    expect(canonicalWins.logs.baseDir).toBe("./canonical-logs");
  });

  it("应以纯函数方式合并 Bot 级配置覆盖", () => {
    const baseConfig = createDataConfig();
    const overlay = createBotConfigOverlay({
      logs: {
        baseDir: "./bots/bot-alpha",
        retention: {
          taskLogDays: 30,
          llmLogDays: 7,
        },
      },
      embedding: {
        dimensions: 768,
      },
    });
    const mergedConfig = createDataConfig({
      botConfig: {
        logs: {
          baseDir: "./bots/bot-alpha",
          retention: {
            taskLogDays: 30,
            llmLogDays: 7,
          },
        },
        embedding: {
          dimensions: 768,
        },
      },
    });

    expect(baseConfig.logs.baseDir).toBe(DEFAULT_LOGS_BASE_DIR);
    expect(overlay.logs?.baseDir).toBe("./bots/bot-alpha");
    expect(mergedConfig.logs.baseDir).toBe("./bots/bot-alpha");
    expect(mergedConfig.logs.retention.eventLogDays).toBe(EVENT_LOG_RETENTION_DAYS);
    expect(mergedConfig.logs.retention.taskLogDays).toBe(30);
    expect(mergedConfig.logs.retention.llmLogDays).toBe(7);
    expect(mergedConfig.embedding.dimensions).toBe(768);
  });

  it("应拒绝无效环境变量与越界 Bot 配置", () => {
    expect(() =>
      createDataConfig({
        env: {
          PG_PORT: "0",
        },
      }),
    ).toThrow("PG_PORT must be a positive integer");
    expect(() =>
      createDataConfig({
        env: {
          PG_POOL_MIN: "8",
          PG_POOL_MAX: "4",
        },
      }),
    ).toThrow("PG_POOL_MIN must be less than or equal to PG_POOL_MAX");
    expect(() =>
      createBotConfigOverlay({
        redis: {
          url: "redis://cache:6379",
        },
      }),
    ).toThrow("Unsupported botConfig key: redis");
    expect(() =>
      createBotConfigOverlay({
        logs: {
          retention: {
            llmLogDays: 0,
          },
        },
      }),
    ).toThrow("botConfig.logs.retention.llmLogDays must be a positive integer");
  });

  it("应声明 PostgreSQL 元信息、迁移目录与 Redis 键规则", () => {
    const postgres = createPostgresConnectionDescriptor(
      createDataConfig({
        env: {
          PG_HOST: "db.internal",
          PG_DATABASE: "mc_servant",
          PG_USER: "servant",
          PG_PASSWORD: "secret",
          PG_PORT: "6432",
          PG_POOL_MIN: "3",
          PG_POOL_MAX: "9",
        },
      }).postgres,
    );
    const redisKeys = createRedisKeyCatalog("bot-007");
    const migrations = createDrizzleMigrationMetadata();

    expect(POSTGRES_SCHEMA_CONTRACT.businessSchema).toBe("mc_servant");
    expect(POSTGRES_SCHEMA_CONTRACT.readonlySchemas).toEqual([]);
    expect(POSTGRES_SCHEMA_CONTRACT.tables).toContain("task_history");
    expect(POSTGRES_EXTENSION_CONTRACTS.map((contract) => contract.name)).toEqual([
      "vector",
      "pg_trgm",
    ]);
    expect(postgres.host).toBe("db.internal");
    expect(postgres.port).toBe(6432);
    expect(postgres.schema).toBe("mc_servant");
    expect(postgres.requiredExtensions).toBe(POSTGRES_EXTENSION_CONTRACTS);
    expect(redisKeys.intentEpoch).toBe("bot:bot-007:intent_epoch");
    expect(redisKeys.state).toBe("bot:bot-007:state");
    expect(redisKeys.snapshot).toBe("bot:bot-007:snapshot");
    expect(redisKeys.queues.conversation).toBe("bull:msg:bot-007:*");
    expect(redisKeys.queues.exec).toBe("bull:bot:bot-007:exec:*");
    expect(redisKeys.queues.brain).toBe("bull:brain:*");
    expect(migrations.schemaDirectory).toBe("src/db/schema");
    expect(migrations.migrationsDirectory).toBe("src/db/migrations");
    expect(migrations.entrypoint).toBe("src/db/migrate.ts");
    expect(migrations.fileNamePattern).toBe(String.raw`^\d{4}_[a-z0-9_]+\.sql$`);
  });

  it("应校验 Redis 状态缓存结构", () => {
    const stateCache = createBotStateCache({
      state: BotStatus.EXECUTING,
      current_task: {
        job_id: "msg-007",
        type: ExecutionTaskKind.SandboxCode,
        intent: "mine oak_log",
        started_at: 1_712_930_000,
      },
      last_updated: 1_712_930_005,
    });

    expect(stateCache.cache_type).toBe("bot_state");
    expect(stateCache.current_task?.type).toBe(ExecutionTaskKind.SandboxCode);
    expect(() =>
      createBotStateCache({
        state: BotStatus.IDLE,
        current_task: {
          job_id: "",
          type: ExecutionTaskKind.SkillCall,
          intent: "say hi",
          started_at: 1,
        },
        last_updated: 2,
      }),
    ).toThrow("current_task.job_id must be a non-empty string");
  });
});
