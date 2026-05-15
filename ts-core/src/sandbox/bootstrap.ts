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
    const __goalFrames = [];
    const __semanticCall = (method, args) =>
      (__ensureDepth > 0 ? __sandboxTryCall(method, args) : __sandboxCall(method, args)).then((result) => {
        __lastActionResult = result;
        const frame = __goalFrames[__goalFrames.length - 1];
        if (frame) {
          frame.results.push(result);
        }
        return result;
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
    const __readActionSummary = (result, condition) => {
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
        completed_count: completedCount,
        ...(inventoryDelta ? { inventory_delta: inventoryDelta } : {}),
        ...(__readWorldKey(data) !== undefined ? { world_key: __readWorldKey(data) } : {})
      };
    };
    const __createGoalSuccess = (name, startedAt, result, condition, frame) => {
      const data = __readResultData(result);
      const actionSummaries = (frame?.results ?? []).map((entry) => __readActionSummary(entry, undefined));
      const successfulActionCount = actionSummaries.filter((entry) =>
        (entry.inventory_delta?.length ?? 0) > 0 || (entry.completed_count ?? 0) > 0 || "target" in entry
      ).length;
      const effectiveCondition = successfulActionCount > 1 ? undefined : condition;
      const mergedInventoryDelta = __mergeInventoryDelta(actionSummaries.flatMap((entry) => entry.inventory_delta ?? []));
      const completedCount = mergedInventoryDelta
        ? mergedInventoryDelta.reduce((sum, delta) => sum + delta.count, 0)
        : __readCompletedCount(data, effectiveCondition);
      const target = __readTarget(data, effectiveCondition);
      const requestedCount = __readRequestedCount(effectiveCondition, completedCount);
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
          ...(successfulActionCount > 1 ? { action_results: actionSummaries } : {})
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
        condition,
        baseline: evaluation.baseline,
        current: evaluation.current,
        completed_count: evaluation.completed_count,
        target_count: evaluation.target_count,
        missing_count: evaluation.missing_count,
        resolved_targets: evaluation.resolved_targets,
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
      const frame = { results: [] };
      __goalFrames.push(frame);
      try {
        const result = await body();
        const finalResult = result === undefined ? __lastActionResult : result;
        const condition = __lastEnsureCondition ?? conditionBefore;
        if (__isFailedResult(finalResult)) {
          return __createGoalFailure(name, startedAt, finalResult.error, condition);
        }
        return __createGoalSuccess(name, startedAt, finalResult, condition, frame);
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
    globalThis.api = Object.freeze({
      bot: Object.freeze({
        goTo: (...args) => __sandboxCall("bot.goTo", args),
        mine: (...args) => __sandboxCall("bot.mine", args),
        collect: (...args) => __sandboxCall("bot.collect", args),
        equip: (...args) => __sandboxCall("bot.equip", args),
        cutTree: (...args) => __sandboxCall("bot.cutTree", args),
        craft: (...args) => __sandboxCall("bot.craft", args),
        place: (...args) => __sandboxCall("bot.place", args),
        placeCraftingTable: (...args) => __sandboxCall("bot.placeCraftingTable", args)
      }),
      chat: Object.freeze({
        say: (...args) => __sandboxCall("chat.say", args),
        report: (...args) => __sandboxCall("chat.report", args)
      }),
      owner: __owner,
      task: Object.freeze(${taskJson})
    });
  `;
}
