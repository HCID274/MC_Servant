import type { RuntimeSandboxExecutionResult } from "../../core-ports/sandbox.js";
import { SKILL_DIRECTORY } from "../../core-ports/skills.js";
import { createSandboxLogRef } from "../../diagnostics/index.js";
import { createObservationRuntimeCache } from "../../observation/index.js";
import type { ObservationRuntimeCache } from "../../observation/index.js";
import {
  createBotActorRuntime,
  createExternalAuthExecutionPlan,
  createMineflayerRuntimeTransport,
} from "../../runtime/index.js";
import type {
  BotActorRuntime,
  MineflayerRuntimeTransport,
  RuntimeRecentEventFormatter,
  RuntimeRecentSandboxEventInput,
  RuntimeRecentSkillEventInput,
} from "../../runtime/index.js";
import { createSandboxExecutionRequest, executeSandboxCodeRequest } from "../../sandbox/index.js";
import { formatSandboxRecentEventLine } from "../../sandbox/recent-event.js";
import { formatSkillRecentEventLine } from "../../skills/recent-event.js";
import { createAppRuntimeCoreExternalAuth } from "./external-auth.js";
import type {
  AppBootstrapContract,
  AppRuntimeCoreDirectory,
  AppRuntimeCoreResourceDependencies,
  AppRuntimeCoreResources,
} from "./types.js";

/**
 * 创建运行时核心资源：observation（观测） 缓存、Mineflayer（Minecraft 协议客户端） 传输与 BotActor（机器人执行代理）。
 *
 * 1. 核心链路建立：初始化 Mineflayer 协议传输层和事件驱动的观测缓存。
 * 2. 状态机激活：创建并启动 BotActor，将其注入初始认证计划。
 * 3. 异步就绪：确保核心组件（特别是协议连接）在函数返回前已进入预期的就绪状态。
 * 4. 架构连接：构建系统的“中枢神经系统”，连接物理协议层与逻辑执行层。
 * 5. 封装启动：封装复杂的异步启动顺序，为上层提供一个原子的核心资源包。
 *
 * @param bootstrap 引导契约
 * @param dependencies 可注入的运行时核心依赖
 * @returns 已完成最小启动闭环的运行时核心资源
 */
export async function createAppRuntimeCoreResources<TBotId extends string>(
  bootstrap: AppBootstrapContract<TBotId>,
  dependencies: AppRuntimeCoreResourceDependencies = {},
): Promise<AppRuntimeCoreResources<TBotId>> {
  const created: Partial<{
    observation: ObservationRuntimeCache;
    transport: MineflayerRuntimeTransport<TBotId>;
    actor: BotActorRuntime<TBotId>;
  }> = {};

  try {
    created.observation = createObservationRuntimeCache();
    created.transport = createMineflayerRuntimeTransport(
      bootstrap.runtime_resources.mineflayer_transport.descriptor,
      dependencies.transport,
    );
    const externalAuth = createAppRuntimeCoreExternalAuth(bootstrap, dependencies);
    const externalAuthPlan =
      dependencies.externalAuthPlan ??
      createExternalAuthExecutionPlan(externalAuth, dependencies.externalAuthSecret);
    created.actor = createBotActorRuntime({
      botId: bootstrap.bot_id,
      transport: created.transport,
      observation: created.observation,
      externalAuth,
      externalAuthPlan,
      sandboxExecution: {
        createLogRef: createSandboxLogRef,
        createRequest: createSandboxExecutionRequest,
        executeRequest: (sandboxInput) =>
          executeSandboxCodeRequest({
            request: sandboxInput.request,
            facade: sandboxInput.facade,
            task: sandboxInput.task,
          }),
      },
      recentEventFormatter: createOnlineRuntimeRecentEventFormatter(),
    });
    // MC（我的世界）宿主服务不归 TS Core 生命周期管理；首连失败时保留接口与工作线程，由状态快照暴露不可用原因。
    await created.actor.start().catch(() => undefined);

    const observation = created.observation;
    const transport = created.transport;
    const actor = created.actor;

    if (observation === undefined || transport === undefined || actor === undefined) {
      throw new Error("app runtime core resources require observation, transport and actor");
    }

    return Object.freeze({
      bot_id: bootstrap.bot_id,
      directory: bootstrap.runtime_resources,
      observation,
      transport,
      actor,
      async close(): Promise<void> {
        await closeAppRuntimeCoreResources({
          directory: bootstrap.runtime_resources,
          observation,
          transport,
          actor,
        });
      },
    });
  } catch (error) {
    await closeAppRuntimeCoreResources({
      directory: bootstrap.runtime_resources,
      ...(created.observation === undefined ? {} : { observation: created.observation }),
      ...(created.transport === undefined ? {} : { transport: created.transport }),
      ...(created.actor === undefined ? {} : { actor: created.actor }),
    }).catch(() => undefined);
    throw error;
  }
}

