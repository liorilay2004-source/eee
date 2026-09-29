/**
 * Optional LIVE fare sources. After the Travelpayouts scan the pipeline asks every configured source for a live
 * round-trip price of the few cheapest date pairs and ranks the answers with everything else: a cached fare gets
 * confirmed (or corrected) and the search no longer depends on one vendor.
 *
 * OWNER RULE: nothing here may ever cost money. Every vendor has a hard request cap BELOW its free allowance, counted
 * in D1 (table source_quota). createQuoteSource is the only code that calls fetch, and it reserves one unit BEFORE
 * every request: no unit (cap reached, missing table, D1 error) means no request. No retries, no card details.
 * A vendor adapter only says how to build one request and how to read the answer; it cannot reach fetch or the counter.
 *
 * Prices follow the Travelpayouts round trips: ONE adult, the vendor's ORIGINAL currency, RAW (no extras, no ILS).
 * The pipeline scales them to the party (scaledCopy) like every other raw offer.
 */
import { aviasalesSearchLink, type Party } from "./travelpayouts";
import type { Leg, Offer, Repo, SourceName, SourceStatus } from "./types";

// --- limits ---------------------------------------------------------------------------------------------

/** Date pairs asked per search: the cheapest ones only. */
export const MAX_QUOTE_PAIRS = 4;
/** Vendor requests per search. Free Workers: 50 subrequests = Travelpayouts 30 + FX 1-2 + this 12 + 6 spare. */
export const MAX_QUOTE_CALLS = 12;
/** One vendor request, headers and body included. The phase costs at most ceil(MAX_QUOTE_CALLS / QUOTE_CONCURRENCY) waves of this. */
export const QUOTE_TIMEOUT_MS = 5_000;
/** workerd keeps 6 connections open at once: more in flight would only queue, and the queue time would eat the timeout. */
export const QUOTE_CONCURRENCY = 6;
/** Offers kept per vendor request (the cheapest): ranking needs a few alternatives, not a whole result page. */
export const MAX_QUOTE_OFFERS_PER_CALL = 20;
/** A stored quote older than this is no longer shown as a "live" fare on later searches. */
export const QUOTE_MAX_AGE_HOURS = 6;
/** Free Workers get 10 ms of CPU per invocation and parsing costs CPU: a vendor page beyond this is refused before it is parsed. */
const MAX_BODY_CHARS = 500_000;

// --- contracts ------------------------------------------------------------------------------------------

export type QuoteSourceName = Extract<SourceName, "ignav" | "wego" | "searchapi" | "serpapi">;
export const QUOTE_SOURCE_NAMES: readonly QuoteSourceName[] = ["ignav", "wego", "searchapi", "serpapi"];
export const isQuoteSource = (name: SourceName): name is QuoteSourceName => (QUOTE_SOURCE_NAMES as readonly string[]).includes(name);

export type QuotaPeriod = "monthly" | "lifetime";

export interface QuotaSpec {
  period: QuotaPeriod;
  /** HARD limit of vendor requests per period. The only number that decides whether a request may be made. */
  cap: number;
  /** The vendor's documented free allowance for that same period. The margin rules below hold `cap` under it. */
  allowance: number;
}

/**
 * How much of the free allowance a cap may use, in percent. A one-off allowance keeps at least 10% spare. A monthly
 * one is counted per UTC month, but a vendor cycle that starts on another day overlaps two of our months (2 x cap in
 * one vendor cycle), so the cap stays under half of it. Where a vendor's terms are unclear the cap must be lower still.
 */
export const LIFETIME_CAP_MAX_PERCENT = 90;
export const MONTHLY_CAP_MAX_PERCENT = 45;

/** True when the cap is a whole number of at least 1 and within the margin above. An unsafe spec makes a source inert. */
export function quotaSpecIsSafe(spec: QuotaSpec): boolean {
  const percent = spec.period === "lifetime" ? LIFETIME_CAP_MAX_PERCENT : spec.period === "monthly" ? MONTHLY_CAP_MAX_PERCENT : 0;
  return Number.isSafeInteger(spec.cap) && Number.isSafeInteger(spec.allowance) && spec.cap >= 1 && spec.cap * 100 <= spec.allowance * percent;
}

