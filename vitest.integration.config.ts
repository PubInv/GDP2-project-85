import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.spec.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ["default"],
  },
});
