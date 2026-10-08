/** Published official airline page data. Never evaluates page scripts or copies
 * unrelated configuration. A headline "from" price is not an exact-date quote.
 */
export interface PublishedFare {
  airline: string;
  origin: string;
  destination: string;
  departDate: string;
  returnDate: string | null;
  amount: number;
  currency: string;
  structure: "oneway" | "roundtrip";
  sourceUrl: string;
  checkedAt: string;
  /** Upstream's relative price age; fetching the page does not reset this age. */
  upstreamPriceAge?: { value: number; unit: "minutes" | "hours" | "days" };
  pricing: "published_advertisement";
}
const officialHosts: Readonly<Record<string, string>> = { KC: "bestfares.airastana.com", F9: "flights.flyfrontier.com", B6: "www.jetblue.com", A3: "flights.aegeanair.com", AC: "www.aircanada.com", TP: "www.flytap.com", ET: "www.ethiopianairlines.com", UX: "www.aireuropa.com", PR: "flights.philippineairlines.com", VS: "flights.virginatlantic.com", NZ: "www.airnewzealand.com", BT: "www.airbaltic.com", GQ: "www.skyexpress.gr", G3: "www.voegol.com.br", EI: "www.aerlingus.com", AA: "www.aa.com", KL: "www.klm.co.il", AM: "www.aeromexico.com", CM: "www.copaair.com", FI: "www.icelandair.com", TK: "www.turkishairlines.com" };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

export function publishedFareUrl(url: string, airline: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== officialHosts[airline] || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) throw new Error("Unsupported official fare page");
  return parsed;
}

