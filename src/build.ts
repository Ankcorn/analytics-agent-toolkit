/**
 * BUILD TIME ONLY (used by the `asql` CLI, never bundled into a Worker).
 *
 * introspection JSON ──catalogFromIntrospection──► full catalog
 *                     ──selectCatalog(presets/filters)──► subset
 *                     ──catalogToModule──► src/analytics-catalog.ts (what the Worker imports)
 */
import type {
  Catalog,
  ColumnDef,
  DatasetKind,
  ExampleQuery,
  TableDef
} from "./catalog";

// ---------------------------------------------------------------------------
// Introspection (`cf analytics sql introspection get --include-columns`)

export interface IntrospectionResponse {
  datasets: {
    name: string;
    title?: string;
    category?: string;
    description?: string;
    kind?: Partial<
      Record<
        DatasetKind,
        { sampling?: "adaptive" | "unsampled"; valid_aggregations?: string[] }
      >
    >;
    hidden?: boolean;
    columns?: {
      name: string;
      description?: string;
      data_type: string;
      hidden?: boolean;
    }[];
  }[];
}

/** Dialect facts checked against production (Oct 2026): DataFusion parser/planner, ClickHouse-style functions. */
export const DIALECT_NOTES: readonly string[] = [
  "SQL is parsed by DataFusion with ClickHouse-style functions. SHOW, DESCRIBE, system.* and information_schema are NOT available — use this schema.",
  'Double-quote camelCase identifiers to be safe: "httpStatus", "scriptName".',
  "Time buckets: toStartOfInterval(timestamp, INTERVAL 5 MINUTE). (date_bin is not available.)",
  'Adaptively sampled datasets have a sampleInterval column: estimate counts with sum("sampleInterval"), conditional counts with sumIf("sampleInterval", cond), percentiles with quantileWeighted(0.99, col, "sampleInterval"). count() gives sampled rows only.',
  "Not supported: quantile(), median(), approx_percentile_cont(), uniq(), ORDER BY inside aggregates, and DISTINCT aggregates on sampled datasets.",
  "Data is already scoped to your account; don't filter on accountTag."
];

export function catalogFromIntrospection(
  response: IntrospectionResponse
): Catalog {
  const tables: TableDef[] = [];
  for (const d of response.datasets) {
    if (d.hidden) continue;
    const columns: ColumnDef[] = (d.columns ?? []).map((c) => ({
      name: c.name,
      type: c.data_type,
      ...(c.description ? { description: c.description } : {}),
      ...(c.hidden ? { hidden: true } : {})
    }));
    const kindName = d.kind
      ? (Object.keys(d.kind)[0] as DatasetKind | undefined)
      : undefined;
    const kind = kindName ? d.kind?.[kindName] : undefined;
    tables.push({
      name: d.name,
      ...(d.title ? { title: d.title } : {}),
      ...(d.category ? { category: d.category } : {}),
      description: d.description ?? d.title ?? "",
      timeColumn: pickTimeColumn(columns),
      columns,
      ...(kindName ? { kind: kindName } : {}),
      ...(kind?.sampling ? { sampling: kind.sampling } : {}),
      ...(kind?.valid_aggregations
        ? { validAggregations: kind.valid_aggregations }
        : {})
    });
  }
  return { notes: DIALECT_NOTES, tables };
}

function pickTimeColumn(columns: readonly ColumnDef[]): string {
  for (const name of ["timestamp", "datetime", "time", "date"])
    if (columns.some((c) => c.name === name)) return name;
  return (
    columns.find((c) => c.type.startsWith("DateTime") && /start/i.test(c.name))
      ?.name ??
    columns.find((c) => c.type.startsWith("DateTime"))?.name ??
    "timestamp"
  );
}

// ---------------------------------------------------------------------------
// Presets and filters

export interface CatalogFilter {
  /** Table name globs: `logs.*`, `events.r2*`. */
  tables?: readonly string[];
  /** Introspection categories, e.g. "Storage" (case-insensitive). */
  categories?: readonly string[];
  kinds?: readonly DatasetKind[];
  /** Substring over table/column names and descriptions. */
  search?: string;
  /** Per-table column allow-list (table glob → column globs). Time column and sampleInterval are always kept. */
  columns?: Readonly<Record<string, readonly string[]>>;
  /** Column globs removed everywhere, e.g. ["accountTag"]. */
  excludeColumns?: readonly string[];
  /** Keep columns introspection marks hidden. Default false. */
  includeHidden?: boolean;
}

export interface Preset extends CatalogFilter {
  description: string;
  notes?: readonly string[];
  /** Verified example queries per table. */
  examples?: Readonly<Record<string, readonly ExampleQuery[]>>;
  tableNotes?: Readonly<Record<string, readonly string[]>>;
}

