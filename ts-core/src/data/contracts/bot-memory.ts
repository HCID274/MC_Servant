import {
  BOT_MEMORY_KIND_VALUES,
  type BotMemoryKind,
  MEMORY_AUDIT_OP_VALUES,
  MEMORY_CANDIDATE_STATUS_VALUES,
  type MemoryAuditOp,
  type MemoryCandidateStatus,
} from "./tables.js";

/** bot_memory（长期记忆） 各 kind（类别） 的 Phase 1 字符容量。 */
export const BOT_MEMORY_CHAR_LIMITS = Object.freeze({
  USER: 1375,
  MEMORY: 2200,
  SKILL: 2200,
} satisfies Record<BotMemoryKind, number>);

/** bot_memory（长期记忆） 单行快照。 */
export interface BotMemoryRecord {
  readonly bot_id: string;
  readonly kind: BotMemoryKind;
  readonly content: string;
  readonly char_count: number;
  readonly updated_at: string;
}

/** bot_memory（长期记忆） 三类资产快照。 */
export type BotMemorySnapshot = Readonly<Record<BotMemoryKind, string>>;

/** memory_candidates（记忆候选） 写入草案。 */
export interface MemoryCandidateDraft {
  readonly id: string;
  readonly bot_id: string;
  readonly source_event_id?: string;
  readonly kind: BotMemoryKind;
  readonly content: string;
  readonly confidence: number;
  readonly reason?: string;
  readonly status: MemoryCandidateStatus;
  readonly created_at: string;
  readonly decided_at?: string;
}

/** memory_audit（记忆审计） 写入草案。 */
export interface MemoryAuditDraft {
  readonly id: string;
  readonly bot_id: string;
  readonly kind: BotMemoryKind;
  readonly op: MemoryAuditOp;
  readonly before_content?: string;
  readonly after_content?: string;
  readonly candidate_id?: string;
  readonly reason?: string;
  readonly created_at: string;
}

/** 创建稳定 memory_candidates（记忆候选） 标识。 */
export function createMemoryCandidateId(input: {
  readonly event_id: string;
  readonly index: number;
}): string {
  assertNonEmpty(input.event_id, "event_id");
  assertNonNegativeInteger(input.index, "index");

  return `memory-candidate:${input.event_id}:${input.index}`;
}

/** 创建稳定 memory_audit（记忆审计） 标识。 */
export function createMemoryAuditId(input: {
  readonly candidate_id: string;
  readonly op: MemoryAuditOp;
  readonly index: number;
}): string {
  assertNonEmpty(input.candidate_id, "candidate_id");
  assertMemoryAuditOp(input.op);
  assertNonNegativeInteger(input.index, "index");

  return `memory-audit:${input.candidate_id}:${input.op}:${input.index}`;
}

/** 创建 bot_memory（长期记忆） 快照对象。 */
export function createEmptyBotMemorySnapshot(
  input: Partial<Record<BotMemoryKind, string>> = {},
): BotMemorySnapshot {
  return Object.freeze({
    USER: input.USER ?? "",
    MEMORY: input.MEMORY ?? "",
    SKILL: input.SKILL ?? "",
  });
}

/** 创建只读 bot_memory（长期记忆） 记录。 */
export function createBotMemoryRecord(input: BotMemoryRecord): BotMemoryRecord {
  assertNonEmpty(input.bot_id, "bot_id");
  assertBotMemoryKind(input.kind);
  assertNonNegativeInteger(input.char_count, "char_count");
  assertNonEmpty(input.updated_at, "updated_at");

  return Object.freeze({ ...input });
}

/** 创建 memory_candidates（记忆候选） 草案。 */
export function createMemoryCandidateDraft(input: MemoryCandidateDraft): MemoryCandidateDraft {
  assertNonEmpty(input.id, "id");
  assertNonEmpty(input.bot_id, "bot_id");
  if (input.source_event_id !== undefined) {
    assertNonEmpty(input.source_event_id, "source_event_id");
  }
  assertBotMemoryKind(input.kind);
  assertNonEmpty(input.content, "content");
  assertConfidence(input.confidence);
  assertMemoryCandidateStatus(input.status);
  assertNonEmpty(input.created_at, "created_at");

  return Object.freeze({
    ...input,
    content: input.content.trim(),
    ...(input.reason === undefined ? {} : { reason: input.reason.trim() }),
  });
}

/** 创建 memory_audit（记忆审计） 草案。 */
export function createMemoryAuditDraft(input: MemoryAuditDraft): MemoryAuditDraft {
  assertNonEmpty(input.id, "id");
  assertNonEmpty(input.bot_id, "bot_id");
  assertBotMemoryKind(input.kind);
  assertMemoryAuditOp(input.op);
  assertNonEmpty(input.created_at, "created_at");

  return Object.freeze({ ...input });
}

/** 计算长期记忆字符数，按 Unicode code point（码点） 计数。 */
export function countBotMemoryChars(content: string): number {
  return Array.from(content).length;
}

function assertBotMemoryKind(value: string): asserts value is BotMemoryKind {
  if (!(BOT_MEMORY_KIND_VALUES as readonly string[]).includes(value)) {
    throw new Error("bot memory kind must be USER, MEMORY, or SKILL");
  }
}

function assertMemoryCandidateStatus(value: string): asserts value is MemoryCandidateStatus {
  if (!(MEMORY_CANDIDATE_STATUS_VALUES as readonly string[]).includes(value)) {
    throw new Error("memory candidate status is invalid");
  }
}

function assertMemoryAuditOp(value: string): asserts value is MemoryAuditOp {
  if (!(MEMORY_AUDIT_OP_VALUES as readonly string[]).includes(value)) {
    throw new Error("memory audit op is invalid");
  }
}

function assertConfidence(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("memory candidate confidence must be in [0,1]");
  }
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}

function assertNonNegativeInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
}
