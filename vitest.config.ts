import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Store/daemon tests touch real files and sqlite; keep them serial-safe per file.
    pool: "forks",
  },
});
