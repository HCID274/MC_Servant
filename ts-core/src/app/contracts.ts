/** 应用装配层声明的子系统清单。 */
export const APP_SUBSYSTEM_NAMES = [
  "config",
  "diagnostics",
  "sandbox",
  "redis",
  "postgres",
  "runtime",
  "workers",
  "realtime",
  "http",
] as const;

/** 应用装配层子系统联合类型。 */
export type AppSubsystemName = (typeof APP_SUBSYSTEM_NAMES)[number];

/** 应用装配层就绪状态清单。 */
export const APP_READINESS_STATES = ["ready", "planned"] as const;

/** 应用装配层就绪状态联合类型。 */
export type AppReadinessState = (typeof APP_READINESS_STATES)[number];

/** 应用装配层生命周期阶段清单。 */
export const APP_LIFECYCLE_PHASES = ["startup", "shutdown"] as const;

/** 应用装配层生命周期阶段联合类型。 */
export type AppLifecyclePhase = (typeof APP_LIFECYCLE_PHASES)[number];

/** 启动序列步骤名清单。 */
export const APP_STARTUP_STEP_NAMES = [
  "load_config",
  "prepare_diagnostics",
  "prepare_sandbox",
  "prepare_redis",
  "prepare_postgres",
  "prepare_runtime",
  "start_workers",
  "start_realtime",
  "start_http",
  "emit_bot_ready",
] as const;

/** 启动序列步骤名联合类型。 */
export type AppStartupStepName = (typeof APP_STARTUP_STEP_NAMES)[number];

/** 关闭序列步骤名清单。 */
export const APP_SHUTDOWN_STEP_NAMES = [
  "interrupt_runtime",
  "transition_runtime_shutdown",
  "stop_workers",
  "stop_http",
  "stop_realtime",
  "disconnect_runtime_transport",
  "release_redis",
  "release_postgres",
] as const;

/** 关闭序列步骤名联合类型。 */
export type AppShutdownStepName = (typeof APP_SHUTDOWN_STEP_NAMES)[number];

/** 生命周期步骤名联合类型。 */
export type AppLifecycleStepName = AppStartupStepName | AppShutdownStepName;

/** 单个生命周期步骤结构。 */
export interface AppLifecycleStep<TName extends AppLifecycleStepName = AppLifecycleStepName> {
  /** 步骤名。 */
  readonly name: TName;
  /** 所属阶段。 */
  readonly phase: AppLifecyclePhase;
  /** 对应子系统。 */
  readonly subsystem: AppSubsystemName;
  /** 必须先完成的前置步骤。 */
  readonly depends_on: readonly AppLifecycleStepName[];
  /** 步骤说明。 */
  readonly description: string;
}

/** 应用装配层生命周期计划。 */
export interface AppLifecyclePlan {
  /** 启动序列。 */
  readonly startup: readonly AppLifecycleStep<AppStartupStepName>[];
  /** 关闭序列。 */
  readonly shutdown: readonly AppLifecycleStep<AppShutdownStepName>[];
}

/** 应用装配层的子系统依赖 / 就绪描述。 */
export interface AppReadinessDescriptor {
  /** 子系统名。 */
  readonly subsystem: AppSubsystemName;
  /** 就绪状态。 */
  readonly readiness: AppReadinessState;
  /** 依赖的上游子系统。 */
  readonly dependencies: readonly AppSubsystemName[];
  /** 就绪判定说明。 */
  readonly ready_when: string;
}

/**
 * 创建一个不可变的生命周期步骤对象。
 *
 * 1. 标准化：统一生命周期（启动/关闭）中各独立原子操作的元数据格式。
 * 2. 不可变性：通过 Object.freeze 确保生命周期定义在运行时不会被篡改。
 *
 * @param input 步骤配置项
 * @returns 冻结后的生命周期步骤
 */
function createLifecycleStep<TName extends AppLifecycleStepName>(input: {
  name: TName;
  phase: AppLifecyclePhase;
  subsystem: AppSubsystemName;
  dependsOn?: readonly AppLifecycleStepName[];
  description: string;
}): AppLifecycleStep<TName> {
  return Object.freeze({
    name: input.name,
    phase: input.phase,
    subsystem: input.subsystem,
    depends_on: Object.freeze([...(input.dependsOn ?? [])]),
    description: input.description,
  });
}

/**
 * 校验生命周期阶段内的步骤顺序是否合法。
 *
 * 1. 拓扑正确性：验证生命周期步骤数组的物理顺序是否满足 depends_on 声明的依赖关系。
 * 2. 边界保护：确保 startup 阶段不包含 shutdown 步骤，反之亦然。
 * 3. 早期发现：在应用引导（Bootstrap）阶段就拦截潜在的配置错误。
 *
 * @param steps 生命周期步骤列表
 * @param phase 目标生命周期阶段
 */
