CREATE SCHEMA "mc_servant";
--> statement-breakpoint
CREATE TABLE "mc_servant"."owners" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owners_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "mc_servant"."bots" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_name" text NOT NULL,
	"persona" text DEFAULT 'catmaid' NOT NULL,
	"mc_server" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bots_bot_name_unique" UNIQUE("bot_name")
);
--> statement-breakpoint
CREATE TABLE "mc_servant"."owner_bots" (
	"owner_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_bots_owner_id_bot_id_pk" PRIMARY KEY("owner_id","bot_id")
);
--> statement-breakpoint
CREATE TABLE "mc_servant"."sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "mc_servant"."chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"session_id" text,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_message_id_unique" UNIQUE("message_id"),
	CONSTRAINT "chat_messages_role_check" CHECK ("role" IN ('user', 'bot')),
	CONSTRAINT "chat_messages_source_check" CHECK ("source" IN ('web', 'game', 'system'))
);
--> statement-breakpoint
CREATE TABLE "mc_servant"."event_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"session_id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mc_servant"."task_history" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"type" text NOT NULL,
	"intent_epoch" integer NOT NULL,
	"status" text NOT NULL,
	"skill" text,
	"params" jsonb,
	"code_ref" text,
	"log_ref" text,
	"snapshot_ts" bigint NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"total_steps" integer,
	"error" jsonb,
	"interrupt_source" jsonb,
	"message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_history_type_check" CHECK ("type" IN ('skill_call', 'sandbox_code')),
	CONSTRAINT "task_history_status_check" CHECK ("status" IN ('accepted', 'started', 'completed', 'failed', 'interrupted', 'discarded'))
);
--> statement-breakpoint
CREATE TABLE "mc_servant"."task_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"intent" text NOT NULL,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"embedding" vector(1024),
	"log_ref" text,
	"triage" jsonb,
	"terminal_event" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_summaries_status_check" CHECK ("status" IN ('completed', 'failed', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE "mc_servant"."session_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"summary" text NOT NULL,
	"task_ids" text[] NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mc_servant"."task_events" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"message_id" text NOT NULL,
	"owner_text" text NOT NULL,
	"task_card" jsonb NOT NULL,
	"takeaway" text,
	"embedding" vector(1024),
	"log_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("owner_text", '') || ' ' || coalesce("takeaway", ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "mc_servant"."bot_rolling_summary" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"char_count" integer DEFAULT 0 NOT NULL,
	"llm_model" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_rolling_summary_char_count_nonnegative" CHECK ("char_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mc_servant"."bot_memory" (
	"bot_id" text NOT NULL,
	"kind" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"char_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_memory_bot_id_kind_pk" PRIMARY KEY("bot_id","kind"),
	CONSTRAINT "bot_memory_kind_check" CHECK ("kind" IN ('USER', 'MEMORY', 'SKILL')),
	CONSTRAINT "bot_memory_char_count_nonnegative" CHECK ("char_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mc_servant"."memory_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"source_event_id" text,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"confidence" real NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "memory_candidates_kind_check" CHECK ("kind" IN ('USER', 'MEMORY', 'SKILL')),
	CONSTRAINT "memory_candidates_status_check" CHECK ("status" IN ('pending', 'applied', 'rejected', 'superseded')),
	CONSTRAINT "memory_candidates_confidence_range" CHECK ("confidence" >= 0 AND "confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "mc_servant"."memory_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"kind" text NOT NULL,
	"op" text NOT NULL,
	"before_content" text,
	"after_content" text,
	"candidate_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_audit_kind_check" CHECK ("kind" IN ('USER', 'MEMORY', 'SKILL')),
	CONSTRAINT "memory_audit_op_check" CHECK ("op" IN ('insert', 'patch', 'merge', 'replace', 'delete'))
);
--> statement-breakpoint
ALTER TABLE "mc_servant"."owner_bots" ADD CONSTRAINT "owner_bots_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "mc_servant"."owners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mc_servant"."owner_bots" ADD CONSTRAINT "owner_bots_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "mc_servant"."bots"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mc_servant"."sessions" ADD CONSTRAINT "sessions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "mc_servant"."owners"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mc_servant"."sessions" ADD CONSTRAINT "sessions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "mc_servant"."bots"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mc_servant"."chat_messages" ADD CONSTRAINT "chat_messages_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "mc_servant"."bots"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mc_servant"."task_history" ADD CONSTRAINT "task_history_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "mc_servant"."bots"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mc_servant"."task_summaries" ADD CONSTRAINT "task_summaries_task_id_task_history_id_fk" FOREIGN KEY ("task_id") REFERENCES "mc_servant"."task_history"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mc_servant"."task_events" ADD CONSTRAINT "task_events_task_id_task_history_id_fk" FOREIGN KEY ("task_id") REFERENCES "mc_servant"."task_history"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mc_servant"."memory_candidates" ADD CONSTRAINT "memory_candidates_source_event_id_task_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "mc_servant"."task_events"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mc_servant"."memory_audit" ADD CONSTRAINT "memory_audit_candidate_id_memory_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "mc_servant"."memory_candidates"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_owner_bots_owner" ON "mc_servant"."owner_bots" USING btree ("owner_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_owner_bots_bot" ON "mc_servant"."owner_bots" USING btree ("bot_id");
--> statement-breakpoint
CREATE INDEX "idx_chat_bot_session" ON "mc_servant"."chat_messages" USING btree ("bot_id","session_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_chat_bot_recent" ON "mc_servant"."chat_messages" USING btree ("bot_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_event_log_bot_seq" ON "mc_servant"."event_log" USING btree ("bot_id","seq");
--> statement-breakpoint
CREATE INDEX "idx_event_log_bot_type" ON "mc_servant"."event_log" USING btree ("bot_id","type","created_at");
--> statement-breakpoint
CREATE INDEX "idx_task_bot_time" ON "mc_servant"."task_history" USING btree ("bot_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_task_bot_status" ON "mc_servant"."task_history" USING btree ("bot_id","status");
--> statement-breakpoint
CREATE INDEX "idx_summary_bot_time" ON "mc_servant"."task_summaries" USING btree ("bot_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_session_summary_bot" ON "mc_servant"."session_summaries" USING btree ("bot_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_task_events_fts" ON "mc_servant"."task_events" USING gin ("search_tsv");
--> statement-breakpoint
CREATE INDEX "idx_task_events_trgm" ON "mc_servant"."task_events" USING gin ("owner_text" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "idx_task_events_embedding" ON "mc_servant"."task_events" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
--> statement-breakpoint
CREATE INDEX "idx_task_events_bot_time" ON "mc_servant"."task_events" USING btree ("bot_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "idx_memory_candidates_bot_status" ON "mc_servant"."memory_candidates" USING btree ("bot_id","status","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "idx_memory_audit_bot_time" ON "mc_servant"."memory_audit" USING btree ("bot_id","created_at" DESC);
