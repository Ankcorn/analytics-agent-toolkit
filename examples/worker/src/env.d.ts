import type { AISDKAgent } from "./ai-sdk-agent";
import type { PiAgent } from "./pi-agent";

declare global {
  namespace Cloudflare {
    interface Env {
      ANALYTICS: AnalyticsSQLBinding;
      AI: Ai;
      AI_SDK_AGENT: DurableObjectNamespace<AISDKAgent>;
      PI_AGENT: DurableObjectNamespace<PiAgent>;
    }
  }
  interface Env extends Cloudflare.Env {}
}
