import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage
} from "@earendil-works/pi-durable";
import { analyticsSQLExtension } from "cf-agent-sql/pi";
import { catalog } from "./analytics-catalog.ts";

const MODEL = {
  provider: "cloudflare-workers-ai",
  modelId: "@cf/moonshotai/kimi-k2.6"
} as const;

/**
 * One pi-durable harness per DO instance (= per agent / per chat).
 *
 * NOTE: uses MemoryStorage to keep the prototype focused on the tool wrapper.
 * For real durability, implement pi's async `SqliteDatabase` facade over
 * `ctx.storage.sql` and use `SqliteStorage` from
 * `@earendil-works/pi-durable/storage/sqlite`.
 */
export class PiAnalyticsAgent extends DurableObject<Env> {
  #harness?: Promise<Harness>;

  #open(): Promise<Harness> {
    this.#harness ??= (async () => {
      const env = this.env as unknown as Record<string, string | undefined>;
      const models = createModels({
        // pi-ai resolves provider credentials through this instead of process.env
        authContext: {
          env: async (name) => env[name],
          fileExists: async () => false
        }
      });
      models.setProvider(cloudflareWorkersAIProvider());

      const registry = createRegistry();
      registry.install(
        analyticsSQLExtension({
          binding: () => this.env.ANALYTICS_SQL,
          catalog
        })
      );

      return Harness.open(
        new MemoryStorage(),
        { models, registry },
        BACKGROUND_CONTEXT
      );
    })();
    return this.#harness;
  }

  async ask(
    prompt: string
  ): Promise<{ answer: string; transcript: unknown[] }> {
    const context = BACKGROUND_CONTEXT;
    const harness = await this.#open();
    const root = await harness.root(context, { agent: { model: MODEL } });
    await (
      await root.submit({ type: "input", content: prompt }, context)
    ).wait(context);
    const { messages } = await root.context(context);
    const last = messages.findLast((m) => m.role === "assistant");
    const answer =
      last && Array.isArray(last.content)
        ? last.content
            .flatMap((c) => (c.type === "text" ? [c.text] : []))
            .join("")
        : "";
    return { answer, transcript: messages as unknown[] };
  }
}
