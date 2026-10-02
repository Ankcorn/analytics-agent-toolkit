import {
  type Catalog,
  type RenderMode,
  type TableDef,
  closest,
  findTable,
  renderCatalog,
  renderTable,
  renderTableIndex
} from "./catalog";
import {
  ensureLimit,
  guardReadOnly,
  parseMetaCommand,
  referencedTables,
  resolveTime,
  unknownIdentifier
} from "./sql";

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
  /** What to do when a query doesn't filter on the table's time column. Default "error". */
  timeFilter?: "error" | "warn" | "off";
  /** Reject tables not in the catalog. Default true. */
  strictTables?: boolean;
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
      kind: "rows";
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
  | { ok: true; kind: "catalog"; text: string; note: string }
  | { ok: false; error: string; hint?: string };

export interface AnalyticsSQLToolkit {
  readonly catalog: Catalog;
  /** Text for a system prompt / tool description. */
  renderCatalog(mode?: RenderMode): string;
  describeTables(names: readonly string[]): string;
  query(input: QueryInput): Promise<QueryOutput>;
}

export const QUERY_TOOL_DESCRIPTION: string = [
  "Run a read-only SQL query against Cloudflare analytics data (DataFusion parser, ClickHouse-style functions).",
  "SHOW TABLES / DESCRIBE are not supported by the backend; use the schema provided (or the describe tool) instead.",
  "Always filter on the table's time column using the $start and $end parameters, e.g. `WHERE timestamp >= $start AND timestamp < $end`; set the window with the start/end arguments (ISO 8601 or relative like -1h, -7d).",
  'Aggregate in SQL rather than pulling raw rows; results are truncated. On sampled tables use sum("sampleInterval") for counts and quantileWeighted(0.99, col, "sampleInterval") for percentiles.'
].join("\n");

export function createAnalyticsSQLToolkit(
  options: AnalyticsSQLToolkitOptions
): AnalyticsSQLToolkit {
  const maxRows = options.maxRows ?? 100;
  const maxChars = options.maxResultChars ?? 16_000;
  const timeFilter = options.timeFilter ?? "error";
  const strict = options.strictTables ?? true;
  const lookback = options.defaultLookbackMs ?? 3_600_000;
  const getBinding =
    typeof options.binding === "function"
      ? options.binding
      : () => options.binding as AnalyticsSQLLike;

  const c = options.catalog;
  const listTables = () => c.tables.map(renderTableIndex).join("\n");

  function describeTables(names: readonly string[]) {
    if (names.length === 0) return renderCatalog(c, "full");
    return names
      .map((n) => {
        const t = findTable(c, n);
        if (t) return renderTable(t);
        const suggestions = closest(
          n,
          c.tables.map((x) => x.name)
        );
        return `Unknown table "${n}".${suggestions.length ? ` Did you mean ${suggestions.join(", ")}?` : ""} Available: ${c.tables.map((x) => x.name).join(", ")}`;
      })
      .join("\n\n");
  }

  async function query(input: QueryInput): Promise<QueryOutput> {
    const meta = parseMetaCommand(input.sql);
    if (meta) {
      const text =
        meta.kind === "show_tables"
          ? listTables()
          : describeTables([meta.table]);
      return {
        ok: true,
        kind: "catalog",
        text,
        note: "Answered from the local catalog: SHOW/DESCRIBE are not supported by Analytics SQL. Now write a SELECT."
      };
    }

    const guarded = guardReadOnly(input.sql);
    if (!guarded.ok) return { ok: false, error: guarded.error };
    let sql = guarded.sql;

    const tables: TableDef[] = [];
    for (const name of referencedTables(sql)) {
      const t = findTable(c, name);
      if (t) tables.push(t);
      else if (strict) {
        const s = closest(
          name,
          c.tables.map((x) => x.name)
        );
        return {
          ok: false,
          error: `Table "${name}" is not in the catalog.`,
          hint: `${s.length ? `Did you mean ${s.join(", ")}? ` : ""}Available tables:\n${listTables()}`
        };
      }
    }

    const warnings: string[] = [];
    if (timeFilter !== "off") {
      const missing = tables.filter(
        (t) => !new RegExp(`\\b${escapeRe(t.timeColumn)}\\b`, "i").test(sql)
      );
      if (missing.length) {
        const msg = `Query does not filter on the time column of ${missing.map((t) => `${t.name} (${t.timeColumn})`).join(", ")}.`;
        const hint = `Add e.g. \`WHERE ${missing[0]!.timeColumn} >= $start AND ${missing[0]!.timeColumn} < $end\` and pass start/end.`;
        if (timeFilter === "error") return { ok: false, error: msg, hint };
        warnings.push(`${msg} ${hint}`);
      }
    }

    sql = ensureLimit(sql, maxRows + 1);

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
    const params = Object.fromEntries(
      Object.entries(all).filter(([k]) =>
        new RegExp(`\\$${escapeRe(k)}\\b`).test(sql)
      )
    );
    const unbound = [...sql.matchAll(/\$(\w+)/g)]
      .map((m) => m[1]!)
      .filter((k) => !(k in params));
    if (unbound.length)
      return {
        ok: false,
        error: `Unbound parameter(s): ${[...new Set(unbound)].map((k) => `$${k}`).join(", ")}`,
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
      if (truncated)
        warnings.push(
          `Result truncated to ${rows.length} rows; aggregate or add a smaller LIMIT.`
        );
      return {
        ok: true,
        kind: "rows",
        rows,
        rowCount: rows.length,
        truncated,
        statistics: result.statistics,
        window,
        ...(warnings.length ? { warnings } : {})
      };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, error, hint: hintForError(error, tables, c) };
    }
  }

  return {
    catalog: c,
    renderCatalog: (mode = "full") => renderCatalog(c, mode),
    describeTables,
    query
  };
}

function hintForError(
  error: string,
  tables: TableDef[],
  catalog: Catalog
): string | undefined {
  const ident = unknownIdentifier(error);
  if (ident?.kind === "column") {
    const scope = tables.length ? tables : catalog.tables;
    const cols = scope.flatMap((t) => t.columns.map((c) => c.name));
    const s = closest(ident.name, cols);
    return [
      s.length
        ? `Unknown column "${ident.name}". Did you mean ${s.join(", ")}?`
        : `Unknown column "${ident.name}".`,
      ...scope.map(
        (t) =>
          `Columns of ${t.name}: ${t.columns.map((c) => c.name).join(", ")}`
      )
    ].join("\n");
  }
  if (ident?.kind === "table") {
    return `Available tables: ${catalog.tables.map((t) => t.name).join(", ")}`;
  }
  if (tables.length) {
    return `Check column names and types against the schema:\n${tables.map(renderTable).join("\n\n")}`;
  }
  return undefined;
}

/** Compact text rendering of a query result for the model (TSV is ~2x cheaper than JSON). */
export function formatQueryOutput(out: QueryOutput): string {
  if (!out.ok)
    return `ERROR: ${out.error}${out.hint ? `\nHINT: ${out.hint}` : ""}`;
  if (out.kind === "catalog") return `${out.note}\n\n${out.text}`;
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
