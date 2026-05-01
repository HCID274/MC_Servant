/**
 * 应用执行入口与启动摘要渲染。
 *
 * 1. 启动摘要构建：将复杂的引导契约（Bootstrap Contract）转换为易于理解和测试的启动摘要（Startup Summary）。
 * 2. IO 边界定义：显式声明当前入口是否涉及真实 IO 连接，起到安全隔离的作用。
 * 3. 结果渲染：提供标准的文本渲染逻辑，用于在控制台或日志中输出系统的启动状态和计划。
 * 4. 入口点触发：提供最小化的应用启动入口，支持注入不同的输出端。
 */

import {
  type ConversationLlmClient,
  type ConversationLlmDependencies,
  type ConversationLlmDiagnosticRecord,
  createConversationLlmClient,
  createConversationLlmConfig,
  createMessageTriage,
} from "../conversation/index.js";
import type { RuntimeEventType } from "../core-ports/events.js";
import { createBotActorStateProjection } from "../core-ports/index.js";
import { type LlmDiagnosticSummary, createLlmDiagnosticSummary } from "../diagnostics/index.js";
import {
  type InterfaceBotStatusSnapshot,
  type RealtimeEventEnvelope,
  type ServerBridgeEventEnvelope,
  type ServerBridgePlayerMessageFrame,
  type ServerBridgeWsRouteOptions,
  createInterfaceBotStatusSnapshot,
  createRealtimeEventEnvelope,
  registerServerBridgeWsRoute,
} from "../interfaces/index.js";
import { createConversationWorkerTask } from "../workers/contracts.js";
import {
  type BotWorkerAction,
  type BotWorkerRuntime,
  type BotWorkerRuntimeDependencies,
  type ConversationWorkerRuntime,
  type ConversationWorkerRuntimeDependencies,
  createBotWorkerRuntime,
  createConversationWorkerRuntime,
} from "../workers/index.js";
import { createResourceIndex } from "../world-model/index.js";
import type { ResourceIndexBoundary } from "../world-model/index.js";
import {
  type AppBootstrapContract,
  type AppExternalAuthInitialConfig,
  type AppProcessRuntimeDependencies,
  type AppRuntimeCoreResources,
  type AppRuntimeResources,
  type AppRuntimeServices,
  createAppRuntimeCoreResources,
  createAppRuntimeResources,
  createAppRuntimeServices,
} from "./bootstrap.js";
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
  /** 外部认证初始配置；运行期真实状态从 BotActor（机器人执行代理） 快照读取。 */
  readonly external_auth_initial_config: AppExternalAuthInitialConfig;
  /** 当前 ready（就绪） 门控结果。 */
  readonly ready_gate: AppBootstrapContract<TBotId>["runtime"]["ready_gate"];
  /** 启动序列摘要。 */
  readonly startup_plan: readonly AppEntrypointStepSummary[];
  /** 关闭序列摘要。 */
  readonly shutdown_plan: readonly AppEntrypointStepSummary[];
  /** 当前入口的 IO 边界说明。 */
  readonly io_boundary: AppEntrypointIoBoundarySummary;
}

/** 真实在线启动入口依赖注入集合。 */
export interface AppOnlineLlmDependencies extends ConversationLlmDependencies {
  /** 运行时注入的接口密钥。 */
  readonly api_key?: string;
}

/** 真实在线启动入口依赖注入集合。 */
export interface AppOnlineEntrypointDependencies extends AppProcessRuntimeDependencies {
  /** ConversationWorker（对话工作线程） 依赖注入。 */
  readonly conversationWorker?: Partial<ConversationWorkerRuntimeDependencies>;
  /** BotWorker（机器人工作线程） 依赖注入。 */
  readonly botWorker?: Omit<BotWorkerRuntimeDependencies, "actor">;
  /** LLM（大语言模型） 依赖注入。 */
  readonly llm?: AppOnlineLlmDependencies;
  /** Server Bridge（服务端桥接） WebSocket 接收端配置。 */
  readonly serverBridge?: AppServerBridgeDependencies;
}

/** Server Bridge（服务端桥接） WebSocket 接收端可注入配置。 */
export interface AppServerBridgeDependencies {
  /** 是否启用接收端；默认按 accessToken 是否提供决定。 */
  readonly enabled?: boolean;
  /** 期望的 access token；与 mod 端 Authorization Bearer 必须完全一致。 */
  readonly accessToken: string;
  /** 是否把 player_message（玩家消息） 显式接入 conversation（对话）队列。 */
  readonly conversationEnabled?: boolean;
  /** 监听路径；默认 /ws/server-bridge。 */
  readonly path?: string;
  /** 时钟覆盖。 */
  readonly now?: ServerBridgeWsRouteOptions["now"];
  /** 事件 id 工厂覆盖。 */
  readonly eventIdFactory?: ServerBridgeWsRouteOptions["eventIdFactory"];
  /** 解析失败回调（仅诊断用）。 */
  readonly onParseFailure?: ServerBridgeWsRouteOptions["onParseFailure"];
  /** 心跳超时毫秒数；默认由 server-bridge（服务端桥接）路由使用 90 秒。 */
  readonly heartbeatTimeoutMs?: ServerBridgeWsRouteOptions["heartbeatTimeoutMs"];
}

