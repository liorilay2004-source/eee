/** calendar-insights.ts: the pure meta.insights builder of GET /api/calendar (cheapest weekday and trip length). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_ENTRIES_PER_MONTH, type CalendarDay } from "../src/calendar";
import { computeInsights, INSIGHTS_LABEL_HE, medianIls, WEEKDAY_HE, type CalendarInsights, type InsightFare } from "../src/calendar-insights";

const pad = (n: number) => String(n).padStart(2, "0");
/** November 2026: the 1st is a Sunday (weekday 0), so weekday w, week k is the (1 + w + 7k)th. */
const dateFor = (w: number, k: number) => `2026-11-${pad(1 + w + 7 * k)}`;

const fare = (priceIls: number): NonNullable<CalendarDay["fare"]> => ({
  priceIls,
  priceAmount: priceIls,
  priceCurrency: "ILS",
  returnDate: "2026-12-01",
  nights: 5,
  stops: 0,
  returnStops: 0,
  airlines: ["W6"],
  departTime: "06:15",
  returnTime: "21:40",
  deeplink: "https://www.aviasales.com/search/x",
  checkedAt: "2026-10-01T09:00:00.000Z",
  level: null,
});

/** Days from per-weekday price lists: weekday w's k-th price lands on dateFor(w, k). */
function daysOf(prices: Partial<Record<number, number[]>>): CalendarDay[] {
  const out: CalendarDay[] = [];
  for (const [w, list] of Object.entries(prices)) for (const [k, p] of (list ?? []).entries()) out.push({ date: dateFor(Number(w), k), known: true, fare: fare(p) });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Four weekdays priced twice: the smallest input that passes the gate. */
const FOUR = daysOf({ 0: [300, 300], 1: [300, 300], 2: [200, 200], 3: [300, 300] });
const must = (r: CalendarInsights | null): CalendarInsights => {
  expect(r).not.toBeNull();
  return r as CalendarInsights;
};

describe("computeInsights: byWeekday", () => {
  it("7 weekdays x 3 priced days -> 7 buckets sorted 0..6 with count, min and median (UTC weekday)", () => {
    expect(new Date("2026-11-01T00:00:00Z").getUTCDay()).toBe(0);
    const prices: Record<number, number[]> = {};
    for (let w = 0; w < 7; w++) prices[w] = [300 + w * 10, 100 + w * 10, 200 + w * 10];
    const r = must(computeInsights(daysOf(prices), []));
    expect(r.byWeekday).toEqual(Array.from({ length: 7 }, (_, w) => ({ weekday: w, minIls: 100 + w * 10, medianIls: 200 + w * 10, count: 3 })));
    // 2026-11-01 is weekday 0 whatever the process time zone: dateFor(0, 0) is that date.
    expect(dateFor(0, 0)).toBe("2026-11-01");
    expect(r.byWeekday[0]).toMatchObject({ weekday: 0, minIls: 100 });
  });

  it("an even count takes the rounded mean of the two middle values; always an integer", () => {
    expect(medianIls([225, 200])).toBe(213);
    expect(medianIls([130, 100, 120, 110])).toBe(115);
    expect(medianIls([101, 102])).toBe(102);
    expect(medianIls([3, 1, 2])).toBe(2);
    const r = must(computeInsights(daysOf({ 0: [200, 225], 1: [130, 100, 120, 110], 2: [300.4, 300.2], 3: [400, 400] }), []));
    expect(r.byWeekday.map((b) => [b.weekday, b.medianIls, b.minIls, b.count])).toEqual([
      [0, 213, 200, 2],
      [1, 115, 100, 4],
      [2, 300, 300, 2],
      [3, 400, 400, 2],
    ]);
    for (const b of r.byWeekday) {
      expect(Number.isInteger(b.medianIls)).toBe(true);
      expect(Number.isInteger(b.minIls)).toBe(true);
    }
  });
});

describe("computeInsights: choosing the cheapest and dearest weekday", () => {
  it("the lowest median wins", () => {
    const prices: Record<number, number[]> = {};
    for (let w = 0; w < 7; w++) prices[w] = w === 2 ? [150, 150, 150] : [180 + w, 190 + w, 200 + w];
    expect(must(computeInsights(daysOf(prices), [])).cheapestWeekday).toBe(2);
  });

  it("a median tie goes to the lower min", () => {
    const r = must(computeInsights(daysOf({ 0: [250, 250], 1: [150, 200, 250], 4: [100, 200, 300], 5: [250, 260] }), []));
    expect(r.cheapestWeekday).toBe(4);
  });

  it("a tie on median and min goes to the lower weekday", () => {
    const r = must(computeInsights(daysOf({ 0: [300, 300], 3: [100, 200, 300], 5: [100, 200, 300], 6: [300, 310] }), []));
    expect(r.cheapestWeekday).toBe(3);
  });

  it("Tue 176 vs Fri 200 -> a 12% saving and the Hebrew summary", () => {
    const r = must(computeInsights(daysOf({ 0: [190, 190], 1: [185, 185], 2: [176, 176], 5: [200, 200] }), []));
    expect(r.cheapestWeekday).toBe(2);
    expect(r.savingVsDearestWeekdayPct).toBe(12);
    expect(r.summaryHe).toBe("יציאה ביום ג׳ זולה בממוצע ב-12% מיציאה ביום ו׳");
  });

  it("a saving under 3% (195 vs 200, 2.5%) is absent, never 0 and never rounded up to 3", () => {
    const r = must(computeInsights(daysOf({ 0: [198, 198], 1: [197, 197], 2: [195, 195], 5: [200, 200] }), []));
    expect("savingVsDearestWeekdayPct" in r).toBe(false);
    expect(r.summaryHe).not.toContain("%");
    expect(r.summaryHe).toBe("המחיר הנמוך ביותר בממוצע: יציאה ביום ג׳");
  });

  it("all medians equal: no saving (dearest is the cheapest)", () => {
    const r = must(computeInsights(daysOf({ 0: [200, 200], 1: [200, 200], 2: [200, 200], 3: [200, 200] }), []));
    expect(r.cheapestWeekday).toBe(0);
    expect("savingVsDearestWeekdayPct" in r).toBe(false);
  });
});

describe("computeInsights: gate", () => {
  it("3 weekdays priced 3 times each -> null", () => {
    expect(computeInsights(daysOf({ 0: [1, 2, 3], 1: [1, 2, 3], 2: [1, 2, 3] }), [])).toBeNull();
  });

  it("4 weekdays priced twice + 3 singletons -> an answer, and singletons are listed but never chosen", () => {
    const r = must(computeInsights(daysOf({ 0: [300, 300], 1: [250, 250], 2: [200, 200], 3: [350, 350], 4: [10], 5: [5000], 6: [20] }), []));
    expect(r.byWeekday.map((b) => [b.weekday, b.count])).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 1],
      [5, 1],
      [6, 1],
    ]);
    expect(r.cheapestWeekday).toBe(2); // not the singleton 10 on Thursday or 20 on Saturday
    expect(r.summaryHe).toBe("יציאה ביום ג׳ זולה בממוצע ב-43% מיציאה ביום ד׳"); // dearest is Wednesday, not the singleton Friday
  });

  it("3 weekdays priced twice + 4 singletons -> null", () => {
    expect(computeInsights(daysOf({ 0: [300, 300], 1: [250, 250], 2: [200, 200], 3: [350], 4: [10], 5: [5000], 6: [20] }), [])).toBeNull();
  });
});

