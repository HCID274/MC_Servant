import { describe, expect, it } from "vitest";

import {
  BotStatus,
  ConversationPriority,
  ExecPriority,
  ExecutionTaskKind,
  RUNTIME_EVENT_TYPES,
  TaskHistoryStatus,
  ThreatLevel,
  ThreatRuleId,
  canTransition,
  createSandboxCodeJob,
  createSkillCallJob,
  isRuntimeEventType,
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
    const skillCallJob = createSkillCallJob({
      message_id: "msg-1",
      intent_epoch: 7,
      snapshot_ts: 1_712_930_000,
      priority: ExecPriority.Urgent,
      skill: "cutTree",
      params: { count: 5 },
    });
    const sandboxCodeJob = createSandboxCodeJob({
      message_id: "msg-2",
      intent_epoch: 8,
      snapshot_ts: 1_712_930_001,
      priority: ExecPriority.Normal,
      code: "await api.chat.say('ok')",
    });

    expect(skillCallJob.type).toBe(ExecutionTaskKind.SkillCall);
    expect(skillCallJob.priority).toBe(ExecPriority.Urgent);
    expect(sandboxCodeJob.type).toBe(ExecutionTaskKind.SandboxCode);
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

  it("应根据中断来源分流到 IDLE 或 REFLEXING", () => {
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
  });

  it("应集中维护 event_log 事件名与任务状态枚举", () => {
    expect(isRuntimeEventType("task.interrupted")).toBe(true);
    expect(isRuntimeEventType("task.unknown")).toBe(false);
    expect(RUNTIME_EVENT_TYPES).toContain("state.transition");
    expect(TaskHistoryStatus.Discarded).toBe("discarded");
  });
});
