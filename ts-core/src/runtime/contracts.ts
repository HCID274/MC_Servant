/**
 * 运行时核心契约与外部认证逻辑。
 *
 * 1. 状态定义：定义 BotActor 的核心执行状态（BotStatus）和中断机制（InterruptSignal）。
 * 2. 外部认证流水线：管理与 Minecraft 服务器连接所需的登录认证状态（Pending, Authenticated, Failed）及执行计划。
 * 3. 就绪门控（Ready Gate）：实现复杂的就绪判定逻辑，综合 Bot 状态与认证状态决定系统是否可对外提供服务。
 * 4. 骨架装配：提供 RuntimeScaffold 用于初始化运行时的基本参数、支持的任务类型及中断模板。
 */

import { type ExecutionTaskEnvelope, ExecutionTaskKind } from "../domain/contracts.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../domain/invariants.js";
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

/** 外部认证动作执行目标清单。 */
export const EXTERNAL_AUTH_ACTION_TARGETS = ["minecraft_chat"] as const;

/** 外部认证动作执行目标联合类型。 */
export type ExternalAuthActionTarget = (typeof EXTERNAL_AUTH_ACTION_TARGETS)[number];

/** 外部认证待执行动作类型清单。 */
export const EXTERNAL_AUTH_ACTION_KINDS = ["login_command"] as const;

/** 外部认证待执行动作类型联合类型。 */
export type ExternalAuthActionKind = (typeof EXTERNAL_AUTH_ACTION_KINDS)[number];

/** 外部认证就绪阻断原因清单。 */
export const RUNTIME_READY_BLOCK_REASONS = [
  "runtime_initializing",
  "runtime_busy",
  "bot_dead",
  "runtime_shutdown",
  "external_auth_pending",
  "external_auth_failed",
] as const;

/** 外部认证就绪阻断原因联合类型。 */
export type RuntimeReadyBlockReason = (typeof RUNTIME_READY_BLOCK_REASONS)[number];

/** 外部认证明文密钥注入描述。 */
export interface ExternalAuthSecretBinding {
  /** 明文密钥来源。 */
  readonly source: ExternalAuthSecretSource;
  /** 密钥引用位置，例如环境变量名或配置路径。 */
  readonly reference: string;
  /** 已注入的明文密钥。 */
  readonly secret: string;
}

/** 外部认证登录命令动作，用于承载最小明文执行载荷。 */
export interface ExternalAuthCommandAction {
  /** 动作类型。 */
  readonly kind: "login_command";
  /** 受控入口。 */
  readonly entrypoint: "game_chat_command";
  /** 执行目标。 */
  readonly target: ExternalAuthActionTarget;
  /** 发送到游戏聊天的登录命令。 */
  readonly command: string;
  /** 是否允许原命令重试。 */
  readonly retry_allowed: true;
}

/** 对外可见的外部认证动作脱敏摘要。 */
export interface ExternalAuthActionSummary {
  /** 动作类型。 */
  readonly kind: "login_command";
  /** 受控入口。 */
  readonly entrypoint: "game_chat_command";
  /** 执行目标。 */
  readonly target: ExternalAuthActionTarget;
  /** 脱敏后的命令预览。 */
  readonly command_preview: string;
  /** 是否允许原命令重试。 */
  readonly retry_allowed: true;
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
  /** 明文密钥来源。 */
  readonly secret_source: ExternalAuthSecretSource;
  /** 密钥引用位置，例如环境变量名或配置路径。 */
  readonly secret_reference: string;
}

