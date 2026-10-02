import { defineConfig } from "tsdown";

const shared = {
  format: "esm",
  target: "es2022",
  dts: true,
  sourcemap: true,
  fixedExtension: false
} as const;

export default defineConfig([
  // Runtime library: runs in Workers, so platform-neutral, peers never bundled.
  {
    ...shared,
    entry: ["src/index.ts", "src/ai-sdk.ts", "src/pi.ts"],
    platform: "neutral",
    clean: true,
    deps: { neverBundle: [/^cloudflare:/, "ai", "zod", /^@earendil-works\//] }
  },
  // Build-time CLI (`asql`): Node only, never imported by a Worker.
  {
    ...shared,
    entry: ["src/cli.ts"],
    platform: "node",
    dts: false,
    clean: false
  }
]);
