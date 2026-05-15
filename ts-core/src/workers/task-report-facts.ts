/**
 * 任务终态汇报事实投影。
 *
 * 这里把 TaskResultSummary（任务结果摘要） 投影成给用户汇报所需的窄事实；
 * 动作层仍只产事实，话术层只消费这些事实。
 */

import { resolveFailureRecoverable } from "../core-ports/task-result.js";
import { TaskHistoryStatus } from "../core-ports/tasking.js";
import type { BrainTaskCard, BrainTaskCardResult } from "../data/contracts.js";

export interface TaskReportInventoryFact {
  readonly item_name: string;
  readonly count: number;
}

export interface TaskReportFailureFact {
  readonly code: string;
  readonly stage: string;
  readonly recoverable: boolean | null;
  readonly suggestion: string | null;
}

export interface TaskReportFacts {
  readonly status: "completed" | "failed" | "interrupted";
  readonly owner_text: string;
  readonly operation: string;
  readonly target?: string;
  readonly requested_count?: number;
  readonly completed_count?: number;
  readonly inventory_delta: readonly TaskReportInventoryFact[];
  readonly duration_text: string;
  readonly world_text: string;
  readonly failure?: TaskReportFailureFact;
  readonly interrupt_reason?: string;
  readonly raw_summary_digest: string;
  readonly required_facts: readonly string[];
}

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

/** 从终态任务卡创建窄汇报事实。 */
export function createTaskReportFacts(taskCard: BrainTaskCard): TaskReportFacts {
  const result = taskCard.result;
  const summary = result.result_summary;
  const inventoryDelta = createInventoryFacts(summary?.inventory_delta);
  const durationText = formatDuration(summary?.duration_ms ?? result.duration_ms);
  const worldText = formatWorld(summary?.world_key);
  const operation = summary?.skill_name ?? summary?.operation ?? "code";
  const base = {
    owner_text: taskCard.owner_text,
    operation,
    ...(summary?.target === undefined ? {} : { target: summary.target }),
    ...(summary?.requested_count === undefined ? {} : { requested_count: summary.requested_count }),
    ...(summary?.completed_count === undefined ? {} : { completed_count: summary.completed_count }),
    inventory_delta: inventoryDelta,
    duration_text: durationText,
    world_text: worldText,
    raw_summary_digest: formatRawSummaryDigest(taskCard),
  };

  switch (result.status) {
    case TaskHistoryStatus.Completed: {
      const itemFacts = formatInventoryFactStrings(
        inventoryDelta,
        summary?.target,
        summary?.completed_count,
      );
      return Object.freeze({
        ...base,
        status: "completed",
        required_facts: uniqueNonEmptyStrings(["完成", ...itemFacts, durationText, worldText]),
      });
    }
    case TaskHistoryStatus.Failed: {
      const failure = createFailureFact(result);
      return Object.freeze({
        ...base,
        status: "failed",
        failure,
        required_facts: uniqueNonEmptyStrings([
          "失败",
          failure.code,
          failure.stage,
          formatRecoverable(failure.recoverable),
        ]),
      });
    }
    case TaskHistoryStatus.Interrupted: {
      return Object.freeze({
        ...base,
        status: "interrupted",
        interrupt_reason: result.reason,
        required_facts: uniqueNonEmptyStrings(["取消", result.reason, durationText]),
      });
    }
  }
}

/** 确定性模板必须可独立作为最终用户汇报。 */
export function formatDeterministicTaskReport(facts: TaskReportFacts): string {
  switch (facts.status) {
    case "completed":
      return formatCompletedReport(facts);
    case "failed":
      return formatFailedReport(facts);
    case "interrupted":
      return `任务已取消：${facts.operation} 已停止，原因 ${facts.interrupt_reason ?? "unknown"}，耗时 ${facts.duration_text}，${facts.world_text}喵~`;
  }
}

