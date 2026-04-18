/**
 * 应用冒烟测试与装配摘要。
 *
 * 1. 冒烟装配（Smoke Assembly）：提供一个轻量级的装配视图，用于在不启动真实服务的情况下验证配置和依赖关系的正确性。
 * 2. 隔离验证：确保在脱离 Minecraft (MC) 协议栈的情况下，核心业务组件（数据库、Redis、Worker 等）的装配逻辑依然稳健。
 */

import type { DataConfig } from "../data/index.js";
import type { PostgresConnectionDescriptor, RedisKeyCatalog } from "../db/index.js";
import {
  type AppBootstrapContract,
  type AppBootstrapInput,
  createAppBootstrapContract,
} from "./bootstrap.js";
import type { AppLifecyclePlan, AppReadinessDescriptor } from "./contracts.js";

/** 单 Bot（机器人） 视角的无 MC（Minecraft） 冒烟装配摘要。 */
export interface AppSmokeAssembly<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 由环境变量与 Bot 覆盖合并后的基础设施配置。 */
  readonly config: DataConfig;
  /** PostgreSQL（关系型数据库） 连接描述。 */
  readonly postgres: PostgresConnectionDescriptor;
  /** Redis（缓存） 键目录。 */
  readonly redis: RedisKeyCatalog<TBotId>;
  /** 三队列目录。 */
  readonly workers: AppBootstrapContract<TBotId>["workers"];
  /** 运行时初始状态。 */
  readonly runtime: AppBootstrapContract<TBotId>["runtime"];
  /** 真实资源目录。 */
  readonly resources: AppBootstrapContract<TBotId>["resources"];
  /** 运行时核心资源目录。 */
  readonly runtime_resources: AppBootstrapContract<TBotId>["runtime_resources"];
  /** 服务层资源目录。 */
  readonly services: AppBootstrapContract<TBotId>["services"];
  /** 健康检查输出基线。 */
  readonly health: AppBootstrapContract<TBotId>["interfaces"]["health"];
  /** 子系统依赖与就绪目录。 */
  readonly readiness: readonly AppReadinessDescriptor[];
  /** 启动 / 关闭生命周期计划。 */
  readonly lifecycle: AppLifecyclePlan;
}

/**
 * 创建单 Bot（机器人） 的无 MC（Minecraft） 冒烟装配摘要。
 *
 * 1. 结果投影：将庞大的引导契约（Bootstrap Contract）转换为一个专门用于冒烟测试的扁平化摘要。
 * 2. 验证保障：作为配置校验的最后一道防线，确保所有基础设施描述符已正确生成。
 * 3. 提供一个轻量级的装配视图，用于在不启动真实服务（No-IO）的情况下验证配置和依赖关系的正确性。
 * 4. 确保在脱离 Minecraft (MC) 协议栈的情况下，核心业务组件（数据库、Redis、Worker 等）的装配逻辑依然稳健。
 *
 * @param input 引导输入
 * @returns 冒烟装配摘要
 */
export function createAppSmokeAssembly<TBotId extends string>(
  input: AppBootstrapInput<TBotId>,
): AppSmokeAssembly<TBotId> {
  const assembly = createAppBootstrapContract(input);

  return Object.freeze({
    bot_id: assembly.bot_id,
    config: assembly.config,
    postgres: assembly.postgres,
    redis: assembly.redis,
    workers: assembly.workers,
    runtime: assembly.runtime,
    resources: assembly.resources,
    runtime_resources: assembly.runtime_resources,
    services: assembly.services,
    health: assembly.interfaces.health,
    readiness: assembly.readiness,
    lifecycle: assembly.lifecycle,
  });
}