export type Presets = Readonly<Record<string, Preset>>;

export function filterCatalog(
  catalog: Catalog,
  filter: CatalogFilter = {}
): Catalog {
  const tableRes = filter.tables?.map(glob);
  const cats = filter.categories?.map((c) => c.toLowerCase());
  const exclude = filter.excludeColumns?.map(glob) ?? [];
  const colRules = Object.entries(filter.columns ?? {}).map(
    ([t, cols]) => [glob(t), cols.map(glob)] as const
  );
  const needle = filter.search?.toLowerCase();

  const tables: TableDef[] = [];
  for (const t of catalog.tables) {
    if (tableRes && !tableRes.some((re) => re.test(t.name))) continue;
    if (cats && !cats.includes((t.category ?? "").toLowerCase())) continue;
    if (filter.kinds && (!t.kind || !filter.kinds.includes(t.kind))) continue;
    if (
      needle &&
      ![
        t.name,
        t.title,
        t.description,
        ...t.columns.flatMap((c) => [c.name, c.description])
      ].some((s) => s?.toLowerCase().includes(needle))
    )
      continue;

    const allow = colRules.find(([re]) => re.test(t.name))?.[1];
    const keep = (name: string) =>
      name === t.timeColumn || name === "sampleInterval";
    const columns = t.columns.filter(
      (c) =>
        (filter.includeHidden || !c.hidden || keep(c.name)) &&
        !exclude.some((re) => re.test(c.name)) &&
        (!allow || keep(c.name) || allow.some((re) => re.test(c.name)))
    );
    tables.push({ ...t, columns });
  }
  return { ...catalog, tables };
}

export function applyPreset(catalog: Catalog, preset: Preset): Catalog {
  const filtered = filterCatalog(catalog, preset);
  return {
    notes: [...(filtered.notes ?? []), ...(preset.notes ?? [])],
    tables: filtered.tables.map((t) => {
      const examples = preset.examples?.[t.name];
      const notes = preset.tableNotes?.[t.name];
      return {
        ...t,
        ...(examples ? { examples } : {}),
        ...(notes ? { notes } : {})
      };
    })
  };
}

/** Merge catalogs (e.g. several presets). A table in more than one gets the union of columns/notes/examples. */
export function unionCatalogs(parts: readonly Catalog[]): Catalog {
  const tables = new Map<string, TableDef>();
  for (const t of parts.flatMap((p) => p.tables)) {
    const prev = tables.get(t.name);
    if (!prev) {
      tables.set(t.name, t);
      continue;
    }
    const cols = new Map(
      [...prev.columns, ...t.columns].map((c) => [c.name, c])
    );
    const examples = dedupeBy(
      [...(prev.examples ?? []), ...(t.examples ?? [])],
      (e) => e.sql
    );
    const notes = [...new Set([...(prev.notes ?? []), ...(t.notes ?? [])])];
    tables.set(t.name, {
      ...prev,
      columns: [...cols.values()],
      ...(examples.length ? { examples } : {}),
      ...(notes.length ? { notes } : {})
    });
  }
  return {
    notes: [...new Set(parts.flatMap((p) => p.notes ?? []))],
    tables: [...tables.values()]
  };
}

// ---------------------------------------------------------------------------
// Codegen

/**
 * Emit the catalog as a self-contained TS module (no imports, `as const`) so a
 * Worker can import it with zero coupling to the build tooling.
 */
export function catalogToModule(catalog: Catalog, generatedBy: string): string {
  // Strip build-only metadata the runtime doesn't need.
  const slim: Catalog = {
    ...catalog,
    tables: catalog.tables.map(({ category: _c, ...t }) => ({
      ...t,
      columns: t.columns.map(({ hidden: _h, ...c }) => c)
    }))
  };
  const j = JSON.stringify;
  const table = (t: TableDef) => {
    const { columns, ...rest } = t;
    const fields = Object.entries(rest).map(([k, v]) => `\t\t\t${k}: ${j(v)},`);
    return [
      "\t\t{",
      ...fields,
      "\t\t\tcolumns: [",
      ...columns.map((c) => `\t\t\t\t${j(c)},`),
      "\t\t\t],",
      "\t\t},"
    ].join("\n");
  };
  return [
    "// Generated by `asql` — do not edit. Regenerate with:",
    `//   ${generatedBy}`,
    "",
    "export const catalog = {",
    `\tnotes: [\n${(slim.notes ?? []).map((n) => `\t\t${j(n)},`).join("\n")}\n\t],`,
    `\ttables: [\n${slim.tables.map(table).join("\n")}\n\t],`,
    "} as const;",
    ""
  ].join("\n");
}

function glob(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "i"
  );
}

function dedupeBy<T>(xs: readonly T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) =>
    seen.has(key(x)) ? false : (seen.add(key(x)), true)
  );
}
