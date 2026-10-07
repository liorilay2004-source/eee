import { QuoteError, type FareQuoteSource } from "../quotes";
import type { PublicFareCache } from "../public-fare-cache";
import { matchPublishedTrip } from "./aegean-published";
import { fetchPublishedFares, type PublishedFare } from "./published-fares";

// Verified official route page: the heading uses Toronto YTO, dated fares use YYZ.
const routes: Readonly<Record<string, string>> = {
  "TLV:YYZ": "https://www.aircanada.com/en-ca/flights-from-tel-aviv-to-toronto",
};
const pages = new Map<string, { expires: number; fares: PublishedFare[] }>();
export function createAirCanadaPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache): FareQuoteSource {
  let calls = 0;
  const pending = new Map<string, Promise<PublishedFare[]>>();
  return {
    name: "air_canada", configured: true, quota: { period: "monthly", cap: 0, allowance: 0 },
    callCount: () => calls, nextQuoteRequests: () => 1,
    async quote(q) {
      const sourceUrl = routes[`${q.origin}:${q.destination}`];
      if (!sourceUrl || q.party.adults !== 1 || q.party.children || q.party.infants) return [];
      const cached = pages.get(sourceUrl);
      let fares: PublishedFare[];
      if (cached && cached.expires > now.getTime()) fares = cached.fares;
      else {
        if (!pending.has(sourceUrl)) {
          let expires = now.getTime() + 600_000;
          const work = (async () => {
            const shared = await sharedCache?.get<PublishedFare>(sourceUrl);
            if (shared) { expires = shared.expires; return shared.fares; }
            calls++;
            const value = await fetchPublishedFares({ airline: "AC", origin: q.origin, destination: q.destination, sourceUrl, now }, fetchFn);
            await sharedCache?.put(sourceUrl, value);
            return value;
          })().then((value) => {
            if (pages.size >= 64) pages.delete(pages.keys().next().value!);
            pages.set(sourceUrl, { expires, fares: value });
            return value;
          }).catch(() => { throw new QuoteError("response"); }).finally(() => pending.delete(sourceUrl));
          pending.set(sourceUrl, work);
        }
        fares = await pending.get(sourceUrl)!;
      }
      return matchPublishedTrip(fares, q, { airline: "AC", source: "air_canada" });
    },
  };
}
