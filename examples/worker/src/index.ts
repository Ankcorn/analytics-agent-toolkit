import { env } from "cloudflare:workers";
import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { analyticsSQLTools } from "cf-agent-sql/ai-sdk";
import { catalog } from "./analytics-catalog"; // generated: pnpm run catalog

export { PiAgent } from "./pi-agent";

const MODEL = "@cf/zai-org/glm-5.3-flash";

export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST")
      return new Response("POST /ai-sdk or /pi with { prompt }", {
        status: 404
      });
    const { prompt, id = "default" } = await request.json<{
      prompt: string;
      id?: string;
    }>();

    // AI SDK: the tool runs in the Worker.
    if (url.pathname === "/ai-sdk") {
      const sql = analyticsSQLTools({ binding: env.ANALYTICS_SQL, catalog });
      const { text, steps } = await generateText({
        model: createWorkersAI({ binding: env.AI })(MODEL, {
          reasoning_effort: "low"
        }),
        system: sql.instructions,
        tools: sql.tools,
        stopWhen: stepCountIs(8),
        prompt
      });
      return Response.json({
        answer: text,
        toolCalls: steps.flatMap((s) =>
          s.toolCalls.map((c) => ({ tool: c.toolName, input: c.input }))
        )
      });
    }

    // Pi: the tool runs in a Durable Object, one conversation per id.
    if (url.pathname === "/pi")
      return Response.json(await env.PI_AGENT.getByName(id).ask(prompt));

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
