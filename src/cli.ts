#!/usr/bin/env node
/**
 * asql — build-time catalog tool for Analytics SQL agents.
 *
 *   asql sync                                      # cf introspection → local cache (not bundled)
 *   asql render --preset workers                   # preview what the model will see
 *   asql render --preset workers --out src/analytics-catalog.ts   # generate the runtime subset
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { renderCatalog } from "./catalog";
import {
  type IntrospectionResponse,
  type Presets,
  applyPreset,
  catalogFromIntrospection,
  catalogToModule,
  filterCatalog
} from "./build";

const HELP = `asql — build-time catalog tool for Analytics SQL agents (wraps \`cf\`).

  asql sync [--account <id>]
      Fetch the full catalog via \`cf analytics sql introspection get --include-columns\`
      into ${".cloudflare/analytics-sql/introspection.json"} (local cache, never bundled).

  asql render [--preset <name>] [--table <glob>] [--out <file.ts>]
      Without --out: print the schema text the model will see (+ token estimate).
      With --out:    write it as a TS module exporting \`catalog\` for the AI SDK / Pi tools.

Selection:
  --preset <name>    From ./presets.ts
  --table <glob>     e.g. 'logs.*' (repeatable; narrows a preset if both are given)

Options:
  --cache <path>     Introspection cache (default .cloudflare/analytics-sql/introspection.json)
  --presets <path>   Presets file (default ./presets.ts; .ts needs Node >= 22.18)
  --account <id>     Default $CLOUDFLARE_ACCOUNT_ID, else the single account from \`cf auth whoami\`
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    preset: { type: "string" },
    table: { type: "string", multiple: true },
    out: { type: "string" },
    cache: {
      type: "string",
      default: ".cloudflare/analytics-sql/introspection.json"
    },
    presets: { type: "string", default: "presets.ts" },
    account: { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});

async function main(): Promise<void> {
  const [command] = positionals;
  if (command === "sync") return sync();
  if (command === "render") return render();
  process.stdout.write(HELP);
  if (command && !flags.help) process.exitCode = 1;
}

async function sync(): Promise<void> {
  const account =
    flags.account ??
    process.env.CLOUDFLARE_ACCOUNT_ID ??
    (await accountFromWhoami());
  const json = await cf([
    "analytics",
    "sql",
    "introspection",
    "get",
    "--account-tag",
    account,
    "--include-columns",
    "--include-wae=false",
    "--include-lex=false"
  ]);
  const parsed = JSON.parse(json) as IntrospectionResponse;
  const path = resolve(flags.cache!);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json);
  const cols = parsed.datasets.reduce(
    (n, d) => n + (d.columns?.length ?? 0),
    0
  );
  console.log(
    `Synced ${parsed.datasets.length} datasets / ${cols} columns → ${flags.cache}`
  );
}

async function render(): Promise<void> {
  const cache = resolve(flags.cache!);
  if (!existsSync(cache))
    fail(`No catalog cache at ${flags.cache}. Run \`asql sync\` first.`);
  let catalog = catalogFromIntrospection(
    JSON.parse(readFileSync(cache, "utf8")) as IntrospectionResponse
  );

  if (flags.preset) {
    const presets = await loadPresets();
    const preset = presets[flags.preset];
    if (!preset)
      fail(
        `Unknown preset "${flags.preset}". Available: ${Object.keys(presets).join(", ")}`
      );
    catalog = applyPreset(catalog, preset);
  }
  if (flags.table) catalog = filterCatalog(catalog, { tables: flags.table });
  if (catalog.tables.length === 0) fail("No tables match these filters.");

  const text = renderCatalog(catalog);
  const summary = `${catalog.tables.length} tables, ~${Math.round(text.length / 4)} tokens`;
  if (!flags.out) {
    process.stderr.write(`# ${summary}\n`);
    return void console.log(text);
  }
  const argv = process.argv
    .slice(2)
    .map((a) => (/\s/.test(a) ? `'${a}'` : a))
    .join(" ");
  writeFileSync(resolve(flags.out), catalogToModule(catalog, `asql ${argv}`));
  console.log(
    `Wrote ${flags.out}: ${catalog.tables.map((t) => t.name).join(", ")} (${summary})`
  );
}

async function loadPresets(): Promise<Presets> {
  const path = resolve(flags.presets!);
  if (!existsSync(path)) fail(`No presets file at ${flags.presets}.`);
  const mod = (await import(pathToFileURL(path).href)) as {
    presets?: Presets;
    default?: Presets;
  };
  return mod.presets ?? mod.default ?? {};
}

async function accountFromWhoami(): Promise<string> {
  const who = JSON.parse(await cf(["auth", "whoami"])) as {
    authenticated?: boolean;
    accounts?: { id: string; name: string }[];
  };
  if (!who.authenticated) fail("Not logged in: run `cf auth login`.");
  const accounts = who.accounts ?? [];
  if (accounts.length === 1) return accounts[0]!.id;
  fail(
    `Pass --account or set CLOUDFLARE_ACCOUNT_ID. Accounts:\n${accounts.map((a) => `  ${a.id}  ${a.name}`).join("\n")}`
  );
}

function cf(args: string[]): Promise<string> {
  return new Promise((ok, reject) => {
    execFile(
      "cf",
      args,
      {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
        env: { ...process.env, NO_COLOR: "1" }
      },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`${stderr}\n${stdout}`.trim() || error.message));
        else ok(stdout);
      }
    );
  });
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
