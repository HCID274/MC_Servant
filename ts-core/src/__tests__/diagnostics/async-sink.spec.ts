import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ExecPriority,
  TaskHistoryStatus,
  type TaskLifecycleEvent,
  createAsyncDiagnosticSink,
  createCodeJob,
  createDiagnosticsCatalog,
  createLlmDiagnosticSummary,
  createLlmLogLine,
  createLlmLogRef,
  createLocalConversationReplyLogSink,
  createSandboxCodeRef,
  createSandboxError,
  createSandboxExecutionFailure,
  createSandboxExecutionInterrupted,
  createSandboxExecutionRequest,
  createSandboxExperienceDraft,
  createSandboxLogLine,
  createSandboxLogRef,
  createSandboxStepResult,
  createTaskLifecycleSummaryJsonlLine,
  createTaskLogLine,
  createTaskLogRef,
  createTaskStartedLifecycleEvent,
  createTaskTerminalLifecycleEvent,
  describe,
  expect,
  it,
} from "../sandbox/diagnostics-and-execution.fixture.js";

describe("diagnostics async sink 行为", () => {
  it("AsyncDiagnosticSink（异步诊断汇点） 应投递后立即返回并由 flush（刷盘） 等待慢写", async () => {
    const scheduled: Array<() => void> = [];
    let releaseWrite: (() => void) | undefined;
    const writes: string[] = [];
    const sink = createAsyncDiagnosticSink({
      maxQueueSize: 4,
      schedule: (run) => {
        scheduled.push(run);
      },
      write: async (record: string) => {
        writes.push(record);
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
      },
    });

    const stats = sink.enqueue("triage-ok");

    expect(stats).toMatchObject({ queued: 1, dropped_count: 0, error_count: 0 });
    expect(writes).toEqual([]);
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    await Promise.resolve();

    expect(sink.getStats()).toMatchObject({ queued: 0, in_flight: true });
    expect(writes).toEqual(["triage-ok"]);

    const flushPromise = sink.flush();
    releaseWrite?.();

    await expect(flushPromise).resolves.toMatchObject({
      queued: 0,
      in_flight: false,
      dropped_count: 0,
      error_count: 0,
    });
  });

  it("AsyncDiagnosticSink（异步诊断汇点） 队列满时应优先保留高价值失败诊断", async () => {
    const scheduled: Array<() => void> = [];
    const writes: Array<{ id: string; ok: boolean }> = [];
    const sink = createAsyncDiagnosticSink({
      maxQueueSize: 2,
      schedule: (run) => {
        scheduled.push(run);
      },
      getDropPriority: (record: { readonly ok: boolean }) => (record.ok ? 1 : 3),
      write: async (record: { id: string; ok: boolean }) => {
        writes.push(record);
      },
    });

    sink.enqueue({ id: "chat-ok-1", ok: true });
    sink.enqueue({ id: "chat-ok-2", ok: true });
    const stats = sink.enqueue({ id: "plan-failed", ok: false });

    expect(stats).toMatchObject({ queued: 2, dropped_count: 1, error_count: 0 });

    scheduled.shift()?.();
    await sink.flush();

    expect(writes.map((record) => record.id)).toEqual(["chat-ok-2", "plan-failed"]);
  });

  it("AsyncDiagnosticSink（异步诊断汇点） 写入失败不应阻塞 flush（刷盘），但要记录 error_count（错误数）", async () => {
    const sink = createAsyncDiagnosticSink({
      maxQueueSize: 2,
      write: async () => {
        throw new Error("disk unavailable");
      },
    });

    sink.enqueue("chat-ok");

    await expect(sink.flush()).resolves.toMatchObject({
      queued: 0,
      in_flight: false,
      dropped_count: 0,
      error_count: 1,
    });
  });

  const createRuntimeSandboxRequest = (input: {
    code: string;
    messageId?: string;
    resourceLimits?: Parameters<typeof createSandboxResourceLimits>[0];
  }) =>
    createSandboxExecutionRequest({
      job_id: input.messageId ?? "T-027",
      bot_id: "bot-027",
      intent_epoch: 1,
      snapshot_ts: 1_712_930_001,
      code: input.code,
      log_ref: createSandboxLogRef({
        date: "2026-04-13",
        job_id: input.messageId ?? "T-027",
      }),
      resource_limits: input.resourceLimits,
    });
});
