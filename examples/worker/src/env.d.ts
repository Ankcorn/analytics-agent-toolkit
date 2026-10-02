import type { PiAgent } from "./pi-agent";

declare global {
  namespace Cloudflare {
    interface Env {
      ANALYTICS_SQL: AnalyticsSQLBinding;
      AI: Ai;
      PI_AGENT: DurableObjectNamespace<PiAgent>;
    }
  }
  interface Env extends Cloudflare.Env {}
}
