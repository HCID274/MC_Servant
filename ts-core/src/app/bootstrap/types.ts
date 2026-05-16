import type { DataConfig, DataConfigEnvironment } from "../../data/index.js";
import type {
  DrizzleMigrationMetadata,
  IntentEpochStore,
  PostgresConnectionDescriptor,
  PostgresRuntimeDependencies,
  PostgresRuntimeResource,
  RedisConnectionDescriptor,
  RedisKeyCatalog,
  RedisRuntimeDependencies,
  RedisRuntimeResource,
} from "../../db/index.js";
import type { LlmDiagnosticSummary, createDiagnosticsCatalog } from "../../diagnostics/index.js";
import type {
  API_ROUTE_DEFINITIONS,
  HealthResponse,
  InterfaceBotStatusSnapshot,
  InterfaceControlFastPathDecision,
  InterfaceServerDependencies,
  InterfaceServerListenOptions,
  InterfaceServerRuntime,
  RealtimeEventEnvelope,
  ReplayRequest,
} from "../../interfaces/index.js";
import type { ObservationRuntimeCache } from "../../observation/index.js";
import type { BotStatus } from "../../runtime/index.js";
import type {
  BotActorRuntime,
  ExternalAuthActionSummary,
  ExternalAuthEntrypoint,
  ExternalAuthExecutionPlan,
  ExternalAuthPublicState,
  ExternalAuthSecretBinding,
  ExternalAuthState,
  MineflayerRuntimeTransport,
  MineflayerRuntimeTransportDependencies,
  MineflayerTransportDescriptor,
  RuntimeReadyGate,
  RuntimeScaffold,
} from "../../runtime/index.js";
import type { SandboxExecutionResourceLimits } from "../../sandbox/index.js";
import type {
  WorkerBullmqDependencies,
  WorkerBullmqRuntime,
  WorkerQueueCatalog,
} from "../../workers/index.js";
import type { ResourceServiceBoundary } from "../../world-model/index.js";
import type { AppLifecyclePlan, AppReadinessDescriptor } from "../contracts.js";

/** 接口层装配结果，用于统一收口纯路由目录与健康检查基线。 */
export interface AppInterfacesContract {
  /** 纯路由定义目录。 */
  readonly routes: typeof API_ROUTE_DEFINITIONS;
  /** 健康检查输出基线。 */
  readonly health: HealthResponse;
}

/** 运行时装配结果，用于声明单 Bot（机器人） 的初始执行状态。 */
export interface AppRuntimeContract {
  /** 初始状态。 */
  readonly initial_status: BotStatus;
  /** 外部认证状态。 */
  readonly external_auth: ExternalAuthPublicState;
  /** 运行时骨架公开视图。 */
  readonly scaffold: AppRuntimeScaffoldContract;
  /** 初始 ready（就绪） 门控结果。 */
  readonly ready_gate: RuntimeReadyGate;
}

/** 应用装配层暴露的外部认证计划公开视图。 */
export type AppExternalAuthPlanContract =
  | {
      /** 对应的认证状态。 */
      readonly status: "not_required";
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
      /** 对外脱敏摘要。 */
      readonly action_summary: null;
      /** 是否允许重试。 */
      readonly retry_allowed: false;
      /** 是否已满足认证前置。 */
      readonly ready_for_idle: false;
      /** 失败原因。 */
      readonly failure_reason: "missing_injected_secret";
      /** 期望的密钥来源。 */
      readonly secret_source: "env" | "bot_config" | null;
      /** 期望的密钥引用。 */
      readonly secret_reference: string | null;
    };

/** 应用装配层暴露的运行时骨架公开视图。 */
export interface AppRuntimeScaffoldContract {
  /** 默认启动状态。 */
  readonly defaultStatus: RuntimeScaffold["defaultStatus"];
  /** 外部认证状态公开视图。 */
  readonly externalAuth: ExternalAuthPublicState;
  /** 外部认证执行计划公开视图。 */
  readonly externalAuthPlan: AppExternalAuthPlanContract;
  /** 初始就绪门控结果。 */
  readonly readyGate: RuntimeScaffold["readyGate"];
  /** 当前阶段声明支持的执行任务类型。 */
  readonly supportedTaskKinds: RuntimeScaffold["supportedTaskKinds"];
  /** 当前阶段提供的中断信号模板。 */
  readonly interruptTemplate: RuntimeScaffold["interruptTemplate"];
}

