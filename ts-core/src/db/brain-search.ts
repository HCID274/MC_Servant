import type { BrainSearchHit, BrainSearchInput, BrainSearchResult } from "../data/index.js";

interface QueryablePostgresClient {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: unknown[] }> | { rows: unknown[] };
}

interface BrainSearchDatabase {
  readonly $client?: QueryablePostgresClient;
}

/** Brain search（大脑检索） 真实 PostgreSQL（关系型数据库） 端口。 */
export interface PostgresBrainSearchStore {
  search(input: BrainSearchInput): Promise<BrainSearchResult>;
}

/** 创建 PostgreSQL（关系型数据库） Brain search（大脑检索） 端口。 */
export function createPostgresBrainSearchStore(input: {
  readonly db: unknown;
  readonly generateEmbedding: (text: string) => Promise<readonly number[]>;
}): PostgresBrainSearchStore {
  return Object.freeze({
    async search(searchInput: BrainSearchInput): Promise<BrainSearchResult> {
      const normalized = normalizeSearchInput(searchInput);
      const embedding = await input.generateEmbedding(normalized.query);
      const rows = await asBrainSearchDatabase(input.db).$client?.query(SEARCH_SQL, [
        normalized.bot_id,
        normalized.query,
        `[${embedding.join(",")}]`,
        normalized.top_k,
      ]);

      return Object.freeze({
        hits: Object.freeze((rows?.rows ?? []).map(createBrainSearchHitFromRow)),
      });
    },
  });
}

function normalizeSearchInput(
  input: BrainSearchInput,
): Required<Pick<BrainSearchInput, "bot_id" | "query" | "top_k">> {
  const query = input.query.trim();
  if (input.bot_id.trim().length === 0) {
    throw new Error("brain.search bot_id must be non-empty");
  }
  if (query.length === 0) {
    throw new Error("brain.search query must be non-empty");
  }

  return Object.freeze({
    bot_id: input.bot_id,
    query,
    top_k: Math.min(Math.max(Math.trunc(input.top_k ?? 5), 1), 10),
  });
}

function createBrainSearchHitFromRow(row: unknown): BrainSearchHit {
  const record = row as Record<string, unknown>;

  return Object.freeze({
    id: String(record.id),
    task_id: String(record.task_id),
    owner_text: String(record.owner_text),
    ...(typeof record.takeaway === "string" ? { takeaway: record.takeaway } : {}),
    task_card: record.task_card,
    created_at:
      record.created_at instanceof Date
        ? record.created_at.toISOString()
        : String(record.created_at),
    score: typeof record.rrf_score === "number" ? record.rrf_score : Number(record.rrf_score ?? 0),
  });
}

function asBrainSearchDatabase(db: unknown): BrainSearchDatabase {
  const candidate = db as BrainSearchDatabase;

  if (candidate.$client === undefined || typeof candidate.$client.query !== "function") {
    throw new Error("Postgres db does not support brain.search query");
  }

  return candidate;
}

const SEARCH_SQL = `
WITH fts AS (
  SELECT id, task_id, owner_text, takeaway, task_card, created_at,
         row_number() OVER (ORDER BY ts_rank(search_tsv, plainto_tsquery('simple', $2)) DESC) AS r
  FROM mc_servant.task_events
  WHERE bot_id = $1
    AND search_tsv @@ plainto_tsquery('simple', $2)
  LIMIT 10
),
vec AS (
  SELECT id, task_id, owner_text, takeaway, task_card, created_at,
         row_number() OVER (ORDER BY embedding <=> $3::vector) AS r
  FROM mc_servant.task_events
  WHERE bot_id = $1
    AND embedding IS NOT NULL
  ORDER BY embedding <=> $3::vector
  LIMIT 10
),
merged AS (
  SELECT id, task_id, owner_text, takeaway, task_card, created_at,
         SUM(1.0 / (60 + r)) AS rrf_score
  FROM (
    SELECT * FROM fts
    UNION ALL
    SELECT * FROM vec
  ) combined
  GROUP BY id, task_id, owner_text, takeaway, task_card, created_at
)
SELECT id, task_id, owner_text, takeaway, task_card, created_at, rrf_score
FROM merged
ORDER BY rrf_score DESC
LIMIT $4
`;
