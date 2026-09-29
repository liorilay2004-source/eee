/**
 * Deal / error-fare detector. Expected values are worked out by hand in the comments (median and MAD of small
 * fixed lists), so a change of the statistics shows up here as a number that no longer adds up.
 */
import { describe, expect, it } from "vitest";
import {
  DEAL_CONFIG,
  assessPrice,
  bucketKey,
  detectDeals,
  median,
  scaledMad,
  type BucketFields,
  type DealPriceRow,
  type PriceSnapshot,
} from "../src/deals";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// --- fixtures -----------------------------------------------------------------------------------------

/**
 * The reference bucket history (ILS, one snapshot a day, 14 days).
 *   sorted: 850 900 900 950 950 1000 1000 1000 1000 1050 1050 1100 1100 1150     (n = 14)
 *   median  = (7th + 8th) / 2 = (1000 + 1000) / 2 = 1000
 *   |x - 1000| sorted: 0 0 0 0 50 50 50 50 100 100 100 100 150 150
 *   MAD     = (7th + 8th) / 2 = (50 + 50) / 2 = 50
 *   scaled  = 1.4826 * 50 = 74.13   (the 2% floor is 0.02 * 1000 = 20, smaller, so the scale is 74.13)
 * A candidate c therefore has drop = (1000 - c) / 10 percent and z = (c - 1000) / 74.13.
 */
const BASE14 = [1000, 1100, 900, 1050, 950, 1000, 1150, 850, 1000, 1100, 900, 1050, 950, 1000];

const START = Date.parse("2026-09-01T00:00:00.000Z");
const at = (days: number) => new Date(START + days * DAY).toISOString();
const daily = (prices: number[]): PriceSnapshot[] => prices.map((priceIls, i) => ({ priceIls, checkedAt: at(i) }));
const snap = (priceIls: number, days: number): PriceSnapshot => ({ priceIls, checkedAt: at(days) });
/** `n` daily snapshots at one price: median = the price, MAD 0, so the scale is the 2% floor. */
const flat = (priceIls: number, n = 12): PriceSnapshot[] => daily(Array.from({ length: n }, () => priceIls));

