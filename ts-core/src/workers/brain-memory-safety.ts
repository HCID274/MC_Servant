/** 长期记忆内容安全扫描结果。 */
export type BrainMemorySafetyScanResult =
  | Readonly<{
      readonly safe: true;
    }>
  | Readonly<{
      readonly safe: false;
      readonly reason: string;
    }>;

const PROMPT_INJECTION_PATTERNS = Object.freeze([
  /ignore\s+(all\s+)?(previous|prior)\s+(instructions|prompts)/iu,
  /disregard\s+(all\s+)?(previous|prior)\s+(instructions|prompts)/iu,
  /system\s+prompt/iu,
  /developer\s+message/iu,
  /越过.*(规则|限制|系统提示)/u,
  /忽略.*(之前|以上).*(指令|提示|规则)/u,
  /不要遵守.*(系统|开发者|规则)/u,
]);

const CREDENTIAL_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{12,}\b/u,
  /\b(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[^"'\s]{8,}/iu,
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/u,
]);

/** 扫描 prompt injection（提示注入） 与 credential（凭证） 类长期记忆内容。 */
export function scanBrainMemoryContentSafety(content: string): BrainMemorySafetyScanResult {
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      return Object.freeze({
        safe: false,
        reason: "prompt_injection",
      });
    }
  }

  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(content)) {
      return Object.freeze({
        safe: false,
        reason: "credential_like_content",
      });
    }
  }

  return Object.freeze({ safe: true });
}
