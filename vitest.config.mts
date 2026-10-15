import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // H-120: the UI test harness runs component and accessibility tests in
    // a DOM environment; everything else stays on node.
    environmentMatchGlobs: [["tests/ui/**", "jsdom"]],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
