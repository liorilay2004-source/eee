/**
 * Live search pipeline (SPEC §7) for the Worker. Port of engine/tpe/pipeline.run_search minus the fast-flights
 * deep search, which is background-only (SPEC §6): its offers arrive through the shared DB (step 6).
 *
 *  1 expand airports   2 cache check   3 wide scan (Travelpayouts)   4 narrow   5 live quotes (optional sources)
 *  6 merge with recent DB offers   7 extras + FX   8 recommend   9 persist
 *
 * Money rules (SPEC §4.2): offers keep their ORIGINAL amount + currency everywhere; ILS is derived per request.
 * The cache holds RAW data (no extras, no ILS): the round trips plus the one-way fares, and the live quotes the
 * optional fare sources gave that scan (so a hit ranks exactly what the scan ranked, not only the cheapest quote
 * per pair that the price history keeps). Split tickets are NOT cached, they are rebuilt on every request from
 * those fares, because which legs get combined depends on the request's hour windows, max stops and bag choice.
 * So a different bag choice, hour window or max-stops setting re-ranks cached data without touching any external
 * service, exactly as a fresh scan would.
 *
 * Passenger convention: `Offer.priceAmount` is the total for the whole party (like Python), and the shared
 * `prices` history stores PER-PASSENGER amounts so searches with different party sizes stay comparable.
 */
import { airlineFieldsFor } from "./airlines/lookup";
import { airlinePriceLinks } from "./airlines/official-links";
import { logMatchAudit } from "./audit";
import * as airportData from "./airports/resolve";
import { orderPairsByService } from "./airports/served";
import type { Resolver } from "./airports/types";
import { DEAL_CONFIG } from "./deals";
import { applyExtrasAndFx, paxCount, round2 } from "./extras";
import { toIls } from "./money";
import { departHour, recommend, recommendationsMeta } from "./scoring";
import { SCORING } from "./scoring.config";
import {
  cheapestCachedByPair,
  coverKey,
  isQuoteSource,
  isPublishedSource,
  MAX_QUOTE_PAIRS,
  mergeQuoted,
  pickQuotePairs,
  plausibleQuotes,
  QUOTE_MAX_AGE_HOURS,
  QUOTE_SOURCE_NAMES,
  quoteOk,
  quoteStatus,
  runQuotes,
  timeCandidates,
  type FareQuoteSource,
  type QuoteSourceName,
  type QuoteStat,
} from "./quotes";
import {
  applyPriceGuard,
  createPriceGuard,
  HISTORY_LOOKBACK_DAYS,
  HISTORY_ROWS_PER_PAIR,
  historyTargets,
  type PriceGuard,
} from "./priceguard";
import { fareExpired, fareFreshness, vendorTimestamp } from "./freshness";
import { partyCheckMetaNow, signedPartyCheckFields, type PartyTokenSigner } from "./partycheck";
import { sourceRegistryForRoute } from "./source-registry";
import { buildSplits, dayNumber, pairOk } from "./splits";
import { monthsBetween, TravelpayoutsError, withPartySize, type Party } from "./travelpayouts";
import type {
  CachedOffers,
  CardView,
  FxRates,
  Leg,
  Offer,
  OneWayFare,
  OneWayPair,
  PriceContext,
  Repo,
  SearchRequest,
  SearchResponse,
  SourceName,
  SourceCoverage,
  SourceStatus,
  StaleInfo,
  SourceUnavailableReason,
  TravelpayoutsClient,
} from "./types";

// --- limits ---------------------------------------------------------------------------------------------

/** Free Workers allow ~50 subrequests per invocation: leave room for FX, D1 and the rest. */
export const MAX_TP_REQUESTS = 30;
/** Airport pairs considered (origin airports x destination airports), primary pair first. */
export const MAX_AIRPORT_PAIRS = 24;
/** D1 rows are limited to ~2 MB: the cache row keeps at most this many round trips... */
export const MAX_CACHED_OFFERS = 1200;
/** ...and this many one-way fares (about 300 bytes each; measured, both caps together come to about 1 MB). */
export const MAX_CACHED_ONEWAYS = 1000;
/**
 * Price-history rows written per fresh search. Every row costs three D1 row writes (the table and two indexes)
 * against a free budget of 100k a day, so the history keeps the cheapest fares only.
 */
export const MAX_PERSISTED_PRICES = 60;
/** A cached scan that found nothing is trusted for a shorter time: fares may appear, and it may be a fluke. */
export const EMPTY_RESULT_TTL_HOURS = 1;
/** Enrichment rows from the background monitor run every 6h; anything older than two runs is stale. */
export const RECENT_ENRICHMENT_MAX_AGE_HOURS = 12;
/** When Travelpayouts is down, older stored fares are better than nothing (the card shows their age). */
export const FALLBACK_MAX_AGE_HOURS = 24;

/**
 * Stale-while-revalidate (index.ts only, see SearchDeps.staleWhileRevalidate): a cache row older than the TTL but younger than
 * this still answers at once, marked `meta.stale`, and one background rescan refreshes it. Same bound as the stored-fare fallback.
 */
export const STALE_MAX_AGE_HOURS = 24;
/** At most one background rescan per search key in this many seconds (a D1 counter): a burst of stale hits costs one scan. */
export const REFRESH_LOCK_SECONDS = 600;

/** Failures the caller can act on; index.ts maps both to HTTP 503. */
export class PipelineError extends Error {
  readonly code: "source_unavailable" | "fx_unavailable";
  /** ADDITIVE: why the fare source is unavailable (source_unavailable only). */
  readonly reason?: SourceUnavailableReason;
  /** ADDITIVE: seconds until a retry can succeed, only when that is actually known (the global scan budget's window). */
  readonly retryAfterSec?: number;
  constructor(
    code: "source_unavailable" | "fx_unavailable",
    message: string,
    extra: { reason?: SourceUnavailableReason; retryAfterSec?: number } = {},
  ) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
    if (extra.reason !== undefined) this.reason = extra.reason;
    if (extra.retryAfterSec !== undefined) this.retryAfterSec = extra.retryAfterSec;
  }
}

/** What the global budget check answers: a plain boolean (older callers, tests) or the limiter's verdict with its wait. */
export type ScanBudgetVerdict = boolean | { allowed: boolean; retryAfterSec?: number };

/** A usable Retry-After value: a positive whole number of seconds, or undefined when the wait is not known. */
function knownWait(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.min(Math.ceil(v), 86_400) : undefined;
}

/** Reads back the truncation note this module writes (see scanNotes); a cache row keeps only the notes, not the counts. */
export function coverageFromNotes(notes: readonly string[] | undefined): SourceCoverage | null {
  for (const n of notes ?? []) {
    const m = /^truncated: (\d+) of (\d+) planned requests skipped/.exec(typeof n === "string" ? n : "");
    // Only a complete scan (no failed request) is cached, so a cached scan never stopped on a fatal error.
    if (m) return { skippedRequests: Number(m[1]), plannedRequests: Number(m[2]), abortedRequests: 0 };
  }
  return null;
}

