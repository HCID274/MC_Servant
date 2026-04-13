import { defineConfig } from "vitest/config";

/** Vitest 测试配置。 */
const vitestConfig = defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.spec.ts"],
  },
});

export default vitestConfig;
