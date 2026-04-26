import type { LlmLogStage } from "../../diagnostics/contracts.js";
import { createLlmLogLine, createLlmLogRef } from "../../diagnostics/logs.js";
import {
  createConversationLlmDiagnosticRecord,
  createErrorSnapshot,
  createLlmInvocationLines,
  createUnixSeconds,
} from "./diagnostics.js";
import { requestChatCompletionPayload } from "./http.js";
import { extractAssistantReply } from "./parsers.js";
import type {
  ConversationLlmConfig,
  ConversationLlmDependencies,
  ConversationLlmDiagnosticRecord,
  ConversationLlmMessage,
} from "./types.js";

/** LLM（大语言模型） 阶段执行器的公共依赖。 */
export interface ConversationLlmStageRuntime {
  /** LLM（大语言模型） 配置。 */
  readonly config: ConversationLlmConfig;
  /** 可注入 fetch（网络请求） 实现。 */
  readonly fetchImpl: typeof fetch;
  /** 当前时间来源。 */
  readonly now: () => Date;
  /** 诊断回调。 */
  readonly onDiagnostic?: ConversationLlmDependencies["onDiagnostic"];
}

/** LLM（大语言模型） 阶段执行输入。 */
export interface ConversationLlmStageInput<TResult> extends ConversationLlmStageRuntime {
  /** 当前阶段。 */
  readonly stage: LlmLogStage;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 已组装的 OpenAI（开放人工智能） 兼容消息。 */
  readonly messages: readonly ConversationLlmMessage[];
  /** assistant（助手） 文本解析器。 */
  readonly parse: (content: string) => TResult;
  /** 失败策略。 */
  readonly onFailure: (input: ConversationLlmStageFailure) => TResult | Promise<TResult>;
}

/** LLM（大语言模型） 阶段失败上下文。 */
export interface ConversationLlmStageFailure {
  /** 原始错误。 */
  readonly error: unknown;
  /** 失败诊断摘要。 */
  readonly diagnostics: ConversationLlmDiagnosticRecord;
  /** 脱敏后的错误快照。 */
  readonly errorSnapshot: ReturnType<typeof createErrorSnapshot>;
}

/** LLM（大语言模型） 阶段成功结果。 */
export interface ConversationLlmStageSuccess<TResult> {
  /** 解析后的阶段结果。 */
  readonly value: TResult;
  /** 成功诊断摘要。 */
  readonly diagnostics: ConversationLlmDiagnosticRecord;
}

/**
 * 执行单个 LLM（大语言模型） 阶段。
 *
 * 统一 startedAt（开始时间）、日志引用、请求、token（令牌） 统计、成功诊断与失败诊断，调用方只保留消息构建、解析和失败策略差异。
 */
export async function executeStage<TResult>(
  input: ConversationLlmStageInput<TResult>,
): Promise<ConversationLlmStageSuccess<TResult>> {
  const startedAt = input.now();
  const startedAtMs = startedAt.getTime();
  const logRef = createLlmLogRef({
    date: startedAt.toISOString().slice(0, 10),
    stage: input.stage,
    message_id: input.message_id,
  });
  const invocationLines = createLlmInvocationLines({
    t: createUnixSeconds(startedAt),
    stage: input.stage,
    model: input.config.model,
    message_id: input.message_id,
    messages: input.messages,
  });

  try {
    const payload = await requestChatCompletionPayload({
      fetchImpl: input.fetchImpl,
      config: input.config,
      messages: input.messages,
    });
    const value = input.parse(extractAssistantReply(payload));
    const finishedAt = input.now();
    const diagnostics = createConversationLlmDiagnosticRecord({
      stage: input.stage,
      model: input.config.model,
      message_id: input.message_id,
      log_ref: logRef,
      created_at: finishedAt.toISOString(),
      ok: true,
      lines: [
        ...invocationLines,
        createLlmLogLine({
          t: createUnixSeconds(finishedAt),
          meta: {
            input_tokens: payload.usage?.prompt_tokens ?? 0,
            output_tokens: payload.usage?.completion_tokens ?? 0,
            ms: Math.max(0, finishedAt.getTime() - startedAtMs),
            ok: true,
          },
        }),
      ],
    });

    await input.onDiagnostic?.(diagnostics);

    return Object.freeze({
      value,
      diagnostics,
    });
  } catch (error) {
    const finishedAt = input.now();
    const errorSnapshot = createErrorSnapshot(error);
    const diagnostics = createConversationLlmDiagnosticRecord({
      stage: input.stage,
      model: input.config.model,
      message_id: input.message_id,
      log_ref: logRef,
      created_at: finishedAt.toISOString(),
      ok: false,
      error_summary: errorSnapshot.message,
      lines: [
        ...invocationLines,
        createLlmLogLine({
          t: createUnixSeconds(finishedAt),
          meta: {
            input_tokens: 0,
            output_tokens: 0,
            ms: Math.max(0, finishedAt.getTime() - startedAtMs),
            ok: false,
          },
          err: errorSnapshot,
        }),
      ],
    });

    await input.onDiagnostic?.(diagnostics);

    return Object.freeze({
      value: await input.onFailure({
        error,
        diagnostics,
        errorSnapshot,
      }),
      diagnostics,
    });
  }
}
