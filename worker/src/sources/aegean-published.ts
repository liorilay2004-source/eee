import { QuoteError, type FareQuoteSource, type QuoteQuery } from "../quotes";
import type { Leg, Offer } from "../types";
import { fetchPublishedFares, type PublishedFare } from "./published-fares";

// Only routes whose official page paths have been inspected so far.
const places: Readonly<Record<string, string>> = { TLV: "tel-aviv", ATH: "athens" };
const cache = new Map<string, { expires: number; fares: PublishedFare[] }>();
const leg = (): Leg => ({ departTime: null, arriveTime: null, durationMin: null, stops: null, airlines: ["A3"] });

/** Published fares are sparse advertisements. Match both exact dates, never substitute
 * a headline price or infer missing return legs. Not usable for party repricing.
 */
export function matchPublishedTrip(fares: readonly PublishedFare[], q: QuoteQuery): Offer[] {
  if (q.party.adults !== 1 || q.party.children || q.party.infants) return [];
  const base = (fare: PublishedFare, amount: number, split: boolean, back?: PublishedFare): Offer => ({
    origin: q.origin, destination: q.destination, departDate: q.departDate, returnDate: q.returnDate,
    source: "aegean", priceAmount: Math.round(amount * 100) / 100, priceCurrency: fare.currency,
    ticketStructure: split ? "split" : "roundtrip", outbound: leg(), inbound: leg(), includes: {},
    deeplink: fare.sourceUrl, ...(back ? { returnDeeplink: back.sourceUrl } : {}), verifyLink: null,
    checkedAt: back && back.checkedAt < fare.checkedAt ? back.checkedAt : fare.checkedAt,
    extrasAmountIls: 0, totalIls: null, tags: ["published_advertisement"],
  });
  const outward = fares.filter((f) => f.airline === "A3" && f.origin === q.origin && f.destination === q.destination && f.departDate === q.departDate);
  const returns = fares.filter((f) => f.airline === "A3" && f.structure === "oneway" && f.origin === q.destination && f.destination === q.origin && f.departDate === q.returnDate);
  const offers = outward.filter((f) => f.structure === "roundtrip" && f.returnDate === q.returnDate).map((f) => base(f, f.amount, false));
  for (const out of outward.filter((f) => f.structure === "oneway")) {
    for (const back of returns) if (out.currency === back.currency) offers.push(base(out, out.amount + back.amount, true, back));
  }
  return offers.sort((a, b) => a.priceAmount - b.priceAmount).slice(0, 20);
}

export function createAegeanPublishedSource(now: Date, fetchFn: typeof fetch): FareQuoteSource {
  let calls = 0;
  const pending = new Map<string, Promise<PublishedFare[]>>();
  async function load(origin: string, destination: string): Promise<PublishedFare[]> {
    const sourceUrl = `https://flights.aegeanair.com/he/flights-from-${places[origin]}-to-${places[destination]}`;
    const stored = cache.get(sourceUrl);
    if (stored && stored.expires > now.getTime()) return stored.fares;
    if (pending.has(sourceUrl)) return pending.get(sourceUrl)!;
    calls++;
    const work = fetchPublishedFares({ airline: "A3", origin, destination, sourceUrl, now }, fetchFn).then((fares) => {
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      cache.set(sourceUrl, { expires: now.getTime() + 10 * 60_000, fares });
      return fares;
    }).catch(() => { throw new QuoteError("response"); }).finally(() => pending.delete(sourceUrl));
    pending.set(sourceUrl, work);
    return work;
  }
  return {
    name: "aegean", configured: true, quota: { period: "monthly", cap: 0, allowance: 0 },
    callCount: () => calls, nextQuoteRequests: () => 2,
    async quote(q) {
      if (!places[q.origin] || !places[q.destination] || q.origin === q.destination || q.party.adults !== 1 || q.party.children || q.party.infants) return [];
      const pages = await Promise.all([load(q.origin, q.destination), load(q.destination, q.origin)]);
      return matchPublishedTrip(pages.flat(), q);
    },
  };
}
