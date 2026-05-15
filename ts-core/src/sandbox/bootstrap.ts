import type { SandboxOwnerContext } from "../core-ports/sandbox.js";

/** 沙箱执行时暴露给只读 task（任务） 分区的上下文。 */
export interface SandboxExecutionTaskContext {
  /** 任务标识。 */
  readonly id: string;
  /** 用户原始消息。 */
  readonly userMessage: string;
  /** 任务意图。 */
  readonly intent: string;
  /** 只读主人上下文。 */
  readonly owner?: SandboxOwnerContext;
}

/**
 * 创建注入 isolated-vm 的语义 API 脚本。
 *
 * 该模块只负责沙箱内 API 注入，不直接执行 BotActor 写动作。
 */
export function createSandboxBootstrapScript(task: SandboxExecutionTaskContext): string {
  const taskJson = JSON.stringify(task);
  const ownerJson = JSON.stringify(task.owner ?? {});

  return `
    const __sandboxHostCallRef = __sandboxHostCall;
    const __sandboxHostReadRef = __sandboxHostRead;
    delete globalThis.__sandboxHostCall;
    delete globalThis.__sandboxHostRead;
    const __sandboxCall = (method, args) =>
      __sandboxHostCallRef.apply(undefined, [method, args], {
        arguments: { copy: true },
        result: { promise: true, copy: true }
      });
    const __sandboxTryCall = (method, args) =>
      __sandboxHostCallRef.apply(undefined, ["system.tryFacadeCall", [method, args]], {
        arguments: { copy: true },
        result: { promise: true, copy: true }
      });
    const __sandboxRead = (method, args) =>
      __sandboxHostReadRef.apply(undefined, [method, args], {
        arguments: { copy: true },
        result: { promise: true, copy: true }
      });
    const __deepFreeze = (value) => {
      if (value === null || typeof value !== "object") {
        return value;
      }
      for (const key of Object.keys(value)) {
        __deepFreeze(value[key]);
      }
      return Object.freeze(value);
    };
    const __owner = __deepFreeze(${ownerJson});
    let __ensureDepth = 0;
    let __lastActionResult = null;
    let __lastEnsureCondition = null;
    let __ensureResults = [];
    const __goalFrames = [];
    const __semanticCall = (method, args) =>
      (__ensureDepth > 0 ? __sandboxTryCall(method, args) : __sandboxCall(method, args)).then((result) => {
        const normalizedResult =
          __ensureDepth > 0 ? result : __normalizeSemanticActionCompletion(method, args, result);
        __lastActionResult = normalizedResult;
        const frame = __goalFrames[__goalFrames.length - 1];
        if (frame) {
          frame.results.push({ method, args, result: normalizedResult, ensure_depth: __ensureDepth });
        }
        if (__isFailedResult(normalizedResult) && __ensureDepth <= 0) {
          const error = new Error(normalizedResult.error?.message ?? normalizedResult.error?.code ?? "semantic action failed");
          error.__sandboxFailure = normalizedResult.error;
          throw error;
        }
        return normalizedResult;
      });
    const __isFailedResult = (value) =>
      value !== null && typeof value === "object" && value.ok === false && value.error;
    const __isGoalResult = (value) =>
      value !== null && typeof value === "object" && value.kind === "goal_result";
    const __normalizeEnsureCondition = (condition) => {
      if (condition === null || typeof condition !== "object") {
        throw new Error("ensure condition must be an until.* condition");
      }
      if (!["gained", "gainedTag", "gainedDropOf", "has", "equipped", "placed"].includes(condition.kind)) {
        throw new Error("unsupported ensure condition: " + String(condition.kind));
      }
      if (condition.kind === "gained" || condition.kind === "has") {
        const itemName = String(condition.itemName ?? condition.item_name ?? "").trim();
        const count = Number(condition.count);
        if (itemName.length === 0 || !Number.isInteger(count) || count <= 0) {
          throw new Error("invalid until." + condition.kind + " condition");
        }
        return { kind: condition.kind, itemName, count };
      }
      if (condition.kind === "gainedTag") {
        const tagName = String(condition.tagName ?? condition.tag_name ?? "").trim();
        const count = Number(condition.count);
        if (tagName.length === 0 || !Number.isInteger(count) || count <= 0) {
          throw new Error("invalid until.gainedTag condition");
        }
        return { kind: "gainedTag", tagName, count };
      }
      if (condition.kind === "gainedDropOf") {
        const blockName = String(condition.blockName ?? condition.block_name ?? "").trim();
        const count = Number(condition.count);
        if (blockName.length === 0 || !Number.isInteger(count) || count <= 0) {
          throw new Error("invalid until.gainedDropOf condition");
        }
        return { kind: "gainedDropOf", blockName, count };
      }
      if (condition.kind === "equipped") {
        const itemName = String(condition.itemName ?? condition.item_name ?? "").trim();
        if (itemName.length === 0) {
          throw new Error("invalid until.equipped condition");
        }
        return { kind: "equipped", itemName };
      }
      const blockName = String(condition.blockName ?? condition.block_name ?? "").trim();
      if (blockName.length === 0) {
        throw new Error("invalid until.placed condition");
      }
      return { kind: "placed", blockName };
    };
    const __readResultData = (value) => {
      if (value !== null && typeof value === "object" && value.ok === true && value.data) {
        return value.data;
      }
      if (value !== null && typeof value === "object" && value.ok === true && value.result) {
        return __readResultData(value.result);
      }
      return value;
    };
    const __readCompletedCount = (data, condition) => {
      if (data !== null && typeof data === "object") {
        if (typeof data.completed_count === "number") return data.completed_count;
        if (typeof data.collected_count === "number") return data.collected_count;
        if (Array.isArray(data.collected)) {
          return data.collected.reduce((sum, item) => sum + (typeof item?.count === "number" ? item.count : 0), 0);
        }
        if (data.skill === "equip" || data.skill === "goTo") return 1;
      }
      if (condition?.kind === "equipped" || condition?.kind === "placed") return 1;
      return 0;
    };
    const __readTarget = (data, condition) => {
      if (condition?.kind === "gained" || condition?.kind === "has" || condition?.kind === "equipped") return condition.itemName;
      if (condition?.kind === "gainedTag") return condition.tagName;
      if (condition?.kind === "gainedDropOf") return data?.item_name ?? data?.resolved_targets?.[0] ?? condition.blockName;
      if (condition?.kind === "placed") return condition.blockName;
      if (data !== null && typeof data === "object") {
        return data.item_name ?? data.block_name ?? data.collected_item_name ?? data.log_block_name;
      }
      return undefined;
    };
    const __readRequestedCount = (condition, completedCount) => {
      if (condition && typeof condition.count === "number") return condition.count;
      return completedCount > 0 ? completedCount : undefined;
    };
    const __readWorldKey = (data) => {
      if (data !== null && typeof data === "object" && "world_key" in data) {
        return data.world_key ?? null;
      }
      return undefined;
    };
    const __readActionCountArg = (args, index = 1) => {
      const count = Number(args?.[index]);
      return Number.isInteger(count) && count > 0 ? count : undefined;
    };
    const __readNumericField = (data, field) =>
      data !== null && typeof data === "object" && typeof data[field] === "number"
        ? data[field]
        : undefined;
    const __createUnknownCompletionFailure = (method, args, data, reason) => ({
      ok: false,
      error: {
        action: String(method).replace(/^bot\\./, ""),
        params: { args },
        code: "unknown_completion",
        message: reason,
        details: {
          failure_stage: String(method).replace(/^bot\\./, ""),
          reason,
          result: data
        }
      }
    });
    const __createSemanticConditionFailure = (method, args, data, target, requestedCount, completedCount, reason) => ({
      ok: false,
      error: {
        action: String(method).replace(/^bot\\./, ""),
        params: { args },
        code: "condition_not_met",
        message: reason,
        details: {
          failure_stage: String(method).replace(/^bot\\./, ""),
          reason,
          target_progress: {
            action: String(method).replace(/^bot\\./, ""),
            ...(typeof target === "string" ? { target } : {}),
            ...(typeof requestedCount === "number" ? { requested_count: requestedCount, target_count: requestedCount } : {}),
            ...(typeof completedCount === "number" ? { completed_count: completedCount } : {})
          },
          ...(typeof target === "string" ? { target } : {}),
          ...(typeof requestedCount === "number" ? { requested_count: requestedCount, target_count: requestedCount } : {}),
          ...(typeof completedCount === "number" ? { completed_count: completedCount } : {}),
          ...(__readWorldKey(data) !== undefined ? { world_key: __readWorldKey(data) } : {})
        }
      }
    });
    const __normalizeSemanticActionCompletion = (method, args, result) => {
      if (__isFailedResult(result)) {
        return result;
      }
      const data = __readResultData(result);
      if (method === "bot.mine") {
        const requestedCount = __readActionCountArg(args);
        const completedCount = __readNumericField(data, "collected_count");
        const target = typeof args?.[0] === "string" ? args[0] : data?.block_name;
        if (requestedCount === undefined || completedCount === undefined || typeof data?.collected_item_name !== "string") {
          return __createUnknownCompletionFailure(method, args, data, "mine result lacks inventory completion proof");
        }
        return completedCount >= requestedCount
          ? result
          : __createSemanticConditionFailure(method, args, data, target, requestedCount, completedCount, "mine completed below requested count");
      }
      if (method === "bot.cutTree") {
        const requestedCount = __readActionCountArg(args, 0);
        const completedCount = __readNumericField(data, "collected_count");
        const target = data?.clusters?.find?.((cluster) => cluster?.collected_count > 0)?.log_block_name ?? data?.clusters?.[0]?.log_block_name ?? "logs";
        if (requestedCount === undefined || completedCount === undefined || !Array.isArray(data?.clusters)) {
          return __createUnknownCompletionFailure(method, args, data, "cutTree result lacks inventory completion proof");
        }
        return completedCount >= requestedCount
          ? result
          : __createSemanticConditionFailure(method, args, data, target, requestedCount, completedCount, "cutTree collected logs below requested count");
      }
      if (method === "bot.equip") {
        return typeof data?.item_name === "string" || typeof data?.itemName === "string"
          ? result
          : __createUnknownCompletionFailure(method, args, data, "equip result lacks equipped item proof");
      }
      if (method === "bot.goTo") {
        return data?.reached === true
          ? result
          : __createUnknownCompletionFailure(method, args, data, "goTo result lacks reached proof");
      }
      if (method === "bot.craft") {
        const requestedCount = __readActionCountArg(args);
        const completedCount = __readNumericField(data, "completed_count");
        const target = typeof args?.[0] === "string" ? args[0] : data?.item_name;
        if (requestedCount === undefined || completedCount === undefined || typeof data?.item_name !== "string") {
          return __createUnknownCompletionFailure(method, args, data, "craft result lacks inventory completion proof");
        }
        return completedCount >= requestedCount
          ? result
          : __createSemanticConditionFailure(method, args, data, target, requestedCount, completedCount, "craft completed below requested count");
      }
      if (method === "bot.place") {
        const completedCount = __readNumericField(data, "completed_count");
        const target = typeof args?.[0] === "string" ? args[0] : data?.block_name;
        if (completedCount === undefined || completedCount < 1 || typeof data?.block_name !== "string") {
          return __createUnknownCompletionFailure(method, args, data, "place result lacks placed block proof");
        }
        return result;
      }
      return result;
    };
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
    const __createGoalFailure = (name, startedAt, failure, condition) => {
      const details = failure?.details && typeof failure.details === "object" ? failure.details : {};
      return __deepFreeze({
        kind: "goal_result",
        ok: false,
        name,
        duration_ms: Math.max(0, Date.now() - startedAt),
        ...(condition ? { condition } : {}),
        failure: {
          failure_code: String(failure?.code ?? failure?.error_code ?? "facade_call_failed"),
          failure_stage: String(details.failure_stage ?? failure?.action ?? "code"),
          message: String(failure?.message ?? "code goal failed"),
          recoverable: typeof failure?.recoverable === "boolean" ? failure.recoverable : null,
          ...(Object.keys(details).length > 0 ? { details } : {})
        }
      });
    };
    const reply = (message) => __sandboxCall("chat.say", [message]);
    const report = async (task) => {
      if (__isGoalResult(task)) {
        await __sandboxCall("system.reportGoal", [task]);
        if (task.ok === false) {
          throw new Error(task.failure.failure_code);
        }
        return undefined;
      }
      return __sandboxCall("chat.report", [task]);
    };
    const goTo = (...args) => __semanticCall("bot.goTo", args);
    const mine = (...args) => __semanticCall("bot.mine", args);
    const cutTree = (...args) => __semanticCall("bot.cutTree", args);
    const collect = (...args) => __semanticCall("bot.collect", args);
    const equip = (...args) => __semanticCall("bot.equip", args);
    const craft = (...args) => __semanticCall("bot.craft", args);
    const place = (...args) => __semanticCall("bot.place", args);
    const search = (...args) => __sandboxRead("memory.search", args);
    const sleep = (ms) => __sandboxRead("system.sleep", [ms]);
    const until = async (predicate, options = {}) => {
      if (typeof predicate !== "function") {
        throw new Error("until predicate must be a function");
      }
      const timeoutMs = Number(options.timeoutMs ?? 10000);
      const intervalMs = Number(options.intervalMs ?? 250);
      const startedAt = Date.now();
      while (Date.now() - startedAt <= timeoutMs) {
        if (await predicate()) {
          return true;
        }
        await sleep(intervalMs);
      }
      return false;
    };
    until.gained = (itemName, count) => Object.freeze({ kind: "gained", itemName, count });
    until.gainedTag = (tagName, count) => Object.freeze({ kind: "gainedTag", tagName, count });
    until.gainedDropOf = (blockName, count) => Object.freeze({ kind: "gainedDropOf", blockName, count });
    until.has = (itemName, count) => Object.freeze({ kind: "has", itemName, count });
    until.equipped = (itemName) => Object.freeze({ kind: "equipped", itemName });
    until.placed = (blockName) => Object.freeze({ kind: "placed", blockName });
    const __captureConditionState = () => __sandboxRead("system.captureConditionState", []);
    const __evaluateCondition = (condition, baseline, current) =>
      __sandboxRead("system.evaluateCondition", [condition, baseline, current]);
    const __createConditionFailure = (condition, evaluation) => Object.freeze({
      action: "ensure",
      params: { condition },
      code: "condition_not_met",
      message: "ensure condition not met",
      details: {
        failure_stage: "ensure",
        reason: "ensure condition not met",
        condition,
        baseline: evaluation.baseline,
        current: evaluation.current,
        completed_count: evaluation.completed_count,
        target_count: evaluation.target_count,
        requested_count: evaluation.target_count,
        missing_count: evaluation.missing_count,
        resolved_targets: evaluation.resolved_targets,
        world_key: evaluation.current?.world_key ?? evaluation.baseline?.world_key ?? null,
        target_progress: {
          action: "ensure",
          target: evaluation.resolved_targets?.[0],
          requested_count: evaluation.target_count,
          target_count: evaluation.target_count,
          completed_count: evaluation.completed_count
        },
        evaluation
      }
    });
    const __createEnsureConditionSuccess = (evaluation, actionResult, recovered) => Object.freeze({
      ok: true,
      data: {
        skill: "ensure",
        completed_count: evaluation.completed_count,
        target_count: evaluation.target_count,
        item_name: evaluation.resolved_targets?.[0],
        resolved_targets: evaluation.resolved_targets,
        condition: evaluation.condition,
        condition_evaluation: evaluation,
        action_result: actionResult,
        ...(recovered === undefined ? {} : { recovery: recovered })
      }
    });
    const __runEnsurePreflight = async (condition) => {
      if (condition.kind !== "gainedDropOf") {
        return null;
      }
      return __sandboxTryCall("bot.ensure", [{
        failure: {
          action: "mine",
          params: { blockName: condition.blockName, count: condition.count },
          code: "preflight_mine_equipment",
          message: "ensure preflight mine equipment"
        },
        condition
      }]);
    };
    const ensure = async (action, condition) => {
      if (typeof action !== "function") {
        throw new Error("ensure first argument must be an async action function");
      }
      const normalizedCondition = __normalizeEnsureCondition(condition);
      __lastEnsureCondition = normalizedCondition;
      const preflight = await __runEnsurePreflight(normalizedCondition);
      if (__isFailedResult(preflight)) {
        __lastActionResult = preflight;
        return preflight;
      }
      const baseline = await __captureConditionState();
      let lastResult = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        __ensureDepth += 1;
        try {
          lastResult = await action();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastResult = { ok: false, error: { action: "unknown", params: {}, code: "facade_call_failed", message } };
        } finally {
          __ensureDepth -= 1;
        }
        __lastActionResult = lastResult;
        if (!__isFailedResult(lastResult)) {
          const current = await __captureConditionState();
          const evaluation = await __evaluateCondition(normalizedCondition, baseline, current);
          if (evaluation.ok === true) {
            const success = __createEnsureConditionSuccess(evaluation, lastResult, undefined);
            __lastActionResult = success;
            __ensureResults.push(success);
            return success;
          }
          lastResult = { ok: false, error: __createConditionFailure(normalizedCondition, evaluation) };
          __lastActionResult = lastResult;
        }
        const recovered = await __sandboxTryCall("bot.ensure", [{
          failure: lastResult.error,
          condition: normalizedCondition
        }]);
        if (__isFailedResult(recovered)) {
          __lastActionResult = recovered;
          return recovered;
        }
        const current = await __captureConditionState();
        const evaluation = await __evaluateCondition(normalizedCondition, baseline, current);
        if (evaluation.ok === true) {
          const success = __createEnsureConditionSuccess(evaluation, lastResult, recovered);
          __lastActionResult = success;
          __ensureResults.push(success);
          return success;
        }
        lastResult = { ok: false, error: __createConditionFailure(normalizedCondition, evaluation) };
        __lastActionResult = lastResult;
      }
      lastResult = __isFailedResult(lastResult) ? lastResult : {
        ok: false,
        error: {
          code: "condition_not_met",
          message: "ensure condition not met after retry limit",
          world_key: null,
          details: { last_result: lastResult, condition: normalizedCondition }
        }
      };
      __lastActionResult = lastResult;
      return lastResult;
    };
    const runGoal = async (goal, fn) => {
      const startedAt = Date.now();
      const name = typeof goal === "string" && goal.trim().length > 0 ? goal.trim() : "code";
      const body = typeof goal === "function" ? goal : fn;
      if (typeof body !== "function") {
        return __createGoalSuccess(name, startedAt, __lastActionResult, __lastEnsureCondition);
      }
      const conditionBefore = __lastEnsureCondition;
      __lastActionResult = null;
      __ensureResults = [];
      const frame = { results: [] };
      __goalFrames.push(frame);
      try {
        const result = await body();
        const finalResult = result === undefined ? __lastActionResult : result;
        const condition = __lastEnsureCondition ?? conditionBefore;
        if (__isFailedResult(finalResult)) {
          return __createGoalFailure(name, startedAt, finalResult.error, condition);
        }
        return __createGoalSuccess(name, startedAt, finalResult, condition, frame, __ensureResults);
      } catch (error) {
        const failure = __isFailedResult(__lastActionResult)
          ? __lastActionResult.error
          : error instanceof Error
            ? { code: error.message || "facade_call_failed", message: error.message }
            : { code: "facade_call_failed", message: String(error) };
        return __createGoalFailure(name, startedAt, failure, __lastEnsureCondition ?? conditionBefore);
      } finally {
        __goalFrames.pop();
      }
    };
    Object.assign(globalThis, {
      reply,
      runGoal,
      ensure,
      until,
      mine,
      cutTree,
      craft,
      place,
      equip,
      collect,
      goTo,
      report,
      search,
      sleep
    });
    Object.defineProperty(globalThis, "owner", {
      value: __owner,
      writable: false,
      configurable: false,
      enumerable: true
    });
  `;
}
