/**
 * match_audit: one PII-free structured log line per user search, so the owner can measure whether the prices shown match
 * (cache vs live, stale age, expired legs, price-guard hits, disbelieved quotes, the headline card's live-vs-cached gap)
 * before tuning the ranking. Zero cost: no subrequest, no D1 operation, one console.log. Workers Logs is OFF by default
 * (docs/CLOUDFLARE_SETUP.md, "Workers Logs (optional)"), so until the owner turns it on the line goes nowhere.
 *
 * Privacy by construction: buildAuditLine builds a NEW object field by field from an allowlist. It never copies the input,
 * so whatever else the caller's object carries (free text, dates, links, network details) cannot reach the line. Every
 * string in the line is a constant, an IATA pair checked against /^[A-Z]{3}$/, or a member of a fixed allowlist.
 */
import { QUOTE_SOURCE_NAMES } from "./quotes";
import type { RecKind, SourceName } from "./types";

/** Share of user searches that log a line. Lower it if searches approach 50k a day (the free Workers Logs allowance). */
export const AUDIT_SAMPLE = 1.0;

/** What runSearch hands over. Only counts, flags, IATA codes and allowlisted names: never the request, text, dates or links. */
export interface MatchAudit {
  origin: string;
  destination: string;
  fromCache: boolean;
  staleAgeH: number | null;
  expiredDropped: number;
  guardSuspicious: number;
  guardExcluded: number;
  liveSources: string[];
  quotesTotal: number;
  quotesDisbelieved: number;
  topCard: { kind: string; source: string; ageH: number | null; liveVsCachedPct: number | null } | null;
  cardKinds: string[];
  upstreamCalls: number;
}

/** The logged line. Keys in this fixed order. */
export interface MatchAuditLine {
  ev: "match_audit";
  v: 1;
  route: string;
  fromCache: boolean;
  staleAgeH: number | null;
  expiredDropped: number;
  guardSuspicious: number;
  guardExcluded: number;
  liveSources: SourceName[];
  quotesTotal: number;
  quotesDisbelieved: number;
  topCard: { kind: RecKind; source: SourceName | null; ageH: number | null; liveVsCachedPct: number | null } | null;
  cardKinds: RecKind[];
  upstreamCalls: number;
}

/** Source names the line may carry: Travelpayouts, the background google_flights rows, and the optional quote sources (imported, never copied). */
const SOURCE_ALLOW: readonly SourceName[] = (["travelpayouts", "google_flights"] as SourceName[]).concat(QUOTE_SOURCE_NAMES);

/** Runtime copy of RecKind. The two checks below fail the typecheck if the union and this list ever drift apart. */
const CARD_KINDS = ["cheapest", "best_value", "my_times"] as const satisfies readonly RecKind[];
type MissingKind = Exclude<RecKind, (typeof CARD_KINDS)[number]>;
const _allKindsListed: [MissingKind] extends [never] ? true : never = true;
void _allKindsListed;

const MAX_LIST = 16;
const IATA = /^[A-Z]{3}$/;

const isIata = (x: unknown): x is string => typeof x === "string" && IATA.test(x);
const count = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.round(x)) : 0);
const tenth = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

function member<T extends string>(allow: readonly T[], x: unknown): T | null {
  return typeof x === "string" && (allow as readonly string[]).includes(x) ? (x as T) : null;
}

/** Allowlisted members only, first occurrence kept, at most MAX_LIST. Anything that is not an array gives []. */
function allowList<T extends string>(allow: readonly T[], xs: unknown): T[] {
  const out: T[] = [];
  if (!Array.isArray(xs)) return out;
  for (let i = 0; i < xs.length && out.length < MAX_LIST; i++) {
    const m = member(allow, xs[i]);
    if (m !== null && !out.includes(m)) out.push(m);
  }
  return out;
}

function topCardOf(t: unknown): MatchAuditLine["topCard"] {
  if (typeof t !== "object" || t === null) return null;
  const c = t as MatchAudit["topCard"] & object;
  const kind = member(CARD_KINDS, c.kind);
  if (kind === null) return null;
  return { kind, source: member(SOURCE_ALLOW, c.source), ageH: tenth(c.ageH), liveVsCachedPct: tenth(c.liveVsCachedPct) };
}

/** The line, built field by field (no spread, no copy of the input, no iteration over its keys). May throw on a hostile getter. */
export function buildAuditLine(a: MatchAudit): MatchAuditLine {
  const origin = a.origin;
  const destination = a.destination;
  return {
    ev: "match_audit",
    v: 1,
    route: isIata(origin) && isIata(destination) ? `${origin}-${destination}` : "invalid",
    fromCache: a.fromCache === true,
    staleAgeH: tenth(a.staleAgeH),
    expiredDropped: count(a.expiredDropped),
    guardSuspicious: count(a.guardSuspicious),
    guardExcluded: count(a.guardExcluded),
    liveSources: allowList(SOURCE_ALLOW, a.liveSources),
    quotesTotal: count(a.quotesTotal),
    quotesDisbelieved: count(a.quotesDisbelieved),
    topCard: topCardOf(a.topCard),
    cardKinds: allowList(CARD_KINDS, a.cardKinds),
    upstreamCalls: count(a.upstreamCalls),
  };
}

/** Logs one line (sampled by AUDIT_SAMPLE). Never throws, whatever the input or the console does. */
export function logMatchAudit(a: MatchAudit, rand: () => number = Math.random): void {
  try {
    if (!(rand() < AUDIT_SAMPLE)) return;
    console.log(JSON.stringify(buildAuditLine(a)));
  } catch {
    // An audit line must never affect a search.
  }
}