/** 真实在线启动入口运行中资源。 */
export interface AppOnlineRuntime<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** HTTP（超文本传输协议） 监听地址。 */
  readonly listen_address: string;
  /** 基础设施资源。 */
  readonly infrastructure: AppRuntimeResources<TBotId>;
  /** 服务层资源。 */
  readonly services: AppRuntimeServices<TBotId>;
  /** 运行时核心资源。 */
  readonly runtime: AppRuntimeCoreResources<TBotId>;
  /** ConversationWorker（对话工作线程） 运行时。 */
  readonly conversation_worker: ConversationWorkerRuntime;
  /** BotWorker（机器人工作线程） 运行时。 */
  readonly bot_worker: BotWorkerRuntime;
  /** 按真实在线关闭顺序回收资源。 */
  close(): Promise<void>;
}

/**
 * 创建子系统就绪状态索引。
 *
 * 快速检索：将列表形式的就绪目录转换为 Map 结构，优化摘要生成过程中的查询效率。
 */
function createReadinessIndex(
  readinessCatalog: readonly AppReadinessDescriptor[],
): ReadonlyMap<AppSubsystemName, AppReadinessState> {
  return new Map(
    readinessCatalog.map((descriptor) => [descriptor.subsystem, descriptor.readiness]),
  );
}

/**
 * 创建单个生命周期步骤的摘要视图。
 *
 * 1. 信息聚合：将静态步骤定义与运行时的子系统就绪状态合并。
 * 2. 格式化：为 UI/日志渲染提供统一的步骤模型（包含序号和依赖摘要）。
 */
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

/**
 * 根据纯装配结果构造可测试的启动摘要。
 *
 * 架构设计：
 * 1. 扁平化：将深层嵌套的引导信息提取为顶层的摘要字段。
 * 2. 状态映射：将子系统的就绪状态与生命周期步骤关联，便于诊断启动依赖。
 * 3. IO 标记：明确标识当前环境为 bootstrap_only，不触碰真实基础设施。
 *
 * @param bootstrap 引导契约
 * @returns 启动摘要
 */
