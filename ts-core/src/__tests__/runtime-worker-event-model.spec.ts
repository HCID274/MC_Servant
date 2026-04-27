import { describe, expect, it } from "vitest";

import {
  ExecPriority,
  MessageSource,
  TaskHistoryStatus,
  createBotWorkerActions,
  createBotWorkerTask,
  createConversationReply,
  createConversationRouteDecision,
  createConversationWorkerActions,
  createMessageTriage,
  createSandboxCodeJob,
  createTaskLifecycleEventLogEntry,
} from "../index.js";

describe("runtime（运行时） 生命周期事件与 worker（工作线程） 动作闭环", () => {
  it("应让 ConversationWorker（对话工作线程） 为执行任务补出 accepted（已接受） 生命周期事件意图", () => {
    const route = createConversationRouteDecision({
      triage: createMessageTriage({
        intent: "task",
        priority: "normal",
        reason: "owner_task",
      }),
      message: "去前面看看",
      has_active_task: false,
    });
    if (route.kind !== "plan_exec") {
      throw new Error("expected plan_exec route");
    }

    const actions = createConversationWorkerActions({
      bot_id: "bot-012",
      route,
      intent_epoch: 21,
      reply: createConversationReply({
        mode: "llm",
        reply: "我先过去看一下",
      }),
      exec_job: createSandboxCodeJob({
        message_id: "msg-accepted",
        intent_epoch: 21,
        snapshot_ts: 1_712_950_000,
        priority: ExecPriority.Normal,
        code: "await api.chat.say('收到');",
      }),
    });
    const acceptedAction = actions.find((action) => action.type === "emit_task_lifecycle");

    if (!acceptedAction || acceptedAction.type !== "emit_task_lifecycle") {
      throw new Error("expected accepted lifecycle action");
    }

    expect(acceptedAction.lifecycle.status).toBe(TaskHistoryStatus.Accepted);
    expect(acceptedAction.lifecycle.event_type).toBe("task.accepted");
    expect(Object.isFrozen(acceptedAction.lifecycle)).toBe(true);
    expect(Object.isFrozen(acceptedAction.lifecycle.payload)).toBe(true);
  });

  it("应让 BotWorker（机器人工作线程） 的 discarded（已丢弃） 与 terminal（终态） 走不同后续链路", () => {
    const task = createBotWorkerTask({
      bot_id: "bot-012",
      exec_job: createSandboxCodeJob({
        message_id: "msg-terminal",
        intent_epoch: 22,
        snapshot_ts: 1_712_950_001,
        priority: ExecPriority.Urgent,
        code: "await api.chat.say('执行');",
      }),
    });
    const discardedActions = createBotWorkerActions({
      task,
      phase: "discarded",
      discard_reason: "snapshot_stale",
    });
    const terminalActions = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Interrupted,
      total_steps: 3,
      duration_ms: 9100,
      interrupt_source: {
        type: "control",
        command: "cancel",
      },
      reason: "owner_cancel",
    });

    expect(discardedActions.map((action) => action.type)).toEqual(["emit_task_lifecycle"]);
    expect(terminalActions.map((action) => action.type)).toEqual([
      "emit_task_lifecycle",
      "enqueue_brain",
      "persist_sandbox_experience",
    ]);
    const terminalLifecycle = terminalActions[0];
    if (terminalLifecycle?.type !== "emit_task_lifecycle") {
      throw new Error("expected terminal lifecycle action");
    }
    expect(terminalLifecycle.lifecycle.status).toBe(TaskHistoryStatus.Interrupted);
    if (terminalLifecycle.lifecycle.status !== TaskHistoryStatus.Interrupted) {
      throw new Error("expected interrupted lifecycle payload");
    }
    expect(
      Object.isFrozen(
        (terminalLifecycle.lifecycle.payload as { interrupt_source: object }).interrupt_source,
      ),
    ).toBe(true);
    expect(terminalActions[2]).toMatchObject({
      type: "persist_sandbox_experience",
      experience: {
        message_id: "msg-terminal",
        status: TaskHistoryStatus.Interrupted,
      },
    });
  });

  it("应能从根导出直接创建任务生命周期 event_log（事件日志） 条目", () => {
    const job = createSandboxCodeJob({
      message_id: "msg-root-export",
      intent_epoch: 23,
      snapshot_ts: 1_712_950_002,
      priority: ExecPriority.Background,
      code: "await api.chat.say('root');",
    });
    const actions = createBotWorkerActions({
      task: createBotWorkerTask({
        bot_id: "bot-012",
        exec_job: job,
      }),
      phase: "started",
    });
    const lifecycleAction = actions[0];

    if (!lifecycleAction || lifecycleAction.type !== "emit_task_lifecycle") {
      throw new Error("expected started lifecycle action");
    }

    const logEntry = createTaskLifecycleEventLogEntry({
      eventId: "evt-root-001",
      lifecycle: lifecycleAction.lifecycle,
      source: MessageSource.Web,
      timestamp: "2026-04-14T12:00:00.000Z",
      botId: "bot-012",
    });

    expect(logEntry.type).toBe("task.started");
    expect(logEntry.botId).toBe("bot-012");
    expect(logEntry.taskId).toBe("msg-root-export");
    expect(logEntry.payload).toMatchObject({
      job_id: "msg-root-export",
      status: "started",
    });
  });

  it("应拒绝构造缺少 interrupt_source（中断来源） 或 reason（中断原因） 的 interrupted（中断） 终态动作", () => {
    const task = createBotWorkerTask({
      bot_id: "bot-012",
      exec_job: createSandboxCodeJob({
        message_id: "msg-interrupted-invalid",
        intent_epoch: 24,
        snapshot_ts: 1_712_950_003,
        priority: ExecPriority.Normal,
        code: "await api.chat.say('interrupt');",
      }),
    });

    expect(() =>
      createBotWorkerActions({
        task,
        phase: "terminal",
        status: TaskHistoryStatus.Interrupted,
        total_steps: 2,
        duration_ms: 1200,
        reason: "owner_cancel",
      } as unknown as Parameters<typeof createBotWorkerActions>[0]),
    ).toThrow(/require interrupt_source/);

    expect(() =>
      createBotWorkerActions({
        task,
        phase: "terminal",
        status: TaskHistoryStatus.Interrupted,
        total_steps: 2,
        duration_ms: 1200,
        interrupt_source: {
          type: "control",
          command: "cancel",
        },
      } as unknown as Parameters<typeof createBotWorkerActions>[0]),
    ).toThrow(/require reason/);
  });
});
