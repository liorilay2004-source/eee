import pages from '../eva-published-catalog.json';
import type { PublicFareCache } from '../public-fare-cache';
import type { FareQuoteSource, QuoteQuery } from '../quotes';
import type { Offer } from '../types';
import type { PublishedFare } from './published-fares';
const realDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
/** Cache-only public advertisements. Website ownership does not identify the operating airline. */
export function createEvaCachedSource(now: Date, cache?: PublicFareCache): FareQuoteSource {
  const pending = new Map<string, Promise<PublishedFare[]>>();
  async function fares(q: QuoteQuery): Promise<PublishedFare[]> {
    if (q.party.adults !== 1 || q.party.children || q.party.infants || (q.adults ?? 1) !== 1
      || !realDate(q.departDate) || !realDate(q.returnDate) || q.departDate < now.toISOString().slice(0, 10)
      || q.returnDate <= q.departDate) return [];
    const urls = [...new Set(pages.filter(page => page.origin === q.origin && page.destination === q.destination
      || page.origin === q.destination && page.destination === q.origin).map(page => page.sourceUrl))];
    const results = await Promise.allSettled(urls.map(page => {
      if (!pending.has(page)) pending.set(page, (async () => {
        const stored = await cache?.get<PublishedFare>(page);
        if (!stored || !Number.isFinite(stored.expires) || stored.expires <= now.getTime()) return [];
        return stored.fares.filter(fare => {
          const age = now.getTime() - Date.parse(fare.checkedAt);
          return fare.airline === 'BR' && fare.sourceUrl === page && fare.pricing === 'published_advertisement'
            && pages.some(config => config.sourceUrl === page && config.origin === fare.origin && config.destination === fare.destination)
            && Number.isFinite(age) && age >= 0 && age < 600_000 && realDate(fare.departDate)
            && fare.departDate >= now.toISOString().slice(0, 10) && Number.isFinite(fare.amount) && fare.amount > 0 && fare.amount <= 1e9
            && /^[A-Z]{3}$/.test(fare.currency) && (fare.structure === 'oneway' && fare.returnDate === null
              || fare.structure === 'roundtrip' && realDate(fare.returnDate) && fare.returnDate > fare.departDate);
        });
      })());
      return pending.get(page)!;
    }));
    return [...new Map(results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
      .map(fare => [JSON.stringify(fare), fare])).values()];
  }
  async function quote(q: QuoteQuery): Promise<Offer[]> {
    const rows = await fares(q);
    const outward = rows.filter(fare => fare.origin === q.origin && fare.destination === q.destination && fare.departDate === q.departDate);
    const backward = rows.filter(fare => fare.structure === 'oneway' && fare.origin === q.destination
      && fare.destination === q.origin && fare.departDate === q.returnDate);
    const build = (out: PublishedFare, back?: PublishedFare): Offer => ({
      origin: q.origin, destination: q.destination, departDate: q.departDate, returnDate: q.returnDate, source: 'eva',
      priceAmount: Math.round((out.amount + (back?.amount ?? 0)) * 100) / 100, priceCurrency: out.currency,
      ticketStructure: back ? 'split' : 'roundtrip',
      outbound: { departTime: null, arriveTime: null, durationMin: null, stops: null, airlines: [] },
      inbound: { departTime: null, arriveTime: null, durationMin: null, stops: null, airlines: [] }, includes: {},
      deeplink: out.sourceUrl, ...(back ? { returnDeeplink: back.sourceUrl } : {}), verifyLink: null,
      checkedAt: back && back.checkedAt < out.checkedAt ? back.checkedAt : out.checkedAt,
      ...(!back && out.upstreamPriceAge ? { upstreamPriceAge: out.upstreamPriceAge } : {}),
      extrasAmountIls: 0, totalIls: null, tags: ['published_advertisement', 'operator_unknown'],
    });
    const offers = outward.filter(fare => fare.structure === 'roundtrip' && fare.returnDate === q.returnDate).map(fare => build(fare));
    for (const out of outward.filter(fare => fare.structure === 'oneway')) {
      for (const back of backward) if (out.currency === back.currency) offers.push(build(out, back));
    }
    // Native amounts are never compared across currencies; the search pipeline applies independently validated FX.
    return [...new Map(offers.map(offer => [JSON.stringify(offer), offer])).values()].slice(0, 20);
  }
  return {
    name: 'eva', configured: true, quota: { period: 'monthly', cap: 0, allowance: 0 },
    callCount: () => 0, nextQuoteRequests: () => 0, quote,
    async validatesStoredOffer(offer) {
      if (offer.source !== 'eva' || offer.outbound.airlines.length || offer.inbound.airlines.length) return false;
      const current = await quote({ origin: offer.origin, destination: offer.destination, departDate: offer.departDate,
        returnDate: offer.returnDate, party: { adults: 1, children: 0, infants: 0 } });
      return current.some(fare => fare.priceAmount === offer.priceAmount && fare.priceCurrency === offer.priceCurrency
        && fare.checkedAt === offer.checkedAt && fare.deeplink === offer.deeplink && fare.returnDeeplink === offer.returnDeeplink);
    },
  };
}
