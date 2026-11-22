import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    env: {
      APP_ENV: "test",
      APP_BASE_URL: "http://localhost:3000",
      STORAGE_DRIVER: "local",
      STORAGE_DIR: "/tmp/rc-vitest-storage",
      STORAGE_SIGNING_SECRET: "test-only-signing-secret-0123456789abcdef",
      // The app role, never the owner. Created by tests/global-setup.ts.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://rc_app_test:rc_app_test@127.0.0.1:5432/rc_vitest",
    },
  },
});
