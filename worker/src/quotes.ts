/**
 * Optional LIVE fare sources. After the Travelpayouts scan the pipeline asks every configured source for a live
 * round-trip price of the few cheapest date pairs and ranks the answers with everything else: a cached fare gets
 * confirmed (or corrected) and the search no longer depends on one vendor.
 *
 * OWNER RULE: nothing here may ever cost money. Every vendor has a hard request cap BELOW its free allowance, counted
 * in D1 (table source_quota). createQuoteSource is the only code that calls fetch, and it reserves one unit BEFORE
 * every request: no unit (cap reached, missing table, D1 error) means no request. No retries, no card details.
 * On top of the cap every vendor has a per-day share of it (withDailyShare, wired in index.ts), so a client that dodges the
 * search cache cannot use up a whole allowance in minutes. It is taken first and fails closed the same way.
 * A vendor adapter only says how to build one request and how to read the answer; it cannot reach fetch or the counter.
 *
 * Prices follow the Travelpayouts round trips: ONE adult, the vendor's ORIGINAL currency, RAW (no extras, no ILS).
 * The pipeline scales them to the party (scaledCopy) like every other raw offer.
 */
import { hasTimePrefs, matchesTimes } from "./scoring";
import { aviasalesSearchLink, type Party } from "./travelpayouts";
import type { Leg, Offer, Repo, SearchRequest, SourceName, SourceStatus } from "./types";
import type { PricedDirection } from "./direct-combinations";

// --- limits ---------------------------------------------------------------------------------------------

/** Date pairs asked per search: the cheapest ones only. */
export const MAX_QUOTE_PAIRS = 4;
/** Vendor requests per search. Free Workers: 50 subrequests = Travelpayouts 30 + FX 1-3 + this 12 + 5 spare. */
export const MAX_QUOTE_CALLS = 12;
/** One vendor request, headers and body included. The phase costs at most ceil(MAX_QUOTE_CALLS / QUOTE_CONCURRENCY) waves of this. */
export const QUOTE_TIMEOUT_MS = 12_000;
/** workerd keeps 6 connections open at once: more in flight would only queue, and the queue time would eat the timeout. */
export const QUOTE_CONCURRENCY = 6;
/** Offers kept per vendor request (the cheapest): ranking needs a few alternatives, not a whole result page. */
export const MAX_QUOTE_OFFERS_PER_CALL = 20;
/**
 * The whole quote phase, from the first request to the last answer. No request STARTS after it and a late answer is ignored,
 * so a slow or hanging vendor cannot hold a search (whose Travelpayouts scan is already stored by then) for ceil(calls / lanes)
 * timeouts. A request that was in flight still used its reserved unit: abandoning it can only overcount.
 */
export const QUOTE_PHASE_DEADLINE_MS = 16_000;
/** A stored quote older than this is no longer shown as a "live" fare on later searches. */
export const QUOTE_MAX_AGE_HOURS = 6;
/**
 * A live quote below this share of the cheapest cached fare of its own date pair is not believed (an adapter reading a one-way
 * or a per-party price would land far below it): it is neither ranked nor stored. A real drop under a 2-7 day old cache is
 * the point of the feature, so the bound is loose.
 */
export const MIN_PLAUSIBLE_QUOTE_SHARE = 0.55;
/** Free Workers get 10 ms of CPU per invocation and parsing costs CPU: a vendor page beyond this is refused before it is parsed. */
const MAX_BODY_CHARS = 500_000;

// --- contracts ------------------------------------------------------------------------------------------

