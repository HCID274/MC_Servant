/**
 * OpenAI 兼容对话调用适配。
 *
 * 1. 最短闭环：封装 `POST /chat/completions`（对话补全接口） 的最小请求与响应解析。
 * 2. 多阶段复用：统一承载 Stage 1-Triage（分诊）、Stage 2-Chat（闲聊） 与最小 Stage 2-Plan（规划） 请求。
 * 3. 诊断留痕：为闲聊阶段生成 `llm`（大语言模型） JSONL（结构化日志） 摘要，覆盖模型、成功与失败信息。
 */

import type { JsonlErrorSnapshot, LlmJsonlLine } from "../diagnostics/contracts.js";
import { createLlmLogLine, createLlmLogRef } from "../diagnostics/logs.js";
import { assertNonEmptyString } from "../domain/invariants.js";
import {
  SKILL_DIRECTORY,
  isCollectSkillParams,
  isEquipSkillParams,
  isGoToSkillParams,
  isMineSkillParams,
} from "../skills/contracts.js";
import type {
  ConversationHistoryTurn,
  ConversationReplyMode,
  ConversationSkillCallPlanDraft,
  InterruptedTaskSummary,
} from "./contracts.js";
import { createSkillCallPlanDraft } from "./planning.js";
import { createMessageTriage } from "./triage.js";

/** OpenAI 兼容闲聊客户端配置。 */
export interface ConversationLlmConfig {
  /** OpenAI 兼容基础地址。 */
  readonly base_url: string;
  /** OpenAI 兼容接口密钥。 */
  readonly api_key: string;
  /** 默认模型名。 */
  readonly model: string;
  /** 默认 Bot 名称。 */
  readonly bot_name: string;
  /** 默认主人称谓。 */
  readonly owner_name: string;
  /** 单次请求超时。 */
  readonly timeout_ms: number;
}

/** 单条 OpenAI 兼容对话消息。 */
export interface ConversationLlmMessage {
  /** 消息角色。 */
  readonly role: "system" | "user" | "assistant";
  /** 消息文本。 */
  readonly content: string;
}

/** 闲聊调用的诊断摘要。 */
export interface ConversationLlmDiagnosticRecord {
  /** 调用阶段。 */
  readonly stage: "chat";
  /** 模型名。 */
  readonly model: string;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 结构化日志引用。 */
  readonly log_ref: string;
  /** 是否成功。 */
  readonly ok: boolean;
  /** 失败摘要。 */
  readonly error_summary?: string;
  /** 本次调用生成的 JSONL（结构化日志） 行。 */
  readonly lines: readonly LlmJsonlLine[];
}

/** 闲聊回复生成结果。 */
export interface ConversationGeneratedReply {
  /** 回复模式。 */
  readonly mode: ConversationReplyMode;
  /** 回复文本。 */
  readonly reply: string;
  /** 可选诊断摘要。 */
  readonly diagnostics?: ConversationLlmDiagnosticRecord;
}

/** 闲聊请求输入。 */
export interface ConversationLlmChatInput {
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 当前主人消息。 */
  readonly message: string;
  /** 最近对话历史。 */
  readonly history?: readonly ConversationHistoryTurn[];
  /** 可选 Bot 名称覆盖。 */
  readonly bot_name?: string;
  /** 可选主人称谓覆盖。 */
  readonly owner_name?: string;
  /** 可选记忆摘要。 */
  readonly memory_context?: string;
}

/** 分诊请求输入。 */
export interface ConversationLlmTriageInput {
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 当前主人消息。 */
  readonly message: string;
  /** 最近对话历史。 */
  readonly history?: readonly ConversationHistoryTurn[];
  /** 一行 Bot 状态摘要。 */
  readonly bot_summary?: string;
}

/** 最小移动规划请求输入。 */
export interface ConversationLlmPlanInput {
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 当前主人消息。 */
  readonly message: string;
  /** 规划时的一行环境快照。 */
  readonly snapshot_context: string;
  /** 分诊理由。 */
  readonly triage_reason?: string;
  /** 可选任务历史摘要。 */
  readonly task_history_context?: string;
  /** 可选记忆摘要。 */
  readonly memory_context?: string;
  /** modify（修改） 时的被中断任务摘要。 */
  readonly interrupted_task?: InterruptedTaskSummary;
}

