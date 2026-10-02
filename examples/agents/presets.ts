import type { Presets } from "cf-agent-sql";

/**
 * Build-time config (not bundled). Each preset is a subset of the analytics
 * catalog: a few tables, trimmed columns, notes and verified examples.
 *
 *   asql render --preset workers                               # preview what the model sees
 *   asql render --preset workers --out src/analytics-catalog.ts  # generate the runtime subset
 */
export const presets = {
  workers: {
    description: "Workers invocation logs, traces and grouped errors (issues).",
    tables: ["logs.workersLogs", "logs.traces", "logs.issues"],
    excludeColumns: ["accountTag"],
    examples: {
      "logs.workersLogs": [
        {
          question: "Requests and 5xx per script",
          sql: `SELECT "scriptName", sum("sampleInterval") AS requests, sumIf("sampleInterval", "httpStatus" >= 500) AS errors
FROM logs.workersLogs
WHERE timestamp >= $start AND timestamp < $end AND "logType" = 'cf-worker-event'
GROUP BY "scriptName" ORDER BY requests DESC LIMIT 20`
        },
        {
          question: "p99 wall time per script",
          sql: `SELECT "scriptName", quantileWeighted(0.99, "wallTimeMs", "sampleInterval") AS p99_wall_ms
FROM logs.workersLogs
WHERE timestamp >= $start AND timestamp < $end
GROUP BY "scriptName" ORDER BY p99_wall_ms DESC LIMIT 20`
        },
        {
          question: "Error-level logs over time",
          sql: `SELECT toStartOfInterval(timestamp, INTERVAL 5 MINUTE) AS t, sum("sampleInterval") AS n
FROM logs.workersLogs
WHERE timestamp >= $start AND timestamp < $end AND level = 'error'
GROUP BY t ORDER BY t`
        }
      ],
      "logs.issues": [
        {
          question: "Top error groups",
          sql: `SELECT "errorTitle", "scriptName", count() AS occurrences
FROM logs.issues
WHERE timestamp >= $start AND timestamp < $end
GROUP BY "errorTitle", "scriptName" ORDER BY occurrences DESC LIMIT 20`
        }
      ]
    },
    tableNotes: {
      "logs.workersLogs": [
        "logType values (observed): 'cf-worker-event' = one row per invocation (carries httpStatus), 'cf-worker' = console.log lines (httpStatus is 0).",
        "invocationType values (observed): fetch, scheduled, alarm, jsrpc, queue."
      ],
      "logs.traces": ["No timestamp column: filter on startTime."],
      "logs.issues": ["Unsampled: count() is exact."]
    }
  },

  http: {
    description: "Edge HTTP traffic for the account's zones.",
    tables: ["events.httpRequests"],
    excludeColumns: [
      "accountTag",
      "waf*AttackScore",
      "webAssetsOperationId",
      "xRequestedWith"
    ],
    examples: {
      "events.httpRequests": [
        {
          question: "Top hosts by 5xx",
          sql: `SELECT "clientRequestHttpHost" AS host, sumIf("sampleInterval", "edgeResponseStatus" >= 500) AS errors
FROM events.httpRequests
WHERE timestamp >= $start AND timestamp < $end
GROUP BY host ORDER BY errors DESC LIMIT 10`
        }
      ]
    }
  },

  storage: {
    description:
      "D1, KV, R2, Hyperdrive, Vectorize request events (no storage-size states).",
    categories: ["Storage"],
    kinds: ["events"],
    excludeColumns: ["accountTag"]
  },

  compute: {
    description: "Queues, Workflows, Pipelines, Browser Run events.",
    categories: ["Compute"],
    kinds: ["events"],
    excludeColumns: ["accountTag"]
  },

  ai: {
    description: "Workers AI inference and related AI products.",
    categories: ["AI"],
    excludeColumns: ["accountTag"]
  },

  /** Workers app on-call: logs + the storage it touches, trimmed to the useful columns. */
  "workers-oncall": {
    description:
      "Workers logs plus D1/KV/R2/Queues latency and errors, trimmed for an on-call agent.",
    tables: [
      "logs.workersLogs",
      "logs.issues",
      "events.d1Queries",
      "events.kvRequests",
      "events.r2CombinedOperations",
      "events.queuesMessages"
    ],
    excludeColumns: ["accountTag"],
    tableNotes: {
      "logs.workersLogs": [
        "logType: 'cf-worker-event' = one row per invocation (has httpStatus); 'cf-worker' = console.log lines (httpStatus 0)."
      ]
    },
    columns: {
      "logs.workersLogs": [
        "scriptName",
        "httpStatus",
        "level",
        "logType",
        "message",
        "error",
        "wallTimeMs",
        "cpuTimeMs",
        "invocationType",
        "url",
        "traceId",
        "rayId"
      ],
      "events.d1Queries": [
        "databaseId",
        "error",
        "queryDurationMs",
        "rowsRead",
        "rowsWritten"
      ],
      "events.kvRequests": [
        "namespaceId",
        "actionType",
        "httpStatus",
        "latencyMs",
        "result"
      ],
      "events.r2CombinedOperations": [
        "bucketName",
        "actionStatus",
        "httpStatus",
        "objectSizeBytes"
      ],
      "events.queuesMessages": [
        "queueId",
        "actionType",
        "outcome",
        "retries",
        "lagTimeMs",
        "backlogCount"
      ]
    }
  }
} satisfies Presets;