export type QuoteSourceName = Extract<SourceName, "ignav" | "wego" | "searchapi" | "serpapi" | "duffel" | "hasdata" | "ryanair" | "aegean" | "air_canada" | "tap" | "ethiopian" | "air_europa" | "philippine" | "virgin_atlantic" | "air_new_zealand" | "air_baltic" | "sky_express" | "gol" | "aeromexico" | "copa" | "brussels_airlines" | "turkish" | "lufthansa" | "swiss" | "austrian" | "icelandair" | "eurowings" | "finnair" | "norwegian" | "iberia" | "avianca" | "klm" | "american" | "aer_lingus" | "jetblue" | "singapore" | "air_serbia" | "elal" | "direct_combination">;
export const QUOTE_SOURCE_NAMES: readonly QuoteSourceName[] = ["ignav", "wego", "searchapi", "serpapi", "duffel", "hasdata", "ryanair", "aegean", "air_canada", "tap", "ethiopian", "air_europa", "philippine", "virgin_atlantic", "air_new_zealand", "air_baltic", "sky_express", "gol", "aeromexico", "copa", "brussels_airlines", "turkish", "lufthansa", "swiss", "austrian", "icelandair", "eurowings", "finnair", "norwegian", "iberia", "avianca", "klm", "american", "aer_lingus", "jetblue", "singapore", "air_serbia", "elal", "direct_combination"];
export const isPublishedSource = (source: SourceName): boolean => source === "ryanair" || source === "aegean" || source === "air_canada" || source === "tap" || source === "ethiopian" || source === "air_europa" || source === "philippine" || source === "virgin_atlantic" || source === "air_new_zealand" || source === "air_baltic" || source === "sky_express" || source === "gol" || source === "brussels_airlines" || source === "turkish" || source === "lufthansa" || source === "swiss" || source === "austrian" || source === "icelandair" || source === "eurowings" || source === "finnair" || source === "norwegian" || source === "iberia" || source === "avianca" || source === "copa" || source === "aeromexico" || source === "klm" || source === "american" || source === "aer_lingus" || source === "jetblue" || source === "singapore" || source === "air_serbia" || source === "elal" || source === "direct_combination";
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
 * one is counted per UTC month. For vendors where the owner explicitly supplies a free-plan key for live pricing,
 * the cap may use the documented free allowance, while the daily share below prevents one day from burning it all.
 */
export const LIFETIME_CAP_MAX_PERCENT = 90;
export const MONTHLY_CAP_MAX_PERCENT = 100;

/** True when the cap is a whole number of at least 1 and within the margin above. An unsafe spec makes a source inert. */
export function quotaSpecIsSafe(spec: QuotaSpec): boolean {
  const percent = spec.period === "lifetime" ? LIFETIME_CAP_MAX_PERCENT : spec.period === "monthly" ? MONTHLY_CAP_MAX_PERCENT : 0;
  return Number.isSafeInteger(spec.cap) && Number.isSafeInteger(spec.allowance) && spec.cap >= 1 && spec.cap * 100 <= spec.allowance * percent;
}

/** One date pair. Vendors are asked for ONE adult (only the party check sets `adults`); `party` only shapes the booking link. */
export interface QuoteQuery {
  origin: string; // primary airport pair only
  destination: string;
  departDate: string;
  returnDate: string;
  party: Party;
  /**
   * ADDITIVE (party check, src/partycheck.ts): how many adults the VENDOR is asked to price, 1-9. Absent = 1, and then every
   * adapter builds exactly the request it built before this field existed. The search's quote phase never sets it (one adult,
   * scaled to the party later); only the party check does. `party` stays what shapes the booking link.
   */
  adults?: number;
}

/**
 * The adults a vendor request is for: q.adults, or 1 when absent. Anything but a whole number 1-9 throws (a RangeError, like
 * every other bad query), so it fails before a unit of the allowance is reserved.
 */
export function vendorAdults(q: Pick<QuoteQuery, "adults">): number {
  const n = q.adults ?? 1;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 9) throw new RangeError("quote: adults must be a whole number from 1 to 9");
  return n;
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
  nextQuoteRequests?(q?: QuoteQuery): number;
  /** Official one-way advertisements, never inferred from a round-trip total. */
  oneWays?(q: QuoteQuery): Promise<readonly PricedDirection[]>;
  /**
   * Live round-trip offers for exactly this date pair, per ADULT in the vendor's original currency (like
   * TravelpayoutsClient.roundTrips). Rejects with QuoteError; never retries; costs one reserved unit per request.
   */
  quote(q: QuoteQuery): Promise<Offer[]>;
  /** ADDITIVE (party check): how a multi-adult price is read, from the vendor's docs (see PartyPricing). Absent = "unknown": never used. */
  readonly partyPricing?: PartyPricing;
  /**
   * ADDITIVE (party check): one vendor search per query, IN ORDER. Every unit is reserved up front, all or none (fewer units left
   * than queries, in the cap or in the day's share, means no request at all), BEFORE the first request. The first failure
   * rejects (QuoteError) and no later request is made; nothing is retried. An answer that holds no usable fare ends the series
   * too, without an error: nothing later is asked (it could only be compared with nothing), so the result then has FEWER lists
   * than queries. `comparable` (optional) is the caller's own test of a fare (the party check: its currency has a rate today);
   * an answer in which no fare passes it ends the series the same way (see answerUsable). Resolves to the fares of each query
   * that was asked, in order.
   */
  partySeries?(queries: QuoteQuery[], comparable?: (fare: PartyFare) => boolean): Promise<PartyFare[][]>;
}

