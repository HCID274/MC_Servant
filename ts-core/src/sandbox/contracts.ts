/**
 * 沙箱契约与 API 规范。
 *
 * 1. Facade 建模：定义沙箱门面（Facade API）的顶层分区（sections）和各分区下的方法/只读字段契约。
 * 2. 安全隔离规则：规定沙箱内可用的能力范围（如 bot 写动作、world 读操作等）。
 * 3. 错误分级：定义标准化的沙箱执行错误分类（StaticCheck, Transpile, Timeout, OOM, FacadeCall 等）。
 * 4. IO 契约：定义沙箱执行请求（ExecutionRequest）和聚合执行结果（ExecutionResult）的完整数据结构。
 */

import type { ExecutionTaskKind } from "../core-ports/foundation.js";
import type {
  CraftCapabilityParams,
  EmptyEnsureCapabilityParams,
  EnsureCobblestoneCapabilityParams,
  EnsureLogsCapabilityParams,
  PlaceCapabilityParams,
  SkillName,
  SkillParamsByName,
  ToolchainCapabilityName,
  ToolchainCapabilityParamsByName,
} from "../core-ports/skills.js";
import {
  FORBIDDEN_TOOLCHAIN_DEMO_NAMES,
  TOOLCHAIN_CAPABILITY_NAMES,
  TOOLCHAIN_FAILURE_CODES,
} from "../core-ports/skills.js";
import type { TaskHistoryStatus } from "../core-ports/tasking.js";
import type { SandboxJsonlLine, TaskLogStepStatus } from "../diagnostics/contracts.js";

/** Facade API（门面接口） 顶层分区清单。 */
export const SANDBOX_FACADE_SECTIONS = [
  "bot",
  "world",
  "knowledge",
  "memory",
  "chat",
  "owner",
  "task",
] as const;

/** Facade API（门面接口） 顶层分区联合类型。 */
export type SandboxFacadeSectionName = (typeof SANDBOX_FACADE_SECTIONS)[number];

/** Facade API（门面接口） 只读分区清单。 */
export const SANDBOX_READONLY_SECTIONS = ["world", "knowledge", "memory", "owner", "task"] as const;

/** Facade API（门面接口） 只读分区联合类型。 */
export type SandboxReadonlySectionName = (typeof SANDBOX_READONLY_SECTIONS)[number];

/** `bot`（动作） 分区允许暴露的写动作清单。 */
export const SANDBOX_BOT_METHOD_NAMES = [
  "goTo",
  "mine",
  "cutTree",
  "collect",
  "equip",
  "craft",
  "place",
  "placeCraftingTable",
  "ensureLogs",
  "ensureCraftingTablePlaced",
  "ensureWoodenPickaxeEquipped",
  "ensureCobblestone",
  "ensureStonePickaxeEquipped",
] as const;

/** `bot`（动作） 分区方法名联合类型。 */
export type SandboxBotMethodName =
  | SkillName
  | "craft"
  | "place"
  | "placeCraftingTable"
  | "ensureLogs"
  | "ensureCraftingTablePlaced"
  | "ensureWoodenPickaxeEquipped"
  | "ensureCobblestone"
  | "ensureStonePickaxeEquipped";

/** sandbox（沙箱） 工具链能力契约清单；未实现前不得注入为真实 Facade（门面） 方法。 */
export const SANDBOX_TOOLCHAIN_CAPABILITY_NAMES = TOOLCHAIN_CAPABILITY_NAMES;

/** sandbox（沙箱） 禁止的一键 demo（演示） 方法名清单。 */
export const SANDBOX_FORBIDDEN_DEMO_METHOD_NAMES = FORBIDDEN_TOOLCHAIN_DEMO_NAMES;

/** sandbox（沙箱） 工具链能力失败码清单。 */
export const SANDBOX_TOOLCHAIN_FAILURE_CODES = TOOLCHAIN_FAILURE_CODES;

/** sandbox（沙箱） 工具链能力参数映射。 */
export type SandboxToolchainCapabilityParamsByName = ToolchainCapabilityParamsByName;

/** sandbox（沙箱） 工具链能力名联合类型。 */
export type SandboxToolchainCapabilityName = ToolchainCapabilityName;

/** `chat`（聊天） 分区允许的写动作清单。 */
export const SANDBOX_CHAT_METHOD_NAMES = ["say", "report"] as const;