export interface SearchDeps {
  repo: Repo;
  tp: TravelpayoutsClient;
  /** Rates, or a loader (production: getFxRates over D1 + Bank of Israel). */
  fx: FxRates | (() => Promise<FxRates>);
  now: Date;
  resolver?: Resolver;
  /** ctx.waitUntil: persistence runs after the response is ready. Without it runSearch awaits the writes. */
  waitUntil?: (work: Promise<unknown>) => void;
  /**
   * Asked before every fresh Travelpayouts scan (never on a cache hit): false = the global upstream budget is spent,
   * so no scan is made and the search is answered from stored fares only, like a source outage.
   */
  scanBudget?: () => Promise<ScanBudgetVerdict>;
  /** Optional live fare sources (quotes.ts). Asked on complete fresh scans only, and only those with a key. */
  quoteSources?: FareQuoteSource[];
  /**
   * Serve a cache row older than the TTL (up to STALE_MAX_AGE_HOURS) at once, marked `meta.stale`, and rescan in the
   * background (waitUntil required; one rescan per key per REFRESH_LOCK_SECONDS; the global scan budget applies). Off by
   * default: only the public API turns it on, so the scheduled snapshot always scans.
   */
  staleWhileRevalidate?: boolean;
  /** True for a background rescan that goes through the whole pipeline: the stale answer already logged this search. */
  skipSearchLog?: boolean;
  /**
   * Emit the one `match_audit` log line (audit.ts) at the end of the search. Default true; the scheduled snapshot passes false,
   * and a background rescan (skipSearchLog) never logs one either, so only a user search via index.ts does. Changes nothing in
   * the response.
   */
  audit?: boolean;
  /**
   * ADDITIVE (party check, partycheck.ts): signs a round-trip card's route, dates and adults for POST /api/party-check. Used only
   * when meta.partyCheck.available is true; absent (the scheduled snapshot, background rescans, tests) = no card gets a token.
   */
  partyToken?: PartyTokenSigner;
}

export const defaultResolver: Resolver = {
  resolveLocation: airportData.resolveLocation,
  resolvePlace: airportData.resolvePlace,
  airportsForCode: airportData.airportsForCode,
  nearbyAirports: airportData.nearbyAirports,
  countryOfAirport: airportData.countryOfAirport,
  cityNameHe: airportData.cityNameHe,
  cityNameEn: airportData.cityNameEn,
};

// --- small helpers --------------------------------------------------------------------------------------

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Stable key of everything that changes WHICH fares exist. Extras, hour windows and max stops are excluded on
 * purpose: they only affect ranking, which is re-applied on every request over the raw cached offers.
 */
export function computeSearchKey(req: SearchRequest): Promise<string> {
  // Keys in alphabetical order: the canonical form does not depend on how the caller built the object.
  return sha256Hex(
    JSON.stringify({
      adults: req.adults,
      cabin: req.cabin,
      children: req.children,
      destination: req.destination.toUpperCase(),
      infants: req.infants,
      nearbyAirports: req.nearbyAirports,
      origin: req.origin.toUpperCase(),
      stayMax: req.stayMax,
      stayMin: req.stayMin,
      windowEnd: req.windowEnd,
      windowStart: req.windowStart,
    }),
  );
}

/** Storage trouble must degrade the search, never fail it. */
async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> => p.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const cloneLeg = (l: Leg): Leg => ({ ...l, airlines: [...l.airlines] });

function cloneOffer(o: Offer): Offer {
  return { ...o, outbound: cloneLeg(o.outbound), inbound: cloneLeg(o.inbound), includes: { ...o.includes }, tags: [...o.tags] };
}

/** Base fare in ILS for ordering only (no extras); Infinity when the currency has no rate. */
function baseIls(fx: FxRates, o: Offer): number {
  try {
    const v = toIls(fx, o.priceAmount, o.priceCurrency);
    return Number.isFinite(v) ? v : Infinity;
  } catch {
    return Infinity;
  }
}

/** Copy with the price multiplied to the whole party; derived fields reset so the copy is RAW. */
function scaledCopy(o: Offer, factor: number): Offer {
  return {
    ...cloneOffer(o),
    priceAmount: round2(o.priceAmount * factor),
    extrasAmountIls: 0,
    totalIls: null,
    tags: [],
  };
}

// --- cache payload validation ---------------------------------------------------------------------------

const SOURCE_NAMES: readonly string[] = ["travelpayouts", "google_flights"];
const STRUCTURES: readonly string[] = ["roundtrip", "split"];
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseLeg(v: unknown): Leg | null {
  if (!isRecord(v)) return null;
  return {
    departTime: strOrNull(v.departTime),
    arriveTime: strOrNull(v.arriveTime),
    stops: intOrNull(v.stops),
    durationMin: intOrNull(v.durationMin),
    airlines: Array.isArray(v.airlines) ? v.airlines.filter((a): a is string => typeof a === "string") : [],
  };
}

/** Source-stated fare times read back from a cache row: kept only when valid, absent otherwise (as before the fields existed). */
function vendorTimes<F extends string, E extends string>(found: unknown, expires: unknown, fKey: F, eKey: E): Partial<Record<F | E, string>> {
  const out: Partial<Record<F | E, string>> = {};
  const f = vendorTimestamp(found);
  const e = vendorTimestamp(expires);
  if (f) out[fKey] = f as never;
  if (e) out[eKey] = e as never;
  return out;
}

/**
 * The cache is JSON written by an earlier version of this code: rebuild every offer from known fields and drop
 * anything malformed, so a bad row can never crash ranking. Derived fields are reset (the cache is RAW).
 */
export function sanitizeOffers(raw: unknown, sources: readonly string[] = SOURCE_NAMES): Offer[] {
  if (!Array.isArray(raw)) return [];
  const out: Offer[] = [];
  for (const v of raw as unknown[]) {
    if (!isRecord(v)) continue;
    const outbound = parseLeg(v.outbound);
    const inbound = parseLeg(v.inbound);
    const amount = v.priceAmount;
    if (!outbound || !inbound) continue;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) continue;
    if (typeof v.origin !== "string" || typeof v.destination !== "string") continue;
    if (typeof v.departDate !== "string" || typeof v.returnDate !== "string") continue;
    if (typeof v.priceCurrency !== "string" || v.priceCurrency === "") continue;
    if (typeof v.source !== "string" || !sources.includes(v.source)) continue;
    if (typeof v.ticketStructure !== "string" || !STRUCTURES.includes(v.ticketStructure)) continue;
    if (typeof v.checkedAt !== "string" || !Number.isFinite(Date.parse(v.checkedAt))) continue;
    const includes = isRecord(v.includes) && typeof v.includes.checkedBag === "boolean" ? { checkedBag: v.includes.checkedBag } : {};
    const returnDeeplink = strOrNull(v.returnDeeplink);
    out.push({
      origin: v.origin,
      destination: v.destination,
      departDate: v.departDate,
      returnDate: v.returnDate,
      priceAmount: amount,
      priceCurrency: v.priceCurrency,
      source: v.source as SourceName,
      ticketStructure: v.ticketStructure as Offer["ticketStructure"],
      outbound,
      inbound,
      includes,
      deeplink: strOrNull(v.deeplink),
      ...(returnDeeplink !== null ? { returnDeeplink } : {}),
      verifyLink: strOrNull(v.verifyLink),
      checkedAt: v.checkedAt,
      ...vendorTimes(v.fareFoundAt, v.fareExpiresAt, "fareFoundAt", "fareExpiresAt"),
      extrasAmountIls: 0,
      totalIls: null,
      tags: [],
    });
  }
  return out;
}

function parseFare(v: unknown): OneWayFare | null {
  if (!isRecord(v)) return null;
  const leg = parseLeg(v.leg);
  const amount = v.priceAmount;
  if (!leg || typeof v.date !== "string" || dayNumber(v.date) === null) return null;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  if (typeof v.priceCurrency !== "string" || v.priceCurrency === "") return null;
  return { date: v.date, priceAmount: amount, priceCurrency: v.priceCurrency, leg, deeplink: strOrNull(v.deeplink), ...vendorTimes(v.foundAt, v.expiresAt, "foundAt", "expiresAt") };
}

/** Same defensive rebuild as sanitizeOffers, for the one-way fares kept in the cache row. */
export function sanitizeOneWayPairs(raw: unknown): OneWayPair[] {
  if (!Array.isArray(raw)) return [];
  const out: OneWayPair[] = [];
  for (const v of raw as unknown[]) {
    if (!isRecord(v) || typeof v.origin !== "string" || typeof v.destination !== "string") continue;
    const fares = (list: unknown): OneWayFare[] =>
      Array.isArray(list) ? (list as unknown[]).map(parseFare).filter((f): f is OneWayFare => f !== null) : [];
    out.push({ origin: v.origin, destination: v.destination, outs: fares(v.outs), backs: fares(v.backs) });
  }
  return out;
}

