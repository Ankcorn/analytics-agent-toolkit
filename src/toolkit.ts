import {
  type Catalog,
  type CatalogSearch,
  type RenderMode,
  renderCatalog,
  renderTableIndex,
  searchCatalog
} from "./catalog";
import { ensureLimit, outerLimit, referencedParams, resolveTime } from "./sql";

/**
 * Structural type of the Workers `AnalyticsSQLBinding` so the package doesn't
 * depend on ambient `@cloudflare/workers-types`.
 */
export interface AnalyticsSQLLike {
  query<T extends Record<string, unknown> = Record<string, unknown>>(request: {
    query: string;
    params?:
      | readonly (string | number | boolean | null)[]
      | Readonly<Record<string, string | number | boolean | null>>;
  }): Promise<{
    data: T[];
    rows: number;
    statistics?: { elapsed_ms: number; rows_read: number; bytes_read: number };
  }>;
}

export type Param = string | number | boolean | null;

export interface AnalyticsSQLToolkitOptions {
  /** The binding, or a getter (handy inside DOs / when `env` is only available per request). */
  binding: AnalyticsSQLLike | (() => AnalyticsSQLLike);
  /** The generated catalog subset (`import { catalog } from "./analytics-catalog"`). */
  catalog: Catalog;
  /** Max rows returned to the model. Default 100. */
  maxRows?: number;
  /** Max characters of serialized rows returned to the model. Default 16_000. */
  maxResultChars?: number;
  /** Default window for `$start` / `$end` when the caller gives none. Default 1h. */
  defaultLookbackMs?: number;
}

export interface QueryInput {
  sql: string;
  /** ISO 8601 or relative (`-15m`, `-1h`, `-7d`). Bound to `$start`. Default: now - defaultLookback. */
  start?: string;
  /** ISO 8601, relative, or `now`. Bound to `$end`. Default: now. */
  end?: string;
  /** Extra named parameters, referenced as `$name`. */
  params?: Record<string, Param>;
}

export type QueryOutput =
  | {
      ok: true;
      rows: Record<string, unknown>[];
      rowCount: number;
      truncated: boolean;
      statistics?: {
        elapsed_ms: number;
        rows_read: number;
        bytes_read: number;
      };
      window: { start: string; end: string };
      warnings?: string[];
    }
  | { ok: false; error: string; hint?: string };

export interface AnalyticsSQLToolkit {
  readonly catalog: Catalog;
  /** Text for a system prompt / tool description. */
  renderCatalog(mode?: RenderMode): string;
  /**
   * The query tool's description: how to work, the dialect rules and a
   * one-line-per-table index. Columns come from the catalog search tool.
   */
  queryToolDescription(catalogTool: string): string;
  /** Search the catalog (what the catalog search tool runs). */
  search(input: CatalogSearch): string;
  query(input: QueryInput): Promise<QueryOutput>;
}

export function queryToolDescription(
  catalog: Catalog,
  catalogTool: string
): string {
  return [
    "Run a read-only SQL query against Cloudflare analytics data (DataFusion parser, ClickHouse-style functions).",
    `Before writing SQL, call ${catalogTool} to get the columns: { table: "<name>" } for a table's full definition, or { query: "<words>" } to find columns. Skip it only if you already have the columns from earlier in this conversation. SHOW TABLES / DESCRIBE are not available.`,
    "Always filter on the table's time column using the $start and $end parameters, e.g. `WHERE timestamp >= $start AND timestamp < $end`; set the window with the start/end arguments (ISO 8601 or relative like -1h, -7d).",
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

export function createAnalyticsSQLToolkit(
  options: AnalyticsSQLToolkitOptions
): AnalyticsSQLToolkit {
  const maxRows = options.maxRows ?? 100;
  const maxChars = options.maxResultChars ?? 16_000;
  const lookback = options.defaultLookbackMs ?? 3_600_000;
  const getBinding =
    typeof options.binding === "function"
      ? options.binding
      : () => options.binding as AnalyticsSQLLike;

  const c = options.catalog;

  async function query(input: QueryInput): Promise<QueryOutput> {
    // Sent as written, apart from a trailing ';' and (for SELECT/WITH) a LIMIT.
    let sql = input.sql.trim().replace(/;\s*$/, "");
    const warnings: string[] = [];

    if (/^(select|with)\b/i.test(sql)) sql = ensureLimit(sql, maxRows + 1);

    let window: { start: string; end: string };
    try {
      const now = new Date();
      window = {
        start: resolveTime(
          input.start,
          new Date(now.getTime() - lookback),
          now
        ),
        end: resolveTime(input.end, now, now)
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    // Only bind parameters the query references; unknown params may be rejected by the backend.
    const all: Record<string, Param> = {
      start: window.start,
      end: window.end,
      ...input.params
    };
    const used = referencedParams(sql);
    const params = Object.fromEntries(
      Object.entries(all).filter(([k]) => used.includes(k))
    );
    const unbound = used.filter((k) => !(k in params));
    if (unbound.length)
      return {
        ok: false,
        error: `Unbound parameter(s): ${unbound.map((k) => `$${k}`).join(", ")}`,
        hint: "Pass them in `params`."
      };

    try {
      const result = await getBinding().query({ query: sql, params });
      let rows = result.data.slice(0, maxRows);
      let truncated = result.data.length > maxRows;
      // Char budget: drop rows from the end until it fits.
      while (rows.length > 1 && JSON.stringify(rows).length > maxChars) {
        rows = rows.slice(0, Math.floor(rows.length * 0.7));
        truncated = true;
      }
      const limit = outerLimit(sql);
      if (truncated)
        warnings.push(
          `Result truncated to ${rows.length} rows; aggregate or add a smaller LIMIT.`
        );
      else if (limit && limit <= maxRows && result.data.length >= limit)
        warnings.push(
          `Result hit LIMIT ${limit}: these are only the top rows, so don't sum them as a total. Run an aggregate query for totals.`
        );
      return {
        ok: true,
        rows,
        rowCount: rows.length,
        truncated,
        statistics: result.statistics,
        window,
        ...(warnings.length ? { warnings } : {})
      };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, error };
    }
  }

  return {
    catalog: c,
    renderCatalog: (mode = "full") => renderCatalog(c, mode),
    queryToolDescription: (catalogTool) => queryToolDescription(c, catalogTool),
    search: (input) => searchCatalog(c, input),
    query
  };
}

/** Compact text rendering of a query result for the model (TSV is ~2x cheaper than JSON). */
export function formatQueryOutput(out: QueryOutput): string {
  if (!out.ok)
    return `ERROR: ${out.error}${out.hint ? `\nHINT: ${out.hint}` : ""}`;
  const header = `${out.rowCount} row(s), window ${out.window.start} → ${out.window.end}${
    out.statistics
      ? `, ${out.statistics.elapsed_ms}ms, ${out.statistics.rows_read} rows read`
      : ""
  }`;
  const warn = out.warnings?.length
    ? `\n${out.warnings.map((w) => `WARNING: ${w}`).join("\n")}`
    : "";
  if (out.rows.length === 0) return `${header}${warn}\n(no rows)`;
  const cols = [...new Set(out.rows.flatMap((r) => Object.keys(r)))];
  const body = [
    cols.join("\t"),
    ...out.rows.map((r) => cols.map((c) => cell(r[c])).join("\t"))
  ].join("\n");
  return `${header}${warn}\n${body}`;
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