/** 闲聊调用成功结果。 */
export interface ConversationLlmChatResult {
  /** 固定为 `llm`（大语言模型） 回复。 */
  readonly mode: "llm";
  /** 原始回复文本。 */
  readonly reply: string;
  /** 诊断摘要。 */
  readonly diagnostics: ConversationLlmDiagnosticRecord;
}

/** 在线最小真实规划允许的技能集合。 */
export const ONLINE_PLAN_SKILLS = Object.freeze([
  SKILL_DIRECTORY.goTo,
  SKILL_DIRECTORY.mine,
  SKILL_DIRECTORY.collect,
  SKILL_DIRECTORY.equip,
] as const);

/** 最小技能规划成功结果。 */
export type ConversationLlmPlanResult = Extract<
  ConversationSkillCallPlanDraft,
  { skill: (typeof ONLINE_PLAN_SKILLS)[number] }
>;

/** OpenAI 兼容聊天请求依赖。 */
export interface ConversationLlmDependencies {
  /** 可注入 fetch（网络请求） 实现。 */
  readonly fetch?: typeof fetch;
  /** 可注入当前时间。 */
  readonly now?: () => Date;
  /** 诊断回调。 */
  readonly onDiagnostic?: (record: ConversationLlmDiagnosticRecord) => void | Promise<void>;
}

/** 闲聊客户端暴露的最小能力。 */
export interface ConversationLlmClient {
  /** 基于真实 OpenAI 兼容接口执行 Stage 1-Triage（分诊）。 */
  generateTriage(
    input: ConversationLlmTriageInput,
  ): Promise<ReturnType<typeof createMessageTriage>>;
  /** 基于真实 OpenAI 兼容接口生成闲聊回复。 */
  generateChatReply(input: ConversationLlmChatInput): Promise<ConversationLlmChatResult>;
  /** 基于真实 OpenAI 兼容接口生成最小单技能 `skill_call`（技能调用） 规划。 */
  generateSkillPlan(input: ConversationLlmPlanInput): Promise<ConversationLlmPlanResult>;
}

/** 闲聊调用失败错误；包含最小诊断摘要。 */
export class ConversationLlmChatError extends Error {
  /** 失败时已生成的诊断摘要。 */
  readonly diagnostics: ConversationLlmDiagnosticRecord;

  /**
   * 创建携带诊断摘要的闲聊调用错误。
   *
   * @param message 错误消息
   * @param diagnostics 失败诊断
   * @param options 原始 cause（原因）
   */
  constructor(
    message: string,
    diagnostics: ConversationLlmDiagnosticRecord,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConversationLlmChatError";
    this.diagnostics = diagnostics;
  }
}

/** 最小规划失败错误。 */
export class ConversationLlmPlanError extends Error {
  /**
   * 创建规划失败错误。
   *
   * @param message 错误消息
   * @param options 原始 cause（原因）
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationLlmPlanError";
  }
}

/** 创建只读的 OpenAI 兼容配置。 */
export function createConversationLlmConfig(
  input: Omit<ConversationLlmConfig, "base_url"> & {
    /** OpenAI 兼容基础地址。 */
    readonly base_url: string;
  },
): ConversationLlmConfig {
  assertNonEmptyString(input.base_url, "base_url");
  assertNonEmptyString(input.api_key, "api_key");
  assertNonEmptyString(input.model, "model");
  assertNonEmptyString(input.bot_name, "bot_name");
  assertNonEmptyString(input.owner_name, "owner_name");

  if (!Number.isFinite(input.timeout_ms) || input.timeout_ms <= 0) {
    throw new Error("timeout_ms must be a positive number");
  }

  return Object.freeze({
    base_url: input.base_url.replace(/\/+$/u, ""),
    api_key: input.api_key.trim(),
    model: input.model.trim(),
    bot_name: input.bot_name.trim(),
    owner_name: input.owner_name.trim(),
    timeout_ms: input.timeout_ms,
  });
}

/** 组装 Stage 2-Chat（闲聊回复） 的最小消息列表。 */
export function createConversationChatMessages(
  input: ConversationLlmChatInput & Pick<ConversationLlmConfig, "bot_name" | "owner_name">,
): readonly ConversationLlmMessage[] {
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.message, "message");

