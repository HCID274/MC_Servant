/**
 * TaskResultReporter（任务结果汇报器）。
 *
 * 只消费 BotWorker（机器人工作线程） 产出的终态任务卡，生成确定性自然语言汇报；
 * 不参与 BotActor（机器人执行代理） 的执行决策。
 */

import type { ConversationLlmClient, ConversationLlmReportInput } from "../conversation/index.js";
import type { TaskFailedErrorSnapshot } from "../core-ports/events.js";
import type { TaskResultSummary } from "../core-ports/task-result.js";
import { TaskHistoryStatus } from "../core-ports/tasking.js";
import type { BrainTaskCard, BrainTaskCardResult } from "../data/contracts.js";
import type { BotWorkerAction } from "./contracts.js";

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

      const deterministicReport = formatTaskResultReport(taskCard);
      const content = await renderTaskResultReportWithOptionalLlm({
        taskCard,
        deterministicReport,
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
}): ConversationLlmReportInput {
  const facts = createReportFactSnapshot(input.taskCard, input.deterministicReport);

  return Object.freeze({
    message_id: `${input.taskCard.message_id}:task_result`,
    owner_text: input.taskCard.owner_text,
    status: facts.status,
    deterministic_report: input.deterministicReport,
    fact_summary: facts.factSummary,
    required_facts: facts.requiredFacts,
    tone: "像正在向主人汇报任务终态，短句、自然、保留喵系口吻；只能改表达，不能改事实。",
  });
}

/** 纯模板渲染终态任务卡。 */
export function formatTaskResultReport(taskCard: BrainTaskCard): string {
  const result = taskCard.result;
  switch (result.status) {
    case TaskHistoryStatus.Completed:
      return formatCompletedReport(taskCard);
    case TaskHistoryStatus.Failed:
      return formatFailedReport(taskCard, result);
    case TaskHistoryStatus.Interrupted:
      return formatInterruptedReport(taskCard, result);
  }
}

type ReportTerminalStatus = ConversationLlmReportInput["status"];

interface ReportFactSnapshot {
  readonly status: ReportTerminalStatus;
  readonly factSummary: string;
  readonly requiredFacts: readonly string[];
}

function createReportFactSnapshot(
  taskCard: BrainTaskCard,
  deterministicReport: string,
): ReportFactSnapshot {
  const result = taskCard.result;
  const summary = result.result_summary;
  const duration = formatDuration(summary?.duration_ms ?? result.duration_ms);
  const world = formatWorld(summary?.world_key);
  const operation = readOperation(taskCard);

  switch (result.status) {
    case TaskHistoryStatus.Completed: {
      const itemFacts = createInventoryFactStrings(summary);
      const requiredFacts = uniqueNonEmptyStrings(["完成", ...itemFacts, duration, world]);

      return Object.freeze({
        status: "completed",
        factSummary: [
          "状态=任务完成",
          `任务=${taskCard.owner_text}`,
          `操作=${operation}`,
          `结果=${itemFacts.length > 0 ? itemFacts.join("、") : "已完成"}`,
          `耗时=${duration}`,
          world,
          `模板=${deterministicReport}`,
        ].join("；"),
        requiredFacts,
      });
    }
    case TaskHistoryStatus.Failed: {
      const details = readDetails(result.error);
      const failure = summary?.failure;
      const code = failure?.failure_code ?? readFailureCode(result.error);
      const stage =
        failure?.failure_stage ??
        readString(details.failure_stage) ??
        result.last_step ??
        "unknown";
      const recoverable = formatRecoverable(failure?.recoverable ?? readRecoverable(result.error));
      const suggestion = createFailureSuggestion(code);
      const requiredFacts = uniqueNonEmptyStrings(["失败", code, stage, recoverable, suggestion]);

      return Object.freeze({
        status: "failed",
        factSummary: [
          "状态=任务失败",
          `任务=${taskCard.owner_text}`,
          `操作=${operation}`,
          `失败码=${code}`,
          `阶段=${stage}`,
          `恢复性=${recoverable}`,
          `建议=${suggestion}`,
          `模板=${deterministicReport}`,
        ].join("；"),
        requiredFacts,
      });
    }
    case TaskHistoryStatus.Interrupted: {
      const requiredFacts = uniqueNonEmptyStrings(["取消", result.reason, duration]);

      return Object.freeze({
        status: "interrupted",
        factSummary: [
          "状态=任务已取消",
          `任务=${taskCard.owner_text}`,
          `操作=${operation}`,
          `原因=${result.reason}`,
          `耗时=${duration}`,
          `模板=${deterministicReport}`,
        ].join("；"),
        requiredFacts,
      });
    }
  }
}

function createInventoryFactStrings(summary: TaskResultSummary | undefined): readonly string[] {
  const deltas = summary?.inventory_delta?.filter((delta) => delta.count > 0) ?? [];
  if (deltas.length > 0) {
    return Object.freeze(deltas.map((delta) => `${delta.item_name} x${delta.count}`));
  }
  if (summary?.target !== undefined && summary.completed_count !== undefined) {
    return Object.freeze([`${summary.target} x${summary.completed_count}`]);
  }

  return Object.freeze([]);
}

function uniqueNonEmptyStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return Object.freeze(result);
}

function formatCompletedReport(taskCard: BrainTaskCard): string {
  const summary = taskCard.result.result_summary;
  const duration = formatDuration(summary?.duration_ms ?? taskCard.result.duration_ms);
  const world = formatWorld(summary?.world_key);
  const completedText = formatCompletedSummary(summary);
  if (completedText !== null) {
    return `${completedText}，耗时 ${duration}，${world}喵~`;
  }

  const operation = summary?.skill_name ?? summary?.operation ?? "code";
  const target = summary?.target === undefined ? "" : ` ${summary.target}`;
  return `任务完成：${operation}${target} 已完成，耗时 ${duration}，${world}喵~`;
}