function assertLifecyclePhaseOrder(
  steps: readonly AppLifecycleStep[],
  phase: AppLifecyclePhase,
): void {
  const stepIndex = new Map<AppLifecycleStepName, number>();

  steps.forEach((step, index) => {
    if (step.phase !== phase) {
      throw new Error(`Lifecycle step ${step.name} must stay inside phase ${phase}`);
    }

    stepIndex.set(step.name, index);
  });

  for (const step of steps) {
    for (const dependency of step.depends_on) {
      const dependencyIndex = stepIndex.get(dependency);
      const currentStepIndex = stepIndex.get(step.name);

      if (dependencyIndex === undefined) {
        throw new Error(`Lifecycle step ${step.name} depends on missing step ${dependency}`);
      }

      if (currentStepIndex === undefined) {
        throw new Error(`Lifecycle step ${step.name} must be present in phase ${phase}`);
      }

      if (dependencyIndex >= currentStepIndex) {
        throw new Error(`Lifecycle step ${step.name} must be ordered after ${dependency}`);
      }
    }
  }
}

/**
 * 校验完整的应用生命周期计划顺序。
 *
 * 全局守卫：确保整个系统的启动和关闭序列在逻辑上是自洽且安全的。
 */
export function assertAppLifecyclePlan(plan: AppLifecyclePlan): void {
  assertLifecyclePhaseOrder(plan.startup, "startup");
  assertLifecyclePhaseOrder(plan.shutdown, "shutdown");
}

/**
 * 创建默认的应用装配层生命周期计划。
 *
 * 1. 序列定义：硬编码系统启动（从加载配置到广播 Bot Ready）和关闭（从中断运行到释放数据库连接）的标准顺序。
 * 2. 依赖声明：显式指定各步骤间的前置约束（如必须先 prepare_redis 才能 start_workers）。
 * 3. 提供系统的“启动蓝图”，使复杂的初始化过程变得透明且可预测。
 */
export function createAppLifecyclePlan(): AppLifecyclePlan {
  const startup = Object.freeze([
    createLifecycleStep({
      name: "load_config",
      phase: "startup",
      subsystem: "config",
      description: "加载环境变量与 Bot 级覆盖配置。",
    }),
    createLifecycleStep({
      name: "prepare_diagnostics",
      phase: "startup",
      subsystem: "diagnostics",
      dependsOn: ["load_config"],
      description: "准备 JSONL（结构化日志） 目录与保留期策略描述。",
    }),
    createLifecycleStep({
      name: "prepare_sandbox",
      phase: "startup",
      subsystem: "sandbox",
      dependsOn: ["load_config"],
      description: "准备 Facade API（门面接口） 与资源限制契约。",
    }),
    createLifecycleStep({
      name: "prepare_redis",
      phase: "startup",
      subsystem: "redis",
      dependsOn: ["load_config"],
      description: "准备 Redis（缓存） 键目录与队列命名描述。",
    }),
    createLifecycleStep({
      name: "prepare_postgres",
      phase: "startup",
      subsystem: "postgres",
      dependsOn: ["load_config"],
      description: "准备 PostgreSQL（关系型数据库） 连接与 migration（迁移） 描述。",
    }),
    createLifecycleStep({
      name: "prepare_runtime",
      phase: "startup",
      subsystem: "runtime",
      dependsOn: ["prepare_diagnostics", "prepare_sandbox", "prepare_redis", "prepare_postgres"],
      description: "创建运行时初始状态、外部认证装配结果与 BotActor（机器人执行代理） 骨架入口。",
    }),
    createLifecycleStep({
      name: "start_workers",
      phase: "startup",
      subsystem: "workers",
      dependsOn: ["prepare_runtime", "prepare_redis"],
      description: "装配 ConversationWorker / BotWorker / BrainWorker 的单进程入口。",
    }),
    createLifecycleStep({
      name: "start_realtime",
      phase: "startup",
      subsystem: "realtime",
      dependsOn: ["prepare_runtime", "start_workers"],
      description: "在运行时完成连接与外部认证、进入 IDLE（空闲） 后开放实时推送边界。",
    }),
    createLifecycleStep({
      name: "start_http",
      phase: "startup",
      subsystem: "http",
      dependsOn: ["prepare_runtime", "start_realtime"],
      description: "在实时推送之后开放 HTTP（超文本传输协议） 健康与消息入口。",
    }),
    createLifecycleStep({
      name: "emit_bot_ready",
      phase: "startup",
      subsystem: "runtime",
      dependsOn: ["start_http"],
      description: "广播 bot.ready 事件并宣告系统进入可服务状态。",
    }),
  ] as const);

  const shutdown = Object.freeze([
    createLifecycleStep({
      name: "interrupt_runtime",
      phase: "shutdown",
      subsystem: "runtime",
      description: "先向运行时发送 system/shutdown 中断信号。",
    }),
    createLifecycleStep({
      name: "transition_runtime_shutdown",
      phase: "shutdown",
      subsystem: "runtime",
      dependsOn: ["interrupt_runtime"],
      description: "等待中断完成后把运行时切换到 SHUTDOWN（关闭） 状态。",
    }),
    createLifecycleStep({
      name: "stop_http",
      phase: "shutdown",
      subsystem: "http",
      dependsOn: ["transition_runtime_shutdown"],
      description: "先停止 HTTP（超文本传输协议） 新请求进入。",
    }),
    createLifecycleStep({
      name: "stop_workers",
      phase: "shutdown",
      subsystem: "workers",
      dependsOn: ["stop_http"],
      description: "在停止新请求后，再停止三个 Worker（工作线程） 接收新任务。",
    }),
    createLifecycleStep({
      name: "stop_realtime",
      phase: "shutdown",
      subsystem: "realtime",
      dependsOn: ["stop_workers"],
      description: "广播 bot.offline 后关闭实时推送连接。",
    }),
    createLifecycleStep({
      name: "disconnect_runtime_transport",
      phase: "shutdown",
      subsystem: "runtime",
      dependsOn: ["stop_realtime"],
      description: "释放 Mineflayer（Minecraft 协议客户端） 一侧的运行时传输占位。",
    }),
    createLifecycleStep({
      name: "release_redis",
      phase: "shutdown",
      subsystem: "redis",
      dependsOn: ["disconnect_runtime_transport"],
      description: "最后阶段回收 Redis（缓存） 连接描述。",
    }),
    createLifecycleStep({
      name: "release_postgres",
      phase: "shutdown",
      subsystem: "postgres",
      dependsOn: ["release_redis"],
      description: "回收 PostgreSQL（关系型数据库） 连接池描述。",
    }),
  ] as const);

  const plan = Object.freeze({
    startup,
    shutdown,
  } satisfies AppLifecyclePlan);

  assertAppLifecyclePlan(plan);

  return plan;
}