  const botName = input.bot_name.trim();
  const ownerName = input.owner_name.trim();
  const historyMessages =
    input.history?.flatMap<ConversationLlmMessage>((turn) => {
      const role = turn.role === "bot" ? "assistant" : "user";
      const content =
        turn.role === "bot" ? `[${botName}] ${turn.content}` : `[${ownerName}] ${turn.content}`;

      return Object.freeze([
        Object.freeze({
          role,
          content,
        }),
      ]);
    }) ?? [];

  const systemSections = [
    `你是 ${botName}，一个在 Minecraft 中的贴心猫娘女仆。你的主人是 ${ownerName}。`,
    "绝对规则：",
    "- 每句回复结尾必须加“喵”或“喵~”",
    "- 回复简短自然，不超过 3 句话",
    "- 不要输出 JSON，不要输出动作计划，只说话",
    ...(input.memory_context === undefined ? [] : [`记忆摘要：${input.memory_context}`]),
  ];

  return Object.freeze([
    Object.freeze({
      role: "system",
      content: systemSections.join("\n"),
    }),
    ...historyMessages,
    Object.freeze({
      role: "user",
      content: `[${ownerName}] ${input.message}`,
    }),
  ]);
}

/** 组装 Stage 1-Triage（分诊） 的最小消息列表。 */
export function createConversationTriageMessages(
  input: ConversationLlmTriageInput,
): readonly ConversationLlmMessage[] {
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.message, "message");

  const historyLines =
    input.history?.map((turn) =>
      turn.role === "bot" ? `[Bot] ${turn.content}` : `[主人] ${turn.content}`,
    ) ?? [];

  return Object.freeze([
    Object.freeze({
      role: "system",
      content: [
        "你是一个消息分类器。根据用户消息和上下文，判断用户的意图类别和紧迫度。",
        "当前在线最小闭环只允许输出 chat、task、cancel 三类意图，不要输出 modify。",
        "只输出 JSON，不要输出其他内容。",
        "意图分类规则：",
        "- chat：闲聊、问候、问问题、情感表达、与 Minecraft 游戏操作无关的对话",
        "- task：要求 Bot 执行游戏内动作（采集、移动、制造、跟随等）",
        "- cancel：要求停止当前任务（只有明确指向当前动作的停止指令）",
        "紧迫度规则：",
        "- interrupt：必须立刻中止当前动作",
        "- urgent：尽快执行，插队",
        "- normal：正常排队",
        "- background：低优先级",
        '输出格式：{"intent":"chat|task|cancel","priority":"interrupt|urgent|normal|background","reason":"一句话说明判断依据"}',
      ].join("\n"),
    }),
    Object.freeze({
      role: "user",
      content: [
        `Bot 状态：${input.bot_summary?.trim() || "idle"}`,
        "---",
        ...(historyLines.length > 0 ? historyLines : ["[无最近对话]"]),
        "---",
        `[主人] ${input.message}`,
      ].join("\n"),
    }),
  ]);
}

