import type { AppBootstrapContract, AppExternalAuthContract } from "./bootstrap.js";
import type {
  AppLifecycleStepName,
  AppReadinessDescriptor,
  AppReadinessState,
  AppSubsystemName,
} from "./contracts.js";

/** 启动入口不会连接的真实依赖清单。 */
export const APP_ENTRYPOINT_PENDING_IO_TARGETS = [
  "redis",
  "postgres",
  "fastify",
  "socket.io",
  "mineflayer",
] as const;

/** 启动入口不会连接的真实依赖联合类型。 */
export type AppEntrypointPendingIoTarget = (typeof APP_ENTRYPOINT_PENDING_IO_TARGETS)[number];

/** 启动计划中的可读步骤摘要。 */
export interface AppEntrypointStepSummary<
  TName extends AppLifecycleStepName = AppLifecycleStepName,
> {
  /** 当前步骤在计划中的顺序，从 1 开始。 */
  readonly order: number;
  /** 生命周期步骤名。 */
  readonly name: TName;
  /** 所属子系统。 */
  readonly subsystem: AppSubsystemName;
  /** 当前子系统在装配阶段的就绪状态。 */
  readonly readiness: AppReadinessState | null;
  /** 前置依赖步骤。 */
  readonly depends_on: readonly AppLifecycleStepName[];
  /** 步骤说明。 */
  readonly description: string;
}

/** 启动入口暴露的真实 IO（输入输出） 边界摘要。 */
export interface AppEntrypointIoBoundarySummary {
  /** 当前入口的执行模式。 */
  readonly mode: "bootstrap_only";
  /** 当前阶段是否已建立真实连接。 */
  readonly connects_real_io: false;
  /** 仍处于计划态、尚未连接的真实依赖。 */
  readonly pending_targets: readonly AppEntrypointPendingIoTarget[];
  /** 边界说明。 */
  readonly note: string;
}

/** 单进程启动入口输出的可测试摘要。 */
export interface AppStartupSummary<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 运行时初始状态。 */
  readonly initial_status: AppBootstrapContract<TBotId>["runtime"]["initial_status"];
  /** 外部认证装配结果。 */
  readonly external_auth: AppExternalAuthContract;
  /** 当前 ready（就绪） 门控结果。 */
  readonly ready_gate: AppBootstrapContract<TBotId>["runtime"]["ready_gate"];
  /** 启动序列摘要。 */
  readonly startup_plan: readonly AppEntrypointStepSummary[];
  /** 关闭序列摘要。 */
  readonly shutdown_plan: readonly AppEntrypointStepSummary[];
  /** 当前入口的 IO 边界说明。 */
  readonly io_boundary: AppEntrypointIoBoundarySummary;
}

function createReadinessIndex(
  readinessCatalog: readonly AppReadinessDescriptor[],
): ReadonlyMap<AppSubsystemName, AppReadinessState> {
  return new Map(
    readinessCatalog.map((descriptor) => [descriptor.subsystem, descriptor.readiness]),
  );
}

function createStepSummary(
  step:
    | AppBootstrapContract["lifecycle"]["startup"][number]
    | AppBootstrapContract["lifecycle"]["shutdown"][number],
  order: number,
  readinessIndex: ReadonlyMap<AppSubsystemName, AppReadinessState>,
): AppEntrypointStepSummary {
  return Object.freeze({
    order,
    name: step.name,
    subsystem: step.subsystem,
    readiness: readinessIndex.get(step.subsystem) ?? null,
    depends_on: Object.freeze([...step.depends_on]),
    description: step.description,
  });
}

/** 根据纯装配结果构造可测试的启动摘要。 */
export function createAppStartupSummary<TBotId extends string>(
  bootstrap: AppBootstrapContract<TBotId>,
): AppStartupSummary<TBotId> {
  const readinessIndex = createReadinessIndex(bootstrap.readiness);

  return Object.freeze({
    bot_id: bootstrap.bot_id,
    initial_status: bootstrap.runtime.initial_status,
    external_auth: bootstrap.auth,
    ready_gate: bootstrap.runtime.ready_gate,
    startup_plan: Object.freeze(
      bootstrap.lifecycle.startup.map((step, index) =>
        createStepSummary(step, index + 1, readinessIndex),
      ),
    ),
    shutdown_plan: Object.freeze(
      bootstrap.lifecycle.shutdown.map((step, index) =>
        createStepSummary(step, index + 1, readinessIndex),
      ),
    ),
    io_boundary: Object.freeze({
      mode: "bootstrap_only",
      connects_real_io: false,
      pending_targets: Object.freeze([...APP_ENTRYPOINT_PENDING_IO_TARGETS]),
      note: "当前入口只输出装配摘要，不会发起真实 Redis、PostgreSQL、Fastify、Socket.io 或 Mineflayer 连接。",
    }),
  });
}

/** 把启动摘要渲染为可直接输出到控制台的文本。 */
export function renderAppStartupSummary<TBotId extends string>(
  summary: AppStartupSummary<TBotId>,
): string {
  const lines = [
    "TS Core bootstrap summary",
    `bot_id: ${summary.bot_id}`,
    `initial_status: ${summary.initial_status}`,
    `external_auth.status: ${summary.external_auth.state.status}`,
    `external_auth.entrypoint: ${summary.external_auth.entrypoint}`,
    `external_auth.secret_injected: ${String(summary.external_auth.secret_injected)}`,
    ...(summary.external_auth.state.action_summary
      ? [
          `external_auth.command_preview: ${summary.external_auth.state.action_summary.command_preview}`,
        ]
      : []),
    `ready_gate.status: ${summary.ready_gate.status}`,
    `ready_gate.ready: ${String(summary.ready_gate.ready)}`,
    `ready_gate.can_open_realtime: ${String(summary.ready_gate.can_open_realtime)}`,
    `ready_gate.can_open_http: ${String(summary.ready_gate.can_open_http)}`,
    `ready_gate.can_emit_bot_ready: ${String(summary.ready_gate.can_emit_bot_ready)}`,
    `ready_gate.blocked_by: ${summary.ready_gate.blocked_by.join(", ") || "none"}`,
    "startup_plan:",
    ...summary.startup_plan.map(
      (step) =>
        `  ${step.order}. ${step.name} -> ${step.subsystem} [readiness=${step.readiness ?? "n/a"}] ${step.description}`,
    ),
    "shutdown_plan:",
    ...summary.shutdown_plan.map(
      (step) =>
        `  ${step.order}. ${step.name} -> ${step.subsystem} [readiness=${step.readiness ?? "n/a"}] ${step.description}`,
    ),
    `io_boundary.mode: ${summary.io_boundary.mode}`,
    `io_boundary.connects_real_io: ${String(summary.io_boundary.connects_real_io)}`,
    `io_boundary.pending_targets: ${summary.io_boundary.pending_targets.join(", ")}`,
    `io_boundary.note: ${summary.io_boundary.note}`,
  ];

  return lines.join("\n");
}

/** 执行可注入输出端的最小启动入口。 */
export function runAppEntrypoint<TBotId extends string>(input: {
  bootstrap: AppBootstrapContract<TBotId>;
  write?: (message: string) => void;
}): AppStartupSummary<TBotId> {
  const summary = createAppStartupSummary(input.bootstrap);

  input.write?.(renderAppStartupSummary(summary));

  return summary;
}
