import { QuoteError, type FareQuoteSource, type QuoteQuery } from "../quotes";
import type { Leg, Offer } from "../types";
import { fetchPublishedFares, type PublishedFare } from "./published-fares";
import type { PublicFareCache } from "../public-fare-cache";
import {EXTERNAL_PUBLISHED_PAGES} from "../external-published-catalog";

const cache = new Map<string, { expires: number; fares: PublishedFare[] }>();

/** Published fares are sparse advertisements. Match both exact dates, never substitute
 * a headline price or infer missing return legs. Not usable for party repricing.
 */
export function matchPublishedTrip(fares: readonly PublishedFare[], q: QuoteQuery, config: { airline: string; source: "air_astana" | "aegean" | "air_canada" | "tap" | "ethiopian" | "air_europa" | "philippine" | "virgin_atlantic" | "air_new_zealand" | "air_baltic" | "sky_express" | "gol" | "aeromexico" | "copa" | "icelandair" | "finnair" | "iberia" | "avianca" | "klm" | "american" | "aer_lingus" | "jetblue" | "frontier" | "singapore" } = { airline: "A3", source: "aegean" }): Offer[] {
  if (q.party.adults !== 1 || q.party.children || q.party.infants) return [];
  const leg = (): Leg => ({ departTime: null, arriveTime: null, durationMin: null, stops: null, airlines: [config.airline] });
  const base = (fare: PublishedFare, amount: number, split: boolean, back?: PublishedFare): Offer => ({
    origin: q.origin, destination: q.destination, departDate: q.departDate, returnDate: q.returnDate,
    source: config.source, priceAmount: Math.round(amount * 100) / 100, priceCurrency: fare.currency,
    ticketStructure: split ? "split" : "roundtrip", outbound: leg(), inbound: leg(), includes: {},
    deeplink: fare.sourceUrl, ...(back ? { returnDeeplink: back.sourceUrl } : {}), verifyLink: null,
    checkedAt: back && back.checkedAt < fare.checkedAt ? back.checkedAt : fare.checkedAt,
    ...(!split && fare.upstreamPriceAge ? {upstreamPriceAge:fare.upstreamPriceAge} : {}),
    extrasAmountIls: 0, totalIls: null, tags: ["published_advertisement"],
  });
  const outward = fares.filter((f) => f.airline === config.airline && f.origin === q.origin && f.destination === q.destination && f.departDate === q.departDate);
  const returns = fares.filter((f) => f.airline === config.airline && f.structure === "oneway" && f.origin === q.destination && f.destination === q.origin && f.departDate === q.returnDate);
  const offers = outward.filter((f) => f.structure === "roundtrip" && f.returnDate === q.returnDate).map((f) => base(f, f.amount, false));
  for (const out of outward.filter((f) => f.structure === "oneway")) {
    for (const back of returns) if (out.currency === back.currency) offers.push(base(out, out.amount + back.amount, true, back));
  }
  return offers.sort((a, b) => a.priceAmount - b.priceAmount).slice(0, 20);
}

