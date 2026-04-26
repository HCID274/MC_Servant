import { createAppRuntimeResources } from "./resources.js";
import { createAppRuntimeCoreResources } from "./runtime-core.js";
import { createAppRuntimeServices } from "./services.js";
import type {
  AppBootstrapContract,
  AppProcessRuntime,
  AppProcessRuntimeDependencies,
  AppRuntimeCoreResources,
  AppRuntimeResources,
  AppRuntimeServices,
} from "./types.js";

/**
 * 创建完整应用进程资源。
 *
 * 1. 级联初始化：按照 基础设施 -> 核心运行时 -> 服务层 的拓扑顺序依次拉起整个应用。
 * 2. 根级生命周期控制：管理整个单进程实例的启动与原子化销毁。
 * 3. 错误传播管理：任何环节的失败都将触发已创建资源的自动回滚清理。
 * 4. 作为真正的“一键拉起”入口，将所有底层的复杂装配隐藏在单一的 Promise 之下。
 * 5. 提供最高级别的资源隔离保障，确保进程级别的 IO 资源始终处于受控状态。
 *
 * @param bootstrap 引导契约
 * @param dependencies 基础设施与服务层依赖
 * @returns 可统一关闭的完整进程资源
 */
export async function createAppProcessRuntime<TBotId extends string>(
  bootstrap: AppBootstrapContract<TBotId>,
  dependencies: AppProcessRuntimeDependencies = {},
): Promise<AppProcessRuntime<TBotId>> {
  let infrastructure: AppRuntimeResources<TBotId> | undefined;
  let runtime: AppRuntimeCoreResources<TBotId> | undefined;
  let services: AppRuntimeServices<TBotId> | undefined;

  try {
    infrastructure = await createAppRuntimeResources(bootstrap, dependencies.infrastructure);
    runtime = await createAppRuntimeCoreResources(bootstrap, dependencies.runtime);
    services = await createAppRuntimeServices(
      bootstrap,
      infrastructure,
      dependencies.services,
      runtime,
    );
    const createdInfrastructure = infrastructure;
    const createdRuntime = runtime;
    const createdServices = services;

    return Object.freeze({
      bot_id: bootstrap.bot_id,
      infrastructure: createdInfrastructure,
      runtime: createdRuntime,
      services: createdServices,
      async close(): Promise<void> {
        const closeErrors: unknown[] = [];

        try {
          await createdServices.close();
        } catch (error) {
          closeErrors.push(error);
        }

        try {
          await createdRuntime.close();
        } catch (error) {
          closeErrors.push(error);
        }

        try {
          await createdInfrastructure.close();
        } catch (error) {
          closeErrors.push(error);
        }

        if (closeErrors.length > 0) {
          throw closeErrors[0];
        }
      },
    });
  } catch (error) {
    if (services !== undefined) {
      await services.close().catch(() => undefined);
    }

    if (runtime !== undefined) {
      await runtime.close().catch(() => undefined);
    }

    if (infrastructure !== undefined) {
      await infrastructure.close().catch(() => undefined);
    }

    throw error;
  }
}