describe("computeInsights: bad and missing data", () => {
  it("empty inputs -> null", () => {
    expect(computeInsights([], [])).toBeNull();
    expect(computeInsights([], [{ departDate: "2026-11-01", nights: 3, priceIls: 100 }, { departDate: "2026-11-02", nights: 3, priceIls: 100 }])).toBeNull();
  });

  it("unknown days and days without a fare are skipped, never counted as 0", () => {
    const extra: CalendarDay[] = [
      { date: dateFor(2, 2), known: true, fare: null },
      { date: dateFor(2, 3), known: false, fare: null },
      { date: dateFor(4, 0), known: false, fare: fare(1) }, // a fare on an unknown day is not trusted
      { date: dateFor(4, 1), known: false, fare: fare(1) },
      { date: dateFor(5, 0), known: true, fare: null },
      { date: dateFor(5, 1), known: true, fare: null },
    ];
    const r = must(computeInsights([...FOUR, ...extra], []));
    expect(r.byWeekday.map((b) => [b.weekday, b.count, b.minIls])).toEqual([
      [0, 2, 300],
      [1, 2, 300],
      [2, 2, 200],
      [3, 2, 300],
    ]);
    // With only unknown/empty days on top of 3 real buckets, the gate stays closed.
    expect(computeInsights([...FOUR.filter((d) => d.date.slice(8) !== dateFor(3, 0).slice(8)), ...extra], [])).toBeNull();
  });

  it("garbage input -> null, never a throw", () => {
    const bad: unknown[] = [null, undefined, 5, "x", {}, [null], [5, "x"], [{ date: 7, known: true, fare: {} }]];
    for (const v of bad) {
      expect(() => computeInsights(v as never, v as never)).not.toThrow();
      expect(computeInsights(v as never, [])).toBeNull();
    }
    expect(computeInsights(FOUR, null as never)).toBeNull();
    // Malformed dates and prices inside otherwise valid days are skipped.
    const noisy: CalendarDay[] = [...FOUR, { date: "2026-13-45x", known: true, fare: fare(1) }, { date: dateFor(6, 0), known: true, fare: fare(Number.NaN) }];
    expect(must(computeInsights(noisy, [])).byWeekday.map((b) => b.weekday)).toEqual([0, 1, 2, 3]);
  });
});

