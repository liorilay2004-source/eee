/** Direct website data, observed in Ryanair's official fare-finder bundle.
 * Monthly calendars are one-adult advertised fares, not a reserved whole-party quote.
 * Never multiply them and claim that all passengers can buy at that price.
 */
import { QuoteError, type FareQuoteSource } from "../quotes";
import type { Leg } from "../types";
import type { PublicFareCache } from "../public-fare-cache";

export interface DirectFare {
  airline: "FR";
  origin: string;
  destination: string;
  date: string;
  departure: string;
  arrival: string | null;
  amount: number;
  currency: "EUR";
  checkedAt: string;
  sourceUrl: string;
  pricing: "advertised_one_adult";
}

const calendars = new Map<string, { expires: number; value: DirectFare[] }>();

/** Website calendars shared across searches in this isolate, including empty days.
 * No paid quota or D1 dependency. At most two bounded requests for a date pair.
 */
export function createRyanairDirectSource(now: Date, fetchFn: typeof fetch = fetch, sharedCache?: PublicFareCache): FareQuoteSource {
  let calls = 0;
  const inFlight = new Map<string, Promise<DirectFare[]>>();
  const load = (origin: string, destination: string, date: string) => {
    const month = date.slice(0, 7);
    const key = ryanairCalendarUrl(origin, destination, month);
    const stored = calendars.get(key);
    if (stored && stored.expires > now.getTime()) return Promise.resolve(stored.value);
    const pending = inFlight.get(key);
    if (pending) return pending;
    if (calendars.size >= 128) calendars.delete(calendars.keys().next().value!);
    let expires = now.getTime() + 10 * 60_000;
    const value = (async () => {
      const shared = await sharedCache?.get<DirectFare>(key);
      if (shared) { expires = shared.expires; return shared.fares; }
      calls++;
      const fares = await fetchRyanairCalendar(origin, destination, month, now, fetchFn);
      await sharedCache?.put(key, fares);
      return fares;
    })().then((fares) => {
      calendars.set(key, { expires, value: fares });
      return fares;
    }).catch((error) => {
      throw error instanceof QuoteError ? error : new QuoteError("network");
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, value);
    return value;
  };
  const leg = (fare: DirectFare): Leg => ({ departTime: fare.departure.slice(11, 16), arriveTime: fare.arrival?.slice(11, 16) ?? null, durationMin: null, stops: 0, airlines: ["FR"] });
  return {
    name: "ryanair", configured: true,
    // Zero means not a paid vendor allowance; this source does not use quota reservation.
    quota: { period: "monthly", cap: 0, allowance: 0 },
    callCount: () => calls, nextQuoteRequests: () => 2,
    async quote(q) {
      // The calendar cannot substantiate a whole-party fare. Do not scale it.
      if (q.party.adults !== 1 || q.party.children !== 0 || q.party.infants !== 0) return [];
      const [outs, backs] = await Promise.all([load(q.origin, q.destination, q.departDate), load(q.destination, q.origin, q.returnDate)]);
      const out = outs.find((f) => f.date === q.departDate);
      const back = backs.find((f) => f.date === q.returnDate);
      if (!out || !back) return [];
      return [{ origin: q.origin, destination: q.destination, departDate: q.departDate, returnDate: q.returnDate,
        priceAmount: Math.round((out.amount + back.amount) * 100) / 100, priceCurrency: "EUR", source: "ryanair",
        ticketStructure: "split", outbound: leg(out), inbound: leg(back), includes: {},
        deeplink: "https://www.ryanair.com/", returnDeeplink: "https://www.ryanair.com/", verifyLink: null,
        checkedAt: out.checkedAt < back.checkedAt ? out.checkedAt : back.checkedAt,
        totalIls: null, extrasAmountIls: 0, tags: ["advertised_calendar_price"] }];
    },
  };
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const airport = /^[A-Z]{3}$/;
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const localTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

export function ryanairCalendarUrl(origin: string, destination: string, month: string): string {
  if (!airport.test(origin) || !airport.test(destination) || !monthPattern.test(month) || origin === destination) throw new Error("Invalid route or month");
  // CORE_API_AWS_OLD in the official bundle names this same public service host.
  return `https://services-api.ryanair.com/farfnd/v4/oneWayFares/${origin}/${destination}/cheapestPerDay?outboundMonthOfDate=${month}-01&currency=EUR`;
}

export function parseRyanairCalendar(body: unknown, origin: string, destination: string, month: string, now: Date): DirectFare[] {
  const sourceUrl = ryanairCalendarUrl(origin, destination, month);
  if (!record(body) || !record(body.outbound) || !Array.isArray(body.outbound.fares)) throw new Error("Invalid fare calendar");
  return body.outbound.fares.flatMap((row): DirectFare[] => {
    if (!record(row) || row.unavailable === true || row.soldOut === true || !record(row.price)) return [];
    const { day, departureDate, arrivalDate } = row;
    if (typeof day !== "string" || !day.startsWith(`${month}-`) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
    const parsedDay = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day) return [];
    if (typeof departureDate !== "string" || !localTime.test(departureDate) || departureDate.slice(0, 10) !== day) return [];
    if (typeof row.price.value !== "number" || !Number.isFinite(row.price.value) || row.price.value <= 0 || row.price.currencyCode !== "EUR") return [];
    return [{ airline: "FR", origin, destination, date: day, departure: departureDate,
      arrival: typeof arrivalDate === "string" && localTime.test(arrivalDate) ? arrivalDate : null,
      amount: row.price.value, currency: "EUR", checkedAt: now.toISOString(), sourceUrl, pricing: "advertised_one_adult" }];
  });
}

/** Fixed official host, no credentials, redirects or unbounded retries. */
export async function fetchRyanairCalendar(origin: string, destination: string, month: string, now: Date, fetchFn: typeof fetch = fetch): Promise<DirectFare[]> {
  const response = await fetchFn(ryanairCalendarUrl(origin, destination, month), {
    headers: { Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new QuoteError("http", response.status);
  const text = await response.text();
  if (text.length > 100_000) throw new QuoteError("response");
  try { return parseRyanairCalendar(JSON.parse(text), origin, destination, month, now); }
  catch { throw new QuoteError("response"); }
}
