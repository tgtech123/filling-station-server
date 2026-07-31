import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    // The route-wiring suite imports the whole Express app, which pulls in every
    // controller and model. Transforming that graph the first time takes longer
    // than the default 10s hook budget on a cold cache.
    hookTimeout: 120_000,
    testTimeout: 30_000,
    // Node, not jsdom: this is a backend suite.
    environment: "node",
  },
});