/** `chat`（聊天） 分区方法名联合类型。 */
export type SandboxChatMethodName = (typeof SANDBOX_CHAT_METHOD_NAMES)[number];

/** `world`（世界） 分区允许的查询方法清单。 */
export const SANDBOX_WORLD_METHOD_NAMES = [
  "nearestBlocks",
  "nearestEntities",
  "blockAt",
  "getTime",
  "getBiome",
] as const;

/** `world`（世界） 分区方法名联合类型。 */
export type SandboxWorldMethodName = (typeof SANDBOX_WORLD_METHOD_NAMES)[number];

/** `knowledge`（知识） 分区允许的查询方法清单。 */
export const SANDBOX_KNOWLEDGE_METHOD_NAMES = [
  "getRecipe",
  "getBlockInfo",
  "getItemInfo",
  "getEntityInfo",
  "getSmeltingRecipe",
] as const;

/** `knowledge`（知识） 分区方法名联合类型。 */
export type SandboxKnowledgeMethodName = (typeof SANDBOX_KNOWLEDGE_METHOD_NAMES)[number];

/** `memory`（记忆） 分区允许的查询方法清单。 */
export const SANDBOX_MEMORY_METHOD_NAMES = ["search", "recentTasks"] as const;

/** `memory`（记忆） 分区方法名联合类型。 */
export type SandboxMemoryMethodName = (typeof SANDBOX_MEMORY_METHOD_NAMES)[number];

/** `owner`（主人） 分区允许的只读字段清单。 */
export const SANDBOX_OWNER_VALUE_NAMES = ["position", "name", "online"] as const;

/** `owner`（主人） 分区字段名联合类型。 */
export type SandboxOwnerValueName = (typeof SANDBOX_OWNER_VALUE_NAMES)[number];

/** `task`（任务） 分区允许的只读字段清单。 */
export const SANDBOX_TASK_VALUE_NAMES = ["id", "userMessage", "intent"] as const;

/** `task`（任务） 分区字段名联合类型。 */
export type SandboxTaskValueName = (typeof SANDBOX_TASK_VALUE_NAMES)[number];

/** 沙箱执行期间允许被记录为步骤的动作清单。 */
export const SANDBOX_STEP_ACTION_NAMES = [
  ...SANDBOX_BOT_METHOD_NAMES,
  ...SANDBOX_CHAT_METHOD_NAMES,
] as const;

/** 沙箱步骤动作名联合类型。 */
export type SandboxStepActionName = (typeof SANDBOX_STEP_ACTION_NAMES)[number];

/** 沙箱步骤动作与参数结构的映射表。 */
export interface SandboxStepParamsByAction extends Pick<SkillParamsByName, SkillName> {
  /** `craft`（合成） 的参数结构。 */
  readonly craft: CraftCapabilityParams;
  /** `place`（放置） 的参数结构。 */
  readonly place: PlaceCapabilityParams;
  /** `placeCraftingTable`（放置工作台） 的参数结构。 */
  readonly placeCraftingTable: EmptyEnsureCapabilityParams;
  /** `ensureLogs`（确保原木） 的参数结构。 */
  readonly ensureLogs: EnsureLogsCapabilityParams;
  /** `ensureCraftingTablePlaced`（确保工作台已放置） 的参数结构。 */
  readonly ensureCraftingTablePlaced: EmptyEnsureCapabilityParams;
  /** `ensureWoodenPickaxeEquipped`（确保木镐已装备） 的参数结构。 */
  readonly ensureWoodenPickaxeEquipped: EmptyEnsureCapabilityParams;
  /** `ensureCobblestone`（确保圆石） 的参数结构。 */
  readonly ensureCobblestone: EnsureCobblestoneCapabilityParams;
  /** `ensureStonePickaxeEquipped`（确保石镐已装备） 的参数结构。 */
  readonly ensureStonePickaxeEquipped: EmptyEnsureCapabilityParams;
  /** `say`（聊天输出） 的参数结构。 */
  readonly say: {
    /** 输出消息。 */
    readonly message: string;
  };
  /** `report`（状态汇报） 的参数结构。 */
  readonly report: {
    /** 汇报消息。 */
    readonly message: string;
  };
}

/** Facade API（门面接口） 成员的基础结构。 */
export interface SandboxMemberContract<TName extends string = string> {
  /** 成员名。 */
  readonly name: TName;
}

