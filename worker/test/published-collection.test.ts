import { describe, expect, it, vi } from "vitest";
import { collectPublishedPage, collectPublishedPages } from "../src/published-collection";
import type { Env } from "../src/types";
const now = new Date("2026-10-08T00:00:00Z");
const env = { TAP_PUBLISHED_ENABLED: "true" } as Env;
const fare = { __typename: "Fare", originAirportCode: "TLV", destinationAirportCode: "IBZ", departureDate: "2027-06-24", returnDate: "2027-06-29", totalPrice: 382.78, currencyCode: "USD", travelClass: "ECONOMY", flightType: "ROUND_TRIP" };
const fetcher = (fares: unknown[]) => vi.fn(async () => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ fares })}</script>`)) as unknown as typeof fetch;
describe("background official price collection", () => {
  it("refreshes every enabled source and preserves successful sources when another fails", async () => {
    const fetchFn = vi.fn(async (url: URL | RequestInfo) => String(url).includes("flytap")
      ? new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ fares: [fare] })}</script>`)
      : new Response("", { status: 403 })) as unknown as typeof fetch;
    const results = await collectPublishedPages({ env: { ...env, AIRNZ_PUBLISHED_ENABLED: "true" }, repo: { savePrices: vi.fn() }, now, fetchFn });
    expect(results).toHaveLength(2);
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ source: "tap", ok: true, saved: 1 }), expect.objectContaining({ source: "air_new_zealand", ok: false })]));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("saves every dated destination without needing a user search", async () => {
    const savePrices = vi.fn();
    const cache = { put: vi.fn(), get: vi.fn() };
    const fetchFn = fetcher([fare, { ...fare, destinationAirportCode: "LIS", totalPrice: 300 }]);
    expect(await collectPublishedPage({ env, repo: { savePrices }, now, fetchFn, cache })).toMatchObject({ ok: true, fares: 2, saved: 2 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(savePrices.mock.calls[0]![0]).toHaveLength(2);
    expect(savePrices.mock.calls[0]![0]).toEqual(expect.arrayContaining([expect.objectContaining({ source: "tap", priceAmount: 382.78, priceCurrency: "USD", checkedAt: now.toISOString(), tags: ["published_advertisement"] })]));
    expect(cache.put).toHaveBeenCalledTimes(1);
  });
  it("retains one-way data in cache without inventing a return price", async () => {
    const savePrices = vi.fn(); const cache = { put: vi.fn(), get: vi.fn() };
    const result = await collectPublishedPage({ env, repo: { savePrices }, now, fetchFn: fetcher([{ ...fare, flightType: "ONE_WAY", returnDate: null }]), cache });
    expect(result).toMatchObject({ fares: 1, saved: 0 });
    expect(savePrices).not.toHaveBeenCalled(); expect(cache.put.mock.calls[0]![1]).toHaveLength(1);
  });
  it("does not request disabled sources", async () => {
    const fetchFn = fetcher([fare]); const savePrices = vi.fn();
    expect(await collectPublishedPage({ env: {} as Env, repo: { savePrices }, now, fetchFn })).toMatchObject({ source: null, saved: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("reports upstream and storage failure without throwing into other cron work", async () => {
    expect(await collectPublishedPage({ env, repo: { savePrices: vi.fn() }, now, fetchFn: vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch })).toMatchObject({ ok: false, saved: 0 });
    expect(await collectPublishedPage({ env, repo: { savePrices: vi.fn().mockRejectedValue(new Error("storage")) }, now, fetchFn: fetcher([fare]) })).toMatchObject({ ok: false, saved: 0 });
  });
});
