import { defineConfig } from "vitest/config";

// Pure logic (no Durable Objects), so plain Node is enough.
export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"]
  }
});
