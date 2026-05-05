import type {
  ConversationLlmConfig,
  ConversationLlmDependencies,
  ConversationLlmMessage,
} from "../conversation/llm.js";
import { parseJsonRecord } from "../conversation/llm/parsers.js";
import { executeStage } from "../conversation/llm/stage.js";
import type { SnapshotPosition } from "../core-ports/observation.js";
import { TaskHistoryStatus } from "../core-ports/tasking.js";
import {
  BOT_MEMORY_KIND_VALUES,
  type BotMemoryKind,
  type BotMemorySnapshot,
  type BrainTaskCard,
} from "../data/index.js";
import { type BrainDiagnosticLogSink, createBrainDiagnosticLogRef } from "../diagnostics/index.js";
import { assertNonEmptyString } from "../domain/invariants.js";

/** BrainWorker（大脑工作线程） 使用的 LLM（大语言模型） 端口。 */
export interface BrainWorkerLlmClient {
  /** 当前模型名，用于记录 bot_rolling_summary.llm_model（滚动摘要模型）。 */
  readonly model: string;
  /** 失败任务根因 takeaway（要点）。 */
  generateFailureTakeaway(input: BrainFailureTakeawayInput): Promise<string>;
  /** 会话静默后的 takeaway（要点）。 */
  generateSessionTakeaway(input: BrainSessionTakeawayInput): Promise<string>;
  /** A.5（滚动摘要） 整块重压。 */
  compressRollingSummary(content: string): Promise<string>;
  /** C 层长期记忆 rubric（评分规则） 候选识别。 */
  generateMemoryCandidates(
    input: BrainMemoryRubricInput,
  ): Promise<readonly BrainMemoryRubricCandidate[]>;
  /** C 层长期记忆容量超限时的二次决策。 */
  resolveMemoryCapacity(input: BrainMemoryCapacityInput): Promise<BrainMemoryCapacityResolution>;
}

/** 失败任务 takeaway（要点） 输入。 */
export interface BrainFailureTakeawayInput {
  /** 任务卡。 */
  readonly task_card: BrainTaskCard;
  /** 最多 50 行 JSONL（结构化日志） 文本；无日志时用任务卡兜底。 */
  readonly log_excerpt: string;
}

/** 会话级 takeaway（要点） 输入。 */
export interface BrainSessionTakeawayInput {
  /** 目标 Bot（机器人） 标识。 */
  readonly bot_id: string;
  /** 当前 A.5（滚动摘要） 内容。 */
  readonly rolling_summary: string;
}

/** rubric（评分规则） 候选识别输入。 */
export interface BrainMemoryRubricInput {
  /** 主人原文。 */
  readonly owner_text: string;
  /** 来源类型；旧任务卡路径缺省视为 task_event（任务事件）。 */
  readonly source?: "task_event" | "conversation_fact";
  /** 任务卡；conversation_fact（对话事实） 输入没有执行终态。 */
  readonly task_card?: BrainTaskCard;
  /** conversation_fact（对话事实） 原始消息标识。 */
  readonly message_id?: string;
  /** conversation_fact（对话事实） 发话时快照时间戳。 */
  readonly snapshot_ts?: number;
  /** conversation_fact（对话事实） 来源路由。 */
  readonly route_kind?: "chat_reply" | "plan_exec";
  /** conversation_fact（对话事实） Bot 当轮回复。 */
  readonly bot_reply?: string;
  /** 已有 bot_memory（长期记忆） 三类资产。 */
  readonly existing_memory: BotMemorySnapshot;
  /** 主人发话时坐标；用于解析“这里 / 这边 / 脚下 / 我家”等指示语。 */
  readonly owner_position?: SnapshotPosition;
}

/** rubric（评分规则） 候选识别输出项。 */
export interface BrainMemoryRubricCandidate {
  /** 记忆类型。 */
  readonly kind: BotMemoryKind;
  /** 候选内容。 */
  readonly content: string;
  /** 置信度。 */
  readonly confidence: number;
  /** 入选理由。 */
  readonly reason?: string;
}

/** 容量超限二次 LLM（大语言模型） 决策输入。 */
export interface BrainMemoryCapacityInput {
  /** 记忆类型。 */
  readonly kind: BotMemoryKind;
  /** 当前内容。 */
  readonly existing_content: string;
  /** 新候选内容。 */
  readonly candidate_content: string;
  /** 最大字符数。 */
  readonly max_chars: number;
}

