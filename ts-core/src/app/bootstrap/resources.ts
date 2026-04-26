import { createPostgresRuntimeResource, createRedisRuntimeResource } from "../../db/index.js";
import type { PostgresRuntimeResource, RedisRuntimeResource } from "../../db/index.js";
import type {
  AppBootstrapContract,
  AppResourceDirectory,
  AppRuntimeResourceDependencies,
  AppRuntimeResources,
} from "./types.js";

/**
 * 基于应用装配结果创建真实 PostgreSQL（关系型数据库） / Redis（缓存） 资源。
 *
 * 该工厂负责物理资源的实例化及生命周期闭环：
 * 1. 按照 create_order 指定的顺序（通常是 Postgres -> Redis）安全地建立底层连接。
 * 2. 封装资源异常回滚机制，若中间某资源创建失败，将逆序清理已创建资源以防止泄露。
 * 3. 提供统一的资源关闭接口，确保在系统停机时各连接被平滑释放。
 *
 * @param bootstrap 引导契约
 * @param dependencies 可注入的资源依赖（用于 Mock 或自定义连接）
 * @returns 运行时资源句柄
 */
export async function createAppRuntimeResources<TBotId extends string>(
  bootstrap: AppBootstrapContract<TBotId>,
  dependencies: AppRuntimeResourceDependencies = {},
): Promise<AppRuntimeResources<TBotId>> {
  const created: Partial<{
    postgres: PostgresRuntimeResource;
    redis: RedisRuntimeResource;
  }> = {};

  try {
    created.postgres = await createPostgresRuntimeResource(
      bootstrap.resources.postgres.descriptor,
      dependencies.postgres,
    );
    created.redis = await createRedisRuntimeResource(
      bootstrap.resources.redis.descriptor,
      dependencies.redis,
    );
    const postgres = created.postgres;
    const redis = created.redis;

    if (postgres === undefined || redis === undefined) {
      throw new Error("app runtime resources require postgres and redis");
    }

    return Object.freeze({
      bot_id: bootstrap.bot_id,
      directory: bootstrap.resources,
      postgres,
      redis,
      async close(): Promise<void> {
        await closeAppRuntimeResources({
          directory: bootstrap.resources,
          postgres,
          redis,
        });
      },
    });
  } catch (error) {
    await closeAppRuntimeResources({
      directory: bootstrap.resources,
      ...(created.postgres === undefined ? {} : { postgres: created.postgres }),
      ...(created.redis === undefined ? {} : { redis: created.redis }),
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * 按应用约定顺序关闭真实资源；即使前一步失败也会继续清理后续资源。
 *
 * 架构设计：
 * 遵循 close_order（通常与创建顺序相反），采用“尽力而为”的清理策略，
 * 捕获并汇总所有关闭过程中的错误，确保基础设施连接被安全释放。
 *
 * @param input 包含资源实例和目录信息的输入
 */
export async function closeAppRuntimeResources<TBotId extends string>(input: {
  directory: AppResourceDirectory<TBotId>;
  postgres?: PostgresRuntimeResource;
  redis?: RedisRuntimeResource;
}): Promise<void> {
  const closeErrors: unknown[] = [];

  for (const resourceName of input.directory.close_order) {
    try {
      if (resourceName === "redis" && input.redis !== undefined) {
        await input.redis.close();
      }

      if (resourceName === "postgres" && input.postgres !== undefined) {
        await input.postgres.close();
      }
    } catch (error) {
      closeErrors.push(error);
    }
  }

  if (closeErrors.length === 0) {
    return;
  }

  throw closeErrors[0];
}