/** One date pair. Vendors are asked for ONE adult; `party` only shapes the booking link. */
export interface QuoteQuery {
  origin: string; // primary airport pair only
  destination: string;
  departDate: string;
  returnDate: string;
  party: Party;
}

export interface FareQuoteSource {
  readonly name: QuoteSourceName;
  /** False without an API key (or with an unsafe quota spec): such a source is never called, never counted and not listed in meta.sources. */
  readonly configured: boolean;
  readonly quota: QuotaSpec;
  /** Vendor requests issued so far by this instance (per search): counted after the unit is reserved, before the request. */
  callCount(): number;
  /**
   * Worst case of vendor requests the NEXT quote() may issue; 1 when omitted. A vendor that needs several requests for one
   * quote (Wego: token, search, polls) says so, and says 0 once it will answer without a request: runQuotes takes that many
   * of its MAX_QUOTE_CALLS slots, so the limit counts requests on the wire, not calls of quote().
   */
  nextQuoteRequests?(): number;
  /**
   * Live round-trip offers for exactly this date pair, per ADULT in the vendor's original currency (like
   * TravelpayoutsClient.roundTrips). Rejects with QuoteError; never retries; costs one reserved unit per request.
   */
  quote(q: QuoteQuery): Promise<Offer[]>;
}

export type QuoteErrorCode = "not_configured" | "quota_exhausted" | "timeout" | "network" | "http" | "response";

/** The message is only the code: vendor bodies, URLs and keys never reach an error. */
export class QuoteError extends Error {
  readonly code: QuoteErrorCode;
  /** HTTP status when the vendor answered, else null. */
  readonly status: number | null;
  constructor(code: QuoteErrorCode, status: number | null = null) {
    super(code);
    this.name = "QuoteError";
    this.code = code;
    this.status = status;
  }
}

/** One fare of a vendor response, as an adapter reads it. Unknown values stay null (never guessed). */
export interface ParsedFare {
  price: number; // ONE adult
  currency: string; // ISO 4217, upper case, as the vendor stated it
  outbound: Leg;
  inbound: Leg;
  checkedBag?: boolean;
}

/** What differs per vendor: the request for one date pair and the reading of the answer. Everything else is shared. */
export interface QuoteAdapter {
  readonly name: QuoteSourceName;
  readonly quota: QuotaSpec;
  /** Pure: builds ONE request for ONE date pair, one adult. `key` is the trimmed secret (a header wherever the vendor allows). */
  request(q: QuoteQuery, key: string): { url: string; method?: "GET" | "POST"; headers: Record<string, string>; body?: string };
  /** Pure: drops what it cannot read, never guesses. May throw on garbage (mapped to a "response" error). */
  parse(body: unknown, q: QuoteQuery): ParsedFare[];
}

// --- quota ----------------------------------------------------------------------------------------------

/** "lifetime" for a one-off allowance (or one of unknown nature), else the UTC month "YYYY-MM". */
export function quotaPeriodKey(period: QuotaPeriod, now: Date): string {
  return period === "lifetime" ? "lifetime" : now.toISOString().slice(0, 7);
}

// --- the one place that talks to a vendor ---------------------------------------------------------------