/** 容量超限二次 LLM（大语言模型） 决策结果。 */
export type BrainMemoryCapacityResolution = Readonly<{
  /** 资产变更操作。 */
  readonly op: "merge" | "replace" | "delete";
  /** 写回内容；delete（删除） 可为空。 */
  readonly content: string;
  /** 决策理由。 */
  readonly reason?: string;
}>;

/** BrainWorker（大脑工作线程） LLM（大语言模型） 依赖。 */
export interface BrainWorkerLlmDependencies {
  readonly fetch?: typeof fetch;
  /** BrainWorker（大脑工作线程） LLM（大语言模型） 调用诊断旁路。 */
  readonly onDiagnostic?: ConversationLlmDependencies["onDiagnostic"];
  /** BrainWorker（大脑工作线程） rubric（评分规则）解析诊断旁路。 */
  readonly diagnosticSink?: BrainDiagnosticLogSink;
  /** 当前时钟。 */
  readonly now?: () => Date;
  /** 可注入单调时钟，用于性能分段指标。 */
  readonly monotonicNow?: () => number;
}

/** 创建 OpenAI compatible（OpenAI 兼容） BrainWorker（大脑工作线程） LLM（大语言模型） 客户端。 */
export function createOpenAiCompatibleBrainWorkerLlmClient(
  config: ConversationLlmConfig,
  dependencies: BrainWorkerLlmDependencies = {},
): BrainWorkerLlmClient {
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const monotonicNow = dependencies.monotonicNow ?? createDefaultMonotonicNow;

  return Object.freeze({
    model: config.model,
    async generateFailureTakeaway(input: BrainFailureTakeawayInput): Promise<string> {
      assertNonEmptyString(input.log_excerpt, "log_excerpt");

      const promptBuildStartedAt = monotonicNow();
      const messages = createFailureTakeawayMessages(input);
      const promptBuildMs = elapsedMs(monotonicNow, promptBuildStartedAt);

      return clampSingleLine(
        await requestPlainText({
          config,
          fetchImpl,
          now,
          monotonicNow,
          ...(dependencies.onDiagnostic === undefined
            ? {}
            : { onDiagnostic: dependencies.onDiagnostic }),
          message_id: input.task_card.message_id,
          messages,
          prompt_build_ms: promptBuildMs,
        }),
        80,
      );
    },
    async generateSessionTakeaway(input: BrainSessionTakeawayInput): Promise<string> {
      assertNonEmptyString(input.bot_id, "bot_id");
      assertNonEmptyString(input.rolling_summary, "rolling_summary");

      const promptBuildStartedAt = monotonicNow();
      const messages = createSessionTakeawayMessages(input);
      const promptBuildMs = elapsedMs(monotonicNow, promptBuildStartedAt);

      return clampSingleLine(
        await requestPlainText({
          config,
          fetchImpl,
          now,
          monotonicNow,
          ...(dependencies.onDiagnostic === undefined
            ? {}
            : { onDiagnostic: dependencies.onDiagnostic }),
          message_id: `session-${input.bot_id}`,
          messages,
          prompt_build_ms: promptBuildMs,
        }),
        120,
      );
    },
    async compressRollingSummary(content: string): Promise<string> {
      assertNonEmptyString(content, "content");

      const promptBuildStartedAt = monotonicNow();
      const messages = createRollingSummaryCompressionMessages(content);
      const promptBuildMs = elapsedMs(monotonicNow, promptBuildStartedAt);

      return clampMultiline(
        await requestPlainText({
          config,
          fetchImpl,
          now,
          monotonicNow,
          ...(dependencies.onDiagnostic === undefined
            ? {}
            : { onDiagnostic: dependencies.onDiagnostic }),
          message_id: "rolling-summary",
          messages,
          prompt_build_ms: promptBuildMs,
        }),
        1000,
      );
    },
    async generateMemoryCandidates(
      input: BrainMemoryRubricInput,
    ): Promise<readonly BrainMemoryRubricCandidate[]> {
      assertNonEmptyString(input.owner_text, "owner_text");

      const promptBuildStartedAt = monotonicNow();
      const messages = createMemoryRubricMessages(input);
      const promptBuildMs = elapsedMs(monotonicNow, promptBuildStartedAt);

      return parseRubricCandidates(
        await requestPlainText({
          config,
          fetchImpl,
          now,
          monotonicNow,
          ...(dependencies.onDiagnostic === undefined
            ? {}
            : { onDiagnostic: dependencies.onDiagnostic }),
          message_id: input.message_id ?? input.task_card?.message_id ?? "memory-rubric",
          messages,
          prompt_build_ms: promptBuildMs,
        }),
        {
          input,
          model: config.model,
          ...(dependencies.diagnosticSink === undefined
            ? {}
            : { diagnosticSink: dependencies.diagnosticSink }),
          now: dependencies.now ?? (() => new Date()),
        },
      );
    },
    async resolveMemoryCapacity(
      input: BrainMemoryCapacityInput,
    ): Promise<BrainMemoryCapacityResolution> {
      assertNonEmptyString(input.candidate_content, "candidate_content");

      const promptBuildStartedAt = monotonicNow();
      const messages = createMemoryCapacityMessages(input);
      const promptBuildMs = elapsedMs(monotonicNow, promptBuildStartedAt);

      return parseMemoryCapacityResolution(
        await requestPlainText({
          config,
          fetchImpl,
          now,
          monotonicNow,
          ...(dependencies.onDiagnostic === undefined
            ? {}
            : { onDiagnostic: dependencies.onDiagnostic }),
          message_id: `memory-capacity-${input.kind}`,
          messages,
          prompt_build_ms: promptBuildMs,
        }),
        input.max_chars,
      );
    },
  });
}

