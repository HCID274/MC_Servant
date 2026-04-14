import { runDrizzleMigrations } from "./migrations.js";

/** 从进程环境创建只读快照，避免迁移入口在后续流程中被旁路改写。 */
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

/** 执行 Drizzle（数据库工具） migration（迁移） CLI（命令行） 入口。 */
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
