import { bindings, defineConfig, exports } from "@cloudflare/config";

export default defineConfig({
  worker: {
    name: "analytics-agent-toolkit-example",
    entrypoint: "./src/index.ts",
    compatibilityDate: "2026-09-25",
    compatibilityFlags: ["nodejs_compat"],
    env: {
      ANALYTICS: { type: "analytics" },
      // Workers AI is remote-only: `wrangler dev` proxies it to your account.
      AI: bindings.ai({ dev: { remote: true } }),
      AI_SDK_AGENT: bindings.durableObject({
        worker: "analytics-agent-toolkit-example",
        exportName: "AISDKAgent"
      }),
      PI_AGENT: bindings.durableObject({
        worker: "analytics-agent-toolkit-example",
        exportName: "PiAgent"
      })
    },
    exports: {
      // Agents SDK agents are SQLite-backed Durable Objects.
      AISDKAgent: exports.durableObject({ storage: "sqlite" }),
      PiAgent: exports.durableObject({ storage: "sqlite" })
    }
  }
});
