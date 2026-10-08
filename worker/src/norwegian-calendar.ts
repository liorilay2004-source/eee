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

/** Rendered public low-fare tables. Transit rows are excluded: HTML does not expose the stop count. */
export function parseNorwegianCalendarHtml(html: string, month: string, now: Date): NorwegianCalendarFare[] {
  if(html.length>4_000_000)throw new Error("Calendar HTML too large");
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return [];
  const compact=month.replace("-","");
  if(!html.includes(`D_City=ATH&amp;A_City=OSL&amp;D_Month=${compact}&amp;R_Month=${compact}&amp;AdultCount=1&amp;CurrencyCode=EUR`))return [];
  const clean=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"");
  const body:Record<string,unknown>={currencyCode:"EUR"};
  const months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  for(const [label,key,route] of [["Outbound","outbound","from Athens (ATH)"],["Return","inbound","from Oslo-Gardermoen (OSL)"]] as const){
    const section=new RegExp(`<h2\\b[^>]*>${label}</h2>([\\s\\S]*?)</table>`,"g");
    const matches=[...clean.matchAll(section)];if(matches.length!==1)return [];
    const table=matches[0]![1]!;if(!table.includes(route)||!table.includes('class="lowfare-calendar__table'))return [];
    const days=[];
    for(const button of table.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)){
      if(/\bdisabled(?:\s|=|$)/.test(button[1]!)||/Is transit|Sold out/.test(button[2]!))continue;
      const dates=[...button[2]!.matchAll(/aria-label="(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})"/g)];
      const amounts=[...button[2]!.matchAll(/aria-label="Fare is (\d+(?:\.\d{1,2})?)"/g)];
      if(dates.length!==1||amounts.length!==1)continue;
      const d=dates[0]!;const date=`${d[3]}-${String(months.indexOf(d[1]!)+1).padStart(2,"0")}-${d[2]!.padStart(2,"0")}T00:00:00`;
      days.push({date,price:Number(amounts[0]![1]),isSoldOut:false,isAgreementPrice:false,isInterliningRoute:false,transitCount:0});
    }
    body[key]={days};
  }
  return parseNorwegianCalendar(body,{origin:"ATH",destination:"OSL",month},now);
}
