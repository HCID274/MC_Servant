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
 * 校验状态转换是否符合预设的有向迁移图。
 *
 * 1. 守门员逻辑：严格限制状态流转路径（如 SHUTDOWN 无法迁出），确保 BotActor 行为符合文档契约。
 * 2. 幂等处理：允许 INITIALIZING 和 IDLE 状态在特定条件下的原地转换。
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
 * 解析中断信号对当前状态的具体影响与处置动作。
 *
 * 1. 优先级判定：Reflex 具有最高优先级，可强制将 IDLE 或 EXECUTING 切换至 REFLEXING 状态。
 * 2. 状态约束：初始化或反射期间收到的中断标记为 queue（排队），终态（DEAD/SHUTDOWN）下则直接 ignore（忽略）。
 * 3. 任务抢占：执行态收到有效控制中断将触发 transition 动作切换回 IDLE。
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
 * 根据外部诱因解析状态转换的最终结果，是状态机的核心分发器。
 *
 * 1. 逻辑收口：将任务完成、死亡、中断、就绪等异步事件统一映射为具体的转换决策。
 * 2. 复杂校验：集成纪元新鲜度（Epoch Freshness）校验、外部认证门控判定以及中断决策。
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
 * 1. 自动补全：负责填充决策对象的公共字段，并根据转换结果自动补全 state.transition 副作用事件。
 * 2. 观测保障：确保每一次有效的状态变更都能在事件清单中被准确记录，支撑系统可观测性。
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