function createFailureTakeawayMessages(
  input: BrainFailureTakeawayInput,
): readonly ConversationLlmMessage[] {
  return Object.freeze([
    {
      role: "system",
      content: "你是 Minecraft Bot 的任务复盘器。只输出一句中文要点，不写解释。",
    },
    {
      role: "user",
      content: [
        '基于以下任务执行日志,用一句中文写出"下次该注意什么":',
        "",
        "要求：",
        "- 保留：失败根因 / 关键决策点 / 应规避的前置条件",
        "- 去掉：坐标数字、时间戳、中间步骤",
        "- 不超过 80 字",
        "",
        "任务卡：",
        JSON.stringify({
          owner_text: input.task_card.owner_text,
          execution: input.task_card.execution,
          result:
            input.task_card.result.status === TaskHistoryStatus.Failed
              ? input.task_card.result
              : { status: input.task_card.result.status },
        }),
        "",
        "日志：",
        input.log_excerpt,
      ].join("\n"),
    },
  ]);
}

function createSessionTakeawayMessages(
  input: BrainSessionTakeawayInput,
): readonly ConversationLlmMessage[] {
  return Object.freeze([
    {
      role: "system",
      content: "你是 Minecraft Bot 的会话复盘器。只输出一句中文要点，不写标题。",
    },
    {
      role: "user",
      content: [
        "主人与 Bot 的会话已经静默 5 分钟。基于近期滚动摘要写一句会话级 takeaway。",
        "",
        "要求：",
        "- 保留：本轮会话中仍有后续价值的目标、偏好、失败教训",
        "- 去掉：临时寒暄、坐标数字、时间戳",
        "- 不超过 120 字",
        "",
        `Bot: ${input.bot_id}`,
        "",
        "近期滚动摘要：",
        input.rolling_summary,
      ].join("\n"),
    },
  ]);
}

function createRollingSummaryCompressionMessages(
  content: string,
): readonly ConversationLlmMessage[] {
  return Object.freeze([
    {
      role: "system",
      content: "你是 Minecraft Bot 的近期记忆压缩器。只输出压缩后的中文流水摘要。",
    },
    {
      role: "user",
      content: [
        '将以下流水摘要重新压缩为一段 ≤1000 字的中文摘要,作为 Bot 的"近期记忆"。',
        "",
        "要求：",
        "- 保留：近期反复出现的事实、未完成的事项、最近的失败/教训",
        "- 去掉：重复描述、过于细节的步骤",
        "- 输出纯流水形式,不分 section,按时间从旧到新",
        "",
        "原文：",
        content,
      ].join("\n"),
    },
  ]);
}

