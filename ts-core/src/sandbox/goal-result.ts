/**
 * 沙箱 runGoal 结果聚合脚本。
 *
 * 这里生成 isolated-vm 内运行的纯事实聚合函数；只消费动作结果和 ensure 条件评估，
 * 不生成用户话术，也不为缺失完成证明补默认成功。
 */
export function createSandboxGoalResultScript(): string {
  return `
    const __isGoalResult = (value) =>
      value !== null && typeof value === "object" && value.kind === "goal_result";
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
  `;
}
