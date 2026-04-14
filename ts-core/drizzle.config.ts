import { defineConfig } from "drizzle-kit";

import { createDrizzleKitConfigSnapshot, createDrizzleMigrationMetadata } from "./src/db/index.js";

function createEnvironmentSnapshot(env: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      snapshot[key] = value;
    }
  }

  return Object.freeze(snapshot);
}

const metadata = createDrizzleMigrationMetadata({
  env: createEnvironmentSnapshot(process.env),
});
const config = createDrizzleKitConfigSnapshot(metadata);

export default defineConfig({
  dialect: config.dialect,
  schema: config.schema,
  out: config.out,
  dbCredentials: config.dbCredentials,
  schemaFilter: [...config.schemaFilter],
});
