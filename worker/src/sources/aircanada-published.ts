import type { PublicFareCache } from "../public-fare-cache";
import { createPublishedSource, type PublishedSourceConfig } from "./published-source";
import {EXTERNAL_PUBLISHED_PAGES} from "../external-published-catalog";
// Toronto's page heading uses YTO, but its dated fares specify YYZ.
export function createAirCanadaPublishedSource(now: Date, fetchFn: typeof fetch, sharedCache?: PublicFareCache) {
  const routes:Record<string,PublishedSourceConfig["routes"][string]>={
    "TLV:YYZ": [{ origin: "TLV", destination: "YYZ", sourceUrl: "https://www.aircanada.com/en-ca/flights-from-tel-aviv-to-toronto" }],
    "TLV:YUL": [{ origin: "TLV", destination: "YUL", sourceUrl: "https://www.aircanada.com/en-ca/flights-from-tel-aviv", allDestinations: true }],
    "TLV:ORD": [{ origin: "TLV", destination: "ORD", sourceUrl: "https://www.aircanada.com/en-ca/flights-from-tel-aviv", allDestinations: true }],
  };
  for(const page of EXTERNAL_PUBLISHED_PAGES.filter(page=>page.airline==="AC"&&!page.allDestinations)){
    const key=`${page.origin}:${page.destination}`;
    const prior=routes[key]??[];
    if(!prior.length)routes[key]=[page];
  }
  return createPublishedSource({source:"air_canada",airline:"AC",routes},now,fetchFn,sharedCache);
}
