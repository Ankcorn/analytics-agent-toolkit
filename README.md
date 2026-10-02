# cf-agent-sql

Give AI SDK and Pi agents a read-only, schema-aware tool over the Cloudflare Analytics SQL binding.

```ts
import { createRegistry } from "@earendil-works/pi-durable";
import { analyticsSQLExtension } from "cf-agent-sql/pi";
import { catalog } from "./analytics-catalog"; // generated at build time by `asql render`

const registry = createRegistry();
registry.install(
  // Two tools: analytics_catalog (find tables and columns)
  // and analytics_query (run SQL through the ANALYTICS binding).
  analyticsSQLExtension({ binding: env.ANALYTICS, catalog })
);
// Open your Pi harness with this registry. Full Agents SDK examples for Pi and AI SDK are below.
```

The binding can run queries but can't list tables or describe them (`SHOW TABLES` and `DESCRIBE` fail), so an agent has no way to find out what it can query. `cf-agent-sql` fixes that in two steps:

1. **Build time:** the `asql` CLI fetches the full catalog with `cf`, narrows it to the tables your agent needs, and writes them to a small TypeScript file.
2. **Runtime:** the AI SDK or Pi tools give the model that schema, a tool to search it, and a tool to run queries through the binding.

## Install

```sh
npm install cf-agent-sql
```

Install `ai` and `zod` for the AI SDK tool, or `@earendil-works/pi-ai` and `@earendil-works/pi-durable` for Pi. Both are optional peer dependencies.

Add the binding in `cloudflare.config.ts`:

```ts
import { defineConfig } from "@cloudflare/config";

export default defineConfig({
  worker: {
    name: "my-agent",
    entrypoint: "./src/index.ts",
    compatibilityDate: "2026-09-25",
    env: { ANALYTICS: { type: "analytics" } }
  }
});
```

Run it locally with `wrangler dev --experimental-new-config`, which proxies the binding to your account. `cf dev` (the Vite plugin) can't proxy this binding yet: every query fails with `WebSocket connection failed`.

## Generate the catalog

```sh
npx asql sync                    # cf analytics sql introspection get → .cloudflare/analytics-sql/
npx asql render --preset workers # preview the schema the model will see, with a token count
npx asql render --preset workers --out src/analytics-catalog.ts
```

`sync` uses your `cf` login. The full catalog (about 90 datasets and 1,100 columns) is cached locally and never bundled. Only the generated file ships with your Worker.

Presets live in `presets.ts` next to your app:

```ts
import type { Presets } from "cf-agent-sql";

export const presets = {
  workers: {
    description: "Workers invocation logs and grouped errors",
    tables: ["logs.workersLogs", "logs.issues"],
    excludeColumns: ["accountTag"],
    columns: { "logs.workersLogs": ["scriptName", "httpStatus", "wallTimeMs"] },
    tableNotes: {
      "logs.workersLogs": ["logType 'cf-worker-event' = one row per invocation"]
    },
    examples: {
      "logs.workersLogs": [
        { question: "5xx per script", sql: `SELECT "scriptName", …` }
      ]
    }
  }
} satisfies Presets;
```

Without a preset, `--table 'logs.*'` picks tables by name. With a preset, `--table` narrows it further.

## Use the tools

Both adapters give the model the same two tools:

- `analytics_catalog` searches the catalog. Its input is `{ query?: string; table?: string }`: `{ table: "logs.workersLogs" }` returns that table's full definition, `{ query: "status code" }` returns matching columns plus the table's notes, and `{}` lists the tables.
- `analytics_query` runs SQL. Its description holds the dialect rules and one line per table, and tells the model to look up columns with `analytics_catalog` first. The prompt stays the same size however big the catalog is.

Both run inside an [Agents SDK](https://developers.cloudflare.com/agents/) `Agent`, which is a Durable Object. [`examples/worker`](examples/worker) has complete, runnable versions.

### Pi

```ts
import { Agent } from "agents";
import { createRegistry } from "@earendil-works/pi-durable";
import { analyticsSQLExtension } from "cf-agent-sql/pi";
import { catalog } from "./analytics-catalog";

export class PiAgent extends Agent<Env> {
  // Pass this registry to Harness.open, along with your storage and models.
  registry() {
    const registry = createRegistry();
    registry.install(
      analyticsSQLExtension({ binding: this.env.ANALYTICS, catalog })
    );
    return registry;
  }
}
```

Both tools are marked safe to rerun after a crash.

### AI SDK 7

```ts
import { Agent } from "agents";
import { stepCountIs, ToolLoopAgent } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { analyticsSQLTools } from "cf-agent-sql/ai-sdk";
import { catalog } from "./analytics-catalog";

export class AISDKAgent extends Agent<Env> {
  async ask(prompt: string): Promise<string> {
    const agent = new ToolLoopAgent({
      model: createWorkersAI({ binding: this.env.AI })(
        "@cf/zai-org/glm-5.3-flash"
      ),
      tools: analyticsSQLTools({ binding: this.env.ANALYTICS, catalog }),
      stopWhen: stepCountIs(8)
    });
    return (await agent.generate({ prompt })).text;
  }
}
```

## What the query tool does

It's a thin wrapper around `binding.query()`:

- **Sends the SQL exactly as written.** `SHOW TABLES`, `DESCRIBE` and anything else go to the backend unchanged; the agent is told to use the catalog instead. Time filters use `now()`, e.g. `timestamp >= now() - INTERVAL '1 day'`.
- **Passes backend errors through unchanged.** Analytics SQL errors are already specific (`No field named status. Valid fields are …`, `ORDER BY requires a LIMIT clause`), so the model reads them as they are.
- **Cuts large results** to `maxRows` (100) and `maxResultChars` (16,000), and tells the model when it did. Results go to the model as TSV, which uses fewer tokens than JSON.

For other frameworks, `createAnalyticsSQLToolkit({ binding, catalog })` from `cf-agent-sql` gives you `queryDescription`, `query()` and `search()`. Use them with `formatQueryOutput()` and `CATALOG_SEARCH_DESCRIPTION`.

## Things to know

These are checked against production and included in every generated catalog:

- **Most datasets are sampled.** Use `sum("sampleInterval")` instead of `count()`, `sumIf("sampleInterval", cond)` for conditional counts, and `quantileWeighted(0.99, col, "sampleInterval")` for percentiles.
- **The engine is DataFusion with ClickHouse-style functions.** Bucket time with `toStartOfInterval(timestamp, INTERVAL 5 MINUTE)`. Anything unsupported comes back as a backend error, which the model reads and fixes.
- **Double-quote camelCase columns**, for example `"httpStatus"`.

## License

MIT
