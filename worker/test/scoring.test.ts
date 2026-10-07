/** Unit tests mapped to SPEC §16 acceptance criteria plus edge cases. Cross-checked against Python by parity.test.ts. */
import { describe, expect, it } from "vitest";
import { applyExtrasAndFx, paxCount, round2, TAG_BAG_UNKNOWN, TAG_BONUS_BAG } from "../src/extras";
import { toIls } from "../src/money";
import { BAG_FEES, SCORING, type BagFeeTable, type ScoringConfig } from "../src/scoring.config";
import {
  bagCostKnown,
  bagCostPool,
  departHour,
  fastestByDirection,
  hasTimePrefs,
  inWindow,
  matchesTimes,
  recommend,
  recommendationsMeta,
  valueScore,
} from "../src/scoring";
import type { FxRates, Leg, Offer, SearchRequest } from "../src/types";

const FX: FxRates = { date: "2026-11-01", source: "test", ratesToIls: { ILS: 1, USD: 3, EUR: 3.5 } };

function leg(over: Partial<Leg> = {}): Leg {
  return { departTime: "10:00", arriveTime: null, stops: 0, durationMin: 300, airlines: ["LY"], ...over };
}

function req(over: Partial<SearchRequest> = {}): SearchRequest {
  return {
    origin: "TLV", destination: "BCN", windowStart: "2026-11-10", windowEnd: "2026-11-25", stayMin: 5, stayMax: 7,
    adults: 1, children: 0, infants: 0, cabin: "economy", checkedBag: false,
    outHours: null, retHours: null, maxStops: null, nearbyAirports: false, ...over,
  };
}

function offer(price: number, over: Partial<Offer> = {}): Offer {
  return {
    origin: "TLV", destination: "BCN", departDate: "2026-11-12", returnDate: "2026-11-18",
    priceAmount: price, priceCurrency: "USD", source: "travelpayouts", ticketStructure: "roundtrip",
    outbound: leg(), inbound: leg({ departTime: "18:00" }), includes: {}, deeplink: null, verifyLink: null,
    checkedAt: "2026-11-01T12:00:00Z", extrasAmountIls: 0, totalIls: null, tags: [], ...over,
  };
}

/** Prices offers the way the pipeline does before ranking. */
function priced(offers: Offer[], r: SearchRequest = req()): Offer[] {
  applyExtrasAndFx(offers, r, FX);
  return offers;
}

const kindsOf = (cards: ReturnType<typeof recommend>) => cards.map((c) => c.kinds);
const cardFor = (cards: ReturnType<typeof recommend>, kind: string) => cards.find((c) => c.kinds.includes(kind as never));

describe("config", () => {
  it("exposes the SPEC §8 penalties from config/scoring.json", () => {
    expect(SCORING.nightDeparturePenaltyIls).toBe(150);
    expect(SCORING.stopPenaltyIls).toBe(180);
    expect(SCORING.durationPenaltyIlsPerHour).toBe(35);
    expect([SCORING.nightStartHour, SCORING.nightEndHour]).toEqual([0, 6]);
  });

  it("scores with the penalties it is given, not constants baked into the scorer", () => {
    const o = priced([offer(100, { outbound: leg({ departTime: "03:00", stops: 1, durationMin: 360 }) })])[0]!;
    const fastest: [number, number] = [300, 300];
    const cfg: ScoringConfig = {
      ...SCORING, nightDeparturePenaltyIls: 1000, stopPenaltyIls: 2000, durationPenaltyIlsPerHour: 60,
    };
    // 300 ILS + night 1000 + 1 stop 2000 + 1h slower * 60
    expect(valueScore(o, fastest, cfg)).toBeCloseTo(300 + 1000 + 2000 + 60);
  });

  it("has the seeded bag fees and no entry for El Al / Lufthansa (unknown, never guessed)", () => {
    expect(BAG_FEES.W6?.checkedBag).toEqual({ amount: 45, currency: "EUR" });
    expect(BAG_FEES.LY).toBeUndefined();
    expect(BAG_FEES.LH).toBeUndefined();
  });
});

describe("SPEC §16: bag not selected, offer includes one", () => {
  it("ranks on base price and tags it as a bonus, never a penalty", () => {
    const r = req();
    const a = offer(100, { includes: { checkedBag: true } });
    const b = offer(110);
    priced([a, b], r);
    expect(a.tags).toContain(TAG_BONUS_BAG);
    expect(b.tags).not.toContain(TAG_BONUS_BAG);
    expect(a.totalIls).toBe(300);
    expect(a.extrasAmountIls).toBe(0);
    expect(recommend([a, b], r)[0]!.offer).toBe(a);
  });

  it("adds no fee for an unrequested bag even on a low-cost carrier", () => {
    const o = offer(100, { outbound: leg({ airlines: ["W6"] }), inbound: leg({ airlines: ["W6"] }) });
    priced([o]);
    expect(o.extrasAmountIls).toBe(0);
    expect(o.totalIls).toBe(300);
    expect(o.tags).toEqual([]);
  });
});

