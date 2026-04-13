import { ExecutionTaskKind, type TaskEnvelope } from "../domain/contracts.js";

/** Bot 状态枚举，用于描述 BotActor 在运行时内的最小状态集合。 */
export enum BotStatus {
  INITIALIZING = "initializing",
  IDLE = "idle",
  EXECUTING = "executing",
  REFLEXING = "reflexing",
  DEAD = "dead",
  SHUTDOWN = "shutdown",
}

/** 威胁评估占位结构，用于为 reflex 中断保留文档要求的 threat 概念。 */
export type ThreatAssessment = Readonly<Record<string, unknown>>;

/** 中断来源判别联合，用于区分 control、reflex、triage 与 system 四类来源。 */
export type InterruptSource =
  | {
      /** 控制类中断。 */
      type: "control";
      /** 控制命令。 */
      command: "interrupt" | "cancel";
    }
  | {
      /** 反射类中断。 */
      type: "reflex";
      /** 威胁评估结果。 */
      threat: ThreatAssessment;
    }
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

/** 运行时任务包结构，用于在 BotActor 边界内补齐执行态字段。 */
export interface RuntimeTaskEnvelope extends TaskEnvelope<ExecutionTaskKind> {
  /** 任务进入运行时前看到的 Bot 状态。 */
  status: BotStatus;
  /** 任务是否允许被中断。 */
  interruptible: boolean;
}

/** 运行时骨架结构，用于表达当前阶段对 BotActor 的最小边界认知。 */
export interface RuntimeScaffold {
  /** 默认启动状态。 */
  defaultStatus: BotStatus;
  /** 当前阶段声明支持的任务类型。 */
  supportedTaskKinds: readonly ExecutionTaskKind[];
  /** 当前阶段提供的中断信号模板。 */
  interruptTemplate: InterruptSignal;
}

/** 创建运行时骨架占位对象。 */
export function createRuntimeScaffold(): RuntimeScaffold {
  return {
    defaultStatus: BotStatus.IDLE,
    supportedTaskKinds: [ExecutionTaskKind.SkillCall, ExecutionTaskKind.SandboxCode],
    interruptTemplate: {
      source: {
        type: "system",
        cause: "shutdown",
      },
      reason: "placeholder",
    },
  };
}
