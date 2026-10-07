import { combineDirectDirections } from "../direct-combinations";
import { isPublishedSource, QuoteError, type FareQuoteSource } from "../quotes";
import type { Leg } from "../types";
/** Reuses provider instances and their pending requests/cache. Never calls a paid source. */
export function createDirectCombinationSource(providers: FareQuoteSource[]): FareQuoteSource {
  const direct = providers.filter(p => p.configured && p.name !== "direct_combination" && isPublishedSource(p.name) && p.oneWays);
  const emptyLeg = (airline: string): Leg => ({ departTime: null, arriveTime: null, durationMin: null, stops: null, airlines: [airline] });
  return {
    name: "direct_combination", configured: direct.length > 1, quota: { period: "monthly", cap: 0, allowance: 0 },
    // Network calls remain attributed to the underlying official source instance.
    callCount: () => 0,
    nextQuoteRequests: q => direct.reduce((n, p) => n + (p.nextQuoteRequests?.(q) ?? 1), 0),
    async quote(q) {
      if (q.party.adults !== 1 || q.party.children || q.party.infants) return [];
      const results = await Promise.allSettled(direct.map(p => p.oneWays!(q)));
      // A failed airline must not erase independently priced legs from the others.
      if (results.every(r => r.status === "rejected")) throw new QuoteError("response");
      const fares = results.flatMap(r => r.status === "fulfilled" ? r.value : []);
      return combineDirectDirections(fares, { ...q, adults: q.party.adults, children: q.party.children ?? 0, infants: q.party.infants ?? 0 }).slice(0, 20).map(c => ({
        origin: q.origin, destination: q.destination, departDate: q.departDate, returnDate: q.returnDate,
        source: "direct_combination", ticketStructure: "split", priceAmount: c.amount, priceCurrency: c.currency,
        outbound: c.outbound.leg ?? emptyLeg(c.outbound.airline), inbound: c.inbound.leg ?? emptyLeg(c.inbound.airline),
        includes: {}, deeplink: c.outbound.bookingUrl, returnDeeplink: c.inbound.bookingUrl, verifyLink: null,
        ticketPrices: {
          outbound: { amount: c.outbound.amount, currency: c.outbound.currency, airline: c.outbound.airline },
          inbound: { amount: c.inbound.amount, currency: c.inbound.currency, airline: c.inbound.airline },
        },
        checkedAt: c.checkedAt, extrasAmountIls: 0, totalIls: null, tags: ["published_advertisement"],
      }));
    },
  };
}
