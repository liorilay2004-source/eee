import type { FareQuoteSource } from "../quotes";
import type { Leg } from "../types";
import type { NorwegianCalendarFare } from "../norwegian-calendar";
import { NORWEGIAN_PAGE, norwegianCacheKey } from "../norwegian-rendered";
import type { PublicFareCache } from "../public-fare-cache";

/** One observed public route. No operating carrier, baggage or departure time is inferred. */
export function createNorwegianCachedSource(db: D1Database, now: Date, cache?: PublicFareCache): FareQuoteSource {
  const pending = new Map<string, Promise<NorwegianCalendarFare[]>>();
  const load = (month: string) => {
    if (!pending.has(month)) pending.set(month, (async () => {
      const hot = await cache?.get<NorwegianCalendarFare>(norwegianCacheKey(month));
      const row = hot?.fares.length ? {fares_json:JSON.stringify(hot.fares),checked_at:hot.fares[0]!.checkedAt} : await db.prepare("SELECT fares_json,checked_at FROM public_calendar_snapshots WHERE source=? AND origin=? AND destination=? AND month=?")
        .bind("norwegian", "ATH", "OSL", month).first<{fares_json:string;checked_at:string}>();
      if (!row || typeof row.fares_json !== "string" || row.fares_json.length > 100_000) return [];
      const age = now.getTime() - Date.parse(row.checked_at);
      if (!Number.isFinite(age) || age < 0 || age > 36 * 3_600_000) return [];
      let data: unknown;
      try { data = JSON.parse(row.fares_json); } catch { return []; }
      if (!Array.isArray(data) || data.length > 62) return [];
      return data.filter((fare): fare is NorwegianCalendarFare => fare && typeof fare === "object" &&
        ["ATH:OSL","OSL:ATH"].includes(`${fare.origin}:${fare.destination}`) &&
        typeof fare.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fare.date) && fare.date.startsWith(`${month}-`) &&
        Number.isFinite(Date.parse(fare.date)) && new Date(fare.date).toISOString().slice(0,10) === fare.date && fare.date >= now.toISOString().slice(0,10) &&
        typeof fare.amount === "number" && Number.isFinite(fare.amount) && fare.amount > 0 && fare.currency === "EUR" &&
        Number.isInteger(fare.stops) && fare.stops >= 0 && fare.stops <= 3 && fare.checkedAt === row.checked_at && fare.pricing === "advertised_calendar_price");
    })().catch(() => []));
    return pending.get(month)!;
  };
  const leg = (fare: NorwegianCalendarFare): Leg => ({departTime:null,arriveTime:null,durationMin:null,stops:fare.stops,airlines:[]});
  return {name:"norwegian",configured:true,quota:{period:"monthly",cap:0,allowance:0},callCount:()=>0,nextQuoteRequests:()=>0,
    async quote(q) {
      if (q.origin !== "ATH" || q.destination !== "OSL" || q.party.adults !== 1 || q.party.children || q.party.infants) return [];
      const months = [...new Set([q.departDate.slice(0,7),q.returnDate.slice(0,7)])];
      const rows = (await Promise.all(months.map(load))).flat();
      const out = rows.find(f=>f.origin===q.origin && f.destination===q.destination && f.date===q.departDate);
      const back = rows.find(f=>f.origin===q.destination && f.destination===q.origin && f.date===q.returnDate);
      if (!out || !back) return [];
      return [{origin:q.origin,destination:q.destination,departDate:q.departDate,returnDate:q.returnDate,source:"norwegian",
        priceAmount:Math.round((out.amount+back.amount)*100)/100,priceCurrency:"EUR",ticketStructure:"roundtrip",outbound:leg(out),inbound:leg(back),
        includes:{},deeplink:NORWEGIAN_PAGE,verifyLink:null,checkedAt:out.checkedAt<back.checkedAt?out.checkedAt:back.checkedAt,
        totalIls:null,extrasAmountIls:0,tags:["published_advertisement","advertised_calendar_price"]}];
    }
  };
}

/** Rotate the thirteen calendar months within the supported one-year search horizon. */
export function norwegianCollectionMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+now.getUTCHours()%13,1)).toISOString().slice(0,7);
}
