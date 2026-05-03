import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAppEmbeddingConfigFromEnvironment,
  createAppServerBridgeConfigFromEnvironment,
} from "./app/bootstrap/env.js";
import type { AppOnlineEntrypointDependencies } from "./app/entrypoint.js";
import {
  createAppBootstrapContract,
  createAppExternalAuthSecretFromEnvironment,
  createAppLlmApiKeyFromEnvironment,
  startAppOnlineRuntime,
} from "./app/index.js";

/**
 * 创建当前进程的环境变量快照。
 *
 * 1. 确保在应用运行期间环境变量是不可变的（Readonly），防止运行时意外修改。
 * 2. 隔离 Node.js process.env 的动态性，提供一个稳定的配置来源。
 *
 * @param env 原始环境变量对象
 * @returns 冻结后的环境变量记录
 */
function createProcessEnvironmentSnapshot(
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      snapshot[key] = value;
    }
  }

  return Object.freeze(snapshot);
}

/**
 * 解析当前机器人的唯一标识符。
 *
 * 1. 确保在多智能体（Multi-Agent）环境中，每个实例都具有明确的身份标识。
 * 2. 默认 fallback 到 "local-bot" 以支持零配置的本地开发与调试。
 *
 * @param env 环境变量
 * @returns 机器人 ID
 */
function resolveBotId(env: NodeJS.ProcessEnv): string {
  const rawBotId = env.TS_CORE_BOT_ID;

  if (typeof rawBotId === "string" && rawBotId.trim().length > 0) {
    return rawBotId.trim();
  }

  return "local-bot";
}

/**
 * 将启动过程中捕获的错误格式化为可读字符串。
 *
 * 1. 在进程边界（Shell/Process Exit）提供统一的错误呈现格式。
 * 2. 确保在没有正式日志记录器（Logger）可用的引导早期阶段，依然能输出有意义的诊断信息。
 *
 * @param error 捕获的异常对象
 */
function formatStartupError(error: unknown): string {
  if (error instanceof Error) {
    return `TS Core bootstrap failed: ${error.message}\n`;
  }

  return "TS Core bootstrap failed: unknown error\n";
}

/** 从环境变量组装在线主程依赖。 */
export function createAppOnlineRuntimeDependenciesFromEnvironment(input: {
  env: Readonly<Record<string, string>>;
}): AppOnlineEntrypointDependencies {
  const env = input.env;
  const serverBridge = createAppServerBridgeConfigFromEnvironment({ env });
  const embedding = createAppEmbeddingConfigFromEnvironment({ env });
  const apiKey = createAppLlmApiKeyFromEnvironment({ env });
  const externalAuthSecret = createAppExternalAuthSecretFromEnvironment({ env });

  return Object.freeze({
    llm: apiKey === undefined ? {} : { api_key: apiKey },
    runtime: externalAuthSecret === undefined ? {} : { externalAuthSecret },
    ...(serverBridge === undefined ? {} : { serverBridge }),
    ...(embedding === undefined ? {} : { embedding }),
  });
}

function isMainModule(input: { moduleUrl: string; argv1: string | undefined }): boolean {
  if (input.argv1 === undefined) {
    return false;
  }

  return fileURLToPath(input.moduleUrl) === resolve(input.argv1);
}

/**
 * 应用主入口点。
 *
 * 1. 初始化引导契约（Bootstrap Contract）：汇集环境快照、时间戳和机器人标识。
 * 2. 启动应用入口（App Entrypoint）：将引导信息注入业务逻辑，并设置标准的输出通道。
 * 3. 错误边界处理：捕获启动阶段的所有致命错误并安全退出。
 */
async function main(): Promise<void> {
  try {
    const env = createProcessEnvironmentSnapshot(process.env);
    const bootstrap = createAppBootstrapContract({
      botId: resolveBotId(process.env),
      now: new Date().toISOString(),
      env,
    });
    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: createAppOnlineRuntimeDependenciesFromEnvironment({ env }),
      write: (message) => {
        process.stdout.write(`${message}\n`);
      },
    });

    const handleSignal = () => {
      runtime
        .close()
        .then(() => {
          process.exitCode = 0;
        })
        .catch((error) => {
          process.stderr.write(formatStartupError(error));
          process.exitCode = 1;
        });
    };

    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  } catch (error) {
    process.stderr.write(formatStartupError(error));
    process.exitCode = 1;
  }
}

if (isMainModule({ moduleUrl: import.meta.url, argv1: process.argv[1] })) {
  void main();
}
