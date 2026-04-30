/**
 * 运行时端口契约。
 *
 * 只放跨模块共享的 BotActor（机器人执行代理） 状态、中断与运行时任务包类型；
 * 运行时实现细节继续留在 runtime（运行时） 模块。
 */

import type { ExecutionTaskEnvelope } from "./foundation.js";
import type { ReflexInterruptSource, SnapshotPosition } from "./observation.js";
import type { SkillName } from "./skills.js";

/** ResourceIndex（资源索引） 允许的只读刷新半径阶梯。 */
export const RESOURCE_REFRESH_RADIUS_STEPS = Object.freeze([16, 32, 64] as const);

/** ResourceIndex（资源索引） 允许的只读刷新半径。 */
export type ResourceRefreshRadius = (typeof RESOURCE_REFRESH_RADIUS_STEPS)[number];

/** runtime（运行时） 资源刷新状态，用于区分命中、未命中与不可用诊断。 */
export type RuntimeResourceRefreshStatus =
  | "found"
  | "cache_miss"
  | "runtime_unavailable"
  | "unsupported_resource_key";

/** runtime（运行时） 只读资源扫描到的候选方块。 */
export interface RuntimeResourceBlockSummary {
  /** 标准方块标识。 */
  readonly block_name: string;
  /** 方块坐标。 */
  readonly position: Readonly<SnapshotPosition>;
  /** 与 Bot（机器人） 的距离。 */
  readonly distance: number;
  /** 匹配到的资源键。 */
  readonly resource_keys: readonly string[];
  /** 可选资源簇标识。 */
  readonly cluster_key?: string;
}

/** runtime（运行时） 只读资源刷新结果。 */
export interface RuntimeResourceRefreshResult {
  /** 被刷新的资源键。 */
  readonly resource_key: string;
  /** 使用的刷新半径。 */
  readonly radius: ResourceRefreshRadius;
  /** 刷新状态。 */
  readonly status: RuntimeResourceRefreshStatus;
  /** 当前世界 / 维度键，用于避免跨世界缓存混用。 */
  readonly world_key: string;
  /** 本次扫描产生的快照版本。 */
  readonly snapshot_version: string;
  /** 扫描发生时间戳。 */
  readonly scanned_at: number;
  /** 扫描锚点，默认为 Bot（机器人） 当前位置。 */
  readonly origin: Readonly<SnapshotPosition>;
  /** 匹配到的候选方块。 */
  readonly blocks: readonly RuntimeResourceBlockSummary[];
  /** 可读诊断。 */
  readonly diagnostics: readonly string[];
}

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

/** BotActor（机器人执行代理） 当前任务只读投影。 */
export type BotActorCurrentTaskProjection =
  | {
      /** 当前任务类型。 */
      readonly kind: "skill_call";
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 正在执行的技能名。 */
      readonly skill: SkillName;
    }
  | {
      /** 当前任务类型。 */
      readonly kind: "sandbox_code";
      /** 原始消息标识。 */
      readonly message_id: string;
    };

/** BotActor（机器人执行代理） 最近技能执行只读投影。 */
export interface BotActorRecentSkillProjection {
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 最近执行的技能名。 */
  readonly skill: SkillName;
}

/** BotActor（机器人执行代理） 最近沙箱执行只读投影。 */
export interface BotActorRecentSandboxProjection {
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 最近沙箱终态。 */
  readonly status: "completed" | "failed" | "interrupted";
  /** 沙箱步骤数。 */
  readonly total_steps: number;
}

/** BotActor（机器人执行代理） 给对话侧读取的只读状态投影。 */
export interface BotActorStateProjection {
  /** 当前 BotActor（机器人执行代理） 状态。 */
  readonly status: BotStatus;
  /** 当前 ready（就绪） 门控是否开放。 */
  readonly ready: boolean;
  /** 世界交互能力是否就绪。 */
  readonly world_ready: boolean;
  /** 当前正在执行的任务摘要。 */
  readonly current_task: BotActorCurrentTaskProjection | null;
  /** 最近一次技能执行摘要。 */
  readonly recent_skill: BotActorRecentSkillProjection | null;
  /** 最近一次沙箱执行摘要。 */
  readonly recent_sandbox: BotActorRecentSandboxProjection | null;
  /** 可直接注入 chat prompt（闲聊提示词） 的短摘要。 */
  readonly summary: string;
}