export function createQuoteSource(
  adapter: QuoteAdapter,
  opts: { key?: string; repo: Repo; now: Date; marker?: string; fetchFn?: typeof fetch },
): FareQuoteSource {
  const key = (opts.key ?? "").trim(); // a stray newline in a pasted secret would make the header invalid
  const quota: QuotaSpec = Object.freeze({ ...adapter.quota }); // the cap that was checked is the cap that is used
  const usable = key !== "" && quotaSpecIsSafe(quota);
  const doFetch: typeof fetch = opts.fetchFn ?? ((input, init) => fetch(input, init)); // workerd: fetch needs its global receiver
  let calls = 0;

  async function call(q: QuoteQuery): Promise<unknown> {
    if (!usable) throw new QuoteError("not_configured");
    // Build (and so validate) the request first: a bad query must not burn a unit.
    const req = adapter.request(q, key);

    // RESERVE BEFORE THE REQUEST, never after: a timeout, a crash or a vendor-side retry can then only overcount.
    // Refused, unreadable or failed counter = no request at all (fail closed). There is deliberately no refund.
    let reserved = false;
    try {
      reserved = (await opts.repo.reserveQuota(adapter.name, quotaPeriodKey(quota.period, opts.now), quota.cap, opts.now)) === true;
    } catch {
      reserved = false;
    }
    if (!reserved) throw new QuoteError("quota_exhausted");
    calls += 1;

    let status: number;
    let text: string;
    try {
      const res = await doFetch(req.url, {
        method: req.method ?? "GET",
        headers: { Accept: "application/json", ...req.headers },
        ...(req.body !== undefined ? { body: req.body } : {}),
        // Never follow a redirect with a key attached (and a followed redirect would be a second request).
        redirect: "manual",
        signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      throw new QuoteError(err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network");
    }
    if (status !== 200) throw new QuoteError("http", status);
    if (text.length > MAX_BODY_CHARS) throw new QuoteError("response", status);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new QuoteError("response", status);
    }
  }

  function link(q: QuoteQuery): string | null {
    try {
      return aviasalesSearchLink(q.origin, q.destination, q.departDate, q.returnDate, q.party, opts.marker);
    } catch {
      return null; // odd codes: no link beats a wrong one
    }
  }

  return {
    name: adapter.name,
    quota,
    get configured() {
      return usable;
    },
    callCount: () => calls,

    async quote(q) {
      const body = await call(q);
      let fares: ParsedFare[];
      try {
        fares = adapter.parse(body, q);
      } catch {
        throw new QuoteError("response");
      }
      const checkedAt = opts.now.toISOString();
      const seen = new Set<string>();
      const offers: Offer[] = [];
      for (const f of fares) {
        if (!Number.isFinite(f.price) || f.price <= 0 || !/^[A-Z]{3}$/.test(f.currency)) continue;
        const dup = [f.outbound.departTime, f.inbound.departTime, f.price, f.currency, f.outbound.airlines[0] ?? ""].join("|");
        if (seen.has(dup)) continue;
        seen.add(dup);
        offers.push({
          origin: q.origin,
          destination: q.destination,
          departDate: q.departDate, // the vendor was asked for exactly these dates
          returnDate: q.returnDate,
          priceAmount: f.price,
          priceCurrency: f.currency,
          source: adapter.name,
          ticketStructure: "roundtrip",
          outbound: { ...f.outbound, airlines: [...f.outbound.airlines] },
          inbound: { ...f.inbound, airlines: [...f.inbound.airlines] },
          includes: typeof f.checkedBag === "boolean" ? { checkedBag: f.checkedBag } : {},
          deeplink: link(q), // an Aviasales search for the same dates (affiliate marker), like Travelpayouts' own fallback
          verifyLink: null,
          checkedAt,
          extrasAmountIls: 0,
          totalIls: null,
          tags: [],
        });
      }
      return offers.sort((a, b) => a.priceAmount - b.priceAmount).slice(0, MAX_QUOTE_OFFERS_PER_CALL);
    },
  };
}

// --- choosing the pairs, merging the answers ------------------------------------------------------------

/**
 * The cheapest date pairs by ILS total (extras included, as the ranker sees them) among the Travelpayouts fares of the
 * primary airport pair: those are the cached prices worth confirming. Needs totalIls, i.e. after applyExtrasAndFx.
 */
export function pickQuotePairs(offers: Offer[], primary: { origin: string; dest: string }, max: number = MAX_QUOTE_PAIRS): Array<[string, string]> {
  const best = new Map<string, { dates: [string, string]; ils: number }>();
  for (const o of offers) {
    if (o.source !== "travelpayouts" || o.totalIls === null || o.origin !== primary.origin || o.destination !== primary.dest) continue;
    const key = `${o.departDate}|${o.returnDate}`;
    const cur = best.get(key);
    if (!cur || o.totalIls < cur.ils) best.set(key, { dates: [o.departDate, o.returnDate], ils: o.totalIls });
  }
  return [...best.values()]
    .sort((a, b) => a.ils - b.ils || a.dates[0].localeCompare(b.dates[0]) || a.dates[1].localeCompare(b.dates[1]))
    .slice(0, Math.min(max, MAX_QUOTE_PAIRS)) // a caller can ask for fewer pairs, never for more
    .map((v) => v.dates);
}

const outKey = (o: Offer): string => JSON.stringify([o.origin, o.destination, o.departDate, o.returnDate, o.outbound.departTime]);
/** Some vendors do not state the return departure: an unknown one cannot contradict a known one. */
const sameReturn = (a: Offer, b: Offer): boolean => a.inbound.departTime === null || b.inbound.departTime === null || a.inbound.departTime === b.inbound.departTime;

/**
 * Dedupe of the same flight seen by several sources. Needs totalIls (after applyExtrasAndFx). Only touches round trips:
 *  - quotes of the same itinerary (same dates, same outbound departure, compatible return) collapse to one: the newest,
 *    then the cheapest (two vendors serving Google Flights, or an older stored quote next to a fresh one);
 *  - every Travelpayouts / google_flights round trip of an itinerary that a quote covers is dropped, even when it is the
 *    cheaper one: a live price replaces a cached one, otherwise "confirmed" would still show the stale price;
 *  - a quote in a currency without an FX rate cannot be ranked, so it replaces nothing and is dropped.
 * Without any quote in the pool the pool comes back untouched.
 */
export function mergeQuoted(pool: Offer[]): Offer[] {
  if (!pool.some((o) => isQuoteSource(o.source))) return pool;
  const ranked = pool
    .filter((o) => isQuoteSource(o.source) && o.ticketStructure === "roundtrip" && o.totalIls !== null)
    .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt) || (a.totalIls as number) - (b.totalIls as number));
  const kept = new Map<string, Offer[]>();
  for (const q of ranked) {
    const bucket = kept.get(outKey(q)) ?? [];
    if (!bucket.some((k) => sameReturn(k, q))) kept.set(outKey(q), [...bucket, q]);
  }
  const survivors = new Set([...kept.values()].flat());
  return pool.filter((o) => {
    if (isQuoteSource(o.source)) return survivors.has(o) || o.ticketStructure !== "roundtrip";
    if (o.ticketStructure !== "roundtrip") return true;
    return !(kept.get(outKey(o)) ?? []).some((k) => sameReturn(k, o));
  });
}

