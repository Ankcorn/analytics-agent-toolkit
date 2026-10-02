import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL as SENTINEL,
  createAiBindingFetch
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import type { StreamOptions } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage
} from "@earendil-works/pi-durable";
import { analyticsSQLExtension } from "cf-agent-sql/pi";
import { catalog } from "./analytics-catalog"; // generated: pnpm run catalog

const MODEL = {
  provider: "cloudflare-workers-ai",
  modelId: "@cf/zai-org/glm-5.3-flash"
} as const;

/** One pi harness per Durable Object (= per conversation). */
export class PiAgent extends DurableObject<Env> {
  #harness?: Promise<Harness>;

  async ask(prompt: string): Promise<{ answer: string; queries: unknown[] }> {
    const ctx = BACKGROUND_CONTEXT;
    // MemoryStorage keeps the example small: the conversation lasts as long as
    // the DO stays in memory. Use SqliteStorage over ctx.storage.sql to persist.
    this.#harness ??= (() => {
      const registry = createRegistry();
      registry.install(
        analyticsSQLExtension({ binding: this.env.ANALYTICS_SQL, catalog })
      );
      return Harness.open(
        new MemoryStorage(),
        { models: workersAIModels(this.env.AI), registry },
        ctx
      );
    })();
    const harness = await this.#harness;
    const root = await harness.root(ctx, {
      agent: { model: MODEL, thinkingLevel: "low" }
    });
    const before = (await root.context(ctx)).messages.length;
    await (
      await root.submit({ type: "input", content: prompt }, ctx)
    ).wait(ctx);
    const turn = (await root.context(ctx)).messages.slice(before);
    const last = turn.findLast((m) => m.role === "assistant");
    return {
      answer:
        last?.role === "assistant"
          ? last.content
              .flatMap((p) => (p.type === "text" ? [p.text] : []))
              .join("")
          : "",
      queries: turn.flatMap((m) =>
        m.role === "assistant"
          ? m.content.flatMap((p) =>
              p.type === "toolCall" ? [p.arguments] : []
            )
          : []
      )
    };
  }
}

/**
 * pi-ai's Workers AI provider only speaks REST (it needs an API token). This
 * keeps its model catalog but sends requests through the AI binding to the
 * account's AI Gateway instead, so no token is needed inside a Worker.
 */
function workersAIModels(ai: Ai, gateway = "default") {
  const base = cloudflareWorkersAIProvider();
  const api = openAICompletionsApi();
  const baseUrl = `https://workers-binding.ai/ai-gateway/gateways/${gateway}/workers-ai/v1`;
  const fetch = createAiBindingFetch(ai);
  const viaBinding = <T extends StreamOptions | undefined>(options: T) => ({
    ...options,
    fetch,
    headers: {
      ...options?.headers,
      "cf-aig-authorization": `Bearer ${SENTINEL}`,
      Authorization: null,
      "x-api-key": null
    }
  });
  const models = createModels();
  models.setProvider(
    createProvider({
      id: base.id,
      name: base.name,
      auth: {
        apiKey: {
          name: "Workers AI binding",
          resolve: async () => ({
            auth: { apiKey: SENTINEL },
            source: "AI binding"
          })
        }
      },
      models: base.getModels(),
      api: {
        stream: (model, context, options) =>
          api.stream({ ...model, baseUrl }, context, viaBinding(options)),
        streamSimple: (model, context, options) =>
          api.streamSimple({ ...model, baseUrl }, context, viaBinding(options))
      }
    })
  );
  return models;
}