function createMemoryRubricMessages(
  input: BrainMemoryRubricInput,
): readonly ConversationLlmMessage[] {
  return Object.freeze([
    {
      role: "system",
      content: "你是 Minecraft Bot 的长期记忆筛选器。只输出 JSON，不输出解释。",
    },
    {
      role: "user",
      content: [
        "判断当前任务是否产生了值得长期保留的资产。",
        "",
        "输入：",
        `- 主人原句：${input.owner_text}`,
        input.task_card === undefined
          ? `- 对话事实：${JSON.stringify({
              message_id: input.message_id,
              snapshot_ts: input.snapshot_ts,
              route_kind: input.route_kind,
              bot_reply: input.bot_reply,
            })}`
          : `- 任务卡：${JSON.stringify(input.task_card)}`,
        ...(input.owner_position === undefined
          ? ["- 主人当前坐标：不可得"]
          : [
              `- 主人发话时坐标：x=${input.owner_position.x} y=${input.owner_position.y} z=${input.owner_position.z}`,
            ]),
        `- 已有 USER：${input.existing_memory.USER}`,
        `- 已有 MEMORY：${input.existing_memory.MEMORY}`,
        `- 已有 SKILL：${input.existing_memory.SKILL}`,
        "",
        "只输出 JSON，结构：",
        '{"candidates":[{"kind":"USER|MEMORY|SKILL","content":"...","confidence":0.0,"reason":"..."}]}',
        "- kind 必须是 USER、MEMORY、SKILL 三者之一的实际值，不得原样输出 USER|MEMORY|SKILL",
        "",
        "判断规则：",
        "- Chat / Plan 对话中主人明确命名地点、项目、基地、家、偏好时，也可产生长期记忆候选",
        "- 主人偏好/沟通风格 → USER",
        "- 世界/项目稳定事实（坐标、地标命名）→ MEMORY",
        "- 若主人说“这里 / 这边 / 脚下 / 我家 / 基地”且主人发话时坐标可得，必须以主人发话时坐标作为该地点坐标",
        "- 示例：主人原句“这里叫日月川了”，主人发话时坐标 x=12 y=64 z=-9 → 输出 MEMORY：日月川 = x=12, y=64, z=-9，confidence 至少 0.85",
        "- 示例：主人原句“这里定义为峡谷之巅”，主人发话时坐标 x=-4 y=120 z=33 → 输出 MEMORY：峡谷之巅 = x=-4, y=120, z=33，confidence 至少 0.85",
        "- 复用 SOP 流程模板（不是 ts skill，是流程套路）→ SKILL",
        "- 一次性任务结果、临时日志、TS 源码、背包 diff → confidence < 0.6 或不输出",
        "- 与现有条目冲突或更新 → 输出 kind 相同的新条目，reason 写覆盖原因",
        "- 精确重复已有条目 → 不输出",
      ].join("\n"),
    },
  ]);
}

function createMemoryCapacityMessages(
  input: BrainMemoryCapacityInput,
): readonly ConversationLlmMessage[] {
  return Object.freeze([
    {
      role: "system",
      content: "你是 Minecraft Bot 的长期记忆容量管理器。只输出 JSON。",
    },
    {
      role: "user",
      content: [
        `bot_memory.${input.kind} 超过 ${input.max_chars} 字容量。`,
        "",
        "已有内容：",
        input.existing_content,
        "",
        "新候选：",
        input.candidate_content,
        "",
        "从 merge / replace / delete 里选择一个：",
        "- merge：合并去重后保留最有长期价值的信息",
        "- replace：新候选明显覆盖旧内容时替换",
        "- delete：新候选价值不足或无法安全压缩时删除最旧/低价值信息",
        "",
        `只输出 JSON：{"op":"merge|replace|delete","content":"写回内容，必须不超过 ${input.max_chars} 字","reason":"..."}`,
      ].join("\n"),
    },
  ]);
}

async function requestPlainText(input: {
  readonly config: ConversationLlmConfig;
  readonly fetchImpl: typeof fetch;
  readonly now: () => Date;
  readonly monotonicNow: () => number;
  readonly onDiagnostic?: ConversationLlmDependencies["onDiagnostic"];
  readonly message_id: string;
  readonly messages: readonly ConversationLlmMessage[];
  readonly prompt_build_ms: number;
}): Promise<string> {
  const result = await executeStage({
    config: input.config,
    fetchImpl: input.fetchImpl,
    now: input.now,
    monotonicNow: input.monotonicNow,
    ...(input.onDiagnostic === undefined ? {} : { onDiagnostic: input.onDiagnostic }),
    stage: "brain",
    message_id: input.message_id,
    messages: input.messages,
    prompt_build_ms: input.prompt_build_ms,
    parse: (content) => content,
    onFailure: ({ error }) => {
      throw error;
    },
  });

  return result.value;
}