export type QuoteErrorCode = "not_configured" | "quota_exhausted" | "ration_exhausted" | "timeout" | "network" | "http" | "response";

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
  price: number; // ONE adult (or, in a party check, what the vendor states for the adults it was asked: see PartyPricing)
  currency: string; // ISO 4217, upper case, as the vendor stated it
  outbound: Leg;
  inbound: Leg;
  checkedBag?: boolean;
  /**
   * ADDITIVE (party check): the vendor's own identity of this itinerary (flight numbers + local departure times of both legs),
   * so the same flight can be found in two answers. Only set when the vendor states all of it; absent = unknown (never guessed).
   */
  flightKey?: string | null;
}

/**
 * ADDITIVE (party check): how the price of a search for several adults is read, and on what grounds.
 *   total       the price is for all the adults asked: stated in the vendor's docs, or INFERRED from them and then checked on
 *               every fare by the adapter against the fare's own per-passenger figures (Wego: see partyTotalAgrees). The
 *               adapter's header says which, with the doc's URL.
 *   per_person  the price is for one of them (same rule)
 *   unknown     the docs give no basis: such a source is never used for the party check (a guess could invert the verdict)
 */
export type PartyPricing = "total" | "per_person" | "unknown";

/** ADDITIVE (party check): one fare of a party-check answer, as the vendor priced it for the adults the request asked for. */
export interface PartyFare {
  /** The vendor's price for the request's adults, read the way the source's PartyPricing says. */
  amount: number;
  currency: string;
  /** See ParsedFare.flightKey: null = the vendor did not state the flight's identity. */
  flightKey: string | null;
  outbound: Leg;
  inbound: Leg;
}

/** What differs per vendor: the request for one date pair and the reading of the answer. Everything else is shared. */
export interface QuoteAdapter {
  readonly name: QuoteSourceName;
  readonly quota: QuotaSpec;
  /** ADDITIVE (party check): how a multi-adult price is read (see PartyPricing; the doc's URL where it is set). Absent = "unknown". */
  readonly partyPricing?: PartyPricing;
  /**
   * Pure: builds ONE request for ONE date pair, one adult (or q.adults when the party check sets it; see vendorAdults). `key` is the
   * trimmed secret (a header wherever the vendor allows).
   */
  request(q: QuoteQuery, key: string): { url: string; method?: "GET" | "POST"; headers: Record<string, string>; body?: string };
  /** Pure: drops what it cannot read, never guesses. May throw on garbage (mapped to a "response" error). */
  parse(body: unknown, q: QuoteQuery): ParsedFare[];
}

// --- quota ----------------------------------------------------------------------------------------------

/** "lifetime" for a one-off allowance (or one of unknown nature), else the UTC month "YYYY-MM". */
export function quotaPeriodKey(period: QuotaPeriod, now: Date): string {
  return period === "lifetime" ? "lifetime" : now.toISOString().slice(0, 7);
}

/**
 * The cap alone only stops spending: nothing in it stops a few clients that dodge the search cache (any changed parameter is a
 * new search) from using a whole one-off allowance in minutes, and a lifetime counter never renews. So the Worker also rations
 * every vendor per UTC day: at most its cap divided over 30 days for lifetime allowances, or 10 active search days for
 * monthly allowances, rounded up.
 */
export function dailyShare(period: string, cap: number): number {
  return Math.max(1, Math.ceil(cap / (period === "lifetime" ? 30 : 10)));
}

/**
 * A Repo whose reserveQuota first takes one unit of today's share, THEN one of the real counter: a refusal by the share costs
 * nothing of the allowance. Same rule as the counter: a share that is spent or cannot be read means no request (fail closed),
 * reported as "ration_exhausted". Wraps the repo only where the Worker wires the vendors, so the caps themselves stay testable alone.
 * ADDITIVE: reserveQuotaUnits (the party check's several units at once) goes through the share the same way, all or none: fewer
 * units left in today's share than asked means nothing is taken from the real counter and no request is made.
 */
