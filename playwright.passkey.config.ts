import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://localhost:33002";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "passkey.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  forbidOnly: Boolean(process.env.CI),
  // 初始化会持久化一次性状态，失败后不能复用同一数据库重试。
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "corepack pnpm@11.13.1 run dev --hostname localhost --port 33002",
    url: `${baseURL}/api/health/live`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
