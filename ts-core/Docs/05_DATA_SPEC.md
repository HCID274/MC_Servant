# DATA_SPEC.md — 数据模型与持久化规格

> v0.1 | 2026.04 | 依赖 ARCHITECTURE.md v0.2, RUNTIME_SPEC.md v0.1, SANDBOX_SPEC.md v0.1, CONVERSATION_SPEC.md v0.1

---

## 0. 本文档的职责边界

本文档定义系统的全部持久化方案：PostgreSQL schema（Drizzle ORM）、JSONL 日志格式、pgvector 集成、冷热分离策略、数据生命周期管理。

**本文档不涉及**：Redis 队列的内部数据结构（BullMQ 自行管理）、observation 内存缓存结构（见 RUNTIME_SPEC.md 第 8.4 节）、LLM prompt 组装逻辑（见 CONVERSATION_SPEC.md）。

---

## 1. 持久化分层总览

```
┌─────────────────────────────────────────────────────────────┐
│                     持久化分层                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  PostgreSQL（唯一业务真理源）                                 │
│  ├─ mc_servant schema                                       │
│  │   ├─ owners              身份                            │
│  │   ├─ bots                Bot 配置                        │
│  │   ├─ owner_bots          绑定关系                        │
│  │   ├─ chat_messages       对话历史                        │
│  │   ├─ event_log           全量事件流                       │
│  │   ├─ task_history        任务记录                        │
│  │   ├─ task_summaries      Level 1 摘要 + embedding        │
│  │   └─ session_summaries   Level 2 聚合摘要                │
│  │                                                          │
│  └─ 外部认证源（部署相关，只读适配）                           │
│      └─ 例如 EasyAuth + SQLite                                │
│         MC 服务器登录验证                                      │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Redis（队列引擎 + 短时缓存）                                │
│  ├─ BullMQ 队列数据          自动管理，不手动操作             │
│  ├─ bot:{botId}:intent_epoch 意图纪元计数器                  │
│  └─ bot:{botId}:state        BotActor 状态缓存               │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  本地文件系统（冷日志）                                       │
│  ├─ logs/tasks/              任务执行 JSONL                  │
│  ├─ logs/sandbox/            沙箱执行 JSONL + 原始代码        │
│  └─ logs/llm/                LLM 原始 I/O JSONL              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. PostgreSQL Schema 设计

### 2.1 Schema 隔离

```sql
CREATE SCHEMA IF NOT EXISTS mc_servant;
```

所有业务表在 `mc_servant` schema 下。

MC（Minecraft） 服务器登录认证不属于 TS Core（TypeScript 单核心） 的业务真理源。Phase 1（第一阶段） 将其建模为**外部认证源**：

- TS Core（TypeScript 单核心） 不接管、不迁移、不双写外部认证数据；
- 若需要读取注册状态、最近认证时间或用户名映射，只能通过只读适配层访问；
- 当前已知部署样例为 EasyAuth（离线服认证模组） + SQLite（嵌入式数据库），但设计上不得写死为某一种模组或某一种表结构；
- 机器人自动登录所需的明文密码必须由 TS Core（TypeScript 单核心） 独立持有或由部署注入，不能依赖外部认证库中的密码哈希反推。

### 2.2 扩展依赖

```sql
CREATE EXTENSION IF NOT EXISTS vector;        -- pgvector
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- 三元组索引（模糊搜索备用）
```

### 2.3 全表一览

按依赖顺序排列（被依赖的表在前）：

---

#### owners

```sql
CREATE TABLE mc_servant.owners (
  id            TEXT PRIMARY KEY,                -- UUID v7
  username      TEXT UNIQUE NOT NULL,            -- MC 用户名
  password_hash TEXT NOT NULL,                   -- bcrypt hash
  display_name  TEXT,                            -- 显示名
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

轻身份模式。Phase 1 不接第三方 OAuth，不做邮箱验证。注册即可用。

---

#### bots

```sql
CREATE TABLE mc_servant.bots (
  id            TEXT PRIMARY KEY,                -- UUID v7
  bot_name      TEXT UNIQUE NOT NULL,            -- Bot 在 MC 内的用户名
  persona       TEXT NOT NULL DEFAULT 'catmaid', -- 人设标识，Phase 1 只有 'catmaid'
  mc_server     TEXT NOT NULL,                   -- MC 服务器地址 host:port
  config        JSONB NOT NULL DEFAULT '{}',     -- Bot 级配置覆盖
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`config` JSONB 存放 Bot 级别的配置覆盖（如反射阈值、超时参数）。应用层读取时先读环境变量默认值，再用 `config` 中的同名键覆盖。

---

#### owner_bots

```sql
CREATE TABLE mc_servant.owner_bots (
  owner_id    TEXT NOT NULL REFERENCES mc_servant.owners(id),
  bot_id      TEXT NOT NULL REFERENCES mc_servant.bots(id),
  bound_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, bot_id)
);

