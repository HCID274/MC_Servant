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
  /** 健康检查输出基线。 */
  readonly health: AppBootstrapContract<TBotId>["interfaces"]["health"];
  /** 子系统依赖与就绪目录。 */
  readonly readiness: readonly AppReadinessDescriptor[];
  /** 启动 / 关闭生命周期计划。 */
  readonly lifecycle: AppLifecyclePlan;
}

/** 创建单 Bot（机器人） 的无 MC（Minecraft） 冒烟装配摘要。 */
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
    health: assembly.interfaces.health,
    readiness: assembly.readiness,
    lifecycle: assembly.lifecycle,
  });
}
