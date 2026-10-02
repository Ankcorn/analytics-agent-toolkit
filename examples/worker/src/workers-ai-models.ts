import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL as SENTINEL,
  createAiBindingFetch
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import type { StreamOptions } from "@earendil-works/pi-ai";

/**
 * pi-ai's Workers AI provider only speaks REST (it needs an API token). This
 * keeps its model catalog but sends requests through the AI binding to the
 * account's AI Gateway instead, so no token is needed inside a Worker.
 */
export function workersAIModels(ai: Ai, gateway = "default") {
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
