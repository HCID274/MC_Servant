/**
 * 沙箱 goal summary 聚合脚本。
 *
 * 只把已存在的动作事实和 condition evaluation 投影成任务摘要需要的事实结构；
 * 不做动作 proof 裁决，不读 runtime，不生成最终用户话术。
 */
export function createSandboxGoalSummaryScript(): string {
  return `
    const __createInventoryDelta = (target, count, condition) => {
      if (typeof target !== "string" || count <= 0) return undefined;
      if (condition?.kind === "equipped" || condition?.kind === "placed") return undefined;
      return [{ item_name: target, count }];
    };
    const __mergeInventoryDelta = (deltas) => {
      const counts = new Map();
      for (const delta of deltas.flat()) {
        if (!delta || typeof delta.item_name !== "string" || typeof delta.count !== "number" || delta.count <= 0) continue;
        counts.set(delta.item_name, (counts.get(delta.item_name) ?? 0) + delta.count);
      }
      const merged = Array.from(counts.entries()).map(([item_name, count]) => ({ item_name, count }));
      return merged.length > 0 ? merged : undefined;
    };
    const __readActionSummary = (entry, condition) => {
      const result = entry?.result ?? entry;
      const data = __readResultData(result);
      const completedCount = __readCompletedCount(data, condition);
      let target = __readTarget(data, condition);
      let inventoryDelta = __createInventoryDelta(target, completedCount, condition);
      if (data !== null && typeof data === "object") {
        if (data.skill === "cutTree") {
          target = data.clusters?.find?.((cluster) => cluster?.collected_count > 0)?.log_block_name ?? data.clusters?.[0]?.log_block_name ?? data.log_block_name ?? "logs";
          inventoryDelta = __createInventoryDelta(target, Number(data.collected_count ?? 0), undefined);
        } else if (data.skill === "mine") {
          target = data.collected_item_name ?? data.block_name ?? target;
          inventoryDelta = __createInventoryDelta(target, Number(data.collected_count ?? completedCount), undefined);
        } else if (data.skill === "collect" && Array.isArray(data.collected)) {
          inventoryDelta = data.collected
            .filter((item) => typeof item?.name === "string" && typeof item?.count === "number" && item.count > 0)
            .map((item) => ({ item_name: item.name, count: item.count }));
        } else if (data.skill === "equip" || data.skill === "goTo" || data.skill === "place") {
          inventoryDelta = undefined;
        }
      }
      return {
        ...(typeof target === "string" ? { target } : {}),
        ...(entry?.method ? { action: String(entry.method).replace(/^bot\\./, "") } : {}),
        completed_count: completedCount,
        ...(inventoryDelta ? { inventory_delta: inventoryDelta } : {}),
        ...(__readWorldKey(data) !== undefined ? { world_key: __readWorldKey(data) } : {})
      };
    };
    const __readConditionEvaluation = (result) => {
      const data = __readResultData(result);
      const evaluation = data?.condition_evaluation;
      return evaluation !== null && typeof evaluation === "object" && evaluation.ok === true
        ? evaluation
        : null;
    };
    const __readConditionEvaluationTarget = (evaluation, condition) => {
      const resolvedTarget = Array.isArray(evaluation?.resolved_targets)
        ? evaluation.resolved_targets.find((target) => typeof target === "string")
        : undefined;
      return resolvedTarget ?? __readTarget(null, condition);
    };
    const __readConditionEvaluationSummary = (evaluation) => {
      const condition = evaluation.condition;
      const completedCount = Number(evaluation.completed_count ?? 0);
      const target = __readConditionEvaluationTarget(evaluation, condition);
      return {
        ...(typeof target === "string" ? { target } : {}),
        completed_count: completedCount,
        ...(__createInventoryDelta(target, completedCount, condition)
          ? { inventory_delta: __createInventoryDelta(target, completedCount, condition) }
          : {}),
        ...(__readWorldKey(evaluation.current) !== undefined ? { world_key: __readWorldKey(evaluation.current) } : {})
      };
    };
    const __createGoalSuccess = (name, startedAt, result, condition, frame, ensureResults) => {
      const data = __readResultData(result);
      const frameResults = frame?.results ?? [];
      const actionSummaries = frameResults.map((entry) => __readActionSummary(entry, undefined));
      const conditionEvaluations = (ensureResults ?? [])
        .map((ensureResult) => __readConditionEvaluation(ensureResult))
        .filter(Boolean);
      const directActionSummaries = frameResults
        .filter((entry) => Number(entry.ensure_depth ?? 0) <= 0)
        .map((entry) => __readActionSummary(entry, undefined));
      const conditionSummaries = conditionEvaluations.map((evaluation) => __readConditionEvaluationSummary(evaluation));
      const directInventoryDelta = __mergeInventoryDelta(directActionSummaries.flatMap((entry) => entry.inventory_delta ?? []));
      const effectiveCondition = conditionEvaluations.length === 1 && !directInventoryDelta
        ? conditionEvaluations[0].condition
        : condition;
      const mergedInventoryDelta = __mergeInventoryDelta([
        ...(directInventoryDelta ?? []),
        ...conditionSummaries.flatMap((entry) => entry.inventory_delta ?? [])
      ]);
      const completedCount = mergedInventoryDelta
        ? mergedInventoryDelta.reduce((sum, delta) => sum + delta.count, 0)
        : __readCompletedCount(data, effectiveCondition);
      const target = mergedInventoryDelta && mergedInventoryDelta.length > 1
        ? undefined
        : conditionSummaries[0]?.target ?? __readTarget(data, effectiveCondition);
      const requestedCount = effectiveCondition
        ? __readRequestedCount(effectiveCondition, completedCount)
        : undefined;
      const inventoryDelta = mergedInventoryDelta ?? __createInventoryDelta(target, completedCount, effectiveCondition);
      const worldKey = [...actionSummaries].reverse().find((entry) => "world_key" in entry)?.world_key ?? __readWorldKey(data);
      return __deepFreeze({
        kind: "goal_result",
        ok: true,
        name,
        duration_ms: Math.max(0, Date.now() - startedAt),
        ...(effectiveCondition ? { condition: effectiveCondition } : {}),
        summary: {
          ...(typeof target === "string" ? { target } : {}),
          ...(typeof requestedCount === "number" ? { requested_count: requestedCount } : {}),
          completed_count: completedCount,
          ...(inventoryDelta ? { inventory_delta: inventoryDelta } : {}),
          ...(worldKey !== undefined ? { world_key: worldKey } : {}),
          ...(actionSummaries.length > 1 ? { action_results: actionSummaries } : {})
        }
      });
    };
  `;
}
