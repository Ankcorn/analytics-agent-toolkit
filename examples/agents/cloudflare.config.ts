import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "cf-agent-sql-example",
    compatibilityDate: "2026-09-25",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    env: {
      // Analytics SQL is remote-only: `cf dev` proxies it to your account.
      ANALYTICS_SQL: bindings.analyticsSQL(),
      AI: bindings.ai(),
      PI_AGENT: bindings.durableObject({
        worker: "cf-agent-sql-example",
        exportName: "PiAnalyticsAgent"
      })
      // pi-ai's Workers AI provider uses the REST API, not the AI binding:
      // set CLOUDFLARE_API_KEY (secret) and CLOUDFLARE_ACCOUNT_ID for /agents/pi.
    },
    exports: {
      PiAnalyticsAgent: exports.durableObject({ storage: "sqlite" })
    }
  }
});
