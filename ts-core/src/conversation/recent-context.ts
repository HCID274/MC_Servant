import type { BotActorRecentEventProjection } from "../core-ports/runtime.js";
import type { FailureCapsule } from "../core-ports/task-result.js";
import { assertNonEmptyString } from "../domain/invariants.js";

const DEFAULT_RECENT_CONTEXT_ROUND_LIMIT = 10;
const SANDBOX_CODE_LINE_LIMIT = 200;
const SANDBOX_CODE_CHAR_LIMIT = 8000;

type ConversationRecentContextEventKind =
  | "owner_message"
  | "bot_reply"
  | "sandbox_code"
  | "sandbox_error"
  | "failure_capsule"
  | "execution_result";

interface ConversationRecentContextEvent {
  readonly kind: ConversationRecentContextEventKind;
  readonly message_id: string | null;
  readonly aggregate_key: string;
  readonly line?: string;
  readonly code?: string;
  readonly failure_capsule?: FailureCapsule;
  readonly timestamp: number;
  readonly sequence: number;
}

interface ConversationRecentContextRound {
  readonly aggregate_key: string;
  readonly message_id: string | null;
  readonly events: readonly ConversationRecentContextEvent[];
  readonly last_used_at: number;
}

/** ConversationWorker（对话工作线程） 单写侧的最近上下文 store（存储）。 */
export interface ConversationRecentContextStore {
  /** 记录主人原文；当前 prompt（提示词） 渲染完成后再写，避免重复当前消息。 */
  appendOwnerMessage(input: ConversationRecentContextTextInput): void;
  /** 记录 Bot（机器人） 最终回复原文。 */
  appendBotReply(input: ConversationRecentContextTextInput): void;
  /** 记录 sandbox（沙盒） TS（TypeScript） 原文。 */
  appendSandboxCode(input: ConversationRecentContextCodeInput): void;
  /** 记录 sandbox（沙盒） error.message（错误消息） 单行。 */
  appendSandboxError(input: ConversationRecentContextTextInput): void;
  /** 记录执行终态侧生成的 Failure Capsule（失败胶囊）。 */
  appendFailureCapsule(input: ConversationRecentContextFailureCapsuleInput): void;
  /** 渲染已完成轮次，并在 prompt（提示词） 构建时合并 BotActor（机器人执行体） recent_events（最近事件）。 */
  render(input?: ConversationRecentContextRenderInput): string | undefined;
  /** 读取最近一条 Failure Capsule（失败胶囊），供 continuation（继续任务） 判定。 */
  getLatestFailureCapsule(): FailureCapsule | null;
  /** 暴露只读快照，供测试和诊断使用。 */
  getRounds(): readonly ConversationRecentContextRenderedRound[];
}

/** 文本类最近上下文写入输入。 */
export interface ConversationRecentContextTextInput {
  readonly message_id: string;
  readonly text: string;
  readonly timestamp?: number;
}

/** 代码类最近上下文写入输入。 */
export interface ConversationRecentContextCodeInput {
  readonly message_id: string;
  readonly code: string;
  readonly timestamp?: number;
}

/** Failure Capsule（失败胶囊） 最近上下文写入输入。 */
export interface ConversationRecentContextFailureCapsuleInput {
  readonly message_id: string;
  readonly capsule: FailureCapsule;
  readonly timestamp?: number;
}

/** 最近上下文渲染输入。 */
export interface ConversationRecentContextRenderInput {
  readonly actorRecentEvents?: readonly BotActorRecentEventProjection[];
  readonly currentMessageId?: string;
  readonly roundLimit?: number;
  /** continuation（继续任务） 时只把最近失败轮渲染为 Failure Capsule（失败胶囊）。 */
  readonly latestFailureCapsuleOnly?: boolean;
}

/** 最近上下文 store（存储） 配置。 */
export interface ConversationRecentContextStoreOptions {
  readonly now?: () => number;
  readonly roundLimit?: number;
}

/** 最近上下文只读轮次快照。 */
export interface ConversationRecentContextRenderedRound {
  readonly aggregate_key: string;
  readonly message_id: string | null;
  readonly lines: readonly string[];
}

