import { type ExecutionTaskEnvelope, ExecutionTaskKind } from "../domain/contracts.js";
import type { ReflexInterruptSource, ThreatAssessment } from "../observation/contracts.js";

export type { ThreatAssessment } from "../observation/contracts.js";

/** Bot 状态枚举，用于描述 BotActor 在运行时内的最小状态集合。 */
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

/** 运行时任务包结构，用于在 BotActor 边界内补齐执行态字段。 */
export interface RuntimeTaskEnvelope extends ExecutionTaskEnvelope {
  /** 任务进入运行时前看到的 Bot 状态。 */
  status: BotStatus;
  /** 任务是否允许被中断。 */
  interruptible: boolean;
}

/** 外部认证受控入口清单。 */
export const EXTERNAL_AUTH_ENTRYPOINTS = ["none", "game_chat_command"] as const;

/** 外部认证受控入口联合类型。 */
export type ExternalAuthEntrypoint = (typeof EXTERNAL_AUTH_ENTRYPOINTS)[number];

/** 外部认证明文密钥来源清单。 */
export const EXTERNAL_AUTH_SECRET_SOURCES = ["env", "bot_config"] as const;

/** 外部认证明文密钥来源联合类型。 */
export type ExternalAuthSecretSource = (typeof EXTERNAL_AUTH_SECRET_SOURCES)[number];

/** 外部认证状态清单。 */
export const EXTERNAL_AUTH_STATUSES = [
  "not_required",
  "pending",
  "authenticated",
  "failed",
] as const;

/** 外部认证状态联合类型。 */
export type ExternalAuthStatus = (typeof EXTERNAL_AUTH_STATUSES)[number];

/** 外部认证失败原因清单。 */
export const EXTERNAL_AUTH_FAILURE_REASONS = ["missing_injected_secret"] as const;

/** 外部认证失败原因联合类型。 */
export type ExternalAuthFailureReason = (typeof EXTERNAL_AUTH_FAILURE_REASONS)[number];

/** 外部认证明文密钥注入描述。 */
export interface ExternalAuthSecretBinding {
  /** 明文密钥来源。 */
  readonly source: ExternalAuthSecretSource;
  /** 密钥引用位置，例如环境变量名或配置路径。 */
  readonly reference: string;
  /** 已注入的明文密钥。 */
  readonly secret: string;
}

/** 无需外部认证时的运行时状态。 */
export interface ExternalAuthNotRequiredState {
  /** 认证状态。 */
  readonly status: "not_required";
  /** 是否需要认证。 */
  readonly required: false;
  /** 受控入口。 */
  readonly entrypoint: "none";
}

/** 外部认证进行中时的运行时状态。 */
export interface ExternalAuthPendingState {
  /** 认证状态。 */
  readonly status: "pending";
  /** 是否需要认证。 */
  readonly required: true;
  /** 受控入口。 */
  readonly entrypoint: "game_chat_command";
  /** 部署注入的密钥。 */
  readonly secret: ExternalAuthSecretBinding;
}

/** 外部认证完成时的运行时状态。 */
export interface ExternalAuthAuthenticatedState {
  /** 认证状态。 */
  readonly status: "authenticated";
  /** 是否需要认证。 */
  readonly required: true;
  /** 受控入口。 */
  readonly entrypoint: "game_chat_command";
  /** 部署注入的密钥。 */
  readonly secret: ExternalAuthSecretBinding;
}

/** 外部认证失败时的运行时状态。 */
export interface ExternalAuthFailedState {
  /** 认证状态。 */
  readonly status: "failed";
  /** 是否需要认证。 */
  readonly required: true;
  /** 受控入口。 */
  readonly entrypoint: "game_chat_command";
  /** 失败原因。 */
  readonly failure_reason: ExternalAuthFailureReason;
  /** 期望的密钥来源。 */
  readonly secret_source: ExternalAuthSecretSource | null;
  /** 期望的密钥引用。 */
  readonly secret_reference: string | null;
}

/** 外部认证运行时状态联合。 */
export type ExternalAuthState =
  | ExternalAuthNotRequiredState
  | ExternalAuthPendingState
  | ExternalAuthAuthenticatedState
  | ExternalAuthFailedState;

/** 运行时骨架结构，用于表达当前阶段对 BotActor 的最小边界认知。 */
export interface RuntimeScaffold {
  /** 默认启动状态。 */
  defaultStatus: BotStatus;
  /** 外部认证状态。 */
  externalAuth: ExternalAuthState;
  /** 当前阶段声明支持的执行任务类型。 */
  supportedTaskKinds: readonly string[];
  /** 当前阶段提供的中断信号模板。 */
  interruptTemplate: InterruptSignal;
}

/** 创建外部认证明文密钥注入描述。 */
export function createExternalAuthSecretBinding(input: {
  source: ExternalAuthSecretSource;
  reference: string;
  secret: string;
}): ExternalAuthSecretBinding {
  assertNonEmptyString(input.reference, "reference");
  assertNonEmptyString(input.secret, "secret");

  return Object.freeze({
    source: input.source,
    reference: input.reference,
    secret: input.secret,
  });
}

/** 创建统一的外部认证运行时状态。 */
export function createExternalAuthState(
  input:
    | {
        status: "not_required";
      }
    | {
        status: "pending" | "authenticated";
        secret: ExternalAuthSecretBinding;
      }
    | {
        status: "failed";
        failureReason: ExternalAuthFailureReason;
        secretSource?: ExternalAuthSecretSource | null;
        secretReference?: string | null;
      },
): ExternalAuthState {
  switch (input.status) {
    case "not_required":
      return Object.freeze({
        status: input.status,
        required: false,
        entrypoint: "none",
      });
    case "pending":
    case "authenticated":
      return Object.freeze({
        status: input.status,
        required: true,
        entrypoint: "game_chat_command",
        secret: input.secret,
      });
    case "failed":
      return Object.freeze({
        status: input.status,
        required: true,
        entrypoint: "game_chat_command",
        failure_reason: input.failureReason,
        secret_source: input.secretSource ?? null,
        secret_reference: input.secretReference ?? null,
      });
  }
}

/** 创建运行时骨架占位对象。 */
export function createRuntimeScaffold(
  input: {
    externalAuth?: ExternalAuthState;
  } = {},
): RuntimeScaffold {
  return {
    defaultStatus: BotStatus.INITIALIZING,
    externalAuth: input.externalAuth ?? createExternalAuthState({ status: "not_required" }),
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

function assertNonEmptyString(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}