export function parsePublishedFares(html: string, query: { airline: string; origin: string; destination: string; sourceUrl: string; now: Date; allDestinations?: boolean; origins?: readonly string[] }): PublishedFare[] {
  publishedFareUrl(query.sourceUrl, query.airline);
  if (!/^[A-Z]{3}$/.test(query.origin) || !/^[A-Z]{3}$/.test(query.destination)) throw new Error("Invalid airport");
  if (query.origins && (query.origins.length > 10 || query.origins.some(origin => !/^[A-Z]{3}$/.test(origin)))) throw new Error("Invalid origins");
  if (html.length > (query.airline === "AA" ? 3_000_000 : 2_000_000)) throw new Error("Official page too large");
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi);
  let data: unknown;
  for (const script of scripts) {
    if (/\bid\s*=\s*["']__NEXT_DATA__["']/i.test(script[1] ?? "")) {
      try { data = JSON.parse(script[2] ?? ""); } catch { throw new Error("Invalid published fare data"); }
      break;
    }
  }
  if (data === undefined) return [];
  const queue: unknown[] = [data];
  const fares: PublishedFare[] = [];
  const seen = new Set<string>();
  let visited = 0;
  const today = query.now.toISOString().slice(0, 10);
  while (queue.length) {
    if (++visited > 100_000) throw new Error("Published data too complex");
    let node = queue.pop();
    if (!record(node) && !Array.isArray(node)) continue;
    // The official daily histogram carries explicit one-way cash economy fares.
    // Normalize only fully identified flight records; month-level minima cannot match this shape.
    if (record(node) && query.airline === "A3" && node.journeyType === "ONE_WAY" && record(node.outboundFlight)
      && node.outboundFlight.fareClass === "ECONOMY" && record(node.priceSpecification)
      && record(node.airline) && node.airline.iataCode === query.airline && node.isPastDay !== true
      && (node.redemption == null || node.redemption === false)) {
      node = { __typename: "Fare", originAirportCode: node.outboundFlight.departureAirportIataCode,
        destinationAirportCode: node.outboundFlight.arrivalAirportIataCode, departureDate: node.departureDate,
        returnDate: null, totalPrice: node.priceSpecification.totalPrice, currencyCode: node.priceSpecification.currencyCode,
        travelClass: "ECONOMY", flightType: "ONE_WAY", redemption: null };
    }
    if (record(node) && node.__typename === "Fare" && (query.airline !== "F9" || node.travelClass === "ECONOMY" && (node.promoCode == null || node.promoCode === "") && ![node.formattedTravelClass,node.brandedFareClass].some(v=>typeof v==="string"&&/discount\s*den|go\s*wild|member/i.test(v))) && (query.airline !== "TK" || node.travelClass === "ECONOMY" && (node.promoCode == null || node.promoCode === "")) && (query.airline !== "FI" || node.travelClass === "eco" && (node.promoCode == null || node.promoCode === "")) && (node.redemption == null || node.redemption === false) && (node.travelClass == null || typeof node.travelClass === "string" && (node.travelClass.toUpperCase() === "ECONOMY" || query.airline === "B6" && node.travelClass === "DN" && node.farenetTravelClass === "ECONOMY" && node.formattedTravelClass === "Main" && (node.promoCode == null || node.promoCode === "") || query.airline === "AM" && ["MAIN_BASIC", "MAIN_CLASSIC"].includes(node.travelClass) || query.airline === "EI" && node.travelClass === "low" && node.flightType === "ONE_WAY" || ["PR", "FI"].includes(query.airline) && node.travelClass === "eco" || query.airline === "VS" && ["Economy Classic", "Economy Classic Flex"].includes(node.travelClass))) && typeof node.originAirportCode === "string" && (node.originAirportCode === query.origin || query.origins?.includes(node.originAirportCode)) && typeof node.destinationAirportCode === "string" && /^[A-Z]{3}$/.test(node.destinationAirportCode) && (query.allDestinations || node.destinationAirportCode === query.destination) && date(node.departureDate) && node.departureDate >= today && typeof node.totalPrice === "number" && Number.isFinite(node.totalPrice) && node.totalPrice > 0 && typeof node.currencyCode === "string" && /^[A-Z]{3}$/.test(node.currencyCode)) {
      const isOneWay = node.flightType === "ONE_WAY" && (node.returnDate === "" || node.returnDate == null);
      const isRoundTrip = query.airline !== "EI" && node.flightType === "ROUND_TRIP" && date(node.returnDate) && node.returnDate > node.departureDate;
      if (isOneWay || isRoundTrip) {
        const fare: PublishedFare = { airline: query.airline, origin: node.originAirportCode, destination: node.destinationAirportCode,
          departDate: node.departureDate, returnDate: isRoundTrip ? node.returnDate as string : null,
          amount: node.totalPrice, currency: node.currencyCode, structure: isOneWay ? "oneway" : "roundtrip",
          sourceUrl: query.sourceUrl, checkedAt: query.now.toISOString(), pricing: "published_advertisement" };
        if(record(node.priceLastSeen)){
          const value=typeof node.priceLastSeen.value==='string'&&/^\d+$/.test(node.priceLastSeen.value)?Number(node.priceLastSeen.value):node.priceLastSeen.value;
          const unit=node.priceLastSeen.unit;
          if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=36500&&(unit==='minutes'||unit==='hours'||unit==='days'))fare.upstreamPriceAge={value,unit};
        }
        const key = JSON.stringify([fare.origin, fare.destination, fare.departDate, fare.returnDate, fare.currency, fare.amount]);
        if (!seen.has(key)) { seen.add(key); fares.push(fare); }
      }
    }
    if (record(node) || Array.isArray(node)) queue.push(...Object.values(node));
  }
  return fares;
}

export async function fetchPublishedFares(query: Parameters<typeof parsePublishedFares>[1], fetchFn: typeof fetch): Promise<PublishedFare[]> {
  const response = await fetchFn(publishedFareUrl(query.sourceUrl, query.airline), { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { Accept: "text/html" } });
  if (!response.ok) throw new Error(`Official page HTTP ${response.status}`);
  return parsePublishedFares(await response.text(), query);
}
