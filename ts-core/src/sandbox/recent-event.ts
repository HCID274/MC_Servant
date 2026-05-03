import { TaskHistoryStatus } from "../core-ports/tasking.js";

type SandboxRecentEventResult =
  | {
      readonly status: TaskHistoryStatus.Completed;
      readonly summary: { readonly total_steps: number };
    }
  | {
      readonly status: TaskHistoryStatus.Failed;
      readonly summary: { readonly total_steps: number };
      readonly error: { readonly message: string };
    }
  | {
      readonly status: TaskHistoryStatus.Interrupted;
      readonly summary: { readonly total_steps: number };
      readonly error: { readonly message: string };
    };

/** 将 sandbox（沙盒） 执行终态格式化为最近上下文确定性单行。 */
export function formatSandboxRecentEventLine(result: SandboxRecentEventResult): string {
  switch (result.status) {
    case TaskHistoryStatus.Completed:
      return `sandbox 成功,步骤 ${result.summary.total_steps}`;
    case TaskHistoryStatus.Failed:
      return `sandbox 失败：${normalizeMessage(result.error.message)}`;
    case TaskHistoryStatus.Interrupted:
      return `sandbox 中断：${normalizeMessage(result.error.message)}`;
  }
}

function normalizeMessage(message: string): string {
  return message.replaceAll(/\s+/gu, " ").trim();
}
