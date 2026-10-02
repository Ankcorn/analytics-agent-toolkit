import { bindings, defineConfig, exports } from "@cloudflare/config";

export default defineConfig({
  worker: {
    name: "cf-agent-sql-example",
    entrypoint: "./src/index.ts",
    compatibilityDate: "2026-09-25",
    compatibilityFlags: ["nodejs_compat"],
    env: {
      // Remote-only: `wrangler dev` proxies both to your account.
      ANALYTICS_SQL: bindings.analyticsSQL({ dev: { remote: true } }),
      AI: bindings.ai({ dev: { remote: true } }),
      PI_AGENT: bindings.durableObject({
        worker: "cf-agent-sql-example",
        exportName: "PiAgent"
      })
    },
    exports: {
      PiAgent: exports.durableObject({ storage: "sqlite" })
    }
  }
});
