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

test("SHOW TABLES and DESCRIBE are passed to the backend as-is", async () => {
  // Arrange
  const { binding, calls } = fakeBinding(
    () => new Error("SQL error: unsupported statement")
  );
  const tk = createAnalyticsSQLToolkit({ binding, catalog });
  // Act
  const show = await tk.query({ sql: "SHOW TABLES" });
  const desc = await tk.query({ sql: "DESCRIBE logs.workersLogs" });
  // Assert
  assert.deepEqual(
    calls.map((c) => c.query),
    ["SHOW TABLES", "DESCRIBE logs.workersLogs"]
  );
  assert.deepEqual(show, {
    ok: false,
    error: "SQL error: unsupported statement"
  });
  assert.ok(!desc.ok);
});

test("catalog search by table returns its full definition", () => {
  // Arrange
  const tk = createAnalyticsSQLToolkit({
    binding: fakeBinding(() => []).binding,
    catalog
  });
  // Act
  const text = tk.search({ table: "workersLogs" });
  // Assert
  assert.match(text, /logs\.workersLogs/);
  assert.match(text, /httpStatus Int64/);
});

// Hand-written catalog for search: table notes and descriptions that overlap.
const searchable = {
  tables: [
    {
      name: "logs.workersLogs",
      description: "Invocation and custom logs emitted by Cloudflare Workers",
      timeColumn: "timestamp",
      columns: [
        { name: "timestamp", type: "DateTime64(3)" },
        { name: "scriptName", type: "String" },
        {
          name: "level",
          type: "String",
          description: "Log level",
          values: ["info", "error"]
        },
        {
          name: "httpStatus",
          type: "Int64",
          description: "HTTP status code returned by the Worker"
        },
        { name: "statusText", type: "String", description: "Status text" },
        {
          name: "cpuTimeMs",
          type: "UInt32",
          description: "CPU time in milliseconds"
        }
      ],
      notes: ["Filter logType = 'cf-worker-event' for invocations."],
      examples: [{ question: "q", sql: "SELECT 1" }]
    }
  ]
} as const;
const search = (input: { query?: string; table?: string }) =>
  createAnalyticsSQLToolkit({
    binding: fakeBinding(() => []).binding,
    catalog: searchable
  }).search(input);

test("catalog search by words returns matching columns, the time column and the table's notes", () => {
  // Act
  const text = search({ query: "cpu" });
  // Assert
  assert.match(text, /- timestamp DateTime64\(3\)\n- cpuTimeMs/);
  assert.doesNotMatch(text, /scriptName|httpStatus/);
  assert.match(text, /Notes:\n- Filter logType = 'cf-worker-event'/);
  assert.doesNotMatch(text, /Examples:/);
  assert.match(text, /4 more columns: search \{ table: "logs\.workersLogs" \}/);
});

test("catalog search puts columns matching more words first", () => {
  // Act
  const text = search({ query: "status code" });
  // Assert: httpStatus matches both words, statusText only one.
  assert.ok(text.indexOf("httpStatus") < text.indexOf("statusText"));
});

test("catalog search matches plurals and example values", () => {
  // Act
  const text = search({ query: "errors" });
  // Assert
  assert.match(text, /- level String — Log level/);
});