/** 应用装配层暴露的外部认证初始配置；运行期真实状态必须从 BotActor（机器人执行代理） 快照读取。 */
export interface AppExternalAuthInitialConfig {
  /** 对外暴露的脱敏初始认证状态。 */
  readonly state: ExternalAuthPublicState;
  /** 当前受控入口。 */
  readonly entrypoint: ExternalAuthEntrypoint;
  /** 明文密钥是否已完成部署注入。 */
  readonly secret_injected: boolean;
}

/** 沙箱装配结果，用于声明无真实隔离实例时的可用契约。 */
export interface AppSandboxContract {
  /** 默认资源限制。 */
  readonly resource_limits: Readonly<SandboxExecutionResourceLimits>;
}

/** 诊断装配结果，用于暴露 JSONL（结构化日志） 通道目录。 */
export interface AppDiagnosticsContract {
  /** 通道目录。 */
  readonly catalog: ReturnType<typeof createDiagnosticsCatalog>;
}

/** LLM（大语言模型） 在线调用装配结果。 */
export interface AppLlmContract {
  /** 当前是否启用真实 LLM（大语言模型） 调用。 */
  readonly enabled: boolean;
  /** 当前接入协议。 */
  readonly provider: "openai_compatible";
  /** 基础地址。 */
  readonly base_url: string | null;
  /** 模型名。 */
  readonly model: string | null;
  /** 是否允许 thinking（思考） 模式。 */
  readonly enable_thinking: boolean;
  /** reasoning effort（推理强度） 统一配置。 */
  readonly reasoning_effort: string;
  /** 强制开启 thinking（思考） 模式的模型清单。 */
  readonly force_thinking_models: readonly string[];
  /** 接口密钥是否已注入。 */
  readonly api_key_injected: boolean;
}

/** 基础设施真实 I/O（输入输出） 资源名称清单。 */
export const APP_RUNTIME_RESOURCE_NAMES = ["postgres", "redis"] as const;

/** 真实 I/O（输入输出） 资源名称联合类型。 */
export type AppRuntimeResourceName = (typeof APP_RUNTIME_RESOURCE_NAMES)[number];

/** 应用装配层暴露的真实资源目录。 */
export interface AppResourceDirectory<TBotId extends string = string> {
  /** 创建顺序。 */
  readonly create_order: readonly AppRuntimeResourceName[];
  /** 关闭顺序。 */
  readonly close_order: readonly AppRuntimeResourceName[];
  /** 失败回滚顺序，按“已创建资源的逆序”生效。 */
  readonly cleanup_on_failure: readonly AppRuntimeResourceName[];
  /** PostgreSQL（关系型数据库） 资源目录。 */
  readonly postgres: {
    /** 连接描述符。 */
    readonly descriptor: PostgresConnectionDescriptor;
    /** 迁移入口元信息。 */
    readonly migrations: DrizzleMigrationMetadata;
  };
  /** Redis（缓存） 资源目录。 */
  readonly redis: {
    /** 连接描述符。 */
    readonly descriptor: RedisConnectionDescriptor;
    /** 键目录。 */
    readonly keys: RedisKeyCatalog<TBotId>;
    /** 与后续 BullMQ（任务队列） 复用的意图说明。 */
    readonly reuse_for: "bullmq_shared_connection";
  };
}

/** 应用装配层创建出的真实资源句柄。 */
export interface AppRuntimeResources<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 资源目录快照。 */
  readonly directory: AppResourceDirectory<TBotId>;
  /** PostgreSQL（关系型数据库） 运行时资源。 */
  readonly postgres: PostgresRuntimeResource;
  /** Redis（缓存） 运行时资源。 */
  readonly redis: RedisRuntimeResource;
  /** 按约定顺序关闭已创建资源。 */
  close(): Promise<void>;
}

/** 运行时核心真实资源名称清单。 */
export const APP_RUNTIME_CORE_RESOURCE_NAMES = [
  "observation",
  "mineflayer_transport",
  "bot_actor",
] as const;

/** 运行时核心真实资源名称联合类型。 */
export type AppRuntimeCoreResourceName = (typeof APP_RUNTIME_CORE_RESOURCE_NAMES)[number];

