import type { LlmDiagnosticSummary } from "../../diagnostics/index.js";
import type {
  InterfaceBotStatusSnapshot,
  InterfaceServerRuntime,
  RealtimeEventEnvelope,
  ReplayRequest,
} from "../../interfaces/index.js";
import {
  createInterfaceServerRuntime,
  createMessageAcceptedResponse,
  matchInterfaceControlFastPath,
  createReplayResponse,
  createStatusResponse,
} from "../../interfaces/index.js";
import { createRedisIntentEpochStore } from "../../db/index.js";
import { createConversationWorkerTask, createWorkerBullmqRuntime } from "../../workers/index.js";
import type { WorkerBullmqRuntime } from "../../workers/index.js";
import { createAppDefaultInterfaceStatusSnapshot } from "./directories.js";
import type {
  AppBootstrapContract,
  AppRuntimeCoreResources,
  AppRuntimeResources,
  AppRuntimeServiceDependencies,
  AppRuntimeServices,
  AppServiceDirectory,
} from "./types.js";

/**
 * 创建服务层运行时资源。
 *
 * 1. 消息路由绑定：建立 HTTP 接口网关，并将入站消息转换为 BullMQ 异步任务。
 * 2. 队列初始化：初始化 Conversation 任务队列，实现请求的持久化削峰。
 * 3. 健康状态关联：将接口层的健康检查输出与底层 BotActor 的实时状态动态绑定。
 *
 * 1. 定义应用的“对客界面（Fronting）”，统一处理入站 IO 协议映射。
 * 2. 实现生产/消费模式的解耦，确保 HTTP 请求不会因为后端 logic 处理缓慢而超时。
 *
 * @param bootstrap 引导契约
 * @param infrastructure 已创建的基础设施资源
 * @param dependencies 可注入的服务层依赖
 * @param runtimeCore 可选运行时核心资源，用于投影当前 BotActor（机器人执行代理） 状态
 * @returns BullMQ（任务队列） 与 Fastify（接口网关） 组合运行时
 */
export async function createAppRuntimeServices<TBotId extends string>(
  bootstrap: AppBootstrapContract<TBotId>,
  infrastructure: AppRuntimeResources<TBotId>,
  dependencies: AppRuntimeServiceDependencies = {},
  runtimeCore?: AppRuntimeCoreResources<TBotId>,
): Promise<AppRuntimeServices<TBotId>> {
  const created: Partial<{
    workers: WorkerBullmqRuntime<TBotId>;
    http: InterfaceServerRuntime<TBotId>;
  }> = {};

  try {
    created.workers = createWorkerBullmqRuntime(
      {
        botId: bootstrap.bot_id,
        redis: infrastructure.redis,
      },
      dependencies.workers,
    );
    const replayEvents = dependencies.replayEvents;
    const intentEpochStore =
      dependencies.intentEpochStore ??
      createRedisIntentEpochStore({
        client: infrastructure.redis.client,
      });
    created.http = createInterfaceServerRuntime(
      {
        bot_id: bootstrap.bot_id,
        health: bootstrap.interfaces.health,
        default_status: createAppDefaultInterfaceStatusSnapshot(bootstrap, runtimeCore),
        listen: bootstrap.services.http.listen,
        handlers: {
          status: async () =>
            createStatusResponse({
              bot:
                dependencies.statusSnapshot?.() ??
                createAppDefaultInterfaceStatusSnapshot(
                  bootstrap,
                  runtimeCore,
                  dependencies.latestLlmDiagnostic?.() ?? null,
                ),
            }),
          message: async (request) => {
            const queuedAt = dependencies.now?.() ?? new Date().toISOString();
            const intentEpoch = await intentEpochStore.next(bootstrap.bot_id);
            const controlDecision = matchInterfaceControlFastPath(request.content);

            if (controlDecision !== null && dependencies.controlFastPathSink !== undefined) {
              await dependencies.controlFastPathSink({
                bot_id: request.bot_id,
                message_id: request.message_id,
                content: request.content,
                intent_epoch: intentEpoch,
                received_at: queuedAt,
                decision: controlDecision,
              });

              return createMessageAcceptedResponse({
                botId: request.bot_id,
                jobId: request.message_id,
                messageId: request.message_id,
                queuedAt,
              });
            }

            if (typeof created.workers?.conversation.queue.add !== "function") {
              throw new Error("conversation queue does not support add");
            }

            const task = createConversationWorkerTask({
              bot_id: bootstrap.bot_id,
              message: {
                bot_id: request.bot_id,
                message_id: request.message_id,
                content: request.content,
                intent_epoch: intentEpoch,
                snapshot_ts: Date.parse(queuedAt),
              },
            });
            const job = await created.workers.conversation.queue.add("conversation", task, {
              jobId: request.message_id,
            });

            const acceptedResponse = createMessageAcceptedResponse({
              botId: request.bot_id,
              jobId: String(job.id ?? request.message_id),
              messageId: request.message_id,
              queuedAt,
            });

            await dependencies.appendRealtimeEvent?.({
              bot_id: request.bot_id,
              type: "task.accepted",
              created_at: queuedAt,
              payload: {
                job_id: acceptedResponse.job_id,
                message_id: request.message_id,
                epoch: task.message.intent_epoch,
              },
            });

            return acceptedResponse;
          },
          ...(replayEvents === undefined
            ? {}
            : {
                replay: async (request) =>
                  createReplayResponse({
                    request,
                    state:
                      dependencies.statusSnapshot?.() ??
                      createAppDefaultInterfaceStatusSnapshot(
                        bootstrap,
                        runtimeCore,
                        dependencies.latestLlmDiagnostic?.() ?? null,
                      ),
                    events: await replayEvents(request),
                  }),
              }),
        },
      },
      dependencies.http,
    );
    const workers = created.workers;
    const http = created.http;

    if (workers === undefined || http === undefined) {
      throw new Error("app runtime services require workers and http");
    }

    return Object.freeze({
      bot_id: bootstrap.bot_id,
      infrastructure,
      directory: bootstrap.services,
      workers,
      http,
      async close(): Promise<void> {
        await closeAppRuntimeServices({
          directory: bootstrap.services,
          workers,
          http,
        });
      },
    });
  } catch (error) {
    await closeAppRuntimeServices({
      directory: bootstrap.services,
      ...(created.workers === undefined ? {} : { workers: created.workers }),
      ...(created.http === undefined ? {} : { http: created.http }),
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * 按服务层约定顺序关闭 Fastify（接口网关） 与 BullMQ（任务队列）。
 *
 * 1. 先关闭入站流量（HTTP Server），再停止处理逻辑（Workers），确保进行中的任务有机会完成（Drain）。
 * 2. 统一错误汇总清理，防止残留的监听器导致进程无法正常退出。
 *
 * @param input 服务资源与目录信息
 */
export async function closeAppRuntimeServices<TBotId extends string>(input: {
  directory: AppServiceDirectory<TBotId>;
  workers?: WorkerBullmqRuntime<TBotId>;
  http?: InterfaceServerRuntime<TBotId>;
}): Promise<void> {
  const closeErrors: unknown[] = [];

  for (const resourceName of input.directory.close_order) {
    try {
      if (resourceName === "http" && input.http !== undefined) {
        await input.http.close();
      }

      if (resourceName === "workers" && input.workers !== undefined) {
        await input.workers.close();
      }
    } catch (error) {
      closeErrors.push(error);
    }
  }

  if (closeErrors.length > 0) {
    throw closeErrors[0];
  }
}
