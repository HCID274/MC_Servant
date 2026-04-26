/**
 * 运行时端口契约。
 *
 * 只放跨模块共享的 BotActor（机器人执行代理） 状态、中断与运行时任务包类型；
 * 运行时实现细节继续留在 runtime（运行时） 模块。
 */

import type { ExecutionTaskEnvelope } from "./foundation.js";
import type { ReflexInterruptSource } from "./observation.js";

/** Bot（机器人） 状态枚举，用于描述 BotActor（机器人执行代理） 在运行时内的最小状态集合。 */
export enum BotStatus {
  INITIALIZING = "initializing",
  IDLE = "idle",
  EXECUTING = "executing",
  REFLEXING = "reflexing",
  DEAD = "dead",
  SHUTDOWN = "shutdown",
}

/** 中断来源判别联合，用于区分 control、reflex、triage 与 system 四类来源。 */
export type InterruptSource =
  | {
      /** 控制类中断。 */
      type: "control";
      /** 控制命令。 */
      command: "interrupt" | "cancel";
    }
  | ReflexInterruptSource
  | {
      /** 分诊类中断。 */
      type: "triage";
      /** 意图纪元。 */
      intent_epoch: number;
    }
  | {
      /** 系统类中断。 */
      type: "system";
      /** 系统原因。 */
      cause: "death" | "shutdown" | "stalled";
    };

/** 中断信号结构，用于统一描述运行时收到的中断请求。 */
export interface InterruptSignal {
  /** 中断请求来源。 */
  source: InterruptSource;
  /** 中断原因。 */
  reason: string;
  /** 中断扩展载荷。 */
  payload?: Readonly<Record<string, unknown>>;
}

/** 运行时任务包结构，用于在 BotActor（机器人执行代理） 边界内补齐执行态字段。 */
export interface RuntimeTaskEnvelope extends ExecutionTaskEnvelope {
  /** 任务进入运行时前看到的 Bot（机器人） 状态。 */
  status: BotStatus;
  /** 任务是否允许被中断。 */
  interruptible: boolean;
}