describe("SPEC §16: 23kg bag selected", () => {
  const r = req({ checkedBag: true });

  it("ranks low-cost fares on fare + bag fee", () => {
    const lowcost = offer(100, { outbound: leg({ airlines: ["W6"] }), inbound: leg({ airlines: ["W6"] }) });
    const full = offer(150, { includes: { checkedBag: true } });
    priced([lowcost, full], r);
    // 2 legs x EUR 45 x 3.5 = 315 ILS on top of 300
    expect(lowcost.extrasAmountIls).toBeCloseTo(315);
    expect(lowcost.totalIls).toBeCloseTo(615);
    expect(full.totalIls).toBeCloseTo(450);
    expect(cardFor(recommend([lowcost, full], r), "cheapest")!.offer).toBe(full);
  });

  it("charges the fee per passenger (adults + children + infants) and per leg", () => {
    const r3 = req({ checkedBag: true, adults: 2, children: 1, infants: 0 });
    const o = offer(300, { outbound: leg({ airlines: ["FR"] }), inbound: leg({ airlines: ["VY"] }) });
    priced([o], r3);
    // FR EUR 40 + VY EUR 35 = 75 EUR x 3.5 x 3 pax
    expect(o.extrasAmountIls).toBeCloseTo(75 * 3.5 * 3);
    expect(paxCount(r3)).toBe(3);
    expect(paxCount(req({ adults: 1, children: 1, infants: 1 }))).toBe(3);
  });

  it("uses the first airline of each leg only", () => {
    const o = offer(100, { outbound: leg({ airlines: ["W6", "LY"] }), inbound: leg({ airlines: ["LY", "W6"] }) });
    priced([o], r);
    expect(o.extrasAmountIls).toBeCloseTo(45 * 3.5); // W6 on the outbound only
    expect(o.tags).toEqual([TAG_BAG_UNKNOWN]); // LY-first inbound is unknown
  });

  it("tags an unknown carrier instead of guessing a fee", () => {
    const o = offer(100, { outbound: leg({ airlines: ["ZZ"] }), inbound: leg({ airlines: ["ZZ"] }) });
    priced([o], r);
    expect(o.tags).toEqual([TAG_BAG_UNKNOWN]);
    expect(o.extrasAmountIls).toBe(0);
    expect(o.totalIls).toBe(300);
  });

  it("treats a leg with no airline as unknown and tags once", () => {
    const o = offer(100, { outbound: leg({ airlines: [] }), inbound: leg({ airlines: [] }) });
    priced([o], r);
    expect(o.tags).toEqual([TAG_BAG_UNKNOWN]);
  });

  it("charges nothing and shows no bonus when the fare already includes the requested bag", () => {
    const o = offer(100, { includes: { checkedBag: true }, outbound: leg({ airlines: ["W6"] }) });
    priced([o], r);
    expect(o.extrasAmountIls).toBe(0);
    expect(o.tags).toEqual([]);
  });

  it("does not look up prototype keys as airlines", () => {
    const o = offer(100, { outbound: leg({ airlines: ["constructor"] }), inbound: leg({ airlines: ["__proto__"] }) });
    priced([o], r);
    expect(o.tags).toEqual([TAG_BAG_UNKNOWN]);
    expect(o.extrasAmountIls).toBe(0);
  });

  it("accepts an injected fee table", () => {
    const table: BagFeeTable = { QQ: { checkedBag: { amount: 10, currency: "USD" } } };
    const o = offer(100, { outbound: leg({ airlines: ["QQ"] }), inbound: leg({ airlines: ["QQ"] }) });
    applyExtrasAndFx([o], r, FX, table);
    expect(o.extrasAmountIls).toBe(60);
  });

  it("treats a fee in a currency without an FX rate as unknown, not as an error", () => {
    const table: BagFeeTable = { QQ: { checkedBag: { amount: 10, currency: "THB" } } };
    const o = offer(100, { outbound: leg({ airlines: ["QQ"] }), inbound: leg({ airlines: ["QQ"] }) });
    expect(() => applyExtrasAndFx([o], r, FX, table)).not.toThrow();
    expect(o.tags).toEqual([TAG_BAG_UNKNOWN]);
    expect(o.extrasAmountIls).toBe(0);
  });
});

