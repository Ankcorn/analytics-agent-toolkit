import { Agent } from "agents";
import { stepCountIs, ToolLoopAgent, type ModelMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { analyticsSQLTools } from "cf-agent-sql/ai-sdk";
import { catalog } from "./analytics-catalog"; // generated: pnpm run catalog

type State = { messages: ModelMessage[] };

/** An AI SDK agent that can query Analytics SQL. One instance per conversation. */
export class AISDKAgent extends Agent<Env, State> {
  initialState: State = { messages: [] };

  async ask(prompt: string): Promise<string> {
    // Two tools: analytics_query and analytics_catalog.
    const sql = analyticsSQLTools({ binding: this.env.ANALYTICS_SQL, catalog });
    const agent = new ToolLoopAgent({
      model: createWorkersAI({ binding: this.env.AI })(
        "@cf/zai-org/glm-5.3-flash",
        { reasoning_effort: "low" }
      ),
      instructions: sql.instructions,
      tools: sql.tools,
      stopWhen: stepCountIs(8)
    });

    // The conversation is kept in the Agent's state, so it survives restarts.
    const messages: ModelMessage[] = [
      ...this.state.messages,
      { role: "user", content: prompt }
    ];
    const result = await agent.generate({ messages });
    this.setState({ messages: [...messages, ...result.response.messages] });
    return result.text;
  }
}
