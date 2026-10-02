/**
 * The catalog is the workaround for `SHOW TABLES` / `DESCRIBE TABLE` not being
 * available through the Analytics SQL binding. It is generated at build time by
 * `analytics-agent-toolkit render --out` (introspection → preset → TS module) and passed
 * to the AI SDK / Pi tools at runtime, where the agent reads it through the
 * catalog search tool.
 */

export interface ColumnDef {
  name: string;
  /** ClickHouse-ish type, e.g. `DateTime64(3)`, `UInt16`, `String`, `Map(String, String)`. */
  type: string;
  description?: string;
  /** Known/allowed values or representative samples. Rendered as hints. */
  values?: readonly (string | number)[];
}

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
  sampling?: "adaptive" | "unsampled";
  /** For `states` datasets: the aggregations the backend accepts. */
  validAggregations?: readonly string[];
}

export interface Catalog {
  /** Free-form notes on dialect quirks, applied to all tables. */
  notes?: readonly string[];
  tables: readonly TableDef[];
}

/** Every table in full, for previewing what the model can see (`analytics-agent-toolkit render`). */
export function renderCatalog(catalog: Catalog): string {
  return [
    ...(catalog.notes?.length
      ? [catalog.notes.map((n) => `- ${n}`).join("\n")]
      : []),
    ...catalog.tables.map(renderTable)
  ].join("\n\n");
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

/** Input of the catalog search tool. Give `table` for one table's full definition, `query` to search, or neither to list tables. */
export interface CatalogSearch {
  /** Words matched against table and column names and descriptions, e.g. "status code", "cpu time". */
  query?: string;
  /** A full table name, e.g. "logs.workersLogs": returns every column, notes and examples. */
  table?: string;
}

export const CATALOG_SEARCH_DESCRIPTION: string = [
  "Search the catalog of analytics tables you can query (SHOW TABLES / DESCRIBE are not available; use this instead).",
  "Input: { query?: string; table?: string }.",
  '- { table: "logs.workersLogs" } → that table\'s full definition: time column, every column with its type and description, notes and example queries.',
  '- { query: "status code" } → columns whose name, description or example values mention any of the words, best matches first, plus the time column and the table\'s notes.',
  "- {} → one line per table: name, time column, sampling, column count and description."
].join("\n");

/** Lowercase, and drop a plural "s" so "errors" also finds "error". */
function searchTerm(word: string): string {
  const w = word.toLowerCase();
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss")
    ? w.slice(0, -1)
    : w;
}

export function searchCatalog(
  catalog: Catalog,
  { query, table }: CatalogSearch
): string {
  const index = () => catalog.tables.map(renderTableIndex).join("\n");
  if (table) {
    const t = catalog.tables.find((x) => x.name === table);
    return t ? renderTable(t) : `No table "${table}".\nTables:\n${index()}`;
  }
  const terms = [
    ...new Set((query ?? "").split(/\W+/).filter(Boolean).map(searchTerm))
  ];
  if (!terms.length) return `Tables:\n${index()}`;

  /** How many of the terms appear in any of the texts. */
  const score = (...texts: (string | number | undefined)[]) => {
    const hay = texts
      .filter((x) => x !== undefined)
      .join(" ")
      .toLowerCase();
    return terms.filter((term) => hay.includes(term)).length;
  };

  const results: { best: number; text: string }[] = [];
  for (const t of catalog.tables) {
    const matches = t.columns
      .map((c) => ({ c, n: score(c.name, c.description, ...(c.values ?? [])) }))
      .filter((m) => m.n > 0 && m.c.name !== t.timeColumn)
      .toSorted((a, b) => b.n - a.n);
    if (!matches.length) {
      // The table itself matches: point at it rather than dumping every column.
      if (score(t.name, t.title, t.description))
        results.push({
          best: 0,
          text: `${renderTableIndex(t)}\n(no matching columns: search { table: "${t.name}" } for all)`
        });
      continue;
    }
    const time = t.columns.filter((c) => c.name === t.timeColumn);
    const columns = [...time, ...matches.map((m) => m.c)];
    results.push({
      best: matches[0]!.n,
      text: `${renderTable({ ...t, columns, examples: [] })}\n(${t.columns.length - columns.length} more columns: search { table: "${t.name}" } for all)`
    });
  }
  return results.length
    ? results
        .toSorted((a, b) => b.best - a.best)
        .map((r) => r.text)
        .join("\n\n")
    : `No tables or columns match "${query}".\nTables:\n${index()}`;
}