describe("applyExtrasAndFx", () => {
  it("is idempotent and recomputes tags, extras and total from scratch", () => {
    const r = req({ checkedBag: true });
    const o = offer(100, {
      outbound: leg({ airlines: ["W6"] }), inbound: leg({ airlines: ["ZZ"] }),
      tags: [TAG_BONUS_BAG, "promo"], extrasAmountIls: 999, totalIls: 1,
    });
    applyExtrasAndFx([o], r, FX);
    const once = structuredClone(o);
    applyExtrasAndFx([o], r, FX);
    expect(o).toEqual(once);
    expect(o.tags).toEqual(["promo", TAG_BAG_UNKNOWN]); // stale bonus dropped, foreign tag kept
    expect(o.extrasAmountIls).toBeCloseTo(157.5);
  });

  it("re-pricing after the request drops the bag removes the fee and the tags", () => {
    const o = offer(100, { outbound: leg({ airlines: ["W6"] }), inbound: leg({ airlines: ["ZZ"] }) });
    applyExtrasAndFx([o], req({ checkedBag: true }), FX);
    expect(o.totalIls).toBeGreaterThan(300);
    applyExtrasAndFx([o], req({ checkedBag: false }), FX);
    expect(o.totalIls).toBe(300);
    expect(o.tags).toEqual([]);
  });

  it("does nothing for an empty list", () => {
    expect(() => applyExtrasAndFx([], req(), FX)).not.toThrow();
  });

  it("leaves totalIls null (and does not throw) for a currency without an FX rate", () => {
    const o = offer(100, { priceCurrency: "THB" });
    const ok = offer(100);
    expect(() => applyExtrasAndFx([o, ok], req(), FX)).not.toThrow();
    expect(o.totalIls).toBeNull();
    expect(ok.totalIls).toBe(300);
    expect(recommend([o, ok], req()).map((c) => c.offer)).toEqual([ok]);
  });

  it("rounds totals and extras to 2 decimals", () => {
    const o = offer(163.333, { includes: {} });
    applyExtrasAndFx([o], req({ checkedBag: true }), FX);
    expect(o.totalIls).toBe(round2(163.333 * 3 + o.extrasAmountIls));
    expect(String(o.totalIls).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("round2 matches Python's round(x, 2), including half-even ties", () => {
    expect(round2(0.125)).toBe(0.12);
    expect(round2(0.375)).toBe(0.38);
    expect(round2(0.625)).toBe(0.62);
    expect(round2(0.875)).toBe(0.88);
    expect(round2(2.675)).toBe(2.67); // binary repr is just below the tie
    expect(round2(1.005)).toBe(1);
    expect(round2(100)).toBe(100);
    expect(round2(-0.125)).toBe(-0.12);
  });
});

describe("SPEC §16: currency", () => {
  it("keeps the original amount + currency and exposes the ILS total the UI formats as ≈ ₪X ($Y)", () => {
    const o = offer(164);
    applyExtrasAndFx([o], req(), FX);
    expect(o.priceCurrency).toBe("USD");
    expect(o.priceAmount).toBe(164);
    expect(o.totalIls).toBe(492); // ≈ ₪492 ($164)
    expect(toIls(FX, o.priceAmount, o.priceCurrency)).toBe(492);
  });

  it("compares offers in different currencies on their ILS value", () => {
    const usd = offer(100); // 300
    const eur = offer(80, { priceCurrency: "EUR", departDate: "2026-11-13" }); // 280
    const ils = offer(290, { priceCurrency: "ILS", departDate: "2026-11-14" });
    const r = req();
    priced([usd, eur, ils], r);
    expect(cardFor(recommend([usd, eur, ils], r), "cheapest")!.offer).toBe(eur);
    expect(eur.priceCurrency).toBe("EUR");
  });
});

describe("SPEC §16: 🎯 Matches My Times", () => {
  it("is hidden when the user set no preferred hours", () => {
    const r = req();
    const offers = priced([offer(100), offer(120, { outbound: leg({ departTime: "08:00" }) })], r);
    expect(recommend(offers, r).flatMap((c) => c.kinds)).not.toContain("my_times");
  });

  it("is hidden when only max stops is set (that is not an hour preference)", () => {
    const r = req({ maxStops: 0 });
    expect(hasTimePrefs(r)).toBe(false);
    expect(recommend(priced([offer(100), offer(120)], r), r).flatMap((c) => c.kinds)).not.toContain("my_times");
  });

  it("picks the cheapest offer inside both windows", () => {
    const r = req({ outHours: [7, 12], retHours: [15, 23] });
    const night = offer(80, { outbound: leg({ departTime: "02:00" }) });
    const good = offer(120, { outbound: leg({ departTime: "09:00" }), departDate: "2026-11-13" });
    const better = offer(110, { outbound: leg({ departTime: "10:00" }), departDate: "2026-11-14" });
    priced([night, good, better], r);
    const cards = recommend([night, good, better], r);
    expect(cardFor(cards, "my_times")!.offer).toBe(better);
    expect(cardFor(cards, "cheapest")!.offer).toBe(night);
  });

  it("is hidden when nothing matches the windows", () => {
    const r = req({ outHours: [1, 2] });
    const offers = priced([offer(100), offer(120)], r);
    expect(recommend(offers, r).flatMap((c) => c.kinds)).not.toContain("my_times");
  });

  it("honours max stops inside the 🎯 filter, and unknown stops do not qualify", () => {
    const r = req({ outHours: [0, 24], maxStops: 0 });
    const oneStop = offer(90, { outbound: leg({ stops: 1 }) });
    const unknown = offer(95, { outbound: leg({ stops: null }), departDate: "2026-11-13" });
    const direct = offer(130, { departDate: "2026-11-14" });
    priced([oneStop, unknown, direct], r);
    expect(cardFor(recommend([oneStop, unknown, direct], r), "my_times")!.offer).toBe(direct);
  });

  it("works with only one direction constrained", () => {
    const r = req({ retHours: [17, 20] });
    const early = offer(100, { inbound: leg({ departTime: "09:00" }) });
    const late = offer(140, { inbound: leg({ departTime: "18:30" }), departDate: "2026-11-13" });
    priced([early, late], r);
    expect(cardFor(recommend([early, late], r), "my_times")!.offer).toBe(late);
  });
});

describe("inWindow / matchesTimes / departHour", () => {
  it("treats a null window as no restriction, even for unknown hours", () => {
    expect(inWindow(leg({ departTime: null }), null)).toBe(true);
  });

  it("is start-inclusive and end-exclusive", () => {
    expect(inWindow(leg({ departTime: "07:00" }), [7, 12])).toBe(true);
    expect(inWindow(leg({ departTime: "11:59" }), [7, 12])).toBe(true);
    expect(inWindow(leg({ departTime: "12:00" }), [7, 12])).toBe(false);
    expect(inWindow(leg({ departTime: "06:59" }), [7, 12])).toBe(false);
  });

  it("wraps midnight when start > end", () => {
    const w: [number, number] = [22, 4];
    for (const t of ["22:00", "23:59", "00:00", "03:59"]) expect(inWindow(leg({ departTime: t }), w), t).toBe(true);
    for (const t of ["04:00", "12:00", "21:59"]) expect(inWindow(leg({ departTime: t }), w), t).toBe(false);
  });

  it("an empty window (start == end) never matches; [0, 24) always does", () => {
    expect(inWindow(leg({ departTime: "09:00" }), [9, 9])).toBe(false);
    for (const t of ["00:00", "12:00", "23:59"]) expect(inWindow(leg({ departTime: t }), [0, 24])).toBe(true);
  });

  it("unknown or unparseable departure hour is never a match", () => {
    for (const t of [null, "", "abc", ":30", "  "]) expect(inWindow(leg({ departTime: t }), [0, 24]), String(t)).toBe(false);
  });

  it("parses the hour like Python's int()", () => {
    expect(departHour(leg({ departTime: "07:05" }))).toBe(7);
    expect(departHour(leg({ departTime: "0:00" }))).toBe(0);
    expect(departHour(leg({ departTime: null }))).toBeNull();
    expect(departHour(leg({ departTime: "x:00" }))).toBeNull();
  });

  it("matchesTimes: unknown stops cannot satisfy max stops; no max stops ignores stops", () => {
    const unknown = offer(100, { outbound: leg({ stops: null }) });
    expect(matchesTimes(unknown, req({ maxStops: 1 }))).toBe(false);
    expect(matchesTimes(unknown, req())).toBe(true);
    expect(matchesTimes(offer(100, { inbound: leg({ stops: 2 }) }), req({ maxStops: 1 }))).toBe(false);
    expect(matchesTimes(offer(100, { inbound: leg({ stops: 1 }) }), req({ maxStops: 1 }))).toBe(true);
  });

  it("hasTimePrefs is true when either direction has hours", () => {
    expect(hasTimePrefs(req())).toBe(false);
    expect(hasTimePrefs(req({ outHours: [6, 9] }))).toBe(true);
    expect(hasTimePrefs(req({ retHours: [6, 9] }))).toBe(true);
  });
});

describe("⚖️ Best Value", () => {
  it("penalises night departures and stops (SPEC §8)", () => {
    const r = req();
    const cheapBad = offer(100, {
      outbound: leg({ departTime: "03:00", stops: 2, durationMin: 900 }),
      inbound: leg({ departTime: "04:00", stops: 2, durationMin: 900 }),
    });
    const decent = offer(200, { departDate: "2026-11-13" });
    priced([cheapBad, decent], r);
    const cards = recommend([cheapBad, decent], r);
    expect(cardFor(cards, "cheapest")!.offer).toBe(cheapBad);
    expect(cardFor(cards, "best_value")!.offer).toBe(decent);
  });

  it("scores total + night + stops + hours above the fastest option, per leg", () => {
    const fast = priced([offer(100)])[0]!; // 300 ILS, 300 min both ways
    const slow = priced([
      offer(100, {
        outbound: leg({ departTime: "01:00", stops: 1, durationMin: 420 }), // night 150, stop 180, +2h = 70
        inbound: leg({ stops: 2, durationMin: 360 }), // 2 stops = 360, +1h = 35
      }),
    ])[0]!;
    const fastest = fastestByDirection([fast, slow]);
    expect(fastest).toEqual([300, 300]);
    expect(valueScore(fast, fastest)).toBe(300);
    expect(valueScore(slow, fastest)).toBeCloseTo(300 + 150 + 180 + 70 + 360 + 35);
  });

  it("falls back to the outbound leg for a return leg with unknown stops/duration", () => {
    const fast = priced([offer(100)])[0]!;
    const google = priced([
      offer(100, {
        outbound: leg({ stops: 1, durationMin: 420 }),
        inbound: leg({ departTime: "18:00", stops: null, durationMin: null }),
      }),
    ])[0]!;
    const fastest = fastestByDirection([fast, google]);
    // outbound: 180 + 2h*35; inbound (estimated from outbound): 180 + 2h*35 against fastest inbound 300
    expect(valueScore(google, fastest)).toBeCloseTo(300 + 2 * (180 + 70));
  });

  it("does not use the fallback for the outbound leg and never guesses a night departure", () => {
    const o = priced([offer(100, { outbound: leg({ departTime: null, stops: null, durationMin: null }) })])[0]!;
    expect(valueScore(o, [300, 300])).toBe(300);
  });

  it("breaks score ties by lower total, whatever the input order", () => {
    // A: 1000 + 180 (one stop) = 1180 ; B: 1030 + 150 (night) = 1180
    const a = offer(1000, { priceCurrency: "ILS", outbound: leg({ stops: 1 }) });
    const b = offer(1030, { priceCurrency: "ILS", outbound: leg({ departTime: "02:00" }), departDate: "2026-11-13" });
    for (const order of [[a, b], [b, a]]) {
      priced(order);
      expect(cardFor(recommend(order, req()), "best_value")!.offer).toBe(a);
    }
  });

  it("valueScore refuses an unpriced offer", () => {
    expect(() => valueScore(offer(100), [null, null])).toThrow();
  });
});

describe("fastestByDirection", () => {
  it("takes the minimum per direction, ignoring unknown (null/0) durations", () => {
    const offers = [
      offer(1, { outbound: leg({ durationMin: 400 }), inbound: leg({ durationMin: null }) }),
      offer(1, { outbound: leg({ durationMin: 0 }), inbound: leg({ durationMin: 350 }) }),
      offer(1, { outbound: leg({ durationMin: 300 }), inbound: leg({ durationMin: 500 }) }),
    ];
    expect(fastestByDirection(offers)).toEqual([300, 350]);
  });

  it("is [null, null] when nothing is known", () => {
    expect(fastestByDirection([])).toEqual([null, null]);
    expect(fastestByDirection([offer(1, { outbound: leg({ durationMin: null }), inbound: leg({ durationMin: null }) })])).toEqual([null, null]);
  });
});

describe("recommend: cards", () => {
  it("returns [] for an empty list", () => {
    expect(recommend([], req())).toEqual([]);
  });

  it("returns [] when no offer has a total", () => {
    expect(recommend([offer(100), offer(200)], req())).toEqual([]);
  });

  it("skips offers without a total and ranks the rest", () => {
    const r = req();
    const noTotal = offer(1, { totalIls: null });
    const a = offer(100);
    const b = offer(90, { departDate: "2026-11-13" });
    priced([a, b], r);
    const cards = recommend([noTotal, a, b], r);
    expect(cards.map((c) => c.offer)).toEqual([b, a]);
    expect(cards[0]!.kinds).toEqual(["cheapest", "best_value"]);
    expect(cards[1]!.kinds).toEqual(["most_convenient"]);
  });

  it("a single offer is one card holding cheapest + best_value (and my_times when it matches)", () => {
    const r = req();
    const o = priced([offer(100)], r)[0]!;
    const cards = recommend([o], r);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.offer).toBe(o);
    expect(cards[0]!.kinds).toEqual(["cheapest", "best_value", "most_convenient"]);
    expect(cards[0]!.savingsVsRoundtripIls).toBeNull();

    const r2 = req({ outHours: [9, 11] });
    priced([o], r2);
    expect(recommend([o], r2)[0]!.kinds).toEqual(["cheapest", "best_value", "most_convenient", "my_times"]);
  });

  it("shows the same offer once with several kinds, in cheapest, best_value, my_times order", () => {
    const r = req({ outHours: [9, 11], retHours: [17, 19] });
    const o = priced([offer(100)], r)[0]!;
    expect(kindsOf(recommend([o], r))).toEqual([["cheapest", "best_value", "most_convenient", "my_times"]]);
  });

  it("cheapest ties go to the earliest offer in input order", () => {
    const r = req();
    const first = offer(100);
    const second = offer(100, { departDate: "2026-11-13" });
    priced([first, second], r);
    expect(cardFor(recommend([first, second], r), "cheapest")!.offer).toBe(first);
    expect(cardFor(recommend([second, first], r), "cheapest")!.offer).toBe(second);
  });

  it("returns the caller's offer objects and does not mutate them", () => {
    const r = req({ outHours: [9, 11] });
    const offers = priced([offer(100), offer(90, { departDate: "2026-11-13" })], r);
    const before = structuredClone(offers);
    const cards = recommend(offers, r);
    expect(offers).toEqual(before);
    for (const c of cards) expect(offers).toContain(c.offer);
  });
});

describe("recommend: which offers merge into one card (Offer.key)", () => {
  /** twin has one more outbound stop, so cheapest picks `base` and best value picks `twin`... or vice versa. */
  function pair(change: Partial<Offer>): number {
    const r = req();
    const base = offer(100, { outbound: leg({ stops: 1 }) }); // worse value, first in order -> cheapest
    const twin = offer(100, { outbound: leg({ stops: 0 }), ...change }); // better value
    priced([base, twin], r);
    return recommend([base, twin], r).length;
  }

  it("merges offers that differ only in airlines, sub-cent price noise or unkeyed leg details", () => {
    expect(pair({ outbound: leg({ stops: 0, airlines: ["W6"] }) })).toBe(1);
    expect(pair({ priceAmount: 100.004 })).toBe(1);
  });

  it("keeps offers apart when any keyed field differs", () => {
    expect(pair({ departDate: "2026-11-13" })).toBe(2);
    expect(pair({ returnDate: "2026-11-19" })).toBe(2);
    expect(pair({ source: "google_flights" })).toBe(2);
    expect(pair({ ticketStructure: "split" })).toBe(2);
    expect(pair({ priceAmount: 100.01 })).toBe(2);
    expect(pair({ priceCurrency: "EUR" })).toBe(2);
    expect(pair({ outbound: leg({ stops: 0, departTime: "11:00" }) })).toBe(2);
    expect(pair({ inbound: leg({ departTime: "19:00" }) })).toBe(2);
    expect(pair({ outbound: leg({ stops: 0, departTime: null }) })).toBe(2); // null is not ""
  });
});

describe("SPEC §16: split ticket savings", () => {
  const splitOffer = (price: number, over: Partial<Offer> = {}) =>
    offer(price, {
      ticketStructure: "split",
      outbound: leg({ airlines: ["W6"] }),
      inbound: leg({ airlines: ["FR"], departTime: "19:00" }),
      ...over,
    });

  it("shows how much a cheaper split ticket saves versus the cheapest round trip", () => {
    const r = req();
    const rt = offer(200);
    const cheaperRt = offer(190, { departDate: "2026-11-13" });
    const split = splitOffer(130, { departDate: "2026-11-14" });
    priced([rt, cheaperRt, split], r);
    const cheapest = cardFor(recommend([rt, cheaperRt, split], r), "cheapest")!;
    expect(cheapest.offer).toBe(split);
    expect(cheapest.savingsVsRoundtripIls).toBeCloseTo(190 * 3 - 130 * 3);
  });

  it("is rounded to cents like every other ILS amount (no float noise such as 69.60000000000001)", () => {
    const r = req();
    const rt = offer(33.3); // 99.9 ILS
    const split = splitOffer(10.1, { departDate: "2026-11-14" }); // 30.3 ILS
    priced([rt, split], r);
    expect(99.9 - 30.3).not.toBe(69.6); // the raw subtraction is what used to leak out
    const cheapest = cardFor(recommend([rt, split], r), "cheapest")!;
    expect(cheapest.savingsVsRoundtripIls).toBe(69.6);
  });

  it("is null when the split ticket is not cheaper than every round trip", () => {
    const r = req();
    const rt = offer(200);
    const split = splitOffer(210, { departDate: "2026-11-13" });
    priced([rt, split], r);
    const cards = recommend([rt, split], r);
    expect(cards.every((c) => c.savingsVsRoundtripIls === null)).toBe(true);
  });

  it("is null when the split ticket only ties the cheapest round trip", () => {
    const r = req();
    const rt = offer(200);
    const split = splitOffer(200, { departDate: "2026-11-13" });
    priced([split, rt], r);
    const cards = recommend([split, rt], r);
    expect(cards.every((c) => c.savingsVsRoundtripIls === null)).toBe(true);
  });

  it("is null when there is no round trip to compare with", () => {
    const r = req();
    const a = splitOffer(100);
    const b = splitOffer(120, { departDate: "2026-11-13" });
    priced([a, b], r);
    expect(recommend([a, b], r).every((c) => c.savingsVsRoundtripIls === null)).toBe(true);
  });

  it("is never set on a round-trip card", () => {
    const r = req();
    const rt = offer(100);
    const split = splitOffer(50, { departDate: "2026-11-13" });
    priced([rt, split], r);
    const cards = recommend([rt, split], r);
    for (const c of cards) {
      if (c.offer.ticketStructure === "roundtrip") expect(c.savingsVsRoundtripIls).toBeNull();
    }
    expect(cards.find((c) => c.offer === split)!.savingsVsRoundtripIls).toBeCloseTo(150);
  });

  it("compares on totals including extras (bag fee can erase the split advantage)", () => {
    const r = req({ checkedBag: true });
    const rt = offer(110, { includes: { checkedBag: true } }); // 330
    const split = splitOffer(100); // 300 + W6 EUR45 + FR EUR40, x3.5 = 597.5
    priced([rt, split], r);
    const cards = recommend([rt, split], r);
    expect(cards.every((c) => c.savingsVsRoundtripIls === null)).toBe(true);
    expect(cards[0]!.offer).toBe(rt);
  });
});

describe("most convenient recommendation", () => {
  it("prefers a nonstop round trip even when it is longer and costs more", () => {
    const r = req();
    const oneStop = offer(100, {
      outbound: leg({ stops: 1, durationMin: 240 }),
      inbound: leg({ departTime: "18:00", stops: 1, durationMin: 240 }),
    });
    const direct = offer(180, {
      departDate: "2026-11-13",
      outbound: leg({ stops: 0, durationMin: 360 }),
      inbound: leg({ departTime: "18:00", stops: 0, durationMin: 360 }),
    });
    const cards = recommend(priced([oneStop, direct], r), r);
    expect(cardFor(cards, "cheapest")?.offer).toBe(oneStop);
    expect(cardFor(cards, "most_convenient")?.offer).toBe(direct);
  });

  it("uses the shorter itinerary when stop counts tie", () => {
    const r = req();
    const long = offer(100, { outbound: leg({ durationMin: 500 }), inbound: leg({ departTime: "18:00", durationMin: 500 }) });
    const short = offer(200, { departDate: "2026-11-13", outbound: leg({ durationMin: 300 }), inbound: leg({ departTime: "18:00", durationMin: 300 }) });
    const cards = recommend(priced([long, short], r), r);
    expect(cardFor(cards, "most_convenient")?.offer).toBe(short);
  });

  it("omits comfort and value labels for price-only fares with unknown itinerary facts", () => {
    const r = req();
    const fareOnly = offer(100, {
      source: "elal",
      outbound: leg({ departTime: null, stops: null, durationMin: null }),
      inbound: leg({ departTime: null, stops: null, durationMin: null }),
    });
    const offers = priced([fareOnly], r);
    const cards = recommend(offers, r);
    expect(kindsOf(cards)).toEqual([["cheapest"]]);
    expect(recommendationsMeta(offers, r, cards).bestValue).toEqual({ status: "flight_details_unknown" });
  });

  it("does not use a separate-ticket split as the convenience winner", () => {
    const r = req();
    const split = offer(50, { ticketStructure: "split", outbound: leg({ durationMin: 100 }), inbound: leg({ departTime: "18:00", durationMin: 100 }) });
    const roundtrip = offer(150, { outbound: leg({ stops: 1, durationMin: 400 }), inbound: leg({ departTime: "18:00", stops: 1, durationMin: 400 }) });
    const cards = recommend(priced([split, roundtrip], r), r);
    expect(cardFor(cards, "most_convenient")?.offer).toBe(roundtrip);
  });

  it("ranks convenience with unknown bag prices and uses stable order for itinerary ties", () => {
    const r = req({ checkedBag: true });
    const unknownBag = offer(100, {
      outbound: leg({ airlines: ["LY"], stops: 1, durationMin: 300 }),
      inbound: leg({ departTime: "18:00", airlines: ["LY"], stops: 1, durationMin: 300 }),
    });
    const knownBag = offer(200, {
      departDate: "2026-11-13",
      outbound: leg({ airlines: ["W6"], stops: 1, durationMin: 300 }),
      inbound: leg({ departTime: "18:00", airlines: ["W6"], stops: 1, durationMin: 300 }),
    });
    const offers = priced([unknownBag, knownBag], r);
    const cards = recommend(offers, r);
    expect(cardFor(cards, "most_convenient")?.offer).toBe(unknownBag);
  });
});

// WEB_APP_SPEC §5.3 / AC-R7 (gap 16): with a bag requested an unknown fee must not rank as zero.
describe("bag-cost pool rule", () => {
  const bag = req({ checkedBag: true });
  // LY has no table fee (unknown); W6 has one (EUR 45 per leg = 157.5 ILS per leg at 3.5).
  const unknownFee = (usd: number, over: Partial<Offer> = {}) => offer(usd, over);
  const knownFee = (usd: number, over: Partial<Offer> = {}) =>
    offer(usd, { outbound: leg({ airlines: ["W6"] }), inbound: leg({ departTime: "18:00", airlines: ["W6"] }), ...over });

  it("an unknown-fee offer cheaper on paper does not win 💰 or ⚖️ over a fully priced one", () => {
    const offers = priced([unknownFee(100), knownFee(200)], bag); // 300 ILS lower bound vs 600 + 315 = 915 ILS
    expect(offers[0]!.tags).toContain(TAG_BAG_UNKNOWN);
    const cards = recommend(offers, bag);
    expect(kindsOf(cards)).toEqual([["cheapest", "best_value"], ["most_convenient"]]);
    expect(cards[0]!.offer).toBe(offers[1]);
    expect(cards[1]!.offer).toBe(offers[0]);
    expect(recommendationsMeta(offers, bag, cards)).toEqual({
      cheapest: { status: "shown", excludedForUnknownBagFee: 1 },
      bestValue: { status: "merged" },
    });
  });

  it("counts only excluded offers whose lower bound is below the shown 💰 total", () => {
    const offers = priced([unknownFee(100), unknownFee(400), unknownFee(305), knownFee(200)], bag); // 300, 1200, 915 vs 915
    const cards = recommend(offers, bag);
    expect(cardFor(cards, "cheapest")!.offer).toBe(offers[3]);
    // 915 is not BELOW 915: only the 300 lower bound could be cheaper.
    expect(recommendationsMeta(offers, bag, cards).cheapest.excludedForUnknownBagFee).toBe(1);
  });

  it("falls back to the cheapest lower bound for 💰, hides ⚖️ and reports bag_cost_unknown when no fee is known", () => {
    const offers = priced([unknownFee(300), unknownFee(100)], bag);
    const cards = recommend(offers, bag);
    expect(kindsOf(cards)).toEqual([["cheapest"], ["most_convenient"]]);
    expect(cards[0]!.offer).toBe(offers[1]);
    expect(cards[1]!.offer).toBe(offers[0]);
    expect(cards[0]!.offer.tags).toContain(TAG_BAG_UNKNOWN); // the cheapest card shows "לפחות" and the warning
    expect(recommendationsMeta(offers, bag, cards)).toEqual({
      cheapest: { status: "shown", excludedForUnknownBagFee: 0 },
      bestValue: { status: "bag_cost_unknown" },
    });
  });

  it("a bag the fare includes is a known cost, even on a carrier without a table fee", () => {
    const offers = priced([unknownFee(100), unknownFee(150, { includes: { checkedBag: true } }), knownFee(200)], bag);
    const cards = recommend(offers, bag);
    expect(cardFor(cards, "cheapest")!.offer).toBe(offers[1]);
    expect(offers[1]!.tags).not.toContain(TAG_BAG_UNKNOWN);
  });

  it("a partly known fee (one leg's carrier unknown) is still excluded", () => {
    const mixed = unknownFee(100, { outbound: leg({ airlines: ["W6"] }) }); // 300 + 157.5, return fee unknown
    const offers = priced([mixed, knownFee(200)], bag);
    expect(offers[0]!.tags).toContain(TAG_BAG_UNKNOWN);
    expect(offers[0]!.extrasAmountIls).toBe(157.5);
    expect(cardFor(recommend(offers, bag), "cheapest")!.offer).toBe(offers[1]);
  });

  it("⚖️ is ranked within the known pool while 💰 can differ", () => {
    // Known A: cheap but 2 stops each way; known B: dearer, direct. Unknown C: cheapest and direct.
    const a = knownFee(200, { outbound: leg({ airlines: ["W6"], stops: 2, durationMin: 700 }), inbound: leg({ departTime: "18:00", airlines: ["W6"], stops: 2, durationMin: 700 }) });
    const b = knownFee(260);
    const c = unknownFee(150);
    const offers = priced([a, b, c], bag);
    const cards = recommend(offers, bag);
    expect(cardFor(cards, "cheapest")!.offer).toBe(a);
    expect(cardFor(cards, "best_value")!.offer).toBe(b);
    expect(recommendationsMeta(offers, bag, cards).bestValue.status).toBe("shown");
  });

  it("🎯 prefers a matching offer with a known bag cost and falls back to the cheapest match otherwise", () => {
    const timed = req({ checkedBag: true, outHours: [8, 12] });
    const offers = priced([unknownFee(100), knownFee(200), knownFee(150, { outbound: leg({ departTime: "20:00", airlines: ["W6"] }) })], timed);
    expect(cardFor(recommend(offers, timed), "my_times")!.offer).toBe(offers[1]);
    const onlyUnknown = priced([unknownFee(100), knownFee(150, { outbound: leg({ departTime: "20:00", airlines: ["W6"] }) })], timed);
    expect(cardFor(recommend(onlyUnknown, timed), "my_times")!.offer).toBe(onlyUnknown[0]);
  });

  it("time-only candidates obey the same rule", () => {
    const timed = req({ checkedBag: true, outHours: [8, 12] });
    const [main] = priced([knownFee(150, { outbound: leg({ departTime: "20:00", airlines: ["W6"] }) })], timed);
    const extra = priced([unknownFee(50), knownFee(300)], timed);
    expect(cardFor(recommend([main!], timed, SCORING, extra), "my_times")!.offer).toBe(extra[1]);
  });

  it("a 🎯 split shown with an unknown bag fee (lower bound) claims no saving over a fully priced round trip", () => {
    const timed = req({ checkedBag: true, outHours: [8, 12] });
    const rt = knownFee(120, { outbound: leg({ departTime: "20:00", airlines: ["W6"] }) }); // 360 + 315 = 675, outside the window
    const split = unknownFee(150, { ticketStructure: "split" }); // 450 lower bound, matches
    const offers = priced([rt, split], timed);
    const mine = cardFor(recommend(offers, timed), "my_times")!;
    expect(mine.offer).toBe(split);
    expect(mine.savingsVsRoundtripIls).toBeNull();
    // With a known fee the same split keeps its saving.
    const knownSplit = knownFee(40, { ticketStructure: "split" }); // 120 + 315 = 435
    const again = priced([rt, knownSplit], timed);
    expect(cardFor(recommend(again, timed), "my_times")!.savingsVsRoundtripIls).toBe(240);
  });

  it("changes nothing when no bag is requested", () => {
    const noBag = req();
    const offers = priced([unknownFee(100), knownFee(200)], noBag);
    expect(offers.every((o) => bagCostKnown(o, noBag))).toBe(true);
    expect(bagCostPool(offers, noBag)).toEqual({ pool: offers, fallback: false });
    const cards = recommend(offers, noBag);
    expect(cardFor(cards, "cheapest")!.offer).toBe(offers[0]);
    expect(recommendationsMeta(offers, noBag, cards)).toEqual({
      cheapest: { status: "shown", excludedForUnknownBagFee: 0 },
      bestValue: { status: "merged" },
    });
  });

  it("reports no_offers when nothing is priced", () => {
    const offers = priced([unknownFee(100, { priceCurrency: "XXX" })], bag);
    expect(recommend(offers, bag)).toEqual([]);
    expect(recommendationsMeta(offers, bag, [])).toEqual({
      cheapest: { status: "no_offers", excludedForUnknownBagFee: 0 },
      bestValue: { status: "no_offers" },
    });
    expect(bagCostPool([], bag)).toEqual({ pool: [], fallback: false });
  });
});
