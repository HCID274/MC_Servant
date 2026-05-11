/**
 * 沙箱运行端口契约。
 *
 * 这里仅描述 runtime（运行时） 与 sandbox（沙箱） 之间的注入边界，避免 BotActor（机器人执行代理）
 * 直接 import（导入） sandbox（沙箱） 实现。
 */

import type { ExecutionTaskKind } from "./foundation.js";
import type {
  EnsureCondition,
  EnsureConditionEvaluation,
  EnsureConditionStateSnapshot,
  SkillName,
  SkillParamsByName,
  ToolchainCapabilityName,
  ToolchainCapabilityParamsByName,
} from "./skills.js";
import type { TaskHistoryStatus } from "./tasking.js";

/** 单次 Facade API（门面接口） 调用的执行门控。 */
export interface SandboxFacadeCallControl {
  /** 沙箱执行进入终态后触发，用于阻止后续真实副作用。 */
  readonly signal: AbortSignal;
  /** 沙箱执行级截止时间。 */
  readonly deadline_ms: number;
}

/** 注入 TS（TypeScript） 代码的只读 owner（主人）上下文。 */
export interface SandboxOwnerContext {
  /** 主人名称；不可用时为空。 */
  readonly name?: string;
  /** 主人是否在线；不可用时为空。 */
  readonly online?: boolean;
  /** 主人发话时或当前观测位置；必须来自 observation（观测） 或 ConversationWorker（对话工作线程） 透传。 */
  readonly position?: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>;
}

/** TS（TypeScript） 代码内 search（检索） 的只读桥接输入。 */
export interface SandboxSearchInput {
  /** 目标 Bot（机器人） 标识。 */
  readonly bot_id: string;
  /** 检索文本。 */
  readonly query: string;
  /** 可选最大返回数。 */
  readonly limit?: number;
}

/** TS（TypeScript） 代码内 search（检索） 的只读桥接器。 */
export type SandboxSearchAdapter = (
  input: SandboxSearchInput,
) => Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>;

/** 沙箱 Facade API（门面接口） 写动作适配器。 */
export interface SandboxFacadeExecutionAdapter {
  /** 通过 BotActor（机器人执行代理） 单写者执行技能动作。 */
  executeBotSkill<TName extends SkillName>(
    skill: TName,
    params: Readonly<SkillParamsByName[TName]>,
    control?: SandboxFacadeCallControl,
  ): Promise<Readonly<Record<string, unknown>>>;
  /** 通过 BotActor（机器人执行代理） 单写者执行已实现的工具链能力。 */
  executeToolchainCapability?<TName extends ToolchainCapabilityName>(
    capability: TName,
    params: Readonly<ToolchainCapabilityParamsByName[TName]>,
    control?: SandboxFacadeCallControl,
  ): Promise<Readonly<Record<string, unknown>>>;
  /** 通过 BotActor（机器人执行代理） 单写者写入聊天。 */
  writeChat(
    method: "say" | "report",
    params: Readonly<{ message: string }>,
    control?: SandboxFacadeCallControl,
  ): Promise<Readonly<Record<string, unknown>>>;
  /** 通过 Brain search（大脑检索） 等只读通道执行 search（检索）。 */
  searchMemory?(
    input: SandboxSearchInput,
    control?: SandboxFacadeCallControl,
  ): Promise<Readonly<Record<string, unknown>>>;
  /** 读取 ensure（确保） 条件检查的真实状态快照。 */
  captureConditionState?(
    control?: SandboxFacadeCallControl,
  ): Promise<EnsureConditionStateSnapshot> | EnsureConditionStateSnapshot;
  /** 用 runtime/minecraft-data（运行时/Minecraft 数据库）事实评估 ensure 条件。 */
  evaluateCondition?(
    input: Readonly<{
      readonly condition: EnsureCondition;
      readonly baseline: EnsureConditionStateSnapshot;
      readonly current: EnsureConditionStateSnapshot;
    }>,
    control?: SandboxFacadeCallControl,
  ): Promise<EnsureConditionEvaluation> | EnsureConditionEvaluation;
}

