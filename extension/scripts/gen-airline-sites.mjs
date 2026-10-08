import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(resolve(root, "worker/src/source-registry.ts"), "utf8");
const start = source.indexOf("const HOME_URLS");
const end = source.indexOf("});", start);
if (start < 0 || end < 0) throw new Error("HOME_URLS block not found");
const excluded = new Set(["travelpayouts", "searchapi", "serpapi", "hasdata", "wego", "ignav", "google_flights", "duffel", "amadeus", "travelport", "sabre"]);
const sites = [...source.slice(start, end).matchAll(/^\s*([A-Za-z0-9_]+):\s*"(https:\/\/[^\"]+)"/gm)]
  .filter(([, id]) => !excluded.has(id))
  .map(([, id, url]) => ({ id, host: new URL(url).hostname.toLowerCase() }));
if (sites.length < 80) throw new Error(`Unexpected airline-site count: ${sites.length}`);
const output = `${JSON.stringify(sites, null, 2)}\n`;
const target = resolve(root, "extension/data/airline-sites.json");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) throw new Error("airline-sites.json is stale; run node scripts/gen-airline-sites.mjs");
} else writeFileSync(target, output, "utf8");
console.log(`Airline sites: ${sites.length}${process.argv.includes("--check") ? " (current)" : " (generated)"}`);
