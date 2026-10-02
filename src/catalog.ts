/**
 * The catalog is the workaround for `SHOW TABLES` / `DESCRIBE TABLE` not being
 * available through the Analytics SQL binding. It is generated at build time by
 * `asql render --out` (introspection → presets/filters → TS module) and passed
 * to the AI SDK / Pi tools at runtime. The query tool also answers SHOW/DESCRIBE
 * locally from it.
 */

export interface ColumnDef {
  name: string;
  /** ClickHouse-ish type, e.g. `DateTime64(3)`, `UInt16`, `String`, `Map(String, String)`. */
  type: string;
  description?: string;
  /** Known/allowed values or representative samples. Rendered as hints. */
  values?: readonly (string | number)[];
  /** Marked hidden by introspection; dropped by `filterCatalog` unless `includeHidden`. */
  hidden?: boolean;
}

export type DatasetKind = "events" | "logs" | "states";

export interface ExampleQuery {
  question: string;
  sql: string;
}

export interface TableDef {
  /** Fully-qualified table name, e.g. `logs.workersLogs`. */
  name: string;
  description: string;
  /** Column every query should filter on (e.g. `timestamp`). */
  timeColumn: string;
  columns: readonly ColumnDef[];
  examples?: readonly ExampleQuery[];
  notes?: readonly string[];
  title?: string;
  /** Introspection category, e.g. "Storage", "Logs and Traces". */
  category?: string;
  kind?: DatasetKind;
  sampling?: "adaptive" | "unsampled";
  /** For `states` datasets: the aggregations the backend accepts. */
  validAggregations?: readonly string[];
}

export interface Catalog {
  /** Free-form notes on dialect quirks, applied to all tables. */
  notes?: readonly string[];
  tables: readonly TableDef[];
}

export function findTable(
  catalog: Catalog,
  name: string
): TableDef | undefined {
  const needle = normalizeIdent(name);
  return (
    catalog.tables.find((t) => normalizeIdent(t.name) === needle) ??
    // allow unqualified names when unambiguous: `workersLogs` -> `logs.workersLogs`
    single(
      catalog.tables.filter(
        (t) => normalizeIdent(t.name).split(".").pop() === needle
      )
    )
  );
}

export type RenderMode =
  /** Every table with every column. Best when the catalog is small. */
  | "full"
  /** Only table names, descriptions and time columns. Pair with a describe tool. */
  | "index";

export function renderCatalog(
  catalog: Catalog,
  mode: RenderMode = "full"
): string {
  const parts: string[] = [];
  if (catalog.notes?.length)
    parts.push(catalog.notes.map((n) => `- ${n}`).join("\n"));
  if (mode === "index")
    parts.push(catalog.tables.map(renderTableIndex).join("\n"));
  else for (const table of catalog.tables) parts.push(renderTable(table));
  return parts.join("\n\n");
}

export function renderTableIndex(table: TableDef): string {
  const tags = [
    `time: ${table.timeColumn}`,
    table.sampling === "adaptive" ? "sampled" : undefined,
    `${table.columns.length} cols`
  ]
    .filter(Boolean)
    .join(", ");
  return `- ${table.name} (${tags}): ${table.description}`;
}

export function renderTable(table: TableDef): string {
  const lines = [
    `## ${table.name}${table.title ? ` — ${table.title}` : ""}`,
    table.description,
    `Time column: ${table.timeColumn} (always filter on it)`
  ];
  if (table.sampling === "adaptive")
    lines.push("Adaptively sampled: weight by sampleInterval (see notes).");
  if (table.validAggregations?.length)
    lines.push(`Valid aggregations: ${table.validAggregations.join(", ")}`);
  lines.push("Columns:");
  for (const c of table.columns) {
    let line = `- ${c.name} ${c.type}`;
    if (c.description) line += ` — ${c.description}`;
    if (c.values?.length)
      line += ` (e.g. ${c.values
        .slice(0, 8)
        .map((v) => JSON.stringify(v))
        .join(", ")})`;
    lines.push(line);
  }
  if (table.notes?.length)
    lines.push("Notes:", ...table.notes.map((n) => `- ${n}`));
  if (table.examples?.length) {
    lines.push("Examples:");
    for (const e of table.examples)
      lines.push(`-- ${e.question}`, e.sql.trim());
  }
  return lines.join("\n");
}

export function normalizeIdent(name: string): string {
  return name.replace(/[`"]/g, "").trim().toLowerCase();
}

function single<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

/** Levenshtein-based "did you mean" for column/table typos. */
export function closest(
  needle: string,
  candidates: readonly string[],
  max = 3
): string[] {
  const n = needle.toLowerCase();
  return candidates
    .map((c) => ({ c, d: distance(n, c.toLowerCase()) }))
    .filter(
      ({ c, d }) =>
        d <= Math.max(2, Math.floor(c.length / 3)) ||
        c.toLowerCase().includes(n) ||
        n.includes(c.toLowerCase())
    )
    .toSorted((a, b) => a.d - b.d)
    .slice(0, max)
    .map(({ c }) => c);
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(
        dp[j]! + 1,
        dp[j - 1]! + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[b.length]!;
}