/** A tiny seeded PRNG (mulberry32): the property tests are random-looking but exactly repeatable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw (Box-Muller). */
function gaussian(rand: () => number): number {
  const u = 1 - rand(); // (0, 1]: log(0) never happens
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

const NOW = new Date("2026-09-29T12:00:00.000Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();
const RATES = { ILS: 1, USD: 4, EUR: 5 };

function row(over: Partial<DealPriceRow> = {}): DealPriceRow {
  return {
    origin: "TLV", destination: "ATH", depart_date: "2026-11-10", return_date: "2026-11-17",
    price_amount: 250, price_currency: "USD", source: "travelpayouts", ticket_structure: "roundtrip",
    airlines_json: '["A3"]', checked_at: ago(2), ...over,
  };
}

/**
 * One bucket in the prices table: BASE14 as 14 daily runs in USD at the fixed rate 4 (so 250 USD = 1000 ILS), the
 * newest of them 24 hours before the candidate, then the candidate run itself `candidateHoursAgo` before NOW.
 */
function bucketRows(candidateUsd: number, over: Partial<DealPriceRow> = {}, candidateHoursAgo = 2): DealPriceRow[] {
  const history = BASE14.map((ils, i) => row({ ...over, price_amount: ils / 4, checked_at: ago(candidateHoursAgo + 24 * (14 - i)) }));
  return [...history, row({ ...over, price_amount: candidateUsd, checked_at: ago(candidateHoursAgo) })];
}

// --- median and MAD -----------------------------------------------------------------------------------

describe("median and scaled MAD", () => {
  it("median takes the middle value, or the mean of the two middle ones, without touching its input", () => {
    const input = [5, 1, 4];
    expect(median(input)).toBe(4); // sorted 1 4 5
    expect(input).toEqual([5, 1, 4]);
    expect(median([10, 2, 8, 4])).toBe(6); // sorted 2 4 8 10: (4 + 8) / 2
    expect(median([7])).toBe(7);
  });

  it("MAD is scaled by 1.4826 and ignores an absurd value that would wreck a standard deviation", () => {
    // [1 2 3 4 100]: median 3, |x - 3| = 2 1 0 1 97, sorted 0 1 1 2 97, MAD 1, scaled 1.4826
    // (mean 22 and sample standard deviation about 43.6 would both be dominated by the 100)
    expect(median([1, 2, 3, 4, 100])).toBe(3);
    expect(scaledMad([1, 2, 3, 4, 100])).toBeCloseTo(1.4826, 10);
  });

  it("one past error fare inside the baseline barely moves it", () => {
    // BASE14 with one 100 in place of a 1000: sorted 100 850 900 900 950 950 1000 1000 1000 1050 1050 1100 1100 1150
    // median = (1000 + 1000) / 2 still 1000; |x - 1000| sorted 0 0 0 50 50 50 50 100 100 100 100 150 150 900
    // MAD = (50 + 100) / 2 = 75, scaled 1.4826 * 75 = 111.195 (the mean drops to 936 and the sample standard deviation triples, from 85 to 255)
    const dirty = [...BASE14];
    dirty[0] = 100;
    const a = assessPrice(daily(dirty), snap(400, 14));
    expect(a.baselineIls).toBe(1000);
    expect(a.madIls).toBeCloseTo(1.4826 * 75, 1); // the hand value sits on a rounding tie, so either cent (111.19 or 111.20) is right, but not 75 or 1.48 * 75
    expect(a.verdict).toBe("error_fare"); // z = -600 / 111.195 = -5.40
  });
});

// --- bucket key ---------------------------------------------------------------------------------------

describe("bucketKey", () => {
  const base: BucketFields = { origin: "TLV", destination: "ATH", depart_date: "2026-11-10", return_date: "2026-11-17", ticket_structure: "roundtrip" };

  it("is origin | destination | structure | departure month | trip-length band", () => {
    expect(bucketKey(base)).toBe("TLV|ATH|roundtrip|2026-11|7-10n"); // 10 Nov to 17 Nov is 7 nights
  });

  it("normalises case and whitespace, and pools different date pairs of the same month and length band", () => {
    const messy = { origin: " tlv ", destination: "ath", depart_date: "2026-11-25", return_date: "2026-12-02", ticket_structure: "ROUNDTRIP" };
    expect(bucketKey(messy)).toBe("TLV|ATH|roundtrip|2026-11|7-10n"); // 25 Nov to 2 Dec: 7 nights, departs in November
    expect(bucketKey({ ...base, depart_date: "2026-11-01", return_date: "2026-11-11" })).toBe("TLV|ATH|roundtrip|2026-11|7-10n"); // 10 nights
  });

  it("separates what is not comparable: month, year, structure, route, trip length", () => {
    const key = bucketKey(base);
    expect(bucketKey({ ...base, depart_date: "2026-12-10", return_date: "2026-12-17" })).not.toBe(key); // July vs December style
    expect(bucketKey({ ...base, depart_date: "2027-11-10", return_date: "2027-11-17" })).not.toBe(key);
    expect(bucketKey({ ...base, ticket_structure: "split" })).not.toBe(key);
    expect(bucketKey({ ...base, destination: "ROM" })).not.toBe(key);
    expect(bucketKey({ ...base, origin: "ETM" })).not.toBe(key);
    expect(bucketKey({ ...base, return_date: "2026-11-13" })).not.toBe(key); // 3 nights instead of 7
    // the documented cost of hard edges: neighbouring days across a month boundary do not share evidence
    expect(bucketKey({ ...base, depart_date: "2026-07-31", return_date: "2026-08-07" })).not.toBe(bucketKey({ ...base, depart_date: "2026-08-01", return_date: "2026-08-08" }));
  });

  it("bands trip lengths 0-3, 4-6, 7-10, 11-14, 15-21 and 22+ nights (edges inclusive)", () => {
    const band = (nights: number) => {
      const ret = new Date(Date.UTC(2026, 10, 1 + nights)).toISOString().slice(0, 10);
      return bucketKey({ ...base, depart_date: "2026-11-01", return_date: ret })?.split("|")[4];
    };
    expect([0, 3, 4, 6, 7, 10, 11, 14, 15, 21, 22, 60].map(band)).toEqual([
      "0-3n", "0-3n", "4-6n", "4-6n", "7-10n", "7-10n", "11-14n", "11-14n", "15-21n", "15-21n", "22+n", "22+n",
    ]);
  });

  it("returns null for rows that cannot be placed", () => {
    expect(bucketKey({ ...base, return_date: "2026-11-09" })).toBeNull(); // returns before departing
    expect(bucketKey({ ...base, depart_date: "2026-02-30" })).toBeNull(); // not a calendar date
    expect(bucketKey({ ...base, depart_date: "10/11/2026" })).toBeNull();
    expect(bucketKey({ ...base, return_date: "" })).toBeNull();
    for (const notARow of [null, undefined, 5, "x"]) expect(bucketKey(notARow as unknown as BucketFields), String(notARow)).toBeNull();
  });
});

// --- assessPrice --------------------------------------------------------------------------------------

describe("assessPrice: verdicts on the reference history", () => {
  const judge = (price: number) => assessPrice(daily(BASE14), snap(price, 14));

  it("flags a clear error fare", () => {
    // candidate 400: drop = (1000 - 400) / 1000 = 60% >= 50%; z = (400 - 1000) / 74.13 = -8.09 <= -3.5
    const a = judge(400);
    expect(a).toMatchObject({ verdict: "error_fare", baselineIls: 1000, madIls: 74.13, dropPct: 60, robustZ: -8.09, sampleSize: 14, spanDays: 13 });
    expect(a.reason).toContain("60.0% below the median 1000 ILS");
  });

  it("flags a deal between the two thresholds", () => {
    // candidate 650: drop = 350 / 1000 = 35% (between 30 and 50); z = -350 / 74.13 = -4.72
    expect(judge(650)).toMatchObject({ verdict: "deal", dropPct: 35, robustZ: -4.72 });
  });

  it("treats both drop thresholds as inclusive", () => {
    expect(judge(700)).toMatchObject({ verdict: "deal", dropPct: 30, robustZ: -4.05 }); // exactly 30%: z = -300 / 74.13
    expect(judge(500)).toMatchObject({ verdict: "error_fare", dropPct: 50, robustZ: -6.74 }); // exactly 50%: z = -500 / 74.13
    expect(judge(700.01).verdict).toBe("normal"); // 29.999%: only the relative drop stops this one (z is -4.05)
    expect(judge(500.01).verdict).toBe("deal");
  });

  it("does not flag an ordinary dip: a big z-score without the relative drop is not a deal", () => {
    // candidate 720: drop 28% < 30% although z = -280 / 74.13 = -3.78 is already past -3.5
    const a = judge(720);
    expect(a).toMatchObject({ verdict: "normal", dropPct: 28, robustZ: -3.78 });
    expect(a.reason).toContain("under the 30% needed for a deal");
  });

  it("reports a fare above or at the median as normal with a zero or negative drop", () => {
    expect(judge(1200)).toMatchObject({ verdict: "normal", dropPct: -20 });
    expect(judge(1000)).toMatchObject({ verdict: "normal", dropPct: 0, robustZ: 0 });
    expect(judge(1000).reason).toBe("not below the median 1000 ILS");
  });

  it("follows a seasonal climb instead of counting it as noise", () => {
    // 900, 920, ... 1160 (+20 a day). As one flat pile the median is (1020 + 1040) / 2 = 1030 and the MAD 70 (scaled
    // 103.78): 700 is 32.04% below with z = -330 / 103.78 = -3.18, "a swing", although the climb stands at 1180 on day 14
    // and 700 is 41% under that. The line is perfect (slope 20), so every price carried to day 14 is 1180: median 1180,
    // MAD 0, scale = the 2% floor 23.6.
    const climb = daily(Array.from({ length: 14 }, (_, i) => 900 + 20 * i));
    expect(assessPrice(climb, snap(1180, 14))).toMatchObject({ verdict: "normal", baselineIls: 1180, madIls: 0, dropPct: 0 }); // on the trend
    expect(assessPrice(climb, snap(1100, 14))).toMatchObject({ verdict: "normal", dropPct: 6.78 }); // 80 / 1180, under the 30% needed
    // 700: drop = 480 / 1180 = 40.68%, z = -480 / 23.6 = -20.34
    const a = assessPrice(climb, snap(700, 14));
    expect(a).toMatchObject({ verdict: "deal", baselineIls: 1180, madIls: 0, dropPct: 40.68, robustZ: -20.34, sampleSize: 14 });
    expect(a.reason).toContain("40.7% below the trend-adjusted median 1180 ILS");
    expect(a.reason).toContain("trend +20 ILS/day");
    // 800 was "22.33% below, normal" against the flat median; against where the climb stands it is 32.2% below
    expect(assessPrice(climb, snap(800, 14))).toMatchObject({ verdict: "deal", dropPct: 32.2 });
    // with the trend switched off (a minimum trend no climb reaches) the old flat verdicts come back
    expect(assessPrice(climb, snap(700, 14), { minTrendPct: 1e9 })).toMatchObject({ verdict: "normal", baselineIls: 1030, madIls: 103.78, dropPct: 32.04, robustZ: -3.18 });
    expect(assessPrice(climb, snap(800, 14), { minTrendPct: 1e9 })).toMatchObject({ verdict: "normal", dropPct: 22.33 });
  });

  it("leaves a gentle slope to the plain median", () => {
    // 1000, 1002, ... 1026: a perfect line, but only 26 ILS (2.6%) over the window, under the 10% that is worth a correction.
    // median (1012 + 1014) / 2 = 1013; |x - 1013| sorted 1 1 3 3 5 5 7 7 9 9 11 11 13 13, MAD 7, scaled 10.38 < the floor 20.26
    const gentle = daily(Array.from({ length: 14 }, (_, i) => 1000 + 2 * i));
    const a = assessPrice(gentle, snap(650, 14)); // drop = 363 / 1013 = 35.83%, z = -363 / 20.26 = -17.92
    expect(a).toMatchObject({ verdict: "deal", baselineIls: 1013, madIls: 10.38, dropPct: 35.83, robustZ: -17.92 });
    expect(a.reason).not.toContain("trend");
  });

  it("does not flag anything in a wide-spread noisy bucket, even a fare near its historical minimum", () => {
    // sorted: 600 650 700 800 900 1000 1100 1200 1250 1300 1400 1500 1550 1600  (n = 14)
    // median = (1100 + 1200) / 2 = 1150; |x - 1150| sorted 50 50 100 150 150 250 250 350 350 400 450 450 500 550
    // MAD = (250 + 350) / 2 = 300, scaled 444.78
    const noisy = daily([600, 1600, 700, 1500, 800, 1400, 900, 1300, 1000, 1200, 1100, 1250, 650, 1550]);
    // (a line through it, +41.7 a day, leaves 191.5 ILS of scatter: 13 days x 41.7 = 542 is 2.8 scatters, under the 4 it takes
    // to believe a trend, so the plain median and MAD below stand)
    // 700: drop = 450 / 1150 = 39.13% (passes the relative rule) but z = -450 / 444.78 = -1.01
    expect(assessPrice(noisy, snap(700, 14))).toMatchObject({ verdict: "normal", baselineIls: 1150, madIls: 444.78, dropPct: 39.13, robustZ: -1.01 });
    // 500 is below anything ever seen: drop = 650 / 1150 = 56.52% (error fare by the relative rule), z = -650 / 444.78 = -1.46
    expect(assessPrice(noisy, snap(500, 14))).toMatchObject({ verdict: "normal", dropPct: 56.52, robustZ: -1.46 });
  });

  it("floors the scale when every past price is identical (MAD 0)", () => {
    const flat = daily(Array.from({ length: 12 }, () => 1000)); // median 1000, MAD 0, scale = 2% of 1000 = 20
    expect(assessPrice(flat, snap(650, 12))).toMatchObject({ verdict: "deal", madIls: 0, dropPct: 35, robustZ: -17.5 }); // -350 / 20
    expect(assessPrice(flat, snap(400, 12)).verdict).toBe("error_fare");
    expect(assessPrice(flat, snap(980, 12))).toMatchObject({ verdict: "normal", dropPct: 2, robustZ: -1 }); // -20 / 20
  });

  it("scores a fare above the median as normal, never as a deal", () => {
    expect(assessPrice(daily(BASE14), snap(5000, 14)).verdict).toBe("normal");
  });
});

describe("assessPrice: minimum evidence", () => {
  it("returns insufficient_data with null statistics for a candidate 60% down but only 5 snapshots", () => {
    // 5 snapshots over 10 days, median 1000, candidate 400 would be 60% below: still no verdict
    const five: PriceSnapshot[] = [1000, 1100, 900, 1050, 950].map((p, i) => snap(p, i * 2.5));
    expect(assessPrice(five, snap(400, 12))).toEqual({
      verdict: "insufficient_data", baselineIls: null, madIls: null, dropPct: null, robustZ: null,
      sampleSize: 5, spanDays: 10, reason: "not enough history: 5 of 12 snapshots",
    });
  });

  it("needs 12 snapshots: 11 is not enough, 12 is", () => {
    const twelve = daily(BASE14.slice(0, 12)); // sorted 850 900 900 950 1000 1000 1000 1050 1050 1100 1100 1150: median (1000 + 1000) / 2
    expect(assessPrice(twelve.slice(1), snap(400, 14)).verdict).toBe("insufficient_data");
    expect(assessPrice(twelve, snap(400, 14))).toMatchObject({ verdict: "error_fare", baselineIls: 1000, sampleSize: 12 });
  });

  it("needs 7 days of span: 12 snapshots in 5.5 days are not enough, exactly 7 days is", () => {
    const halfDays = BASE14.slice(0, 12).map((p, i) => snap(p, i * 0.5)); // 11 * 0.5 = 5.5 days
    expect(assessPrice(halfDays, snap(400, 6))).toMatchObject({ verdict: "insufficient_data", sampleSize: 12, spanDays: 5.5, reason: "not enough history: 5.5 of 7 days" });
    const offsets = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 5.5, 6, 6.5, 7]; // 12 snapshots, newest exactly 7 days after the oldest, no two in one 6-hour bin
    const seven = BASE14.slice(0, 12).map((p, i) => snap(p, offsets[i] as number));
    expect(assessPrice(seven, snap(400, 8))).toMatchObject({ verdict: "error_fare", spanDays: 7 });
    const justShort = seven.map((s, i) => (i === 11 ? snap(s.priceIls, 6.99) : s)); // still 12 bins, so the span is the only shortfall
    expect(assessPrice(justShort, snap(400, 8))).toMatchObject({ verdict: "insufficient_data", sampleSize: 12, spanDays: 6.99, reason: "not enough history: 6.9 of 7 days" }); // cut, never rounded up to "7.0 of 7"
  });

  it("names every shortfall, including an empty history", () => {
    expect(assessPrice(daily([1000, 1000, 1000]), snap(300, 3)).reason).toBe("not enough history: 3 of 12 snapshots, 2.0 of 7 days, 3 of 5 distinct days");
    expect(assessPrice([], snap(300, 3))).toMatchObject({
      verdict: "insufficient_data", sampleSize: 0, spanDays: 0, reason: "not enough history: 0 of 12 snapshots, 0.0 of 7 days, 0 of 5 distinct days",
    });
  });

  it("never lets the candidate, or anything from its future, into its own baseline", () => {
    const clean = assessPrice(daily(BASE14.slice(0, 12)), snap(400, 12));
    // the stored row of the candidate itself (same time, same price) and a later, even cheaper snapshot are ignored
    const polluted = assessPrice([...daily(BASE14.slice(0, 12)), snap(400, 12), snap(100, 13)], snap(400, 12));
    expect(polluted).toEqual(clean);
    expect(polluted.sampleSize).toBe(12); // 14 if the two extra snapshots had counted
  });

  it("ignores unusable history rows instead of counting them", () => {
    const junk: PriceSnapshot[] = [
      { priceIls: 0, checkedAt: at(0.5) }, { priceIls: -50, checkedAt: at(1.5) }, { priceIls: Number.NaN, checkedAt: at(2.5) },
      { priceIls: Infinity, checkedAt: at(3.5) }, { priceIls: 500, checkedAt: "yesterday" }, { priceIls: 500, checkedAt: "" },
      { priceIls: 500, checkedAt: "2026-09-02 10:00:00" }, // a space instead of the T
      // no zone: read in the host's local time, so refused (each of these would move the median if it counted)
      { priceIls: 500, checkedAt: "2026-09-02T10:00:00" }, { priceIls: 500, checkedAt: "2026-09-03T10:00:00.000" }, { priceIls: 500, checkedAt: "2026-09-04T10:00" },
    ];
    expect(assessPrice([...daily(BASE14), ...junk], snap(400, 14))).toEqual(assessPrice(daily(BASE14), snap(400, 14)));
  });

  it("never turns a bad candidate into an error fare", () => {
    for (const bad of [0, -100, Number.NaN, Infinity]) {
      expect(assessPrice(daily(BASE14), snap(bad, 14)).verdict, String(bad)).toBe("insufficient_data");
    }
    expect(assessPrice(daily(BASE14), { priceIls: 400, checkedAt: "soon" }).verdict).toBe("insufficient_data");
    // a candidate stamped without a zone is refused, not read in local time (that would make it an error fare on some hosts)
    for (const zoneless of ["2026-09-15T00:00:00", "2026-09-15T00:00:00.000", "2026-09-15T00:00", "2026-09-15 00:00:00"]) {
      expect(assessPrice(daily(BASE14), { priceIls: 400, checkedAt: zoneless }).verdict, zoneless).toBe("insufficient_data");
    }
    expect(assessPrice(daily(BASE14), { priceIls: 400, checkedAt: "2026-09-15T00:00:00Z" }).verdict).toBe("error_fare"); // the same instant with a zone
  });

  it("does not throw on a missing candidate or a null snapshot", () => {
    expect(assessPrice(daily(BASE14), null as unknown as PriceSnapshot)).toMatchObject({ verdict: "insufficient_data", sampleSize: 0 });
    expect(assessPrice(daily(BASE14), undefined as unknown as PriceSnapshot).verdict).toBe("insufficient_data");
    expect(assessPrice([null, undefined, 5, ...daily(BASE14)] as unknown as PriceSnapshot[], snap(400, 14))).toEqual(assessPrice(daily(BASE14), snap(400, 14)));
  });
});

describe("assessPrice: duplicate and simultaneous snapshots", () => {
  it("counts identical duplicate snapshots once", () => {
    // 6 distinct snapshots, every one stored 4 times: 24 rows, 6 observations
    const six = daily([1000, 1100, 900, 1050, 950, 1000]).flatMap((s) => [s, s, s, s]);
    expect(six).toHaveLength(24);
    expect(assessPrice(six, snap(300, 8))).toMatchObject({ verdict: "insufficient_data", sampleSize: 6 });
  });

  it("counts one check instant once and keeps its cheapest fare (a run stores several date pairs at one time)", () => {
    // every run also stored a dearer date pair 500 ILS above: the baseline is still the cheapest fare of each run
    const twoPerRun = daily(BASE14.slice(0, 12)).flatMap((s) => [{ ...s, priceIls: s.priceIls + 500 }, s]);
    expect(twoPerRun).toHaveLength(24);
    const a = assessPrice(twoPerRun, snap(400, 12));
    expect(a).toMatchObject({ verdict: "error_fare", baselineIls: 1000, sampleSize: 12 });
    // and one run alone cannot pass for a week of evidence
    const oneRun = Array.from({ length: 30 }, (_, i) => snap(1000 + i, 0));
    expect(assessPrice(oneRun, snap(300, 8))).toMatchObject({ verdict: "insufficient_data", sampleSize: 1 });
  });
});

describe("assessPrice: a trend is followed, on the recent window", () => {
  it("follows a falling trend too, where the flat median has a MAD too wide to see a deal", () => {
    // 1650, 1600, ... 1000 (-50 a day): flat median 1325 and scaled MAD 259.45, so 600 (54.72% below) has z = -2.79 and is a "swing";
    // along the line it is day 14 at 950, and 600 is 36.84% under that (MAD 0, scale = the 2% floor 19)
    const falling = daily(Array.from({ length: 14 }, (_, i) => 1650 - 50 * i));
    const a = assessPrice(falling, snap(600, 14));
    expect(a).toMatchObject({ verdict: "deal", baselineIls: 950, dropPct: 36.84, robustZ: -18.42 });
    expect(a.reason).toContain("trend -50 ILS/day");
    expect(assessPrice(falling, snap(950, 14))).toMatchObject({ verdict: "normal", dropPct: 0 }); // on the line
    expect(assessPrice(falling, snap(600, 14), { minTrendPct: 1e9 })).toMatchObject({ verdict: "normal", baselineIls: 1325, madIls: 259.45, robustZ: -2.79 });
  });

  it("fits the last 21 days only: an old flat stretch does not hide a recent climb", () => {
    // 39 days at 1000, then a perfect climb of 40 a day from day 39 (1000) to day 59 (1800). The window from day 39 holds 21 snapshots on the
    // line, and every price carried to day 60 is 1840: median 1840, MAD 0. The 60 snapshots together would call the climb a swing.
    const rising = [...Array.from({ length: 39 }, (_, d) => snap(1000, d)), ...Array.from({ length: 21 }, (_, i) => snap(1000 + 40 * i, 39 + i))];
    const a = assessPrice(rising, snap(1100, 60)); // drop = 740 / 1840 = 40.22%
    expect(a).toMatchObject({ verdict: "deal", baselineIls: 1840, madIls: 0, dropPct: 40.22, sampleSize: 21, spanDays: 20 }); // the evidence is the window's
    expect(a.reason).toContain("trend +40 ILS/day");
  });

  it("fits at most the newest 60 snapshots of the window", () => {
    // 84 snapshots, one every 6 hours over 21 days, on 1000 + 10 a day: every carried price is 1210 at day 21
    const dense = Array.from({ length: 84 }, (_, i) => snap(1000 + 10 * (i * 0.25), i * 0.25));
    expect(assessPrice(dense, snap(700, 21))).toMatchObject({ verdict: "deal", baselineIls: 1210, dropPct: 42.15, sampleSize: 60, spanDays: 14.75 });
  });

  it("keeps the plain median when the last 21 days are too thin to be evidence of their own", () => {
    // 30 days at 1000, then 9 snapshots in the 21 days before the candidate on a steep climb: 9 of the 12 needed. The window is not allowed to
    // turn the verdict into insufficient_data or to fit a line through 9 points, so the 39 snapshots as a whole give the plain median.
    const thin = [31, 33.5, 36, 38.5, 41, 43.5, 46, 48.5, 50.5].map((d) => snap(1000 + 40 * (d - 30), d));
    const a = assessPrice([...Array.from({ length: 30 }, (_, d) => snap(1000, d)), ...thin], snap(700, 51));
    expect(a).toMatchObject({ verdict: "deal", baselineIls: 1000, sampleSize: 39, spanDays: 50.5, dropPct: 30 });
    expect(a.reason).not.toContain("trend");
  });
});

describe("assessPrice: a burst of searches is one look at the market", () => {
  // every fresh search stamps its own checkedAt, so 11 searches in 10 minutes are 11 distinct timestamps
  const burst = (day: number, n: number): PriceSnapshot[] =>
    Array.from({ length: n }, (_, i) => ({ priceIls: 1000 + i, checkedAt: new Date(START + day * DAY + i * 60_000).toISOString() }));
  const afterBurst: PriceSnapshot = { priceIls: 650, checkedAt: new Date(START + 7 * DAY + 25 * 60_000).toISOString() };

  it("counts 11 searches within 10 minutes as one observation, next to one a week older", () => {
    // 12 timestamps but 2 bins: day 0, and the first 6 hours of day 7 (whose cheapest fare, 1000, stands for the burst)
    expect(assessPrice([snap(1010, 0), ...burst(7, 11)], afterBurst)).toEqual({
      verdict: "insufficient_data", baselineIls: null, madIls: null, dropPct: null, robustZ: null,
      sampleSize: 2, spanDays: 7, reason: "not enough history: 2 of 12 snapshots, 2 of 5 distinct days",
    });
  });

  it("would have passed as a week of evidence with a bin narrower than the gap between searches and no day rule", () => {
    // the old rule: 12 distinct timestamps over 7.0 days. Ten minutes of prices (MAD 7.41, under the 2% floor of 20.1) decide the verdict
    const old = assessPrice([snap(1010, 0), ...burst(7, 11)], afterBurst, { binHours: 0.01, minDistinctDays: 0 }); // 0.01 h = 36 s
    expect(old).toMatchObject({ verdict: "deal", sampleSize: 12, spanDays: 7.01 });
  });

  it("needs the observations on 5 different days: 12 bins on 4 days are not a spread", () => {
    // 12 snapshots in 12 different 6-hour bins over 9.5 days, but on 4 calendar days only (day 0, then days 7, 8 and 9)
    const clustered = [snap(1000, 0), ...Array.from({ length: 11 }, (_, i) => snap(1000, 7 + i * 0.25))];
    expect(assessPrice(clustered, snap(600, 10))).toMatchObject({
      verdict: "insufficient_data", sampleSize: 12, spanDays: 9.5, reason: "not enough history: 4 of 5 distinct days",
    });
    expect(assessPrice(clustered, snap(600, 10), { minDistinctDays: 4 }).verdict).toBe("deal");
  });

  it("still reaches a verdict with 12 snapshots 16 hours apart (12 bins on 8 days over 7.33 days)", () => {
    const spread = Array.from({ length: 12 }, (_, i) => snap(1000, (i * 16) / 24));
    expect(assessPrice(spread, snap(650, 8))).toMatchObject({ verdict: "deal", sampleSize: 12, spanDays: 7.33 });
  });

  it("keeps the cheapest of two snapshots in one bin, whatever the order", () => {
    const cfg = { minSamples: 2, minSpanDays: 1, minDistinctDays: 2 };
    // 1200 at 00:00 and 900 at 03:00 of day 2 share a bin: the observations are 1000 and 900, median 950 (1100 if the first one won)
    const history = [snap(1000, 0), snap(1200, 2), snap(900, 2 + 3 / 24)];
    const a = assessPrice(history, snap(500, 3), cfg);
    expect(a).toMatchObject({ baselineIls: 950, sampleSize: 2 });
    expect(assessPrice([...history].reverse(), snap(500, 3), cfg)).toEqual(a);
  });

  it("lets the older of two equally cheap snapshots of a bin stand for it, whatever the order", () => {
    const cfg = { minSamples: 2, minSpanDays: 1, minDistinctDays: 2 };
    const history = [snap(1000, 0), snap(900, 2), snap(900, 2 + 3 / 24)];
    const a = assessPrice(history, snap(500, 3), cfg);
    expect(a).toMatchObject({ sampleSize: 2, spanDays: 2 }); // 2.13 if the later one stood
    expect(assessPrice([...history].reverse(), snap(500, 3), cfg)).toEqual(a);
  });

  it("falls back to the default bin for a zero or negative width", () => {
    const spread = Array.from({ length: 12 }, (_, i) => snap(1000, (i * 16) / 24)); // 12 bins of 6 hours; one bin of infinite width would leave 1 observation
    const expected = assessPrice(spread, snap(650, 8));
    expect(expected.verdict).toBe("deal");
    for (const binHours of [0, -6]) {
      expect(assessPrice(spread, snap(650, 8), { binHours }), String(binHours)).toEqual(expected);
      expect(assessPrice([snap(1010, 0), ...burst(7, 11)], afterBurst, { binHours }).verdict, String(binHours)).toBe("insufficient_data");
    }
  });
});

describe("assessPrice: a price the history has already reached is not news", () => {
  // A history that sits on one level most of the time has a MAD of 0 (or close to it), so a minority of lower prices
  // scores a huge z-score: the median is the majority level, the scale collapses to the 2% floor. Only the rank rule
  // tells "the price of every third run" from "a fare nobody has seen".

  it("does not call a price seen 4 times in 12 a deal", () => {
    // 8 x 1000 + 4 x 650: median 1000, MAD 0, scale = 2% of 1000 = 20; 650 is 35% below with z = -350 / 20 = -17.5
    const history = daily([1000, 1000, 650, 1000, 1000, 650, 1000, 1000, 650, 1000, 1000, 650]);
    const a = assessPrice(history, snap(650, 12));
    expect(a).toMatchObject({ verdict: "normal", baselineIls: 1000, madIls: 0, dropPct: 35, robustZ: -17.5 });
    expect(a.reason).toBe("35.0% below the median 1000 ILS, but this price already occurred in 4 of 12 earlier snapshots");
    expect(assessPrice(history, snap(650, 12), { maxPriorAtOrBelow: 4 }).verdict).toBe("deal"); // the drop and the z-score alone would say so
  });

  it("does not call a price seen 5 times in 12 a mistake fare", () => {
    // 7 x 1000 + 5 x 400: 400 is 60% below with z = -600 / 20 = -30
    const history = daily([1000, 400, 1000, 400, 1000, 400, 1000, 400, 1000, 400, 1000, 1000]);
    const a = assessPrice(history, snap(400, 12));
    expect(a).toMatchObject({ verdict: "normal", dropPct: 60, robustZ: -30 });
    expect(a.reason).toContain("already occurred in 5 of 12 earlier snapshots");
    expect(assessPrice(history, snap(400, 12), { maxPriorAtOrBelow: 5 }).verdict).toBe("error_fare");
  });

  it("does not call a price worse than 5 of 12 earlier ones a deal", () => {
    // 7 x 1000 + 5 x 500: 690 is 31% below with z = -310 / 20 = -15.5, and five earlier prices were cheaper still
    const history = daily([1000, 500, 1000, 500, 1000, 500, 1000, 500, 1000, 500, 1000, 1000]);
    const a = assessPrice(history, snap(690, 12));
    expect(a).toMatchObject({ verdict: "normal", dropPct: 31, robustZ: -15.5 });
    expect(a.reason).toContain("already occurred in 5 of 12");
  });

  it("holds when the levels have a spread, so the MAD is above the floor too", () => {
    // 630 630 650 670 670 | 992 992 992 1000 1008 1008 1008 (n = 12): median (992 + 992) / 2 = 992
    // |x - 992| sorted 0 0 0 8 16 16 16 322 322 342 362 362, MAD (16 + 16) / 2 = 16, scaled 23.72 (the floor is 19.84)
    const history = daily([1000, 630, 992, 670, 1008, 630, 992, 670, 1008, 650, 992, 1008]);
    // 650: drop = 342 / 992 = 34.48%, z = -342 / 23.72 = -14.42, and 630, 630 and 650 were as cheap
    const a = assessPrice(history, snap(650, 12));
    expect(a).toMatchObject({ verdict: "normal", baselineIls: 992, madIls: 23.72, dropPct: 34.48, robustZ: -14.42 });
    expect(a.reason).toContain("already occurred in 3 of 12");
  });

  it("still calls a new low a deal, also after a long flat history", () => {
    expect(assessPrice(flat(1000), snap(650, 12))).toMatchObject({ verdict: "deal", dropPct: 35 });
    expect(assessPrice(flat(1000), snap(400, 12)).verdict).toBe("error_fare");
    expect(assessPrice(daily(BASE14), snap(650, 14)).verdict).toBe("deal"); // below everything seen, 850 was the cheapest
  });

  it("lets a price seen once before through, and stops at twice", () => {
    const once = flat(1000).map((s, i) => (i === 5 ? { ...s, priceIls: 650 } : s));
    expect(assessPrice(once, snap(650, 12))).toMatchObject({ verdict: "deal", dropPct: 35 });
    const twice = once.map((s, i) => (i === 8 ? { ...s, priceIls: 650 } : s));
    expect(assessPrice(twice, snap(650, 12)).verdict).toBe("normal");
    expect(assessPrice(once, snap(650, 12), { maxPriorAtOrBelow: 0 }).verdict).toBe("normal"); // the limit is tunable
    expect(assessPrice(flat(1000), snap(650, 12), { maxPriorAtOrBelow: -5 }).verdict).toBe("deal"); // and never below "nothing seen"
  });

  it("counts an earlier price within the 2% spread of the candidate as reached", () => {
    const twice = flat(1000).map((s, i) => (i === 4 || i === 8 ? { ...s, priceIls: 650 } : s));
    expect(assessPrice(twice, snap(637, 12)).verdict).toBe("deal"); // 637 * 1.02 = 649.74 < 650: below what was seen
    expect(assessPrice(twice, snap(640, 12)).verdict).toBe("normal"); // 640 * 1.02 = 652.8 >= 650: the same level
  });

  it("goes quiet after a permanent drop: the first two checks at the new level are deals, the rest are not", () => {
    // 20 days at 1000, then 650 for good; the median stays 1000 for a long time and the z-score is -17.5 every time
    const shifted = (checks: number) => [...flat(1000, 20), ...Array.from({ length: checks }, (_, i) => snap(650, 20 + i))];
    const verdicts = [0, 1, 2, 3, 4, 5].map((k) => assessPrice(shifted(k), snap(650, 20 + k)).verdict);
    expect(verdicts).toEqual(["deal", "deal", "normal", "normal", "normal", "normal"]);
    expect(assessPrice(shifted(2), snap(650, 22)).reason).toContain("already occurred in 2 of 22 earlier snapshots");
  });
});

describe("assessPrice: thresholds are exact despite float noise", () => {
  it("counts a 30% drop that computes as 29.999999999999993 as 30%", () => {
    // (102 - 71.4) / 102 * 100 = 29.999999999999993 in floating point
    expect(assessPrice(flat(102), snap(71.4, 12))).toMatchObject({ verdict: "deal", dropPct: 30 });
    expect(assessPrice(flat(102), snap(71.41, 12))).toMatchObject({ verdict: "normal", dropPct: 29.99 });
  });

  it("counts a drop that computes as 44.99999999999999 as the 45% it is (error threshold set to 45)", () => {
    // (104 - 57.2) / 104 * 100 = 44.99999999999999
    expect(assessPrice(flat(104), snap(57.2, 12), { errorDropPct: 45 })).toMatchObject({ verdict: "error_fare", dropPct: 45 });
    expect(assessPrice(flat(104), snap(57.21, 12), { errorDropPct: 45 }).verdict).toBe("deal"); // 44.99%
  });

  it("treats z = -3.5 as inclusive (a 5% drop threshold, so that only the z-score decides)", () => {
    // flat 1000: scale = 20, so 930 is z = -70 / 20 = -3.5 exactly
    expect(assessPrice(flat(1000), snap(930, 12), { dealDropPct: 5 })).toMatchObject({ verdict: "deal", robustZ: -3.5 });
    const just = assessPrice(flat(1000), snap(930.01, 12), { dealDropPct: 5 }); // z = -3.4995
    expect(just.verdict).toBe("normal");
    expect(just.reason).toContain("robust z -3.49 is above -3.5"); // cut, not rounded to a "-3.50" that would not be above -3.5
  });

  it("treats a z-score that computes as -3.4999999999999964 as -3.5", () => {
    // 101 * 0.93 = 93.93 exactly in decimal, but (93.93 - 101) / 2.02 comes out at -3.4999999999999964
    expect(assessPrice(flat(101), snap(93.93, 12), { dealDropPct: 5 })).toMatchObject({ verdict: "deal", robustZ: -3.5 });
    expect(assessPrice(flat(101), snap(93.94, 12), { dealDropPct: 5 }).verdict).toBe("normal");
  });

  it("does not say 'under the 30% needed' about a drop of exactly 30% that the z-score refuses", () => {
    // median 102 but a MAD of 6 x 1.4826 = 8.9: 71.4 is exactly 30% below (computed as 29.999999999999993) with z = -30.6 / 8.9 = -3.44
    const wide = daily([90, 96, 102, 108, 114, 102, 96, 108, 90, 114, 102, 102]);
    const a = assessPrice(wide, snap(71.4, 12));
    expect(a).toMatchObject({ verdict: "normal", baselineIls: 102, madIls: 8.9, dropPct: 30 });
    expect(a.reason).toContain("30.0% below the median 102 ILS, but robust z -3.43 is above -3.5");
  });

  it("reports 0, never -0, for a fare a hair above or below the median", () => {
    expect(assessPrice(daily(BASE14), snap(1000.001, 14)).dropPct).toBe(0); // drop -0.0001%: rounds to -0
    expect(assessPrice(daily(BASE14), snap(999.999, 14)).robustZ).toBe(0); // z -0.0000135
  });
});

describe("assessPrice: the reason never contradicts the verdict", () => {
  it("cuts the percentage of a failed drop check instead of rounding it up to the threshold", () => {
    const a = assessPrice(flat(1000), snap(700.01, 12)); // 29.999%
    expect(a.verdict).toBe("normal");
    expect(a.reason).toBe("29.9% below the median 1000 ILS, under the 30% needed for a deal");
    expect(assessPrice(flat(1000), snap(700.1, 12)).reason).toContain("29.9% below"); // 29.99%
  });

  it("names a tiny drop as a drop, and a fare at or above the median as not below it", () => {
    expect(assessPrice(daily(BASE14), snap(995, 14)).reason).toBe("0.5% below the median 1000 ILS, under the 30% needed for a deal");
    expect(assessPrice(daily(BASE14), snap(1000, 14)).reason).toBe("not below the median 1000 ILS");
  });
});

describe("assessPrice: configuration and determinism", () => {
  it("does not depend on the order of the history", () => {
    const rand = mulberry32(7);
    const expected = assessPrice(daily(BASE14), snap(650, 14));
    for (let i = 0; i < 20; i++) expect(assessPrice(shuffled(daily(BASE14), rand), snap(650, 14))).toEqual(expected);
  });

  it("returns the same output for the same input, and does not modify the input", () => {
    const history = Object.freeze(daily(BASE14).map((s) => Object.freeze(s)));
    const candidate = Object.freeze(snap(650, 14));
    expect(assessPrice(history, candidate)).toEqual(assessPrice(history, candidate));
  });

  it("accepts overrides, and falls back to the default for a missing or non-finite value", () => {
    const five: PriceSnapshot[] = [1000, 1100, 900, 1050, 950].map((p, i) => snap(p, i * 2.5));
    expect(assessPrice(five, snap(400, 12), { minSamples: 5 }).verdict).toBe("error_fare");
    expect(assessPrice(daily(BASE14), snap(650, 14), { dealDropPct: 40 }).verdict).toBe("normal"); // 35% < 40%
    const undefinedOverride = assessPrice(daily(BASE14), snap(650, 14), { minSamples: undefined, dealDropPct: Number.NaN });
    expect(undefinedOverride).toEqual(assessPrice(daily(BASE14), snap(650, 14)));
    expect(DEAL_CONFIG).toMatchObject({ minSamples: 12, minSpanDays: 7, dealDropPct: 30, errorDropPct: 50 });
  });

  it("never lets minSamples fall below one, and says so in the reason", () => {
    for (const minSamples of [0, -3]) {
      expect(assessPrice([], snap(500, 3), { minSamples, minSpanDays: 0, minDistinctDays: 0 }), String(minSamples)).toEqual({
        verdict: "insufficient_data", baselineIls: null, madIls: null, dropPct: null, robustZ: null,
        sampleSize: 0, spanDays: 0, reason: "not enough history: 0 of 1 snapshots",
      });
    }
  });

  it("falls back to the default spread floor for a zero or negative one instead of dividing by zero", () => {
    for (const minRelSpread of [0, -1]) {
      expect(assessPrice(flat(1000), snap(650, 12), { minRelSpread }), String(minRelSpread)).toMatchObject({ verdict: "deal", robustZ: -17.5 }); // -350 / 20, not -Infinity
      expect(assessPrice(flat(1000), snap(1000, 12), { minRelSpread }), String(minRelSpread)).toMatchObject({ verdict: "normal", robustZ: 0 }); // 0 / 20, not 0 / 0
      expect(assessPrice(flat(102), snap(50, 12), { minRelSpread }), String(minRelSpread)).toMatchObject({ verdict: "error_fare", robustZ: -25.49 }); // -52 / 2.04
    }
  });
});

// --- detectDeals --------------------------------------------------------------------------------------

describe("detectDeals: a whole prices table", () => {
  it("reports an error fare with route, dates, both prices, airlines and the evidence", () => {
    // candidate 100 USD * 4 = 400 ILS against the BASE14 history (median 1000, scaled MAD 74.13): 60% down, z -8.09
    const rows = bucketRows(100, { airlines_json: '["A3","LY"]' });
    const { deals, stats } = detectDeals(rows, RATES, NOW);
    expect(deals).toEqual([
      {
        verdict: "error_fare", origin: "TLV", destination: "ATH", departDate: "2026-11-10", returnDate: "2026-11-17",
        ticketStructure: "roundtrip", source: "travelpayouts", airlines: ["A3", "LY"],
        priceAmount: 100, priceCurrency: "USD", priceIls: 400, dropPct: 60, checkedAt: ago(2),
        bucket: "TLV|ATH|roundtrip|2026-11|7-10n",
        evidence: { baselineIls: 1000, madIls: 74.13, robustZ: -8.09, sampleSize: 14, spanDays: 13 },
        reason: "60.0% below the median 1000 ILS (robust z -8.09, 14 snapshots over 13.0 days): likely a mistake fare",
      },
    ]);
    expect(stats).toEqual({ rows: 15, buckets: 1, staleBuckets: 0, insufficientBuckets: 0, skippedNoRate: 0, missingCurrencies: [], skippedInvalid: 0, skippedFuture: 0 });
  });

  it("returns nothing for a normal fare, and an empty report for no rows", () => {
    expect(detectDeals(bucketRows(250), RATES, NOW).deals).toEqual([]); // 250 USD = 1000 ILS = the median
    expect(detectDeals([], RATES, NOW)).toEqual({
      deals: [],
      stats: { rows: 0, buckets: 0, staleBuckets: 0, insufficientBuckets: 0, skippedNoRate: 0, missingCurrencies: [], skippedInvalid: 0, skippedFuture: 0 },
    });
  });

  it("sorts the deals by dropPct, biggest first, and leaves the normal bucket out", () => {
    // 100 USD = 400 ILS: 60%   162.5 USD = 650 ILS: 35%   175 USD = 700 ILS: exactly 30%   250 USD = 1000 ILS: normal
    const rows = [
      ...bucketRows(175, { destination: "CDG" }),
      ...bucketRows(250, { destination: "LHR" }),
      ...bucketRows(162.5, { destination: "FCO" }),
      ...bucketRows(100, { destination: "ATH" }),
    ];
    const { deals, stats } = detectDeals(rows, RATES, NOW);
    expect(deals.map((d) => [d.destination, d.verdict, d.dropPct])).toEqual([
      ["ATH", "error_fare", 60],
      ["FCO", "deal", 35],
      ["CDG", "deal", 30],
    ]);
    expect(stats.buckets).toBe(4);
  });

  it("does not compare a July fare with a December one (different buckets)", () => {
    // December history sits around 2000 ILS (BASE14 * 2, i.e. USD amounts of BASE14 / 2), the July fare is a perfectly
    // ordinary 1000 ILS for July: there is no July history yet
    const december = BASE14.map((ils, i) => row({ depart_date: "2026-12-10", return_date: "2026-12-17", price_amount: ils / 2, checked_at: ago(26 + 24 * (13 - i)) }));
    const july = row({ depart_date: "2027-07-10", return_date: "2027-07-17", price_amount: 250, checked_at: ago(1) });
    const { deals, stats } = detectDeals([...december, july], RATES, NOW);
    expect(deals).toEqual([]);
    expect(stats).toMatchObject({ buckets: 2, insufficientBuckets: 1 }); // the July bucket, with nothing to compare against

    // what a bucket-blind comparison would have said: December's median 2000 (MAD 50 * 2 * 1.4826 = 148.26), July's
    // 1000 is exactly 50% below and z = -1000 / 148.26 = -6.74: a phantom error fare
    const blind = assessPrice(december.map((r) => ({ priceIls: r.price_amount * 4, checkedAt: r.checked_at })), { priceIls: 1000, checkedAt: july.checked_at });
    expect(blind).toMatchObject({ verdict: "error_fare", baselineIls: 2000, dropPct: 50, robustZ: -6.74 });
  });

  it("does not compare a short trip with a long one, or a split ticket with a round trip", () => {
    const short = row({ return_date: "2026-11-13", price_amount: 100, checked_at: ago(1) }); // 3 nights, 400 ILS
    const split = row({ ticket_structure: "split", price_amount: 100, checked_at: ago(1) });
    const { deals, stats } = detectDeals([...bucketRows(250), short, split], RATES, NOW);
    expect(deals).toEqual([]);
    expect(stats).toMatchObject({ buckets: 3, insufficientBuckets: 2 });
  });

  it("reports the candidate's own dates, judged against that date pair's own history", () => {
    // three date pairs of one bucket take turns from run to run, and the candidate's pair (21 Nov) is only in the last run
    const pairs = [["2026-11-10", "2026-11-17"], ["2026-11-12", "2026-11-19"], ["2026-11-14", "2026-11-21"]] as const;
    const rows: DealPriceRow[] = bucketRows(100).map((r, i) => ({ ...r, depart_date: pairs[i % 3]![0], return_date: pairs[i % 3]![1] }));
    const last = rows[rows.length - 1] as DealPriceRow;
    rows[rows.length - 1] = { ...last, depart_date: "2026-11-21", return_date: "2026-11-28" };
    const { deals, stats } = detectDeals(rows, RATES, NOW);
    expect(deals).toEqual([]); // 21 Nov has never been seen: nothing to compare with, and no guessing from the 14 runs of other dates
    expect(stats).toMatchObject({ buckets: 1, insufficientBuckets: 1 });

    // once the pair has a history of its own (the same 14 runs, all on 21 Nov) the same fare is judged and reported with its dates
    const own = detectDeals(bucketRows(100, { depart_date: "2026-11-21", return_date: "2026-11-28" }), RATES, NOW);
    expect(own.deals).toHaveLength(1);
    expect(own.deals[0]).toMatchObject({ departDate: "2026-11-21", returnDate: "2026-11-28", bucket: "TLV|ATH|roundtrip|2026-11|7-10n", evidence: { sampleSize: 14 } });
  });

  it("judges a bucket from its cheapest fare per run, and never puts the rest of the candidate's run in the baseline", () => {
    // every run (history and latest) also stored a dearer date pair: history +800 ILS, latest run 300 USD = 1200 ILS
    const rows = bucketRows(100).flatMap((r) => [r, { ...r, depart_date: "2026-11-12", return_date: "2026-11-19", price_amount: r.price_amount + 200 }]);
    const { deals } = detectDeals(rows, RATES, NOW);
    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({ priceAmount: 100, departDate: "2026-11-10", evidence: { baselineIls: 1000, sampleSize: 14 } });
  });

  it("counts duplicated rows once", () => {
    const rows = bucketRows(100);
    const once = detectDeals(rows, RATES, NOW);
    const twice = detectDeals([...rows, ...rows], RATES, NOW);
    expect(twice.deals).toEqual(once.deals);
    expect(twice.deals).toHaveLength(1);
    expect(twice.deals[0]?.evidence.sampleSize).toBe(14);
  });

  it("returns insufficient_data buckets as counted, not reported", () => {
    // 5 snapshots and a candidate 60% down: no verdict yet
    const rows = [...bucketRows(100).slice(9, 14), row({ price_amount: 100, checked_at: ago(1) })];
    const { deals, stats } = detectDeals(rows, RATES, NOW);
    expect(deals).toEqual([]);
    expect(stats).toMatchObject({ buckets: 1, insufficientBuckets: 1 });
  });
});

describe("detectDeals: like for like at the date pair", () => {
  // Every search stores the cheapest date pairs of its OWN window (see historyRows in pipeline.ts), so the cheapest fare of a bucket
  // is a minimum over a different set of dates each run. Judged against older minima, an ordinary fare for a cheap date that
  // earlier searches never covered would look like a mistake fare.
  const PEAK = { depart_date: "2026-12-22", return_date: "2026-12-29" };
  const EARLY = { depart_date: "2026-12-05", return_date: "2026-12-12" };
  const CHEAP = { depart_date: "2026-11-14", return_date: "2026-11-21" }; // in the bucket of the default row (November, 7 nights)
  const PEAK_RUNS = Array.from({ length: 13 }, (_, i) => row({ ...PEAK, price_amount: 450, checked_at: ago(26 + 24 * (12 - i)) })); // 1800 ILS, 13 days

  it("does not call an ordinary fare for a date the history never covered an error fare", () => {
    // the newest search's window also covers 5 Dec at 900 ILS, an ordinary price for that date, against a median of 1800 for 22 Dec
    const newest = [row({ ...EARLY, price_amount: 225, checked_at: ago(2) }), row({ ...PEAK, price_amount: 450, checked_at: ago(2) })];
    const { deals, stats } = detectDeals([...PEAK_RUNS, ...newest], RATES, NOW);
    expect(deals).toEqual([]);
    expect(stats).toMatchObject({ buckets: 1, insufficientBuckets: 1 });

    // what a comparison of the bucket's cheapest fare per run says: 50% below the median 1800, z -22.5, "likely a mistake fare"
    const pooled = [...PEAK_RUNS.map((r) => ({ priceIls: r.price_amount * 4, checkedAt: r.checked_at })), { priceIls: 900, checkedAt: ago(2) }];
    expect(assessPrice(pooled.slice(0, 13), pooled[13] as PriceSnapshot)).toMatchObject({ verdict: "error_fare", baselineIls: 1800, dropPct: 50 });
  });

  it("treats a pair that differs by one day in either date as another pair", () => {
    const history = bucketRows(250).slice(0, 14); // 10 to 17 Nov, 7 nights
    for (const other of [{ depart_date: "2026-11-10", return_date: "2026-11-18" }, { depart_date: "2026-11-09", return_date: "2026-11-17" }]) {
      const { deals, stats } = detectDeals([...history, row({ ...other, price_amount: 100, checked_at: ago(2) })], RATES, NOW); // same bucket: November, 7 to 10 nights
      expect(deals, JSON.stringify(other)).toEqual([]);
      expect(stats, JSON.stringify(other)).toMatchObject({ buckets: 1, insufficientBuckets: 1 });
    }
  });

  it("flags a real drop of the same date pair, whatever else the runs also covered", () => {
    // every third run also covered a cheaper pair (500 ILS); the pair of the candidate is in all 14 runs at the BASE14 prices
    const runs = BASE14.flatMap((ils, i) => {
      const checked_at = ago(26 + 24 * (13 - i));
      return [row({ price_amount: ils / 4, checked_at }), ...(i % 3 === 0 ? [row({ ...CHEAP, price_amount: 125, checked_at })] : [])];
    });
    const { deals } = detectDeals([...runs, row({ price_amount: 162.5, checked_at: ago(2) })], RATES, NOW); // 650 ILS: 35% below the pair's median 1000
    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({ verdict: "deal", departDate: "2026-11-10", dropPct: 35, evidence: { baselineIls: 1000, sampleSize: 14 } });
  });

  it("does not judge a cheaper date pair that only some of the runs covered, and never pools it with the rest of the month", () => {
    const runs = BASE14.flatMap((ils, i) => {
      const checked_at = ago(26 + 24 * (13 - i));
      return [row({ price_amount: ils / 4, checked_at }), ...(i % 3 === 0 ? [row({ ...CHEAP, price_amount: 125, checked_at })] : [])]; // CHEAP at 500 ILS in 5 of 14 runs
    });
    const newest = [row({ price_amount: 250, checked_at: ago(2) }), row({ ...CHEAP, price_amount: 125, checked_at: ago(2) })];
    const { deals, stats } = detectDeals([...runs, ...newest], RATES, NOW);
    expect(deals).toEqual([]); // the cheapest fare of the run is the 500 one: 5 earlier snapshots of its own, 12 are needed
    expect(stats).toMatchObject({ buckets: 1, insufficientBuckets: 1 });
  });

  it("does not report the cheap level of a source that comes and goes", () => {
    // every third run has the cheap source (160 USD = 640 ILS), the others only the dear one (250 USD = 1000 ILS)
    const run = (i: number, over: Partial<DealPriceRow>) => row({ checked_at: ago(2 + 24 * (14 - i)), ...over });
    const history = Array.from({ length: 14 }, (_, i) => (i % 3 === 2 ? run(i, { source: "travelpayouts", price_amount: 160 }) : run(i, { source: "google_flights", price_amount: 250 })));
    const cheapAgain = run(14, { source: "travelpayouts", price_amount: 160 });
    // 4 of the 14 earlier runs were at 640 and 10 at 1000: median 1000, MAD 0, so 640 is a 36% drop with z = -18 on paper, but it is no news
    const { deals, stats } = detectDeals([...history, cheapAgain], RATES, NOW);
    expect(deals).toEqual([]);
    expect(stats).toMatchObject({ buckets: 1, insufficientBuckets: 0 });
    // the first time the cheap source shows up it is a deal
    const firstTime = detectDeals([...history.map((r) => ({ ...r, source: "google_flights", price_amount: 250 })), cheapAgain], RATES, NOW);
    expect(firstTime.deals[0]).toMatchObject({ verdict: "deal", source: "travelpayouts", priceIls: 640, dropPct: 36 });
  });
});

describe("detectDeals: currencies", () => {
  it("skips rows in a currency with no rate, counts them and names the currency, never guessing 1:1", () => {
    // a 10 GBP fare would be a 10 ILS "error fare" if the currency were guessed
    const gbp = row({ price_amount: 10, price_currency: "GBP", checked_at: ago(1) });
    const skipped = detectDeals([...bucketRows(250), gbp], RATES, NOW);
    expect(skipped.deals).toEqual([]); // the newest usable row is the normal 250 USD one
    expect(skipped.stats).toMatchObject({ skippedNoRate: 1, missingCurrencies: ["GBP"], buckets: 1 });

    // once a rate exists the same row is judged: 10 GBP * 5 = 50 ILS; baseline = BASE14 + the 1000 row, median 1000, MAD 50
    // drop = 950 / 1000 = 95%, z = -950 / 74.13 = -12.82
    const rated = detectDeals([...bucketRows(250), gbp], { ...RATES, GBP: 5 }, NOW);
    expect(rated.deals).toHaveLength(1);
    expect(rated.deals[0]).toMatchObject({ verdict: "error_fare", priceAmount: 10, priceCurrency: "GBP", priceIls: 50, dropPct: 95, evidence: { baselineIls: 1000, sampleSize: 15, robustZ: -12.82 } });
  });

  it("treats a zero, negative or non-finite rate as missing", () => {
    for (const bad of [0, -4, Number.NaN, Infinity]) {
      const { deals, stats } = detectDeals(bucketRows(100), { ILS: 1, USD: bad }, NOW);
      expect(deals, String(bad)).toEqual([]);
      expect(stats, String(bad)).toMatchObject({ skippedNoRate: 15, missingCurrencies: ["USD"], buckets: 0 });
    }
  });

  it("reads currency codes case-insensitively and ignores padding", () => {
    for (const code of ["usd", " USD ", " usd "]) {
      const { deals, stats } = detectDeals(bucketRows(100).map((r) => ({ ...r, price_currency: code })), RATES, NOW);
      expect(deals, code).toHaveLength(1);
      expect(deals[0]?.priceCurrency, code).toBe(code); // reported as stored
      expect(stats.skippedNoRate, code).toBe(0);
    }
  });

  it("does not let a currency name, or an inherited rate, reach into the prototype", () => {
    const tricky = detectDeals([row({ price_currency: "constructor" }), row({ price_currency: "toString" })], RATES, NOW);
    expect(tricky.stats).toMatchObject({ skippedNoRate: 2, missingCurrencies: ["CONSTRUCTOR", "TOSTRING"] });
    // a rate table that only inherits USD (Object.create) has no rate of its own for it
    const inherited = Object.create({ USD: 4 }) as Record<string, number>;
    expect(detectDeals([row()], inherited, NOW).stats).toMatchObject({ skippedNoRate: 1, missingCurrencies: ["USD"] });
  });

  it("skips a fare whose amount times its rate overflows", () => {
    // 1e308 * 4 is Infinity: the amount alone is a fine number
    const { deals, stats } = detectDeals([row({ price_amount: 1e308 })], RATES, NOW);
    expect(deals).toEqual([]);
    expect(stats).toMatchObject({ skippedInvalid: 1, buckets: 0 });
  });

  it("converts ILS rows one to one even when the table has no ILS entry", () => {
    const rows = [
      ...BASE14.map((ils, i) => row({ price_amount: ils, price_currency: "ILS", checked_at: ago(26 + 24 * (13 - i)) })),
      row({ price_amount: 400, price_currency: "ILS", checked_at: ago(2) }),
    ];
    const { deals } = detectDeals(rows, {}, NOW);
    expect(deals[0]).toMatchObject({ verdict: "error_fare", priceAmount: 400, priceCurrency: "ILS", priceIls: 400, dropPct: 60 });
  });

  it("converts every currency at the one supplied table before comparing", () => {
    // history alternates USD (rate 4) and EUR (rate 5) with the same ILS values as BASE14: 250 USD = 200 EUR = 1000 ILS
    const mixed = BASE14.map((ils, i) =>
      i % 2 === 0
        ? row({ price_amount: ils / 4, price_currency: "USD", checked_at: ago(26 + 24 * (13 - i)) })
        : row({ price_amount: ils / 5, price_currency: "EUR", checked_at: ago(26 + 24 * (13 - i)) }),
    );
    const { deals } = detectDeals([...mixed, row({ price_amount: 100, price_currency: "USD", checked_at: ago(2) })], RATES, NOW);
    expect(deals[0]).toMatchObject({ verdict: "error_fare", priceIls: 400, evidence: { baselineIls: 1000, madIls: 74.13, sampleSize: 14 } });
  });
});

describe("detectDeals: staleness and clock", () => {
  it("does not report a candidate older than 48 hours as a live deal", () => {
    const at49 = detectDeals(bucketRows(100, {}, 49), RATES, NOW);
    expect(at49.deals).toEqual([]);
    expect(at49.stats).toMatchObject({ buckets: 1, staleBuckets: 1 });
  });

  it("keeps a candidate of exactly 48 hours live, and drops one a minute older", () => {
    expect(detectDeals(bucketRows(100, {}, 48), RATES, NOW).deals).toHaveLength(1);
    expect(detectDeals(bucketRows(100, {}, 48 + 1 / 60), RATES, NOW).stats.staleBuckets).toBe(1);
  });

  it("drops only the stale bucket and still reports the live one", () => {
    const rows = [...bucketRows(100, { destination: "ATH" }, 72), ...bucketRows(100, { destination: "FCO" }, 3)];
    const { deals, stats } = detectDeals(rows, RATES, NOW);
    expect(deals.map((d) => d.destination)).toEqual(["FCO"]);
    expect(stats).toMatchObject({ buckets: 2, staleBuckets: 1 });
  });

  it("uses the caller's 48 hour window (liveWithinHours) and its `now`", () => {
    expect(detectDeals(bucketRows(100, {}, 49), RATES, NOW, { liveWithinHours: 72 }).deals).toHaveLength(1);
    // as of a moment 30 hours later the same 2-hour-old candidate is 32 hours old: still live; 60 hours later it is stale
    expect(detectDeals(bucketRows(100), RATES, new Date(NOW.getTime() + 30 * HOUR)).deals).toHaveLength(1);
    expect(detectDeals(bucketRows(100), RATES, new Date(NOW.getTime() + 60 * HOUR)).deals).toEqual([]);
  });

  it("ignores rows stamped after now (counted, and never the candidate)", () => {
    const future = row({ price_amount: 10, checked_at: ago(-1) }); // one hour from now
    const { deals, stats } = detectDeals([...bucketRows(250), future], RATES, NOW);
    expect(deals).toEqual([]);
    expect(stats).toMatchObject({ skippedFuture: 1, buckets: 1 });
  });

  it("keeps a run stamped a moment after `now` (a slow upstream, clock skew, a `now` read before the scan)", () => {
    const atOffset = (ms: number) => bucketRows(100).map((r, i, all) => (i === all.length - 1 ? { ...r, checked_at: new Date(NOW.getTime() + ms).toISOString() } : r));
    for (const ms of [0, 1, 1000, 5 * 60_000]) { // up to and including the 5 minute tolerance
      const { deals, stats } = detectDeals(atOffset(ms), RATES, NOW);
      expect(deals, `+${ms} ms`).toHaveLength(1);
      expect(stats.skippedFuture, `+${ms} ms`).toBe(0);
    }
    for (const ms of [5 * 60_000 + 1, 10 * 60_000]) {
      const { deals, stats } = detectDeals(atOffset(ms), RATES, NOW);
      expect(deals, `+${ms} ms`).toEqual([]); // the newest usable run is the ordinary one of 26 hours ago
      expect(stats.skippedFuture, `+${ms} ms`).toBe(1);
    }
  });

  it("does not let a normal fare stamped a second after `now` give way to an older deal", () => {
    // the deal was 30 hours ago, the newest run (a second ahead of the caller's clock) is an ordinary 250 USD
    const rows = [...bucketRows(100, {}, 30), row({ price_amount: 250, checked_at: new Date(NOW.getTime() + 1000).toISOString() })];
    const { deals, stats } = detectDeals(rows, RATES, NOW);
    expect(deals).toEqual([]);
    expect(stats.skippedFuture).toBe(0);
  });

  it("takes the future tolerance from the config (0 restores the strict rule) and never lets it go negative", () => {
    const plusOneSecond = bucketRows(100).map((r, i, all) => (i === all.length - 1 ? { ...r, checked_at: new Date(NOW.getTime() + 1000).toISOString() } : r));
    expect(detectDeals(plusOneSecond, RATES, NOW, { futureToleranceMinutes: 0 }).stats.skippedFuture).toBe(1);
    expect(detectDeals(plusOneSecond, RATES, NOW, { futureToleranceMinutes: -5 }).stats.skippedFuture).toBe(1);
    expect(detectDeals(plusOneSecond, RATES, NOW, { futureToleranceMinutes: 1 }).deals).toHaveLength(1);
    // a negative tolerance is 0, not "reject rows from the past too": a run one minute BEFORE now is fine
    const minuteAgo = bucketRows(100).map((r, i, all) => (i === all.length - 1 ? { ...r, checked_at: new Date(NOW.getTime() - 60_000).toISOString() } : r));
    expect(detectDeals(minuteAgo, RATES, NOW, { futureToleranceMinutes: -5 })).toMatchObject({ stats: { skippedFuture: 0 }, deals: [{ verdict: "error_fare" }] });
  });

  it("throws on an invalid `now` rather than reporting everything as stale", () => {
    expect(() => detectDeals(bucketRows(100), RATES, new Date("nope"))).toThrow(RangeError);
  });
});

describe("detectDeals: bad rows", () => {
  it("skips and counts rows it cannot use, and still judges the rest", () => {
    const bad = [
      row({ price_amount: 0 }), row({ price_amount: -5 }), row({ price_amount: Number.NaN }),
      row({ depart_date: "2026-13-40" }), row({ return_date: "2026-11-01" }), row({ checked_at: "yesterday" }),
      row({ checked_at: "2026-09-29 10:00:00" }), // a space instead of the T
      // no zone: refused rather than read in local time (which would move these by the host's UTC offset, and past `now` in some zones)
      row({ checked_at: "2026-09-29T10:00:00" }), row({ checked_at: "2026-09-29T10:00:00.000" }), row({ checked_at: "2026-09-29T10:00" }),
    ];
    const { deals, stats } = detectDeals([...bucketRows(100), ...bad], RATES, NOW);
    expect(deals).toHaveLength(1);
    expect(stats).toMatchObject({ rows: 25, skippedInvalid: 10, buckets: 1 });
  });

  it("counts a row that is not a row at all (null, undefined, a primitive) instead of throwing", () => {
    const junk = [null, undefined, 5, "x", {}, []] as unknown as DealPriceRow[];
    const { deals, stats } = detectDeals([...junk, ...bucketRows(100)], RATES, NOW);
    expect(deals).toHaveLength(1); // the valid rows are still judged
    expect(stats).toMatchObject({ rows: 21, skippedInvalid: 6, buckets: 1 });
  });

  it("skips a row whose text fields or price are not what the type says, without throwing", () => {
    const notText = [null, undefined, 5, {}];
    for (const field of ["price_currency", "origin", "destination", "ticket_structure"]) {
      for (const value of notText) {
        const { stats } = detectDeals([row({ [field]: value } as unknown as Partial<DealPriceRow>)], RATES, NOW);
        expect(stats, `${field} = ${String(value)}`).toMatchObject({ skippedInvalid: 1, buckets: 0 });
      }
    }
    for (const value of [null, undefined, {}, Number.NaN, "250"]) { // a number in a string, or a string in a number, is not a price
      const { stats } = detectDeals([row({ price_amount: value as unknown as number })], RATES, NOW);
      expect(stats, `price_amount = ${String(value)}`).toMatchObject({ skippedInvalid: 1, buckets: 0 });
    }
  });

  it("rounds the reported ILS price to the agora, from the exact converted amount", () => {
    // 33.333 USD * 4 = 133.332 ILS
    expect(detectDeals(bucketRows(33.333), RATES, NOW).deals[0]?.priceIls).toBe(133.33);
  });

  it("tolerates a missing or malformed airlines list", () => {
    expect(detectDeals(bucketRows(100, { airlines_json: "not json" }), RATES, NOW).deals[0]?.airlines).toEqual([]);
    expect(detectDeals(bucketRows(100, { airlines_json: '{"a":1}' }), RATES, NOW).deals[0]?.airlines).toEqual([]);
    expect(detectDeals(bucketRows(100, { airlines_json: '["A3",7,null,"LY"]' }), RATES, NOW).deals[0]?.airlines).toEqual(["A3", "LY"]);
  });
});

describe("detectDeals: determinism", () => {
  const rows = [
    ...bucketRows(100, { destination: "ATH" }),
    ...bucketRows(162.5, { destination: "FCO" }),
    ...bucketRows(175, { destination: "CDG" }),
    ...bucketRows(250, { destination: "LHR" }),
    row({ price_amount: 10, price_currency: "GBP" }),
  ];

  it("gives the same report for the same input, whatever the row order, without touching the input", () => {
    const frozen = Object.freeze(rows.map((r) => Object.freeze(r)));
    const expected = JSON.stringify(detectDeals(frozen, RATES, NOW));
    expect(JSON.stringify(detectDeals(frozen, RATES, NOW))).toBe(expected);
    const rand = mulberry32(99);
    for (let i = 0; i < 10; i++) expect(JSON.stringify(detectDeals(shuffled(rows, rand), RATES, NOW))).toBe(expected);
  });

  it("breaks ties between equally cheap fares of one run by a fixed order, not by input order", () => {
    const a = row({ depart_date: "2026-11-12", return_date: "2026-11-19", price_amount: 100, checked_at: ago(1) });
    const b = row({ depart_date: "2026-11-10", return_date: "2026-11-17", price_amount: 100, checked_at: ago(1) });
    const history = bucketRows(250).slice(0, 14);
    expect(detectDeals([...history, a, b], RATES, NOW).deals[0]?.departDate).toBe("2026-11-10");
    expect(detectDeals([...history, b, a], RATES, NOW).deals[0]?.departDate).toBe("2026-11-10");
  });

  it("breaks the rest of the ties between equally cheap fares of one run (source, airlines, currency) by a fixed order", () => {
    const history = bucketRows(250).slice(0, 14);
    const tied = (over: Partial<DealPriceRow> = {}) => row({ price_amount: 100, checked_at: ago(1), ...over });
    const pick = (x: DealPriceRow, y: DealPriceRow) => [detectDeals([...history, x, y], RATES, NOW).deals[0], detectDeals([...history, y, x], RATES, NOW).deals[0]];
    for (const d of pick(tied({ source: "zzz" }), tied({ source: "aaa" }))) expect(d?.source).toBe("aaa");
    for (const d of pick(tied({ airlines_json: '["LY"]' }), tied({ airlines_json: '["A3"]' }))) expect(d?.airlines).toEqual(["A3"]);
    // 200 AAA * 2 and 50 ZZZ * 8 are both 400 ILS, on the same dates from the same source: the currency code decides (AAA), not the smaller amount
    const rates = { ...RATES, AAA: 2, ZZZ: 8 };
    const pickPair = (x: DealPriceRow, y: DealPriceRow) => [detectDeals([...history, x, y], rates, NOW).deals[0], detectDeals([...history, y, x], rates, NOW).deals[0]];
    for (const d of pickPair(tied({ price_amount: 50, price_currency: "ZZZ" }), tied({ price_amount: 200, price_currency: "AAA" }))) expect(d?.priceCurrency).toBe("AAA");
  });

  it("orders deals of equal strength cheaper first, then by bucket, whatever the input order", () => {
    const names = (rows: DealPriceRow[]) => detectDeals(rows, RATES, NOW).deals.map((d) => d.destination);
    // ATH and FCO: the same history and candidate, so the same dropPct and the same priceIls: only the bucket is left
    const ath = bucketRows(100, { destination: "ATH" });
    const fco = bucketRows(100, { destination: "FCO" });
    expect(names([...fco, ...ath])).toEqual(["ATH", "FCO"]);
    expect(names([...ath, ...fco])).toEqual(["ATH", "FCO"]);
    // AAA at twice the prices (candidate 800 ILS, history median 2000) is also 60% down but dearer: ZZZ comes first though its name is later
    const scaled = (rows: DealPriceRow[], k: number) => rows.map((r) => ({ ...r, price_amount: r.price_amount * k }));
    const aaa = scaled(bucketRows(100, { destination: "AAA" }), 2);
    const zzz = bucketRows(100, { destination: "ZZZ" });
    expect(names([...aaa, ...zzz])).toEqual(["ZZZ", "AAA"]);
    expect(names([...zzz, ...aaa])).toEqual(["ZZZ", "AAA"]);
    expect(detectDeals([...aaa, ...zzz], RATES, NOW).deals.map((d) => [d.dropPct, d.priceIls])).toEqual([[60, 400], [60, 800]]);
  });
});

// --- properties ---------------------------------------------------------------------------------------

describe("seeded properties (1000 trials each)", () => {
  const TRIALS = 1000;
  const SIGMAS = [0.02, 0.05, 0.08, 0.1, 0.15, 0.2];

  /** A stable route: `base` ILS with normal noise of relative size `sigma`, two checks a day, candidate at the end. */
  function trial(rand: () => number, sigma: number, candidate?: (base: number) => number) {
    const base = 500 + Math.floor(rand() * 2000);
    const n = 15 + Math.floor(rand() * 16); // 15 to 30 snapshots: at least 7 days at two a day
    const noisy = () => base * (1 + sigma * gaussian(rand));
    const history = Array.from({ length: n }, (_, i) => snap(noisy(), i * 0.5));
    const price = candidate ? candidate(base) : noisy();
    return { base, history, candidate: snap(price, n * 0.5) };
  }

  it("normal noise around a stable price is not flagged in at least 99% of trials", () => {
    const rand = mulberry32(20260929);
    let flagged = 0;
    let normal = 0;
    for (let i = 0; i < TRIALS; i++) {
      const t = trial(rand, SIGMAS[i % SIGMAS.length] as number);
      const verdict = assessPrice(t.history, t.candidate).verdict;
      if (verdict === "deal" || verdict === "error_fare") flagged++;
      if (verdict === "normal") normal++;
    }
    expect(normal + flagged).toBe(TRIALS); // every trial had enough evidence to be judged
    expect(flagged / TRIALS).toBeLessThanOrEqual(0.01);
  });

  it("is not vacuous: a fare 55% to 75% below a stable price is flagged in at least 99% of trials", () => {
    const rand = mulberry32(424242);
    let flagged = 0;
    for (let i = 0; i < TRIALS; i++) {
      const t = trial(rand, [0.02, 0.04, 0.06][i % 3] as number, (base) => base * (1 - (0.55 + 0.2 * rand())));
      const verdict = assessPrice(t.history, t.candidate).verdict;
      if (verdict === "deal" || verdict === "error_fare") flagged++;
    }
    expect(flagged / TRIALS).toBeGreaterThanOrEqual(0.99);
  });

  /** A route that climbs or falls by `perDay` (a fraction of `base`) a day for 30 days, 3% noise, one check a day, the candidate on day 30. */
  function trending(rand: () => number, perDay: number, candidate: (level: number) => number) {
    const base = 500 + Math.floor(rand() * 2000);
    const level = (day: number) => base * (1 + perDay * day);
    const history = Array.from({ length: 30 }, (_, i) => snap(level(i) * (1 + 0.03 * gaussian(rand)), i));
    return { history, candidate: snap(candidate(level(30)), 30) };
  }
  const flags = (history: PriceSnapshot[], candidate: PriceSnapshot, config = {}) => {
    const verdict = assessPrice(history, candidate, config).verdict;
    return verdict === "deal" || verdict === "error_fare";
  };

  it("a fare on a rising or a falling trend is not flagged in at least 99% of trials", () => {
    const rand = mulberry32(5150);
    let flagged = 0;
    for (let i = 0; i < TRIALS; i++) {
      const t = trending(rand, i % 2 === 0 ? 0.01 : -0.02, (level) => level * (1 + 0.03 * gaussian(rand)));
      if (flags(t.history, t.candidate)) flagged++;
    }
    expect(flagged / TRIALS).toBeLessThanOrEqual(0.01);
  });

  it("a fare 35% under a rising trend is flagged in at least 85% of trials, where the flat median flags at most 5%", () => {
    // the climb counts as noise for a flat median: it inflates the MAD and the median lags the current level
    const rand = mulberry32(8675309);
    let followed = 0;
    let flat = 0;
    for (let i = 0; i < TRIALS; i++) {
      const t = trending(rand, 0.01, (level) => level * 0.65);
      if (flags(t.history, t.candidate)) followed++;
      if (flags(t.history, t.candidate, { minTrendPct: 1e9 })) flat++;
    }
    expect(followed / TRIALS).toBeGreaterThanOrEqual(0.85);
    expect(flat / TRIALS).toBeLessThanOrEqual(0.05);
  });

  it("a common currency factor cannot change a verdict (the rates scale every price alike)", () => {
    const rand = mulberry32(31337);
    for (let i = 0; i < 200; i++) {
      const t = trial(rand, SIGMAS[i % SIGMAS.length] as number, (base) => base * (0.3 + 0.7 * rand()));
      const scaled = assessPrice(
        t.history.map((s) => ({ ...s, priceIls: s.priceIls * 3.7 })),
        { ...t.candidate, priceIls: t.candidate.priceIls * 3.7 },
      );
      const plain = assessPrice(t.history, t.candidate);
      expect(scaled.verdict).toBe(plain.verdict);
      expect(scaled.dropPct).toBeCloseTo(plain.dropPct as number, 6);
      expect(scaled.robustZ).toBeCloseTo(plain.robustZ as number, 1);
    }
  });
});