/** Facade API（门面接口） 的方法契约结构。 */
export interface SandboxMethodContract<TName extends string = string>
  extends SandboxMemberContract<TName> {
  /** 成员种类。 */
  readonly kind: "method";
  /** 访问模式。 */
  readonly access: "read" | "write";
  /** 参数键顺序。 */
  readonly parameter_keys: readonly string[];
  /** 是否应产出步骤结果。 */
  readonly emits_step: boolean;
  /** 对齐到的技能名。 */
  readonly aligned_skill?: SkillName;
}

/** Facade API（门面接口） 的只读字段契约结构。 */
export interface SandboxValueContract<TName extends string = string>
  extends SandboxMemberContract<TName> {
  /** 成员种类。 */
  readonly kind: "value";
  /** 访问模式。 */
  readonly access: "read";
}

/** `bot`（动作） 分区与技能目录一一对齐的绑定结构。 */
export type SandboxBotSkillBindings = {
  readonly [TName in SkillName]: TName;
};

/** Facade API（门面接口） 的完整顶层契约结构。 */
export interface SandboxFacadeContract {
  /** `bot`（动作） 分区。 */
  readonly bot: Readonly<Record<SandboxBotMethodName, SandboxMethodContract<SandboxBotMethodName>>>;
  /** `world`（世界） 分区。 */
  readonly world: Readonly<
    Record<SandboxWorldMethodName, SandboxMethodContract<SandboxWorldMethodName>>
  >;
  /** `knowledge`（知识） 分区。 */
  readonly knowledge: Readonly<
    Record<SandboxKnowledgeMethodName, SandboxMethodContract<SandboxKnowledgeMethodName>>
  >;
  /** `memory`（记忆） 分区。 */
  readonly memory: Readonly<
    Record<SandboxMemoryMethodName, SandboxMethodContract<SandboxMemoryMethodName>>
  >;
  /** `chat`（聊天） 分区。 */
  readonly chat: Readonly<
    Record<SandboxChatMethodName, SandboxMethodContract<SandboxChatMethodName>>
  >;
  /** `owner`（主人） 分区。 */
  readonly owner: Readonly<
    Record<SandboxOwnerValueName, SandboxValueContract<SandboxOwnerValueName>>
  >;
  /** `task`（任务） 分区。 */
  readonly task: Readonly<Record<SandboxTaskValueName, SandboxValueContract<SandboxTaskValueName>>>;
}

/** 沙箱执行错误名清单。 */
export const SANDBOX_ERROR_NAMES = [
  "StaticCheckError",
  "TranspileError",
  "SandboxTimeoutError",
  "SandboxOOMError",
  "FacadeCallError",
  "AbortError",
  "UnhandledError",
] as const;

/** 沙箱执行错误名联合类型。 */
export type SandboxErrorName = (typeof SANDBOX_ERROR_NAMES)[number];

/** 沙箱执行错误的公共字段。 */
export interface SandboxExecutionErrorBase<TName extends SandboxErrorName = SandboxErrorName> {
  /** 错误名。 */
  readonly name: TName;
  /** 错误消息。 */
  readonly message: string;
  /** 是否允许调用方恢复。 */
  readonly recoverable: boolean;
}

/** 静态预检失败错误结构。 */
export interface StaticCheckError extends SandboxExecutionErrorBase<"StaticCheckError"> {
  /** 命中的禁止模式。 */
  readonly violation: string;
}

/** 转译失败错误结构。 */
export interface TranspileError extends SandboxExecutionErrorBase<"TranspileError"> {
  /** 可选的诊断文本。 */
  readonly diagnostics?: readonly string[];
}

/** 沙箱超时错误结构。 */
export interface SandboxTimeoutError extends SandboxExecutionErrorBase<"SandboxTimeoutError"> {
  /** 超时阈值。 */
  readonly timeout_ms: number;
}

/** 沙箱内存溢出错误结构。 */
export interface SandboxOOMError extends SandboxExecutionErrorBase<"SandboxOOMError"> {
  /** 内存上限。 */
  readonly memory_limit_mb: number;
}

