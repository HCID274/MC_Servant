import { type TaskReportFacts, formatInventoryDeltaFact, formatRecoverable } from "./facts.js";

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

function formatCompletedReport(facts: TaskReportFacts): string {
  const itemText = formatInventoryDeltaFact(facts);
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
