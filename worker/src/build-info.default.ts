/**
 * Stand-in for the generated module "eee-build-info" (build/build-info.js, written by scripts/gen-build-info.mjs when
 * wrangler builds). Type checking (tsconfig `paths`) and tests (vitest alias) resolve the module to this file; a real
 * deploy never does (wrangler.toml `[alias]`).
 */
export const BUILD_SHA: string = "unknown";
export const BUILD_TIME: string | null = null;
