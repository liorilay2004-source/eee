/**
 * Route hints from free public data (docs/FLIGHT_API_RESEARCH.md §16), bundled at build time by
 * scripts/gen-served-routes.mjs. They never decide WHETHER a fare exists, only which airport pairs a search asks
 * Travelpayouts about first, so a city search spends its request budget where fares can be:
 *
 *  - directFrom: airports seen with a direct flight to/from an Israeli airport on the IAA flight board (a few days'
 *    snapshot). Absence proves nothing (seasonal and weekly routes, connecting fares), so it only orders pairs.
 *  - noScheduledService: bundled airports OurAirports marks as having no scheduled passenger service (e.g. Ovda,
 *    closed to civil traffic since 2019). A pair touching one is dropped, but only when another pair remains.
 */
import served from "./served.json";

const IATA = /^[A-Z]{3}$/;

function codeSet(list: unknown): ReadonlySet<string> {
  return new Set(Array.isArray(list) ? list.filter((c): c is string => typeof c === "string" && IATA.test(c)) : []);
}

const DIRECT: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries((served as { directFrom?: Record<string, unknown> }).directFrom ?? {})
    .filter(([hub]) => IATA.test(hub))
    .map(([hub, list]) => [hub, codeSet(list)]),
);
const NO_SERVICE: ReadonlySet<string> = codeSet((served as { noScheduledService?: unknown }).noScheduledService);

/** True when the snapshot saw a direct flight between the two airports (either direction). Case-insensitive. */
export function directSeen(a: string, b: string): boolean {
  const x = a.toUpperCase();
  const y = b.toUpperCase();
  return DIRECT.get(x)?.has(y) === true || DIRECT.get(y)?.has(x) === true;
}

/** True for a bundled airport with no scheduled passenger service. Unknown codes are false (never pruned). */
export function noScheduledService(code: string): boolean {
  return NO_SERVICE.has(code.toUpperCase());
}

/**
 * Pairs in the order a scan should spend its budget on them:
 *  1. pairs touching an airport without scheduled service are removed, unless that would leave nothing;
 *  2. the first remaining pair (the user's primary airports) stays first;
 *  3. the rest keep their order, except that pairs with a direct flight seen move ahead of the others (stable).
 * No pair is ever added, and the input is not modified.
 */
export function orderPairsByService<P extends { origin: string; dest: string }>(pairs: readonly P[]): P[] {
  const live = pairs.filter((p) => !noScheduledService(p.origin) && !noScheduledService(p.dest));
  const list = live.length > 0 ? live : [...pairs];
  if (list.length <= 2) return list;
  const [primary, ...rest] = list as [P, ...P[]];
  const direct = rest.filter((p) => directSeen(p.origin, p.dest));
  const other = rest.filter((p) => !directSeen(p.origin, p.dest));
  return [primary, ...direct, ...other];
}