describe("computeInsights: byNights", () => {
  const f = (nights: number, priceIls: number): InsightFare => ({ departDate: "2026-11-05", nights, priceIls });

  it("groups by nights, drops lengths seen once, sorts ascending and picks the lowest min", () => {
    const r = must(computeInsights(FOUR, [f(3, 200), f(7, 300), f(5, 150), f(3, 180), f(7, 250), f(7, 260)]));
    expect(r.byNights).toEqual([
      { nights: 3, minIls: 180, count: 2 },
      { nights: 7, minIls: 250, count: 3 },
    ]);
    expect(r.cheapestNights).toBe(3);
  });

  it("a tie on min goes to fewer nights; none left -> null", () => {
    expect(must(computeInsights(FOUR, [f(6, 100.4), f(6, 120), f(4, 100), f(4, 101)])).cheapestNights).toBe(4);
    const lonely = must(computeInsights(FOUR, [f(3, 100), f(5, 100)]));
    expect(lonely.byNights).toEqual([]);
    expect(lonely.cheapestNights).toBeNull();
  });
});

describe("computeInsights: labels and Hebrew text", () => {
  it("every answer carries labelHe and basis; the summary has no Latin letters; Saturday reads 'ביום שבת'", () => {
    expect(WEEKDAY_HE).toHaveLength(7);
    expect(WEEKDAY_HE[2]).toBe("ג׳");
    const fixtures = [
      FOUR,
      daysOf({ 0: [198, 198], 1: [197, 197], 2: [195, 195], 5: [200, 200] }),
      daysOf({ 0: [300, 300], 2: [250, 250], 4: [280, 280], 6: [100, 100] }),
      daysOf({ 1: [300, 300], 2: [300, 300], 3: [300, 300], 6: [299, 299] }),
    ];
    for (const days of fixtures) {
      const r = must(computeInsights(days, []));
      expect(r.labelHe).toBe(INSIGHTS_LABEL_HE);
      expect(r.basis).toBe("cached_fares");
      expect(r.summaryHe).not.toMatch(/[A-Za-z]/);
    }
    const sat = must(computeInsights(fixtures[2] as CalendarDay[], []));
    expect(sat.cheapestWeekday).toBe(6);
    expect(sat.summaryHe).toBe("יציאה ביום שבת זולה בממוצע ב-67% מיציאה ביום א׳");
    const satFlat = must(computeInsights(fixtures[3] as CalendarDay[], []));
    expect(satFlat.summaryHe).toBe("המחיר הנמוך ביותר בממוצע: יציאה ביום שבת");
  });
});

describe("computeInsights: purity and cost", () => {
  const deepFreeze = <T>(v: T): T => {
    if (v && typeof v === "object") {
      for (const x of Object.values(v)) deepFreeze(x);
      Object.freeze(v);
    }
    return v;
  };

  it("deep-frozen inputs do not throw and are unchanged", () => {
    const days = daysOf({ 0: [300, 100, 200], 1: [250, 150], 2: [220, 120, 180, 90], 3: [400, 410] });
    const fitting: InsightFare[] = [
      { departDate: "2026-11-01", nights: 5, priceIls: 300 },
      { departDate: "2026-11-02", nights: 5, priceIls: 200 },
      { departDate: "2026-11-03", nights: 2, priceIls: 90 },
    ];
    const before = structuredClone({ days, fitting });
    deepFreeze(days);
    deepFreeze(fitting);
    let r: CalendarInsights | null = null;
    expect(() => (r = computeInsights(days, fitting))).not.toThrow();
    expect(r).not.toBeNull();
    expect(structuredClone({ days, fitting })).toEqual(before);
  });

  it("5 x MAX_ENTRIES_PER_MONTH fitting fares: mean under 1 ms", () => {
    const days: CalendarDay[] = Array.from({ length: 92 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10),
      known: true,
      fare: fare(100 + ((i * 37) % 400)),
    }));
    const fitting: InsightFare[] = Array.from({ length: 5 * MAX_ENTRIES_PER_MONTH }, (_, i) => ({
      departDate: days[i % days.length]?.date as string,
      nights: 1 + (i % 30),
      priceIls: 100 + ((i * 7919) % 5000) / 7,
    }));
    for (let i = 0; i < 20; i++) computeInsights(days, fitting); // warm-up
    const runs = 200;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) computeInsights(days, fitting);
    const mean = (performance.now() - t0) / runs;
    expect(must(computeInsights(days, fitting)).byNights).toHaveLength(30);
    expect(mean).toBeLessThan(1);
  });
});

describe("docs/WEB_APP_SPEC.md", () => {
  it("documents meta.insights with the exact label", () => {
    const spec = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "WEB_APP_SPEC.md"), "utf8");
    expect(spec).toContain("meta.insights");
    expect(spec).toContain(INSIGHTS_LABEL_HE);
  });
});