/** BotActor（机器人执行代理） 侧需要的沙箱执行请求最小结构。 */
export interface RuntimeSandboxExecutionRequest {
  /** 固定为 code（代码）。 */
  readonly type: ExecutionTaskKind.Code;
  /** 任务标识。 */
  readonly job_id: string;
  /** Bot（机器人） 标识。 */
  readonly bot_id: string;
  /** 意图纪元。 */
  readonly intent_epoch: number;
  /** 规划时快照时间戳。 */
  readonly snapshot_ts: number;
  /** 待执行源码。 */
  readonly code: string;
  /** 指向 sandbox（沙箱执行） JSONL（结构化日志） 的引用。 */
  readonly log_ref: string;
  /** 指向 sandbox（沙箱执行） 原始代码文件的引用。 */
  readonly code_ref?: string;
  /** 资源限制。 */
  readonly resource_limits: Readonly<{
    /** 内存上限。 */
    readonly memory_limit_mb: number;
    /** 总超时时间。 */
    readonly timeout_ms: number;
    /** 脚本运行超时时间。 */
    readonly script_timeout_ms: number;
    /** 单次 sleep 上限。 */
    readonly max_sleep_ms: number;
    /** 中断后的强制清理等待时间。 */
    readonly abort_cleanup_timeout_ms: number;
  }>;
}

/** BotActor（机器人执行代理） 侧需要的沙箱执行步骤最小结构。 */
export interface RuntimeSandboxExecutionStepResult {
  /** 动作名。 */
  readonly action: string;
  /** 动作参数；仅用于终态摘要，不参与执行决策。 */
  readonly params?: Readonly<Record<string, unknown>>;
  /** 执行状态。 */
  readonly status: string;
  /** 步骤返回值；仅用于终态摘要，不参与执行决策。 */
  readonly result?: Readonly<Record<string, unknown>>;
  /** 步骤错误。 */
  readonly error?: RuntimeSandboxExecutionErrorSnapshot;
}

/** BotActor（机器人执行代理） 侧需要的沙箱执行错误快照。 */
export interface RuntimeSandboxExecutionErrorSnapshot {
  /** 错误分类名。 */
  readonly name: string;
  /** 错误消息。 */
  readonly message: string;
  /** 可选错误码。 */
  readonly error_code?: string;
}

/** BotActor（机器人执行代理） 侧需要的沙箱执行结果公共字段。 */
export interface RuntimeSandboxExecutionResultBase {
  /** 终态摘要。 */
  readonly summary: Readonly<{
    /** 总步骤数。 */
    readonly total_steps: number;
  }>;
  /** 收集到的步骤结果。 */
  readonly step_results: readonly RuntimeSandboxExecutionStepResult[];
}

/** BotActor（机器人执行代理） 侧需要的沙箱执行结果最小结构。 */
export type RuntimeSandboxExecutionResult =
  | (RuntimeSandboxExecutionResultBase & {
      /** 沙箱执行成功终态。 */
      readonly status: TaskHistoryStatus.Completed;
    })
  | (RuntimeSandboxExecutionResultBase & {
      /** 沙箱执行失败终态。 */
      readonly status: TaskHistoryStatus.Failed;
      /** 终态错误。 */
      readonly error: RuntimeSandboxExecutionErrorSnapshot;
    })
  | (RuntimeSandboxExecutionResultBase & {
      /** 沙箱执行中断终态。 */
      readonly status: TaskHistoryStatus.Interrupted;
      /** 终态错误。 */
      readonly error: RuntimeSandboxExecutionErrorSnapshot;
    });

/** BotActor（机器人执行代理） 注入的沙箱执行依赖集合。 */
export interface RuntimeSandboxExecutionDependencies {
  /** 创建 sandbox（沙箱） 日志引用。 */
  createLogRef(input: { date: string; job_id: string }): string;
  /** 创建 sandbox（沙箱） 执行请求。 */
  createRequest(input: {
    job_id: string;
    bot_id: string;
    intent_epoch: number;
    snapshot_ts: number;
    code: string;
    log_ref: string;
  }): RuntimeSandboxExecutionRequest;
  /** 执行 code（代码） 请求。 */
  executeRequest(input: {
    request: RuntimeSandboxExecutionRequest;
    facade: SandboxFacadeExecutionAdapter;
    signal: AbortSignal;
    task: {
      readonly id: string;
      readonly userMessage: string;
      readonly intent: string;
      readonly owner?: SandboxOwnerContext;
    };
  }): Promise<RuntimeSandboxExecutionResult>;
}