async function parseRubricCandidates(
  content: string,
  options: {
    readonly input: BrainMemoryRubricInput;
    readonly model: string;
    readonly diagnosticSink?: BrainDiagnosticLogSink;
    readonly now: () => Date;
  },
): Promise<readonly BrainMemoryRubricCandidate[]> {
  let rawCandidates: unknown;

  try {
    const record = parseJsonRecord(content);
    rawCandidates = record.candidates;

    if (!Array.isArray(rawCandidates)) {
      throw new Error("memory rubric response must contain candidates array");
    }

    return Object.freeze(
      rawCandidates.map((candidate) => createRubricCandidateFromRecord(candidate)),
    );
  } catch (error) {
    await appendRubricParseDiagnostic({
      error,
      content,
      options,
    });

    return Object.freeze([]);
  }
}

async function appendRubricParseDiagnostic(input: {
  readonly error: unknown;
  readonly content: string;
  readonly options: {
    readonly input: BrainMemoryRubricInput;
    readonly model: string;
    readonly diagnosticSink?: BrainDiagnosticLogSink;
    readonly now: () => Date;
  };
}): Promise<void> {
  if (input.options.diagnosticSink === undefined) {
    return;
  }

  const createdAt = input.options.now();
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await input.options.diagnosticSink({
    log_ref: createBrainDiagnosticLogRef({
      date: createdAt.toISOString().slice(0, 10),
      kind: "rubric-parse-failed",
      ...(input.options.input.message_id === undefined
        ? {}
        : { message_id: input.options.input.message_id }),
    }),
    lines: [
      Object.freeze({
        t: createdAt.getTime() / 1000,
        event: "brain.rubric.parse_failed" as const,
        model: input.options.model,
        ...(input.options.input.message_id === undefined
          ? {}
          : { message_id: input.options.input.message_id }),
        ...(input.options.input.source === undefined ? {} : { source: input.options.input.source }),
        error_message: message,
        raw_output: clampMultiline(input.content, 4000),
      }),
    ],
  });
}

function createRubricCandidateFromRecord(value: unknown): BrainMemoryRubricCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("memory rubric candidate must be an object");
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const content = record.content;
  const confidence = record.confidence;
  const reason = record.reason;

  if (typeof kind !== "string" || !(BOT_MEMORY_KIND_VALUES as readonly string[]).includes(kind)) {
    throw new Error("memory rubric candidate kind is invalid");
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("memory rubric candidate content must be non-empty");
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    throw new Error("memory rubric candidate confidence must be finite");
  }
  const candidateKind = kind as BotMemoryKind;

  return Object.freeze({
    kind: candidateKind,
    content: clampSingleLine(content, 600),
    confidence: Math.max(0, Math.min(1, confidence)),
    ...(typeof reason === "string" && reason.trim().length > 0
      ? { reason: clampSingleLine(reason, 160) }
      : {}),
  });
}

function parseMemoryCapacityResolution(
  content: string,
  maxChars: number,
): BrainMemoryCapacityResolution {
  const record = parseJsonRecord(content);
  const op = record.op;
  const resolvedContent = record.content;
  const reason = record.reason;

  if (op !== "merge" && op !== "replace" && op !== "delete") {
    throw new Error("memory capacity op must be merge, replace, or delete");
  }
  if (typeof resolvedContent !== "string") {
    throw new Error("memory capacity content must be a string");
  }

  return Object.freeze({
    op,
    content: clampMultiline(resolvedContent, maxChars),
    ...(typeof reason === "string" && reason.trim().length > 0
      ? { reason: clampSingleLine(reason, 160) }
      : {}),
  });
}

function clampSingleLine(value: string, maxChars: number): string {
  return clampByChars(value.replace(/\s+/gu, " ").trim(), maxChars);
}

function clampMultiline(value: string, maxChars: number): string {
  return clampByChars(value.trim(), maxChars);
}

function clampByChars(value: string, maxChars: number): string {
  const chars = Array.from(value);

  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join("");
}

function createDefaultMonotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function elapsedMs(now: () => number, startedAt: number): number {
  const value = now() - startedAt;

  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}