-- Phase 1 约束：一个 owner 只绑一个 bot，一个 bot 只绑一个 owner
CREATE UNIQUE INDEX idx_owner_bots_owner ON mc_servant.owner_bots (owner_id);
CREATE UNIQUE INDEX idx_owner_bots_bot   ON mc_servant.owner_bots (bot_id);
```

双向唯一索引强制一主一 Bot。Phase 2 多 Bot 时只需删掉 `idx_owner_bots_owner` 索引。

---

#### sessions

```sql
CREATE TABLE mc_servant.sessions (
  id            TEXT PRIMARY KEY,                -- UUID v7
  owner_id      TEXT NOT NULL REFERENCES mc_servant.owners(id),
  bot_id        TEXT NOT NULL REFERENCES mc_servant.bots(id),
  token         TEXT UNIQUE NOT NULL,            -- 登录 token（随机 base64）
  expires_at    TIMESTAMPTZ NOT NULL,            -- 默认 7 天后
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_token ON mc_servant.sessions (token) WHERE expires_at > now();
```

轻身份：登录生成 token，7 天有效，过期重登。不用 JWT——token 直接查表验证，支持即时吊销。

---

#### chat_messages

```sql
CREATE TABLE mc_servant.chat_messages (
  id            BIGSERIAL PRIMARY KEY,
  bot_id        TEXT NOT NULL REFERENCES mc_servant.bots(id),
  session_id    TEXT,                            -- 可空，游戏端消息无 session
  role          TEXT NOT NULL CHECK (role IN ('user', 'bot')),
  content       TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('web', 'game', 'system')),
  message_id    TEXT UNIQUE NOT NULL,            -- 去重键
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_bot_session ON mc_servant.chat_messages (bot_id, session_id, created_at DESC);
CREATE INDEX idx_chat_bot_recent  ON mc_servant.chat_messages (bot_id, created_at DESC);
```

`session_id` 可空：游戏端 `/svs` 消息没有 web session，此时 session_id 为 null，用 `idx_chat_bot_recent` 索引检索。

---

#### event_log

```sql
CREATE TABLE mc_servant.event_log (
  seq           BIGSERIAL PRIMARY KEY,
  bot_id        TEXT NOT NULL,
  session_id    TEXT,
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_event_log_bot_seq  ON mc_servant.event_log (bot_id, seq);
CREATE INDEX idx_event_log_bot_type ON mc_servant.event_log (bot_id, type, created_at DESC);
```

append-only。不更新、不删除。断线补拉通过 `bot_id + seq` 范围查询实现。

**type 枚举值**（与 RUNTIME_SPEC.md 第 9 节一致）：

```
bot.ready, bot.died, bot.respawned, bot.offline,
state.transition,
task.accepted, task.started, task.discarded,
step.progress,
task.completed, task.failed, task.interrupted,
reflex.triggered, reflex.done,
intent.epoch_changed,
chat.reply
```

Phase 1 不对 type 做 PG enum 约束——用 TEXT，避免加新事件类型时需要 `ALTER TYPE`。type 的合法值由应用层 TypeScript 枚举控制。

---

#### task_history

```sql
CREATE TABLE mc_servant.task_history (
  id              TEXT PRIMARY KEY,              -- 同 BullMQ jobId = message_id
  bot_id          TEXT NOT NULL REFERENCES mc_servant.bots(id),
  type            TEXT NOT NULL CHECK (type IN ('skill_call', 'sandbox_code')),
  intent_epoch    INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN (
                    'accepted', 'started', 'completed', 'failed', 'interrupted', 'discarded'
                  )),
  skill           TEXT,                          -- skill_call 时有值
  params          JSONB,                         -- skill_call 时有值
  code_ref        TEXT,                          -- sandbox_code 时有值，指向 .code.ts 文件
  log_ref         TEXT,                          -- 指向 JSONL 日志文件
  snapshot_ts     BIGINT NOT NULL,               -- 规划时的快照时间戳
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  duration_ms     INTEGER,
  total_steps     INTEGER,
  error           JSONB,                         -- 失败时的错误信息
  interrupt_source JSONB,                        -- 被中断时的中断来源
  message_id      TEXT NOT NULL,                 -- 原始用户消息 ID
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_task_bot_time   ON mc_servant.task_history (bot_id, created_at DESC);
CREATE INDEX idx_task_bot_status ON mc_servant.task_history (bot_id, status);
```

每个 ExecJob 进入 exec 队列时创建记录（status=accepted），BotWorker 更新状态流转。

`log_ref` 和 `code_ref` 是相对路径指针（如 `tasks/2026-04-12/T-abc123.jsonl`），不是绝对路径。应用层拼接 `LOGS_BASE_DIR + log_ref` 得到完整路径。这样日志目录搬迁不需要更新数据库。

---

#### task_summaries

```sql
CREATE TABLE mc_servant.task_summaries (
  id              TEXT PRIMARY KEY,              -- UUID v7
  task_id         TEXT NOT NULL REFERENCES mc_servant.task_history(id),
  bot_id          TEXT NOT NULL,
  intent          TEXT NOT NULL,                 -- 一句话意图描述
  status          TEXT NOT NULL,                 -- completed / failed / interrupted
  summary         TEXT NOT NULL,                 -- Level 1 摘要（50-150 字）
  embedding       vector(1024),                  -- pgvector 向量（BrainWorker 异步填充）
  log_ref         TEXT,                          -- 冗余字段，快速定位原始日志
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 全文搜索索引
ALTER TABLE mc_servant.task_summaries
  ADD COLUMN summary_tsv TSVECTOR
  GENERATED ALWAYS AS (
    to_tsvector('simple', summary)
  ) STORED;

CREATE INDEX idx_summary_fts       ON mc_servant.task_summaries USING gin (summary_tsv);

-- 向量搜索索引（HNSW，Phase 1 数据量小，IVFFlat 不如 HNSW）
CREATE INDEX idx_summary_embedding ON mc_servant.task_summaries
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_summary_bot_time  ON mc_servant.task_summaries (bot_id, created_at DESC);
```

**tsvector 配置说明**：使用 `'simple'` 字典而非 `'chinese'`。理由：PG 内置不含中文分词器，`zhparser` 等第三方扩展需要额外安装和维护。`'simple'` 对中文做逐字切分，在短文本（50-150 字摘要）上配合 LIKE 前缀匹配已经够用。Phase 2 如果 FTS 精度不足，再引入 `pg_bigm` 或 `zhparser`。

**HNSW 索引参数**：`m=16, ef_construction=64` 是 pgvector 官方推荐的小数据集默认值。10 万条以内性能 < 10ms。

---

#### session_summaries

```sql
CREATE TABLE mc_servant.session_summaries (
  id              TEXT PRIMARY KEY,              -- UUID v7
  bot_id          TEXT NOT NULL,
  summary         TEXT NOT NULL,                 -- Level 2 聚合摘要（≤100 字）
  task_ids        TEXT[] NOT NULL,               -- 指向被聚合的 task_summaries
  embedding       vector(1024),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE mc_servant.session_summaries
  ADD COLUMN summary_tsv TSVECTOR
  GENERATED ALWAYS AS (
    to_tsvector('simple', summary)
  ) STORED;

CREATE INDEX idx_session_summary_fts ON mc_servant.session_summaries USING gin (summary_tsv);
CREATE INDEX idx_session_summary_emb ON mc_servant.session_summaries
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_session_summary_bot ON mc_servant.session_summaries (bot_id, created_at DESC);
```

Level 2 摘要。BrainWorker 定期聚合产出。`task_ids` 数组保留回溯链路——需要细节时沿着 `task_ids` 查 `task_summaries`，再沿 `log_ref` 查原始 JSONL。

---

### 2.4 Drizzle ORM Schema 示例

完整 Drizzle schema 文件放在 `src/db/schema/` 目录下，每个表一个文件。此处给出关键表的 Drizzle 定义示例：

```typescript
// src/db/schema/task-summaries.ts
import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core'
import { vector } from 'drizzle-orm/pg-core'  // drizzle-orm 原生 pgvector 支持

export const taskSummaries = pgTable('task_summaries', {
  id:         text('id').primaryKey(),
  taskId:     text('task_id').notNull(),
  botId:      text('bot_id').notNull(),
  intent:     text('intent').notNull(),
  status:     text('status').notNull(),
  summary:    text('summary').notNull(),
  embedding:  vector('embedding', { dimensions: 1024 }),
  logRef:     text('log_ref'),
  createdAt:  timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  botTimeIdx: index('idx_summary_bot_time').on(table.botId, table.createdAt),
}))
```

tsvector 生成列和 GIN/HNSW 索引通过 Drizzle 的 `sql` 原始 SQL 在 migration 文件中创建，不在 schema 定义中——Drizzle 对这些高级特性的声明式支持尚不完善。

---

## 3. 记忆检索查询

### 3.1 混合检索 SQL

ConversationWorker 发起的混合检索，一条 SQL 完成两路合并：

```sql
WITH fts AS (
  SELECT id, task_id, intent, status, summary, created_at,
         ts_rank(summary_tsv, plainto_tsquery('simple', $2)) AS fts_rank
  FROM mc_servant.task_summaries
  WHERE bot_id = $1
    AND summary_tsv @@ plainto_tsquery('simple', $2)
  ORDER BY fts_rank DESC
  LIMIT 5
),
vec AS (
  SELECT id, task_id, intent, status, summary, created_at,
         1 - (embedding <=> $3::vector) AS vec_score
  FROM mc_servant.task_summaries
  WHERE bot_id = $1
    AND embedding IS NOT NULL
  ORDER BY embedding <=> $3::vector
  LIMIT 5
),
merged AS (
  SELECT *,
         COALESCE(fts_rank, 0) * 0.6 + COALESCE(vec_score, 0) * 0.4 AS hybrid_score
  FROM (
    SELECT id, task_id, intent, status, summary, created_at,
           fts_rank, NULL::float AS vec_score FROM fts
    UNION ALL
    SELECT id, task_id, intent, status, summary, created_at,
           NULL::float AS fts_rank, vec_score FROM vec
  ) combined
)
SELECT DISTINCT ON (id)
  id, task_id, intent, status, summary, created_at, hybrid_score
FROM merged
ORDER BY id, hybrid_score DESC  -- 去重时保留高分
```

外层再按 `hybrid_score DESC` 排序取 Top-N：

```sql
SELECT * FROM (
  -- 上面的 CTE
) deduped
ORDER BY hybrid_score DESC
LIMIT $4
```

### 3.2 FTS 短路优化

```typescript
async function hybridSearch(
  botId: string,
  query: string,
  queryEmbedding: number[],
  limit: number
): Promise<MemoryEntry[]> {
  // 1. 先发 FTS
  const ftsResults = await ftsSearch(botId, query, 5)

  // 2. 如果 FTS 已有 ≥3 条高置信度结果，跳过向量检索
  const highConfidence = ftsResults.filter(r => r.ftsRank > 0.3)
  if (highConfidence.length >= 3) {
    return highConfidence.slice(0, limit)
  }

  // 3. 否则并发向量检索 + 合并
  const vecResults = await vectorSearch(botId, queryEmbedding, 5)
  return mergeAndRank(ftsResults, vecResults, limit)
}
```

---

## 4. JSONL 日志规格

### 4.1 目录结构

```
logs/
├── tasks/
│   └── 2026-04-12/
│       ├── T-abc123.jsonl          # 任务执行日志
│       └── T-def456.jsonl
├── sandbox/
│   └── 2026-04-12/
│       ├── T-abc123.jsonl          # 沙箱执行日志（Facade 调用详情）
│       └── T-abc123.code.ts        # LLM 生成的原始 TS 代码
└── llm/
    └── 2026-04-12/
        ├── triage-msg001.jsonl     # Stage 1 分诊调用
        ├── chat-msg001.jsonl       # Stage 2 闲聊调用
        └── plan-msg002.jsonl       # Stage 2 规划调用
```

按日期分目录。每个任务/每次 LLM 调用一个独立文件。文件名含任务 ID 或消息 ID，便于定位。

### 4.2 任务执行日志格式（tasks/）

每行一个 JSON 对象，字段尽量精简：

```jsonl
{"t":1712930000,"e":"task.started","job":"T-abc123","type":"sandbox_code","epoch":7}
{"t":1712930001,"e":"step","i":0,"act":"goTo","p":{"x":100,"y":64,"z":200},"s":"ok","ms":5200}
{"t":1712930006,"e":"step","i":1,"act":"mine","p":{"target":"oak_log","count":5},"s":"ok","r":{"collected":5},"ms":16000}
{"t":1712930022,"e":"step","i":2,"act":"say","p":{"msg":"木头砍好了喵~"},"s":"ok","ms":50}
{"t":1712930022,"e":"task.completed","job":"T-abc123","steps":3,"ms":22000}
```

字段约定：

| 字段 | 含义 | 必需 |
|------|------|------|
| `t` | Unix 时间戳（秒） | 是 |
| `e` | 事件类型 | 是 |
| `job` | 任务 ID | 任务事件必需 |
| `i` | 步骤索引 | step 事件必需 |
| `act` | 动作名 | step 事件必需 |
| `p` | 参数（压缩 key） | 可选 |
| `s` | 状态：`ok` / `err` / `abort` | step 事件必需 |
| `r` | 返回值 | 成功时可选 |
| `ms` | 耗时（毫秒） | 可选 |
| `err` | 错误信息 | 失败时必需 |

**压缩原则**：key 用缩写（`t` 而非 `timestamp`），value 不压缩（可读性优先）。JSONL 是给人 debug 看的，省字段名节省的空间在磁盘上微不足道，但可读性不能牺牲太多。

### 4.3 沙箱执行日志格式（sandbox/）

比任务日志更细粒度，记录沙箱内部的每一步：

```jsonl
{"t":1712930000,"phase":"precheck","ok":true}
{"t":1712930000,"phase":"transpile","ok":true,"ms":0.8}
{"t":1712930001,"phase":"isolate_create","mem_mb":128}
{"t":1712930001,"phase":"facade_call","m":"goTo","p":{"x":100,"y":64,"z":200}}
{"t":1712930006,"phase":"facade_result","m":"goTo","s":"ok","ms":5200}
{"t":1712930006,"phase":"console","lvl":"log","args":["找到了5棵树"]}
{"t":1712930022,"phase":"sandbox_done","steps":3,"ms":22000}
```

### 4.4 LLM I/O 日志格式（llm/）

每次 LLM 调用的完整 prompt 和响应：

```jsonl
{"t":1712930000,"stage":"triage","model":"minimax-xxx","msg_id":"msg001"}
{"t":1712930000,"role":"system","content":"你是一个消息分类器..."}
{"t":1712930000,"role":"user","content":"Bot 状态：idle\n---\n[主人] 帮我砍树"}
{"t":1712930001,"role":"assistant","content":"{\"intent\":\"task\",\"priority\":\"normal\",\"reason\":\"用户要求采集\"}"}
{"t":1712930001,"meta":{"input_tokens":120,"output_tokens":35,"ms":800,"ok":true}}
```

每次调用按 `{stage}-{message_id}.jsonl` 命名。一个用户消息如果触发了 Triage + Plan 两次 LLM 调用，会产出两个文件。

### 4.5 日志写入实现

```typescript
import { createWriteStream, WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

class JsonlWriter {
  private stream: WriteStream | null = null
  private filePath: string

  constructor(baseDir: string, fileName: string) {
    const dateDir = new Date().toISOString().slice(0, 10) // 2026-04-12
    this.filePath = join(baseDir, dateDir, fileName)
  }

  async init(): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true })
    this.stream = createWriteStream(this.filePath, { flags: 'a' })
  }

  append(record: Record<string, unknown>): void {
    if (!this.stream) throw new Error('Writer not initialized')
    this.stream.write(JSON.stringify(record) + '\n')
  }

  close(): void {
    this.stream?.end()
    this.stream = null
  }
}
```

`flags: 'a'` 追加模式。进程崩溃时，已写入的行不会损坏（操作系统保证逐行 write 的原子性，只要单行不超过 PIPE_BUF 大小，Linux 下为 4096 字节）。

---

## 5. 冷热分离策略

### 5.1 热数据（PostgreSQL）

| 数据 | 保留策略 | 理由 |
|------|---------|------|
| chat_messages | 无限期保留 | 数据量小（每天几百条），是对话记忆的源 |
| event_log | 保留 30 天 | 断线补拉和审计需要近期数据，30 天前的可清理 |
| task_history | 无限期保留 | 条数少（每天几十条），是任务索引的源 |
| task_summaries | 无限期保留 | RAG 检索的核心数据，不能删 |
| session_summaries | 无限期保留 | 同上 |

### 5.2 冷数据（JSONL 文件）

| 数据 | 保留策略 | 理由 |
|------|---------|------|
| tasks/ JSONL | 保留 90 天 | 90 天前的原始日志实际价值极低 |
| sandbox/ JSONL + .code.ts | 保留 90 天 | 同上 |
| llm/ JSONL | 保留 30 天 | LLM 调用日志主要用于短期调试 |

### 5.3 清理脚本

```bash
#!/bin/bash
# scripts/cleanup-logs.sh
# 由 cron 每天凌晨 3 点执行

LOGS_DIR="/home/ts-core/logs"

# 清理 90 天前的任务日志
find "$LOGS_DIR/tasks" -name "*.jsonl" -mtime +90 -delete
find "$LOGS_DIR/sandbox" -name "*.jsonl" -mtime +90 -delete
find "$LOGS_DIR/sandbox" -name "*.code.ts" -mtime +90 -delete

# 清理 30 天前的 LLM 日志
find "$LOGS_DIR/llm" -name "*.jsonl" -mtime +30 -delete

# 清理空目录
find "$LOGS_DIR" -type d -empty -delete
```

```bash
# scripts/cleanup-events.sh
# 清理 30 天前的 event_log

psql -c "DELETE FROM mc_servant.event_log WHERE created_at < now() - interval '30 days';"
```

Phase 1 用 cron + shell 脚本。不做复杂的日志轮转框架。

---

## 6. event_log 查询模式

event_log 是全系统的审计和补拉数据源。主要查询模式：

### 6.1 断线补拉

```sql
-- 客户端重连后，拉取 last_seen_seq 之后的事件
SELECT seq, type, payload, created_at
FROM mc_servant.event_log
WHERE bot_id = $1
  AND seq > $2
ORDER BY seq ASC
LIMIT 50
```

### 6.2 任务完整事件流

```sql
-- 查看某个任务的全部事件
SELECT seq, type, payload, created_at
FROM mc_servant.event_log
WHERE bot_id = $1
  AND payload->>'job_id' = $2
ORDER BY seq ASC
```

### 6.3 崩溃恢复：检测未闭合任务

```sql
-- 找到 started 但没有 completed/failed/interrupted 的任务
SELECT payload->>'job_id' AS job_id, created_at
FROM mc_servant.event_log
WHERE bot_id = $1
  AND type = 'task.started'
  AND NOT EXISTS (
    SELECT 1 FROM mc_servant.event_log e2
    WHERE e2.bot_id = $1
      AND e2.payload->>'job_id' = mc_servant.event_log.payload->>'job_id'
      AND e2.type IN ('task.completed', 'task.failed', 'task.interrupted')
  )
ORDER BY created_at DESC
LIMIT 5
```

---

## 7. BrainWorker 数据写入流

BrainWorker 从 `brain` 队列取出任务后的写入顺序：

```
BrainWorker 取出压缩任务
    │
    ▼
1. 读取 task_history 记录（获取 log_ref）
    │
2. 读取 JSONL 原始日志（通过 log_ref）
    │
3. 调用 LLM 生成摘要（50-150 字）
    │
4. 调用 Embedding API 生成向量
    │
5. 写入 task_summaries 表
    │  （summary + embedding 一次写入，避免二次更新）
    │
6. 检查是否需要 Level 2 聚合
    │  条件：同 bot 的 Level 1 摘要累计 >10 条且未被聚合
    │
    ├─ 不需要 → done
    │
    └─ 需要 → 调用 LLM 聚合摘要
              → 调用 Embedding API
              → 写入 session_summaries 表
              → done
```

### 7.1 BrainWorker 的 LLM Prompt（摘要生成）

```
将以下任务执行日志压缩为一段 50-150 字的中文摘要。

要求：
- 保留：做了什么、结果如何、遇到了什么问题、关键地点/物品
- 去掉：具体坐标数字、重复的中间步骤、时间戳
- 如果任务失败或被中断，必须说明原因

日志：
{JSONL 内容，截取最多 50 行}
```

### 7.2 BrainWorker 的 LLM Prompt（Level 2 聚合）

```
将以下多个任务摘要聚合为一段 ≤100 字的会话概要。

要求：
- 概括这段时间内 Bot 的主要活动和成果
- 保留关键事件和转折点
- 去掉重复描述

任务摘要列表：
{Level 1 摘要列表}
```

---

## 8. Redis 数据约定

Redis 不是业务真理源，宕机后所有数据可从 PG 恢复（BullMQ 队列数据除外，队列中的 job 会丢失，但用户可重发消息）。

### 8.1 Key 命名规范

```
bot:{botId}:intent_epoch       -- INTEGER, 单调递增
bot:{botId}:state              -- JSON string, BotActor 当前状态快照
bot:{botId}:snapshot           -- JSON string, observation 最新快照（可选缓存）
```

### 8.2 BullMQ 队列 Key

BullMQ 自动管理以下 key pattern，不手动操作：

```
bull:msg:{botId}:*             -- ConversationWorker 队列
bull:bot:{botId}:exec:*        -- BotWorker 队列
bull:brain:*                   -- BrainWorker 队列
```

### 8.3 state 缓存结构

```typescript
interface BotStateCache {
  state: BotActorState             // 'idle' | 'executing' | ...
  current_task?: {
    job_id: string
    type: string
    intent: string
    started_at: number
  }
  last_updated: number
}
```

`GET /api/status` 直接读这个缓存，不查 PG。BotActor 每次状态转换时更新。

---

## 9. 数据一致性约定

### 9.1 写入顺序

任务生命周期中的写入严格按以下顺序：

```
1. task_history INSERT (status=accepted)     ← msg 队列入队时
2. event_log INSERT (task.accepted)          ← 同上
3. task_history UPDATE (status=started)      ← BotWorker 取出时
4. event_log INSERT (task.started)           ← 同上
5. event_log INSERT (step.progress) × N     ← 每步
6. JSONL append × N                         ← 每步
7. task_history UPDATE (status=completed/failed/interrupted)  ← 结束时
8. event_log INSERT (task.completed/failed/interrupted)       ← 同上
9. brain 队列 push                          ← 同上
10. task_summaries INSERT                    ← BrainWorker 异步
```

### 9.2 事务边界

Phase 1 不使用跨表事务。每步写入是独立的。理由：

- event_log 是 append-only，不存在回滚需求
- task_history 的状态更新是单向流转（accepted → started → completed），不存在并发冲突
- PG 和 JSONL 之间天然无法事务一致，但 JSONL 是冷日志，PG 是真理源，不一致时以 PG 为准

唯一可能的不一致：进程在步骤 7 和步骤 8 之间崩溃（task_history 更新了但 event_log 没写入）。崩溃恢复时通过第 6.3 节的未闭合检测补写。

---

## 10. 数据迁移策略

### 10.1 Drizzle Migration

```
src/db/
├── schema/                    # Drizzle schema 定义
│   ├── owners.ts
│   ├── bots.ts
│   ├── owner-bots.ts
│   ├── sessions.ts
│   ├── chat-messages.ts
│   ├── event-log.ts
│   ├── task-history.ts
│   ├── task-summaries.ts
│   └── session-summaries.ts
├── migrations/                # Drizzle 自动生成的 SQL migration
│   ├── 0000_initial.sql
│   └── ...
├── migrate.ts                 # 执行 migration 的入口
└── connection.ts              # PG 连接池配置
```

Migration 命令：

```bash
# 生成 migration（schema 变更后）
pnpm drizzle-kit generate

# 执行 migration
pnpm drizzle-kit migrate
```

### 10.2 向后兼容原则

- 新增列用 `DEFAULT` 值，不 break 旧代码
- 不删列，只废弃（加注释标记 deprecated）
- 不改列类型，只加新列
- 索引变更单独 migration，与数据变更分离

---

## 11. ID 生成策略

### 11.1 UUID v7

所有 `id` 字段使用 UUID v7（时间排序 + 随机尾部）。理由：

- 天然按时间排序，B-tree 索引友好，insert 不产生随机页分裂
- 全局唯一，无需中心化 sequence
- 比 UUID v4 在 PG 中的索引性能好 30-50%

```typescript
import { uuidv7 } from 'uuidv7'

function generateId(): string {
  return uuidv7()
}
```

### 11.2 message_id

用户消息的 `message_id` 由入口层生成，格式：`msg-{uuidv7()}`。前缀 `msg-` 便于在日志中快速识别。

### 11.3 task_history.id

直接复用 BullMQ 的 `jobId`，即 `message_id`。一条用户消息最多产出一个 ExecJob，ID 天然一一对应。

---

## 12. 配置参数速查

| 参数 | 默认值 | 环境变量 | 说明 |
|------|--------|---------|------|
| `PG_HOST` | `localhost` | `PG_HOST` | PostgreSQL 地址 |
| `PG_PORT` | `5432` | `PG_PORT` | PostgreSQL 端口 |
| `PG_DATABASE` | `ts_core` | `PG_DATABASE` | 数据库名 |
| `PG_USER` | `ts_core` | `PG_USER` | 数据库用户 |
| `PG_PASSWORD` | — | `PG_PASSWORD` | 数据库密码 |
| `PG_POOL_MIN` | `2` | `PG_POOL_MIN` | 连接池最小连接数 |
| `PG_POOL_MAX` | `10` | `PG_POOL_MAX` | 连接池最大连接数 |
| `REDIS_URL` | `redis://localhost:6379` | `REDIS_URL` | Redis 连接 |
| `LOGS_BASE_DIR` | `./logs` | `LOGS_DIR` | JSONL 日志根目录 |
| `EVENT_LOG_RETENTION_DAYS` | `30` | `EVENT_RETENTION` | event_log 保留天数 |
| `TASK_LOG_RETENTION_DAYS` | `90` | `TASK_LOG_RETENTION` | 任务 JSONL 保留天数 |
| `LLM_LOG_RETENTION_DAYS` | `30` | `LLM_LOG_RETENTION` | LLM 日志保留天数 |
| `EMBEDDING_DIMENSIONS` | `1024` | `EMBED_DIM` | 向量维度（Qwen3-Embedding-8B text-embedding-v4 默认维度） |

---

## 13. 后续文档依赖

本文档定义了全部持久化方案。以下文档依赖本文档：

- **INTERFACE_SPEC.md**：依赖第 6 节 event_log 查询模式（断线补拉 API）、第 2.4 节 sessions 表（认证）
- **DEPLOYMENT.md**：依赖第 2.2 节扩展依赖（pgvector 安装）、第 10 节 migration 命令、第 5.3 节清理脚本

本文档依赖的上游文档：

- **ARCHITECTURE.md 第 8 节**：Event Protocol 定义
- **ARCHITECTURE.md 第 9 节**：Ingress Idempotency（message_id）
- **CONVERSATION_SPEC.md 第 8 节**：任务索引层级
- **CONVERSATION_SPEC.md 第 9 节**：混合检索架构
- **CONVERSATION_SPEC.md 第 10 节**：chat_messages 表结构
- **RUNTIME_SPEC.md 第 9 节**：诊断事件清单
- **SANDBOX_SPEC.md 第 11 节**：沙箱 JSONL 日志格式

---

v0.1 完毕。你审一遍，没问题就继续下一个文档。
