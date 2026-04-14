import { BotStatus, type InterruptSignal } from "./contracts.js";
import type { RuntimeEventType } from "./events.js";

/** 状态转换原因结构，用于表达文档中的关键触发条件。 */
export type RuntimeTransitionReason =
  | {
      /** 初始化完成。 */
      type: "ready";
    }
  | {
      /** 初始化重试。 */
      type: "initializing_retry";
    }
  | {
      /** 初始化重试耗尽。 */
      type: "initializing_retry_exhausted";
    }
  | {
      /** exec 任务被取出。 */
      type: "exec_job_pulled";
      /** 任务纪元是否仍然有效。 */
      epoch_fresh: boolean;
      /** 快照是否仍然可用。 */
      snapshot_fresh: boolean;
    }
  | {
      /** 执行完成。 */
      type: "task_completed";
    }
  | {
      /** 执行失败。 */
      type: "task_failed";
    }
  | {
      /** 收到中断信号。 */
      type: "interrupt";
      /** 中断信号内容。 */
      signal: InterruptSignal;
    }
  | {
      /** 反射完成。 */
      type: "reflex_done";
    }
  | {
      /** Bot 死亡。 */
      type: "bot_died";
    }
  | {
      /** Bot 重生。 */
      type: "bot_respawned";
    }
  | {
      /** 进程进入关闭流程。 */
      type: "shutdown_requested";
    };

/** 中断处理决策结构。 */
export interface InterruptDecision {
  /** 当前状态。 */
  from: BotStatus;
  /** 是否接受该中断。 */
  accepted: boolean;
  /** 目标状态。 */
  to: BotStatus;
  /** 处理动作。 */
  action: "transition" | "queue" | "ignore";
  /** 触发的事件清单。 */
  emittedEvents: readonly RuntimeEventType[];
}

/** 状态转换决策结构。 */
export interface RuntimeTransitionDecision {
  /** 当前状态。 */
  from: BotStatus;
  /** 是否接受该转换。 */
  accepted: boolean;
  /** 目标状态。 */
  to: BotStatus;
  /** 转换原因。 */
  reason: RuntimeTransitionReason["type"];
  /** 中断类转换的处置动作。 */
  interrupt_action?: InterruptDecision["action"];
  /** 触发的事件清单。 */
  emittedEvents: readonly RuntimeEventType[];
}

/** 运行时状态集合。 */
export const BOT_STATUS_SET = [
  BotStatus.INITIALIZING,
  BotStatus.IDLE,
  BotStatus.EXECUTING,
  BotStatus.REFLEXING,
  BotStatus.DEAD,
  BotStatus.SHUTDOWN,
] as const;

/** 判断状态值是否属于合法 Bot 状态集合。 */
export function isBotStatus(value: string): value is BotStatus {
  return BOT_STATUS_SET.includes(value as BotStatus);
}

/** 判断给定转换是否属于文档允许的状态集合。 */
export function canTransition(from: BotStatus, to: BotStatus): boolean {
  if (from === to) {
    return from === BotStatus.INITIALIZING || from === BotStatus.IDLE;
  }

  switch (from) {
    case BotStatus.INITIALIZING:
      return to === BotStatus.IDLE || to === BotStatus.SHUTDOWN || to === BotStatus.DEAD;
    case BotStatus.IDLE:
      return (
        to === BotStatus.EXECUTING ||
        to === BotStatus.REFLEXING ||
        to === BotStatus.DEAD ||
        to === BotStatus.SHUTDOWN
      );
    case BotStatus.EXECUTING:
      return (
        to === BotStatus.IDLE ||
        to === BotStatus.REFLEXING ||
        to === BotStatus.DEAD ||
        to === BotStatus.SHUTDOWN
      );
    case BotStatus.REFLEXING:
      return to === BotStatus.IDLE || to === BotStatus.DEAD || to === BotStatus.SHUTDOWN;
    case BotStatus.DEAD:
      return to === BotStatus.IDLE || to === BotStatus.SHUTDOWN;
    case BotStatus.SHUTDOWN:
      return false;
  }
}

