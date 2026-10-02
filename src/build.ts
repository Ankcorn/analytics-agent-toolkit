/**
 * BUILD TIME ONLY (used by the `asql` CLI, never bundled into a Worker).
 *
 * introspection JSON ──catalogFromIntrospection──► full catalog
 *                     ──applyPreset / filterCatalog──► subset
 *                     ──catalogToModule──► src/analytics-catalog.ts (what the Worker imports)
 */
import type { Catalog, ColumnDef, ExampleQuery, TableDef } from "./catalog";

type DatasetKind = "events" | "logs" | "states";

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
/** How to query correctly, checked against production (Oct 2026). Included in every catalog. */
export const DIALECT_NOTES: readonly string[] = [
  'Double-quote camelCase identifiers to be safe: "httpStatus", "scriptName".',
  "Time buckets: toStartOfInterval(timestamp, INTERVAL 5 MINUTE).",
  'Adaptively sampled datasets have a sampleInterval column: estimate counts with sum("sampleInterval"), conditional counts with sumIf("sampleInterval", cond), percentiles with quantileWeighted(0.99, col, "sampleInterval"). count() gives sampled rows only. Call sum("sampleInterval") results estimated events, not sampled events; when an estimate is small, add count() to show how many rows it rests on.',
  "Data is already scoped to your account; don't filter on accountTag."
];

export function catalogFromIntrospection(
  response: IntrospectionResponse
): Catalog {
  const tables: TableDef[] = [];
  for (const d of response.datasets) {
    if (d.hidden) continue;
    const columns: ColumnDef[] = (d.columns ?? [])
      .filter((c) => !c.hidden)
      .map((c) => ({
        name: c.name,
        type: c.data_type,
        ...(c.description ? { description: c.description } : {})
      }));
    const kindName = d.kind
      ? (Object.keys(d.kind)[0] as DatasetKind | undefined)
      : undefined;
    const kind = kindName ? d.kind?.[kindName] : undefined;
    tables.push({
      name: d.name,
      ...(d.title ? { title: d.title } : {}),
      description: d.description ?? d.title ?? "",
      timeColumn: pickTimeColumn(columns),
      columns,
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
  /** Per-table column allow-list (table glob → column globs). Time column and sampleInterval are always kept. */
  columns?: Readonly<Record<string, readonly string[]>>;
  /** Column globs removed everywhere, e.g. ["accountTag"]. */
  excludeColumns?: readonly string[];
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
  const exclude = filter.excludeColumns?.map(glob) ?? [];
  const colRules = Object.entries(filter.columns ?? {}).map(
    ([t, cols]) => [glob(t), cols.map(glob)] as const
  );
  const tables: TableDef[] = [];
  for (const t of catalog.tables) {
    if (tableRes && !tableRes.some((re) => re.test(t.name))) continue;
    const allow = colRules.find(([re]) => re.test(t.name))?.[1];
    const keep = (name: string) =>
      name === t.timeColumn || name === "sampleInterval";
    const columns = t.columns.filter(
      (c) =>
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

// ---------------------------------------------------------------------------
// Codegen

/**
 * Emit the catalog as a self-contained TS module (no imports, `as const`) so a
 * Worker can import it with zero coupling to the build tooling.
 */
export function catalogToModule(catalog: Catalog, generatedBy: string): string {
  return [
    "// Generated by `asql` — do not edit. Regenerate with:",
    `//   ${generatedBy}`,
    "",
    `export const catalog = ${JSON.stringify(catalog, null, 2)} as const;`,
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