export interface PublishedSourceConfig {
  source: "aegean" | "air_canada" | "tap" | "ethiopian" | "air_europa" | "philippine" | "virgin_atlantic" | "air_new_zealand" | "air_baltic" | "sky_express" | "gol" | "aeromexico" | "copa" | "icelandair" | "finnair" | "iberia" | "avianca" | "klm" | "american" | "aer_lingus" | "jetblue" | "frontier" | "singapore";
  airline: string;
  routes: Readonly<Record<string, readonly PublishedPage[]>>;
  /** Origin-specific official page lists multiple destinations; parsed once for all. */
  originPages?: readonly PublishedPage[];
}
interface PublishedPage { origin: string; destination: string; sourceUrl: string; allDestinations?: boolean; origins?: readonly string[] }
/** All routes and page URLs come from verified official pages, never user URLs. */
export function createPublishedSource(config: PublishedSourceConfig, now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache): FareQuoteSource {
  let calls = 0;
  const pending = new Map<string, Promise<PublishedFare[]>>();
  async function load(page: PublishedSourceConfig["routes"][string][number]): Promise<PublishedFare[]> {
    const { sourceUrl } = page;
    const stored = cache.get(sourceUrl);
    if (stored && stored.expires > now.getTime()) return stored.fares;
    if (pending.has(sourceUrl)) return pending.get(sourceUrl)!;
    let expires = now.getTime() + 600_000;
    const work = (async () => {
      const shared = await sharedCache?.get<PublishedFare>(sourceUrl);
      if (shared) { expires = Math.min(shared.expires, now.getTime() + 600_000); return shared.fares; }
      calls++;
      const fares = await fetchPublishedFares({ ...page, airline: config.airline, now }, fetchFn);
      await sharedCache?.put(sourceUrl, fares);
      return fares;
    })().then((fares) => {
      if (cache.size >= 256) cache.delete(cache.keys().next().value!);
      cache.set(sourceUrl, { expires, fares });
      return fares;
    }).catch(() => { throw new QuoteError("response"); }).finally(() => pending.delete(sourceUrl));
    pending.set(sourceUrl, work);
    return work;
  }
  const source:FareQuoteSource = {
    name: config.source, configured: true, quota: { period: "monthly", cap: 0, allowance: 0 },
    callCount: () => calls,
    nextQuoteRequests: (q) => {
      if (!q) return Math.max(1, config.originPages?.length ?? 0, ...Object.values(config.routes).map((pages) => pages.length));
      if (q.party.adults !== 1 || q.party.children || q.party.infants) return 0;
      const pages = config.routes[`${q.origin}:${q.destination}`] ?? config.originPages?.filter(page => page.origin === q.origin) ?? [];
      // Pending loads already have their request slots reserved by the first caller.
      return [...new Set(pages.map(page => page.sourceUrl))].filter(url => !pending.has(url) && (cache.get(url)?.expires ?? 0) <= now.getTime()).length;
    },
    async oneWays(q) {
      const pages = config.routes[`${q.origin}:${q.destination}`] ?? config.originPages?.filter(page => page.origin === q.origin);
      if (!pages?.length || q.party.adults !== 1 || q.party.children || q.party.infants) return [];
      const fares = (await Promise.all(pages.map(load))).flat();
      return fares.filter(f => f.structure === "oneway" && (f.origin === q.origin && f.destination === q.destination && f.departDate === q.departDate || f.origin === q.destination && f.destination === q.origin && f.departDate === q.returnDate)).map(f => ({
        source: config.source, airline: f.airline, origin: f.origin, destination: f.destination, date: f.departDate,
        amount: f.amount, currency: f.currency, checkedAt: f.checkedAt, bookingUrl: f.sourceUrl,
        leg: { departTime: null, arriveTime: null, durationMin: null, stops: null, airlines: [f.airline] },
      }));
    },
    async quote(q) {
      const pages = config.routes[`${q.origin}:${q.destination}`] ?? config.originPages?.filter((page) => page.origin === q.origin);
      if (!pages?.length || q.party.adults !== 1 || q.party.children || q.party.infants) return [];
      return matchPublishedTrip((await Promise.all(pages.map(load))).flat(), q, config);
    },
  };
  if(!sharedCache||!["TP","VS","GQ","ET","EI","G3","AA","B6"].includes(config.airline))return source;
  const additional=async(q:QuoteQuery)=>{
    if(q.party.adults!==1||q.party.children||q.party.infants)return [];
    const pages=EXTERNAL_PUBLISHED_PAGES.filter(page=>page.airline===config.airline&&!page.allDestinations&&(page.origin===q.origin&&page.destination===q.destination||page.origin===q.destination&&page.destination===q.origin));
    const values=await Promise.allSettled([...new Set(pages.map(page=>page.sourceUrl))].map(url=>sharedCache.get<PublishedFare>(url)));
    return values.flatMap(value=>value.status==="fulfilled"?value.value?.fares??[]:[]);
  };
  return {...source,async oneWays(q){
    const [base,extra]=await Promise.allSettled([source.oneWays?.(q)??Promise.resolve([]),additional(q)]);
    const expanded=(extra.status==="fulfilled"?extra.value:[]).filter(f=>f.structure==="oneway"&&(f.origin===q.origin&&f.destination===q.destination&&f.departDate===q.departDate||f.origin===q.destination&&f.destination===q.origin&&f.departDate===q.returnDate)).map(f=>({source:config.source,airline:f.airline,origin:f.origin,destination:f.destination,date:f.departDate,amount:f.amount,currency:f.currency,checkedAt:f.checkedAt,bookingUrl:f.sourceUrl,leg:{departTime:null,arriveTime:null,durationMin:null,stops:null,airlines:[f.airline]}}));
    if(base.status==="rejected"&&!expanded.length)throw base.reason;
    return [...new Map([...(base.status==="fulfilled"?base.value:[]),...expanded].map(fare=>[JSON.stringify(fare),fare])).values()];
  },async quote(q){
    const [base,extra]=await Promise.allSettled([source.quote(q),additional(q)]);
    const expanded=extra.status==="fulfilled"?matchPublishedTrip(extra.value,q,config):[];
    if(base.status==="rejected"&&!expanded.length)throw base.reason;
    return [...new Map([...(base.status==="fulfilled"?base.value:[]),...expanded].map(offer=>[JSON.stringify(offer),offer])).values()].sort((a,b)=>a.priceAmount-b.priceAmount).slice(0,20);
  }};
}