/** Facade 调用失败错误结构。 */
export interface FacadeCallError extends SandboxExecutionErrorBase<"FacadeCallError"> {
  /** 出错的方法名。 */
  readonly method: SandboxStepActionName;
  /** 原始调用参数。 */
  readonly params: Readonly<Record<string, unknown>>;
  /** 结构化错误码。 */
  readonly error_code: string;
  /** 能力返回的可审计细节；用于把候选点失败原因传到 task（任务） 诊断。 */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** 外部中断错误结构。 */
export interface AbortError extends SandboxExecutionErrorBase<"AbortError"> {
  /** 中断错误固定不可恢复。 */
  readonly recoverable: false;
  /** 中断原因。 */
  readonly reason: string;
}

/** 未捕获运行时异常结构。 */
export interface UnhandledError extends SandboxExecutionErrorBase<"UnhandledError"> {
  /** 可选堆栈。 */
  readonly stack?: string;
}

/** 沙箱执行错误联合类型。 */
export type SandboxExecutionError =
  | StaticCheckError
  | TranspileError
  | SandboxTimeoutError
  | SandboxOOMError
  | FacadeCallError
  | AbortError
  | UnhandledError;

/** 沙箱执行资源限制结构。 */
export interface SandboxExecutionResourceLimits {
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
}

/** 沙箱执行请求结构。 */
export interface SandboxExecutionRequest {
  /** 固定为 code（代码）。 */
  readonly type: ExecutionTaskKind.Code;
  /** 任务标识。 */
  readonly job_id: string;
  /** Bot 标识。 */
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
  readonly resource_limits: Readonly<SandboxExecutionResourceLimits>;
}

/** 单步 Facade 调用的执行结果结构。 */
export interface SandboxStepResult<TAction extends SandboxStepActionName = SandboxStepActionName> {
  /** 步骤索引。 */
  readonly step_index: number;
  /** 动作名。 */
  readonly action: TAction;
  /** 动作参数。 */
  readonly params: Readonly<SandboxStepParamsByAction[TAction]>;
  /** 执行状态。 */
  readonly status: TaskLogStepStatus;
  /** 步骤耗时。 */
  readonly duration_ms?: number;
  /** 步骤返回值。 */
  readonly result?: Readonly<Record<string, unknown>>;
  /** 步骤错误。 */
  readonly error?: SandboxExecutionError;
}

/** 沙箱执行终态状态联合类型。 */
export type SandboxTerminalStatus =
  | TaskHistoryStatus.Completed
  | TaskHistoryStatus.Failed
  | TaskHistoryStatus.Interrupted;

/** 沙箱执行终态摘要结构。 */
export interface SandboxExecutionSummary {
  /** 终态状态。 */
  readonly terminal_status: SandboxTerminalStatus;
  /** 总步骤数。 */
  readonly total_steps: number;
  /** 总耗时。 */
  readonly duration_ms: number;
}

/** 沙箱执行结果的公共字段。 */
export interface SandboxExecutionResultBase {
  /** 任务标识。 */
  readonly job_id: string;
  /** Bot 标识。 */
  readonly bot_id: string;
  /** 意图纪元。 */
  readonly intent_epoch: number;
  /** 指向 sandbox（沙箱执行） JSONL（结构化日志） 的引用。 */
  readonly log_ref: string;
  /** 指向 sandbox（沙箱执行） 原始代码文件的引用。 */
  readonly code_ref?: string;
  /** 阶段性日志。 */
  readonly phase_logs: readonly SandboxJsonlLine[];
  /** 终态摘要。 */
  readonly summary: Readonly<SandboxExecutionSummary>;
}

/** 成功完成的沙箱执行结果结构。 */
export interface SandboxExecutionSuccess extends SandboxExecutionResultBase {
  /** 固定为 completed。 */
  readonly status: TaskHistoryStatus.Completed;
  /** 收集到的步骤结果。 */
  readonly step_results: readonly SandboxStepResult[];
}

/** 失败结束的沙箱执行结果结构。 */
export interface SandboxExecutionFailure extends SandboxExecutionResultBase {
  /** 固定为 failed。 */
  readonly status: TaskHistoryStatus.Failed;
  /** 收集到的步骤结果。 */
  readonly step_results: readonly SandboxStepResult[];
  /** 终态错误。 */
  readonly error: SandboxExecutionError;
}

/** 被中断的沙箱执行结果结构。 */
export interface SandboxExecutionInterrupted extends SandboxExecutionResultBase {
  /** 固定为 interrupted。 */
  readonly status: TaskHistoryStatus.Interrupted;
  /** 收集到的步骤结果。 */
  readonly step_results: readonly SandboxStepResult[];
  /** 中断错误。 */
  readonly error: AbortError;
}

/** 沙箱执行结果联合类型。 */
export type SandboxExecutionResult =
  | SandboxExecutionSuccess
  | SandboxExecutionFailure
  | SandboxExecutionInterrupted;
