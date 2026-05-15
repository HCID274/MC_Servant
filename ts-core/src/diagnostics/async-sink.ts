/**
 * 有界异步 diagnostics（诊断） 写入汇点。
 *
 * 该模块只负责旁路写入排队与容错，不理解具体 JSONL（结构化日志） 协议。
 */

/** AsyncDiagnosticSink（异步诊断汇点） 当前轻量统计。 */
export interface AsyncDiagnosticSinkStats {
  /** 等待写入的记录数。 */
  readonly queued: number;
  /** 当前是否有后台写入正在执行。 */
  readonly in_flight: boolean;
  /** 因队列上限被丢弃的记录数。 */
  readonly dropped_count: number;
  /** 后台写入失败次数。 */
  readonly error_count: number;
}

/** AsyncDiagnosticSink（异步诊断汇点） 对外接口。 */
export interface AsyncDiagnosticSink<TRecord> {
  /** 投递记录；不得等待真实写入。 */
  enqueue(record: TRecord): AsyncDiagnosticSinkStats;
  /** 等待已入队记录写完；用于进程关闭。 */
  flush(): Promise<AsyncDiagnosticSinkStats>;
  /** 读取当前统计。 */
  getStats(): AsyncDiagnosticSinkStats;
}

/** 创建有界异步 diagnostics（诊断） 写入汇点。 */
export function createAsyncDiagnosticSink<TRecord>(input: {
  /** 队列上限，必须大于 0。 */
  readonly maxQueueSize: number;
  /** 后台真实写入器。 */
  readonly write: (record: TRecord) => Promise<void>;
  /** 价值评分；队列满时分数低的记录优先丢弃。 */
  readonly getDropPriority?: (record: TRecord) => number;
  /** 可注入后台调度器，测试可用微任务替代。 */
  readonly schedule?: (run: () => void) => void;
}): AsyncDiagnosticSink<TRecord> {
  if (!Number.isInteger(input.maxQueueSize) || input.maxQueueSize <= 0) {
    throw new Error("async diagnostic sink maxQueueSize must be a positive integer");
  }

  const queue: TRecord[] = [];
  const getDropPriority = input.getDropPriority ?? (() => 0);
  const schedule = input.schedule ?? createDefaultAsyncSchedule;
  let inFlight = false;
  let scheduled = false;
  let droppedCount = 0;
  let errorCount = 0;
  let idleWaiters: Array<() => void> = [];

  const readStats = (): AsyncDiagnosticSinkStats =>
    Object.freeze({
      queued: queue.length,
      in_flight: inFlight,
      dropped_count: droppedCount,
      error_count: errorCount,
    });

  const notifyIdleIfNeeded = (): void => {
    if (inFlight || scheduled || queue.length > 0) {
      return;
    }

    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  };

  const scheduleDrain = (): void => {
    if (scheduled || inFlight) {
      return;
    }

    scheduled = true;
    schedule(() => {
      scheduled = false;
      void drain();
    });
  };

  const drain = async (): Promise<void> => {
    if (inFlight) {
      return;
    }

    inFlight = true;
    try {
      while (queue.length > 0) {
        const record = queue.shift();

        if (record === undefined) {
          continue;
        }

        try {
          await input.write(record);
        } catch (error) {
          errorCount += 1;
          console.warn("[diagnostics] async diagnostic sink write failed", {
            error_count: errorCount,
            error_summary: summarizeError(error),
          });
        }
      }
    } finally {
      inFlight = false;
      notifyIdleIfNeeded();
    }
  };

  const sink: AsyncDiagnosticSink<TRecord> = {
    enqueue(record: TRecord) {
      if (queue.length >= input.maxQueueSize) {
        const newPriority = getDropPriority(record);
        let dropIndex = -1;
        let lowestPriority = newPriority;

        for (let index = 0; index < queue.length; index += 1) {
          const priority = getDropPriority(queue[index] as TRecord);

          if (priority < lowestPriority) {
            lowestPriority = priority;
            dropIndex = index;
          }
        }

        if (dropIndex >= 0) {
          queue.splice(dropIndex, 1);
          queue.push(record);
        }

        droppedCount += 1;
        scheduleDrain();

        return readStats();
      }

      queue.push(record);
      scheduleDrain();

      return readStats();
    },

    async flush() {
      scheduleDrain();

      if (queue.length > 0 || inFlight || scheduled) {
        await new Promise<void>((resolve) => {
          idleWaiters.push(resolve);
          notifyIdleIfNeeded();
        });
      }

      return readStats();
    },

    getStats() {
      return readStats();
    },
  };

  return Object.freeze(sink);
}

function createDefaultAsyncSchedule(run: () => void): void {
  if (typeof setImmediate === "function") {
    setImmediate(run);
    return;
  }

  setTimeout(run, 0);
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
