import { randomUUID } from "node:crypto";

import {
  createBrainTaskCard,
  createDataConfig,
  createPostgresConnectionDescriptor,
  createPostgresRuntimeResource,
  createPostgresTaskEventPersister,
} from "../../src/index.js";
import { ExecutionTaskKind } from "../../src/core-ports/foundation.js";
import { ExecPriority, TaskHistoryStatus } from "../../src/core-ports/tasking.js";
import {
  createBrainWorkerRuntime,
  createBrainWorkerTask,
  createOpenAiCompatibleEmbeddingGenerator,
} from "../../src/workers/index.js";

interface QueryablePool {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];

  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = readOptionalEnv(name);

  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function redactEndpoint(value: string): string {
  try {
    const url = new URL(value);

    return `${url.origin}${url.pathname}`;
  } catch {
    return value.replace(/\?.*$/u, "");
  }
}

function createEmbeddingGeneratorFromEnvironment() {
  const endpointUrl = readOptionalEnv("EMBEDDING_ENDPOINT_URL");
  const baseUrl = readOptionalEnv("EMBEDDING_BASE_URL") ?? readOptionalEnv("LLM_BASE_URL");
  const apiKey = readOptionalEnv("EMBEDDING_API_KEY") ?? readOptionalEnv("LLM_API_KEY");
  const model = readOptionalEnv("EMBEDDING_MODEL") ?? "text-embedding-v4";
  const dimensions = readPositiveIntegerEnv("EMBEDDING_DIMENSIONS", 1024);

  if (apiKey === undefined) {
    throw new Error("EMBEDDING_API_KEY or LLM_API_KEY must be configured");
  }
  if (endpointUrl === undefined && baseUrl === undefined) {
    throw new Error("EMBEDDING_ENDPOINT_URL or EMBEDDING_BASE_URL must be configured");
  }

  return {
    endpoint: endpointUrl ?? `${baseUrl?.replace(/\/+$/u, "")}/embeddings`,
    dimensions,
    generateEmbedding: createOpenAiCompatibleEmbeddingGenerator({
      ...(endpointUrl === undefined ? { base_url: baseUrl } : { endpoint_url: endpointUrl }),
      api_key: apiKey,
      model,
      dimensions,
      timeout_ms: readPositiveIntegerEnv("EMBEDDING_TIMEOUT_MS", 15_000),
    }),
  };
}

async function seedTaskHistory(input: {
  readonly pool: QueryablePool;
  readonly botId: string;
  readonly taskId: string;
  readonly messageId: string;
  readonly ownerText: string;
}): Promise<void> {
  await input.pool.query(
    `
      INSERT INTO mc_servant.bots (id, bot_name, mc_server)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING
    `,
    [input.botId, input.botId, "probe"],
  );
  await input.pool.query(
    `
      INSERT INTO mc_servant.task_history (
        id, bot_id, type, intent_epoch, status, skill, params, snapshot_ts,
        started_at, finished_at, duration_ms, total_steps, message_id, created_at
      )
      VALUES ($1, $2, 'skill_call', 1, 'completed', 'collect', '{}'::jsonb, 1,
        now(), now(), 1, 1, $3, now())
    `,
    [input.taskId, input.botId, input.messageId],
  );
}

async function main(): Promise<void> {
  const embedding = createEmbeddingGeneratorFromEnvironment();
  const dataConfig = createDataConfig({ env: process.env });
  const postgres = await createPostgresRuntimeResource(
    createPostgresConnectionDescriptor(dataConfig.postgres),
  );
  const pool = postgres.pool as QueryablePool;
  const botId = readOptionalEnv("TS_CORE_BOT_ID") ?? "local-bot";
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const messageId = `brain-probe-${suffix}`;
  const taskId = messageId;
  const ownerText = readOptionalEnv("BRAIN_PROBE_OWNER_TEXT") ?? "把这个东西捡起来";
  let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;

  try {
    await seedTaskHistory({ pool, botId, taskId, messageId, ownerText });

    const runtime = createBrainWorkerRuntime({
      queue: {
        name: "brain",
        connection: {},
      },
      dependencies: {
        generateEmbedding: embedding.generateEmbedding,
        persistTaskEvent: createPostgresTaskEventPersister({ db: postgres.db }),
        now: () => new Date(),
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
      },
    });
    await runtime.start();
    await processor?.({
      data: createBrainWorkerTask({
        bot_id: botId,
        message_id: messageId,
        intent_epoch: 1,
        status: TaskHistoryStatus.Completed,
        owner_text: ownerText,
        task_card: createBrainTaskCard({
          task_id: taskId,
          message_id: messageId,
          intent_epoch: 1,
          snapshot_ts: 1,
          priority: ExecPriority.Normal,
          owner_text: ownerText,
          execution: {
            type: ExecutionTaskKind.SkillCall,
            skill: "collect",
            params: {},
          },
          result: {
            status: TaskHistoryStatus.Completed,
            duration_ms: 1,
            total_steps: 1,
          },
        }),
      }),
    });

    const result = await pool.query(
      `
        SELECT id, task_id, bot_id, message_id, owner_text, embedding IS NOT NULL AS has_embedding
        FROM mc_servant.task_events
        WHERE id = $1
      `,
      [`task-event:${botId}:${messageId}`],
    );
    const row = result.rows[0];
    if (row === undefined || row.has_embedding !== true) {
      throw new Error("task_events probe row was not persisted with embedding");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          endpoint: redactEndpoint(embedding.endpoint),
          dimensions: embedding.dimensions,
          event: row,
          runtime_events: runtime.getEvents(),
        },
        null,
        2,
      ),
    );
    await runtime.close();
  } finally {
    await postgres.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exitCode = 1;
});
