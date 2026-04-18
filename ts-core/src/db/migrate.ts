/**
 * 数据库迁移 CLI 入口。
 *
 * 1. 环境准备：解析并冻结迁移所需的环境变量。
 * 2. 迁移执行：调用 Drizzle 迁移逻辑，执行 Schema 更新。
 * 3. 结果反馈：向标准输出（stdout）打印迁移详情，或向标准错误（stderr）打印失败信息并设置退出码。
 */

import { runDrizzleMigrations } from "./migrations.js";

/**
 * 从进程环境创建只读快照。
 *
 * 环境隔离（Environment Isolation）：隔离 Node.js process.env 的动态性。
 *
 * 稳定性保障：为迁移过程提供一个稳定的、不可变的配置来源，防止迁移期间环境变量意外变更导致的副作用。
 *
 * @param env 原始环境变量
 * @returns 冻结后的环境变量记录
 */
export function createMigrationEnvironmentSnapshot(
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
 * 执行 Drizzle 迁移 CLI 入口。
 *
 * CLI 协议适配：负责初始化迁移环境、触发核心迁移逻辑并输出标准化的状态摘要。
 *
 * 独立工具链：作为独立于主应用的脚本入口，确保数据库演进可以作为部署流水线（CI/CD）中的独立环节运行。
 */
export async function runMigrationCli(): Promise<void> {
  const result = await runDrizzleMigrations({
    env: createMigrationEnvironmentSnapshot(process.env),
  });

  process.stdout.write(
    `${[
      "TS Core migrations completed",
      `schema: ${result.metadata.connection.schema}`,
      `database: ${result.metadata.connection.database}`,
      `migrations: ${result.metadata.migrationsDirectory}`,
      `extensions: ${result.ensuredExtensions.join(", ") || "none"}`,
    ].join("\n")}\n`,
  );
}

void runMigrationCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`TS Core migrations failed: ${message}\n`);
  process.exitCode = 1;
});