/** 面向 ReportLLM 的短事实摘要。 */
export function formatTaskReportFactSummary(facts: TaskReportFacts): string {
  switch (facts.status) {
    case "completed":
      return [
        "状态=任务完成",
        `任务=${facts.owner_text}`,
        `操作=${facts.operation}`,
        `结果=${formatCompletedResultFact(facts)}`,
        `耗时=${facts.duration_text}`,
        facts.world_text,
        `原始摘要=${facts.raw_summary_digest}`,
      ].join("；");
    case "failed":
      return [
        "状态=任务失败",
        `任务=${facts.owner_text}`,
        `操作=${facts.operation}`,
        `失败码=${facts.failure?.code ?? "unknown_error"}`,
        `阶段=${facts.failure?.stage ?? "unknown"}`,
        `恢复性=${formatRecoverable(facts.failure?.recoverable ?? null)}`,
        ...(facts.failure?.suggestion === null || facts.failure?.suggestion === undefined
          ? []
          : [`可重试方向=${facts.failure.suggestion}`]),
        `原始摘要=${facts.raw_summary_digest}`,
      ].join("；");
    case "interrupted":
      return [
        "状态=任务已取消",
        `任务=${facts.owner_text}`,
        `操作=${facts.operation}`,
        `原因=${facts.interrupt_reason ?? "unknown"}`,
        `耗时=${facts.duration_text}`,
        `原始摘要=${facts.raw_summary_digest}`,
      ].join("；");
  }
}

/** 给 diagnostics 保留的结构化汇报事实，不含完整 task card 或错误栈。 */
export function serializeTaskReportFacts(
  facts: TaskReportFacts,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    status: facts.status,
    owner_text: facts.owner_text,
    operation: facts.operation,
    ...(facts.target === undefined ? {} : { target: facts.target }),
    ...(facts.requested_count === undefined ? {} : { requested_count: facts.requested_count }),
    ...(facts.completed_count === undefined ? {} : { completed_count: facts.completed_count }),
    inventory_delta: facts.inventory_delta,
    duration_text: facts.duration_text,
    world_text: facts.world_text,
    ...(facts.failure === undefined ? {} : { failure: facts.failure }),
    ...(facts.interrupt_reason === undefined ? {} : { interrupt_reason: facts.interrupt_reason }),
    raw_summary_digest: facts.raw_summary_digest,
    required_facts: facts.required_facts,
  });
}

function formatCompletedReport(facts: TaskReportFacts): string {
  const itemText = formatInventoryDelta(facts);
  if (facts.operation === "cutTree") {
    return `任务完成：砍到 ${itemText}，已捡拾掉落物，耗时 ${facts.duration_text}，${facts.world_text}喵~`;
  }
  if (facts.operation === "equip") {
    return `任务完成：已装备 ${facts.target ?? "目标物品"}，耗时 ${facts.duration_text}，${facts.world_text}喵~`;
  }
  if (facts.operation === "place") {
    return `任务完成：已放置 ${facts.target ?? "目标方块"}，耗时 ${facts.duration_text}，${facts.world_text}喵~`;
  }

  return `任务完成：${facts.operation} ${itemText}，耗时 ${facts.duration_text}，${facts.world_text}喵~`;
}

function formatFailedReport(facts: TaskReportFacts): string {
  const failure = facts.failure;
  const code = failure?.code ?? "unknown_error";
  const stage = failure?.stage ?? "unknown";
  const recoverable = formatRecoverable(failure?.recoverable ?? null);
  const suggestion = failure?.suggestion;
  const suggestionText = suggestion === null || suggestion === undefined ? "" : `，${suggestion}`;
  return `任务失败：${facts.operation} 失败码 ${code}，阶段 ${stage}，${recoverable}${suggestionText}，${facts.world_text}，已停止喵~`;
}

function formatCompletedResultFact(facts: TaskReportFacts): string {
  const itemText = formatInventoryDelta(facts);
  return itemText.length === 0 ? "已完成" : itemText;
}

