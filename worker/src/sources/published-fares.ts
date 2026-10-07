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
  pricing: "published_advertisement";
}
const officialHosts: Readonly<Record<string, string>> = { A3: "flights.aegeanair.com", AC: "www.aircanada.com" };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

export function publishedFareUrl(url: string, airline: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== officialHosts[airline] || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) throw new Error("Unsupported official fare page");
  return parsed;
}

export function parsePublishedFares(html: string, query: { airline: string; origin: string; destination: string; sourceUrl: string; now: Date }): PublishedFare[] {
  publishedFareUrl(query.sourceUrl, query.airline);
  if (!/^[A-Z]{3}$/.test(query.origin) || !/^[A-Z]{3}$/.test(query.destination)) throw new Error("Invalid airport");
  if (html.length > 2_000_000) throw new Error("Official page too large");
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
    const node = queue.pop();
    if (!record(node) && !Array.isArray(node)) continue;
    if (record(node) && node.__typename === "Fare" && (node.redemption == null || node.redemption === false) && (node.travelClass == null || node.travelClass === "ECONOMY") && node.originAirportCode === query.origin && node.destinationAirportCode === query.destination && date(node.departureDate) && node.departureDate >= today && typeof node.totalPrice === "number" && Number.isFinite(node.totalPrice) && node.totalPrice > 0 && typeof node.currencyCode === "string" && /^[A-Z]{3}$/.test(node.currencyCode)) {
      const isOneWay = node.flightType === "ONE_WAY" && (node.returnDate === "" || node.returnDate == null);
      const isRoundTrip = node.flightType === "ROUND_TRIP" && date(node.returnDate) && node.returnDate > node.departureDate;
      if (isOneWay || isRoundTrip) {
        const fare: PublishedFare = { airline: query.airline, origin: query.origin, destination: query.destination,
          departDate: node.departureDate, returnDate: isRoundTrip ? node.returnDate as string : null,
          amount: node.totalPrice, currency: node.currencyCode, structure: isOneWay ? "oneway" : "roundtrip",
          sourceUrl: query.sourceUrl, checkedAt: query.now.toISOString(), pricing: "published_advertisement" };
        const key = JSON.stringify([fare.departDate, fare.returnDate, fare.currency, fare.amount]);
        if (!seen.has(key)) { seen.add(key); fares.push(fare); }
      }
    }
    queue.push(...Object.values(node));
  }
  return fares;
}

export async function fetchPublishedFares(query: Parameters<typeof parsePublishedFares>[1], fetchFn: typeof fetch): Promise<PublishedFare[]> {
  const response = await fetchFn(publishedFareUrl(query.sourceUrl, query.airline), { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { Accept: "text/html" } });
  if (!response.ok) throw new Error(`Official page HTTP ${response.status}`);
  return parsePublishedFares(await response.text(), query);
}
