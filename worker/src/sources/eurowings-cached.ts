import type { FareQuoteSource } from "../quotes";
import type { PublicFareCache } from "../public-fare-cache";
import type { EurowingsCalendarFare } from "../eurowings-calendar";
import { EUROWINGS_PAGE, eurowingsCacheKey } from "../eurowings-rendered";
import type { Leg } from "../types";

export function createEurowingsCachedSource(db: D1Database, now: Date, cache?: PublicFareCache): FareQuoteSource {
  const pending = new Map<string, Promise<EurowingsCalendarFare[]>>();
  const load = (month: string): Promise<EurowingsCalendarFare[]> => {
    if (!pending.has(month)) pending.set(month, (async () => {
      const hot = await cache?.get<EurowingsCalendarFare>(eurowingsCacheKey(month));
      let data: unknown = hot?.fares;
      if (!data) {
        const row = await db.prepare("SELECT fares_json,checked_at FROM public_calendar_snapshots WHERE source=? AND origin=? AND destination=? AND month=?")
          .bind("eurowings","LHR","DUS",month).first<{fares_json:string;checked_at:string}>();
        if (!row || typeof row.fares_json !== "string" || row.fares_json.length > 100_000) return [];
        data = JSON.parse(row.fares_json);
        if (!Array.isArray(data) || data.some(f => f?.checkedAt !== row.checked_at)) return [];
      }
      if (!Array.isArray(data) || data.length > 62) return [];
      return data.filter((f): f is EurowingsCalendarFare => {
        if (!f || typeof f !== "object" || !["LHR:DUS","DUS:LHR"].includes(`${f.origin}:${f.destination}`) ||
            typeof f.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(f.date) || !f.date.startsWith(`${month}-`) ||
            f.date < now.toISOString().slice(0,10) || !Number.isFinite(Date.parse(f.date)) || new Date(f.date).toISOString().slice(0,10) !== f.date ||
            typeof f.amount !== "number" || !Number.isFinite(f.amount) || f.amount <= 0 || f.currency !== "GBP" ||
            f.pricing !== "advertised_calendar_price" || typeof f.checkedAt !== "string") return false;
        const age = now.getTime() - Date.parse(f.checkedAt);
        return Number.isFinite(age) && age >= 0 && age <= 36 * 3_600_000;
      });
    })().catch(() => []));
    return pending.get(month)!;
  };
  const leg = (): Leg => ({departTime:null,arriveTime:null,durationMin:null,stops:null,airlines:[]});
  return {name:"eurowings",configured:true,quota:{period:"monthly",cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,
    async quote(q) {
      if (!["LHR:DUS","DUS:LHR"].includes(`${q.origin}:${q.destination}`) || q.party.adults !== 1 || q.party.children || q.party.infants || q.returnDate <= q.departDate) return [];
      const rows = (await Promise.all([...new Set([q.departDate.slice(0,7),q.returnDate.slice(0,7)])].map(load))).flat();
      const out = rows.find(f=>f.origin===q.origin && f.destination===q.destination && f.date===q.departDate);
      const back = rows.find(f=>f.origin===q.destination && f.destination===q.origin && f.date===q.returnDate);
      if (!out || !back) return [];
      return [{origin:q.origin,destination:q.destination,departDate:q.departDate,returnDate:q.returnDate,source:"eurowings",
        priceAmount:Math.round((out.amount+back.amount)*100)/100,priceCurrency:"GBP",ticketStructure:"roundtrip",outbound:leg(),inbound:leg(),
        includes:{},deeplink:EUROWINGS_PAGE,verifyLink:null,checkedAt:out.checkedAt<back.checkedAt?out.checkedAt:back.checkedAt,
        totalIls:null,extrasAmountIls:0,tags:["published_advertisement","advertised_calendar_price"]}];
    }
  };
}