// --- step 1: airports -----------------------------------------------------------------------------------

interface Pair {
  origin: string;
  dest: string;
}

/** City code -> its airports (primary first); with `nearby`, neighbouring airports follow. */
function airportsOf(resolver: Resolver, code: string, nearby: boolean): string[] {
  const base = resolver.airportsForCode(code);
  const list = base.length > 0 ? [...base] : [code.toUpperCase()];
  if (nearby) {
    for (const n of resolver.nearbyAirports(code)) {
      const expanded = resolver.airportsForCode(n);
      for (const a of expanded.length > 0 ? expanded : [n]) if (!list.includes(a)) list.push(a);
    }
  }
  return list;
}

/**
 * All origin x destination airport pairs, the primary pair first, then by distance from it. Route hints from public
 * data (airports/served.ts) then drop pairs touching an airport without scheduled service (when others remain) and
 * move pairs with a direct flight seen ahead of the rest, before the cap: a truncated scan spends its budget on the
 * pairs most likely to have fares (TLV-BGY before TLV-LIN). The primary pair always stays first.
 */
export function airportPairs(resolver: Resolver, req: SearchRequest): Pair[] {
  const origins = airportsOf(resolver, req.origin, req.nearbyAirports);
  const dests = airportsOf(resolver, req.destination, req.nearbyAirports);
  const ranked: Array<{ pair: Pair; rank: number; i: number }> = [];
  origins.forEach((origin, i) => dests.forEach((dest, j) => ranked.push({ pair: { origin, dest }, rank: i + j, i })));
  ranked.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return orderPairsByService(ranked.map((r) => r.pair)).slice(0, MAX_AIRPORT_PAIRS);
}

// --- step 3: Travelpayouts wide scan --------------------------------------------------------------------

interface ScanResult {
  roundTrips: Offer[]; // per adult, unfiltered
  oneWayPairs: Array<{ pair: Pair; outs: OneWayFare[]; backs: OneWayFare[] }>;
  successes: number;
  failures: string[];
  /** Airport pairs Travelpayouts answered with HTTP 400 (not a searchable code): reported, not counted as a source failure. */
  rejected: string[];
  plannedRequests: number;
  skippedRequests: number;
  /** Planned requests not made because an earlier request failed fatally (401/403/429): the scan stopped. */
  abortedRequests: number;
}

/**
 * Error text that is safe to show: only the part before the first ":" (the client puts upstream bodies and
 * network details after it), and nothing at all from foreign errors.
 */
export function describeError(e: unknown): string {
  if (e instanceof TravelpayoutsError) return `Travelpayouts: ${(e.message.split(":")[0] ?? "error").trim().slice(0, 80)}`;
  return "Travelpayouts: unexpected error";
}

/** Auth or quota problems repeat on every call: stop instead of burning the rest of the budget. */
const isFatal = (e: unknown): boolean => e instanceof TravelpayoutsError && (e.status === 401 || e.status === 403 || e.status === 429);

/**
 * Plan: round trips for the primary airport pair, then its one-ways (split tickets), then the same for the
 * remaining pairs (same-city and nearby airports) in distance order. A step that does not fit the request
 * budget is skipped and reported; the primary pair always fits (5 months: 15 + 10 requests).
 */
async function scanTravelpayouts(tp: TravelpayoutsClient, req: SearchRequest, pairs: Pair[]): Promise<ScanResult> {
  const months = monthsBetween(req.windowStart, req.windowEnd).length;
  const rtCost = (months * (months + 1)) / 2; // one call per (departure month, return month >= departure month)
  const owCost = 2 * months; // one call per month, both directions

  const steps: Array<{ kind: "rt" | "ow"; pair: Pair; cost: number }> = [];
  for (const pair of pairs) {
    steps.push({ kind: "rt", pair, cost: rtCost }, { kind: "ow", pair, cost: owCost });
  }

  const result: ScanResult = { roundTrips: [], oneWayPairs: [], successes: 0, failures: [], rejected: [], plannedRequests: 0, skippedRequests: 0, abortedRequests: 0 };
  let spent = 0;
  let stopped = false;
  for (const step of steps) {
    result.plannedRequests += step.cost;
    if (stopped) {
      result.abortedRequests += step.cost;
      continue;
    }
    if (spent + step.cost > MAX_TP_REQUESTS) {
      result.skippedRequests += step.cost;
      continue;
    }
    spent += step.cost;
    try {
      if (step.kind === "rt") {
        result.roundTrips.push(...(await tp.roundTrips(step.pair.origin, step.pair.dest, req.windowStart, req.windowEnd)));
      } else {
        const outs = await tp.oneWays(step.pair.origin, step.pair.dest, req.windowStart, req.windowEnd);
        const backs = await tp.oneWays(step.pair.dest, step.pair.origin, req.windowStart, req.windowEnd);
        result.oneWayPairs.push({ pair: step.pair, outs, backs });
      }
      result.successes += 1;
    } catch (e) {
      // HTTP 400 means the pair itself is not searchable (e.g. Ovda, a sibling airport of Eilat that Aviasales does not
      // serve). The source answered, so it is neither a failure nor a reason to stop: an all-rejected search is an empty
      // result, and a good sibling airport still gets searched.
      if (e instanceof TravelpayoutsError && e.status === 400) {
        const label = `${step.pair.origin}-${step.pair.dest}`;
        if (!result.rejected.includes(label)) result.rejected.push(label);
        result.successes += 1;
        continue;
      }
      const text = describeError(e);
      if (!result.failures.includes(text)) result.failures.push(text);
      if (isFatal(e)) stopped = true;
    }
  }
  return result;
}

// --- steps 6-9 helpers ----------------------------------------------------------------------------------

/** Newest snapshot per concrete flight: history rows repeat the same fare over time. */
function latestPerFlight(offers: Offer[]): Offer[] {
  const best = new Map<string, Offer>();
  for (const o of offers) {
    const key = JSON.stringify([o.origin, o.destination, o.departDate, o.returnDate, o.source, o.ticketStructure, o.outbound.departTime, o.inbound.departTime]);
    const cur = best.get(key);
    if (!cur || Date.parse(o.checkedAt) > Date.parse(cur.checkedAt)) best.set(key, o);
  }
  return [...best.values()];
}

/**
 * Shrinks `items` to at most `max` for the cache row without deciding the ranking in advance. A plain "keep the
 * cheapest N" would throw away exactly the fares the 🎯 card and Best Value look for (an evening flight, a
 * nonstop), because those are rarely the cheapest overall. Instead the items are grouped into "cells" of the
 * same shape and only the cheapest of each cell is kept, with cells getting coarser until the result fits.
 * `levels` go from the finest cell key to the coarsest; if even that does not fit, the cheapest survivors win.
 * The input order of the kept items is preserved (ties in ranking resolve to the earliest one).
 */
function capByCells<T>(items: T[], max: number, cost: (t: T) => number, levels: Array<(t: T) => string>): T[] {
  if (items.length <= max) return items;
  let survivors: T[] = items;
  for (const cellOf of levels) {
    const best = new Map<string, { t: T; c: number }>();
    for (const t of items) {
      const key = cellOf(t);
      const c = cost(t);
      const cur = best.get(key);
      if (!cur || c < cur.c) best.set(key, { t, c });
    }
    survivors = [...best.values()].map((v) => v.t);
    if (survivors.length <= max) break;
  }
  if (survivors.length > max) {
    survivors = survivors
      .map((t) => ({ t, c: cost(t) }))
      .sort((a, b) => a.c - b.c)
      .slice(0, max)
      .map((x) => x.t);
  }
  const keep = new Set(survivors);
  return items.filter((t) => keep.has(t));
}

const hourOf = (leg: Leg): number => {
  const h = departHour(leg);
  return h === null ? -1 : h;
};
const stopsClass = (leg: Leg, cap: number): number => (leg.stops === null ? -1 : Math.min(leg.stops, cap));

