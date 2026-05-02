import { assertNonEmptyString, assertPositiveNumber } from "../../domain/invariants.js";
import type { ConversationLlmConfig } from "./types.js";

export function createConversationLlmConfig(
  input: Omit<
    ConversationLlmConfig,
    "base_url" | "enable_thinking" | "reasoning_effort" | "force_thinking_models"
  > & {
    /** OpenAI 兼容基础地址。 */
    readonly base_url: string;
    /** 是否允许 thinking（思考） 模式；默认关闭。 */
    readonly enable_thinking?: boolean;
    /** reasoning effort（推理强度）；默认 none。 */
    readonly reasoning_effort?: string;
    /** 强制开启 thinking（思考） 模式的模型清单。 */
    readonly force_thinking_models?: readonly string[];
  },
): ConversationLlmConfig {
  assertNonEmptyString(input.base_url, "base_url");
  assertNonEmptyString(input.api_key, "api_key");
  assertNonEmptyString(input.model, "model");
  assertNonEmptyString(input.bot_name, "bot_name");
  assertNonEmptyString(input.owner_name, "owner_name");

  assertPositiveNumber(input.timeout_ms, "timeout_ms");
  const model = input.model.trim();
  const reasoningEffort = input.reasoning_effort?.trim() || "none";
  const forceThinkingModels = Object.freeze(
    (input.force_thinking_models ?? [])
      .map((forcedModel) => forcedModel.trim())
      .filter((forcedModel) => forcedModel.length > 0),
  );

  assertValidForceThinkingConfig({
    model,
    reasoningEffort,
    forceThinkingModels,
  });

  return Object.freeze({
    base_url: input.base_url.replace(/\/+$/u, ""),
    api_key: input.api_key.trim(),
    model,
    enable_thinking: input.enable_thinking ?? false,
    reasoning_effort: reasoningEffort,
    force_thinking_models: forceThinkingModels,
    bot_name: input.bot_name.trim(),
    owner_name: input.owner_name.trim(),
    timeout_ms: input.timeout_ms,
  });
}

/** 非 MiMo（小米大模型） 强制 thinking（思考） 必须显式声明有效 reasoning effort（推理强度）。 */
function assertValidForceThinkingConfig(input: {
  readonly model: string;
  readonly reasoningEffort: string;
  readonly forceThinkingModels: readonly string[];
}): void {
  if (!isForceThinkingModel(input.model, input.forceThinkingModels) || isMimoModel(input.model)) {
    return;
  }

  if (input.reasoningEffort === "none") {
    throw new Error(
      "LLM_FORCE_THINKING_MODELS includes a non-MiMo model; set LLM_REASONING_EFFORT to a non-none value",
    );
  }
}

function isForceThinkingModel(model: string, forceThinkingModels: readonly string[]): boolean {
  const normalizedModel = normalizeModelName(model);

  return forceThinkingModels.some(
    (forcedModel) => normalizeModelName(forcedModel) === normalizedModel,
  );
}

function isMimoModel(model: string): boolean {
  return normalizeModelName(model).startsWith("mimo-");
}

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}