/** 生产装配的 recent_events（最近事件） formatter（格式化器），由 app（应用） 连接实现模块与 runtime（运行时） 端口。 */
function createOnlineRuntimeRecentEventFormatter(): RuntimeRecentEventFormatter {
  return Object.freeze({
    formatSkill(input: RuntimeRecentSkillEventInput): string {
      switch (input.skill) {
        case SKILL_DIRECTORY.goTo:
          return formatSkillRecentEventLine({
            skill: SKILL_DIRECTORY.goTo,
            status: input.status,
            ...(input.result?.skill === SKILL_DIRECTORY.goTo ? { result: input.result } : {}),
            ...(input.message === undefined ? {} : { message: input.message }),
          });
        case SKILL_DIRECTORY.collect:
          return formatSkillRecentEventLine({
            skill: SKILL_DIRECTORY.collect,
            status: input.status,
            ...(input.result?.skill === SKILL_DIRECTORY.collect ? { result: input.result } : {}),
            ...(input.message === undefined ? {} : { message: input.message }),
          });
        case SKILL_DIRECTORY.mine:
        case SKILL_DIRECTORY.equip:
        case SKILL_DIRECTORY.cutTree:
          return formatUnsupportedSkillRecentEventLine(input);
        default:
          return formatUnsupportedSkillRecentEventLine(input);
      }
    },
    formatSandbox(input: RuntimeRecentSandboxEventInput): string {
      if (isRuntimeSandboxExecutionResult(input.result)) {
        return formatSandboxRecentEventLine(input.result);
      }

      return input.status === "interrupted"
        ? `sandbox 中断：${normalizeRecentEventMessage(input.message)}`
        : `sandbox 失败：${normalizeRecentEventMessage(input.message)}`;
    },
  });
}

function isRuntimeSandboxExecutionResult(value: unknown): value is RuntimeSandboxExecutionResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value.status === "completed" || value.status === "failed" || value.status === "interrupted") &&
    "summary" in value &&
    typeof value.summary === "object" &&
    value.summary !== null &&
    "total_steps" in value.summary &&
    typeof value.summary.total_steps === "number"
  );
}

function formatUnsupportedSkillRecentEventLine(input: RuntimeRecentSkillEventInput): string {
  switch (input.status) {
    case "completed":
      return `${input.skill} 成功`;
    case "failed":
      return `${input.skill} 失败：${normalizeRecentEventMessage(input.message)}`;
    case "interrupted":
      return `${input.skill} 中断：${normalizeRecentEventMessage(input.message)}`;
  }
}

function normalizeRecentEventMessage(message: string | undefined): string {
  const normalized = message?.replaceAll(/\s+/gu, " ").trim();

  return normalized === undefined || normalized.length === 0 ? "unknown" : normalized;
}

/**
 * 按应用约定关闭运行时核心资源。
 *
 * 1. 严格遵循关闭顺序（如先停状态机，再断开协议连接），防止挂起的事件处理。
 * 2. 优雅释放 Mineflayer 占用的套接字（Socket）资源。
 *
 * @param input 运行时核心资源与目录信息
 */
export async function closeAppRuntimeCoreResources<TBotId extends string>(input: {
  directory: AppRuntimeCoreDirectory<TBotId>;
  observation?: ObservationRuntimeCache;
  transport?: MineflayerRuntimeTransport<TBotId>;
  actor?: BotActorRuntime<TBotId>;
}): Promise<void> {
  const closeErrors: unknown[] = [];

  for (const resourceName of input.directory.close_order) {
    try {
      if (resourceName === "bot_actor" && input.actor !== undefined) {
        await input.actor.shutdown();
      }

      if (resourceName === "mineflayer_transport" && input.transport !== undefined) {
        await input.transport.disconnect();
      }

      if (resourceName === "observation") {
        void input.observation;
      }
    } catch (error) {
      closeErrors.push(error);
    }
  }

  if (closeErrors.length > 0) {
    throw closeErrors[0];
  }
}