/** 解析中断信号对当前状态的影响。 */
export function resolveInterruptDecision(
  currentStatus: BotStatus,
  signal: InterruptSignal,
): InterruptDecision {
  if (currentStatus === BotStatus.SHUTDOWN || currentStatus === BotStatus.DEAD) {
    return {
      from: currentStatus,
      accepted: false,
      to: currentStatus,
      action: "ignore",
      emittedEvents: [],
    };
  }

  if (currentStatus === BotStatus.INITIALIZING) {
    return {
      from: currentStatus,
      accepted: false,
      to: currentStatus,
      action: "queue",
      emittedEvents: [],
    };
  }

  if (currentStatus === BotStatus.REFLEXING) {
    return {
      from: currentStatus,
      accepted: false,
      to: currentStatus,
      action: "queue",
      emittedEvents: [],
    };
  }

  if (signal.source.type === "reflex") {
    return {
      from: currentStatus,
      accepted: true,
      to: BotStatus.REFLEXING,
      action: "transition",
      emittedEvents:
        currentStatus === BotStatus.EXECUTING
          ? ["task.interrupted", "reflex.triggered"]
          : ["reflex.triggered"],
    };
  }

  return {
    from: currentStatus,
    accepted: currentStatus === BotStatus.EXECUTING,
    to: currentStatus === BotStatus.EXECUTING ? BotStatus.IDLE : currentStatus,
    action: currentStatus === BotStatus.EXECUTING ? "transition" : "ignore",
    emittedEvents: currentStatus === BotStatus.EXECUTING ? ["task.interrupted"] : [],
  };
}

/** 根据原因解析状态转换结果。 */
export function resolveTransition(
  currentStatus: BotStatus,
  reason: RuntimeTransitionReason,
): RuntimeTransitionDecision {
  switch (reason.type) {
    case "ready":
      return createTransitionDecision(currentStatus, BotStatus.IDLE, reason.type, ["bot.ready"]);
    case "initializing_retry":
      return createTransitionDecision(currentStatus, BotStatus.INITIALIZING, reason.type, []);
    case "initializing_retry_exhausted":
      return createTransitionDecision(currentStatus, BotStatus.SHUTDOWN, reason.type, [
        "bot.offline",
      ]);
    case "exec_job_pulled":
      if (!reason.epoch_fresh || !reason.snapshot_fresh) {
        return createTransitionDecision(currentStatus, BotStatus.IDLE, reason.type, [
          "task.discarded",
        ]);
      }

      return createTransitionDecision(currentStatus, BotStatus.EXECUTING, reason.type, [
        "task.started",
      ]);
    case "task_completed":
      return createTransitionDecision(currentStatus, BotStatus.IDLE, reason.type, [
        "task.completed",
      ]);
    case "task_failed":
      return createTransitionDecision(currentStatus, BotStatus.IDLE, reason.type, ["task.failed"]);
    case "interrupt": {
      const decision = resolveInterruptDecision(currentStatus, reason.signal);

      return createTransitionDecision(
        currentStatus,
        decision.to,
        reason.type,
        decision.emittedEvents,
        decision.accepted && canTransition(currentStatus, decision.to),
        decision.action,
      );
    }
    case "reflex_done":
      return createTransitionDecision(currentStatus, BotStatus.IDLE, reason.type, ["reflex.done"]);
    case "bot_died":
      return createTransitionDecision(currentStatus, BotStatus.DEAD, reason.type, ["bot.died"]);
    case "bot_respawned":
      return createTransitionDecision(currentStatus, BotStatus.IDLE, reason.type, [
        "bot.respawned",
      ]);
    case "shutdown_requested":
      return createTransitionDecision(currentStatus, BotStatus.SHUTDOWN, reason.type, [
        "bot.offline",
      ]);
  }
}

/** 创建统一格式的状态转换决策。 */
export function createTransitionDecision(
  from: BotStatus,
  to: BotStatus,
  reason: RuntimeTransitionReason["type"],
  emittedEvents: readonly RuntimeEventType[],
  accepted = canTransition(from, to),
  interruptAction?: InterruptDecision["action"],
): RuntimeTransitionDecision {
  const emittedEventsForDecision: readonly RuntimeEventType[] = accepted
    ? from === to
      ? emittedEvents
      : emittedEvents.includes("state.transition")
        ? emittedEvents
        : ["state.transition", ...emittedEvents]
    : [];

  return {
    from,
    accepted,
    to,
    reason,
    ...(interruptAction === undefined ? {} : { interrupt_action: interruptAction }),
    emittedEvents: emittedEventsForDecision,
  };
}
