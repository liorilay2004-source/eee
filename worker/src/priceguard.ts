/**
 * Price-sanity guard. The Travelpayouts Data API serves CACHED fares (found by other users 2-7 days ago), and now and
 * then one of them is far below anything that can still be booked: a sold-out promo seat, or a mistake that was already
 * fixed. Shown as 💰 "cheapest", it promises a price the booking link will not honour. This module marks such fares
 * with the tag `price_suspicious` so the pipeline can keep them from winning a card while anything else exists.
 *
 * Pure and deterministic: no I/O, no clock reads. Two independent signals, either one is enough:
 *
 *  - PEERS (always available, no D1): the offer is compared with the cheapest fare of each NEIGHBOURING date pair of
 *    the same airport pair in the same search (departure within ±peerDepartDays, trip length within ±peerNightsDelta,
 *    the offer's own date pair excluded). A cached fare at most `(100 - errorDropPct)` % of the median of those
 *    neighbours, with at least minPeers of them, is suspicious: adjacent days of one route are rarely that far apart,
 *    while a stale cache entry is exactly that. The neighbours' MINIMA are used, so a neighbour that is itself cheap
 *    only makes the guard more lenient.
 *  - HISTORY (one indexed D1 read per search, see Repo.priceHistory): the same date pair's own older snapshots in the
 *    shared `prices` table, one per 6-hour bin (the cheapest), strictly older than the offer. At least
 *    minHistoryBins bins on minHistoryDays distinct UTC days are needed; then the same cut-off against their median.
 *
 * The cut-off and the bin size are the deal detector's (deals.ts DEAL_CONFIG.errorDropPct / binHours), so "suspicious
 * here" and "error_fare there" mean the same drop. Only Travelpayouts fares are judged (they are the cached ones): a live
 * quote from an optional source is fresh by definition and has its own plausibility check (quotes.ts plausibleQuotes),
 * and the background monitor's rows are recent. Every source still counts as a peer.
 *
 * Prices are compared per passenger, in ILS, on the BASE fare (no extras): the bag fee depends on the request and would
 * make the same fare look different between searches. Every number here is a conservative estimate, NOT a sourced
 * figure; re-tune against real history.
 */
import { DEAL_CONFIG, median } from "./deals";
import { toIls } from "./money";
import type { FxRates, Offer, PriceHistoryRow } from "./types";

export const PRICE_SUSPICIOUS_TAG = "price_suspicious";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface PriceGuardConfig {
  /** A fare at or below (100 - this) % of the reference is suspicious. */
  dropPct: number;
  /** Neighbouring date pairs: departure at most this many days away... */
  peerDepartDays: number;
  /** ...and a trip length at most this many nights different. */
  peerNightsDelta: number;
  /** Neighbouring date pairs (with a price) needed before the peer signal speaks. */
  minPeers: number;
  /** History bins (strictly older than the offer) needed before the history signal speaks... */
  minHistoryBins: number;
  /** ...spread over at least this many distinct UTC days. */
  minHistoryDays: number;
  binHours: number;
}

export const PRICE_GUARD_CONFIG: Readonly<PriceGuardConfig> = {
  dropPct: DEAL_CONFIG.errorDropPct,
  peerDepartDays: 3,
  peerNightsDelta: 2,
  minPeers: 4,
  minHistoryBins: 3,
  minHistoryDays: 2,
  binHours: DEAL_CONFIG.binHours,
};

/** How many date pairs get a history read (the cheapest ones: only they can win 💰), and how far back it looks. */
export const HISTORY_PAIRS = 5;
export const HISTORY_ROWS_PER_PAIR = 40;
export const HISTORY_LOOKBACK_DAYS = 30;

/** One stored snapshot of a date pair (prices table columns; the amount is PER PASSENGER). */
export type HistoryRow = PriceHistoryRow;

export interface DatePair {
  origin: string;
  destination: string;
  departDate: string;
  returnDate: string;
}

export type SuspicionReason = "peers" | "history";

export interface PriceGuard {
  /** Why the offer is suspicious, or null when it is not (or cannot be judged). */
  check(o: Offer): SuspicionReason | null;
}

const pairKey = (o: { origin: string; destination: string; departDate: string; returnDate: string }): string =>
  `${o.origin}|${o.destination}|${o.departDate}|${o.returnDate}`;
const routeKey = (o: { origin: string; destination: string }): string => `${o.origin}|${o.destination}`;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function dayNum(s: string): number | null {
  const m = ISO_DATE.exec(s);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? ms / DAY_MS : null;
}

