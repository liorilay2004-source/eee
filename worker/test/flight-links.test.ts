import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as entry from "../src/index";
import type { Env, FlightLinkResponse, FlightLinksResponse } from "../src/types";
import { createTestD1 } from "./helpers/d1";

const worker = entry.default;
const BASE = "https://api.example.test";
const IP = "203.0.113.44";
const NOW = new Date("2026-10-01T09:00:00.000Z");

function makeEnv(over: Partial<Env> = {}): Env {
  return { DB: createTestD1(), TRAVELPAYOUTS_TOKEN: "tp-token-0123456789", TRAVELPAYOUTS_MARKER: "12345", ...over };
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", IP);
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const res = await worker.fetch(new Request(`${BASE}${path}`, { ...init, headers }), env, ctx);
  await Promise.all(pending);
  return res;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no outbound calls for pasted flight links"); }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("flight links", () => {
  it("saves a sanitized pasted link, detects its source and remembers when it was checked", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/flight-links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://www.lufthansa.com/il/en/flight-search?route=TLVFRA&departure=20270601&return=20270622&sessionToken=secret&email=a@example.com#private",
        search: { origin: "TLV", destination: "FRA", windowStart: "2027-06-01", windowEnd: "2027-06-22" },
      }),
    });
    const body = (await res.json()) as FlightLinkResponse;
    expect(res.status).toBe(201);
    expect(body.saved.sourceName).toBe("Lufthansa");
    expect(body.saved.origin).toBe("TLV");
    expect(body.saved.destination).toBe("FRA");
    expect(body.saved.departDate).toBe("2027-06-01");
    expect(body.saved.returnDate).toBe("2027-06-22");
    expect(body.saved.airlineIata).toBe("LH");
    expect(body.saved.airlineIcao).toBe("DLH");
    expect(body.saved.airlineName).toBe("Lufthansa");
    expect(body.saved.checkedAt).toBe(NOW.toISOString());
    expect(body.saved.url).not.toContain("sessionToken");
    expect(body.saved.url).not.toContain("email");
    expect(body.saved.url).not.toContain("#private");

    const rows = await env.DB.prepare("SELECT host, source_name, url, airline_iata, airline_name, checked_at FROM flight_links").all<{ host: string; source_name: string; url: string; checked_at: string }>();
    expect(rows.results).toEqual([{ host: "lufthansa.com", source_name: "Lufthansa", url: body.saved.url, airline_iata: "LH", airline_name: "Lufthansa", checked_at: NOW.toISOString() }]);
  });

  it("returns only the same client recent links", async () => {
    const env = makeEnv();
    await call(env, "/api/flight-links", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://www.elal.com/flights/TLV-ATH/2027-06-01" }) });
    const mine = await call(env, "/api/flight-links", { method: "GET" });
    expect(((await mine.json()) as FlightLinksResponse).links).toHaveLength(1);

    const other = await worker.fetch(new Request(`${BASE}/api/flight-links`, { headers: { "CF-Connecting-IP": "203.0.113.99" } }), env, { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext);
    expect(((await other.json()) as FlightLinksResponse).links).toHaveLength(0);
  });

  it("rejects non-web and malformed links", async () => {
    const env = makeEnv();
    for (const url of ["not a url", "javascript:alert(1)"]) {
      const res = await call(env, "/api/flight-links", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
      expect(res.status).toBe(400);
    }
  });
});