function formatInventoryDelta(facts: TaskReportFacts): string {
  const deltas = facts.inventory_delta.filter((delta) => delta.count > 0);
  if (deltas.length > 0) {
    return deltas.map((delta) => `${delta.item_name} x${delta.count}`).join("、");
  }
  if (facts.target !== undefined && facts.completed_count !== undefined) {
    return `${facts.target} x${facts.completed_count}`;
  }

  return "已完成";
}

function formatInventoryFactStrings(
  deltas: readonly TaskReportInventoryFact[],
  target: string | undefined,
  completedCount: number | undefined,
): readonly string[] {
  if (deltas.length > 0) {
    return Object.freeze(deltas.map((delta) => `${delta.item_name} x${delta.count}`));
  }
  if (target !== undefined && completedCount !== undefined) {
    return Object.freeze([`${target} x${completedCount}`]);
  }

  return Object.freeze([]);
}

function createInventoryFacts(
  deltas: readonly { readonly item_name: string; readonly count: number }[] | undefined,
): readonly TaskReportInventoryFact[] {
  if (deltas === undefined) {
    return Object.freeze([]);
  }

  const counts = new Map<string, number>();
  for (const delta of deltas) {
    if (delta.count <= 0) {
      continue;
    }
    counts.set(delta.item_name, (counts.get(delta.item_name) ?? 0) + delta.count);
  }

  return Object.freeze(
    Array.from(counts.entries()).map(([item_name, count]) => Object.freeze({ item_name, count })),
  );
}

function createFailureFact(
  result: Extract<BrainTaskCardResult, { readonly status: TaskHistoryStatus.Failed }>,
): TaskReportFailureFact {
  const details = readDetails(result.error);
  const failure = result.result_summary?.failure;
  const code =
    failure?.failure_code ?? result.error.error_code ?? readCodeFromMessage(result.error.message);
  const stage =
    failure?.failure_stage ?? readString(details.failure_stage) ?? result.last_step ?? "unknown";
  const recoverable =
    failure?.recoverable ??
    resolveFailureRecoverable(result.error.error_code ?? readCodeFromMessage(result.error.message));

  return Object.freeze({
    code,
    stage,
    recoverable,
    suggestion: createFailureSuggestion(code),
  });
}

function formatRawSummaryDigest(taskCard: BrainTaskCard): string {
  const result = taskCard.result;
  const summary = result.result_summary;
  const parts = [
    `status=${result.status}`,
    `operation=${summary?.operation ?? summary?.skill_name ?? "code"}`,
    ...(summary?.target === undefined ? [] : [`target=${summary.target}`]),
    ...(summary?.requested_count === undefined ? [] : [`requested=${summary.requested_count}`]),
    ...(summary?.completed_count === undefined ? [] : [`completed=${summary.completed_count}`]),
    ...(summary?.inventory_delta === undefined
      ? []
      : [
          `inventory=${formatInventoryFactStrings(createInventoryFacts(summary.inventory_delta), undefined, undefined).join(",")}`,
        ]),
    ...(summary?.world_key === undefined ? [] : [`world=${summary.world_key ?? "unknown"}`]),
    ...(summary?.failure === undefined
      ? []
      : [`failure=${summary.failure.failure_code}`, `stage=${summary.failure.failure_stage}`]),
  ];

  return parts.join("|");
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

function readDetails(error: { readonly details?: Readonly<Record<string, unknown>> }): Readonly<
  Record<string, unknown>
> {
  return error.details ?? {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readCodeFromMessage(message: string): string {
  const separatorIndex = message.indexOf(":");
  return separatorIndex <= 0 ? "unknown_error" : message.slice(0, separatorIndex);
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

function createFailureSuggestion(code: string): string | null {
  switch (code) {
    case "missing_materials":
    case "missing_item":
      return "下一步建议先补齐材料";
    case "missing_crafting_table":
    case "missing_crafting_table_item":
    case "crafting_table_required":
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
      return null;
  }
}