test("a word matching only the table description points at the table instead of dumping it", () => {
  // Act
  const text = search({ query: "cloudflare" });
  // Assert
  assert.match(text, /^- logs\.workersLogs \(time: timestamp/);
  assert.match(
    text,
    /no matching columns: search \{ table: "logs\.workersLogs" \}/
  );
  assert.doesNotMatch(text, /cpuTimeMs/);
});

test("catalog search with no match or no input lists the tables", () => {
  // Arrange
  const tk = createAnalyticsSQLToolkit({
    binding: fakeBinding(() => []).binding,
    catalog
  });
  // Act
  const none = tk.search({ query: "zzzz" });
  const all = tk.search({});
  // Assert
  assert.match(none, /No tables or columns match "zzzz"/);
  assert.match(all, /^Tables:\n- logs\.workersLogs \(time: timestamp/);
});

test("a LIMIT followed by a comment is recognised, so no second LIMIT is added", async () => {
  // Arrange
  const { binding, calls } = fakeBinding(() => []);
  const tk = createAnalyticsSQLToolkit({ binding, catalog });
  const sql =
    "SELECT timestamp FROM logs.workersLogs WHERE timestamp >= $start ORDER BY timestamp LIMIT 10 -- top ten\n/* done */";
  // Act
  await tk.query({ sql });
  // Assert
  assert.equal(calls[0]!.query, sql);
});

test("a result that hits the query's own LIMIT warns that it is only the top rows", async () => {
  // Arrange
  const { binding } = fakeBinding(() => [{ n: 3 }, { n: 2 }]);
  const tk = createAnalyticsSQLToolkit({ binding, catalog });
  // Act
  const full = await tk.query({
    sql: 'SELECT "scriptName", count() AS n FROM logs.workersLogs WHERE timestamp >= $start GROUP BY 1 ORDER BY n DESC LIMIT 2'
  });
  const partial = await tk.query({
    sql: 'SELECT "scriptName", count() AS n FROM logs.workersLogs WHERE timestamp >= $start GROUP BY 1 ORDER BY n DESC LIMIT 5'
  });
  // Assert
  assert.match(formatQueryOutput(full), /WARNING: .*LIMIT 2.*top rows/);
  assert.doesNotMatch(formatQueryOutput(partial), /WARNING/);
});

test("$ inside string literals is not treated as a parameter", async () => {
  // Arrange
  const { binding, calls } = fakeBinding(() => []);
  const tk = createAnalyticsSQLToolkit({ binding, catalog });
  // Act
  const out = await tk.query({
    sql: `SELECT count() AS n FROM logs.workersLogs WHERE timestamp >= $start AND timestamp < $end AND "scriptName" LIKE '%$price%'`
  });
  // Assert
  assert.ok(out.ok, JSON.stringify(out));
  assert.deepEqual(Object.keys(calls[0]!.params as object).toSorted(), [
    "end",
    "start"
  ]);
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
  assert.ok(out.ok && out.rowCount === 100 && out.truncated);
});

test("backend errors are passed through verbatim, without rewriting", async () => {
  // Arrange
  const error =
    "Schema error: No field named status. Valid fields are logs.workersLogs.httpStatus, logs.workersLogs.timestamp.";
  const { binding } = fakeBinding(() => new Error(error));
  const tk = createAnalyticsSQLToolkit({ binding, catalog });
  // Act
  const out = await tk.query({
    sql: "SELECT status FROM logs.workersLogs WHERE timestamp >= $start"
  });
  // Assert
  assert.deepEqual(out, { ok: false, error });
  assert.equal(formatQueryOutput(out), `ERROR: ${error}`);
});

test("a LIMIT inside a subquery doesn't stop the outer query getting one", async () => {
  // Arrange
  const { binding, calls } = fakeBinding(() => []);
  const tk = createAnalyticsSQLToolkit({ binding, catalog, maxRows: 100 });
  // Act
  await tk.query({
    sql: "SELECT * FROM (SELECT timestamp FROM logs.workersLogs WHERE timestamp >= $start LIMIT 5) AS x ORDER BY timestamp"
  });
  // Assert
  assert.match(calls[0]!.query, /ORDER BY timestamp\nLIMIT 101$/);
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
  assert.deepEqual(Object.keys(tools), [
    "analytics_query",
    "analytics_catalog"
  ]);
  const description = String(tools.analytics_query!.description);
  assert.match(description, /^- logs\.workersLogs \(time: timestamp/m);
  assert.doesNotMatch(description, /httpStatus Int64/); // columns come from the catalog tool
  const search = tools.analytics_catalog!.execute as (
    input: { table?: string; query?: string },
    options: unknown
  ) => Promise<string>;
  const columns = await search({ table: "logs.workersLogs" }, {});
  assert.match(String(columns), /httpStatus Int64/);
  assert.doesNotMatch(String(columns), /^- accountTag /m);
});
