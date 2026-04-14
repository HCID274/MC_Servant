import { createAppBootstrapContract, runAppEntrypoint } from "./app/index.js";

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

function resolveBotId(env: NodeJS.ProcessEnv): string {
  const rawBotId = env.TS_CORE_BOT_ID;

  if (typeof rawBotId === "string" && rawBotId.trim().length > 0) {
    return rawBotId.trim();
  }

  return "local-bot";
}

function formatStartupError(error: unknown): string {
  if (error instanceof Error) {
    return `TS Core bootstrap failed: ${error.message}\n`;
  }

  return "TS Core bootstrap failed: unknown error\n";
}

function main(): void {
  try {
    const bootstrap = createAppBootstrapContract({
      botId: resolveBotId(process.env),
      now: new Date().toISOString(),
      env: createProcessEnvironmentSnapshot(process.env),
    });

    runAppEntrypoint({
      bootstrap,
      write: (message) => {
        process.stdout.write(`${message}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(formatStartupError(error));
    process.exitCode = 1;
  }
}

main();
