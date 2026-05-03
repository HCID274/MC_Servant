const REDACTED_SECRET = "<redacted>";
const REDACTED_HOST_PATH = "<redacted-path>";

/** 脱敏本地 diagnostics（诊断） JSONL（结构化日志） 文本。 */
export function redactLocalDiagnosticJsonText(
  value: string,
  sensitiveValues: readonly string[] = [],
): string {
  return redactHostSensitivePaths(
    redactNamedSecretValues(
      redactConnectionStringPasswords(
        redactKnownSensitiveValues(
          value.replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, REDACTED_SECRET),
          sensitiveValues,
        ),
      ),
    ),
  );
}

function redactKnownSensitiveValues(value: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues.reduce((current, sensitiveValue) => {
    const normalized = sensitiveValue.trim();

    if (normalized.length === 0) {
      return current;
    }

    return current.replace(new RegExp(escapeRegExp(normalized), "g"), REDACTED_SECRET);
  }, value);
}

function redactConnectionStringPasswords(value: string): string {
  return value.replace(
    /\b(postgres(?:ql)?|redis):\/\/([^@\s]+)@/gi,
    (match: string, scheme: string, auth: string) => {
      const passwordSeparatorIndex = auth.lastIndexOf(":");

      if (passwordSeparatorIndex < 0) {
        return match;
      }

      const username = auth.slice(0, passwordSeparatorIndex);

      return `${scheme}://${username}:${REDACTED_SECRET}@`;
    },
  );
}

function redactNamedSecretValues(value: string): string {
  return value.replace(
    /\b(LLM_API_KEY|OPENAI_API_KEY|API_KEY|api_key|MC_EXTERNAL_AUTH_SECRET|MC_EXTERNAL_AUTH_PASSWORD|EasyAuth(?:\s*(?:password|密码))?|password|passwd|pwd|secret)\s*[:=]\s*["']?([^"',;\s]+)/gi,
    (_match: string, key: string) => `${key}=${REDACTED_SECRET}`,
  );
}

function redactHostSensitivePaths(value: string): string {
  const unixPathPrefixes = [
    "home",
    "Users",
    "root",
    "workspace",
    "workspaces",
    "mnt",
    "tmp",
    "var",
    "opt",
    "private",
    "Volumes",
  ].join("|");
  const pathEndPattern = "[^\\s\"'`,;)\\]}]+";
  const unixAbsolutePathPattern = new RegExp(
    `(^|[\\s"'(=:\\[{])(/(?:${unixPathPrefixes})/${pathEndPattern})`,
    "g",
  );
  const windowsAbsolutePathPattern =
    /(^|[\s"'(=:\[{])([A-Za-z]:[\\/](?:Users[\\/])?[^\s"'`,;)\]}]+)/g;

  return value
    .replace(unixAbsolutePathPattern, (_match: string, prefix: string) => {
      return `${prefix}${REDACTED_HOST_PATH}`;
    })
    .replace(windowsAbsolutePathPattern, (_match: string, prefix: string) => {
      return `${prefix}${REDACTED_HOST_PATH}`;
    });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