/** 组装最小单技能 `skill_call`（技能调用） 规划消息列表。 */
export function createConversationPlanMessages(
  input: ConversationLlmPlanInput,
): readonly ConversationLlmMessage[] {
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.message, "message");
  assertNonEmptyString(input.snapshot_context, "snapshot_context");

  return Object.freeze([
    Object.freeze({
      role: "system",
      content: [
        "你是一个 Minecraft 任务规划器。",
        "当前阶段只能输出单个 skill_call。",
        "允许的 skill 只有：goTo、mine、collect、equip。",
        "如果是去某个坐标，请输出 JSON：",
        '{"type":"skill_call","reply":"一句简短确认回复","skill":"goTo","params":{"x":10,"y":64,"z":-5}}',
        "如果是挖某种方块 N 个，请输出 JSON：",
        '{"type":"skill_call","reply":"一句简短确认回复","skill":"mine","params":{"blockName":"stone","count":3}}',
        "如果是捡某种掉落物，请输出 JSON：",
        '{"type":"skill_call","reply":"一句简短确认回复","skill":"collect","params":{"itemName":"cobblestone","radius":8}}',
        "如果是把某物装备到手上或指定槽位，请输出 JSON：",
        '{"type":"skill_call","reply":"一句简短确认回复","skill":"equip","params":{"itemName":"stone_pickaxe","destination":"hand"}}',
        "如果不能明确判断为 goTo、mine、collect、equip 其中一种，或参数不完整 / 不合法，输出 JSON：",
        '{"type":"cannot_plan","reason":"一句话说明为什么无法规划"}',
        "绝对规则：",
        "- 只能输出 JSON，不要解释",
        "- 不要输出 sandbox_code",
        "- 不要输出除 goTo、mine、collect、equip 之外的 skill",
        "- goTo.params.x / y / z 必须是数字",
        "- mine.params.blockName 必须是非空字符串，count 必须是正整数",
        "- collect.params.itemName 必须是非空字符串，radius 若提供必须是正整数",
        "- equip.params.itemName 必须是非空字符串，destination 若提供只能是 hand、off-hand、head、torso、legs、feet",
      ].join("\n"),
    }),
    Object.freeze({
      role: "user",
      content: [
        `环境快照：${input.snapshot_context}`,
        ...(input.triage_reason === undefined ? [] : [`分诊理由：${input.triage_reason}`]),
        ...(input.task_history_context === undefined
          ? []
          : [`任务历史：${input.task_history_context}`]),
        ...(input.memory_context === undefined ? [] : [`记忆摘要：${input.memory_context}`]),
        ...(input.interrupted_task === undefined
          ? []
          : [
              `被中断任务：message_id=${input.interrupted_task.message_id}; summary=${input.interrupted_task.intent_summary}${input.interrupted_task.last_step === undefined ? "" : `; last_step=${input.interrupted_task.last_step}`}`,
            ]),
        `主人的指令：${input.message}`,
      ].join("\n"),
    }),
  ]);
}