export function createAppStartupSummary<TBotId extends string>(
  bootstrap: AppBootstrapContract<TBotId>,
): AppStartupSummary<TBotId> {
  const readinessIndex = createReadinessIndex(bootstrap.readiness);

  return Object.freeze({
    bot_id: bootstrap.bot_id,
    initial_status: bootstrap.runtime.initial_status,
    external_auth_initial_config: bootstrap.auth,
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

/**
 * 把启动摘要渲染为可直接输出到控制台的文本。
 *
 * 架构设计：
 * 该函数负责将结构化的摘要数据转化为人类可读的列表，包括：
 * 1. 基础元信息（Bot ID, 状态）。
 * 2. 认证状态与秘密注入情况。
 * 3. 就绪门控（Ready Gate）的详细阻塞原因。
 * 4. 完整的启动与关闭计划序列。
 *
 * @param summary 启动摘要
 * @returns 渲染后的字符串
 */
export function renderAppStartupSummary<TBotId extends string>(
  summary: AppStartupSummary<TBotId>,
): string {
  const lines = [
    "TS Core bootstrap summary",
    `bot_id: ${summary.bot_id}`,
    `initial_status: ${summary.initial_status}`,
    `external_auth_initial_config.status: ${summary.external_auth_initial_config.state.status}`,
    `external_auth_initial_config.entrypoint: ${summary.external_auth_initial_config.entrypoint}`,
    `external_auth_initial_config.secret_injected: ${String(summary.external_auth_initial_config.secret_injected)}`,
    ...(summary.external_auth_initial_config.state.action_summary
      ? [
          `external_auth_initial_config.command_preview: ${summary.external_auth_initial_config.state.action_summary.command_preview}`,
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

/**
 * 执行可注入输出端的最小启动入口。
 *
 * 架构设计：
 * 这是应用在 process.main 之后的第一个逻辑入口，它解耦了“生成摘要”与“如何输出摘要”，
 * 允许在测试环境或不同的宿主环境中灵活替换 write 回调。
 *
 * @param input 包含引导契约和输出回调的输入
 * @returns 启动摘要
 */
export function runAppEntrypoint<TBotId extends string>(input: {
  bootstrap: AppBootstrapContract<TBotId>;
  write?: (message: string) => void;
}): AppStartupSummary<TBotId> {
  const summary = createAppStartupSummary(input.bootstrap);

  input.write?.(renderAppStartupSummary(summary));

  return summary;
}

/**
 * 启动真实在线单进程运行时。
 *
 * 1. 级联拉起：按照 基础设施 -> 服务 -> 核心运行时 -> 工作线程 的顺序完整初始化应用。
 * 2. 工作线程装配：手动连接 Worker 与 BotActor 之间的生产者/消费者闭环。
 * 3. 结果暴露：向外部返回包含所有活跃资源句柄和 HTTP 监听地址的运行中对象。
 * 4. 作为应用在生产环境下的真实执行入口，封装复杂的异步拓扑启动逻辑。
 * 5. 启动顺序刻意保持为：关系型数据库/缓存 -> 任务队列 -> 接口网关 listen -> 协议传输层 -> 离线服认证登录 -> 执行代理 -> 工作线程。
 */
export async function startAppOnlineRuntime<TBotId extends string>(input: {
  /** 应用装配契约。 */
  readonly bootstrap: AppBootstrapContract<TBotId>;
  /** 可注入依赖。 */
  readonly dependencies?: AppOnlineEntrypointDependencies;
  /** 日志写入端。 */
  readonly write?: (message: string) => void;
}): Promise<AppOnlineRuntime<TBotId>> {
  let infrastructure: AppRuntimeResources<TBotId> | undefined;
  let services: AppRuntimeServices<TBotId> | undefined;
  let runtime: AppRuntimeCoreResources<TBotId> | undefined;
  let botWorker: BotWorkerRuntime | undefined;
  let conversationWorker: ConversationWorkerRuntime | undefined;
  let latestLlmDiagnostic: LlmDiagnosticSummary | null = null;
  const replayStore = createOnlineEventReplayStore(input.bootstrap.bot_id);
  const userAppendRealtimeEvent = input.dependencies?.services?.appendRealtimeEvent;
  const appendOnlineRealtimeEvent = async (
    event: Omit<RealtimeEventEnvelope, "seq">,
  ): Promise<void> => {
    replayStore.append(event);
    await userAppendRealtimeEvent?.(event);
  };
  const onlineLlmClient = createOnlineConversationLlmClient(
    input.bootstrap,
    input.dependencies?.llm,
    (record) => {
      const summary = createLlmDiagnosticSummary(
        {
          stage: record.stage,
          message_id: record.message_id,
          status: record.ok ? "ok" : "error",
          model: record.model,
          log_ref: record.log_ref,
          created_at: record.created_at,
          ...(record.error_summary === undefined ? {} : { error_summary: record.error_summary }),
        },
        {
          sensitiveValues:
            input.dependencies?.llm?.api_key === undefined ? [] : [input.dependencies.llm.api_key],
        },
      );

      latestLlmDiagnostic = summary;
    },
    input.write,
  );
  const onlineTriage =
    input.dependencies?.conversationWorker?.triage ??
    createOnlineConversationTriage(onlineLlmClient);
  const llmReplyGenerator =
    input.dependencies?.conversationWorker?.replyGenerator ??
    createOnlineConversationReplyGenerator(onlineLlmClient);
  let resourceIndex: ResourceIndexBoundary | null = null;
  const onlinePlanner =
    input.dependencies?.conversationWorker?.planner ??
    createOnlineConversationPlanner(onlineLlmClient);

  try {
    infrastructure = await createAppRuntimeResources(
      input.bootstrap,
      input.dependencies?.infrastructure,
    );
    input.write?.("TS Core infrastructure ready");

    services = await createAppRuntimeServices(input.bootstrap, infrastructure, {
      ...(input.dependencies?.services ?? {}),
      statusSnapshot: () =>
        createOnlineInterfaceStatusSnapshot({
          bootstrap: input.bootstrap,
          runtime,
          botWorker,
          conversationWorker,
          latestLlmDiagnostic,
          lastEventSeq: replayStore.getLastSeq(),
        }),
      replayEvents: input.dependencies?.services?.replayEvents ?? replayStore.read,
      latestLlmDiagnostic: () => latestLlmDiagnostic,
      appendRealtimeEvent: appendOnlineRealtimeEvent,
    });
    const onlineServices = services;
    await registerOnlineServerBridgeRoute({
      server: onlineServices.http.server,
      botId: input.bootstrap.bot_id,
      dependencies: input.dependencies?.serverBridge,
      appendRealtimeEvent: appendOnlineRealtimeEvent,
      enqueueConversationTask: async ({ frame, receivedAt }) => {
        const task = createConversationWorkerTask({
          bot_id: input.bootstrap.bot_id,
          message: {
            bot_id: input.bootstrap.bot_id,
            message_id: frame.message_id,
            content: frame.content,
            intent_epoch: 0,
            snapshot_ts: parseServerBridgeTimestamp(receivedAt),
          },
        });

        const addConversationTask = onlineServices.workers.conversation.queue.add;

        if (typeof addConversationTask !== "function") {
          throw new Error("conversation queue does not support add");
        }

        await addConversationTask("conversation", task, {
          jobId: frame.message_id,
        });
        await appendOnlineRealtimeEvent({
          bot_id: input.bootstrap.bot_id,
          type: "task.accepted",
          created_at: receivedAt,
          payload: Object.freeze({
            job_id: frame.message_id,
            message_id: frame.message_id,
            epoch: task.message.intent_epoch,
            source: "server_bridge",
          }),
        });
      },
    });
    const listenAddress = await services.http.listen();
    input.write?.(`TS Core HTTP ready: ${listenAddress}`);

    runtime = await createAppRuntimeCoreResources(input.bootstrap, input.dependencies?.runtime);
    const transportSnapshot = runtime.actor.getSnapshot().transport;
    input.write?.(
      transportSnapshot.connected
        ? `TS Core Mineflayer ready: ${transportSnapshot.username}`
        : `TS Core Mineflayer unavailable: ${transportSnapshot.last_error ?? transportSnapshot.state}`,
    );
    const createdRuntime = runtime;
    resourceIndex = createResourceIndex({
      refreshPort: createdRuntime.transport,
    });
    const interruptRuntimeSink =
      input.dependencies?.conversationWorker?.interruptRuntimeSink ??
      createOnlineConversationInterruptRuntimeSink(createdRuntime.actor);
    const actorStateProjectionProvider =
      input.dependencies?.conversationWorker?.actorStateProjectionProvider ??
      createOnlineConversationActorStateProjectionProvider(createdRuntime.actor);

    botWorker = createBotWorkerRuntime({
      queue: {
        name: services.workers.bot.name,
        connection: infrastructure.redis.client,
      },
      dependencies: {
        ...(input.dependencies?.botWorker ?? {}),
        actor: createdRuntime.actor,
        actionSink: async (action) => {
          await input.dependencies?.botWorker?.actionSink?.(action);

          const realtimeEvent = createRealtimeEventFromBotWorkerAction({
            action,
            createdAt: new Date().toISOString(),
          });

          if (realtimeEvent !== null) {
            await appendOnlineRealtimeEvent(realtimeEvent);
          }
        },
      },
    });
    await botWorker.start();
    input.write?.(`TS Core BotWorker ready: ${botWorker.queue_name}`);

    conversationWorker = createConversationWorkerRuntime({
      queue: {
        name: services.workers.conversation.name,
        connection: infrastructure.redis.client,
      },
      dependencies: {
        ...(input.dependencies?.conversationWorker ?? {}),
        ...(onlineTriage === undefined ? {} : { triage: onlineTriage }),
        ...(llmReplyGenerator === undefined ? {} : { replyGenerator: llmReplyGenerator }),
        ...(onlinePlanner === undefined ? {} : { planner: onlinePlanner }),
        resourceContextProvider:
          input.dependencies?.conversationWorker?.resourceContextProvider ??
          createOnlineResourceContextProvider(() => resourceIndex),
        interruptRuntimeSink,
        actorStateProjectionProvider,
        broadcastReplySink: async (reply) => {
          await input.dependencies?.conversationWorker?.broadcastReplySink?.(reply);
          await createdRuntime.actor.broadcastReply(reply);
          await appendOnlineRealtimeEvent(
            createRealtimeEventFromConversationReply({
              botId: input.bootstrap.bot_id,
              messageId: reply.message_id,
              content: reply.content,
              createdAt: new Date().toISOString(),
            }),
          );
        },
        enqueueExecTaskSink: async ({ task, priority }) => {
          if (typeof services?.workers.bot.queue.add !== "function") {
            throw new Error("bot exec queue does not support add");
          }

          await services.workers.bot.queue.add("bot", task, {
            jobId: task.exec_job.message_id,
            priority,
          });
        },
      },
    });
    await conversationWorker.start();
    input.write?.(`TS Core ConversationWorker ready: ${conversationWorker.queue_name}`);

    const createdInfrastructure = infrastructure;
    const createdServices = services;
    const createdBotWorker = botWorker;
    const createdConversationWorker = conversationWorker;

    return Object.freeze({
      bot_id: input.bootstrap.bot_id,
      listen_address: listenAddress,
      infrastructure: createdInfrastructure,
      services: createdServices,
      runtime: createdRuntime,
      bot_worker: createdBotWorker,
      conversation_worker: createdConversationWorker,
      async close(): Promise<void> {
        await closeOnlineRuntimeInOrder({
          runtime: createdRuntime,
          botWorker: createdBotWorker,
          conversationWorker: createdConversationWorker,
          services: createdServices,
          infrastructure: createdInfrastructure,
        });
      },
    });
  } catch (error) {
    await closeOnlineRuntimeInOrder({
      runtime,
      botWorker,
      conversationWorker,
      services,
      infrastructure,
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * 为真实在线入口创建运行时中断汇点。
 *
 * 入口层只保留最小调用能力，不扩大对 BotActor（机器人执行代理） 运行时内部实现的耦合面。
 */
function createOnlineConversationInterruptRuntimeSink<TBotId extends string>(
  actor: AppRuntimeCoreResources<TBotId>["actor"],
): NonNullable<ConversationWorkerRuntimeDependencies["interruptRuntimeSink"]> {
  return async ({ signal }) => {
    const interruptActor = actor as unknown as {
      interrupt(interruptSignal: typeof signal): Promise<unknown>;
    };

    await interruptActor.interrupt(signal);
  };
}

/**
 * 为真实在线入口创建 BotActor（机器人执行代理） 只读状态投影提供器。
 *
 * 这里只读取快照并压缩为短摘要，不暴露 Mineflayer（Minecraft 协议客户端） Bot（机器人） 或中断控制器。
 */
export function createOnlineConversationActorStateProjectionProvider<TBotId extends string>(
  actor: AppRuntimeCoreResources<TBotId>["actor"],
): NonNullable<ConversationWorkerRuntimeDependencies["actorStateProjectionProvider"]> {
  return () => {
    const snapshot = actor.getSnapshot();
    const recentSkill = snapshot.skill_executions.at(-1) ?? null;
    const recentSandbox = snapshot.sandbox_executions.at(-1) ?? null;

    return createBotActorStateProjection({
      status: snapshot.status,
      ready: snapshot.ready_gate.ready,
      world_ready: snapshot.transport.world_ready,
      current_task: snapshot.current_task,
      recent_skill: recentSkill,
      recent_sandbox:
        recentSandbox === null
          ? null
          : {
              message_id: recentSandbox.message_id,
              status: recentSandbox.status,
              total_steps: recentSandbox.total_steps,
            },
    });
  };
}

/**
 * 为真实在线入口创建最小分诊器。
 *
 * 在线最短闭环仍需保留 cancel（取消） 的模板中断语义；因此这里先锁住显式取消文本，
 * 其余消息则交给真实 LLM（大语言模型） 做最小 triage（分诊）；若未启用 LLM（大语言模型），再安全回退为普通 chat（闲聊）。
 */
function createOnlineConversationTriage(
  llm: ConversationLlmClient | undefined,
): ConversationWorkerRuntimeDependencies["triage"] {
  return async ({ task }) => {
    const normalizedContent = task.message.content.trim().replaceAll(/\s+/gu, "");
    const isExplicitCancel =
      normalizedContent === "取消" ||
      normalizedContent === "停" ||
      normalizedContent === "停止" ||
      normalizedContent === "停下" ||
      normalizedContent === "停下来" ||
      normalizedContent === "先停下" ||
      normalizedContent === "先停一下";

    if (isExplicitCancel) {
      return createMessageTriage({
        intent: "cancel",
        priority: "interrupt",
        reason: "online_explicit_cancel",
      });
    }

    if (llm === undefined) {
      return createMessageTriage({
        intent: "chat",
        priority: "normal",
        reason: "online_chat_fallback",
      });
    }

    const triage = await llm.generateCompositeTriage({
      message_id: task.message.message_id,
      message: task.message.content,
      bot_summary: "online_runtime_ready",
    });

    return triage;
  };
}

/**
 * 为真实在线入口创建闲聊回复生成器。
 *
 * 只有当引导契约已显式启用 LLM 时，才会返回真实 OpenAI 兼容调用逻辑。
 */
function createOnlineConversationReplyGenerator(
  llm: ConversationLlmClient | undefined,
): ConversationWorkerRuntimeDependencies["replyGenerator"] | undefined {
  if (llm === undefined) {
    return undefined;
  }

  return async ({ task, state_context, memory_context }) =>
    llm.generateChatReply({
      message_id: task.message.message_id,
      message: task.message.content,
      ...(memory_context === undefined ? {} : { memory_context }),
      ...(state_context === undefined ? {} : { state_context }),
    });
}

/**
 * 为真实在线入口创建最小单技能 `skill_call`（技能调用） 规划器。
 *
 * 当前阶段只允许规划到 goTo（前往坐标） 或 collect（捡拾） 单个 `skill_call`（技能调用）。
 */
function createOnlineConversationPlanner(
  llm: ConversationLlmClient | undefined,
): ConversationWorkerRuntimeDependencies["planner"] | undefined {
  if (llm === undefined) {
    return undefined;
  }

  return async ({ task, route, memory_context, resource_context }) =>
    llm.generateSkillPlan({
      message_id: task.message.message_id,
      message: task.message.content,
      snapshot_context: createOnlinePlannerSnapshotContext(resource_context),
      triage_reason: route.triage.reason,
      ...(memory_context === undefined ? {} : { memory_context }),
    });
}

/** 组装在线 planner（规划器） 的短快照上下文。 */
function createOnlinePlannerSnapshotContext(resourceContext?: string): string {
  return [
    "online_runtime: T-047A resource index ready; executable skills: goTo, collect",
    ...(resourceContext === undefined ? [] : [resourceContext]),
  ].join("; ");
}

/** 创建在线 ResourceIndex（资源索引） 摘要 provider（提供器）。 */
function createOnlineResourceContextProvider(
  readResourceIndex: () => ResourceIndexBoundary | null,
): NonNullable<ConversationWorkerRuntimeDependencies["resourceContextProvider"]> {
  return async () => {
    const resourceIndex = readResourceIndex();

    if (resourceIndex === null) {
      return undefined;
    }

    await refreshResourceIndexByRadiusLadder(resourceIndex, "tree");
    await refreshResourceIndexByRadiusLadder(resourceIndex, "ore");

    return resourceIndex.createPlannerSummary(["tree", "ore"]);
  };
}

/** 按 16 -> 32 -> 64 阶梯刷新资源索引，命中即停止。 */
async function refreshResourceIndexByRadiusLadder(
  resourceIndex: ResourceIndexBoundary,
  resourceKey: string,
): Promise<void> {
  const cached = resourceIndex.queryClusters(resourceKey, 1);

  if (cached.status === "found") {
    return;
  }

  for (const radius of [16, 32, 64] as const) {
    const refreshed = await resourceIndex.refreshAroundBot(resourceKey, radius);

    if (refreshed.status === "found" || refreshed.status === "unsupported_resource_key") {
      return;
    }
  }
}

/**
 * 为真实在线入口创建共享的 LLM（大语言模型） 客户端。
 *
 * 统一让 triage（分诊） / chat（闲聊） / plan（规划） 复用同一套 OpenAI（开放人工智能） 兼容配置。
 */
function createOnlineConversationLlmClient<TBotId extends string>(
  bootstrap: AppBootstrapContract<TBotId>,
  dependencies: AppOnlineLlmDependencies | undefined,
  onDiagnosticSummary: (record: ConversationLlmDiagnosticRecord) => void,
  write: ((message: string) => void) | undefined,
): ConversationLlmClient | undefined {
  if (!bootstrap.llm.enabled) {
    return undefined;
  }

  if (dependencies?.api_key === undefined) {
    throw new Error("LLM_API_KEY must be injected for online runtime");
  }
  const apiKey = dependencies.api_key;

  return createConversationLlmClient(
    createConversationLlmConfig({
      base_url: bootstrap.llm.base_url ?? "",
      api_key: apiKey,
      model: bootstrap.llm.model ?? "",
      bot_name: bootstrap.bot_id,
      owner_name: "主人",
      timeout_ms: 15_000,
    }),
    {
      ...dependencies,
      onDiagnostic: async (record) => {
        onDiagnosticSummary(record);
        write?.(renderLlmDiagnosticMessage(record, [apiKey]));
        await dependencies?.onDiagnostic?.(record);
      },
    },
  );
}

/**
 * 渲染最小 LLM（大语言模型） 诊断摘要。
 *
 * @param record 诊断记录
 * @returns 控制台输出文本
 */
function renderLlmDiagnosticMessage(
  record: ConversationLlmDiagnosticRecord,
  sensitiveValues: readonly string[] = [],
): string {
  const summary = createLlmDiagnosticSummary(
    {
      stage: record.stage,
      message_id: record.message_id,
      status: record.ok ? "ok" : "error",
      model: record.model,
      log_ref: record.log_ref,
      created_at: record.created_at,
      ...(record.error_summary === undefined ? {} : { error_summary: record.error_summary }),
    },
    { sensitiveValues },
  );
  const base =
    `TS Core LLM ${record.stage} ${record.ok ? "ok" : "failed"}: ` +
    `model=${record.model} message_id=${record.message_id} log_ref=${record.log_ref}`;

  return summary.error_summary === undefined ? base : `${base} error=${summary.error_summary}`;
}

/** 从 ConversationWorker（对话工作线程） 广播回复构造 replay（补拉） 事件。 */
export function createRealtimeEventFromConversationReply(input: {
  /** 目标 Bot 标识。 */
  readonly botId: string;
  /** 原始消息标识。 */
  readonly messageId: string;
  /** 回复内容。 */
  readonly content: string;
  /** 事件创建时间。 */
  readonly createdAt: string;
}): Omit<RealtimeEventEnvelope<"chat.reply">, "seq"> {
  return Object.freeze({
    bot_id: input.botId,
    type: "chat.reply",
    created_at: input.createdAt,
    payload: Object.freeze({
      message_id: input.messageId,
      content: input.content,
    }),
  });
}

/** 从 BotWorker（机器人工作线程） 动作构造 replay（补拉） 事件；摘要入队动作不会暴露为运行时事件。 */
export function createRealtimeEventFromBotWorkerAction(input: {
  /** BotWorker（机器人工作线程） 输出动作。 */
  readonly action: BotWorkerAction;
  /** 事件创建时间。 */
  readonly createdAt: string;
}): Omit<RealtimeEventEnvelope, "seq"> | null {
  if (input.action.type !== "emit_task_lifecycle") {
    return null;
  }

  return Object.freeze({
    bot_id: input.action.bot_id,
    type: input.action.lifecycle.event_type,
    created_at: input.createdAt,
    payload: input.action.lifecycle.payload as unknown as Readonly<Record<string, unknown>>,
  });
}

/**
 * 创建真实在线入口的进程内事件回放源。
 *
 * 当前阶段尚未接入 event_log（事件日志） repository（仓库 / 存储适配），因此使用注入式 append-only（只追加） 源承载手测回放。
 */
function createOnlineEventReplayStore<TBotId extends string>(
  botId: TBotId,
): {
  readonly append: (event: Omit<RealtimeEventEnvelope, "seq">) => void;
  readonly read: (request: {
    readonly bot_id: string;
    readonly after_seq: number;
    readonly limit: number;
  }) => readonly RealtimeEventEnvelope[];
  readonly getLastSeq: () => number;
} {
  let seq = 0;
  const events: RealtimeEventEnvelope[] = [];

  return Object.freeze({
    append(event): void {
      if (event.bot_id !== botId) {
        throw new Error("online replay event bot_id must match runtime bot");
      }

      seq += 1;
      events.push(
        createRealtimeEventEnvelope({
          seq,
          botId: event.bot_id,
          type: event.type,
          createdAt: event.created_at,
          ...(event.session_id === undefined ? {} : { sessionId: event.session_id }),
          ...(event.payload === undefined ? {} : { payload: event.payload }),
        }),
      );
    },
    read(request): readonly RealtimeEventEnvelope[] {
      return Object.freeze(
        events
          .filter((event) => event.bot_id === request.bot_id && event.seq > request.after_seq)
          .sort((left, right) => left.seq - right.seq)
          .slice(0, request.limit),
      );
    },
    getLastSeq(): number {
      return seq;
    },
  });
}

/**
 * 创建真实在线入口的只读状态投影。
 *
 * 该投影只读取 BotActor（机器人执行代理） 快照与本地装配状态，不暴露密钥、连接串或可写 Bot（机器人） 句柄。
 */
function createOnlineInterfaceStatusSnapshot<TBotId extends string>(input: {
  readonly bootstrap: AppBootstrapContract<TBotId>;
  readonly runtime: AppRuntimeCoreResources<TBotId> | undefined;
  readonly botWorker: BotWorkerRuntime | undefined;
  readonly conversationWorker: ConversationWorkerRuntime | undefined;
  readonly latestLlmDiagnostic: LlmDiagnosticSummary | null;
  readonly lastEventSeq: number;
}): InterfaceBotStatusSnapshot {
  const actorSnapshot = input.runtime?.actor.getSnapshot();
  const transportSnapshot = actorSnapshot?.transport as
    | {
        readonly connected?: boolean;
        readonly username?: string;
        readonly world_ready?: boolean;
      }
    | undefined;

  return createInterfaceBotStatusSnapshot({
    bot_id: input.bootstrap.bot_id,
    status: actorSnapshot?.status ?? input.bootstrap.runtime.initial_status,
    intent_epoch: 0,
    last_event_seq: input.lastEventSeq,
    updated_at: new Date().toISOString(),
    ...(transportSnapshot === undefined
      ? {}
      : {
          mineflayer: {
            connected: transportSnapshot.connected ?? false,
            world_ready: transportSnapshot.world_ready ?? false,
            ...(transportSnapshot.username === undefined
              ? {}
              : { username: transportSnapshot.username }),
          },
        }),
    workers: {
      conversation: input.conversationWorker !== undefined,
      bot: input.botWorker !== undefined,
    },
    llm: input.latestLlmDiagnostic,
  });
}

/**
 * 在已创建的 Fastify 实例上挂载 Server Bridge（服务端桥接） WebSocket 接收端。
 *
 * 1. 默认按 enabled / accessToken 决定是否注册：未注入 token 等同禁用，
 *    避免开发或测试无配置时误开端点。
 * 2. 解析成功的帧走 onEvent 回调注入既有 replay（补拉） 流，事件类型固定为
 *    `server_bridge.<frame.type>`，runtime_effect 由 envelope 保持 observe_only。
 * 3. 类型断言把 server_bridge.* 收口到 RuntimeEventType；这是唯一接口边界，
 *    Phase 1 不允许这些事件进入 conversation / workers / BotActor 写路径。
 */
async function registerOnlineServerBridgeRoute<TBotId extends string>(input: {
  readonly server: AppRuntimeServices<TBotId>["http"]["server"];
  readonly botId: TBotId;
  readonly dependencies: AppServerBridgeDependencies | undefined;
  readonly appendRealtimeEvent: (event: Omit<RealtimeEventEnvelope, "seq">) => Promise<void>;
  readonly enqueueConversationTask: (input: {
    readonly frame: ServerBridgePlayerMessageFrame;
    readonly receivedAt: string;
  }) => Promise<void>;
}): Promise<void> {
  const dependencies = input.dependencies;
  if (dependencies === undefined) {
    return;
  }
  if (dependencies.enabled === false) {
    return;
  }
  if (dependencies.accessToken.length === 0) {
    return;
  }

  const baseOptions: ServerBridgeWsRouteOptions = {
    botId: input.botId,
    accessToken: dependencies.accessToken,
    ...(dependencies.path === undefined ? {} : { path: dependencies.path }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.eventIdFactory === undefined
      ? {}
      : { eventIdFactory: dependencies.eventIdFactory }),
    ...(dependencies.onParseFailure === undefined
      ? {}
      : { onParseFailure: dependencies.onParseFailure }),
    ...(dependencies.heartbeatTimeoutMs === undefined
      ? {}
      : { heartbeatTimeoutMs: dependencies.heartbeatTimeoutMs }),
    onLifecycleEvent: async ({ envelope, received_at }) => {
      await appendServerBridgeEnvelope({
        botId: input.botId,
        envelope,
        receivedAt: received_at,
        appendRealtimeEvent: input.appendRealtimeEvent,
      });
    },
    onEvent: async ({ frame, envelope, received_at }) => {
      await appendServerBridgeEnvelope({
        botId: input.botId,
        envelope,
        receivedAt: received_at,
        appendRealtimeEvent: input.appendRealtimeEvent,
      });
      if (dependencies.conversationEnabled === true && frame.type === "player_message") {
        await input.enqueueConversationTask({ frame, receivedAt: received_at });
      }
    },
  };

  await registerServerBridgeWsRoute(input.server, baseOptions);
}

/** 将 Server Bridge（服务端桥接） 接收时间转换为 Worker（工作线程） 快照时间。 */
function parseServerBridgeTimestamp(receivedAt: string): number {
  const timestamp = Date.parse(receivedAt);

  if (!Number.isFinite(timestamp)) {
    throw new Error("server-bridge received_at must be a valid timestamp");
  }

  return timestamp;
}

/** 将 Server Bridge（服务端桥接）事件统一写入在线 replay（补拉）流。 */
async function appendServerBridgeEnvelope<TBotId extends string>(input: {
  readonly botId: TBotId;
  readonly envelope: ServerBridgeEventEnvelope;
  readonly receivedAt: string;
  readonly appendRealtimeEvent: (event: Omit<RealtimeEventEnvelope, "seq">) => Promise<void>;
}): Promise<void> {
  const realtimeType = input.envelope.event_type as RuntimeEventType;
  await input.appendRealtimeEvent({
    bot_id: input.botId,
    type: realtimeType,
    created_at: input.receivedAt,
    payload: {
      runtime_effect: input.envelope.runtime_effect,
      ...(input.envelope.payload ?? {}),
    },
  });
}

/**
 * 按应用在线运行顺序关闭资源。
 *
 * 1. 优雅销毁：采用与启动顺序相反的逻辑，先停上层业务线程（Worker），再断开底层物理连接（Runtime/DB）。
 * 2. 容错处理：确保即使某一个环节关闭失败，后续环节依然能尝试清理资源。
 */
async function closeOnlineRuntimeInOrder(input: {
  runtime: AppRuntimeCoreResources | undefined;
  botWorker: BotWorkerRuntime | undefined;
  conversationWorker: ConversationWorkerRuntime | undefined;
  services: AppRuntimeServices | undefined;
  infrastructure: AppRuntimeResources | undefined;
}): Promise<void> {
  const closeErrors: unknown[] = [];

  for (const close of [
    () => input.conversationWorker?.close(),
    () => input.botWorker?.close(),
    () => input.runtime?.close(),
    () => input.services?.close(),
    () => input.infrastructure?.close(),
  ]) {
    try {
      await close();
    } catch (error) {
      closeErrors.push(error);
    }
  }

  if (closeErrors.length > 0) {
    throw closeErrors[0];
  }
}
