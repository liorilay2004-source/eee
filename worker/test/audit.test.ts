/** match_audit (audit.ts): one PII-free line, a fixed shape, never throws, costs nothing. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_SAMPLE, buildAuditLine, logMatchAudit, type MatchAudit } from "../src/audit";

function audit(over: Partial<MatchAudit> = {}): MatchAudit {
  return {
    origin: "TLV",
    destination: "BCN",
    fromCache: false,
    staleAgeH: null,
    expiredDropped: 0,
    guardSuspicious: 0,
    guardExcluded: 0,
    liveSources: ["travelpayouts"],
    quotesTotal: 0,
    quotesDisbelieved: 0,
    topCard: { kind: "cheapest", source: "travelpayouts", ageH: 1.2, liveVsCachedPct: null },
    cardKinds: ["cheapest", "best_value"],
    upstreamCalls: 6,
    ...over,
  };
}

/** Runs logMatchAudit with console.log spied and returns the logged strings. */
function logged(a: MatchAudit, rand?: () => number): string[] {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    if (rand) logMatchAudit(a, rand);
    else logMatchAudit(a);
    return spy.mock.calls.map((c) => String(c[0]));
  } finally {
    spy.mockRestore();
  }
}
const lineOf = (a: MatchAudit) => JSON.parse(logged(a, () => 0)[0] ?? "null") as Record<string, unknown> & { topCard: Record<string, unknown> | null };

afterEach(() => vi.restoreAllMocks());