/** 创建 OpenAI 兼容闲聊客户端。 */
export function createConversationLlmClient(
  config: ConversationLlmConfig,
  dependencies: ConversationLlmDependencies = {},
): ConversationLlmClient {
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());

  return Object.freeze({
    async generateTriage(
      input: ConversationLlmTriageInput,
    ): Promise<ReturnType<typeof createMessageTriage>> {
      try {
        const payload = await requestChatCompletionPayload({
          fetchImpl,
          config,
          messages: createConversationTriageMessages(input),
        });

        return parseConversationTriage(extractAssistantReply(payload));
      } catch {
        return createMessageTriage({
          intent: "chat",
          priority: "normal",
          reason: "llm_triage_fallback",
        });
      }
    },
    async generateChatReply(input: ConversationLlmChatInput): Promise<ConversationLlmChatResult> {
      const startedAt = now();
      const startedAtMs = startedAt.getTime();
      const messages = createConversationChatMessages({
        ...input,
        bot_name: input.bot_name ?? config.bot_name,
        owner_name: input.owner_name ?? config.owner_name,
      });
      const logRef = createLlmLogRef({
        date: startedAt.toISOString().slice(0, 10),
        stage: "chat",
        message_id: input.message_id,
      });
      const invocationLines = Object.freeze([
        createLlmLogLine({
          t: createUnixSeconds(startedAt),
          stage: "chat",
          model: config.model,
          msg_id: input.message_id,
        }),
        ...messages.map((message) =>
          createLlmLogLine({
            t: createUnixSeconds(startedAt),
            role: message.role,
            content: message.content,
          }),
        ),
      ]);

      try {
        const payload = await requestChatCompletionPayload({
          fetchImpl,
          config,
          messages,
        });

        const reply = extractAssistantReply(payload);
        const finishedAt = now();
        const diagnostics = createConversationLlmDiagnosticRecord({
          stage: "chat",
          model: config.model,
          message_id: input.message_id,
          log_ref: logRef,
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

        await dependencies.onDiagnostic?.(diagnostics);

        return Object.freeze({
          mode: "llm",
          reply,
          diagnostics,
        });
      } catch (error) {
        const finishedAt = now();
        const errorSnapshot = createErrorSnapshot(error);
        const diagnostics = createConversationLlmDiagnosticRecord({
          stage: "chat",
          model: config.model,
          message_id: input.message_id,
          log_ref: logRef,
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

        await dependencies.onDiagnostic?.(diagnostics);

        throw new ConversationLlmChatError(errorSnapshot.message, diagnostics, {
          cause: error,
        });
      }
    },
    async generateSkillPlan(input: ConversationLlmPlanInput): Promise<ConversationLlmPlanResult> {
      const payload = await requestChatCompletionPayload({
        fetchImpl,
        config,
        messages: createConversationPlanMessages(input),
      });

      return parseConversationSkillPlan(extractAssistantReply(payload));
    },
  });
}

/**
 * 创建只读诊断摘要。
 *
 * @param input 原始诊断输入
 * @returns 冻结后的诊断对象
 */
function createConversationLlmDiagnosticRecord(
  input: ConversationLlmDiagnosticRecord,
): ConversationLlmDiagnosticRecord {
  return Object.freeze({
    ...input,
    lines: Object.freeze([...input.lines]),
  });
}

/**
 * 提取 OpenAI 兼容返回中的回复文本。
 *
 * @param payload 接口返回
 * @returns 第一条 assistant（助手） 回复文本
 */
function extractAssistantReply(payload: OpenAiCompatibleChatCompletionResponse): string {
  const content = payload.choices?.[0]?.message?.content;

  if (typeof content === "string" && content.trim().length > 0) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();

    if (text.length > 0) {
      return text;
    }
  }

  throw new Error("LLM response does not contain assistant text");
}

/**
 * 解析分诊阶段返回。
 *
 * @param content assistant（助手） 文本
 * @returns 收敛后的分诊结果
 */
function parseConversationTriage(content: string): ReturnType<typeof createMessageTriage> {
  const record = parseJsonRecord(content);

  return createMessageTriage({
    ...(typeof record.intent === "string" ? { intent: record.intent } : {}),
    ...(typeof record.priority === "string" ? { priority: record.priority } : {}),
    ...(typeof record.reason === "string"
      ? { reason: record.reason }
      : { reason: "llm_triage_fallback" }),
  });
}

/**
 * 解析最小单技能 `skill_call`（技能调用） 规划返回。
 *
 * @param content assistant（助手） 文本
 * @returns 经过强校验的技能规划草案
 */
function parseConversationSkillPlan(content: string): ConversationLlmPlanResult {
  const record = parseJsonRecord(content);

  if (record.type === "cannot_plan") {
    throw new ConversationLlmPlanError(
      typeof record.reason === "string" && record.reason.trim().length > 0
        ? record.reason
        : "planner cannot determine a valid executable skill",
    );
  }

  if (record.type !== "skill_call") {
    throw new ConversationLlmPlanError("planner must return type=skill_call or type=cannot_plan");
  }

  if (typeof record.reply !== "string" || record.reply.trim().length === 0) {
    throw new ConversationLlmPlanError("planner reply must be a non-empty string");
  }

  switch (record.skill) {
    case SKILL_DIRECTORY.goTo:
      if (!isGoToSkillParams(record.params)) {
        throw new ConversationLlmPlanError("planner returned invalid goTo params");
      }

      return createSkillCallPlanDraft({
        reply: record.reply,
        skill: SKILL_DIRECTORY.goTo,
        params: record.params,
      }) as ConversationLlmPlanResult;
    case SKILL_DIRECTORY.mine:
      if (!isMineSkillParams(record.params)) {
        throw new ConversationLlmPlanError("planner returned invalid mine params");
      }

      return createSkillCallPlanDraft({
        reply: record.reply,
        skill: SKILL_DIRECTORY.mine,
        params: record.params,
      }) as ConversationLlmPlanResult;
    case SKILL_DIRECTORY.collect:
      if (!isCollectSkillParams(record.params)) {
        throw new ConversationLlmPlanError("planner returned invalid collect params");
      }

      return createSkillCallPlanDraft({
        reply: record.reply,
        skill: SKILL_DIRECTORY.collect,
        params: record.params,
      }) as ConversationLlmPlanResult;
    case SKILL_DIRECTORY.equip:
      if (!isEquipSkillParams(record.params)) {
        throw new ConversationLlmPlanError("planner returned invalid equip params");
      }

      return createSkillCallPlanDraft({
        reply: record.reply,
        skill: SKILL_DIRECTORY.equip,
        params: record.params,
      }) as ConversationLlmPlanResult;
    default:
      throw new ConversationLlmPlanError("planner must return skill=goTo|mine|collect|equip");
  }
}

/**
 * 提取 OpenAI 兼容错误摘要。
 *
 * @param payload 接口返回
 * @param status HTTP（超文本传输协议） 状态码
 * @returns 可读错误摘要
 */
function extractOpenAiErrorMessage(
  payload: OpenAiCompatibleChatCompletionResponse,
  status: number,
): string {
  const message = payload.error?.message;

  if (typeof message === "string" && message.trim().length > 0) {
    return message.trim();
  }

  return `LLM request failed with status ${status}`;
}

/**
 * 将未知错误转换为 JSONL（结构化日志） 错误快照。
 *
 * @param error 原始错误
 * @returns 只读错误快照
 */
function createErrorSnapshot(error: unknown): JsonlErrorSnapshot {
  if (error instanceof Error) {
    return Object.freeze({
      name: error.name,
      message: error.message,
    });
  }

  return Object.freeze({
    name: "UnknownError",
    message: "Unknown LLM request error",
  });
}

/**
 * 发起一次最小 OpenAI 兼容 chat.completions（对话补全） 请求。
 *
 * @param input 请求参数
 * @returns 原始补全响应
 */
async function requestChatCompletionPayload(input: {
  fetchImpl: typeof fetch;
  config: ConversationLlmConfig;
  messages: readonly ConversationLlmMessage[];
}): Promise<OpenAiCompatibleChatCompletionResponse> {
  const response = await fetchWithTimeout(
    input.fetchImpl,
    `${input.config.base_url}/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.config.api_key}`,
      },
      body: JSON.stringify({
        model: input.config.model,
        messages: input.messages,
      }),
    },
    input.config.timeout_ms,
  );
  const payload = (await response.json()) as OpenAiCompatibleChatCompletionResponse;

  if (!response.ok) {
    throw new Error(extractOpenAiErrorMessage(payload, response.status));
  }

  return payload;
}