// --- the phase ------------------------------------------------------------------------------------------

export interface QuoteStat {
  calls: number; // vendor requests actually issued
  succeeded: number;
  offers: number;
  failures: string[];
  /** Remarks that are not failures: quota reached, calls skipped by the per-search limit. */
  notes: string[];
}

/** Slots the next quote() of a source may use: what it says, or 1 when it says nothing sensible (never less than it might spend). */
function requestsOf(source: FareQuoteSource): number {
  let n: unknown;
  try {
    n = source.nextQuoteRequests?.();
  } catch {
    n = undefined;
  }
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.ceil(n) : 1;
}

const LABEL: Record<QuoteSourceName, string> = { ignav: "Ignav", wego: "Wego", searchapi: "SearchApi", serpapi: "SerpApi" };

/** Fixed texts only: nothing of a vendor response, URL or key can get into meta.sources. */
export function describeQuoteError(source: FareQuoteSource, e: unknown): string {
  const label = LABEL[source.name];
  if (!(e instanceof QuoteError)) return `${label}: unexpected error`;
  switch (e.code) {
    case "quota_exhausted":
      return `${label}: free quota used up (${source.quota.period})`; // also what an unreadable counter looks like: fail closed
    case "not_configured":
      return `${label}: not configured`;
    case "timeout":
      return `${label}: timeout`;
    case "network":
      return `${label}: network error`;
    case "http":
      return `${label}: HTTP ${e.status ?? "error"}`;
    case "response":
      return `${label}: unexpected response`;
  }
}