/** Round trips and splits: finest cell = same date pair, structure, both departure times, stops and carriers. */
function capOffers(offers: Offer[], fx: FxRates, max: number): Offer[] {
  const pair = (o: Offer) => [o.origin, o.destination, o.departDate, o.returnDate, o.source, o.ticketStructure].join("|");
  const levels: Array<(o: Offer) => string> = [
    (o) => `${pair(o)}|${o.outbound.departTime}|${o.inbound.departTime}|${o.outbound.stops}|${o.inbound.stops}|${o.outbound.airlines[0] ?? ""}|${o.inbound.airlines[0] ?? ""}`,
    (o) => `${pair(o)}|${Math.floor(hourOf(o.outbound) / 3)}|${Math.floor(hourOf(o.inbound) / 3)}|${stopsClass(o.outbound, 2)}|${stopsClass(o.inbound, 2)}`,
    (o) => `${pair(o)}|${Math.floor(hourOf(o.outbound) / 6)}|${Math.floor(hourOf(o.inbound) / 6)}|${stopsClass(o.outbound, 1)}|${stopsClass(o.inbound, 1)}`,
    pair,
  ];
  return capByCells(offers, max, (o) => baseIls(fx, o), levels);
}

/** One-way fares of every pair and direction, cut the same way (the direction and pair are part of every cell). */
function capOneWayPairs(pairs: OneWayPair[], fx: FxRates, max: number): OneWayPair[] {
  interface Item {
    p: number;
    dir: "outs" | "backs";
    fare: OneWayFare;
  }
  const items: Item[] = pairs.flatMap((pr, p) => [
    ...pr.outs.map((fare): Item => ({ p, dir: "outs", fare })),
    ...pr.backs.map((fare): Item => ({ p, dir: "backs", fare })),
  ]);
  if (items.length <= max) return pairs;
  const day = (i: Item) => `${i.p}|${i.dir}|${i.fare.date}`;
  const levels: Array<(i: Item) => string> = [
    (i) => `${day(i)}|${i.fare.leg.departTime}|${i.fare.leg.stops}|${i.fare.leg.airlines[0] ?? ""}`,
    (i) => `${day(i)}|${Math.floor(hourOf(i.fare.leg) / 3)}|${stopsClass(i.fare.leg, 2)}`,
    (i) => `${day(i)}|${Math.floor(hourOf(i.fare.leg) / 6)}|${stopsClass(i.fare.leg, 1)}`,
    day,
  ];
  const cost = (i: Item): number => {
    try {
      const v = toIls(fx, i.fare.priceAmount, i.fare.priceCurrency);
      return Number.isFinite(v) ? v : Infinity;
    } catch {
      return Infinity;
    }
  };
  const kept = new Set(capByCells(items, max, cost, levels));
  const out: OneWayPair[] = pairs.map((pr) => ({ origin: pr.origin, destination: pr.destination, outs: [], backs: [] }));
  for (const i of items) if (kept.has(i)) out[i.p]?.[i.dir].push(i.fare);
  return out;
}

/** Price-history rows for a fresh scan: the cheapest fare per (pair, source, structure), per passenger. */
function historyRows(live: Offer[], fx: FxRates, pax: number, now: Date): Offer[] {
  const best = new Map<string, { o: Offer; ils: number }>();
  for (const o of live) {
    // A source-expired fare is not ranked, so it must not reach the history either: the `prices` table keeps no expiry,
    // and a fallback read of it could not tell it apart from a valid fare.
    if (fareExpired(o, now)) continue;
    const key = [o.origin, o.destination, o.departDate, o.returnDate, o.source, o.ticketStructure].join("|");
    const ils = baseIls(fx, o);
    const cur = best.get(key);
    if (!cur || ils < cur.ils) best.set(key, { o, ils });
  }
  return [...best.values()]
    .sort((a, b) => a.ils - b.ils)
    .slice(0, MAX_PERSISTED_PRICES)
    .map(({ o }) => scaledCopy(o, 1 / pax));
}

function ageHours(checkedAt: string, now: Date): number {
  const ms = Date.parse(checkedAt);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.round(((now.getTime() - ms) / 3_600_000) * 10) / 10);
}

async function contextFor(repo: Repo, o: Offer, pax: number, now: Date): Promise<PriceContext | null> {
  const ctx = await attempt(() => repo.priceContext(o.origin, o.destination, o.departDate, o.returnDate, now));
  if (!ctx) return null;
  // History is per passenger; the card shows the whole party's price, so the context must match it.
  const scale = (v: number | null): number | null => (v === null ? null : round2(v * pax));
  return { currency: ctx.currency, weekAgoAmount: scale(ctx.weekAgoAmount), lowestAmount: scale(ctx.lowestAmount) };
}

async function loadRecent(
  repo: Repo,
  pairs: Pair[],
  req: SearchRequest,
  sources: SourceName[] | undefined,
  maxAgeHours: number,
  now: Date,
): Promise<Offer[]> {
  const rows = await Promise.all(
    pairs.map(async (p) => (await attempt(() => repo.loadRecentOffers(p.origin, p.dest, req.windowStart, req.windowEnd, maxAgeHours, now, sources))) ?? []),
  );
  return rows.flat().filter((o) => pairOk(req, o.departDate, o.returnDate));
}

async function resolveFx(deps: SearchDeps): Promise<FxRates> {
  return typeof deps.fx === "function" ? deps.fx() : deps.fx;
}

/** Rates or a typed failure: without any FX rate nothing can be compared in ILS. */
async function loadFxOrFail(deps: SearchDeps): Promise<FxRates> {
  const r = await settle(resolveFx(deps));
  if (!r.ok) throw new PipelineError("fx_unavailable", "Exchange rates are unavailable");
  return r.value;
}

/**
 * A cache hit must make zero external calls (SPEC §16): prefer rates already stored in D1, even from
 * yesterday when the UTC day just rolled over, and only then fall back to the loader.
 */
async function fxForCacheHit(deps: SearchDeps): Promise<FxRates> {
  if (typeof deps.fx !== "function") return deps.fx;
  const today = deps.now.toISOString().slice(0, 10);
  const stored = await attempt(async () => (await deps.repo.getFxRates(today)) ?? (await deps.repo.getLatestFxRates()));
  return stored ?? loadFxOrFail(deps);
}

/** True for a cache row written by a scan that succeeded but found nothing, while it is still young enough to trust. */
function isFreshEmptyScan(hit: CachedOffers, now: Date): boolean {
  const created = Date.parse(hit.createdAt);
  if (!Number.isFinite(created) || now.getTime() - created >= EMPTY_RESULT_TTL_HOURS * 3_600_000) return false;
  if (!Array.isArray(hit.offers) || hit.offers.length > 0 || !Array.isArray(hit.oneWayPairs)) return false;
  return hit.oneWayPairs.every((p) => isRecord(p) && !(Array.isArray(p.outs) && p.outs.length > 0) && !(Array.isArray(p.backs) && p.backs.length > 0));
}

/**
 * The API's own links search for ONE adult while the card's price is for the whole party: point the links at
 * the party. Links that are not Aviasales search links are left alone.
 */
