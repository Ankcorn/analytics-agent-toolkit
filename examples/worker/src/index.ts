import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";

export { AISDKAgent } from "./ai-sdk-agent";
export { PiAgent } from "./pi-agent";

/**
 * POST /ai-sdk or /pi with { prompt, id? }. Each id is its own agent
 * instance, so follow-up prompts with the same id continue the conversation.
 */
export default {
  async fetch(request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST")
      return new Response("POST /ai-sdk or /pi with { prompt, id? }", {
        status: 404
      });
    const { prompt, id = "default" } = await request.json<{
      prompt: string;
      id?: string;
    }>();

    if (pathname === "/ai-sdk") {
      const agent = await getAgentByName(env.AI_SDK_AGENT, id);
      return Response.json({ answer: await agent.ask(prompt) });
    }
    if (pathname === "/pi") {
      const agent = await getAgentByName(env.PI_AGENT, id);
      return Response.json({ answer: await agent.ask(prompt) });
    }
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
