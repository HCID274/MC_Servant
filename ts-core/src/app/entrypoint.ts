/**
 * 应用执行入口与启动摘要渲染。
 *
 * 架构职责：
 * 1. 启动摘要构建：将复杂的引导契约（Bootstrap Contract）转换为易于理解和测试的启动摘要（Startup Summary）。
 * 2. IO 边界定义：显式声明当前入口是否涉及真实 IO 连接，起到安全隔离的作用。
 * 3. 结果渲染：提供标准的文本渲染逻辑，用于在控制台或日志中输出系统的启动状态和计划。
 * 4. 入口点触发：提供最小化的应用启动入口，支持注入不同的输出端。
 */

import {
  type BotWorkerRuntime,
  type BotWorkerRuntimeDependencies,
  type ConversationWorkerRuntime,
  type ConversationWorkerRuntimeDependencies,
  createBotWorkerRuntime,
  createConversationWorkerRuntime,
} from "../workers/index.js";
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
export interface AppOnlineEntrypointDependencies extends AppProcessRuntimeDependencies {
  /** ConversationWorker（对话工作线程） 依赖注入。 */
  readonly conversationWorker?: Omit<ConversationWorkerRuntimeDependencies, "broadcastReplySink">;
  /** BotWorker（机器人工作线程） 依赖注入。 */
  readonly botWorker?: Omit<BotWorkerRuntimeDependencies, "actor">;
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
 * 启动顺序刻意保持为：PostgreSQL（关系型数据库）/ Redis（缓存） → BullMQ（任务队列）
 * → Fastify（接口网关） listen（监听） → Mineflayer（Minecraft 协议客户端）
 * → EasyAuth（离线服认证模组） 登录命令 → BotWorker（机器人工作线程）
 * → ConversationWorker（对话工作线程）。
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

  try {
    infrastructure = await createAppRuntimeResources(
      input.bootstrap,
      input.dependencies?.infrastructure,
    );
    input.write?.("TS Core infrastructure ready");

    services = await createAppRuntimeServices(
      input.bootstrap,
      infrastructure,
      input.dependencies?.services,
    );
    const listenAddress = await services.http.listen();
    input.write?.(`TS Core HTTP ready: ${listenAddress}`);

    runtime = await createAppRuntimeCoreResources(input.bootstrap, input.dependencies?.runtime);
    input.write?.(`TS Core Mineflayer ready: ${runtime.actor.getSnapshot().transport.username}`);
    const createdRuntime = runtime;

    botWorker = createBotWorkerRuntime({
      queue: {
        name: services.workers.bot.name,
        connection: infrastructure.redis.client,
      },
      dependencies: {
        ...(input.dependencies?.botWorker ?? {}),
        actor: createdRuntime.actor,
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
        broadcastReplySink: async (reply) => {
          await createdRuntime.actor.broadcastReply(reply);
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
