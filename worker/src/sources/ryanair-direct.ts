/** Direct website data, observed in Ryanair's official fare-finder bundle.
 * Monthly calendars are one-adult advertised fares, not a reserved whole-party quote.
 * Never multiply them and claim that all passengers can buy at that price.
 */
export interface DirectFare {
  airline: "FR";
  origin: string;
  destination: string;
  date: string;
  departure: string;
  arrival: string | null;
  amount: number;
  currency: "EUR";
  checkedAt: string;
  sourceUrl: string;
  pricing: "advertised_one_adult";
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const airport = /^[A-Z]{3}$/;
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const localTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

export function ryanairCalendarUrl(origin: string, destination: string, month: string): string {
  if (!airport.test(origin) || !airport.test(destination) || !monthPattern.test(month) || origin === destination) throw new Error("Invalid route or month");
  return `https://www.ryanair.com/api/farfnd/v4/oneWayFares/${origin}/${destination}/cheapestPerDay?outboundMonthOfDate=${month}-01&currency=EUR`;
}

export function parseRyanairCalendar(body: unknown, origin: string, destination: string, month: string, now: Date): DirectFare[] {
  const sourceUrl = ryanairCalendarUrl(origin, destination, month);
  if (!record(body) || !record(body.outbound) || !Array.isArray(body.outbound.fares)) throw new Error("Invalid fare calendar");
  return body.outbound.fares.flatMap((row): DirectFare[] => {
    if (!record(row) || row.unavailable === true || row.soldOut === true || !record(row.price)) return [];
    const { day, departureDate, arrivalDate } = row;
    if (typeof day !== "string" || !day.startsWith(`${month}-`) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
    const parsedDay = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day) return [];
    if (typeof departureDate !== "string" || !localTime.test(departureDate) || departureDate.slice(0, 10) !== day) return [];
    if (typeof row.price.value !== "number" || !Number.isFinite(row.price.value) || row.price.value <= 0 || row.price.currencyCode !== "EUR") return [];
    return [{ airline: "FR", origin, destination, date: day, departure: departureDate,
      arrival: typeof arrivalDate === "string" && localTime.test(arrivalDate) ? arrivalDate : null,
      amount: row.price.value, currency: "EUR", checkedAt: now.toISOString(), sourceUrl, pricing: "advertised_one_adult" }];
  });
}

/** Fixed official host, no credentials, redirects or unbounded retries. */
export async function fetchRyanairCalendar(origin: string, destination: string, month: string, now: Date, fetchFn: typeof fetch = fetch): Promise<DirectFare[]> {
  const response = await fetchFn(ryanairCalendarUrl(origin, destination, month), {
    headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Ryanair HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 100_000) throw new Error("Fare calendar too large");
  return parseRyanairCalendar(JSON.parse(text), origin, destination, month, now);
}