/** 创建 ConversationWorker（对话工作线程） 单写侧最近上下文 store（存储）。 */
export function createConversationRecentContextStore(
  options: ConversationRecentContextStoreOptions = {},
): ConversationRecentContextStore {
  const rounds = new Map<string, ConversationRecentContextRound>();
  const now = options.now ?? Date.now;
  const roundLimit = options.roundLimit ?? DEFAULT_RECENT_CONTEXT_ROUND_LIMIT;
  let sequence = 0;

  const append = (event: Omit<ConversationRecentContextEvent, "sequence">): void => {
    const nextEvent = Object.freeze({
      ...event,
      sequence: sequence,
    });
    sequence += 1;

    const current = rounds.get(event.aggregate_key);
    const events = current === undefined ? [] : [...current.events];
    events.push(nextEvent);
    rounds.set(
      event.aggregate_key,
      Object.freeze({
        aggregate_key: event.aggregate_key,
        message_id: event.message_id,
        events: Object.freeze(events),
        last_used_at: Math.max(current?.last_used_at ?? 0, event.timestamp),
      }),
    );
    evictRounds(rounds, roundLimit);
  };

  const store: ConversationRecentContextStore = {
    appendOwnerMessage(input: ConversationRecentContextTextInput): void {
      appendTextEvent("owner_message", input, now);
    },
    appendBotReply(input: ConversationRecentContextTextInput): void {
      appendTextEvent("bot_reply", input, now);
    },
    appendSandboxCode(input: ConversationRecentContextCodeInput): void {
      assertNonEmptyString(input.message_id, "message_id");
      assertNonEmptyString(input.code, "code");
      append({
        kind: "sandbox_code",
        message_id: input.message_id,
        aggregate_key: createMessageAggregateKey(input.message_id),
        code: input.code,
        timestamp: input.timestamp ?? now(),
      });
    },
    appendSandboxError(input: ConversationRecentContextTextInput): void {
      appendTextEvent("sandbox_error", input, now);
    },
    appendFailureCapsule(input: ConversationRecentContextFailureCapsuleInput): void {
      assertNonEmptyString(input.message_id, "message_id");
      append({
        kind: "failure_capsule",
        message_id: input.message_id,
        aggregate_key: createMessageAggregateKey(input.message_id),
        failure_capsule: freezeFailureCapsule(input.capsule),
        timestamp: input.timestamp ?? now(),
      });
    },
    render(input: ConversationRecentContextRenderInput = {}): string | undefined {
      const renderedRounds = renderConversationRecentContextRounds({
        rounds: [...rounds.values()],
        actorRecentEvents: input.actorRecentEvents ?? [],
        ...(input.currentMessageId === undefined
          ? {}
          : { currentMessageId: input.currentMessageId }),
        roundLimit: input.roundLimit ?? roundLimit,
        latestFailureCapsuleOnly: input.latestFailureCapsuleOnly === true,
      });

      if (renderedRounds.length === 0) {
        return undefined;
      }

      return renderedRounds.map((round) => round.lines.join("\n")).join("\n\n");
    },
    getLatestFailureCapsule(): FailureCapsule | null {
      return readLatestFailureCapsule([...rounds.values()]);
    },
    getRounds(): readonly ConversationRecentContextRenderedRound[] {
      return Object.freeze(
        [...rounds.values()].sort(compareRoundsOldToNew).map((round) =>
          Object.freeze({
            aggregate_key: round.aggregate_key,
            message_id: round.message_id,
            lines: Object.freeze(renderRoundEvents([...round.events], round.aggregate_key)),
          }),
        ),
      );
    },
  };

  return Object.freeze(store);

  function appendTextEvent(
    kind: Exclude<ConversationRecentContextEventKind, "sandbox_code" | "execution_result">,
    input: ConversationRecentContextTextInput,
    readNow: () => number,
  ): void {
    assertNonEmptyString(input.message_id, "message_id");
    const text = normalizeSingleLine(input.text);
    assertNonEmptyString(text, "text");
    append({
      kind,
      message_id: input.message_id,
      aggregate_key: createMessageAggregateKey(input.message_id),
      line: text,
      timestamp: input.timestamp ?? readNow(),
    });
  }
}

