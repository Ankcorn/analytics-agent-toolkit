import { env } from "cloudflare:workers";
import { stepCountIs, ToolLoopAgent } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { analyticsSQLTools } from "cf-agent-sql/ai-sdk";
import { catalog } from "./analytics-catalog.ts"; // generated: asql render --preset workers --out src/analytics-catalog.ts
import { PiAnalyticsAgent } from "./pi-agent.ts";

export { PiAnalyticsAgent };

export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 });

    // AI SDK 7
    if (url.pathname === "/agents/ai-sdk") {
      const { prompt } = await request.json<{ prompt: string }>();
      const sql = analyticsSQLTools({ binding: env.ANALYTICS_SQL, catalog });
      const agent = new ToolLoopAgent({
        model: createWorkersAI({ binding: env.AI })("@cf/moonshotai/kimi-k2.6"),
        instructions: sql.instructions,
        tools: sql.tools,
        stopWhen: stepCountIs(8)
      });
      return Response.json({ answer: (await agent.generate({ prompt })).text });
    }

    // Pi Durable, one harness per DO
    if (url.pathname === "/agents/pi") {
      const { prompt, id = "default" } = await request.json<{
        prompt: string;
        id?: string;
      }>();
      // Self-referencing DO bindings by worker name can't infer the class yet; narrow by hand.
      const ns =
        env.PI_AGENT as unknown as DurableObjectNamespace<PiAnalyticsAgent>;
      return Response.json(await ns.getByName(id).ask(prompt));
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
