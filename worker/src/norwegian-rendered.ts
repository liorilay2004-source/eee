import type { Env } from "./types";
import type { PublicFareCache } from "./public-fare-cache";
import {parseNorwegianCalendarHtml} from "./norwegian-calendar";
export const NORWEGIAN_PAGE = "https://www.norwegian.com/en/low-fare-calendar/Athens-OsloGardermoen";
export const norwegianCacheKey = (month: string) => `${NORWEGIAN_PAGE}?month=${month}`;
/** Observed official month parameters, fixed route, background only. */
export async function loadRenderedNorwegian(browser: NonNullable<Env["BROWSER"]>, month: string): Promise<string> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid calendar month");
  const value = month.replace("-", "");
  const response = await browser.quickAction("content", {
    url: `${NORWEGIAN_PAGE}?D_Month=${value}&R_Month=${value}&AdultCount=1&CurrencyCode=EUR`,
    gotoOptions: {waitUntil:"domcontentloaded",timeout:15000},waitForTimeout:3000,
    rejectResourceTypes:["image","font","media"],
  });
  if (!response.ok || !response.body) throw new Error("Official calendar rendering failed");
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try {for (;;) {const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>4_000_000)throw new Error("Calendar rendering too large");chunks.push(part.value);}}
  finally {await reader.cancel();}
  const joined=new Uint8Array(size);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}
  const envelope=JSON.parse(new TextDecoder().decode(joined)) as {success?:unknown;result?:unknown};
  if(envelope.success!==true||typeof envelope.result!=="string")throw new Error("Invalid calendar rendering");
  const expected=`D_City=ATH&amp;A_City=OSL&amp;D_Month=${value}&amp;R_Month=${value}&amp;AdultCount=1&amp;CurrencyCode=EUR`;
  if(!envelope.result.includes(expected))throw new Error("Calendar route or month mismatch");
  return envelope.result;
}

/** Persist one complete monthly snapshot; failed/empty renders never overwrite valid data. */
export async function collectNorwegianMonth(env: Pick<Env,"BROWSER"|"DB">, month:string, now:Date, cache?:PublicFareCache) {
  if(!env.BROWSER)return {ok:false,fares:0};
  const html=await loadRenderedNorwegian(env.BROWSER,month);
  const fares=parseNorwegianCalendarHtml(html,month,now);
  if(!fares.length)return {ok:false,fares:0};
  await cache?.put(norwegianCacheKey(month),fares);
  await env.DB.prepare("INSERT INTO public_calendar_snapshots (source,origin,destination,month,fares_json,checked_at) VALUES (?,?,?,?,?,?) ON CONFLICT(source,origin,destination,month) DO UPDATE SET fares_json=excluded.fares_json,checked_at=excluded.checked_at")
    .bind("norwegian","ATH","OSL",month,JSON.stringify(fares),now.toISOString()).run();
  return {ok:true,fares:fares.length};
}
