import { Agent } from "agents";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  Harness,
  MemoryStorage
} from "@earendil-works/pi-durable";
import { analyticsSQLExtension } from "analytics-agent-toolkit/pi";
import { catalog } from "./analytics-catalog"; // generated: pnpm run catalog
import { workersAIModels } from "./workers-ai-models";

/** A Pi agent that can query Analytics SQL. One instance per conversation. */
export class PiAgent extends Agent<Env> {
  #harness?: Promise<Harness>;

  async ask(prompt: string): Promise<string> {
    const ctx = BACKGROUND_CONTEXT;
    this.#harness ??= (() => {
      // The extension adds two tools: analytics_query and analytics_catalog.
      const registry = createRegistry();
      registry.install(
        analyticsSQLExtension({ binding: this.env.ANALYTICS, catalog })
      );
      // MemoryStorage: the conversation lives as long as this instance stays in memory.
      return Harness.open(
        new MemoryStorage(),
        { models: workersAIModels(this.env.AI), registry },
        ctx
      );
    })();

    const root = await (
      await this.#harness
    ).root(ctx, {
      agent: {
        model: {
          provider: "cloudflare-workers-ai",
          modelId: "@cf/zai-org/glm-5.3-flash"
        },
        thinkingLevel: "low"
      }
    });
    await (
      await root.submit({ type: "input", content: prompt }, ctx)
    ).wait(ctx);

    const { messages } = await root.context(ctx);
    const reply = messages.findLast((m) => m.role === "assistant");
    return reply?.role === "assistant"
      ? reply.content
          .flatMap((p) => (p.type === "text" ? [p.text] : []))
          .join("")
      : "";
  }
}