/** 外部认证完成时的运行时状态。 */
export interface ExternalAuthAuthenticatedState {
  /** 认证状态。 */
  readonly status: "authenticated";
  /** 是否需要认证。 */
  readonly required: true;
  /** 受控入口。 */
  readonly entrypoint: "game_chat_command";
  /** 明文密钥来源。 */
  readonly secret_source: ExternalAuthSecretSource;
  /** 密钥引用位置，例如环境变量名或配置路径。 */
  readonly secret_reference: string;
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

/** 外部认证待执行计划。 */
export type ExternalAuthExecutionPlan =
  | {
      /** 对应的认证状态。 */
      readonly status: "not_required";
      /** 当前无需执行登录动作。 */
      readonly next_action: null;
      /** 对外脱敏摘要。 */
      readonly action_summary: null;
      /** 是否允许重试。 */
      readonly retry_allowed: false;
      /** 是否已满足认证前置。 */
      readonly ready_for_idle: true;
    }
  | {
      /** 对应的认证状态。 */
      readonly status: "pending";
      /** 待执行登录动作。 */
      readonly next_action: ExternalAuthCommandAction;
      /** 对外脱敏摘要。 */
      readonly action_summary: ExternalAuthActionSummary;
      /** 是否允许重试。 */
      readonly retry_allowed: true;
      /** 是否已满足认证前置。 */
      readonly ready_for_idle: false;
    }
  | {
      /** 对应的认证状态。 */
      readonly status: "authenticated";
      /** 当前无需执行登录动作。 */
      readonly next_action: null;
      /** 对外脱敏摘要。 */
      readonly action_summary: null;
      /** 是否允许重试。 */
      readonly retry_allowed: false;
      /** 是否已满足认证前置。 */
      readonly ready_for_idle: true;
    }
  | {
      /** 对应的认证状态。 */
      readonly status: "failed";
      /** 当前无需执行登录动作。 */
      readonly next_action: null;
      /** 对外脱敏摘要。 */
      readonly action_summary: null;
      /** 是否允许重试。 */
      readonly retry_allowed: false;
      /** 是否已满足认证前置。 */
      readonly ready_for_idle: false;
      /** 失败原因。 */
      readonly failure_reason: ExternalAuthFailureReason;
      /** 期望的密钥来源。 */
      readonly secret_source: ExternalAuthSecretSource | null;
      /** 期望的密钥引用。 */
      readonly secret_reference: string | null;
    };

/** 对外暴露的外部认证脱敏状态。 */
export type ExternalAuthPublicState =
  | {
      /** 认证状态。 */
      readonly status: "not_required";
      /** 是否需要认证。 */
      readonly required: false;
      /** 受控入口。 */
      readonly entrypoint: "none";
      /** 脱敏动作摘要。 */
      readonly action_summary: null;
    }
  | {
      /** 认证状态。 */
      readonly status: "pending";
      /** 是否需要认证。 */
      readonly required: true;
      /** 受控入口。 */
      readonly entrypoint: "game_chat_command";
      /** 脱敏动作摘要。 */
      readonly action_summary: ExternalAuthActionSummary;
    }
  | {
      /** 认证状态。 */
      readonly status: "authenticated";
      /** 是否需要认证。 */
      readonly required: true;
      /** 受控入口。 */
      readonly entrypoint: "game_chat_command";
      /** 脱敏动作摘要。 */
      readonly action_summary: null;
    }
  | {
      /** 认证状态。 */
      readonly status: "failed";
      /** 是否需要认证。 */
      readonly required: true;
      /** 受控入口。 */
      readonly entrypoint: "game_chat_command";
      /** 脱敏动作摘要。 */
      readonly action_summary: null;
      /** 失败原因。 */
      readonly failure_reason: ExternalAuthFailureReason;
      /** 期望的密钥来源。 */
      readonly secret_source: ExternalAuthSecretSource | null;
      /** 期望的密钥引用。 */
      readonly secret_reference: string | null;
    };

/** 运行时就绪门控结果。 */
export interface RuntimeReadyGate {
  /** 当前是否已满足 ready（就绪） 条件。 */
  readonly ready: boolean;
  /** 门控状态。 */
  readonly status: "ready" | "blocked";
  /** 当前运行时状态。 */
  readonly runtime_status: BotStatus;
  /** 当前外部认证状态。 */
  readonly external_auth_status: ExternalAuthStatus;
  /** 是否允许发出 bot.ready。 */
  readonly can_emit_bot_ready: boolean;
  /** 是否允许开放实时推送。 */
  readonly can_open_realtime: boolean;
  /** 是否允许开放 HTTP（超文本传输协议） 入口。 */
  readonly can_open_http: boolean;
  /** 阻断原因清单。 */
  readonly blocked_by: readonly RuntimeReadyBlockReason[];
}

/** 运行时骨架结构，用于表达当前阶段对 BotActor 的最小边界认知。 */
export interface RuntimeScaffold {
  /** 默认启动状态。 */
  defaultStatus: BotStatus;
  /** 外部认证状态。 */
  externalAuth: ExternalAuthState;
  /** 外部认证执行计划。 */
  externalAuthPlan: ExternalAuthExecutionPlan;
  /** 初始就绪门控结果。 */
  readyGate: RuntimeReadyGate;
  /** 当前阶段声明支持的执行任务类型。 */
  supportedTaskKinds: readonly string[];
  /** 当前阶段提供的中断信号模板。 */
  interruptTemplate: InterruptSignal;
}

/**
 * 创建外部认证密钥绑定。
 *
 * 1. 密钥封装：将来自环境变量或配置的明文密钥及其来源元数据（Source, Reference）进行强类型封装。
 * 2. 安全输入：为后续的登录命令生成（如 /login <secret>）提供安全、确定的输入保障。
 *
 * @param input 包含来源、引用和密钥明文的输入
 * @returns 不可变的密钥绑定对象
 */
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

/** 创建待执行的外部认证登录命令动作。 */
export function createExternalAuthCommandAction(
  secret: ExternalAuthSecretBinding,
): ExternalAuthCommandAction {
  return Object.freeze({
    kind: "login_command",
    entrypoint: "game_chat_command",
    target: "minecraft_chat",
    command: `/login ${secret.secret}`,
    retry_allowed: true,
  });
}

/**
 * 创建外部认证执行计划。
 *
 * 1. 动态决策：根据当前的 ExternalAuthState 决定下一步需要执行的认证动作（如发送登录命令）。
 * 2. 状态映射：在 pending 状态下生成真实的认证动作，并同步产出脱敏后的摘要供外部查询。
 *
 * @param state 内部认证状态
 * @param secret 可选的注入密钥绑定
 * @returns 完整的执行计划
 */
export function createExternalAuthExecutionPlan(
  state: ExternalAuthState,
  secret?: ExternalAuthSecretBinding,
): ExternalAuthExecutionPlan {
  switch (state.status) {
    case "not_required":
      return Object.freeze({
        status: "not_required",
        next_action: null,
        action_summary: null,
        retry_allowed: false,
        ready_for_idle: true,
      });
    case "pending": {
      const nextAction = createExternalAuthCommandAction(
        resolveExternalAuthExecutionSecret(state, secret),
      );

      return cloneReadonlyValue({
        status: "pending",
        next_action: nextAction,
        action_summary: {
          kind: nextAction.kind,
          entrypoint: nextAction.entrypoint,
          target: nextAction.target,
          command_preview: "/login <redacted>",
          retry_allowed: nextAction.retry_allowed,
        },
        retry_allowed: true,
        ready_for_idle: false,
      });
    }
    case "authenticated":
      return Object.freeze({
        status: "authenticated",
        next_action: null,
        action_summary: null,
        retry_allowed: false,
        ready_for_idle: true,
      });
    case "failed":
      return Object.freeze({
        status: "failed",
        next_action: null,
        action_summary: null,
        retry_allowed: false,
        ready_for_idle: false,
        failure_reason: state.failure_reason,
        secret_source: state.secret_source,
        secret_reference: state.secret_reference,
      });
  }
}

/**
 * 创建对外可见的外部认证脱敏状态。
 *
 * 1. 安全投影：作为一个“脱敏器”，将包含敏感密钥引用的内部状态转换为适合暴露给客户端的 PublicState。
 * 2. 隐私保护：移除具体的密钥物理细节，仅保留状态机指示和脱敏后的动作预览。
 *
 * @param state 内部认证状态
 * @returns 脱敏后的公开状态
 */
export function createExternalAuthPublicState(state: ExternalAuthState): ExternalAuthPublicState {
  switch (state.status) {
    case "not_required":
      return Object.freeze({
        status: "not_required",
        required: false,
        entrypoint: "none",
        action_summary: null,
      });
    case "pending": {
      return cloneReadonlyValue({
        status: "pending",
        required: true,
        entrypoint: "game_chat_command",
        action_summary: createExternalAuthActionSummary(),
      });
    }
    case "authenticated":
      return Object.freeze({
        status: "authenticated",
        required: true,
        entrypoint: "game_chat_command",
        action_summary: null,
      });
    case "failed":
      return Object.freeze({
        status: "failed",
        required: true,
        entrypoint: "game_chat_command",
        action_summary: null,
        failure_reason: state.failure_reason,
        secret_source: state.secret_source,
        secret_reference: state.secret_reference,
      });
  }
}

/**
 * 创建运行时就绪门控结果。
 *
 * 1. 准入判定：实现核心的“就绪”逻辑。综合考虑运行时状态（如是否忙碌）与外部认证状态（如是否成功）。
 * 2. 能力授权：产出综合 ready 标志并列出阻断原因（blocked_by），决定系统是否可开放 HTTP 或实时推送能力。
 *
 * @param input 包含 Bot 状态 and 外部认证状态的输入
 * @returns 门控判定结果
 */
export function createRuntimeReadyGate(input: {
  status: BotStatus;
  externalAuth: ExternalAuthState;
}): RuntimeReadyGate {
  const blockedBy: RuntimeReadyBlockReason[] = [];

  switch (input.status) {
    case BotStatus.INITIALIZING:
      blockedBy.push("runtime_initializing");
      break;
    case BotStatus.EXECUTING:
    case BotStatus.REFLEXING:
      blockedBy.push("runtime_busy");
      break;
    case BotStatus.DEAD:
      blockedBy.push("bot_dead");
      break;
    case BotStatus.SHUTDOWN:
      blockedBy.push("runtime_shutdown");
      break;
    case BotStatus.IDLE:
      break;
  }

  if (input.externalAuth.status === "pending") {
    blockedBy.push("external_auth_pending");
  }

  if (input.externalAuth.status === "failed") {
    blockedBy.push("external_auth_failed");
  }

  const ready = blockedBy.length === 0;

  return cloneReadonlyValue({
    ready,
    status: ready ? "ready" : "blocked",
    runtime_status: input.status,
    external_auth_status: input.externalAuth.status,
    can_emit_bot_ready: ready,
    can_open_realtime: ready,
    can_open_http: ready,
    blocked_by: blockedBy,
  });
}

/**
 * 创建外部认证运行时状态。
 *
 * 1. 状态收口：将认证结果（成功、失败、待定）统一封装为标准的 ExternalAuthState。
 * 2. 契约保证：负责从密钥绑定中提取元数据，确保状态对象在全系统内的结构一致性。
 *
 * @param input 包含认证状态及相关元数据的判别联合输入
 * @returns 统一的认证状态对象
 */
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
        secret_source: input.secret.source,
        secret_reference: input.secret.reference,
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

/**
 * 创建运行时骨架占位对象。
 *
 * 1. 启动蓝图：聚合初始状态、认证计划及门控结果，为 BotActor 提供完整的启动上下文。
 * 2. 边界定义：定义运行时支持的任务类型（Skill, Sandbox）和标准的中断信号模板。
 *
 * @param input 可选的认证状态和密钥注入
 * @returns 完整的运行时骨架
 */
export function createRuntimeScaffold(
  input: {
    externalAuth?: ExternalAuthState;
    externalAuthSecret?: ExternalAuthSecretBinding;
  } = {},
): RuntimeScaffold {
  const externalAuth = input.externalAuth ?? createExternalAuthState({ status: "not_required" });

  return cloneReadonlyValue({
    defaultStatus: BotStatus.INITIALIZING,
    externalAuth,
    externalAuthPlan: createExternalAuthExecutionPlan(externalAuth, input.externalAuthSecret),
    readyGate: createRuntimeReadyGate({
      status: BotStatus.INITIALIZING,
      externalAuth,
    }),
    supportedTaskKinds: [ExecutionTaskKind.SkillCall, ExecutionTaskKind.SandboxCode],
    interruptTemplate: {
      source: {
        type: "system",
        cause: "shutdown",
      },
      reason: "placeholder",
    },
  });
}
/** 创建外部认证流转动作摘要。 */

function createExternalAuthActionSummary(): ExternalAuthActionSummary {
  return Object.freeze({
    kind: "login_command",
    entrypoint: "game_chat_command",
    target: "minecraft_chat",
    command_preview: "/login <redacted>",
    retry_allowed: true,
  });
}
/** 解析外部认证执行阶段的具体密钥。 */

function resolveExternalAuthExecutionSecret(
  state: ExternalAuthPendingState,
  secret: ExternalAuthSecretBinding | undefined,
): ExternalAuthSecretBinding {
  if (secret === undefined) {
    throw new Error("pending external auth execution plan requires an injected secret binding");
  }

  if (secret.source !== state.secret_source || secret.reference !== state.secret_reference) {
    throw new Error(
      "pending external auth execution plan secret binding must match state metadata",
    );
  }

  return secret;
}
