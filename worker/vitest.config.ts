import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The deploy build points "eee-build-info" at the generated build/build-info.js (wrangler.toml [alias]); tests use the stand-in.
  resolve: { alias: { "cloudflare:workers": join(dirname(fileURLToPath(import.meta.url)), "test", "helpers", "cloudflare-workers.ts"), "eee-build-info": join(dirname(fileURLToPath(import.meta.url)), "src", "build-info.default.ts") } },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
