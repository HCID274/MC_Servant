/**
 * toolchain ensure（工具链确保）公开入口。
 *
 * 具体职责沉到 ./toolchain-ensure/ 内部：
 * - condition-checker：基于 baseline/current/facts 做最终条件检查。
 * - recovery-planner：只决定下一步补什么，不执行动作。
 * - capability-executor：执行恢复计划并记录 action summary。
 * - failure-attribution：唯一结构化失败归因出口。
 */

import type { EnsureDependencyParams, ToolchainActionSummary } from "../core-ports/skills.js";
import { NOOP_SKILL_EXECUTION_CONTROL } from "../core-ports/skills.js";
import { executeRecoveryPlan } from "./toolchain-ensure/capability-executor.js";
import { planRecovery } from "./toolchain-ensure/recovery-planner.js";
import type {
  ResolverContext,
  ToolchainEnsureDependencies,
  ToolchainEnsureExecutor,
  ToolchainEnsureInventoryReader,
} from "./toolchain-ensure/types.js";

export type {
  ToolchainEnsureDependencies,
  ToolchainEnsureExecutor,
  ToolchainEnsureInventoryReader,
} from "./toolchain-ensure/types.js";
export { evaluateEnsureCondition } from "./toolchain-ensure/condition-checker.js";

/** 创建工具链 ensure（确保） 解析器；只根据结构化失败补局部依赖，不直接操作 runtime（运行时）。 */
export function createToolchainEnsureExecutor(
  dependencies: ToolchainEnsureDependencies,
): ToolchainEnsureExecutor {
  return Object.freeze({
    async ensureDependency(
      params: Readonly<EnsureDependencyParams>,
      control = NOOP_SKILL_EXECUTION_CONTROL,
    ) {
      const context: ResolverContext = { dependencies, control };
      return resolveDependency(context, params);
    },
  });
}

async function resolveDependency(
  context: ResolverContext,
  params: Readonly<EnsureDependencyParams>,
) {
  context.control.throwIfAborted();
  const actions: ToolchainActionSummary[] = [];
  const plan = planRecovery(context, params);
  return executeRecoveryPlan(context, plan, params, actions);
}
