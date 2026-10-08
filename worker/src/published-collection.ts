import type { Env, Repo, Offer } from "./types";
import type { PublicFareCache } from "./public-fare-cache";
import { fetchPublishedFares } from "./sources/published-fares";
import { matchPublishedTrip, type PublishedSourceConfig } from "./sources/published-source";

interface Page {
  source: PublishedSourceConfig["source"];
  airline: string;
  origin: string;
  destination: string;
  sourceUrl: string;
  flag: keyof Env;
  origins?: readonly string[];
}
// Only pages already used and validated by production source adapters.
export const COLLECTION_PAGES: readonly Page[] = [
  { source: "american", airline: "AA", origin: "LAX", destination: "MEX", sourceUrl: "https://www.aa.com/en-us/flights-from-los-angeles-to-mexico-city", flag: "AMERICAN_PUBLISHED_ENABLED" },
  { source: "aer_lingus", airline: "EI", origin: "DUB", destination: "AMS", sourceUrl: "https://www.aerlingus.com/en-ie/flights-from-dublin", flag: "AERLINGUS_PUBLISHED_ENABLED" },
  { source: "gol", airline: "G3", origin: "GRU", destination: "GIG", origins: ["GRU", "CGH", "SAO"], sourceUrl: "https://www.voegol.com.br/en/flights-from-sao-paulo", flag: "GOL_PUBLISHED_ENABLED" },
  { source: "sky_express", airline: "GQ", origin: "ATH", destination: "FCO", sourceUrl: "https://www.skyexpress.gr/en/flights-from-athens", flag: "SKYEXPRESS_PUBLISHED_ENABLED" },
  { source: "air_canada", airline: "AC", origin: "TLV", destination: "YYZ", sourceUrl: "https://www.aircanada.com/en-ca/flights-from-tel-aviv", flag: "AIRCANADA_PUBLISHED_ENABLED" },
  { source: "tap", airline: "TP", origin: "TLV", destination: "LIS", sourceUrl: "https://www.flytap.com/en_il/flights-from-tel-aviv", flag: "TAP_PUBLISHED_ENABLED" },
  { source: "ethiopian", airline: "ET", origin: "TLV", destination: "BKK", sourceUrl: "https://www.ethiopianairlines.com/en-il/", flag: "ETHIOPIAN_PUBLISHED_ENABLED" },
  { source: "air_europa", airline: "UX", origin: "TLV", destination: "MAD", sourceUrl: "https://www.aireuropa.com/en-il/flight-deals-from-tel-aviv-to-spain", flag: "AIREUROPA_PUBLISHED_ENABLED" },
  { source: "philippine", airline: "PR", origin: "MNL", destination: "BKK", sourceUrl: "https://flights.philippineairlines.com/en-ph/flights-from-manila-to-bangkok", flag: "PHILIPPINE_PUBLISHED_ENABLED" },
  { source: "virgin_atlantic", airline: "VS", origin: "TLV", destination: "JFK", sourceUrl: "https://flights.virginatlantic.com/en-il/flights-from-tel-aviv", flag: "VIRGIN_PUBLISHED_ENABLED" },
  { source: "air_new_zealand", airline: "NZ", origin: "LAX", destination: "AKL", sourceUrl: "https://www.airnewzealand.com/flights/en-us/flights-from-los-angeles", flag: "AIRNZ_PUBLISHED_ENABLED" },
  { source: "air_baltic", airline: "BT", origin: "TLV", destination: "RIX", sourceUrl: "https://www.airbaltic.com/en/flight-deals/flights-from-israel", flag: "AIRBALTIC_PUBLISHED_ENABLED" },
];

/** One official page per hourly invocation; no paid vendor calls or arbitrary URLs.
 * Persist all dated round-trip advertisements, not just a user's requested pair.
 * One-way records remain complete in the public cache for combination adapters.
 */
interface CollectionDeps {
  env: Env; repo: Pick<Repo, "savePrices">; now: Date; fetchFn: typeof fetch; cache?: PublicFareCache;
}
export async function collectPublishedPage(deps: CollectionDeps): Promise<{ source: string | null; ok: boolean; fares: number; saved: number }> {
  const pages = COLLECTION_PAGES.filter(page => deps.env[page.flag] === "true");
  if (!pages.length) return { source: null, ok: true, fares: 0, saved: 0 };
  const page = pages[Math.floor(deps.now.getTime() / 3_600_000) % pages.length]!;
  return collectPage(deps, page);
}

/** Refresh every enabled official origin each hour, four at a time. */
export async function collectPublishedPages(deps: CollectionDeps) {
  const pages = COLLECTION_PAGES.filter(page => deps.env[page.flag] === "true");
  const results: Awaited<ReturnType<typeof collectPublishedPage>>[] = [];
  for (let i = 0; i < pages.length; i += 4) {
    results.push(...await Promise.all(pages.slice(i, i + 4).map(page => collectPage(deps, page))));
  }
  return results;
}

async function collectPage(deps: CollectionDeps, page: Page) {
  try {
    const fares = await fetchPublishedFares({ ...page, allDestinations: true, now: deps.now }, deps.fetchFn);
    await deps.cache?.put(page.sourceUrl, fares);
    const offers: Offer[] = [];
    for (const fare of fares.slice(0, 500)) {
      if (fare.structure !== "roundtrip" || !fare.returnDate) continue;
      offers.push(...matchPublishedTrip([fare], { origin: fare.origin, destination: fare.destination,
        departDate: fare.departDate, returnDate: fare.returnDate, party: { adults: 1, children: 0, infants: 0 } }, page));
    }
    if (offers.length) await deps.repo.savePrices(offers, { skipUnchangedSince: new Date(deps.now.getTime() - 3_600_000).toISOString(), skipUnchangedPublishedSince: new Date(deps.now.getTime() - 86_400_000).toISOString() });
    return { source: page.source, ok: true, fares: fares.length, saved: offers.length };
  } catch {
    // A failed airline or storage write cannot cancel unrelated scheduled tasks.
    return { source: page.source, ok: false, fares: 0, saved: 0 };
  }
}
