import type { Presets } from "cf-agent-sql";

/** Build-time only: `pnpm run catalog` turns this into src/analytics-catalog.ts. */
export const presets = {
  "workers-logs": {
    description: "Workers invocation and console logs.",
    tables: ["logs.workersLogs"],
    excludeColumns: ["accountTag"],
    tableNotes: {
      "logs.workersLogs": [
        "logType 'cf-worker-event' = one row per invocation (has httpStatus, wallTimeMs, cpuTimeMs). logType 'cf-worker' = console.log lines (httpStatus is 0).",
        "invocationType values seen: fetch, scheduled, alarm, jsrpc (also queue, email, … if used).",
        "level: console lines are '' (console.log), 'debug', 'warn' or 'error'; invocation rows are 'info', or 'error' when the invocation failed."
      ]
    },
    examples: {
      "logs.workersLogs": [
        {
          question: "Invocations and 5xx per script",
          sql: `SELECT "scriptName", sum("sampleInterval") AS invocations, sumIf("sampleInterval", "httpStatus" >= 500) AS errors
FROM logs.workersLogs
WHERE timestamp >= now() - INTERVAL '1 day' AND "logType" = 'cf-worker-event'
GROUP BY "scriptName" ORDER BY invocations DESC LIMIT 20`
        },
        {
          question: "p99 wall time per script",
          sql: `SELECT "scriptName", quantileWeighted(0.99, "wallTimeMs", "sampleInterval") AS p99_wall_ms
FROM logs.workersLogs
WHERE timestamp >= now() - INTERVAL '1 day' AND "logType" = 'cf-worker-event'
GROUP BY "scriptName" ORDER BY p99_wall_ms DESC LIMIT 20`
        },
        {
          question: "Most common error messages",
          sql: `SELECT "scriptName", message, sum("sampleInterval") AS n
FROM logs.workersLogs
WHERE timestamp >= now() - INTERVAL '1 day' AND level = 'error'
GROUP BY "scriptName", message ORDER BY n DESC LIMIT 20`
        }
      ]
    }
  }
} satisfies Presets;