function formatFailedReport(
  taskCard: BrainTaskCard,
  result: Extract<BrainTaskCardResult, { readonly status: TaskHistoryStatus.Failed }>,
): string {
  const error = result.error;
  const details = readDetails(error);
  const summary = result.result_summary;
  const failure = summary?.failure;
  const code = failure?.failure_code ?? readFailureCode(error);
  const stage =
    failure?.failure_stage ?? readString(details.failure_stage) ?? result.last_step ?? "unknown";
  const recoverable = failure?.recoverable ?? readRecoverable(error);
  const operation = readOperation(taskCard);
  const suggestion = createFailureSuggestion(code);

  return `任务失败：${operation} 失败码 ${code}，阶段 ${stage}，${formatRecoverable(recoverable)}，${suggestion}，已停止喵~`;
}

function formatInterruptedReport(
  taskCard: BrainTaskCard,
  result: Extract<BrainTaskCardResult, { readonly status: TaskHistoryStatus.Interrupted }>,
): string {
  const summary = result.result_summary;
  const operation = summary?.skill_name ?? summary?.operation ?? readOperation(taskCard);
  const duration = formatDuration(summary?.duration_ms ?? result.duration_ms);
  return `任务已取消：${operation} 已停止，原因 ${result.reason}，耗时 ${duration}喵~`;
}

function readOperation(taskCard: BrainTaskCard): string {
  const summary = taskCard.result.result_summary;
  if (summary?.skill_name !== undefined) {
    return summary.skill_name;
  }
  if (summary?.operation !== undefined) {
    return summary.operation;
  }

  return "code";
}

function formatCompletedSummary(summary: TaskResultSummary | undefined): string | null {
  if (summary === undefined) {
    return null;
  }

  const itemText = formatInventoryDelta(summary);
  const status = readString(summary.details?.status);
  const skillName = summary.skill_name ?? summary.operation;
  const label = COMPLETED_SKILL_LABELS[skillName] ?? skillName;
  if (skillName === "cutTree") {
    return `任务完成：砍到 ${itemText}，已捡拾掉落物`;
  }
  if (skillName === "equip") {
    return `任务完成：${formatEquipStatus(status)} ${summary.target ?? "目标物品"}`;
  }
  if (skillName === "place" || skillName === "placeCraftingTable") {
    return `任务完成：已放置 ${summary.target ?? "crafting_table"}`;
  }
  if (skillName.startsWith("ensure")) {
    return `任务完成：${skillName} 已确保 ${summary.target ?? "目标"} x${summary.completed_count ?? 1}`;
  }

  return `任务完成：${label} ${itemText}`;
}

const COMPLETED_SKILL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  cutTree: "砍到",
  mine: "挖到",
  collect: "捡到",
  craft: "合成",
  goTo: "到达",
} as const);

function formatEquipStatus(status: string | undefined): string {
  return status === "already_equipped" ? "已保持装备" : "已装备";
}

function formatInventoryDelta(summary: TaskResultSummary): string {
  const deltas = summary.inventory_delta?.filter((delta) => delta.count > 0) ?? [];
  if (deltas.length > 0) {
    return deltas.map((delta) => `${delta.item_name} x${delta.count}`).join("、");
  }

  const target = summary.target ?? "目标";
  const count = summary.completed_count ?? 0;
  return `${target} x${count}`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const seconds = durationMs / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
}

function formatWorld(worldKey: string | null | undefined): string {
  return worldKey === undefined || worldKey === null ? "世界 unknown" : `世界 ${worldKey}`;
}

function readFailureCode(error: TaskFailedErrorSnapshot): string {
  return error.error_code ?? readCodeFromMessage(error.message);
}

function readCodeFromMessage(message: string): string {
  const separatorIndex = message.indexOf(":");
  if (separatorIndex <= 0) {
    return "unknown_error";
  }

  return message.slice(0, separatorIndex);
}

function readRecoverable(error: TaskFailedErrorSnapshot): boolean | null {
  const details = readDetails(error);
  if (typeof details.recoverable === "boolean") {
    return details.recoverable;
  }

  const code = readFailureCode(error);
  if (
    code === "missing_materials" ||
    code === "missing_item" ||
    code === "missing_crafting_table" ||
    code === "not_equipped" ||
    code === "resource_not_found" ||
    code === "unsafe_path"
  ) {
    return true;
  }

  if (
    code === "runtime_mine_failed" ||
    code === "runtime_craft_failed" ||
    code === "runtime_equip_failed" ||
    code === "place_failed" ||
    code === "cannot_place"
  ) {
    return false;
  }

  return null;
}

function formatRecoverable(recoverable: boolean | null): string {
  if (recoverable === true) {
    return "可恢复";
  }
  if (recoverable === false) {
    return "不可自动恢复";
  }
  return "可恢复性未知";
}

function createFailureSuggestion(code: string): string {
  switch (code) {
    case "missing_materials":
    case "missing_item":
      return "下一步建议先补齐材料";
    case "missing_crafting_table":
    case "crafting_table_unavailable":
      return "下一步建议先准备可用工作台";
    case "not_equipped":
      return "下一步建议先装备所需工具";
    case "resource_not_found":
      return "下一步建议换位置或扩大搜索范围";
    case "unsafe_path":
    case "unreachable_target":
      return "下一步建议换安全路线";
    case "runtime_mine_failed":
      return "下一步建议查看失败位置后重试";
    default:
      return "下一步建议查看 diagnostics（诊断）详情";
  }
}

function readDetails(error: TaskFailedErrorSnapshot): Readonly<Record<string, unknown>> {
  return error.details ?? {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
