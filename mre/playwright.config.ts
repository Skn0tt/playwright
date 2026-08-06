import { defineConfig, devices } from "@playwright/test"
const exe = process.env.CRPATH
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  retries: 0,
  reporter: "line",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:3123",
    ...(exe ? { launchOptions: { executablePath: exe } } : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node server.mjs",
    url: "http://localhost:3123",
    reuseExistingServer: true,
  },
})
