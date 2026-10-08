import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const BASE = "https://api.example.test";
const ORIGIN = "https://app.example.test";
const NOW = new Date("2026-10-08T09:00:00.000Z");
const FARE = { host: "www.lufthansa.com", origin: "TLV", destination: "FRA", departDate: "2027-06-01", returnDate: "2027-06-08", priceAmount: 489.9, currency: "EUR" };

function env(): Env { return { DB: createTestD1(), ALLOWED_ORIGIN: ORIGIN, RATE_LIMIT_SALT: "test-salt" }; }

async function call(e: Env, path: string, init: RequestInit = {}, ip = "203.0.113.7") {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", ip);
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  return worker.fetch(new Request(`${BASE}${path}`, { ...init, headers }), e, ctx);
}

const post = (e: Env, body: unknown, ip?: string) => call(e, "/api/community-fares", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify(body),
}, ip);

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("user-shared airline fare observations", () => {
  it("stores a validated observation separately and labels it unverified", async () => {
    const e = env();
    const res = await post(e, { ...FARE, pageUrl: "https://www.lufthansa.com/?sessionToken=must-not-store", pageText: "private text" });
    expect(res.status).toBe(201);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const body = await res.json() as { observation: Record<string, unknown> };
    expect(body.observation).toMatchObject({ ...FARE, observedAt: NOW.toISOString(), verification: "unverified", link: "https://www.lufthansa.com/" });
    expect(body.observation).not.toHaveProperty("pageUrl");
    expect(body.observation).not.toHaveProperty("pageText");
    const rows = await e.DB.prepare("SELECT client_hash, host, origin, destination, depart_date, return_date, price_amount, currency, observed_at FROM community_fares").all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).not.toHaveProperty("pageUrl");
    expect(rows.results[0]?.client_hash).not.toBe("203.0.113.7");
  });

  it("returns only fresh exact-route departures and requested stay lengths, cheapest first", async () => {
    const e = env();
    await post(e, FARE, "203.0.113.1");
    await post(e, { ...FARE, priceAmount: 450, departDate: "2027-06-03", returnDate: "2027-06-10" }, "203.0.113.2");
    await post(e, { ...FARE, origin: "ATH", priceAmount: 300 }, "203.0.113.3");
    const res = await call(e, "/api/community-fares?origin=TLV&destination=FRA&windowStart=2027-06-01&windowEnd=2027-06-10&stayMin=7&stayMax=7", { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
    const body = await res.json() as { fares: Record<string, unknown>[]; noticeHe: string };
    expect(body.fares).toHaveLength(2);
    expect(body.fares[0]).toMatchObject({ priceAmount: 450, verification: "unverified", observations: 1 });
    expect(body.fares[1]).toMatchObject({ priceAmount: 489.9, verification: "unverified" });
    expect(body.noticeHe).toContain("לא אומתו");
  });

  it("rejects unknown airline domains, invalid route/dates, oversized data and bad media types", async () => {
    const e = env();
    for (const bad of [
      { ...FARE, host: "evil.example" },
      { ...FARE, host: "lufthansa.com.evil.example" },
      { ...FARE, origin: "TLV-FRA" },
      { ...FARE, departDate: "2027-02-30" },
      { ...FARE, returnDate: "2027-06-01" },
      { ...FARE, priceAmount: 0 },
      { ...FARE, currency: "XXX" },
    ]) expect((await post(e, bad, crypto.randomUUID())).status).toBe(400);
    expect((await call(e, "/api/community-fares", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await call(e, "/api/community-fares", { method: "PUT" })).status).toBe(405);
    expect((await call(e, "/api/community-fares?origin=TLV&destination=FRA&windowStart=2027-06-01&windowEnd=2027-12-01&stayMin=1&stayMax=8" )).status).toBe(400);
  });

  it("limits shared writes to one per minute per salted client identity", async () => {
    const e = env();
    expect((await post(e, FARE)).status).toBe(201);
    expect((await post(e, { ...FARE, priceAmount: 470 })).status).toBe(429);
    expect((await post(e, FARE, "203.0.113.8")).status).toBe(201);
  });

  it("applies the seven-day retention during the normal daily prune", async () => {
    const e = env();
    await post(e, FARE);
    await e.DB.prepare("UPDATE community_fares SET observed_at=?").bind(new Date(NOW.getTime() - 8 * 86_400_000).toISOString()).run();
    const res = await (await import("../src/db")).pruneHistory(e.DB, NOW);
    expect(res.community_fares).toBe(1);
    expect((await e.DB.prepare("SELECT * FROM community_fares").all()).results).toHaveLength(0);
  });
});