/**
 * Asks every source for every date pair (pair-major: if MAX_QUOTE_CALLS bites, the cheapest pairs keep all sources),
 * at most QUOTE_CONCURRENCY requests at a time, and never more than MAX_QUOTE_CALLS in total. One failing source, pair
 * or request never affects another. A source that is out of quota, unconfigured or refused with 401/403/429 is not
 * asked again in this search.
 */
export async function runQuotes(
  sources: FareQuoteSource[],
  primary: { origin: string; dest: string },
  dates: Array<[string, string]>,
  party: Party,
): Promise<{ offers: Offer[]; stats: Map<QuoteSourceName, QuoteStat> }> {
  const stats = new Map<QuoteSourceName, QuoteStat>();
  const before = new Map<QuoteSourceName, number>();
  for (const s of sources) {
    stats.set(s.name, { calls: 0, succeeded: 0, offers: 0, failures: [], notes: [] });
    before.set(s.name, s.callCount());
  }
  const queue = dates.slice(0, MAX_QUOTE_PAIRS).flatMap(([departDate, returnDate]) =>
    sources.map((source) => ({ source, q: { origin: primary.origin, destination: primary.dest, departDate, returnDate, party } satisfies QuoteQuery })),
  );
  const offers: Offer[] = [];
  const stopped = new Set<QuoteSourceName>();
  const skipped = new Map<QuoteSourceName, number>();
  let slots = 0; // requests started or about to start (worst case per quote): taken before any await, so MAX_QUOTE_CALLS holds under concurrency

  async function lane(): Promise<void> {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const { source, q } = item;
      const stat = stats.get(source.name);
      if (!stat || stopped.has(source.name)) continue;
      const cost = requestsOf(source);
      if (cost > 0 && slots + cost > MAX_QUOTE_CALLS) {
        skipped.set(source.name, (skipped.get(source.name) ?? 0) + 1);
        continue;
      }
      slots += cost;
      try {
        const got = await source.quote(q);
        stat.succeeded += 1;
        stat.offers += got.length;
        offers.push(...got);
      } catch (e) {
        const err = e instanceof QuoteError ? e : null;
        const text = describeQuoteError(source, e);
        const noRequest = err?.code === "quota_exhausted" || err?.code === "not_configured";
        const list = err?.code === "quota_exhausted" ? stat.notes : stat.failures;
        if (!list.includes(text)) list.push(text);
        if (noRequest) slots -= cost; // nothing went out: give the slots back
        if (noRequest || (err?.code === "http" && (err.status === 401 || err.status === 403 || err.status === 429))) stopped.add(source.name);
      }
    }
  }
  await Promise.allSettled(Array.from({ length: Math.min(QUOTE_CONCURRENCY, queue.length) }, lane));

  for (const s of sources) {
    const stat = stats.get(s.name);
    if (!stat) continue;
    stat.calls = s.callCount() - (before.get(s.name) ?? 0);
    const n = skipped.get(s.name) ?? 0;
    if (n > 0) stat.notes.push(`${n} request(s) skipped (limit ${MAX_QUOTE_CALLS} per search)`);
  }
  return { offers, stats };
}

/** meta.sources entry: the fresh run's numbers, or (cache hit, nothing asked) what stored quotes still contribute. */
export function quoteStatus(source: FareQuoteSource, stat: QuoteStat | undefined, storedOffers: number): SourceStatus {
  if (!stat) return { name: source.name, enabled: true, ok: storedOffers > 0, calls: 0, offers: storedOffers, error: null };
  const notes = [...stat.failures, ...stat.notes];
  return {
    name: source.name,
    enabled: true,
    ok: stat.failures.length === 0 && stat.succeeded > 0 && stat.calls > 0, // a source that was refused before any request did not work
    calls: stat.calls,
    offers: stat.offers,
    error: notes.length > 0 ? notes.join("; ") : null,
  };
}