/**
 * 创建应用装配层的就绪 / 依赖目录。
 *
 * 1. 依赖可视化：以声明式的方式展示各子系统间的依赖拓扑。
 * 2. 状态定义：明确每个子系统进入“就绪”状态的具体判定标准。
 */
export function createAppReadinessCatalog(): readonly AppReadinessDescriptor[] {
  return Object.freeze([
    Object.freeze({
      subsystem: "config",
      readiness: "ready",
      dependencies: [] as const,
      ready_when: "已解析环境变量与 Bot 级覆盖配置。",
    }),
    Object.freeze({
      subsystem: "diagnostics",
      readiness: "ready",
      dependencies: ["config"] as const,
      ready_when: "日志目录策略与保留期契约已装配完成。",
    }),
    Object.freeze({
      subsystem: "sandbox",
      readiness: "ready",
      dependencies: ["config"] as const,
      ready_when: "Facade API（门面接口） 与资源限制已固定。",
    }),
    Object.freeze({
      subsystem: "redis",
      readiness: "ready",
      dependencies: ["config"] as const,
      ready_when: "键目录与队列命名描述已生成。",
    }),
    Object.freeze({
      subsystem: "postgres",
      readiness: "ready",
      dependencies: ["config"] as const,
      ready_when: "连接池、schema 与 migration（迁移） 描述已生成。",
    }),
    Object.freeze({
      subsystem: "runtime",
      readiness: "ready",
      dependencies: ["diagnostics", "sandbox", "redis", "postgres"] as const,
      ready_when:
        "BotActor（机器人执行代理） 初始状态为 INITIALIZING（初始化），且外部认证装配结果与中断模板已固定。",
    }),
    Object.freeze({
      subsystem: "workers",
      readiness: "ready",
      dependencies: ["runtime", "redis"] as const,
      ready_when: "三队列目录与单进程 Worker（工作线程） 入口已收口。",
    }),
    Object.freeze({
      subsystem: "realtime",
      readiness: "planned",
      dependencies: ["runtime", "workers"] as const,
      ready_when: "运行时完成连接与外部认证、进入 IDLE（空闲） 后才允许打开实时推送。",
    }),
    Object.freeze({
      subsystem: "http",
      readiness: "planned",
      dependencies: ["runtime", "workers", "realtime"] as const,
      ready_when: "实时推送准备完成后才允许开放 HTTP（超文本传输协议） 服务。",
    }),
  ] satisfies readonly AppReadinessDescriptor[]);
}
