/** Light-weight SQL inspection. Not a parser: just enough to bind params and cap rows. */

const TRAILING_LIMIT = /\blimit\s+(\d+)(?:\s+offset\s+\d+)?\s*$/i;
const TRAILING_COMMENTS = /(?:\s*(?:--[^\n]*|\/\*[\s\S]*?\*\/))+\s*$/;

/**
 * The outer query's `LIMIT n`, if any. A LIMIT inside a subquery doesn't
 * count; trailing comments are ignored (for this check only).
 */
export function outerLimit(sql: string): number | undefined {
  const m = TRAILING_LIMIT.exec(sql.replace(TRAILING_COMMENTS, ""));
  return m ? Number(m[1]) : undefined;
}

/** Append `LIMIT n` unless the outer query has one (Analytics SQL requires it with ORDER BY). */
export function ensureLimit(sql: string, limit: number): string {
  return outerLimit(sql) === undefined ? `${sql}\nLIMIT ${limit}` : sql;
}

/** Blank out the contents of '...' string literals so keywords and `$x` inside them are ignored. */
export function stripStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** `$name` parameters referenced outside string literals. */
export function referencedParams(sql: string): string[] {
  return [
    ...new Set([...stripStrings(sql).matchAll(/\$(\w+)/g)].map((m) => m[1]!))
  ];
}

/**
 * Relative or absolute time → ISO string. Accepts `now`, `-15m`, `-1h`, `-7d`,
 * `-30s`, `-2w`, or anything `Date` can parse.
 */
export function resolveTime(
  value: string | undefined,
  fallback: Date,
  now: Date = new Date()
): string {
  if (!value) return fallback.toISOString();
  const v = value.trim();
  if (v === "now") return now.toISOString();
  const rel = /^-?\s*(\d+)\s*(s|m|h|d|w)$/i.exec(v);
  if (rel) {
    const unit = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 }[
      rel[2]!.toLowerCase() as "s" | "m" | "h" | "d" | "w"
    ];
    return new Date(now.getTime() - Number(rel[1]) * unit).toISOString();
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new Error(
      `Cannot parse time "${value}". Use ISO 8601 or relative like -1h.`
    );
  return d.toISOString();
}