describe("match_audit line shape", () => {
  it("logs exactly one line with the fixed keys", () => {
    const out = logged(audit(), () => 0);
    expect(out).toHaveLength(1);
    const line = JSON.parse(out[0]!) as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual([
      "cardKinds",
      "ev",
      "expiredDropped",
      "fromCache",
      "guardExcluded",
      "guardSuspicious",
      "liveSources",
      "quotesDisbelieved",
      "quotesTotal",
      "route",
      "staleAgeH",
      "topCard",
      "upstreamCalls",
      "v",
    ]);
    expect(Object.keys(line.topCard as object).sort()).toEqual(["ageH", "kind", "liveVsCachedPct", "source"]);
    expect(line.ev).toBe("match_audit");
    expect(line.v).toBe(1);
    // The fixed key order of the spec, not just the set.
    expect(Object.keys(buildAuditLine(audit()))).toEqual([
      "ev", "v", "route", "fromCache", "staleAgeH", "expiredDropped", "guardSuspicious", "guardExcluded",
      "liveSources", "quotesTotal", "quotesDisbelieved", "topCard", "cardKinds", "upstreamCalls",
    ]);
  });

  it("carries none of the extra properties a caller's object may hold", () => {
    const extra = { q: "יש לי 5 ימים בנובמבר", ip: "1.2.3.4", deeplink: "https://x?marker=123", departDate: "2026-11-12", ua: "Mozilla" };
    const input = { ...audit(), ...extra } as unknown as MatchAudit;
    const [s] = logged(input, () => 0);
    expect(s).toBeDefined();
    for (const [k, v] of Object.entries(extra)) {
      expect(s).not.toContain(`"${k}"`);
      expect(s).not.toContain(v);
    }
    expect(s).not.toContain("marker");
    expect(s).not.toContain("2026-11-12");
  });

  it("route: valid IATA codes only, anything else is 'invalid' and the raw value is absent", () => {
    expect(lineOf(audit()).route).toBe("TLV-BCN");
    for (const bad of ["ברצלונה", "bcn", "BCNX", "BC", "<script>"]) {
      const s = logged(audit({ destination: bad }), () => 0)[0]!;
      expect(JSON.parse(s).route, bad).toBe("invalid");
      expect(s, bad).not.toContain(bad);
      const s2 = logged(audit({ origin: bad }), () => 0)[0]!;
      expect(JSON.parse(s2).route, bad).toBe("invalid");
      expect(s2, bad).not.toContain(bad);
    }
  });

  it("numbers: non-finite counts are 0 and non-finite hours null; rounding; no negative counts; never NaN or Infinity", () => {
    const line = lineOf(
      audit({
        expiredDropped: Number.NaN,
        guardSuspicious: Number.POSITIVE_INFINITY,
        guardExcluded: -3,
        quotesTotal: 2.7,
        quotesDisbelieved: Number.NEGATIVE_INFINITY,
        upstreamCalls: -0.4,
        staleAgeH: 12.3456,
        topCard: { kind: "cheapest", source: "travelpayouts", ageH: Number.NaN, liveVsCachedPct: Number.POSITIVE_INFINITY },
      }),
    );
    expect(line).toMatchObject({ expiredDropped: 0, guardSuspicious: 0, guardExcluded: 0, quotesTotal: 3, quotesDisbelieved: 0, upstreamCalls: 0, staleAgeH: 12.3 });
    expect(line.topCard).toMatchObject({ ageH: null, liveVsCachedPct: null });
    const s = logged(audit({ staleAgeH: Number.POSITIVE_INFINITY, expiredDropped: Number.NaN }), () => 0)[0]!;
    expect(JSON.parse(s).staleAgeH).toBeNull();
    for (const t of [s, JSON.stringify(line)]) {
      expect(t).not.toContain("NaN");
      expect(t).not.toContain("Infinity");
    }
  });

  it("liveVsCachedPct: a negative gap passes through (one decimal), non-finite is null", () => {
    expect(lineOf(audit({ topCard: { kind: "cheapest", source: "serpapi", ageH: 0, liveVsCachedPct: -12.7 } })).topCard?.liveVsCachedPct).toBe(-12.7);
    expect(lineOf(audit({ topCard: { kind: "cheapest", source: "serpapi", ageH: 0, liveVsCachedPct: -12.74 } })).topCard?.liveVsCachedPct).toBe(-12.7);
    expect(lineOf(audit({ topCard: { kind: "cheapest", source: "serpapi", ageH: 0, liveVsCachedPct: Number.NaN } })).topCard?.liveVsCachedPct).toBeNull();
  });

  it("names: unknown sources and kinds are dropped, lists are deduped and capped at 16", () => {
    const line = lineOf(
      audit({
        liveSources: ["travelpayouts", "evil", "serp api", "סרפ", "serpapi", "serpapi", "google_flights"],
        cardKinds: ["cheapest", "cheapest", "best value", "הכי זול", "my_times", "bogus"],
      }),
    );
    expect(line.liveSources).toEqual(["travelpayouts", "serpapi", "google_flights"]);
    expect(line.cardKinds).toEqual(["cheapest", "my_times"]);
    expect(lineOf(audit({ topCard: { kind: "best_value", source: "nope", ageH: 1, liveVsCachedPct: null } })).topCard).toEqual({
      kind: "best_value",
      source: null,
      ageH: 1,
      liveVsCachedPct: null,
    });
    expect(lineOf(audit({ topCard: { kind: "הכי זול", source: "travelpayouts", ageH: 1, liveVsCachedPct: null } })).topCard).toBeNull();
    // 120 entries (20 copies of each known name): deduped, so far below the cap of 16.
    const many = Array.from({ length: 20 }, () => ["travelpayouts", "google_flights", "ignav", "wego", "searchapi", "serpapi"]).flat();
    const capped = buildAuditLine(audit({ liveSources: many, cardKinds: Array.from({ length: 40 }, (_, i) => `k${i}`) }));
    expect(capped.liveSources).toEqual(["travelpayouts", "google_flights", "ignav", "wego", "searchapi", "serpapi"]);
    expect(capped.cardKinds).toEqual([]);
  });

  it("sampling: AUDIT_SAMPLE is 1, rand 0.999 logs once, rand 1 logs nothing", () => {
    expect(AUDIT_SAMPLE).toBe(1);
    expect(logged(audit(), () => 0.999)).toHaveLength(1);
    expect(logged(audit(), () => 1)).toHaveLength(0);
    expect(logged(audit())).toHaveLength(1); // the default Math.random is always below 1
  });

  it("never throws: not when console.log throws, not on an input whose getter throws", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("log sink down");
    });
    expect(() => logMatchAudit(audit(), () => 0)).not.toThrow();
    spy.mockRestore();
    const hostile = audit();
    Object.defineProperty(hostile, "origin", {
      get() {
        throw new Error("boom");
      },
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(() => logMatchAudit(hostile, () => 0)).not.toThrow();
    expect(out).not.toHaveBeenCalled();
    expect(() => logMatchAudit(audit(), () => {
      throw new Error("rand");
    })).not.toThrow();
  });

  it("makes no request and is cheap: 10,000 calls in under a second", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const a = audit();
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) logMatchAudit(a);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out).toHaveBeenCalledTimes(10_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