/** 应用装配层暴露的运行时核心资源目录。 */
export interface AppRuntimeCoreDirectory<TBotId extends string = string> {
  /** 创建顺序。 */
  readonly create_order: readonly AppRuntimeCoreResourceName[];
  /** 关闭顺序。 */
  readonly close_order: readonly AppRuntimeCoreResourceName[];
  /** 失败回滚顺序。 */
  readonly cleanup_on_failure: readonly AppRuntimeCoreResourceName[];
  /** observation（观测） 事件驱动缓存目录。 */
  readonly observation: {
    /** 缓存策略。 */
    readonly mode: "event_driven_cache";
    /** 上游数据源。 */
    readonly source: "mineflayer_events";
  };
  /** Mineflayer（Minecraft 协议客户端） 运行时传输目录。 */
  readonly mineflayer_transport: {
    /** 连接描述符。 */
    readonly descriptor: MineflayerTransportDescriptor<TBotId>;
  };
  /** BotActor（机器人执行代理） 运行时目录。 */
  readonly bot_actor: {
    /** 初始状态。 */
    readonly initial_status: BotStatus;
    /** 初始 ready（就绪） 门控。 */
    readonly ready_gate: RuntimeReadyGate;
  };
}

/** 运行时核心真实资源工厂依赖。 */
export interface AppRuntimeCoreResourceDependencies {
  /** Mineflayer（Minecraft 协议客户端） 运行时传输依赖注入。 */
  readonly transport?: MineflayerRuntimeTransportDependencies;
  /** pending（待执行） 外部认证需要的一次性明文密钥绑定。 */
  readonly externalAuthSecret?: ExternalAuthSecretBinding;
  /** 可选的外部认证执行计划覆盖。 */
  readonly externalAuthPlan?: ExternalAuthExecutionPlan;
}

/** 应用装配层创建出的运行时核心资源句柄。 */
export interface AppRuntimeCoreResources<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 运行时核心资源目录。 */
  readonly directory: AppRuntimeCoreDirectory<TBotId>;
  /** observation（观测） 事件驱动缓存。 */
  readonly observation: ObservationRuntimeCache;
  /** Mineflayer（Minecraft 协议客户端） 运行时传输。 */
  readonly transport: MineflayerRuntimeTransport<TBotId>;
  /** ResourceService（资源服务） 当前运行时共享实例。 */
  readonly resourceService: ResourceServiceBoundary;
  /** BotActor（机器人执行代理） 最小运行时。 */
  readonly actor: BotActorRuntime<TBotId>;
  /** 按约定顺序关闭运行时核心资源。 */
  close(): Promise<void>;
}

/** 真实资源工厂的可注入依赖。 */
export interface AppRuntimeResourceDependencies {
  /** PostgreSQL（关系型数据库） 工厂注入。 */
  readonly postgres?: PostgresRuntimeDependencies;
  /** Redis（缓存） 工厂注入。 */
  readonly redis?: RedisRuntimeDependencies;
}

/** 服务层真实资源名称清单。 */
export const APP_SERVICE_RESOURCE_NAMES = ["workers", "http"] as const;

/** 服务层真实资源名称联合类型。 */
export type AppServiceResourceName = (typeof APP_SERVICE_RESOURCE_NAMES)[number];

/** 应用装配层暴露的服务资源目录。 */
export interface AppServiceDirectory<TBotId extends string = string> {
  /** 创建顺序。 */
  readonly create_order: readonly AppServiceResourceName[];
  /** 关闭顺序。 */
  readonly close_order: readonly AppServiceResourceName[];
  /** 失败回滚顺序。 */
  readonly cleanup_on_failure: readonly AppServiceResourceName[];
  /** BullMQ（任务队列） 三队列资源目录。 */
  readonly workers: {
    /** 三队列目录。 */
    readonly catalog: WorkerQueueCatalog<TBotId>;
    /** 共享 Redis（缓存） 客户端复用说明。 */
    readonly redis_reuse: "shared_client";
  };
  /** Fastify（接口网关） 资源目录。 */
  readonly http: {
    /** 最小路由目录。 */
    readonly routes: typeof API_ROUTE_DEFINITIONS;
    /** 默认监听参数。 */
    readonly listen: InterfaceServerListenOptions;
  };
}

/** 服务层真实资源工厂依赖。 */
export interface AppRuntimeServiceDependencies {
  /** BullMQ（任务队列） 依赖注入。 */
  readonly workers?: WorkerBullmqDependencies;
  /** Fastify（接口网关） 依赖注入。 */
  readonly http?: InterfaceServerDependencies;
  /** 每条消息入队时使用的时钟；默认读取当前系统时间。 */
  readonly now?: () => string;
  /** 当前状态只读投影源。 */
  readonly statusSnapshot?: () => InterfaceBotStatusSnapshot;
  /** replay（补拉） 事件只读读取源。 */
  readonly replayEvents?: (
    request: ReplayRequest,
  ) => readonly RealtimeEventEnvelope[] | Promise<readonly RealtimeEventEnvelope[]>;
  /** 最近一次 LLM（大语言模型） 调用摘要源。 */
  readonly latestLlmDiagnostic?: () => LlmDiagnosticSummary | null;
  /** intent_epoch（意图纪元） 单调源；真实路径使用 Redis INCR（缓存自增命令）。 */
  readonly intentEpochStore?: IntentEpochStore;
  /** control fast-path（控制快路径） 命中后的副作用收口。 */
  readonly controlFastPathSink?: (input: {
    readonly bot_id: string;
    readonly message_id: string;
    readonly content: string;
    readonly intent_epoch: number;
    readonly received_at: string;
    readonly decision: InterfaceControlFastPathDecision;
  }) => void | Promise<void>;
  /** 追加运行中只读事件。 */
  readonly appendRealtimeEvent?: (
    event: Omit<RealtimeEventEnvelope, "seq">,
  ) => void | Promise<void>;
}

