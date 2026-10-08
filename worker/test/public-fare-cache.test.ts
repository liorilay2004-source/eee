import { describe, expect, it } from "vitest";
import { BACKGROUND_FARE_TTL_MS, createPublicFareCache } from "../src/public-fare-cache";
import { createRyanairDirectSource, parseRyanairCalendar, ryanairCalendarUrl } from "../src/sources/ryanair-direct";
import {EXTERNAL_PUBLISHED_PAGES} from "../src/external-published-catalog";
const now = new Date("2026-10-12T00:00:00Z");
const url = ryanairCalendarUrl("STN", "DUB", "2027-06");
const storage = () => {
  const rows = new Map<string, Response>();
  return { rows, match: async (request: RequestInfo) => rows.get((request as Request).url)?.clone(), put: async (request: RequestInfo, response: Response) => { rows.set((request as Request).url, response.clone()); } };
};
describe("shared public fare data", () => {
  it.each(EXTERNAL_PUBLISHED_PAGES)("expires external $airline snapshots at ten minutes even with background TTL",async page=>{
    const db=storage();const cache=createPublicFareCache(db as unknown as Cache,now,BACKGROUND_FARE_TTL_MS);
    await cache.put(page.sourceUrl,[{amount:42,checkedAt:now.toISOString()}]);
    expect((await cache.get(page.sourceUrl))?.expires).toBe(now.getTime()+600000);
    expect(await createPublicFareCache(db as unknown as Cache,new Date(now.getTime()+600000)).get(page.sourceUrl)).toBeNull();
  });
  it("stores only the verified Austrian public route page",async()=>{
    const db=storage();const cache=createPublicFareCache(db as unknown as Cache,now,BACKGROUND_FARE_TTL_MS);
    const key="https://www.austrian.com/lhg/at/en/o-d/cy-cy/vienna-tel-aviv";
    const fares=[{amount:252,currency:"EUR",checkedAt:now.toISOString()}];
    await cache.put(key,fares);
    expect(await cache.get(key)).toEqual({fares,expires:now.getTime()+BACKGROUND_FARE_TTL_MS});
    await cache.put(`${key}?token=secret`,fares);
    await cache.put(key.replace("vienna-tel-aviv","tel-aviv-vienna"),fares);
    expect(db.rows.size).toBe(1);
  });
  it("stores only the verified Swiss public page and preserves CHF",async()=>{
    const db=storage();const cache=createPublicFareCache(db as unknown as Cache,now,BACKGROUND_FARE_TTL_MS);
    const key="https://www.swiss.com/lhg/ch/en/o-d/cy-cy/zurich-tel-aviv";
    const fares=[{amount:358,currency:"CHF",checkedAt:now.toISOString()}];
    await cache.put(key,fares);
    expect(await cache.get(key)).toEqual({fares,expires:now.getTime()+BACKGROUND_FARE_TTL_MS});
    await cache.put(`${key}?token=secret`,fares);
    await cache.put(key.replace("zurich-tel-aviv","tel-aviv-zurich"),fares);
    expect(db.rows.size).toBe(1);
  });
  it("keeps background advertisements between daily collections without extending live calendar freshness", async () => {
    const db=storage();const writer=createPublicFareCache(db as unknown as Cache,now,BACKGROUND_FARE_TTL_MS);
    const key="https://www.norwegian.com/en/low-fare-calendar/Athens-OsloGardermoen?month=2027-06";
    const fares=[{amount:56.44,checkedAt:now.toISOString()}];
    await writer.put(key,fares);await writer.put(url,fares);
    const reader=createPublicFareCache(db as unknown as Cache,new Date(now.getTime()+12*3600000));
    expect(await reader.get(key)).toEqual({fares,expires:now.getTime()+BACKGROUND_FARE_TTL_MS});
    expect(await reader.get(url)).toBeNull();
    expect(await createPublicFareCache(db as unknown as Cache,new Date(now.getTime()+BACKGROUND_FARE_TTL_MS+1)).get(key)).toBeNull();
    await writer.put(`${key}&api_key=secret`,fares);
    expect(db.rows.size).toBe(2);
  });
  it("preserves timestamps and original expiry across independent cache readers", async () => {
    const db = storage();
    const first = createPublicFareCache(db as unknown as Cache, now);
    const fares = [{ checkedAt: now.toISOString(), amount: 10 }];
    await first.put(url, fares);
    const next = createPublicFareCache(db as unknown as Cache, new Date(now.getTime() + 300_000));
    expect(await next.get(url)).toEqual({ fares, expires: now.getTime() + 600_000 });
    expect(await createPublicFareCache(db as unknown as Cache, new Date(now.getTime() + 600_001)).get(url)).toBeNull();
  });
  it("does not cache credentials, unrelated URLs, malformed or oversized content", async () => {
    const db = storage();
    const cache = createPublicFareCache(db as unknown as Cache, now);
    await cache.put("https://key:secret@services-api.ryanair.com/", []);
    await cache.put("https://serpapi.com/search?api_key=secret", []);
    await cache.put(`${url}&api_key=secret`, []);
    await cache.put(url, Array(501).fill({}));
    expect(db.rows.size).toBe(0);
  });
  it("cache storage failures are optional and fail to a miss", async () => {
    const broken = { match: async () => { throw new Error("unavailable"); }, put: async () => { throw new Error("unavailable"); } };
    const cache = createPublicFareCache(broken as unknown as Cache, now);
    expect(await cache.get(url)).toBeNull();
    await expect(cache.put(url, [])).resolves.toBeUndefined();
  });
  it("shares only the verified airBaltic pages and keeps their original expiry", async () => {
    const db = storage();
    const first = createPublicFareCache(db as unknown as Cache, now);
    const key = "https://www.airbaltic.com/en/flight-deals/flights-from-israel";
    const fares = [{ amount: 298.55, currency: "EUR", checkedAt: now.toISOString() }];
    await first.put(key, fares);
    expect(await createPublicFareCache(db as unknown as Cache, new Date(now.getTime() + 1000)).get(key)).toEqual({ fares, expires: now.getTime() + 600_000 });
    await first.put(`${key}?token=secret`, []);
    await first.put("https://www.airbaltic.com/en/flight-deals/unverified", []);
    expect(db.rows.size).toBe(1);
  });
  it("serves exact-date calendars from shared data with no airline request", async () => {
    const db = storage();
    const shared = createPublicFareCache(db as unknown as Cache, now);
    const row = (day: string) => ({ day, departureDate: `${day}T10:00:00`, arrivalDate: `${day}T11:00:00`, price: { value: 40, currencyCode: "EUR" } });
    await shared.put(url, parseRyanairCalendar({ outbound: { fares: [row("2027-06-01")] } }, "STN", "DUB", "2027-06", now));
    await shared.put(ryanairCalendarUrl("DUB", "STN", "2027-06"), parseRyanairCalendar({ outbound: { fares: [row("2027-06-05")] } }, "DUB", "STN", "2027-06", now));
    const source = createRyanairDirectSource(now, (async () => { throw new Error("must not fetch"); }) as typeof fetch, shared);
    const fares = await source.quote({ origin: "STN", destination: "DUB", departDate: "2027-06-01", returnDate: "2027-06-05", party: { adults: 1, children: 0, infants: 0 } });
    expect(source.callCount()).toBe(0);
    expect(fares[0]).toMatchObject({ priceAmount: 80, checkedAt: now.toISOString() });
  });
});