function linkParty(o: Offer, party: Party): void {
  try {
    o.deeplink = withPartySize(o.deeplink, party);
    if (o.returnDeeplink) o.returnDeeplink = withPartySize(o.returnDeeplink, party);
  } catch {
    // An impossible party (validation rules it out) keeps the original links rather than failing the search.
  }
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY = 86_400_000;

function fallbackQuotePairs(req: SearchRequest, max: number = MAX_QUOTE_PAIRS): Array<[string, string]> {
  const start = Date.parse(`${req.windowStart}T00:00:00.000Z`);
  const end = Date.parse(`${req.windowEnd}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const min = Math.max(0, req.stayMin);
  const maxStay = Math.max(min, req.stayMax);
  const windowDays = Math.floor((end - start) / DAY);
  const offsets = [...new Set([0, Math.floor(windowDays / 2), windowDays])].filter((n) => n >= 0 && n <= windowDays);
  const stays = [...new Set([min, Math.floor((min + maxStay) / 2), maxStay])].filter((n) => n >= min && n <= maxStay);
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const offset of offsets) {
    const depart = start + offset * DAY;
    for (const stay of stays) {
      const ret = depart + stay * DAY;
      if (ret > end + maxStay * DAY) continue;
      const pair: [string, string] = [isoDay(depart), isoDay(ret)];
      if (!pairOk(req, pair[0], pair[1])) continue;
      const key = pair.join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(pair);
      if (out.length >= max) return out;
    }
  }
  return out;
}

// --- the pipeline ---------------------------------------------------------------------------------------

export async function runSearch(deps: SearchDeps, req: SearchRequest): Promise<SearchResponse> {
  const { repo, tp, now } = deps;
  const resolver = deps.resolver ?? defaultResolver;
  const searchKey = await computeSearchKey(req);
  const pax = paxCount(req);
  const pairs = airportPairs(resolver, req);

  const tpStatus: SourceStatus = {
    name: "travelpayouts",
    enabled: tp.configured,
    ok: false,
    calls: 0,
    offers: 0,
    error: null,
    truncated: false,
    coverage: null,
    reason: null,
  };
  let budgetWait: number | undefined; // seconds until the global scan budget frees up, when it was the reason
  let fx: FxRates;
  let rts: Offer[] = []; // RAW round trips for the whole party: from the cache or the scan below
  let oneWayPairs: OneWayPair[] = []; // RAW one-way fares, per adult
  let splitsCheckedAt = now.toISOString();
  let scan: ScanResult | null = null;
  let scanNotes: string[] = []; // what a later cache hit must still tell the caller about this scan
  let quotedRaw: Offer[] = []; // RAW live quotes of THIS scan, whole party: stored beside the cache row, and added to the price history
  let carriedQuotes: Offer[] = []; // RAW live quotes the scan that wrote the cache row got (cache hit only): a hit ranks them like that scan did
  let quoteStats = new Map<QuoteSourceName, QuoteStat>();

  // Step 2: cache check. A row that holds fares is a hit, and so is a scan that found nothing (for a shorter time:
  // repeating a no-result search must not repeat up to 30 upstream calls). A damaged row is a miss.
  // With stale-while-revalidate a row up to STALE_MAX_AGE_HOURS old is read; one older than the TTL is a hit only when it
  // holds fares (an old EMPTY scan is a miss, as before), and the answer then says how old it is (meta.stale).
  const swr = deps.staleWhileRevalidate === true && deps.waitUntil !== undefined;
  const readAgeHours = swr ? Math.max(SCORING.cacheTtlHours, STALE_MAX_AGE_HOURS) : SCORING.cacheTtlHours;
  const hit = await attempt(() => repo.getCachedOffers(searchKey, readAgeHours, now));
  const cachedRts = hit ? sanitizeOffers(hit.offers) : [];
  const cachedPairs = hit?.oneWayPairs ? sanitizeOneWayPairs(hit.oneWayPairs) : null;
  const cachedFares = cachedPairs ? cachedPairs.reduce((n, p) => n + p.outs.length + p.backs.length, 0) : 0;
  const hitAgeMs = hit ? now.getTime() - Date.parse(hit.createdAt) : Number.NaN;
  const isStale = hit !== null && !(hitAgeMs < SCORING.cacheTtlHours * 3_600_000);
  const fromCache = hit !== null && (isStale ? cachedRts.length + cachedFares > 0 : cachedRts.length + cachedFares > 0 || isFreshEmptyScan(hit, now));
  let revalidation: Promise<boolean> = Promise.resolve(false);

  if (fromCache && hit) {
    fx = await fxForCacheHit(deps);
    // Started now, awaited at the end: the lock and budget reads run while this request ranks the stale fares.
    rts = cachedRts;
    oneWayPairs = cachedPairs ?? [];
    splitsCheckedAt = hit.createdAt; // the fares are as old as the scan that found them
    tpStatus.ok = true;
    tpStatus.error = hit.notes && hit.notes.length > 0 ? hit.notes.join("; ") : null;
    tpStatus.coverage = coverageFromNotes(hit.notes);
    tpStatus.truncated = (tpStatus.coverage?.skippedRequests ?? 0) > 0;
    carriedQuotes = sanitizeOffers(hit.quotes, QUOTE_SOURCE_NAMES).filter((o) => (o.ticketStructure === "roundtrip" || isPublishedSource(o.source)) && (!isPublishedSource(o.source) || pax === 1 && req.adults === 1) && ageHours(o.checkedAt, now) <= QUOTE_MAX_AGE_HOURS);
    // Started now, awaited at the end: the lock and budget reads run while this request ranks the stale fares.
    if (isStale) revalidation = startRevalidation(deps, req, searchKey, pairs, fx, carriedQuotes);
  } else {
    // FX loads while the scan runs; the scan itself does not need it, only split building and ranking do.
    const fxLoad = settle(resolveFx(deps));
    const budget: ScanBudgetVerdict = !tp.configured || !deps.scanBudget ? true : await deps.scanBudget();
    const budgetOk = typeof budget === "boolean" ? budget : budget.allowed === true;
    if (!tp.configured) {
      tpStatus.error = "Travelpayouts is not configured";
      tpStatus.reason = "no_token";
    } else if (!budgetOk) {
      tpStatus.error = "Travelpayouts: too many searches right now";
      tpStatus.reason = "scan_budget";
      budgetWait = typeof budget === "boolean" ? undefined : knownWait(budget.retryAfterSec);
    } else {
      const callsBefore = tp.callCount();
      scan = await scanTravelpayouts(tp, req, pairs);
      tpStatus.calls = tp.callCount() - callsBefore;
    }
    const fxResult = await fxLoad;
    if (!fxResult.ok) throw new PipelineError("fx_unavailable", "Exchange rates are unavailable");
    fx = fxResult.value;

    if (scan) {
      rts = scan.roundTrips.filter((o) => pairOk(req, o.departDate, o.returnDate)).map((o) => scaledCopy(o, pax));
      oneWayPairs = scan.oneWayPairs.map(({ pair, outs, backs }) => ({ origin: pair.origin, destination: pair.dest, outs, backs }));
      tpStatus.ok = scan.failures.length === 0 && scan.successes > 0; // like Python: any failed request = not ok
      if (scan.failures.length > 0) tpStatus.reason = "upstream_down";
      tpStatus.coverage = { plannedRequests: scan.plannedRequests, skippedRequests: scan.skippedRequests, abortedRequests: scan.abortedRequests };
      tpStatus.truncated = scan.skippedRequests > 0;
      if (scan.skippedRequests > 0) {
        scanNotes = [`truncated: ${scan.skippedRequests} of ${scan.plannedRequests} planned requests skipped (limit ${MAX_TP_REQUESTS})`];
      }
      if (scan.rejected.length > 0) {
        scanNotes = [...scanNotes, `not searchable at Travelpayouts: ${scan.rejected.slice(0, 6).join(", ")}`];
      }
      const notes = [...scan.failures, ...scanNotes];
      tpStatus.error = notes.length > 0 ? notes.join("; ") : null;
    }
  }

  // Split tickets are built per request, from the raw one-way fares, so the request's own hour windows, max stops
  // and bag choice decide which legs get combined: a cache hit answers exactly like a fresh scan would.
  // A fare whose source-stated expiry has passed is never ranked (the vendor advises against using expired prices). One-way
  // legs are dropped BEFORE pairing, so an expired cheap leg cannot hide a valid pair behind it.
  let expiredDropped = 0; // match_audit only: legs and offers dropped as source-expired
  const unexpiredLeg = (f: OneWayFare): boolean => {
    const ok = !fareExpired({ fareExpiresAt: f.expiresAt }, now);
    if (!ok) expiredDropped += 1;
    return ok;
  };
  const splits = oneWayPairs.flatMap((p) =>
    buildSplits(p.origin, p.destination, req, p.outs.filter(unexpiredLeg), p.backs.filter(unexpiredLeg), "travelpayouts", fx, pax, splitsCheckedAt),
  );
  // Ranking sees everything the scan found. Only what is cached is cut down (capOffers), never what is ranked.
  const live = [...rts, ...splits];
  tpStatus.offers = live.length;

  // Step 6: merge with recent offers already in the shared DB. With a healthy Travelpayouts result only the
  // background monitor's google_flights rows are added (our own saved fares would just duplicate `live`); when
  // Travelpayouts is unavailable every recent stored fare is a fallback.
  const tpUnavailable = !fromCache && (scan === null || (scan.failures.length > 0 && live.length === 0));
  const stored = await loadRecent(
    repo,
    pairs,
    req,
    tpUnavailable ? undefined : ["google_flights", ...QUOTE_SOURCE_NAMES],
    tpUnavailable ? FALLBACK_MAX_AGE_HOURS : RECENT_ENRICHMENT_MAX_AGE_HOURS,
    now,
  );
  // A scan that succeeded completely: its result is cached below, and the live quotes are asked only in this case, so within
  // the cache TTL every repeat of the search is a cache hit that costs the vendors' free allowances nothing.
  const scanComplete = !fromCache && scan !== null && scan.failures.length === 0 && scan.successes > 0;
  const fromDb = latestPerFlight(stored)
    .filter((o) => !isPublishedSource(o.source) || pax === 1 && req.adults === 1)
    .filter((o) => !isQuoteSource(o.source) || ageHours(o.checkedAt, now) <= QUOTE_MAX_AGE_HOURS) // a stored quote is "live" for a few hours only
    .map((o) => scaledCopy(o, pax)); // stored fares are per passenger
  const gfOffers = fromDb.filter((o) => o.source === "google_flights").length;
  const gfStatus: SourceStatus = { name: "google_flights", enabled: gfOffers > 0, ok: gfOffers > 0, calls: 0, offers: gfOffers, error: null };

  // Step 9 (part): what to write. Only fresh scan results feed the history, never rows read back from the DB.
  // A scan that succeeded but found nothing is cached too (as an empty row). The capped fares are computed once: the row can be written twice.
  let capped: { offers: Offer[]; oneWayPairs: OneWayPair[] } | null = null;
  const cacheRow = (quotes: Offer[]): PersistJob["cache"] => {
    if (!scanComplete) return null;
    capped ??= { offers: capOffers(rts, fx, MAX_CACHED_OFFERS), oneWayPairs: capOneWayPairs(oneWayPairs, fx, MAX_CACHED_ONEWAYS) };
    return { ...capped, notes: scanNotes, quotes };
  };
  const scanHealth = scan === null ? null : { ok: scan.failures.length === 0 && scan.successes > 0, error: scan.failures.join("; ") || null };
  const quoteHealth = () => [...quoteStats].filter(([, st]) => st.calls > 0).map(([name, st]) => ({ name, ok: quoteOk(st), error: st.failures.join("; ") || null }));
  const jobOf = (part: Partial<PersistJob>): PersistJob => ({
    repo, req, searchKey, now, fx, pax, logSearch: deps.skipSearchLog !== true, fresh: [], quotes: [], quoteHealth: [], cache: null, health: null, ...part,
  });
  const wholeJob = () =>
    jobOf({ fresh: fromCache ? [] : live, quotes: quotedRaw, quoteHealth: quoteHealth(), cache: cacheRow(quotedRaw), health: scanHealth });
  const write = (work: Promise<void>): Promise<void> => {
    if (deps.waitUntil) {
      deps.waitUntil(work);
      return Promise.resolve();
    }
    return work;
  };

  if (live.length + fromDb.length === 0 && tpUnavailable && !(deps.quoteSources ?? []).some((s) => s.configured && isPublishedSource(s.name))) {
    await write(persist(wholeJob()));
    throw new PipelineError("source_unavailable", "No fare source is available right now", {
      reason: tpStatus.reason ?? "upstream_down",
      ...(tpStatus.reason === "scan_budget" && budgetWait !== undefined ? { retryAfterSec: budgetWait } : {}),
    });
  }

  // Steps 7-8: extras + FX on copies (`live` stays raw for the cache), then rank.
  const unfiltered = [...live.map(cloneOffer), ...fromDb];
  const working = unfiltered.filter((o) => !fareExpired(o, now));
  expiredDropped += unfiltered.length - working.length;
  const party: Party = { adults: req.adults, children: req.children, infants: req.infants };
  for (const o of working) linkParty(o, party);
  applyExtrasAndFx(working, req, fx);

  /** RAW whole-party quotes -> ranked copies. The same for this scan's quotes and for the ones a cache hit carries. */
  const rankable = (raw: Offer[]): Offer[] => {
    const copies = raw.map(cloneOffer);
    for (const o of copies) linkParty(o, party);
    // SearchApi and SerpApi do not state the return flight (empty carrier list), yet the fare flies back on its carrier, as
    // Travelpayouts assumes for its own: price the return bag fee for that carrier, or a bag would make the quote cheaper than
    // the fully priced fare it replaces. The list is filled for the fee only and emptied again: no return carrier is claimed.
    const unstated = copies.filter((o) => o.inbound.airlines.length === 0 && o.outbound.airlines.length > 0);
    for (const o of unstated) o.inbound.airlines = [...o.outbound.airlines];
    applyExtrasAndFx(copies, req, fx);
    for (const o of unstated) o.inbound.airlines = [];
    return copies;
  };

  // Step 5: live quotes for the cheapest date pairs of the primary airport pair. Complete fresh scans only: a cache hit
  // makes zero external calls (SPEC §16) and ranks the quotes the scan stored with its cache row (carriedQuotes) plus the
  // stored history rows (step 6); a failed or partial scan is not cached, so every repeat would ask the vendors again.
  // Failures here never fail the search.
  const quoters = (deps.quoteSources ?? []).filter((s) => s.configured);
  const primary = pairs[0];
  const emptyCachedAnswer = fromCache && working.length === 0 && carriedQuotes.length === 0;
  const canAskQuotes = quoters.length > 0 && primary && (scanComplete || emptyCachedAnswer || tpUnavailable && quoters.some((s) => isPublishedSource(s.name)));
  const cachedDates = scanComplete && canAskQuotes && primary ? pickQuotePairs(working, primary) : [];
  const dates = canAskQuotes ? (cachedDates.length > 0 ? cachedDates : fallbackQuotePairs(req)) : [];
  let scanStored: Promise<void> | null = null; // the scan's own write, when it was made before the quote phase
  let quotesTotal = 0; // match_audit only: live quotes this search's quote phase considered...
  let quotesDisbelieved = 0; // ...and how many of them were not believed (far below the cached fare)
  if (primary && dates.length > 0) {
    // The scan is worth up to 30 upstream requests: store it BEFORE the vendors are asked, so a client that gives up during
    // the phase (a new search cancels the old one) does not lose it. The price history is written after the ranking has read
    // its context (below), and what depends on the quotes (their history, their health, the cache row's quotes) after the phase.
    scanStored = persist(jobOf({ cache: cacheRow([]), health: scanHealth }));
    await write(scanStored);
    // A vendor whose stored quote for a pair is still live (step 6) is not asked for that pair again: the pair is already confirmed.
    const covered = new Set(fromDb.filter((o) => isQuoteSource(o.source)).map((o) => coverKey(o.source, o.origin, o.destination, o.departDate, o.returnDate)));
    const run = await attempt(() => runQuotes(tpUnavailable ? quoters.filter((s) => isPublishedSource(s.name)) : quoters, primary, dates, party, covered));
    if (run) {
      quoteStats = run.stats;
      const raw = run.offers.filter((o) => pairOk(req, o.departDate, o.returnDate)).map((o) => scaledCopy(o, pax)); // per adult -> party, like every raw fare
      const ranked = rankable(raw);
      // A price far below the cached fare of its own date pair is more likely a misread price than a bargain: not ranked, not stored.
      const believable = plausibleQuotes(ranked, working, primary);
      // Said in meta.sources when a source has NOTHING left: one reading a wrong price wrongly is wrong for every quote it makes,
      // while a single pair far below its cached fare next to believable ones is only a big drop.
      const disbelieved = new Map<QuoteSourceName, { all: number; ignored: number }>();
      ranked.forEach((o, i) => {
        if (!isQuoteSource(o.source)) return;
        const n = disbelieved.get(o.source) ?? { all: 0, ignored: 0 };
        disbelieved.set(o.source, { all: n.all + 1, ignored: n.ignored + (believable[i] ? 0 : 1) });
      });
      for (const [name, n] of disbelieved) if (n.ignored === n.all) quoteStats.get(name)?.notes.push(`${n.ignored} quote(s) ignored: far below the cached fare`);
      for (const n of disbelieved.values()) {
        quotesTotal += n.all;
        quotesDisbelieved += n.ignored;
      }
      quotedRaw = raw.filter((_, i) => believable[i]);
      working.push(...ranked.filter((_, i) => believable[i]));
    }
  } else if (fromCache) {
    working.push(...rankable(carriedQuotes));
  }
  // A live price replaces the cached one for the same flight; the same flight seen by two sources counts once.
  const ranking = mergeQuoted(working);
  // Price guard (priceguard.ts): a cached fare far below its neighbouring dates or its own recent history is tagged; when both
  // signals agree it is kept out of the cards while anything else is priced. One indexed D1 read (the cheapest date pairs' history); storage trouble = no history.
  const since = new Date(now.getTime() - HISTORY_LOOKBACK_DAYS * 86_400_000);
  const targets = historyTargets(ranking, fx, pax);
  const history =
    targets.length > 0 && repo.priceHistory ? ((await attempt(() => repo.priceHistory!(targets, since, HISTORY_ROWS_PER_PAIR))) ?? []) : [];
  const guard = createPriceGuard(ranking, history, fx, pax);
  // ...but a quote that does not state its return flight cannot pass the user's return-hour window or max stops: the cached fare it replaced stays a 🎯 candidate.
  const guarded = applyPriceGuard(ranking, timeCandidates(working, ranking, req), guard);
  const cards = recommend(guarded.pool, req, SCORING, guarded.timeOnly);

  // Step 4 bookkeeping: how many date pairs are candidates for the deep search (top N cheapest pairs).
  const pairsWithPrice = new Set<string>();
  for (const o of ranking) if (o.totalIls !== null) pairsWithPrice.add(`${o.departDate}|${o.returnDate}`);

  // "Together or one by one?" (partycheck.ts): only on a search for 2+ adults. Whether the live check can run for this answer (a
  // capable source with room for a check: one D1 read, made only when such a source is configured); only then do round-trip
  // cards carry the token the check needs.
  const partyMeta = await partyCheckMetaNow(req, quoters, { repo, now });
  const partySigner = partyMeta.partyCheck?.available === true ? deps.partyToken : undefined;
  const views: CardView[] = await Promise.all(
    cards.map(async (card) => ({
      ...card,
      priceContext: await contextFor(repo, card.offer, pax, now),
      ageHours: ageHours(card.offer.checkedAt, now),
      ...airlineFieldsFor(card.offer),
      ...fareFreshness(card.offer, now),
      // From the card's own (already party-sized) links.
      ...(await signedPartyCheckFields(card.offer, req, partySigner)),
    })),
  );

  // History and vendor health come last: the ranking above has read its price context before this search's own prices are written.
  // After the scan's own write, never beside it: both may write the cache row, and the one with the quotes must be the last.
  const rest = jobOf({ logSearch: false, fresh: fromCache ? [] : live, quotes: quotedRaw, guard, quoteHealth: quoteHealth(), cache: quotedRaw.length > 0 ? cacheRow(quotedRaw) : null });
  await write(scanStored ? scanStored.then(() => persist(rest)) : persist({ ...wholeJob(), guard }));

  const stale = fromCache && isStale && hit ? staleInfo(hit.createdAt, now, await revalidation) : null;

  if (deps.skipSearchLog !== true && deps.audit !== false) {
    try {
      // Only what this search already holds: the resolved primary IATA pair (never the request's own text), counts and names.
      // upstreamCalls = Travelpayouts requests made by this search (0 on a cache hit) + the quote vendors' requests (QuoteStat.calls).
      const top = cards[0];
      const topSource = top?.offer.source;
      let liveVsCachedPct: number | null = null;
      if (top && primary && topSource !== undefined && isQuoteSource(topSource) && top.offer.totalIls !== null) {
        const floor = cheapestCachedByPair(
          working.filter((o) => !isQuoteSource(o.source)),
          primary,
        ).get(`${top.offer.departDate}|${top.offer.returnDate}`)?.ils;
        if (floor !== undefined && floor > 0) liveVsCachedPct = ((top.offer.totalIls - floor) / floor) * 100;
      }
      let quoteCalls = 0;
      for (const st of quoteStats.values()) quoteCalls += st.calls;
      const liveSources: string[] = [];
      if (tpStatus.offers > 0) liveSources.push("travelpayouts");
      for (const [name, st] of quoteStats) if (st.offers > 0) liveSources.push(name);
      logMatchAudit({
        origin: primary?.origin ?? "",
        destination: primary?.dest ?? "",
        fromCache,
        staleAgeH: stale ? stale.ageHours : null,
        expiredDropped,
        guardSuspicious: guarded.suspicious.size,
        guardExcluded: guarded.excluded,
        liveSources,
        quotesTotal,
        quotesDisbelieved,
        topCard: top
          ? { kind: top.kinds[0] ?? "", source: top.offer.source, ageH: ageHours(top.offer.checkedAt, now), liveVsCachedPct }
          : null,
        cardKinds: cards.flatMap((c) => c.kinds),
        upstreamCalls: tpStatus.calls + quoteCalls,
      });
    } catch {
      // The audit line never affects the answer.
    }
  }

  return {
    cards: views,
    meta: {
      apiVersion: 1,
      searchKey,
      fromCache,
      fxSource: fx.source,
      fxDate: fx.date,
      sources: [tpStatus, gfStatus, ...quoters.map((s) => quoteStatus(s, quoteStats.get(s.name), fromDb.filter((o) => o.source === s.name).length))],
      candidatePairs: Math.min(SCORING.topNCandidates, pairsWithPrice.size),
      generatedAt: now.toISOString(),
      ...(stale ? { stale } : {}),
      // Only when something was flagged: an ordinary answer keeps exactly the fields it had before the guard.
      ...(guarded.suspicious.size > 0 ? { priceGuard: { suspicious: guarded.suspicious.size, excluded: guarded.excluded } } : {}),
      recommendations: recommendationsMeta(ranking, req, cards),
      airlinePriceLinks: airlinePriceLinks(guarded.pool),
      sourceRegistry: sourceRegistryForRoute(req, resolver),
      // Only on a search for 2+ adults: whether the live party check can run (a configured source qualifies and has room, no children).
      ...partyMeta,
    },
  };
}

// --- stale-while-revalidate -----------------------------------------------------------------------------

/** What a stale answer tells the caller: the scan's time and age, whether a rescan runs, and the Hebrew notice. */
export function staleInfo(cachedAt: string, now: Date, revalidating: boolean): StaleInfo {
  const hours = ageHours(cachedAt, now);
  const whole = Math.max(1, Math.floor(hours));
  const age = whole === 1 ? "לפני שעה" : whole === 2 ? "לפני שעתיים" : `לפני ${whole} שעות`;
  const messageHe = revalidating
    ? `התוצאות מחיפוש שנעשה ${age}, והמחירים עשויים להשתנות. מחירים עדכניים נבדקים עכשיו ברקע: חפשו שוב בעוד דקה כדי לראות אותם.`
    : `התוצאות מחיפוש שנעשה ${age}, והמחירים עשויים להשתנות.`;
  return { cachedAt: new Date(Date.parse(cachedAt)).toISOString(), ageHours: hours, revalidating, messageHe };
}

/**
 * Decides, before the answer is sent, whether a background rescan starts (so meta.stale.revalidating is true only when one
 * really does): Travelpayouts must be configured, this key's refresh lock free, and the global scan budget not spent, in
 * that order (a refused lock spends no budget). Every failure means "no rescan": the stale answer stands on its own.
 *
 * The lock is a FIXED window (Repo.claimWindowLock): one claim per key per REFRESH_LOCK_SECONDS window, and refused
 * attempts write nothing, so a key polled all day still gets a rescan in every window, never less often.
 *
 * Which rescan: while the row still carries live quotes (or no quote source is configured) the lean one below, which keeps
 * those quotes on the rewritten row; once they have expired and a quote source is configured, the whole pipeline (quote
 * phase included, with all its caps and shares) runs in the background, so a key kept warm by stale hits still gets its
 * live price checks.
 */
async function startRevalidation(deps: SearchDeps, req: SearchRequest, searchKey: string, pairs: Pair[], fx: FxRates, carriedQuotes: Offer[]): Promise<boolean> {
  const { repo, tp, now, waitUntil } = deps;
  if (!waitUntil || !tp.configured) return false;
  const locked = await attempt(() => repo.claimWindowLock(`refresh:${searchKey}`, REFRESH_LOCK_SECONDS, now));
  if (locked !== true) return false;
  if (deps.scanBudget) {
    const verdict = await attempt(deps.scanBudget);
    // A verdict is a boolean or { allowed } (#22): an object is truthy even when it refuses, so read `allowed`.
    const allowed = typeof verdict === "object" && verdict !== null ? verdict.allowed : verdict === true;
    if (!allowed) return false;
  }
  const quoters = (deps.quoteSources ?? []).filter((s) => s.configured);
  if (carriedQuotes.length === 0 && quoters.length > 0) {
    // The budget unit above is this scan's: the pipeline must not take a second one.
    const full = { ...deps, fx, staleWhileRevalidate: false, waitUntil: undefined, scanBudget: undefined, skipSearchLog: true };
    waitUntil(
      runSearch(full, req).then(
        () => undefined,
        (err: unknown) => console.error("background refresh failed:", err instanceof Error ? err.name : typeof err),
      ),
    );
  } else {
    waitUntil(refreshCache({ ...deps, fx }, req, searchKey, pairs, fx, carriedQuotes));
  }
  return true;
}

/**
 * The background rescan: the same Travelpayouts scan and the same writes as a fresh search's miss path (cache row, price
 * history, source health), minus what only an answer needs (ranking, price context), the search log (the stale answer
 * already logged this search) and the quote phase: the row's still-live quotes are kept on the rewritten row as they are
 * (startRevalidation runs the whole pipeline instead once they have expired). A scan that is not complete leaves the stale
 * row as it is. Never rejects.
 */
async function refreshCache(deps: SearchDeps, req: SearchRequest, searchKey: string, pairs: Pair[], fx: FxRates, carriedQuotes: Offer[]): Promise<void> {
  try {
    const { repo, tp, now } = deps;
    const pax = paxCount(req);
    const scan = await scanTravelpayouts(tp, req, pairs);
    const complete = scan.failures.length === 0 && scan.successes > 0;
    const health = { ok: complete, error: scan.failures.join("; ") || null };
    if (!complete) {
      await persist({ repo, req, searchKey, now, fx, pax, logSearch: false, fresh: [], quotes: [], quoteHealth: [], cache: null, health });
      return;
    }
    const rts = scan.roundTrips.filter((o) => pairOk(req, o.departDate, o.returnDate)).map((o) => scaledCopy(o, pax));
    const oneWayPairs: OneWayPair[] = scan.oneWayPairs.map(({ pair, outs, backs }) => ({ origin: pair.origin, destination: pair.dest, outs, backs }));
    const splits = oneWayPairs.flatMap((p) => buildSplits(p.origin, p.destination, req, p.outs, p.backs, "travelpayouts", fx, pax, now.toISOString()));
    let notes: string[] = [];
    if (scan.skippedRequests > 0) notes = [`truncated: ${scan.skippedRequests} of ${scan.plannedRequests} planned requests skipped (limit ${MAX_TP_REQUESTS})`];
    if (scan.rejected.length > 0) notes = [...notes, `not searchable at Travelpayouts: ${scan.rejected.slice(0, 6).join(", ")}`];
    const cache = { offers: capOffers(rts, fx, MAX_CACHED_OFFERS), oneWayPairs: capOneWayPairs(oneWayPairs, fx, MAX_CACHED_ONEWAYS), notes, quotes: carriedQuotes };
    await persist({ repo, req, searchKey, now, fx, pax, logSearch: false, fresh: [...rts, ...splits], quotes: [], quoteHealth: [], cache, health });
  } catch (err) {
    console.error("background refresh failed:", err instanceof Error ? err.name : typeof err);
  }
}

// --- step 9: persist ------------------------------------------------------------------------------------

interface PersistJob {
  repo: Repo;
  req: SearchRequest;
  searchKey: string;
  now: Date;
  fx: FxRates;
  pax: number;
  /** False when the search log row was already written (the quote phase splits the write in two). */
  logSearch: boolean;
  fresh: Offer[];
  /** Live quotes of this search (raw, whole party): history, and the cache row's `quotes`. */
  quotes: Offer[];
  quoteHealth: Array<{ name: SourceName; ok: boolean; error: string | null }>;
  /** What to keep for the next identical search, or null when this scan must not be reused. */
  cache: { offers: Offer[]; oneWayPairs: OneWayPair[]; notes: string[]; quotes: Offer[] } | null;
  health: { ok: boolean; error: string | null } | null;
  /**
   * Set once the ranking has run: fresh fares BOTH guard signals reject are not written to the price history, so a stale cached
   * fare cannot become the "lowest we have seen" of a price context or the baseline of the next check. A fare only one signal
   * doubts is written, so the history can learn that a new low level is real.
   */
  guard?: PriceGuard;
}

/** Start of the UTC deal-detection bin (DEAL_CONFIG.binHours) that `now` falls in, canonical ISO. */
function binStart(now: Date): string {
  const binMs = DEAL_CONFIG.binHours * 3_600_000;
  return new Date(Math.floor(now.getTime() / binMs) * binMs).toISOString();
}

/** Best effort and never rejects: a storage hiccup must not turn a good answer into an error. */
async function persist(job: PersistJob): Promise<void> {
  const { repo, now } = job;
  const work: Array<Promise<unknown>> = [];
  if (job.logSearch) work.push(attempt(() => repo.saveSearch(job.req, job.searchKey, now)));
  // A fare already stored unchanged in this deal-detection time bin is not written again (see Repo.savePrices): deals.ts keeps one
  // observation per bin (the cheapest, the older on a tie), so the skipped row changes no verdict, and it saves 3 row writes.
  const fresh = job.guard ? job.fresh.filter((o) => !job.guard!.check(o)?.exclude) : job.fresh;
  if (fresh.length > 0) work.push(attempt(() => repo.savePrices(historyRows(fresh, job.fx, job.pax, job.now), { skipUnchangedSince: binStart(now) })));
  if (job.quotes.length > 0) work.push(attempt(() => repo.savePrices(historyRows(job.quotes, job.fx, job.pax, job.now))));
  for (const h of job.quoteHealth) work.push(attempt(() => repo.recordSourceHealth(h.name, h.ok, h.error, now)));
  if (job.cache) {
    const { offers, oneWayPairs, notes, quotes } = job.cache;
    // Without quotes the row is exactly what it was before the optional sources existed.
    work.push(attempt(() => repo.putCachedOffers(job.searchKey, offers, now, { oneWayPairs, notes, ...(quotes.length > 0 ? { quotes } : {}) })));
  }
  if (job.health) work.push(attempt(() => repo.recordSourceHealth("travelpayouts", job.health!.ok, job.health!.error, now)));
  await Promise.all(work);
}
