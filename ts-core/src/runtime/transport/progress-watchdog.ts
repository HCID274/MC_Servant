export interface ProgressWatchdog<TProgress> {
  readonly startedAt: number;
  markProgressIfAdvanced(now?: number): void;
  assertAlive(now?: number): void;
}

export interface ProgressWatchdogInput<TProgress> {
  readonly idleTimeoutMs: number;
  readonly readProgress: () => TProgress;
  readonly isProgressAdvanced: (previous: TProgress, current: TProgress) => boolean;
  readonly describeProgress: (progress: TProgress) => string;
  readonly createTimeoutMessage: (input: {
    readonly idleMs: number;
    readonly lastProgress: TProgress;
    readonly currentProgress: TProgress;
  }) => string;
  readonly diagnostics?: string[];
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