/** 应用装配层创建出的服务运行时句柄。 */
export interface AppRuntimeServices<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 基础设施资源句柄。 */
  readonly infrastructure: AppRuntimeResources<TBotId>;
  /** 服务资源目录。 */
  readonly directory: AppServiceDirectory<TBotId>;
  /** BullMQ（任务队列） 三队列运行时句柄。 */
  readonly workers: WorkerBullmqRuntime<TBotId>;
  /** Fastify（接口网关） 运行时句柄。 */
  readonly http: InterfaceServerRuntime<TBotId>;
  /** 按约定顺序关闭服务层资源。 */
  close(): Promise<void>;
}

/** 应用进程组合资源。 */
export interface AppProcessRuntime<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 基础设施资源句柄。 */
  readonly infrastructure: AppRuntimeResources<TBotId>;
  /** 运行时核心资源句柄。 */
  readonly runtime: AppRuntimeCoreResources<TBotId>;
  /** 服务层资源句柄。 */
  readonly services: AppRuntimeServices<TBotId>;
  /** 关闭完整进程资源。 */
  close(): Promise<void>;
}

/** 应用进程组合资源工厂依赖。 */
export interface AppProcessRuntimeDependencies {
  /** 基础设施资源依赖。 */
  readonly infrastructure?: AppRuntimeResourceDependencies;
  /** 运行时核心资源依赖。 */
  readonly runtime?: AppRuntimeCoreResourceDependencies;
  /** 服务层资源依赖。 */
  readonly services?: AppRuntimeServiceDependencies;
}

/** 应用装配输入，用于从纯配置构建单进程组合根。 */
export interface AppBootstrapInput<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly botId: TBotId;
  /** 生成健康检查基线时使用的时间戳。 */
  readonly now: string;
  /** 可选环境变量快照。 */
  readonly env?: DataConfigEnvironment;
  /** 可选 Bot 级覆盖配置。 */
  readonly botConfig?: unknown;
}

/** 应用装配结果，用于统一暴露 Phase 1（第一阶段） 的纯组合根。 */
export interface AppBootstrapContract<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 数据与基础设施配置。 */
  readonly config: DataConfig;
  /** 外部认证初始配置；不代表运行期当前认证状态。 */
  readonly auth: AppExternalAuthInitialConfig;
  /** PostgreSQL（关系型数据库） 连接描述。 */
  readonly postgres: PostgresConnectionDescriptor;
  /** Redis（缓存） 键目录。 */
  readonly redis: RedisKeyCatalog<TBotId>;
  /** 三队列目录。 */
  readonly workers: WorkerQueueCatalog<TBotId>;
  /** 运行时装配结果。 */
  readonly runtime: AppRuntimeContract;
  /** 接口层装配结果。 */
  readonly interfaces: AppInterfacesContract;
  /** 沙箱装配结果。 */
  readonly sandbox: AppSandboxContract;
  /** 诊断装配结果。 */
  readonly diagnostics: AppDiagnosticsContract;
  /** LLM（大语言模型） 装配结果。 */
  readonly llm: AppLlmContract;
  /** Drizzle migration（迁移） 元信息。 */
  readonly migrations: DrizzleMigrationMetadata;
  /** 真实资源目录。 */
  readonly resources: AppResourceDirectory<TBotId>;
  /** 运行时核心资源目录。 */
  readonly runtime_resources: AppRuntimeCoreDirectory<TBotId>;
  /** 服务层资源目录。 */
  readonly services: AppServiceDirectory<TBotId>;
  /** 启动 / 关闭生命周期计划。 */
  readonly lifecycle: AppLifecyclePlan;
  /** 子系统依赖与就绪目录。 */
  readonly readiness: readonly AppReadinessDescriptor[];
}