/** 创建 BotActor（机器人执行代理） 只读状态投影。 */
export function createBotActorStateProjection(input: {
  /** 当前 BotActor（机器人执行代理） 状态。 */
  readonly status: BotStatus;
  /** 当前 ready（就绪） 门控是否开放。 */
  readonly ready: boolean;
  /** 世界交互能力是否就绪。 */
  readonly world_ready: boolean;
  /** 当前正在执行的任务摘要。 */
  readonly current_task?: BotActorCurrentTaskProjection | null;
  /** 最近一次技能执行摘要。 */
  readonly recent_skill?: BotActorRecentSkillProjection | null;
  /** 最近一次沙箱执行摘要。 */
  readonly recent_sandbox?: BotActorRecentSandboxProjection | null;
}): BotActorStateProjection {
  const currentTask = cloneBotActorCurrentTaskProjection(input.current_task ?? null);
  const recentSkill =
    input.recent_skill === undefined || input.recent_skill === null
      ? null
      : Object.freeze({
          message_id: input.recent_skill.message_id,
          skill: input.recent_skill.skill,
        });
  const recentSandbox =
    input.recent_sandbox === undefined || input.recent_sandbox === null
      ? null
      : Object.freeze({
          message_id: input.recent_sandbox.message_id,
          status: input.recent_sandbox.status,
          total_steps: input.recent_sandbox.total_steps,
        });

  return Object.freeze({
    status: input.status,
    ready: input.ready,
    world_ready: input.world_ready,
    current_task: currentTask,
    recent_skill: recentSkill,
    recent_sandbox: recentSandbox,
    summary: createBotActorStateProjectionSummary({
      status: input.status,
      ready: input.ready,
      world_ready: input.world_ready,
      current_task: currentTask,
      recent_skill: recentSkill,
      recent_sandbox: recentSandbox,
    }),
  });
}

/** 创建 BotActor（机器人执行代理） 给闲聊使用的短状态摘要。 */
export function createBotActorStateProjectionSummary(input: {
  /** 当前 BotActor（机器人执行代理） 状态。 */
  readonly status: BotStatus;
  /** 当前 ready（就绪） 门控是否开放。 */
  readonly ready: boolean;
  /** 世界交互能力是否就绪。 */
  readonly world_ready: boolean;
  /** 当前正在执行的任务摘要。 */
  readonly current_task: BotActorCurrentTaskProjection | null;
  /** 最近一次技能执行摘要。 */
  readonly recent_skill: BotActorRecentSkillProjection | null;
  /** 最近一次沙箱执行摘要。 */
  readonly recent_sandbox: BotActorRecentSandboxProjection | null;
}): string {
  const base = `当前状态：${input.status}；ready：${input.ready ? "是" : "否"}；世界交互：${input.world_ready ? "已就绪" : "未就绪"}`;

  if (input.current_task?.kind === "skill_call") {
    return `${base}；正在执行技能：${input.current_task.skill}（消息 ${input.current_task.message_id}）`;
  }

  if (input.current_task?.kind === "sandbox_code") {
    return `${base}；正在执行沙箱代码（消息 ${input.current_task.message_id}）`;
  }

  if (input.recent_skill !== null) {
    return `${base}；刚完成技能：${input.recent_skill.skill}（消息 ${input.recent_skill.message_id}）`;
  }

  if (input.recent_sandbox !== null) {
    return `${base}；最近沙箱：${input.recent_sandbox.status}，步骤 ${input.recent_sandbox.total_steps}（消息 ${input.recent_sandbox.message_id}）`;
  }

  return base;
}

/** 克隆 BotActor（机器人执行代理） 当前任务投影，避免外部引用污染只读快照。 */
function cloneBotActorCurrentTaskProjection(
  task: BotActorCurrentTaskProjection | null,
): BotActorCurrentTaskProjection | null {
  if (task === null) {
    return null;
  }

  if (task.kind === "skill_call") {
    return Object.freeze({
      kind: "skill_call" as const,
      message_id: task.message_id,
      skill: task.skill,
    });
  }

  return Object.freeze({
    kind: "sandbox_code" as const,
    message_id: task.message_id,
  });
}
