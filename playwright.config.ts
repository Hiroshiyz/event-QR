import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
  testDir: "./tests",
  testMatch: "browser.spec.ts",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://localhost:5173",
    channel: "chromium",
    headless: true,
    viewport: { width: 1000, height: 900 },
    permissions: ["camera"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-file-for-fake-video-capture=" + resolve(".local/camera.y4m"),
      ],
    },
  },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
  },
  // Traces/screenshots may contain real QR credentials. Never collect them automatically.
  outputDir: ".local/browser-results",
  reporter: "list",
});
