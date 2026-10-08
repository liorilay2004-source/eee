/** The observed official LHR–DUS calendar. Amounts are per direction and adult. */
export interface EurowingsCalendarFare {
  origin: "LHR" | "DUS";
  destination: "LHR" | "DUS";
  date: string;
  amount: number;
  currency: "GBP";
  checkedAt: string;
  pricing: "advertised_calendar_price";
}

const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const route = (v: unknown) => object(v) && v.origin === "LHR" && v.destination === "DUS" && v.airlineCode === "EW";
const amount = (v: unknown): number | null => object(v) && typeof v.raw === "number" && Number.isFinite(v.raw) && v.raw > 0 ? v.raw : null;

export function parseEurowingsCalendar(input: unknown, now: Date): EurowingsCalendarFare[] {
  if (!object(input) || !object(input.header) || input.header.code !== "SUCCESS" || input.header.statusCode !== 200 ||
      !object(input.meta) || !route(input.meta.stations) || !Array.isArray(input.sections) || input.sections.length !== 2) return [];
  const sections = input.sections;
  if (sections.some(s => !object(s) || !object(s.meta) || !route(s.meta.stations) || !Array.isArray(s.bookableMonths)) ||
      sections.filter(s => object(s) && s.type === "outbound").length !== 1 ||
      sections.filter(s => object(s) && s.type === "inbound").length !== 1) return [];
  const today = now.toISOString().slice(0, 10);
  const fares: EurowingsCalendarFare[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    if (!object(section) || !Array.isArray(section.bookableMonths) || section.bookableMonths.length > 24) return [];
    for (const month of section.bookableMonths) {
      if (!object(month) || month.bookable !== true || !Number.isInteger(month.year) || !Number.isInteger(month.month) ||
          (month.year as number) < 2020 || (month.year as number) > 2100 || (month.month as number) < 1 || (month.month as number) > 12 ||
          !Array.isArray(month.expandedDates) || month.expandedDates.length > 31) continue;
      for (const day of month.expandedDates) {
        if (!object(day) || !Number.isInteger(day.date) || day.currency !== "GBP" || typeof day.promocode !== "boolean") continue;
        // The page advertises a member promotion. Retain only the explicit ordinary
        // amount when promo is set; do not claim the discounted price for every user.
        const price = amount(day.promocode ? day.noDiscountPrice : day.price);
        const date = `${month.year}-${String(month.month).padStart(2, "0")}-${String(day.date).padStart(2, "0")}`;
        const time = Date.parse(date);
        if (price === null || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date || date < today) continue;
        const key = `${section.type}:${date}`;
        if (seen.has(key)) return []; // ambiguous duplicate day fails closed
        seen.add(key);
        fares.push({origin: section.type === "outbound" ? "LHR" : "DUS", destination: section.type === "outbound" ? "DUS" : "LHR",
          date, amount: price, currency: "GBP", checkedAt: now.toISOString(), pricing: "advertised_calendar_price"});
      }
    }
  }
  return fares;
}

/** Browser Run returns the JSON document rendered inside a pre element. */
export function parseEurowingsRenderedCalendar(html: string, now: Date): EurowingsCalendarFare[] {
  if (html.length > 500_000) return [];
  const pre = /<pre(?:\s[^>]*)?>([\s\S]*?)<\/pre>/i.exec(html)?.[1];
  if (!pre) return [];
  const json = pre.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  try { return parseEurowingsCalendar(JSON.parse(json), now); } catch { return []; }
}
