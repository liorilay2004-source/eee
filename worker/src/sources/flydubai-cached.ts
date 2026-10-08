import pages from '../flydubai-published-catalog.json';
import type {FlydubaiAdvertisement} from '../../../collector/flydubai-fares.mjs';
import type {PublicFareCache} from '../public-fare-cache';
import type {FareQuoteSource, QuoteQuery} from '../quotes';
import type {Leg, Offer} from '../types';

const MAX_AGE_MS = 600_000;
const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const unknownLeg = (): Leg => ({departTime: null, arriveTime: null, durationMin: null, stops: null, airlines: []});

/** Only externally refreshed official advertisements. Search never calls the airline. */
export function createFlydubaiCachedSource(now: Date, cache?: PublicFareCache): FareQuoteSource {
  const pending = new Map<string, Promise<FlydubaiAdvertisement[]>>();
  const capturedNow = now.getTime();

  async function fares(q: QuoteQuery): Promise<FlydubaiAdvertisement[]> {
    if (!Number.isFinite(capturedNow) || q.party.adults !== 1 || q.party.children !== 0
      || q.party.infants !== 0 || (q.adults ?? 1) !== 1 || !validDate(q.departDate)
      || !validDate(q.returnDate) || q.returnDate <= q.departDate) return [];

    const relevant = pages.filter(p => p.origin === q.origin && p.destination === q.destination
      || p.origin === q.destination && p.destination === q.origin);
    const urls = [...new Set(relevant.map(p => p.sourceUrl))];
    const snapshots = await Promise.allSettled(urls.map(page => {
      if (!pending.has(page)) pending.set(page, (async () => {
        const stored = await cache?.get<FlydubaiAdvertisement>(page);
        if (!stored || !Number.isFinite(stored.expires) || stored.expires <= capturedNow) return [];
        const approved = pages.filter(p => p.sourceUrl === page);
        return stored.fares.filter(f => {
          const age = capturedNow - Date.parse(f.checkedAt);
          return f.sourceUrl === page && f.pricing === 'published_advertisement'
            && approved.some(p => p.origin === f.origin && p.destination === f.destination)
            && Number.isFinite(age) && age >= 0 && age < MAX_AGE_MS
            && Number.isFinite(f.amount) && f.amount > 0 && f.amount <= 10_000_000
            && /^[A-Z]{3}$/.test(f.currency) && validDate(f.departDate)
            && (f.structure === 'oneway' && f.returnDate === null
              || f.structure === 'roundtrip' && typeof f.returnDate === 'string'
                && validDate(f.returnDate) && f.returnDate > f.departDate);
        });
      })());
      return pending.get(page)!;
    }));
    return [...new Map(snapshots.flatMap(snapshot => snapshot.status === 'fulfilled' ? snapshot.value : [])
      .map(f => [JSON.stringify(f), f])).values()];
  }

  async function quote(q: QuoteQuery): Promise<Offer[]> {
    const rows = await fares(q);
    const outgoing = rows.filter(f => f.origin === q.origin && f.destination === q.destination
      && f.departDate === q.departDate);
    const incoming = rows.filter(f => f.structure === 'oneway' && f.origin === q.destination
      && f.destination === q.origin && f.departDate === q.returnDate);
    const build = (out: FlydubaiAdvertisement, back?: FlydubaiAdvertisement): Offer => ({
      origin: q.origin, destination: q.destination, departDate: q.departDate, returnDate: q.returnDate,
      source: 'flydubai', priceAmount: Math.round((out.amount + (back?.amount ?? 0)) * 100) / 100,
      priceCurrency: out.currency, ticketStructure: back ? 'split' : 'roundtrip',
      outbound: unknownLeg(), inbound: unknownLeg(), includes: {},
      deeplink: out.sourceUrl, ...(back ? {returnDeeplink: back.sourceUrl} : {}), verifyLink: null,
      checkedAt: back && Date.parse(back.checkedAt) < Date.parse(out.checkedAt) ? back.checkedAt : out.checkedAt,
      extrasAmountIls: 0, totalIls: null,
      tags: ['published_advertisement', 'operator_unknown', 'cabin_unknown'],
    });
    const offers = outgoing.filter(f => f.structure === 'roundtrip' && f.returnDate === q.returnDate)
      .map(f => build(f));
    for (const out of outgoing.filter(f => f.structure === 'oneway')) {
      for (const back of incoming) {
        if (out.currency === back.currency) offers.push(build(out, back));
      }
    }
    // Native prices are only ordered within a currency. FX comparison belongs to the pipeline.
    return [...new Map(offers.map(offer => [JSON.stringify(offer), offer])).values()]
      .sort((a, b) => a.priceCurrency.localeCompare(b.priceCurrency) || a.priceAmount - b.priceAmount)
      .slice(0, 20);
  }

  return {
    name: 'flydubai', configured: true, quota: {period: 'monthly', cap: 0, allowance: 0},
    callCount: () => 0, nextQuoteRequests: () => 0, quote,
    async validatesStoredOffer(offer) {
      if (offer.source !== 'flydubai') return false;
      const current = await quote({origin: offer.origin, destination: offer.destination,
        departDate: offer.departDate, returnDate: offer.returnDate,
        party: {adults: 1, children: 0, infants: 0}});
      return current.some(f => f.priceAmount === offer.priceAmount && f.priceCurrency === offer.priceCurrency
        && f.checkedAt === offer.checkedAt && f.ticketStructure === offer.ticketStructure
        && f.deeplink === offer.deeplink && f.returnDeeplink === offer.returnDeeplink);
    },
  };
}
