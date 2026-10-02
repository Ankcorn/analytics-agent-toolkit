import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { pathToFileURL } from "node:url";
import {
  type AnalyticsSQLLike,
  createAnalyticsSQLToolkit,
  formatQueryOutput,
  renderCatalog
} from "../index";
import {
  type IntrospectionResponse,
  applyPreset,
  catalogFromIntrospection,
  catalogToModule,
  filterCatalog,
  unionCatalogs
} from "../build";
import { analyticsSQLTools } from "../ai-sdk";

// Trimmed copy of real `cf analytics sql introspection get --include-columns` output.
const introspection: IntrospectionResponse = {
  datasets: [
    {
      name: "logs.workersLogs",
      title: "Workers Logs",
      category: "Logs and Traces",
      description: "Invocation and custom logs emitted by Cloudflare Workers",
      kind: { logs: { sampling: "adaptive" } },
      columns: [
        { name: "accountTag", data_type: "String" },
        { name: "attributes", data_type: "Json", hidden: true },
        {
          name: "httpStatus",
          data_type: "Int64",
          description: "HTTP status code returned by the Worker"
        },
        { name: "sampleInterval", data_type: "Int64" },
        { name: "scriptName", data_type: "String" },
        { name: "timestamp", data_type: "DateTime64(3)" },
        { name: "wallTimeMs", data_type: "UInt32" }
      ]
    },
    {
      name: "logs.traces",
      category: "Logs and Traces",
      description: "Spans",
      kind: { logs: { sampling: "adaptive" } },
      columns: [
        { name: "startTime", data_type: "DateTime64(3)" },
        { name: "endTime", data_type: "DateTime64(3)" },
        { name: "durationMs", data_type: "Float64" }
      ]
    },
    {
      name: "states.kvStorage",
      category: "Storage",
      description: "KV storage size",
      kind: { states: { sampling: "unsampled", valid_aggregations: ["max"] } },
      columns: [
        { name: "timestamp", data_type: "DateTime" },
        { name: "byteCount", data_type: "UInt64" }
      ]
    }
  ]
};
const catalog = catalogFromIntrospection(introspection);

function fakeBinding(
  impl: (q: string, p: unknown) => Record<string, unknown>[] | Error
) {
  const calls: { query: string; params: unknown }[] = [];
  const binding: AnalyticsSQLLike = {
    async query(req) {
      calls.push({ query: req.query, params: req.params });
      const r = impl(req.query, req.params);
      if (r instanceof Error) throw r;
      return {
        data: r as never[],
        rows: r.length,
        statistics: { elapsed_ms: 3, rows_read: 10, bytes_read: 100 }
      };
    }
  };
  return { binding, calls };
}

test("introspection maps kind, sampling, aggregations and picks a time column", () => {
  const [logs, traces, kv] = catalog.tables;
  assert.equal(logs!.timeColumn, "timestamp");
  assert.equal(logs!.sampling, "adaptive");
  assert.equal(traces!.timeColumn, "startTime");
  assert.deepEqual(kv!.validAggregations, ["max"]);
});

test("filterCatalog drops hidden + excluded columns and filters by category/kind/glob", () => {
  // Arrange / Act
  const byCat = filterCatalog(catalog, { categories: ["storage"] });
  const byGlob = filterCatalog(catalog, {
    tables: ["logs.*"],
    kinds: ["logs"],
    excludeColumns: ["account*"]
  });
  // Assert
  assert.deepEqual(
    byCat.tables.map((t) => t.name),
    ["states.kvStorage"]
  );
  assert.deepEqual(
    byGlob.tables.map((t) => t.name),
    ["logs.workersLogs", "logs.traces"]
  );
  const cols = byGlob.tables[0]!.columns.map((c) => c.name);
  assert.ok(!cols.includes("accountTag") && !cols.includes("attributes"));
});

test("preset column allow-list always keeps time column and sampleInterval, and adds examples", () => {
  const c = applyPreset(catalog, {
    description: "x",
    tables: ["logs.workersLogs"],
    columns: { "logs.workersLogs": ["httpStatus"] },
    examples: { "logs.workersLogs": [{ question: "q", sql: "SELECT 1" }] }
  });
  assert.deepEqual(
    c.tables[0]!.columns.map((col) => col.name),
    ["httpStatus", "sampleInterval", "timestamp"]
  );
  assert.match(renderCatalog(c), /-- q\nSELECT 1/);
});

test("SHOW TABLES is answered from the (filtered) catalog without hitting the binding", async () => {
  const { binding, calls } = fakeBinding(() => []);
  const tk = createAnalyticsSQLToolkit({
    binding,
    catalog: filterCatalog(catalog, { tables: ["logs.*"] })
  });
  const out = await tk.query({ sql: "SHOW TABLES;" });
  assert.equal(calls.length, 0);
  assert.ok(
    out.ok &&
      out.kind === "catalog" &&
      out.text.includes("logs.traces") &&
      !out.text.includes("kvStorage")
  );
});

