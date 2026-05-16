import type { BrainTaskCard } from "../../data/contracts.js";
import {
  type TaskReportFacts,
  createTaskReportFacts,
  formatTaskReportFactSummary,
} from "./facts.js";
import { formatDeterministicTaskReport } from "./template.js";

export interface TaskReportRenderInput {
  readonly facts: TaskReportFacts;
  readonly deterministic_report: string;
  readonly fact_summary: string;
}

/** 从终态任务卡创建窄汇报事实与确定性模板。 */
export function createTaskReportRenderInput(taskCard: BrainTaskCard): TaskReportRenderInput {
  const facts = createTaskReportFacts(taskCard);
  return Object.freeze({
    facts,
    deterministic_report: formatDeterministicTaskReport(facts),
    fact_summary: formatTaskReportFactSummary(facts),
  });
}

/** 纯模板渲染终态任务卡。 */
export function formatTaskResultReport(taskCard: BrainTaskCard): string {
  return createTaskReportRenderInput(taskCard).deterministic_report;
}
