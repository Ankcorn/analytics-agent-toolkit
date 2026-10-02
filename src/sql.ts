/** Light-weight SQL inspection. Not a parser: just enough to guard and to give good hints. */

export type MetaCommand =
  | { kind: "show_tables" }
  | { kind: "describe"; table: string };

/** Strip comments and a trailing semicolon. */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim()
    .replace(/;\s*$/, "")
    .trim();
}

/**
 * Agents reach for `SHOW TABLES` / `DESCRIBE x` first. The binding rejects them,
 * so we recognise them and answer from the catalog instead of failing.
 */
export function parseMetaCommand(sql: string): MetaCommand | undefined {
  const s = normalizeSql(sql);
  if (/^show\s+(full\s+)?tables\b/i.test(s) || /^show\s+databases\b/i.test(s))
    return { kind: "show_tables" };
  if (
    /^select\b[\s\S]*\bfrom\s+(system\.tables|information_schema\.tables)\b/i.test(
      s
    )
  )
    return { kind: "show_tables" };
  const describe =
    /^(?:describe|desc|show\s+columns\s+from|show\s+create\s+table)\s+(?:table\s+)?([\w.`"]+)/i.exec(
      s
    );
  if (describe) return { kind: "describe", table: describe[1]! };
  const infoSchema =
    /^select\b[\s\S]*\bfrom\s+(?:system\.columns|information_schema\.columns)\b[\s\S]*\b(?:table|table_name)\s*=\s*'([\w.]+)'/i.exec(
      s
    );
  if (infoSchema) return { kind: "describe", table: infoSchema[1]! };
  return undefined;
}

export type GuardResult =
  | { ok: true; sql: string }
  | { ok: false; error: string };

export function guardReadOnly(sql: string): GuardResult {
  const s = normalizeSql(sql);
  if (!s) return { ok: false, error: "Query is empty." };
  if (s.includes(";"))
    return {
      ok: false,
      error: "Only a single statement is allowed (remove the ';')."
    };
  if (!/^(select|with)\b/i.test(s))
    return { ok: false, error: "Only SELECT / WITH queries are allowed." };
  return { ok: true, sql: s };
}

/** Append `LIMIT n` when the query has no LIMIT at all. Deliberately conservative. */
export function ensureLimit(sql: string, limit: number): string {
  if (/\blimit\s+\d+/i.test(sql)) return sql;
  return `${sql}\nLIMIT ${limit}`;
}

/** `FROM x` / `JOIN x` targets, ignoring CTE names. */
export function referencedTables(sql: string): string[] {
  const s = normalizeSql(sql);
  const ctes = new Set(
    [...s.matchAll(/(?:with|,)\s*([\w]+)\s+as\s*\(/gi)].map((m) =>
      m[1]!.toLowerCase()
    )
  );
  const tables = [...s.matchAll(/\b(?:from|join)\s+([\w.`"]+)/gi)]
    .map((m) => m[1]!.replace(/[`"]/g, ""))
    .filter((t) => !ctes.has(t.toLowerCase()) && t !== "(");
  return [...new Set(tables)];
}

/** Pull the offending identifier out of common ClickHouse / SQL error messages. */
export function unknownIdentifier(
  error: string
): { kind: "column" | "table"; name: string } | undefined {
  // Analytics SQL (DataFusion) formats, checked against production:
  //   Schema error: No field named status. Valid fields are …
  //   Error during planning: table `logs.workerLogs` not found
  const df = /No field named\s+[`"']?([\w.]+?)[`"']?[.\s]/i.exec(error);
  if (df?.[1]) return { kind: "column", name: df[1].split(".").pop()! };
  const dfTable = /table\s+[`"']([\w.]+)[`"']\s+not found/i.exec(error);
  if (dfTable?.[1]) return { kind: "table", name: dfTable[1] };
  // Generic / ClickHouse formats.
  const table =
    /(?:unknown\s+table|table\s+[\w`'".]*\s*does(?:n't| not)\s+exist|UNKNOWN_TABLE)[^'`"]*['`"]?([\w.]+)['`"]?/i.exec(
      error
    );
  if (table?.[1] && !/^(expression|identifier)$/i.test(table[1]))
    return { kind: "table", name: table[1] };
  const column =
    /(?:unknown\s+(?:expression\s+)?(?:identifier|column)|missing\s+columns?|UNKNOWN_IDENTIFIER|no\s+such\s+column)[^'`"]*['`"]([\w.]+)['`"]/i.exec(
      error
    );
  if (column?.[1]) return { kind: "column", name: column[1].split(".").pop()! };
  return undefined;
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
