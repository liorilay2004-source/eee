/**
 * Date-pair helpers and split-ticket construction (SPEC §7 layers 1 and 3).
 * Ports SearchRequest.valid_pairs / pair_ok and pipeline.build_splits from the Python engine.
 */
import { legBagFeeIls, round2 } from "./extras";
import { earlierOf, olderOf } from "./freshness";
import { toIls } from "./money";
import { hasTimePrefs, inWindow } from "./scoring";
import { BAG_FEES, type BagFeeTable } from "./scoring.config";
import type { FxRates, Leg, Offer, OneWayFare, SearchRequest, SourceName } from "./types";

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whole days since 1970-01-01 (UTC) for a strict, real calendar "YYYY-MM-DD"; null otherwise. */
export function dayNumber(iso: string): number | null {
  const g = typeof iso === "string" ? ISO_DATE.exec(iso) : null;
  if (!g) return null;
  const y = Number(g[1]);
  const m = Number(g[2]);
  const d = Number(g[3]);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  // Date.UTC rolls 2026-02-30 over to March: the round trip catches it.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

export function isoFromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

type Window = Pick<SearchRequest, "windowStart" | "windowEnd" | "stayMin" | "stayMax">;

/** Every (depart, return) pair inside the window whose stay length is in range. Empty on unparseable dates. */
export function validPairs(req: Window): Array<[string, string]> {
  const start = dayNumber(req.windowStart);
  const end = dayNumber(req.windowEnd);
  if (start === null || end === null) return [];
  const pairs: Array<[string, string]> = [];
  for (let d = start; d <= end; d++) {
    for (let n = req.stayMin; n <= req.stayMax; n++) {
      if (d + n <= end) pairs.push([isoFromDayNumber(d), isoFromDayNumber(d + n)]);
    }
  }
  return pairs;
}

/** Number of valid pairs without building them (used to bound a request before doing any work). */
export function countValidPairs(windowStart: string, windowEnd: string, stayMin: number, stayMax: number): number {
  const start = dayNumber(windowStart);
  const end = dayNumber(windowEnd);
  if (start === null || end === null) return 0;
  const span = end - start;
  let count = 0;
  for (let n = Math.max(0, stayMin); n <= stayMax; n++) if (span - n >= 0) count += span - n + 1;
  return count;
}

/** True if the pair lies inside the window and its stay length is in range. */
export function pairOk(req: Window, depart: string, ret: string): boolean {
  const d = dayNumber(depart);
  const r = dayNumber(ret);
  const start = dayNumber(req.windowStart);
  const end = dayNumber(req.windowEnd);
  if (d === null || r === null || start === null || end === null) return false;
  const nights = r - d;
  return start <= d && r <= end && req.stayMin <= nights && nights <= req.stayMax;
}

/** ILS value, or null when there is no FX rate: an unconvertible fare must be skipped, never guessed. */
function ilsOrNull(fx: FxRates, amount: number, currency: string): number | null {
  try {
    const v = toIls(fx, amount, currency);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Cheapest fare per day, first wins ties, optionally only legs that pass `keep`. "Cheapest" is fare + the
 * checked-bag fee when the user wants a bag (SPEC §4.1), because that is what the ranker compares: a leg that is
 * cheaper on the base fare can be dearer once its carrier's bag fee is added.
 */
function cheapestByDay(
  fares: OneWayFare[],
  keep: ((leg: Leg) => boolean) | null,
  fx: FxRates,
  bagFeeOf: (leg: Leg) => number,
): Map<string, OneWayFare> {
  const best = new Map<string, { fare: OneWayFare; cost: number }>();
  for (const fare of fares) {
    if (keep !== null && !keep(fare.leg)) continue;
    const ils = ilsOrNull(fx, fare.priceAmount, fare.priceCurrency);
    if (ils === null) continue;
    const cost = ils + bagFeeOf(fare.leg);
    const cur = best.get(fare.date);
    if (!cur || cost < cur.cost) best.set(fare.date, { fare, cost });
  }
  return new Map([...best].map(([day, v]) => [day, v.fare]));
}

/**
 * Cheapest one-way out + cheapest one-way back per valid date pair (currencies normalised via ILS).
 * `scale` multiplies per-adult fares to the whole party.
 *
 * When the user set preferred hours, the cheapest legs that satisfy those hours AND the max-stops limit are
 * combined too (the same test as scoring.matchesTimes), so the 🎯 card finds the cheapest split that really
 * matches, not just the cheapest legs, which usually fail the stops check.
 *
 * The result depends on the request's filters and bag choice, so it is built per request from the raw one-way
 * fares and never cached itself (the cache keeps the fares, see pipeline.ts).
 */
function splitTimes(out: OneWayFare, back: OneWayFare): { fareFoundAt?: string; fareExpiresAt?: string } {
  const found = olderOf(out.foundAt, back.foundAt);
  const expires = earlierOf(out.expiresAt, back.expiresAt);
  return { ...(found ? { fareFoundAt: found } : {}), ...(expires ? { fareExpiresAt: expires } : {}) };
}

export function buildSplits(
  origin: string,
  dest: string,
  req: SearchRequest,
  outs: OneWayFare[],
  backs: OneWayFare[],
  source: SourceName,
  fx: FxRates,
  scale: number,
  checkedAt: string,
  bagFees: BagFeeTable = BAG_FEES,
): Offer[] {
  const bagFeeOf = (leg: Leg): number => (req.checkedBag ? (legBagFeeIls(leg, fx, bagFees) ?? 0) : 0);
  const stopsOk = (leg: Leg): boolean => req.maxStops == null || (leg.stops != null && leg.stops <= req.maxStops);

  const outOk = (l: Leg): boolean => inWindow(l, req.outHours) && stopsOk(l);
  const backOk = (l: Leg): boolean => inWindow(l, req.retHours) && stopsOk(l);
  const variants: Array<[Map<string, OneWayFare>, Map<string, OneWayFare>]> = [
    [cheapestByDay(outs, null, fx, bagFeeOf), cheapestByDay(backs, null, fx, bagFeeOf)],
  ];
  if (hasTimePrefs(req)) {
    variants.push([cheapestByDay(outs, outOk, fx, bagFeeOf), cheapestByDay(backs, backOk, fx, bagFeeOf)]);
  }
  if (req.checkedBag) {
    // An unknown fee counts as 0 above, so a leg of a carrier without a known fee can take the day, and the ranker then keeps
    // that split out of 💰/⚖️/🎯 (bag-cost pool rule, scoring.bagCostPool). Also combine the cheapest legs whose fee IS known,
    // so a fully priced split still competes. Same pairs, so at most one more offer per pair and variant; the history keeps
    // one row per pair anyway (historyRows).
    const feeKnown = (l: Leg): boolean => legBagFeeIls(l, fx, bagFees) !== null;
    variants.push([cheapestByDay(outs, feeKnown, fx, bagFeeOf), cheapestByDay(backs, feeKnown, fx, bagFeeOf)]);
    if (hasTimePrefs(req)) {
      variants.push([
        cheapestByDay(outs, (l) => feeKnown(l) && outOk(l), fx, bagFeeOf),
        cheapestByDay(backs, (l) => feeKnown(l) && backOk(l), fx, bagFeeOf),
      ]);
    }
  }

  const pairs = validPairs(req);
  const offers: Offer[] = [];
  const seen = new Set<string>();
  for (const [oBest, bBest] of variants) {
    for (const [dep, ret] of pairs) {
      const out = oBest.get(dep);
      const back = bBest.get(ret);
      if (!out || !back) continue;
      const sig = JSON.stringify([
        dep, ret,
        out.priceAmount, out.priceCurrency, out.leg.departTime, out.leg.airlines[0] ?? null,
        back.priceAmount, back.priceCurrency, back.leg.departTime, back.leg.airlines[0] ?? null,
      ]);
      if (seen.has(sig)) continue;
      seen.add(sig);

      let amount: number;
      let currency: string;
      if (out.priceCurrency === back.priceCurrency) {
        amount = (out.priceAmount + back.priceAmount) * scale;
        currency = out.priceCurrency;
      } else {
        // Mixed currencies: store in ILS rather than invent a rate between them. Both are convertible,
        // otherwise cheapestByDay would have skipped them.
        amount = ((ilsOrNull(fx, out.priceAmount, out.priceCurrency) ?? 0) + (ilsOrNull(fx, back.priceAmount, back.priceCurrency) ?? 0)) * scale;
        currency = "ILS";
      }
      offers.push({
        origin,
        destination: dest,
        departDate: dep,
        returnDate: ret,
        priceAmount: round2(amount),
        priceCurrency: currency,
        source,
        ticketStructure: "split",
        outbound: { ...out.leg, airlines: [...out.leg.airlines] },
        inbound: { ...back.leg, airlines: [...back.leg.airlines] },
        includes: {},
        // Two one-way tickets = two bookings: the card needs both links (SPEC G5).
        deeplink: out.deeplink,
        returnDeeplink: back.deeplink,
        verifyLink: null,
        checkedAt,
        // The pair is only as known as its least-known leg, and expires with the first leg that does.
        ...splitTimes(out, back),
        extrasAmountIls: 0,
        totalIls: null,
        tags: [],
      });
    }
  }
  return offers;
}
