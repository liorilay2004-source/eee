/**
 * Recommendation logic (SPEC §8). Port of engine/tpe/scoring.py: all comparisons are in ILS on the
 * total price including the extras the user selected. Ties resolve to the earliest offer in input
 * order, exactly like Python's min().
 */
import { round2 } from "./extras";
import { SCORING, type ScoringConfig } from "./scoring.config";
import type { Card, Leg, Offer, RecKind, SearchRequest } from "./types";

/** Fastest known duration in minutes as [outbound, inbound]; null when no offer knows it. */
export type FastestByDirection = [number | null, number | null];

type Priced = Offer & { totalIls: number };

function isPriced(o: Offer): o is Priced {
  return typeof o.totalIls === "number" && Number.isFinite(o.totalIls);
}

/** Local departure hour (0-23) or null when unknown or unparseable ("can't verify"). */
export function departHour(leg: Leg): number | null {
  if (!leg.departTime) return null;
  const head = (leg.departTime.split(":")[0] ?? "").trim();
  const h = head === "" ? NaN : Number(head);
  return Number.isInteger(h) ? h : null;
}

function isNight(leg: Leg, cfg: ScoringConfig): boolean {
  const h = departHour(leg);
  return h !== null && cfg.nightStartHour <= h && h < cfg.nightEndHour;
}

export function fastestByDirection(offers: Offer[]): FastestByDirection {
  let out: number | null = null;
  let inn: number | null = null;
  for (const o of offers) {
    // 0 and null both mean "unknown", as in Python's truthiness check.
    const d1 = o.outbound.durationMin;
    if (d1 && (out === null || d1 < out)) out = d1;
    const d2 = o.inbound.durationMin;
    if (d2 && (inn === null || d2 < inn)) inn = d2;
  }
  return [out, inn];
}

/**
 * Penalty for one leg. If the leg's stops/duration are unknown (e.g. the return leg of a Google
 * round trip) the fallback leg's values are used as a symmetric estimate; the night penalty only
 * applies on a known departure time.
 */
function legPenalty(leg: Leg, fastest: number | null, cfg: ScoringConfig, fallback?: Leg): number {
  let p = 0;
  if (isNight(leg, cfg)) p += cfg.nightDeparturePenaltyIls;
  const stops = leg.stops ?? fallback?.stops ?? null;
  if (stops) p += stops * cfg.stopPenaltyIls;
  const dur = leg.durationMin ?? fallback?.durationMin ?? null;
  if (dur && fastest) p += Math.max(0, (dur - fastest) / 60) * cfg.durationPenaltyIlsPerHour;
  return p;
}

/** score = total + night + stop + duration penalties (SPEC §8). Lower is better. */
export function valueScore(o: Offer, fastest: FastestByDirection, cfg: ScoringConfig = SCORING): number {
  if (o.totalIls === null) throw new Error("valueScore needs totalIls; run applyExtrasAndFx first");
  return (
    o.totalIls +
    legPenalty(o.outbound, fastest[0], cfg) +
    legPenalty(o.inbound, fastest[1], cfg, o.outbound)
  );
}

/** Hour window [start, end); start > end wraps midnight. Unknown departure hour never matches. */
export function inWindow(leg: Leg, window: [number, number] | null): boolean {
  if (window == null) return true;
  const h = departHour(leg);
  if (h === null) return false;
  const [start, end] = window;
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

/** Both legs inside their hour windows and within max stops; unknown stops cannot be verified. */
export function matchesTimes(o: Offer, req: SearchRequest): boolean {
  if (!(inWindow(o.outbound, req.outHours) && inWindow(o.inbound, req.retHours))) return false;
  if (req.maxStops != null) {
    for (const leg of [o.outbound, o.inbound]) {
      if (leg.stops == null || leg.stops > req.maxStops) return false;
    }
  }
  return true;
}

/** The 🎯 card only exists when the user set hour windows (otherwise it would duplicate Cheapest). */
export function hasTimePrefs(req: SearchRequest): boolean {
  return req.outHours != null || req.retHours != null;
}

/** Identity used to merge duplicate recommendations into one card (Offer.key() in Python). */
function offerKey(o: Offer): string {
  return JSON.stringify([
    o.departDate,
    o.returnDate,
    o.source,
    o.ticketStructure,
    round2(o.priceAmount),
    o.priceCurrency,
    o.outbound.departTime,
    o.inbound.departTime,
  ]);
}

/** First element with the smallest key; earlier elements win ties. */
function firstMin<T>(items: T[], less: (a: T, b: T) => boolean): T | undefined {
  let best: T | undefined;
  for (const it of items) if (best === undefined || less(it, best)) best = it;
  return best;
}

/**
 * `timeOnly` are extra candidates for the 🎯 card alone (never for Cheapest or Best value): the pipeline passes cached fares whose
 * verified return leg a live quote (which does not state its own) replaced, so the quote cannot cost the user that card.
 */
export function recommend(offers: Offer[], req: SearchRequest, cfg: ScoringConfig = SCORING, timeOnly: Offer[] = []): Card[] {
  const priced = offers.filter(isPriced);
  if (priced.length === 0) return [];

  const picks: Array<[RecKind, Priced]> = [];

  const cheapest = firstMin(priced, (a, b) => a.totalIls < b.totalIls);
  if (cheapest) picks.push(["cheapest", cheapest]);

  const fastest = fastestByDirection(priced);
  const scored = priced.map((o) => ({ o, score: valueScore(o, fastest, cfg) }));
  const best = firstMin(scored, (a, b) => a.score < b.score || (a.score === b.score && a.o.totalIls < b.o.totalIls));
  if (best) picks.push(["best_value", best.o]);

  if (hasTimePrefs(req)) {
    const mine = firstMin([...priced, ...timeOnly.filter(isPriced)].filter((o) => matchesTimes(o, req)), (a, b) => a.totalIls < b.totalIls);
    if (mine) picks.push(["my_times", mine]);
  }

  const cards: Card[] = [];
  const keys: string[] = [];
  for (const [kind, o] of picks) {
    const key = offerKey(o);
    const at = keys.indexOf(key);
    const existing = at >= 0 ? cards[at] : undefined;
    if (existing) existing.kinds.push(kind);
    else {
      cards.push({ offer: o, kinds: [kind], savingsVsRoundtripIls: null });
      keys.push(key);
    }
  }

  // A split ticket cheaper than every round trip shows what it saves (SPEC §16).
  let cheapestRoundtrip: number | null = null;
  for (const o of priced) {
    if (o.ticketStructure === "roundtrip" && (cheapestRoundtrip === null || o.totalIls < cheapestRoundtrip)) {
      cheapestRoundtrip = o.totalIls;
    }
  }
  if (cheapestRoundtrip !== null) {
    for (const c of cards) {
      if (c.offer.ticketStructure === "split" && c.offer.totalIls !== null && c.offer.totalIls < cheapestRoundtrip) {
        // Both operands are rounded ILS, but their difference still carries float noise (289.20000000000005).
        c.savingsVsRoundtripIls = round2(cheapestRoundtrip - c.offer.totalIls);
      }
    }
  }
  return cards;
}
