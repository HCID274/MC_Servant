import { assertNonEmptyString } from "../../domain/invariants.js";
import type { ConversationLlmConfig } from "./types.js";

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
