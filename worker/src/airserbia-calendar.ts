import type { PricedDirection } from "./direct-combinations";
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** Official public one-way calendar advertisements, not held booking inventory. */
export function parseAirSerbiaCalendar(data: unknown, q: { origin: string; destination: string; year: number; month: number; now: Date }): PricedDirection[] {
  if (!record(data) || data.origin !== q.origin || data.destination !== q.destination || data.year !== q.year || data.month !== q.month || data.source !== "db" || !record(data.prices)) return [];
  if (!/^[A-Z]{3}$/.test(q.origin) || !/^[A-Z]{3}$/.test(q.destination) || q.origin === q.destination || q.month < 1 || q.month > 12 || !Number.isInteger(q.year)) return [];
  const month = `${q.year}-${String(q.month).padStart(2, "0")}`;
  const today = q.now.toISOString().slice(0, 10);
  return Object.entries(data.prices).flatMap(([date, item]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || !date.startsWith(`${month}-`) || date < today || !record(item) || item.soldOut !== false || typeof item.price !== "number" || !Number.isFinite(item.price) || item.price <= 0 || item.currency !== "EUR") return [];
    return [{ source: "air_serbia", airline: "JU", origin: q.origin, destination: q.destination, date, amount: item.price, currency: "EUR", checkedAt: q.now.toISOString(), bookingUrl: "https://www.airserbia.com/en/booking" }];
  });
}
