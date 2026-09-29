import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRepo } from "../src/db";
import { defaultResolver } from "../src/pipeline";
import { buildSnapshotRequest, pickSnapshotRoute, runSnapshot, SNAPSHOT_ROUTES } from "../src/snapshots";
import { TravelpayoutsError } from "../src/travelpayouts";
import type { FxRates, TravelpayoutsClient } from "../src/types";
import { parseSearchBody } from "../src/validate";
import { createTestD1 } from "./helpers/d1";

const FX: FxRates = { date: "2026-11-01", source: "test", ratesToIls: { ILS: 1, USD: 3 } };
const NOW = new Date("2026-11-01T10:43:00Z");

const emptyTp = (configured = true, fail = false): TravelpayoutsClient => ({
  configured,
  callCount: () => 0,
  async roundTrips() {
    if (fail) throw new TravelpayoutsError("HTTP 500: boom", 500);
    return [];
  },
  async oneWays() {
    return [];
  },
});

describe("price snapshots", () => {
  it("visits every watchlist route once per cycle, hour by hour", () => {
    const seen = new Set<string>();
    for (let h = 0; h < SNAPSHOT_ROUTES.length; h++) {
      const [o, d] = pickSnapshotRoute(new Date(NOW.getTime() + h * 3_600_000));
      seen.add(`${o}-${d}`);
    }
    expect(seen.size).toBe(SNAPSHOT_ROUTES.length);
  });

  it("the same hour always picks the same route", () => {
    expect(pickSnapshotRoute(new Date("2026-11-01T10:05:00Z"))).toEqual(pickSnapshotRoute(new Date("2026-11-01T10:55:00Z")));
  });

  it("the watchlist has no duplicates and every code is known to the resolver", () => {
    expect(new Set(SNAPSHOT_ROUTES.map((r) => r.join("-"))).size).toBe(SNAPSHOT_ROUTES.length);
    for (const [o, d] of SNAPSHOT_ROUTES) {
      expect(defaultResolver.airportsForCode(o).length, o).toBeGreaterThan(0);
      expect(defaultResolver.airportsForCode(d).length, d).toBeGreaterThan(0);
    }
  });

  it("the snapshot request passes the same validation as a user search", () => {
    const req = buildSnapshotRequest("TLV", "BCN", NOW);
    const parsed = parseSearchBody(
      { origin: req.origin, destination: req.destination, windowStart: req.windowStart, windowEnd: req.windowEnd, stayMin: req.stayMin, stayMax: req.stayMax },
      { resolver: defaultResolver, now: NOW },
    );
    expect(parsed.ok).toBe(true);
    expect(req.windowStart > "2026-11-01").toBe(true);
  });

  it("does nothing without a Travelpayouts token", async () => {
    const res = await runSnapshot({ repo: createRepo(createTestD1()), tp: emptyTp(false), fx: FX, now: NOW });
    expect(res.ok).toBe(false);
  });

  it("a failing source is reported, not thrown", async () => {
    const res = await runSnapshot({ repo: createRepo(createTestD1()), tp: emptyTp(true, true), fx: FX, now: NOW });
    expect(res.ok).toBe(false);
  });

  it("a healthy source with no fares is an ok run with no cards", async () => {
    const res = await runSnapshot({ repo: createRepo(createTestD1()), tp: emptyTp(), fx: FX, now: NOW });
    expect(res).toMatchObject({ ok: true, cards: 0 });
  });

  it("wrangler.toml schedules the hourly snapshot cron the handler listens for", () => {
    const toml = readFileSync(join(__dirname, "..", "wrangler.toml"), "utf8");
    const index = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");
    const cron = /const SNAPSHOT_CRON = "([^"]+)"/.exec(index)?.[1];
    expect(cron).toBeTruthy();
    expect(toml).toContain(`"${cron}"`);
  });
});
