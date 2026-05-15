/**
 * 进度看门狗（Progress Watchdog）：基于真实进展刷新空闲计时器。
 *
 * 核心思路：不是简单地用固定超时杀掉长任务，而是检测"是否有真实进展"。
 * 只要 Bot 的位置/状态在推进，计时器就重置；一旦真正卡住不动了，才触发超时。
 * 这避免了"正在挖掘但耗时较长"被固定 wall-clock timeout 误杀的问题。
 */

export interface ProgressWatchdog<TProgress> {
  /** 看门狗启动时间戳。 */
  readonly startedAt: number;
  /** 如果当前进度比上次有进展，就重置空闲计时器。 */
  markProgressIfAdvanced(now?: number): void;
  /** 检查是否还存活；如果空闲超时则抛出异常。 */
  assertAlive(now?: number): void;
}

/**
 * 看门狗输入参数。
 * @template TProgress 进度快照类型，可以是坐标、方块状态等任何可比较的值。
 */
export interface ProgressWatchdogInput<TProgress> {
  /** 空闲超时毫秒数。 */
  readonly idleTimeoutMs: number;
  /** 读取当前进度快照。 */
  readonly readProgress: () => TProgress;
  /** 判断两个进度快照之间是否有"进展"（true 表示有进展）。 */
  readonly isProgressAdvanced: (previous: TProgress, current: TProgress) => boolean;
  /** 将进度快照格式化为可读字符串，用于诊断日志。 */
  readonly describeProgress: (progress: TProgress) => string;
  /** 生成超时错误消息，包含空闲时间和进度快照。 */
  readonly createTimeoutMessage: (input: {
    readonly idleMs: number;
    readonly lastProgress: TProgress;
    readonly currentProgress: TProgress;
  }) => string;
  /** 可选诊断日志接收器。 */
  readonly diagnostics?: string[];
  /** 诊断日志前缀。 */
  readonly diagnosticPrefix?: string;
}

/** 基于真实进展刷新 idle 计时，避免长任务被固定 wall-clock timeout 误杀。 */
export function createProgressWatchdog<TProgress>(
  input: ProgressWatchdogInput<TProgress>,
): ProgressWatchdog<TProgress> {
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastProgress = input.readProgress();

  input.diagnostics?.push(
    `${input.diagnosticPrefix ?? "watchdog"}_watchdog_start:${input.describeProgress(lastProgress)}`,
  );

  return Object.freeze({
    startedAt,
    markProgressIfAdvanced(now = Date.now()) {
      const current = input.readProgress();
      if (!input.isProgressAdvanced(lastProgress, current)) return;
      lastProgressAt = now;
      lastProgress = current;
      input.diagnostics?.push(
        `${input.diagnosticPrefix ?? "watchdog"}_watchdog_progress:${input.describeProgress(current)};elapsed_ms=${now - startedAt}`,
      );
    },
    assertAlive(now = Date.now()) {
      const current = input.readProgress();
      if (input.isProgressAdvanced(lastProgress, current)) {
        lastProgressAt = now;
        lastProgress = current;
        input.diagnostics?.push(
          `${input.diagnosticPrefix ?? "watchdog"}_watchdog_progress:${input.describeProgress(current)};elapsed_ms=${now - startedAt}`,
        );
        return;
      }

      const idleMs = now - lastProgressAt;
      if (idleMs < input.idleTimeoutMs) return;
      throw new Error(
        input.createTimeoutMessage({
          idleMs,
          lastProgress,
          currentProgress: current,
        }),
      );
    },
  });
}

/** 等待 Promise 或条件满足：轮询检查条件，如果条件满足则立即返回，否则等待 Promise 完成。 */
export async function waitForPromiseOrCondition<TValue>(input: {
  readonly promise: Promise<TValue>;
  readonly condition: () => boolean;
  readonly idleTimeoutMs: number;
  readonly pollMs: number;
  readonly timeoutMessage: () => string;
  readonly throwIfAborted?: () => void;
  readonly diagnostics?: string[];
  readonly diagnosticPrefix?: string;
}): Promise<TValue | "condition_met"> {
  const startedAt = Date.now();
  let isSettled = false;
  let isRejected = false;
  let settledValue: TValue | undefined;
  let settledReason: unknown;

  input.promise.then(
    (value) => {
      isSettled = true;
      settledValue = value;
    },
    (reason) => {
      isSettled = true;
      isRejected = true;
      settledReason = reason;
    },
  );

  input.diagnostics?.push(`${input.diagnosticPrefix ?? "watchdog"}_watchdog_start`);

  while (true) {
    input.throwIfAborted?.();
    if (input.condition()) {
      input.diagnostics?.push(
        `${input.diagnosticPrefix ?? "watchdog"}_watchdog_condition_met:elapsed_ms=${Date.now() - startedAt}`,
      );
      return "condition_met";
    }

    if (isSettled && !isRejected) return settledValue as TValue;
    if (isSettled && isRejected) {
      input.throwIfAborted?.();
      if (input.condition()) return "condition_met";
      throw settledReason;
    }

    const idleMs = Date.now() - startedAt;
    if (idleMs >= input.idleTimeoutMs) {
      if (input.condition()) return "condition_met";
      throw new Error(input.timeoutMessage());
    }

    await delay(Math.min(input.pollMs, Math.max(1, input.idleTimeoutMs - idleMs)));
    input.throwIfAborted?.();
  }
}

/** 延迟指定毫秒。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
