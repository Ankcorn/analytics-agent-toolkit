// Runtime core. Framework adapters: `analytics-agent-toolkit/ai-sdk`, `analytics-agent-toolkit/pi`.
export type {
  Catalog,
  CatalogSearch,
  ColumnDef,
  ExampleQuery,
  TableDef
} from "./catalog";
export {
  CATALOG_SEARCH_DESCRIPTION,
  renderCatalog,
  searchCatalog
} from "./catalog";
export type {
  AnalyticsSQLLike,
  AnalyticsSQLToolkit,
  AnalyticsSQLToolkitOptions,
  QueryInput,
  QueryOutput
} from "./toolkit";
export { createAnalyticsSQLToolkit, formatQueryOutput } from "./toolkit";
// Types for the build-time presets file (`satisfies Presets`); the build code itself ships only in the CLI.
export type { CatalogFilter, Preset, Presets } from "./build";