/** 渲染最近上下文轮次；供 store（存储） 与单元测试复用。 */
export function renderConversationRecentContextRounds(input: {
  readonly rounds: readonly ConversationRecentContextRound[];
  readonly actorRecentEvents?: readonly BotActorRecentEventProjection[];
  readonly currentMessageId?: string;
  readonly roundLimit?: number;
  readonly latestFailureCapsuleOnly?: boolean;
}): readonly ConversationRecentContextRenderedRound[] {
  const currentAggregateKey =
    input.currentMessageId === undefined
      ? undefined
      : createMessageAggregateKey(input.currentMessageId);
  const merged = new Map<string, ConversationRecentContextRound>();

  for (const round of input.rounds) {
    if (round.aggregate_key === currentAggregateKey) {
      continue;
    }
    merged.set(round.aggregate_key, round);
  }

  for (const event of input.actorRecentEvents ?? []) {
    const aggregateKey =
      event.message_id === null
        ? createSystemAggregateKey(event)
        : createMessageAggregateKey(event.message_id);
    const baseRound = merged.get(aggregateKey);

    if (event.message_id !== null && baseRound === undefined) {
      continue;
    }

    const executionEvent: ConversationRecentContextEvent = Object.freeze({
      kind: event.failure_capsule === undefined ? "execution_result" : "failure_capsule",
      message_id: event.message_id,
      aggregate_key: aggregateKey,
      line: normalizeSingleLine(event.line),
      ...(event.failure_capsule === undefined
        ? {}
        : { failure_capsule: freezeFailureCapsule(event.failure_capsule) }),
      timestamp: event.timestamp,
      sequence: Number.MAX_SAFE_INTEGER,
    });
    const events = baseRound === undefined ? [] : [...baseRound.events];
    events.push(executionEvent);
    merged.set(
      aggregateKey,
      Object.freeze({
        aggregate_key: aggregateKey,
        message_id: event.message_id,
        events: Object.freeze(events),
        last_used_at: Math.max(baseRound?.last_used_at ?? 0, event.timestamp),
      }),
    );
  }

  const limitedRounds = [...merged.values()]
    .sort(compareRoundsOldToNew)
    .slice(-(input.roundLimit ?? DEFAULT_RECENT_CONTEXT_ROUND_LIMIT));
  const latestFailureAggregateKey =
    input.latestFailureCapsuleOnly === true
      ? readLatestFailureCapsuleRound(limitedRounds)?.aggregate_key
      : undefined;

  return Object.freeze(
    limitedRounds
      .map((round) =>
        Object.freeze({
          aggregate_key: round.aggregate_key,
          message_id: round.message_id,
          lines: Object.freeze(
            renderRoundEvents([...round.events], round.aggregate_key, {
              capsuleOnly: round.aggregate_key === latestFailureAggregateKey,
            }),
          ),
        }),
      )
      .filter((round) => round.lines.length > 0),
  );
}

function evictRounds(
  rounds: Map<string, ConversationRecentContextRound>,
  roundLimit: number,
): void {
  while (rounds.size > roundLimit) {
    const evicted = [...rounds.values()].sort(compareRoundsOldToNew)[0];

    if (evicted === undefined) {
      return;
    }
    rounds.delete(evicted.aggregate_key);
  }
}

function renderRoundEvents(
  events: ConversationRecentContextEvent[],
  aggregateKey: string,
  options: { readonly capsuleOnly?: boolean } = {},
): readonly string[] {
  if (options.capsuleOnly === true) {
    const capsule = readLatestFailureCapsuleFromEvents(events);
    return capsule === null ? [] : renderFailureCapsule(capsule);
  }

  return events
    .sort((left, right) => left.timestamp - right.timestamp || left.sequence - right.sequence)
    .flatMap((event) => renderEvent(event, aggregateKey));
}

