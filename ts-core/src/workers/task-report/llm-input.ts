import type { ConversationLlmReportInput } from "../../conversation/index.js";
import { TaskHistoryStatus } from "../../core-ports/tasking.js";
import type { BrainTaskCard } from "../../data/contracts.js";

export function createConversationLlmReportInput(input: {
  readonly taskCard: BrainTaskCard;
  readonly deterministicReport: string;
  readonly factSummary: string;
  readonly requiredFacts: readonly string[];
  readonly rawSummaryDigest: string;
  readonly reportFacts: Readonly<Record<string, unknown>>;
}): ConversationLlmReportInput {
  return Object.freeze({
    message_id: `${input.taskCard.message_id}:task_result`,
    owner_text: input.taskCard.owner_text,
    status: readReportStatus(input.taskCard),
    deterministic_report: input.deterministicReport,
    fact_summary: input.factSummary,
    required_facts: input.requiredFacts,
    raw_summary_digest: input.rawSummaryDigest,
    report_facts: input.reportFacts,
    tone: "像正在向主人汇报任务终态，短句、自然、保留喵系口吻；只能改表达，不能改事实。",
  });
}

function readReportStatus(taskCard: BrainTaskCard): ConversationLlmReportInput["status"] {
  switch (taskCard.result.status) {
    case TaskHistoryStatus.Completed:
      return "completed";
    case TaskHistoryStatus.Failed:
      return "failed";
    case TaskHistoryStatus.Interrupted:
      return "interrupted";
  }
}