export function withDailyShare(repo: Repo): Repo {
  return {
    ...repo,
    async reserveQuota(source, period, cap, now) {
      let granted = false;
      try {
        granted = (await repo.reserveDaily(`quota:${source}`, dailyShare(period, cap), now)) === true;
      } catch {
        granted = false;
      }
      if (!granted) throw new QuoteError("ration_exhausted");
      return repo.reserveQuota(source, period, cap, now);
    },
    async reserveQuotaUnits(source, period, cap, units, now) {
      let granted = false;
      try {
        granted = typeof repo.reserveDailyUnits === "function" && (await repo.reserveDailyUnits(`quota:${source}`, dailyShare(period, cap), units, now)) === true;
      } catch {
        granted = false;
      }
      if (!granted) throw new QuoteError("ration_exhausted");
      return typeof repo.reserveQuotaUnits === "function" ? repo.reserveQuotaUnits(source, period, cap, units, now) : false;
    },
  };
}

/**
 * ADDITIVE (party check): whether a series may go on after this answer: it holds a fare, and (with `comparable`) at least one
 * fare the caller can compare. A `comparable` that throws counts as "none": the series stops (fewer requests, never more).
 */
export function answerUsable(fares: readonly PartyFare[], comparable?: (fare: PartyFare) => boolean): boolean {
  if (fares.length === 0) return false;
  if (comparable === undefined) return true;
  try {
    return fares.some((fare) => comparable(fare) === true);
  } catch {
    return false;
  }
}

/**
 * ADDITIVE (party check): reserves `units` of a source's allowance at once, all or none, BEFORE any request (the party check's two
 * searches). A repo that cannot reserve several units, a refusal, or a counter that cannot be read means no request: QuoteError
 * "quota_exhausted" (or the daily share's own "ration_exhausted"). Used by createQuoteSource and the Wego source alike.
 */