test("DESCRIBE accepts unqualified table names", async () => {
  const { binding } = fakeBinding(() => []);
  const out = await createAnalyticsSQLToolkit({ binding, catalog }).query({
    sql: "describe table workersLogs"
  });
  assert.ok(
    out.ok && out.kind === "catalog" && out.text.includes("httpStatus Int64")
  );
});

test("missing time filter is rejected locally with a hint", async () => {
  const { binding, calls } = fakeBinding(() => []);
  const out = await createAnalyticsSQLToolkit({ binding, catalog }).query({
    sql: "SELECT count() FROM logs.workersLogs"
  });
  assert.equal(calls.length, 0);
  assert.ok(!out.ok && out.hint?.includes("timestamp >= $start"));
});

test("tables outside the preset are rejected with a did-you-mean", async () => {
  const { binding } = fakeBinding(() => []);
  const out = await createAnalyticsSQLToolkit({ binding, catalog }).query({
    sql: "SELECT 1 FROM logs.workerLogs WHERE timestamp >= $start"
  });
  assert.ok(!out.ok && out.hint?.includes("logs.workersLogs"));
});

test("valid query binds only referenced params, adds LIMIT, truncates", async () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({ i }));
  const { binding, calls } = fakeBinding(() => rows);
  const out = await createAnalyticsSQLToolkit({
    binding,
    catalog,
    maxRows: 100
  }).query({
    sql: 'SELECT "httpStatus" FROM logs.workersLogs WHERE timestamp >= $start AND timestamp < $end',
    start: "-15m"
  });
  assert.match(calls[0]!.query, /LIMIT 101$/);
  assert.deepEqual(Object.keys(calls[0]!.params as object).toSorted(), [
    "end",
    "start"
  ]);
  assert.ok(
    out.ok && out.kind === "rows" && out.rowCount === 100 && out.truncated
  );
});

test("real Analytics SQL 'No field named' error gets a did-you-mean", async () => {
  // Verbatim shape of the production error.
  const { binding } = fakeBinding(
    () =>
      new Error(
        'Schema error: No field named status. Valid fields are logs."workersLogs"."accountTag", logs."workersLogs"."httpStatus".'
      )
  );
  const out = await createAnalyticsSQLToolkit({ binding, catalog }).query({
    sql: "SELECT status FROM logs.workersLogs WHERE timestamp >= $start"
  });
  const text = formatQueryOutput(out);
  assert.match(text, /Did you mean httpStatus\?/);
  assert.match(text, /Columns of logs.workersLogs: .*httpStatus/);
});

test("real 'table not found' error lists available tables", async () => {
  // strictTables off so the backend error path is exercised.
  const { binding } = fakeBinding(
    () => new Error("Error during planning: table `logs.nope` not found")
  );
  const out = await createAnalyticsSQLToolkit({
    binding,
    catalog,
    strictTables: false,
    timeFilter: "off"
  }).query({ sql: "SELECT 1 FROM logs.nope" });
  assert.ok(
    !out.ok && out.hint?.startsWith("Available tables: logs.workersLogs")
  );
});

test("non-SELECT is rejected", async () => {
  const { binding } = fakeBinding(() => []);
  const out = await createAnalyticsSQLToolkit({ binding, catalog }).query({
    sql: "DROP TABLE logs.workersLogs"
  });
  assert.ok(!out.ok);
});

test("unionCatalogs merges presets that share a table", () => {
  const a = applyPreset(catalog, {
    description: "a",
    tables: ["logs.workersLogs"],
    columns: { "logs.workersLogs": ["httpStatus"] }
  });
  const b = applyPreset(catalog, {
    description: "b",
    tables: ["logs.*"],
    columns: { "logs.workersLogs": ["scriptName"] }
  });
  const u = unionCatalogs([a, b]);
  assert.deepEqual(
    u.tables.map((t) => t.name),
    ["logs.workersLogs", "logs.traces"]
  );
  assert.deepEqual(u.tables[0]!.columns.map((c) => c.name).toSorted(), [
    "httpStatus",
    "sampleInterval",
    "scriptName",
    "timestamp"
  ]);
});

test("generated module is importable and drives the AI SDK tools (build → runtime round trip)", async () => {
  // Arrange: build step
  const subset = applyPreset(catalog, {
    description: "x",
    tables: ["logs.workersLogs"],
    excludeColumns: ["accountTag"]
  });
  const file = join(
    mkdtempSync(join(tmpdir(), "asql-")),
    "analytics-catalog.ts"
  );
  writeFileSync(file, catalogToModule(subset, "asql render --test"));

  // Act: runtime step
  const { catalog: generated } = (await import(pathToFileURL(file).href)) as {
    catalog: typeof subset;
  };
  const { tools } = analyticsSQLTools({
    binding: fakeBinding(() => []).binding,
    catalog: generated
  });

  // Assert
  assert.equal(renderCatalog(generated), renderCatalog(subset));
  assert.deepEqual(Object.keys(tools), ["analytics_query"]); // small subset → schema inlined, no describe tool
  assert.match(
    String(tools.analytics_query!.description),
    /## logs\.workersLogs[\s\S]*httpStatus Int64/
  );
  assert.doesNotMatch(
    String(tools.analytics_query!.description),
    /^- accountTag |logs\.traces/m
  );
});
