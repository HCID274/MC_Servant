/**
 * 运行时状态机逻辑。
 * 
 * 架构职责：
 * 1. 状态转移校验：实现 `canTransition` 逻辑，确保 BotActor 严格遵循预设的状态迁移图（Initializing -> Idle -> Executing 等）。
 * 2. 中断判定策略：通过 `resolveInterruptDecision` 实现复杂的中断决策逻辑，区分抢占式中断（如 Reflex）与排队式中断。
 * 3. 统一转换决策：提供 `resolveTransition` 作为状态机的“大脑”，根据外部诱因（Ready, Job Pulled, Failed, Died 等）产出结构化的转换决策。
 * 4. 事件副作用定义：规定每次状态转换应当触发的副作用事件清单（如 state.transition, task.started, bot.ready）。
 */

import {
  BotStatus,
  type ExternalAuthState,
  type InterruptSignal,
  createRuntimeReadyGate,
} from "./contracts.js";
import type { RuntimeEventType } from "./events.js";

/** 状态转换原因结构，用于表达文档中的关键触发条件。 */
export type RuntimeTransitionReason =
  | {
      /** 初始化完成。 */
      type: "ready";
      /** 当前外部认证状态。 */
      external_auth: ExternalAuthState;
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

/**
 * 判断给定转换是否属于合法的状态迁移路径。
 * 
 * 架构意图：
 * 它是状态机的“守门员”，严格执行文档中定义的有向图。
 * 例如：一旦进入 SHUTDOWN 状态，就不允许再迁往任何其他状态；
 * 只有 IDLE 或 EXECUTING 才能迁往 REFLEXING 等。
 * 
 * @param from 起始状态
 * @param to 目标状态
 * @returns 是否允许转换
 */
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

/**
 * 解析中断信号对当前状态的具体影响。
 * 
 * 架构意图：
 * 实现中断优先级逻辑：
 * 1. reflex 类型中断：具有最高优先级，即使在执行中也会强制进入 REFLEXING 状态。
 * 2. 状态约束：在 INITIALIZING 或 REFLEXING 状态下收到的中断会被标记为 "queue"（待处理），
 *    而在 DEAD 或 SHUTDOWN 状态下则会被忽略。
 * 3. 任务抢占：在 EXECUTING 状态下收到控制类中断会触发 "transition" 回 IDLE 状态。
 * 
 * @param currentStatus 当前 Bot 状态
 * @param signal 收到的中断信号
 * @returns 中断决策对象
 */
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

/**
 * 根据外部原因解析状态转换的最终结果。
 * 
 * 架构意图：
 * 它是状态机的核心分发器（Dispatcher），将各种异步事件（任务完成、死亡、中断、就绪等）
 * 映射为具体的 TransitionDecision。它负责处理复杂的逻辑，例如：
 * - 在任务拉取时校验纪元和快照的新鲜度。
 * - 在就绪事件中校验外部认证门控。
 * - 结合中断决策逻辑处理中断信号。
 * 
 * @param currentStatus 当前 Bot 状态
 * @param reason 触发转换的原因载荷
 * @returns 最终的转换决策
 */
export function resolveTransition(
  currentStatus: BotStatus,
  reason: RuntimeTransitionReason,
): RuntimeTransitionDecision {
  switch (reason.type) {
    case "ready":
      return createTransitionDecision(
        currentStatus,
        BotStatus.IDLE,
        reason.type,
        ["bot.ready"],
        canTransition(currentStatus, BotStatus.IDLE) &&
          createRuntimeReadyGate({
            status: BotStatus.IDLE,
            externalAuth: reason.external_auth,
          }).ready,
      );
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

/**
 * 创建统一格式的状态转换决策。
 * 
 * 架构意图：
 * 作为一个工厂函数，它负责填充决策对象中的公共字段，
 * 特别是自动补全副作用事件列表。如果转换被接受且涉及状态变更，
 * 它会自动将 `state.transition` 加入待触发事件清单，确保系统的可观测性。
 * 
 * @param from 起始状态
 * @param to 目标状态
 * @param reason 触发原因类型
 * @param emittedEvents 关联的业务事件
 * @param accepted 是否允许转换（默认为 canTransition 结果）
 * @param interruptAction 可选的中断处置动作
 * @returns 标准化的转换决策
 */
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
