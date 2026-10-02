import {
  type Catalog,
  type CatalogSearch,
  renderTableIndex,
  searchCatalog
} from "./catalog";

/**
 * Structural type of the Workers `AnalyticsSQLBinding` so the package doesn't
 * depend on ambient `@cloudflare/workers-types`.
 */
export interface AnalyticsSQLLike {
  query(request: {
    query: string;
  }): Promise<{ data: Record<string, unknown>[] }>;
}

export interface AnalyticsSQLToolkitOptions {
  /** The Analytics SQL binding, e.g. `env.ANALYTICS`. */
  binding: AnalyticsSQLLike;
  /** The generated catalog (`import { catalog } from "./analytics-catalog"`). */
  catalog: Catalog;
  /** Max rows returned to the model. Default 100. */
  maxRows?: number;
  /** Max characters of serialized rows returned to the model. Default 16_000. */
  maxResultChars?: number;
}

export interface QueryInput {
  sql: string;
}

export type QueryOutput =
  | { ok: true; rows: Record<string, unknown>[]; truncated: boolean }
  | { ok: false; error: string };

/** What both tools run, for wiring into another agent framework. */
export interface AnalyticsSQLToolkit {
  /** Description for the `analytics_query` tool: how to work, dialect notes and a table index. */
  readonly queryDescription: string;
  /** Run SQL as written. */
  query(input: QueryInput): Promise<QueryOutput>;
  /** What the `analytics_catalog` tool runs. */
  search(input: CatalogSearch): string;
}

export function createAnalyticsSQLToolkit({
  binding,
  catalog,
  maxRows = 100,
  maxResultChars = 16_000
}: AnalyticsSQLToolkitOptions): AnalyticsSQLToolkit {
  return {
    queryDescription: queryDescription(catalog),
    search: (input) => searchCatalog(catalog, input),
    // Only the result is changed: cut down to fit the model's context.
    async query({ sql }) {
      try {
        const { data } = await binding.query({ query: sql });
        let rows = data.slice(0, maxRows);
        while (rows.length > 1 && JSON.stringify(rows).length > maxResultChars)
          rows = rows.slice(0, Math.floor(rows.length * 0.7));
        return { ok: true, rows, truncated: rows.length < data.length };
      } catch (cause) {
        return {
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause)
        };
      }
    }
  };
}

function queryDescription(catalog: Catalog): string {
  return [
    "Run a read-only SQL query against Cloudflare analytics data (DataFusion parser, ClickHouse-style functions).",
    'Before writing SQL, call analytics_catalog to get the columns: { table: "<name>" } for a table\'s full definition, or { query: "<words>" } to find columns. Skip it only if you already have the columns from earlier in this conversation. Use it instead of SHOW TABLES / DESCRIBE.',
    "Always filter on the table's time column relative to now(), e.g. `WHERE timestamp >= now() - INTERVAL '1 day'`. ORDER BY needs a LIMIT.",
    'Aggregate in SQL rather than pulling raw rows; results are truncated. On sampled tables use sum("sampleInterval") for counts and quantileWeighted(0.99, col, "sampleInterval") for percentiles.',
    "Never add up rows of a LIMITed or truncated result to report a total: those are only the top rows. Run a separate aggregate query for totals.",
    ...(catalog.notes?.length
      ? ["", "Dialect notes:", ...catalog.notes.map((n) => `- ${n}`)]
      : []),
    "",
    "Tables:",
    ...catalog.tables.map(renderTableIndex)
  ].join("\n");
}

/** Compact text rendering of a query result for the model (TSV is ~2x cheaper than JSON). */
export function formatQueryOutput(out: QueryOutput): string {
  if (!out.ok) return `ERROR: ${out.error}`;
  if (out.rows.length === 0) return "(no rows)";
  const cols = [...new Set(out.rows.flatMap((r) => Object.keys(r)))];
  return [
    ...(out.truncated
      ? [
          `Showing the first ${out.rows.length} rows only. Aggregate in SQL or add a LIMIT.`
        ]
      : []),
    cols.join("\t"),
    ...out.rows.map((r) => cols.map((c) => cell(r[c])).join("\t"))
  ].join("\n");
}

function cell(v: unknown): string {
  const s =
    v === null || v === undefined
      ? "NULL"
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
  return s.replace(/[\t\n]/g, " ");
}
