import { describe, expect, it } from "vitest";
import { createCodeJobForSkill } from "./test-code-job.js";

import {
  BotStatus,
  ConversationPriority,
  EXTERNAL_AUTH_STATUSES,
  ExecPriority,
  ExecutionTaskKind,
  MessageSource,
  RUNTIME_EVENT_TYPES,
  TASK_HISTORY_STATUSES,
  TASK_LIFECYCLE_EVENT_TYPE_BY_STATUS,
  TASK_TERMINAL_STATUSES,
  TaskHistoryStatus,
  ThreatLevel,
  ThreatRuleId,
  canTransition,
  createCodeJob,
  createExternalAuthExecutionPlan,
  createExternalAuthPublicState,
  createExternalAuthSecretBinding,
  createExternalAuthState,
  createRuntimeReadyGate,
  createRuntimeScaffold,
  createTaskAcceptedLifecycleEvent,
  createTaskDiscardedLifecycleEvent,
  createTaskLifecycleEventLogEntry,
  createTaskTerminalLifecycleEvent,
  isRuntimeEventType,
  isTaskTerminalStatus,
  resolveInterruptDecision,
  resolveTransition,
  toExecPriority,
} from "../index.js";

describe("runtime 执行态模型", () => {
  const reflexThreat = {
    rule_id: ThreatRuleId.HostileCloseArmed,
    level: ThreatLevel.Fight,
    reason: "hostile_close_armed",
    interrupt_required: true,
    detected_at: 1_712_000_000,
    hostile_entities: [],
    bot_state: {
      health: 20,
      is_on_fire: false,
      y_velocity: 0,
      has_weapon_equipped: true,
    },
  } as const;

  it("应能创建与文档一致的执行任务联合", () => {
    const codeJob = createCodeJobForSkill({
      message_id: "msg-1",
      intent_epoch: 7,
      snapshot_ts: 1_712_930_000,
      priority: ExecPriority.Urgent,
      skill: "cutTree",
      params: { count: 5 },
    });
    const sandboxCodeJob = createCodeJob({
      message_id: "msg-2",
      intent_epoch: 8,
      snapshot_ts: 1_712_930_001,
      priority: ExecPriority.Normal,
      code: "await reply('ok')",
    });

    expect(codeJob.type).toBe(ExecutionTaskKind.Code);
    expect(codeJob.priority).toBe(ExecPriority.Urgent);
    expect(sandboxCodeJob.type).toBe(ExecutionTaskKind.Code);
    expect(toExecPriority(ConversationPriority.Background)).toBe(ExecPriority.Background);
  });

  it("应接受合法状态转换并拒绝非法转换", () => {
    const legalTransition = resolveTransition(BotStatus.IDLE, {
      type: "exec_job_pulled",
      epoch_fresh: true,
      snapshot_fresh: true,
    });
    const illegalTransition = resolveTransition(BotStatus.SHUTDOWN, {
      type: "bot_respawned",
    });

    expect(legalTransition.accepted).toBe(true);
    expect(legalTransition.to).toBe(BotStatus.EXECUTING);
    expect(legalTransition.emittedEvents).toContain("state.transition");
    expect(legalTransition.emittedEvents).toContain("task.started");
    expect(illegalTransition.accepted).toBe(false);
    expect(illegalTransition.emittedEvents).toEqual([]);
    expect(canTransition(BotStatus.SHUTDOWN, BotStatus.IDLE)).toBe(false);
  });

  it("应根据中断来源分流到 IDLE 或 REFLEXING，并在初始化 / 反射中排队", () => {
    const reflexDecision = resolveInterruptDecision(BotStatus.EXECUTING, {
      source: {
        type: "reflex",
        threat: reflexThreat,
      },
      reason: "threat_detected",
    });
    const controlDecision = resolveInterruptDecision(BotStatus.EXECUTING, {
      source: {
        type: "control",
        command: "interrupt",
      },
      reason: "owner_stop",
    });
    const reflexTransition = resolveTransition(BotStatus.EXECUTING, {
      type: "interrupt",
      signal: {
        source: {
          type: "reflex",
          threat: reflexThreat,
        },
        reason: "threat_detected",
      },
    });
    const idleControlTransition = resolveTransition(BotStatus.IDLE, {
      type: "interrupt",
      signal: {
        source: {
          type: "control",
          command: "interrupt",
        },
        reason: "owner_stop",
      },
    });
    const initializingInterruptTransition = resolveTransition(BotStatus.INITIALIZING, {
      type: "interrupt",
      signal: {
        source: {
          type: "triage",
          intent_epoch: 9,
        },
        reason: "newer_intent",
      },
    });
    const reflexingInterruptDecision = resolveInterruptDecision(BotStatus.REFLEXING, {
      source: {
        type: "control",
        command: "cancel",
      },
      reason: "owner_cancel",
    });
    const reflexingInterruptTransition = resolveTransition(BotStatus.REFLEXING, {
      type: "interrupt",
      signal: {
        source: {
          type: "control",
          command: "cancel",
        },
        reason: "owner_cancel",
      },
    });

    expect(reflexDecision.accepted).toBe(true);
    expect(reflexDecision.to).toBe(BotStatus.REFLEXING);
    expect(reflexDecision.emittedEvents).toEqual(["task.interrupted", "reflex.triggered"]);
    expect(controlDecision.accepted).toBe(true);
    expect(controlDecision.to).toBe(BotStatus.IDLE);
    expect(controlDecision.emittedEvents).toEqual(["task.interrupted"]);
    expect(reflexTransition.accepted).toBe(true);
    expect(reflexTransition.emittedEvents).toContain("state.transition");
    expect(reflexTransition.emittedEvents).toContain("reflex.triggered");
    expect(idleControlTransition.accepted).toBe(false);
    expect(idleControlTransition.emittedEvents).toEqual([]);
    expect(initializingInterruptTransition.accepted).toBe(false);
    expect(initializingInterruptTransition.emittedEvents).toEqual([]);
    expect(initializingInterruptTransition.interrupt_action).toBe("queue");
    expect(reflexingInterruptDecision.action).toBe("queue");
    expect(reflexingInterruptTransition.accepted).toBe(false);
    expect(reflexingInterruptTransition.interrupt_action).toBe("queue");
  });

  it("应统一表达外部认证状态与运行时骨架初始态", () => {
    const secret = createExternalAuthSecretBinding({
      source: "env",
      reference: "MC_EXTERNAL_AUTH_SECRET",
      secret: "hunter2",
    });
    const pending = createExternalAuthState({
      status: "pending",
      secret,
    });
    const authenticated = createExternalAuthState({
      status: "authenticated",
      secret,
    });
    const failed = createExternalAuthState({
      status: "failed",
      failureReason: "missing_injected_secret",
      secretSource: "env",
      secretReference: "MC_EXTERNAL_AUTH_SECRET",
    });
    const runtimeScaffold = createRuntimeScaffold({
      externalAuth: pending,
      externalAuthSecret: secret,
    });
    const pendingPlan = createExternalAuthExecutionPlan(pending, secret);
    const pendingPublicState = createExternalAuthPublicState(pending);
    const notRequiredReadyGate = createRuntimeReadyGate({
      status: BotStatus.IDLE,
      externalAuth: createExternalAuthState({ status: "not_required" }),
    });
    const pendingReadyGate = createRuntimeReadyGate({
      status: BotStatus.INITIALIZING,
      externalAuth: pending,
    });
    const readyTransition = resolveTransition(BotStatus.INITIALIZING, {
      type: "ready",
      external_auth: authenticated,
    });
    const blockedReadyTransition = resolveTransition(BotStatus.INITIALIZING, {
      type: "ready",
      external_auth: pending,
    });

    expect(EXTERNAL_AUTH_STATUSES).toEqual(["not_required", "pending", "authenticated", "failed"]);
    expect(createExternalAuthState({ status: "not_required" }).entrypoint).toBe("none");
    expect(pending.status).toBe("pending");
    expect(authenticated.status).toBe("authenticated");
    expect(pending).not.toHaveProperty("secret");
    expect(authenticated).not.toHaveProperty("secret");
    expect(pending).toMatchObject({
      secret_source: "env",
      secret_reference: "MC_EXTERNAL_AUTH_SECRET",
    });
    if (failed.status !== "failed") {
      throw new Error("expected failed external auth state");
    }
    expect(failed.failure_reason).toBe("missing_injected_secret");
    expect(runtimeScaffold.defaultStatus).toBe(BotStatus.INITIALIZING);
    expect(runtimeScaffold.externalAuth).toEqual(pending);
    expect(runtimeScaffold.externalAuthPlan).toEqual(pendingPlan);
    expect(runtimeScaffold.readyGate.status).toBe("blocked");
    expect(runtimeScaffold.readyGate.blocked_by).toContain("runtime_initializing");
    expect(runtimeScaffold.readyGate.blocked_by).toContain("external_auth_pending");
    expect(pendingPlan.status).toBe("pending");
    expect(pendingPlan.next_action.command).toBe("/login hunter2");
    expect(pendingPlan.action_summary?.command_preview).toBe("/login <redacted>");
    expect(pendingPlan.action_summary).not.toHaveProperty("command");
    expect(pendingPublicState.action_summary?.command_preview).toBe("/login <redacted>");
    expect(pendingPublicState as Record<string, unknown>).not.toHaveProperty("secret");
    expect(notRequiredReadyGate.ready).toBe(true);
    expect(notRequiredReadyGate.blocked_by).toEqual([]);
    expect(pendingReadyGate.ready).toBe(false);
    expect(pendingReadyGate.can_emit_bot_ready).toBe(false);
    expect(pendingReadyGate.blocked_by).toEqual(["runtime_initializing", "external_auth_pending"]);
    expect(readyTransition.accepted).toBe(true);
    expect(readyTransition.to).toBe(BotStatus.IDLE);
    expect(readyTransition.emittedEvents).toContain("bot.ready");
    expect(blockedReadyTransition.accepted).toBe(false);
    expect(blockedReadyTransition.emittedEvents).toEqual([]);
  });

  it("应集中维护 event_log 事件名与任务状态枚举", () => {
    expect(isRuntimeEventType("task.interrupted")).toBe(true);
    expect(isRuntimeEventType("task.unknown")).toBe(false);
    expect(RUNTIME_EVENT_TYPES).toContain("state.transition");
    expect(TaskHistoryStatus.Discarded).toBe("discarded");
    expect(TASK_HISTORY_STATUSES).toContain(TaskHistoryStatus.Accepted);
    expect(TASK_TERMINAL_STATUSES).toEqual([
      TaskHistoryStatus.Completed,
      TaskHistoryStatus.Failed,
      TaskHistoryStatus.Interrupted,
    ]);
    expect(TASK_LIFECYCLE_EVENT_TYPE_BY_STATUS.accepted).toBe("task.accepted");
    expect(isTaskTerminalStatus(TaskHistoryStatus.Discarded)).toBe(false);
    expect(isTaskTerminalStatus(TaskHistoryStatus.Completed)).toBe(true);
  });

  it("应创建统一的 accepted / discarded / terminal 生命周期事件", () => {
    const job = createCodeJob({
      message_id: "msg-life-1",
      intent_epoch: 12,
      snapshot_ts: 1_712_930_123,
      priority: ExecPriority.Normal,
      code: "await reply('ok')",
    });
    const accepted = createTaskAcceptedLifecycleEvent(job);
    const discarded = createTaskDiscardedLifecycleEvent({
      job,
      discard_reason: "intent_epoch_stale",
      current_epoch: 13,
    });
    const terminal = createTaskTerminalLifecycleEvent({
      job,
      status: TaskHistoryStatus.Interrupted,
      total_steps: 2,
      duration_ms: 4800,
      interrupt_source: {
        type: "control",
        command: "interrupt",
      },
      reason: "owner_stop",
    });
    const acceptedLog = createTaskLifecycleEventLogEntry({
      eventId: "evt-001",
      lifecycle: accepted,
      source: MessageSource.Web,
      timestamp: "2026-04-14T00:00:00.000Z",
      botId: "bot-008",
    });

    expect(accepted.event_type).toBe("task.accepted");
    expect(accepted.payload.priority).toBe(ExecPriority.Normal);
    expect(discarded.payload.current_epoch).toBe(13);
    expect(terminal.event_type).toBe("task.interrupted");
    if (terminal.status !== TaskHistoryStatus.Interrupted) {
      throw new Error("expected interrupted terminal lifecycle");
    }
    expect((terminal.payload as { reason: string }).reason).toBe("owner_stop");
    expect(acceptedLog.type).toBe("task.accepted");
    expect(acceptedLog.taskId).toBe("msg-life-1");
  });
});