export async function reserveUnits(repo: Repo, source: QuoteSourceName, quota: QuotaSpec, units: number, now: Date): Promise<void> {
  let reserved = false;
  try {
    reserved = typeof repo.reserveQuotaUnits === "function" && (await repo.reserveQuotaUnits(source, quotaPeriodKey(quota.period, now), quota.cap, units, now)) === true;
  } catch (err) {
    if (err instanceof QuoteError) throw err; // the daily share (withDailyShare) says why it refused
    reserved = false;
  }
  if (!reserved) throw new QuoteError("quota_exhausted");
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
    } catch (err) {
      if (err instanceof QuoteError) throw err; // the daily share (withDailyShare) says why it refused
      reserved = false;
    }
    if (!reserved) throw new QuoteError("quota_exhausted");
    return send(req);
  }

  /** ONE request whose unit is already reserved: counted, sent, read. Every failure is a bare QuoteError (no body, URL or key). */
  async function send(req: ReturnType<QuoteAdapter["request"]>): Promise<unknown> {
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

  /** The adapter's reading of an answer; a reader that throws is a "response" error, never a crash. */
  function readFares(body: unknown, q: QuoteQuery): ParsedFare[] {
    try {
      return adapter.parse(body, q);
    } catch {
      throw new QuoteError("response");
    }
  }

  return {
    name: adapter.name,
    quota,
    partyPricing: adapter.partyPricing ?? "unknown",
    get configured() {
      return usable;
    },
    callCount: () => calls,

    async partySeries(queries, comparable) {
      if (!usable) throw new QuoteError("not_configured");
      // Build (and so validate) every request first: a bad query must not burn a unit.
      const reqs = queries.map((q) => adapter.request(q, key));
      if (reqs.length === 0) return [];
      // ALL the units, all or none, BEFORE the first request (fail closed; no refund, like quote()).
      await reserveUnits(opts.repo, adapter.name, quota, reqs.length, opts.now);
      const out: PartyFare[][] = [];
      for (const [i, req] of reqs.entries()) {
        const q = queries[i] as QuoteQuery;
        // A failure rejects right here: no later request is made, and nothing is retried.
        const fares = toPartyFares(readFares(await send(req), q));
        out.push(fares);
        // An answer without a usable fare (HTTP 200 with nothing, nothing readable, or nothing the caller can compare) ends the
        // series as well: a later answer could only be compared with nothing, so its request is never sent (its unit stays
        // spent: it can only overcount).
        if (!answerUsable(fares, comparable)) break;
      }
      return out;
    },

    async quote(q) {
      const body = await call(q);
      const fares = readFares(body, q);
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

/** The fares of a party-check answer that can be compared: a positive price in a stated ISO currency. Legs are copied. */
function toPartyFares(fares: ParsedFare[]): PartyFare[] {
  const out: PartyFare[] = [];
  for (const f of fares) {
    if (!Number.isFinite(f.price) || f.price <= 0 || !/^[A-Z]{3}$/.test(f.currency)) continue;
    out.push({
      amount: f.price,
      currency: f.currency,
      flightKey: typeof f.flightKey === "string" && f.flightKey !== "" ? f.flightKey : null,
      outbound: { ...f.outbound, airlines: [...f.outbound.airlines] },
      inbound: { ...f.inbound, airlines: [...f.inbound.airlines] },
    });
  }
  return out;
}

// --- choosing the pairs, merging the answers ------------------------------------------------------------

/** The cheapest ILS total per date pair among the Travelpayouts fares of the primary airport pair: the cached prices worth confirming. Needs totalIls. */
export function cheapestCachedByPair(offers: Offer[], primary: { origin: string; dest: string }): Map<string, { dates: [string, string]; ils: number }> {
  const best = new Map<string, { dates: [string, string]; ils: number }>();
  for (const o of offers) {
    if (o.source !== "travelpayouts" || o.totalIls === null || o.origin !== primary.origin || o.destination !== primary.dest) continue;
    const key = `${o.departDate}|${o.returnDate}`;
    const cur = best.get(key);
    if (!cur || o.totalIls < cur.ils) best.set(key, { dates: [o.departDate, o.returnDate], ils: o.totalIls });
  }
  return best;
}

/**
 * The cheapest date pairs by ILS total (extras included, as the ranker sees them) among the Travelpayouts fares of the
 * primary airport pair: those are the cached prices worth confirming. Needs totalIls, i.e. after applyExtrasAndFx.
 */
export function pickQuotePairs(offers: Offer[], primary: { origin: string; dest: string }, max: number = MAX_QUOTE_PAIRS): Array<[string, string]> {
  return [...cheapestCachedByPair(offers, primary).values()]
    .sort((a, b) => a.ils - b.ils || a.dates[0].localeCompare(b.dates[0]) || a.dates[1].localeCompare(b.dates[1]))
    .slice(0, Math.min(max, MAX_QUOTE_PAIRS)) // a caller can ask for fewer pairs, never for more
    .map((v) => v.dates);
}

/**
 * Per quote: false when it is below MIN_PLAUSIBLE_QUOTE_SHARE of the cheapest cached fare of its own date pair (`cached` = the
 * pool before the quotes, priced). A quote without a cached fare to compare with, or without a total, is not judged here.
 * Nothing about the vendor's price is verified by the code: this only keeps a wrong reading from becoming "the lowest price ever seen".
 */
export function plausibleQuotes(quotes: Offer[], cached: Offer[], primary: { origin: string; dest: string }): boolean[] {
  const floor = cheapestCachedByPair(cached, primary);
  return quotes.map((q) => {
    const ref = floor.get(`${q.departDate}|${q.returnDate}`);
    return ref === undefined || q.totalIls === null || q.totalIls >= ref.ils * MIN_PLAUSIBLE_QUOTE_SHARE;
  });
}

/** What identifies "this vendor was asked for this pair" (runQuotes' `covered`): the quotes already in the pool are the vendor's answer. */
export const coverKey = (source: string, origin: string, destination: string, departDate: string, returnDate: string): string =>
  [source, origin, destination, departDate, returnDate].join("|");

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

/**
 * Cached round trips that mergeQuoted dropped for a quote that cannot itself pass the user's hour windows or max stops (its
 * vendor does not state the return flight: unknown departure hour or stops) while the cached fare, with its verified return,
 * can. They stay candidates for the 🎯 card ONLY (the last argument of recommend): the live price still replaces them for
 * Cheapest and Best value, and no return flight is ever claimed for a quote. `pool` is what went into mergeQuoted.
 */
export function timeCandidates(pool: Offer[], merged: Offer[], req: SearchRequest): Offer[] {
  if (merged === pool || !hasTimePrefs(req)) return [];
  const kept = new Set(merged);
  const covering = merged.filter((q) => isQuoteSource(q.source) && q.ticketStructure === "roundtrip");
  return pool.filter(
    (o) =>
      !kept.has(o) &&
      !isQuoteSource(o.source) &&
      o.ticketStructure === "roundtrip" &&
      matchesTimes(o, req) &&
      !covering.some((q) => outKey(q) === outKey(o) && sameReturn(q, o) && matchesTimes(q, req)),
  );
}

// --- the phase ------------------------------------------------------------------------------------------

export interface QuoteStat {
  calls: number; // vendor requests actually issued
  succeeded: number;
  offers: number;
  failures: string[];
  /** Remarks that are not failures: quota reached, calls skipped by the per-search limits, quotes not believed. */
  notes: string[];
}

/** Slots the next quote() of a source may use: what it says, or 1 when it says nothing sensible (never less than it might spend). */
function requestsOf(source: FareQuoteSource, q: QuoteQuery): number {
  let n: unknown;
  try {
    n = source.nextQuoteRequests?.(q);
  } catch {
    n = undefined;
  }
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.ceil(n) : 1;
}

const LABEL: Record<QuoteSourceName, string> = { ignav: "Ignav", wego: "Wego", searchapi: "SearchApi", serpapi: "SerpApi", duffel: "Duffel", hasdata: "HasData", ryanair: "Ryanair", aegean: "Aegean", air_canada: "Air Canada", tap: "TAP", ethiopian: "Ethiopian", air_europa: "Air Europa", philippine: "Philippine Airlines", virgin_atlantic: "Virgin Atlantic", air_new_zealand: "Air New Zealand", air_baltic: "airBaltic", sky_express: "SKY express", gol: "GOL", brussels_airlines: "Brussels Airlines", turkish: "Turkish Airlines", lufthansa: "Lufthansa", swiss: "SWISS", austrian: "Austrian Airlines", icelandair: "Icelandair", eurowings: "Eurowings", finnair: "Finnair", norwegian: "Norwegian", iberia: "Iberia", avianca: "Avianca", copa: "Copa Airlines", aeromexico: "Aeromexico", klm: "KLM", american: "American Airlines", aer_lingus: "Aer Lingus", jetblue: "JetBlue", singapore: "Singapore Airlines", air_serbia: "Air Serbia", elal: "EL AL", direct_combination: "Official airline combination" };

/** Fixed texts only: nothing of a vendor response, URL or key can get into meta.sources. */
export function describeQuoteError(source: FareQuoteSource, e: unknown): string {
  const label = LABEL[source.name];
  if (!(e instanceof QuoteError)) return `${label}: unexpected error`;
  switch (e.code) {
    case "quota_exhausted":
      return `${label}: free quota used up (${source.quota.period})`; // also what an unreadable counter looks like: fail closed
    case "ration_exhausted":
      return `${label}: today's share of the free quota used up`; // also what an unreadable daily counter looks like: fail closed
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
 * asked again in this search. A (source, pair) in `covered` (see coverKey) is not asked at all: a stored quote of that
 * vendor for that pair is still live, and asking again would only spend allowance.
 * The whole phase ends at QUOTE_PHASE_DEADLINE_MS: what arrived by then is returned, nothing starts later, and a request
 * still in flight is reported as a timeout (its unit was reserved before it went out, so abandoning it never undercounts).
 */
export async function runQuotes(
  sources: FareQuoteSource[],
  primary: { origin: string; dest: string },
  dates: Array<[string, string]>,
  party: Party,
  covered: ReadonlySet<string> = new Set(),
): Promise<{ offers: Offer[]; stats: Map<QuoteSourceName, QuoteStat> }> {
  const stats = new Map<QuoteSourceName, QuoteStat>();
  const before = new Map<QuoteSourceName, number>();
  for (const s of sources) {
    stats.set(s.name, { calls: 0, succeeded: 0, offers: 0, failures: [], notes: [] });
    before.set(s.name, s.callCount());
  }
  const queue = dates.slice(0, MAX_QUOTE_PAIRS).flatMap(([departDate, returnDate]) =>
    sources
      .filter((source) => !covered.has(coverKey(source.name, primary.origin, primary.dest, departDate, returnDate)))
      .map((source) => ({ source, q: { origin: primary.origin, destination: primary.dest, departDate, returnDate, party } satisfies QuoteQuery })),
  );
  const offers: Offer[] = [];
  const stopped = new Set<QuoteSourceName>();
  const skipped = new Map<QuoteSourceName, number>();
  const flying = new Map<QuoteSourceName, number>(); // requests of a source that were asked for and have not answered yet
  let slots = 0; // requests started or about to start (worst case per quote): taken before any await, so MAX_QUOTE_CALLS holds under concurrency
  let closed = false; // the deadline passed: nothing starts any more and a late answer is ignored

  async function lane(): Promise<void> {
    while (!closed) {
      const item = queue.shift();
      if (item === undefined) return;
      const { source, q } = item;
      const stat = stats.get(source.name);
      if (!stat || stopped.has(source.name)) continue;
      const cost = requestsOf(source, q);
      if (cost > 0 && slots + cost > MAX_QUOTE_CALLS) {
        skipped.set(source.name, (skipped.get(source.name) ?? 0) + 1);
        continue;
      }
      slots += cost;
      flying.set(source.name, (flying.get(source.name) ?? 0) + 1);
      try {
        const got = await source.quote(q);
        if (closed) return;
        stat.succeeded += 1;
        stat.offers += got.length;
        offers.push(...got);
      } catch (e) {
        if (closed) return;
        const err = e instanceof QuoteError ? e : null;
        const text = describeQuoteError(source, e);
        const spent = err?.code === "quota_exhausted" || err?.code === "ration_exhausted";
        const noRequest = spent || err?.code === "not_configured";
        const list = spent ? stat.notes : stat.failures;
        if (!list.includes(text)) list.push(text);
        if (noRequest) slots -= cost; // nothing went out: give the slots back
        if (noRequest || (err?.code === "http" && (err.status === 401 || err.status === 403 || err.status === 429))) stopped.add(source.name);
      } finally {
        flying.set(source.name, (flying.get(source.name) ?? 1) - 1);
      }
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), QUOTE_PHASE_DEADLINE_MS);
  });
  let late = false;
  try {
    const lanes = Array.from({ length: Math.min(QUOTE_CONCURRENCY, queue.length) }, lane);
    late = (await Promise.race([Promise.allSettled(lanes).then(() => "done" as const), deadline])) === "deadline";
  } finally {
    clearTimeout(timer);
  }
  closed = true;

  for (const s of sources) {
    const stat = stats.get(s.name);
    if (!stat) continue;
    stat.calls = s.callCount() - (before.get(s.name) ?? 0);
    const n = skipped.get(s.name) ?? 0;
    if (n > 0) stat.notes.push(`${n} request(s) skipped (limit ${MAX_QUOTE_CALLS} per search)`);
    if (!late) continue;
    const text = describeQuoteError(s, new QuoteError("timeout"));
    if ((flying.get(s.name) ?? 0) > 0 && !stat.failures.includes(text)) stat.failures.push(text);
    const unstarted = queue.filter((item) => item.source === s).length;
    if (unstarted > 0) stat.notes.push(`${unstarted} request(s) skipped (time limit ${QUOTE_PHASE_DEADLINE_MS / 1000} s)`);
  }
  return { offers, stats };
}

/** A source worked in this search: it was asked, every request it made succeeded, and it answered at least once. Health and meta.sources share it. */
export const quoteOk = (stat: QuoteStat): boolean => stat.failures.length === 0 && stat.succeeded > 0 && stat.calls > 0;

/** meta.sources entry: the fresh run's numbers, or (cache hit, or every pair already answered by a stored quote) what stored quotes still contribute. */
export function quoteStatus(source: FareQuoteSource, stat: QuoteStat | undefined, storedOffers: number): SourceStatus {
  const asked = stat !== undefined && (stat.calls > 0 || stat.succeeded > 0 || stat.failures.length > 0 || stat.notes.length > 0);
  if (!stat || !asked) return { name: source.name, enabled: true, ok: storedOffers > 0, calls: 0, offers: storedOffers, error: null };
  const notes = [...stat.failures, ...stat.notes];
  return {
    name: source.name,
    enabled: true,
    ok: isPublishedSource(source.name) && stat.succeeded > 0 && stat.failures.length === 0 || quoteOk(stat), // published fare cache hits succeed without a network call
    calls: stat.calls,
    offers: stat.offers,
    error: notes.length > 0 ? notes.join("; ") : null,
  };
}