/**
 * 从 assistant（助手） 文本中提取 JSON（结构化数据） 对象。
 *
 * @param content assistant（助手） 原始文本
 * @returns 解析后的普通对象
 */
function parseJsonRecord(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const fencedMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  const normalized = fencedMatch?.[1]?.trim() ?? extractBraceWrappedJson(trimmed) ?? trimmed;
  const parsed = JSON.parse(normalized) as unknown;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("LLM response must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

/**
 * 尝试从混合文本中截取首尾大括号包裹的 JSON（结构化数据） 对象。
 *
 * @param content 原始文本
 * @returns JSON 片段；若不存在则返回 undefined
 */
function extractBraceWrappedJson(content: string): string | undefined {
  const firstBraceIndex = content.indexOf("{");
  const lastBraceIndex = content.lastIndexOf("}");

  if (firstBraceIndex === -1 || lastBraceIndex === -1 || lastBraceIndex <= firstBraceIndex) {
    return undefined;
  }

  return content.slice(firstBraceIndex, lastBraceIndex + 1);
}

/**
 * 以超时保护执行 fetch（网络请求）。
 *
 * @param fetchImpl 注入的 fetch（网络请求） 实现
 * @param input 请求地址
 * @param init 请求参数
 * @param timeoutMs 超时毫秒
 * @returns fetch（网络请求） 返回值
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort(new Error("LLM request timed out"));
  }, timeoutMs);

  try {
    return await fetchImpl(input, {
      ...init,
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 创建 Unix 时间戳（秒）。
 *
 * @param value 时间对象
 * @returns 秒级时间戳
 */
function createUnixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

interface OpenAiCompatibleChatCompletionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: {
      readonly content?:
        | string
        | ReadonlyArray<{
            readonly type?: string;
            readonly text?: string;
          }>;
    };
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
  readonly error?: {
    readonly message?: string;
  };
}
