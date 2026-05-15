/**
 * TaskResultReporter（任务结果汇报器）。
 *
 * 只消费 BotWorker（机器人工作线程） 产出的终态任务卡，生成确定性自然语言汇报；
 * 不参与 BotActor（机器人执行代理） 的执行决策。
 */

import type { ConversationLlmClient, ConversationLlmReportInput } from "../conversation/index.js";
import { TaskHistoryStatus } from "../core-ports/tasking.js";
import type { BrainTaskCard } from "../data/contracts.js";
import type { BotWorkerAction } from "./contracts.js";
import { createTaskReportRenderInput, serializeTaskReportFacts } from "./task-report-facts.js";

/** 已渲染、可同步到游戏聊天和网页端的任务结果汇报。 */
export interface TaskResultReport {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 汇报消息标识。 */
  readonly message_id: string;
  /** 汇报正文。 */
  readonly content: string;
}

/** 任务结果汇报器运行时。 */
export interface TaskResultReporter {
  /** 消费 BotWorker（机器人工作线程） 动作；非终态或重复终态返回 null。 */
  consume(action: BotWorkerAction): Promise<TaskResultReport | null>;
}

/** 终态汇报可选的 ReportLLM 依赖。 */
export interface TaskResultReporterOptions {
  readonly reportLlm?: Pick<ConversationLlmClient, "generateReport"> | undefined;
}

/** 创建带去重状态的任务结果汇报器。 */
export function createTaskResultReporter(
  options: TaskResultReporterOptions = {},
): TaskResultReporter {
  const reported = new Set<string>();

  return Object.freeze({
    async consume(action: BotWorkerAction): Promise<TaskResultReport | null> {
      if (action.type !== "enqueue_brain") {
        return null;
      }
      if ("kind" in action.task.payload) {
        return null;
      }

      const taskCard = action.task.payload.task_card;
      const dedupeKey = `${action.task.payload.bot_id}:${taskCard.message_id}:${taskCard.result.status}`;
      if (reported.has(dedupeKey)) {
        return null;
      }
      reported.add(dedupeKey);

      const renderInput = createTaskReportRenderInput(taskCard);
      const content = await renderTaskResultReportWithOptionalLlm({
        taskCard,
        deterministicReport: renderInput.deterministic_report,
        factSummary: renderInput.fact_summary,
        requiredFacts: renderInput.facts.required_facts,
        rawSummaryDigest: renderInput.facts.raw_summary_digest,
        reportFacts: serializeTaskReportFacts(renderInput.facts),
        reportLlm: options.reportLlm,
      });

      return Object.freeze({
        bot_id: action.task.payload.bot_id,
        message_id: `${taskCard.message_id}:task_result`,
        content,
      });
    },
  });
}

async function renderTaskResultReportWithOptionalLlm(input: {
  readonly taskCard: BrainTaskCard;
  readonly deterministicReport: string;
  readonly factSummary: string;
  readonly requiredFacts: readonly string[];
  readonly rawSummaryDigest: string;
  readonly reportFacts: Readonly<Record<string, unknown>>;
  readonly reportLlm?: Pick<ConversationLlmClient, "generateReport"> | undefined;
}): Promise<string> {
  if (input.reportLlm === undefined) {
    return input.deterministicReport;
  }

  try {
    const result = await input.reportLlm.generateReport(
      createConversationLlmReportInput({
        taskCard: input.taskCard,
        deterministicReport: input.deterministicReport,
        factSummary: input.factSummary,
        requiredFacts: input.requiredFacts,
        rawSummaryDigest: input.rawSummaryDigest,
        reportFacts: input.reportFacts,
      }),
    );

    return result.reply;
  } catch {
    return input.deterministicReport;
  }
}

function createConversationLlmReportInput(input: {
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

/** 纯模板渲染终态任务卡。 */
export function formatTaskResultReport(taskCard: BrainTaskCard): string {
  return createTaskReportRenderInput(taskCard).deterministic_report;
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
