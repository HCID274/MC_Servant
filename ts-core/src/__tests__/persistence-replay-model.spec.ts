import { describe, expect, it } from "vitest";

import {
  BotStatus,
  ExecPriority,
  MessageSource,
  TaskHistoryStatus,
  createPersistedTaskHistoryAcceptedRecord,
  createPersistedTaskHistoryStartedPatch,
  createPersistedTaskHistoryTerminalPatch,
  createPersistedTaskLifecycleEventLogRecord,
  createPersistedTaskProgressEventLogRecord,
  createReplayRequest,
  createReplayResponse,
  createSandboxCodeJob,
  createSandboxCodeRef,
  createSandboxLogRef,
  createSkillCallJob,
  createTaskLifecycleEventLogEntry,
  createTaskLogRef,
  createTaskPersistencePlan,
  createTaskStartedLifecycleEvent,
  createTaskTerminalLifecycleEvent,
  createUnclosedTaskDetectionInput,
  detectUnclosedTasks,
} from "../index.js";

describe("persistence（持久化） 与 replay（补拉） 纯模型", () => {
  it("应对齐 accepted / started / progress / terminal 的持久化字段语义", () => {
    const job = createSandboxCodeJob({
      message_id: "task-015",
      intent_epoch: 9,
      snapshot_ts: 1_712_990_000,
      priority: ExecPriority.Normal,
      code: "await api.chat.say('persist');",
    });
    const acceptedRecord = createPersistedTaskHistoryAcceptedRecord({
      bot_id: "bot-015",
      job,
      log_ref: createSandboxLogRef({
        date: "2026-04-14",
        job_id: "task-015",
      }),
      code_ref: createSandboxCodeRef({
        date: "2026-04-14",
        job_id: "task-015",
      }),
      created_at: "2026-04-14T09:00:00.000Z",
    });
    const startedLifecycle = createTaskStartedLifecycleEvent(job);
    const startedEvent = createPersistedTaskLifecycleEventLogRecord({
      seq: 101,
      bot_id: "bot-015",
      lifecycle: startedLifecycle,
      created_at: "2026-04-14T09:00:02.000Z",
    });
    const progressEvent = createPersistedTaskProgressEventLogRecord({
      seq: 102,
      bot_id: "bot-015",
      job,
      created_at: "2026-04-14T09:00:03.000Z",
      step_index: 0,
      action: "goTo",
      status: "ok",
      params: {
        target: {
          x: 1,
          y: 64,
          z: 2,
        },
      },
      result: {
        arrived: true,
      },
      duration_ms: 5200,
    });
    const interruptedLifecycle = createTaskTerminalLifecycleEvent({
      job,
      status: TaskHistoryStatus.Interrupted,
      total_steps: 1,
      duration_ms: 5300,
      interrupt_source: {
        type: "control",
        command: "cancel",
      },
      reason: "owner_cancel",
    });
    const interruptedEvent = createPersistedTaskLifecycleEventLogRecord({
      seq: 103,
      bot_id: "bot-015",
      lifecycle: interruptedLifecycle,
      created_at: "2026-04-14T09:00:04.000Z",
    });
    const startedPatch = createPersistedTaskHistoryStartedPatch({
      id: "task-015",
      started_at: "2026-04-14T09:00:02.000Z",
    });
    const interruptedPatch = createPersistedTaskHistoryTerminalPatch({
      id: "task-015",
      status: TaskHistoryStatus.Interrupted,
      finished_at: "2026-04-14T09:00:04.000Z",
      duration_ms: 5300,
      total_steps: 1,
      interrupt_source: {
        type: "control",
        command: "cancel",
      },
      reason: "owner_cancel",
    });

    expect(acceptedRecord.status).toBe(TaskHistoryStatus.Accepted);
    expect(acceptedRecord.log_ref).toBe("sandbox/2026-04-14/task-015.jsonl");
    expect(acceptedRecord.type).toBe("sandbox_code");
    expect(startedEvent.type).toBe("task.started");
    expect(startedEvent.payload.job_id).toBe("task-015");
    expect(progressEvent.type).toBe("step.progress");
    expect(progressEvent.payload.step_index).toBe(0);
    expect(interruptedEvent.type).toBe("task.interrupted");
    expect(interruptedPatch.status).toBe(TaskHistoryStatus.Interrupted);
    expect(startedPatch.status).toBe(TaskHistoryStatus.Started);
    expect(Object.isFrozen(progressEvent.payload)).toBe(true);
    expect(
      Object.isFrozen(
        (progressEvent.payload as { params?: { target?: object } }).params?.target ?? {},
      ),
    ).toBe(true);

    const skillJob = createSkillCallJob({
      message_id: "task-skill",
      intent_epoch: 10,
      snapshot_ts: 1_712_990_010,
      priority: ExecPriority.Normal,
      skill: "goTo",
      params: {
        x: 3,
        y: 64,
        z: 4,
      },
    });

    expect(
      createPersistedTaskHistoryAcceptedRecord({
        bot_id: "bot-015",
        job: skillJob,
        log_ref: createTaskLogRef({
          date: "2026-04-14",
          job_id: "task-skill",
        }),
        created_at: "2026-04-14T09:01:00.000Z",
      }).log_ref,
    ).toBe("tasks/2026-04-14/task-skill.jsonl");

    expect(() =>
      createPersistedTaskHistoryAcceptedRecord({
        bot_id: "bot-015",
        job: skillJob,
        log_ref: createSandboxLogRef({
          date: "2026-04-14",
          job_id: "task-skill",
        }),
        created_at: "2026-04-14T09:01:00.000Z",
      }),
    ).toThrow(/tasks\/\*\.jsonl/);
  });

  it("应锁死 failed / interrupted 的任务历史字段完整性", () => {
    expect(() =>
      createPersistedTaskHistoryTerminalPatch({
        id: "task-failed",
        status: TaskHistoryStatus.Failed,
        finished_at: "2026-04-14T09:10:00.000Z",
        duration_ms: 1000,
        total_steps: 1,
      }),
    ).toThrow(/requires error/);

    expect(() =>
      createPersistedTaskHistoryTerminalPatch({
        id: "task-interrupted",
        status: TaskHistoryStatus.Interrupted,
        finished_at: "2026-04-14T09:10:00.000Z",
        duration_ms: 1000,
        total_steps: 1,
        interrupt_source: {
          type: "control",
          command: "cancel",
        },
      }),
    ).toThrow(/requires reason/);
  });

  it("应表达阶段化写入顺序与未闭合任务检测模型", () => {
    const job = createSandboxCodeJob({
      message_id: "task-open",
      intent_epoch: 10,
      snapshot_ts: 1_712_990_100,
      priority: ExecPriority.Urgent,
      code: "await api.chat.say('open');",
    });
    const otherJob = createSandboxCodeJob({
      message_id: "task-closed",
      intent_epoch: 11,
      snapshot_ts: 1_712_990_101,
      priority: ExecPriority.Urgent,
      code: "await api.chat.say('closed');",
    });
    const detectionInput = createUnclosedTaskDetectionInput({
      bot_id: "bot-015",
      started_events: [
        createPersistedTaskLifecycleEventLogRecord({
          seq: 201,
          bot_id: "bot-015",
          lifecycle: createTaskStartedLifecycleEvent(job),
          created_at: "2026-04-14T10:00:00.000Z",
        }),
        createPersistedTaskLifecycleEventLogRecord({
          seq: 200,
          bot_id: "bot-015",
          lifecycle: createTaskStartedLifecycleEvent(otherJob),
          created_at: "2026-04-14T09:59:00.000Z",
        }),
      ],
      terminal_events: [
        createPersistedTaskLifecycleEventLogRecord({
          seq: 202,
          bot_id: "bot-015",
          lifecycle: createTaskTerminalLifecycleEvent({
            job: otherJob,
            status: TaskHistoryStatus.Completed,
            total_steps: 1,
            duration_ms: 3000,
          }),
          created_at: "2026-04-14T10:00:03.000Z",
        }),
      ],
    });
    const detection = detectUnclosedTasks(detectionInput);
    const terminalPlan = createTaskPersistencePlan({
      phase: "terminal",
    });
    const brainPlan = createTaskPersistencePlan({
      phase: "brain_summary",
      includeSessionAggregation: true,
    });

    expect(terminalPlan.map((step) => step.order)).toEqual([7, 8, 9]);
    expect(terminalPlan.map((step) => step.target)).toEqual([
      "task_history",
      "event_log",
      "brain_queue",
    ]);
    expect(brainPlan.map((step) => step.target)).toEqual(["task_summaries", "session_summaries"]);
    expect(detection.open_tasks).toEqual([
      {
        job_id: "task-open",
        type: "sandbox_code",
        message_id: "task-open",
        epoch: 10,
        started_seq: 201,
        started_at: "2026-04-14T10:00:00.000Z",
      },
    ]);
    expect(Object.isFrozen(detection.open_tasks)).toBe(true);
  });

  it("应让 replay（补拉） 只返回排序后的只读事件批次", () => {
    const request = createReplayRequest({
      botId: "bot-015",
      afterSeq: 300,
      limit: 2,
    });
    const response = createReplayResponse({
      request,
      state: {
        bot_id: "bot-015",
        status: BotStatus.EXECUTING,
        intent_epoch: 12,
        last_event_seq: 303,
        updated_at: "2026-04-14T10:30:00.000Z",
        active_task_id: "task-open",
      },
      events: [
        createTaskLifecycleEventLogEntry({
          eventId: "evt-303",
          lifecycle: createTaskTerminalLifecycleEvent({
            job: createSandboxCodeJob({
              message_id: "task-z",
              intent_epoch: 12,
              snapshot_ts: 1_712_990_300,
              priority: ExecPriority.Normal,
              code: "await api.chat.say('z');",
            }),
            status: TaskHistoryStatus.Completed,
            total_steps: 1,
            duration_ms: 100,
          }),
          source: MessageSource.System,
          timestamp: "2026-04-14T10:30:03.000Z",
          botId: "bot-015",
        }),
        createTaskLifecycleEventLogEntry({
          eventId: "evt-299",
          lifecycle: createTaskStartedLifecycleEvent(
            createSandboxCodeJob({
              message_id: "task-old",
              intent_epoch: 11,
              snapshot_ts: 1_712_990_299,
              priority: ExecPriority.Normal,
              code: "await api.chat.say('old');",
            }),
          ),
          source: MessageSource.System,
          timestamp: "2026-04-14T10:29:59.000Z",
          botId: "bot-015",
        }),
      ].map((event, index) => ({
        seq: index === 0 ? 303 : 299,
        bot_id: event.botId ?? "bot-015",
        type: event.type,
        created_at: event.timestamp,
        payload: event.payload,
      })),
    });

    expect(response.events.map((event) => event.seq)).toEqual([303]);
    expect(Object.isFrozen(response.events[0]?.payload ?? {})).toBe(true);
  });
});
