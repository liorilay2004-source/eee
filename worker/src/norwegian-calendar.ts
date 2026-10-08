export interface NorwegianCalendarFare {
  origin: string; destination: string; date: string; amount: number; currency: "EUR";
  stops: number; checkedAt: string; pricing: "advertised_calendar_price";
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** The response does not echo airports: callers must bind it to the observed request. */
export function parseNorwegianCalendar(data: unknown, query: {origin:string;destination:string;month:string}, now: Date): NorwegianCalendarFare[] {
  if (!record(data) || data.currencyCode !== "EUR" || !["ATH:OSL", "OSL:ATH"].includes(`${query.origin}:${query.destination}`) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(query.month)) return [];
  const result: NorwegianCalendarFare[] = [];
  for (const [direction, origin, destination] of [["outbound",query.origin,query.destination],["inbound",query.destination,query.origin]] as const) {
    const calendar = data[direction];
    if (!record(calendar) || !Array.isArray(calendar.days)) continue;
    if (calendar.days.length > 31) throw new Error("Calendar response too large");
    for (const row of calendar.days) {
      if (!record(row) || typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(row.date)) continue;
      const date = row.date.slice(0,10);
      if (!date.startsWith(`${query.month}-`) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date || date < now.toISOString().slice(0,10)) continue;
      if (row.isSoldOut !== false || row.isAgreementPrice !== false || row.isInterliningRoute !== false || typeof row.price !== "number" || !Number.isFinite(row.price) || row.price <= 0 || !Number.isInteger(row.transitCount) || (row.transitCount as number) < 0 || (row.transitCount as number) > 3) continue;
      result.push({origin,destination,date,amount:row.price,currency:"EUR",stops:row.transitCount as number,checkedAt:now.toISOString(),pricing:"advertised_calendar_price"});
    }
  }
  return result;
}