function renderEvent(
  event: ConversationRecentContextEvent,
  aggregateKey: string,
): readonly string[] {
  switch (event.kind) {
    case "owner_message":
      return [`主人：${event.line ?? ""}`];
    case "bot_reply":
      return [`Bot：${event.line ?? ""}`];
    case "sandbox_code":
      return renderSandboxCode(event.code ?? "", aggregateKey);
    case "sandbox_error":
      return [`报错：${event.line ?? ""}`];
    case "failure_capsule":
      return event.failure_capsule === undefined ? [] : renderFailureCapsule(event.failure_capsule);
    case "execution_result":
      return [`执行结果：${event.line ?? ""}`];
  }
}

function renderFailureCapsule(capsule: FailureCapsule): readonly string[] {
  return Object.freeze([
    "[上一轮失败]",
    `目标：${capsule.goal}`,
    `失败：${capsule.failure_code} at ${capsule.failed_action}；进度：${capsule.progress}`,
    `避免重复：${capsule.retry_guard}`,
    `建议：${capsule.hint}`,
  ]);
}

function renderSandboxCode(code: string, aggregateKey: string): readonly string[] {
  const lineCount = countLines(code);
  const charCount = code.length;

  if (lineCount <= SANDBOX_CODE_LINE_LIMIT && charCount <= SANDBOX_CODE_CHAR_LIMIT) {
    return ["沙盒TS：", "```ts", code, "```"];
  }

  return [
    `沙盒TS：[代码 ${lineCount} 行/${charCount} 字超阈值，已截断，code_ref=${normalizeCodeRef(aggregateKey)}]`,
    "```ts",
    truncateSandboxCode(code),
    "```",
  ];
}

function truncateSandboxCode(code: string): string {
  const byLines = code.split(/\r?\n/u).slice(0, SANDBOX_CODE_LINE_LIMIT).join("\n");

  return byLines.length > SANDBOX_CODE_CHAR_LIMIT
    ? byLines.slice(0, SANDBOX_CODE_CHAR_LIMIT)
    : byLines;
}

function countLines(code: string): number {
  return code.length === 0 ? 0 : code.split(/\r?\n/u).length;
}

function compareRoundsOldToNew(
  left: ConversationRecentContextRound,
  right: ConversationRecentContextRound,
): number {
  return (
    left.last_used_at - right.last_used_at || left.aggregate_key.localeCompare(right.aggregate_key)
  );
}

function createMessageAggregateKey(messageId: string): string {
  return `message:${messageId}`;
}

function createSystemAggregateKey(event: BotActorRecentEventProjection): string {
  return `system:${event.timestamp}:${event.line}`;
}

function normalizeCodeRef(aggregateKey: string): string {
  return aggregateKey.startsWith("message:") ? aggregateKey.slice("message:".length) : aggregateKey;
}

function normalizeSingleLine(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function readLatestFailureCapsule(
  rounds: readonly ConversationRecentContextRound[],
): FailureCapsule | null {
  const round = readLatestFailureCapsuleRound(rounds);
  return round === null ? null : readLatestFailureCapsuleFromEvents([...round.events]);
}

function readLatestFailureCapsuleRound(
  rounds: readonly ConversationRecentContextRound[],
): ConversationRecentContextRound | null {
  return (
    [...rounds]
      .filter((round) => readLatestFailureCapsuleFromEvents([...round.events]) !== null)
      .sort(compareRoundsOldToNew)
      .at(-1) ?? null
  );
}

function readLatestFailureCapsuleFromEvents(
  events: readonly ConversationRecentContextEvent[],
): FailureCapsule | null {
  const event =
    [...events]
      .filter((candidate) => candidate.failure_capsule !== undefined)
      .sort((left, right) => left.timestamp - right.timestamp || left.sequence - right.sequence)
      .at(-1) ?? null;

  return event?.failure_capsule ?? null;
}

function freezeFailureCapsule(capsule: FailureCapsule): FailureCapsule {
  return Object.freeze({
    goal: capsule.goal,
    failed_action: capsule.failed_action,
    failure_code: capsule.failure_code,
    progress: capsule.progress,
    retry_guard: capsule.retry_guard,
    hint: capsule.hint,
  });
}
