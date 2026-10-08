import { QuoteError, type FareQuoteSource, type QuoteQuery } from "../quotes";
import type { Leg } from "../types";
import type { PricedDirection } from "../direct-combinations";
import type { PublicFareCache } from "../public-fare-cache";
import { parseAirSerbiaCalendar } from "../airserbia-calendar";
const cache = new Map<string, { expires: number; fares: PricedDirection[] }>();
const supported = (q: QuoteQuery) => ["BEG:ATH", "ATH:BEG"].includes(`${q.origin}:${q.destination}`) && q.party.adults === 1 && !q.party.children && !q.party.infants;
export function airSerbiaCalendarUrl(origin: string, destination: string, date: string): string {
  if (!["BEG:ATH", "ATH:BEG"].includes(`${origin}:${destination}`) || !/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(date)) throw new Error("Unsupported calendar");
  return `https://www.airserbia.com/api/destination/flight-prices/${origin}/${destination}?year=${date.slice(0,4)}&month=${Number(date.slice(5,7))}&pos=GLOBAL`;
}
export function createAirSerbiaDirectSource(now: Date, fetchFn: typeof fetch = fetch, sharedCache?: PublicFareCache): FareQuoteSource {
  let calls = 0;
  const pending = new Map<string, Promise<PricedDirection[]>>();
  const load = (origin: string, destination: string, date: string) => {
    const key = airSerbiaCalendarUrl(origin, destination, date);
    const stored = cache.get(key);
    if (stored && stored.expires > now.getTime()) return Promise.resolve(stored.fares);
    if (pending.has(key)) return pending.get(key)!;
    let expires = now.getTime() + 600_000;
    const work = (async () => {
      const shared = await sharedCache?.get<PricedDirection>(key);
      if (shared) { expires = shared.expires; return shared.fares; }
      calls++;
      const response = await fetchFn(key, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
      if (!response.ok) throw new QuoteError("http", response.status);
      const text = await response.text();
      if (text.length > 100_000) throw new QuoteError("response");
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new QuoteError("response"); }
      const fares = parseAirSerbiaCalendar(data, { origin, destination, year: Number(date.slice(0,4)), month: Number(date.slice(5,7)), now });
      await sharedCache?.put(key, fares);
      return fares;
    })().then(fares => {
      if (cache.size >= 128) cache.delete(cache.keys().next().value!);
      cache.set(key, { expires, fares }); return fares;
    }).finally(() => pending.delete(key));
    pending.set(key, work); return work;
  };
  const directions = async (q: QuoteQuery) => {
    if (!supported(q)) return [];
    const rows = (await Promise.all([load(q.origin,q.destination,q.departDate), load(q.destination,q.origin,q.returnDate)])).flat();
    return rows.filter(f => f.origin === q.origin && f.destination === q.destination && f.date === q.departDate || f.origin === q.destination && f.destination === q.origin && f.date === q.returnDate);
  };
  const leg = (): Leg => ({ departTime: null, arriveTime: null, durationMin: null, stops: null, airlines: ["JU"] });
  return { name: "air_serbia", configured: true, quota: { period: "monthly", cap: 0, allowance: 0 }, callCount: () => calls,
    nextQuoteRequests: q => !q ? 2 : !supported(q) ? 0 : [airSerbiaCalendarUrl(q.origin,q.destination,q.departDate),airSerbiaCalendarUrl(q.destination,q.origin,q.returnDate)].filter(key => !pending.has(key) && (cache.get(key)?.expires ?? 0) <= now.getTime()).length,
    oneWays: directions,
    async quote(q) {
      const rows = await directions(q);
      const out = rows.find(f => f.origin === q.origin && f.date === q.departDate);
      const back = rows.find(f => f.origin === q.destination && f.date === q.returnDate);
      if (!out || !back) return [];
      return [{ origin:q.origin,destination:q.destination,departDate:q.departDate,returnDate:q.returnDate,source:"air_serbia",priceAmount:Math.round((out.amount+back.amount)*100)/100,priceCurrency:"EUR",ticketStructure:"split",outbound:leg(),inbound:leg(),includes:{},deeplink:out.bookingUrl,returnDeeplink:back.bookingUrl,verifyLink:null,checkedAt:out.checkedAt<back.checkedAt?out.checkedAt:back.checkedAt,totalIls:null,extrasAmountIls:0,tags:["published_advertisement","advertised_calendar_price"],ticketPrices:{outbound:{airline:"JU",amount:out.amount,currency:"EUR"},inbound:{airline:"JU",amount:back.amount,currency:"EUR"}} }];
    }
  };
}