/** Base fare per passenger in ILS, or null when it cannot be priced. */
function perPaxIls(fx: FxRates, amount: number, currency: string, pax: number): number | null {
  if (!(typeof amount === "number" && Number.isFinite(amount) && amount > 0) || !(pax >= 1)) return null;
  try {
    const v = toIls(fx, amount, currency) / pax;
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** The date pairs whose history is worth one read: the cheapest distinct Travelpayouts pairs, cheapest first. */
export function historyTargets(offers: readonly Offer[], fx: FxRates, pax: number, max: number = HISTORY_PAIRS): DatePair[] {
  const best = new Map<string, { pair: DatePair; ils: number }>();
  for (const o of offers) {
    if (o.source !== "travelpayouts") continue;
    const ils = perPaxIls(fx, o.priceAmount, o.priceCurrency, pax);
    if (ils === null) continue;
    const k = pairKey(o);
    const cur = best.get(k);
    if (!cur || ils < cur.ils) best.set(k, { pair: { origin: o.origin, destination: o.destination, departDate: o.departDate, returnDate: o.returnDate }, ils });
  }
  return [...best.values()]
    .sort((a, b) => a.ils - b.ils || (pairKey(a.pair) < pairKey(b.pair) ? -1 : 1))
    .slice(0, Math.max(0, max))
    .map((v) => v.pair);
}

interface PairInfo {
  dep: number;
  nights: number;
  minIls: number;
}

/**
 * Builds the guard over the search's own offers (`peers`, whole-party prices, any source) and the history rows read for
 * it. `pax` converts whole-party amounts to per passenger; history rows are already per passenger.
 */
export function createPriceGuard(
  peers: readonly Offer[],
  history: readonly HistoryRow[],
  fx: FxRates,
  pax: number,
  config: Partial<PriceGuardConfig> = {},
): PriceGuard {
  const cfg: PriceGuardConfig = { ...PRICE_GUARD_CONFIG };
  for (const k of Object.keys(PRICE_GUARD_CONFIG) as (keyof PriceGuardConfig)[]) {
    const v = config[k];
    if (typeof v === "number" && Number.isFinite(v)) cfg[k] = v;
  }
  if (!(cfg.binHours > 0)) cfg.binHours = PRICE_GUARD_CONFIG.binHours;
  const share = 1 - cfg.dropPct / 100;
  const EPS = 1e-9;

  // A search has a few hundred distinct dates at most: parse each once.
  const days = new Map<string, number | null>();
  const day = (s: string): number | null => {
    let v = days.get(s);
    if (v === undefined) {
      v = typeof s === "string" ? dayNum(s) : null;
      days.set(s, v);
    }
    return v;
  };

  // Cheapest fare per date pair, grouped per airport pair and sorted by departure day (for the neighbour window).
  const pairs = new Map<string, PairInfo & { route: string }>();
  for (const o of peers) {
    const ils = perPaxIls(fx, o.priceAmount, o.priceCurrency, pax);
    const dep = day(o.departDate);
    const ret = day(o.returnDate);
    if (ils === null || dep === null || ret === null || ret < dep) continue;
    const k = pairKey(o);
    const cur = pairs.get(k);
    if (!cur || ils < cur.minIls) pairs.set(k, { dep, nights: ret - dep, minIls: ils, route: routeKey(o) });
  }
  const byRoute = new Map<string, Array<PairInfo & { key: string }>>();
  for (const [key, p] of pairs) {
    const list = byRoute.get(p.route) ?? [];
    list.push({ key, dep: p.dep, nights: p.nights, minIls: p.minIls });
    byRoute.set(p.route, list);
  }
  for (const list of byRoute.values()) list.sort((a, b) => a.dep - b.dep);
  // The peer reference is a median of some of a route's pair minima, so never above the dearest one: a fare above `share` of that
  // cannot be flagged by peers, and most fares of a search are rejected with one comparison instead of a neighbour scan.
  const routeMax = new Map<string, number>();
  for (const [route, list] of byRoute) routeMax.set(route, list.reduce((m, p) => (p.minIls > m ? p.minIls : m), 0));

  const peerRef = new Map<string, number | null>();
  function peerReference(o: Offer): number | null {
    const k = pairKey(o);
    if (peerRef.has(k)) return peerRef.get(k) ?? null;
    let ref: number | null = null;
    const own = pairs.get(k);
    const list = byRoute.get(routeKey(o));
    if (own && list) {
      const near: number[] = [];
      // First index whose departure is inside the window (the list is sorted by departure): the scan stays O(window), not O(route).
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((list[mid] as PairInfo).dep < own.dep - cfg.peerDepartDays) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < list.length; i++) {
        const p = list[i] as PairInfo & { key: string };
        if (p.dep > own.dep + cfg.peerDepartDays) break;
        if (p.key === k || Math.abs(p.nights - own.nights) > cfg.peerNightsDelta) continue;
        near.push(p.minIls);
      }
      if (near.length >= Math.max(1, cfg.minPeers)) ref = median(near);
    }
    peerRef.set(k, ref);
    return ref;
  }

  // History: per date pair, the rows as (ms, per-pax ILS).
  const hist = new Map<string, Array<{ ms: number; ils: number }>>();
  for (const r of history) {
    if (r === null || typeof r !== "object") continue;
    const ms = typeof r.checked_at === "string" ? Date.parse(r.checked_at) : NaN;
    const ils = typeof r.price_currency === "string" ? perPaxIls(fx, r.price_amount, r.price_currency, 1) : null;
    if (!Number.isFinite(ms) || ils === null) continue;
    const k = pairKey({ origin: r.origin, destination: r.destination, departDate: r.depart_date, returnDate: r.return_date });
    const list = hist.get(k) ?? [];
    list.push({ ms, ils });
    hist.set(k, list);
  }

  function historyReference(o: Offer): number | null {
    const rows = hist.get(pairKey(o));
    const before = Date.parse(o.checkedAt);
    if (!rows || !Number.isFinite(before)) return null;
    const binMs = cfg.binHours * HOUR_MS;
    const bins = new Map<number, number>();
    for (const r of rows) {
      if (r.ms >= before) continue; // never compared with itself or with what came after it
      const b = Math.floor(r.ms / binMs);
      const cur = bins.get(b);
      if (cur === undefined || r.ils < cur) bins.set(b, r.ils);
    }
    if (bins.size < Math.max(1, cfg.minHistoryBins)) return null;
    const days = new Set([...bins.keys()].map((b) => Math.floor((b * binMs) / DAY_MS))).size;
    if (days < cfg.minHistoryDays) return null;
    return median([...bins.values()]);
  }

  return {
    check(o: Offer): SuspicionReason | null {
      if (o.source !== "travelpayouts") return null;
      const ils = perPaxIls(fx, o.priceAmount, o.priceCurrency, pax);
      if (ils === null) return null;
      const max = routeMax.get(routeKey(o));
      const peer = max !== undefined && ils <= max * share + EPS ? peerReference(o) : null;
      if (peer !== null && ils <= peer * share + EPS) return "peers";
      const past = hist.size > 0 ? historyReference(o) : null;
      if (past !== null && ils <= past * share + EPS) return "history";
      return null;
    },
  };
}

export interface GuardOutcome {
  /** What to rank: the pool without suspicious offers, or the whole pool when nothing else is priced. */
  pool: Offer[];
  /** The same filter for the 🎯-only candidates. */
  timeOnly: Offer[];
  /** Offers found suspicious (each got the tag). */
  suspicious: Set<Offer>;
  /** How many suspicious offers were kept out of the ranking (0 when the fallback kept them in). */
  excluded: number;
}

/**
 * Tags every suspicious offer of `pool` and `timeOnly` and keeps them out of the ranking, unless that would leave no
 * priced offer at all: then everything stays in (tagged), because a suspicious price is still better than an empty
 * page. Mutates only the tags of the given (working copy) offers.
 */
export function applyPriceGuard(pool: Offer[], timeOnly: Offer[], guard: PriceGuard): GuardOutcome {
  const suspicious = new Set<Offer>();
  for (const o of [...pool, ...timeOnly]) {
    if (o.totalIls === null || guard.check(o) === null) continue;
    suspicious.add(o);
    if (!o.tags.includes(PRICE_SUSPICIOUS_TAG)) o.tags.push(PRICE_SUSPICIOUS_TAG);
  }
  if (suspicious.size === 0) return { pool, timeOnly, suspicious, excluded: 0 };
  const kept = pool.filter((o) => !suspicious.has(o));
  if (!kept.some((o) => o.totalIls !== null)) return { pool, timeOnly, suspicious, excluded: 0 };
  const excluded = pool.length - kept.length;
  return { pool: kept, timeOnly: timeOnly.filter((o) => !suspicious.has(o)), suspicious, excluded };
}
