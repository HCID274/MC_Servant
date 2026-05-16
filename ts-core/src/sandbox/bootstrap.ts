import type { SandboxOwnerContext } from "../core-ports/sandbox.js";
import { createSandboxGoalResultScript } from "./goal-result.js";
import { createSandboxGoalSummaryScript } from "./goal-summary.js";
import { createSandboxResultFactsScript } from "./result-facts.js";
import { createSandboxSemanticActionResultScript } from "./semantic-action-result.js";

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
  const ownerJson = JSON.stringify(task.owner ?? {});
  const resultFactsScript = createSandboxResultFactsScript();
  const semanticActionResultScript = createSandboxSemanticActionResultScript();
  const goalSummaryScript = createSandboxGoalSummaryScript();
  const goalResultScript = createSandboxGoalResultScript();

  return `
    (() => {
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
      __sandboxHostCallRef.apply(undefined, ["system.tryHostCall", [method, args]], {
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
	    ${resultFactsScript}
	    ${semanticActionResultScript}
	    ${goalSummaryScript}
	    ${goalResultScript}
	    const __throwSandboxFailure = (result) => {
	      __lastActionResult = result;
	      const failure = result?.error ?? {
	        code: "semantic_action_failed",
	        message: "semantic action failed"
	      };
	      const error = new Error(failure.message ?? failure.code ?? "semantic action failed");
	      error.__sandboxFailure = failure;
	      throw error;
	    };
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
	          __throwSandboxFailure(normalizedResult);
	        }
	        return normalizedResult;
	      });
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
	        __throwSandboxFailure(preflight);
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
	          __throwSandboxFailure(recovered);
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
	      __throwSandboxFailure(lastResult);
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
    })();
  `;
}
