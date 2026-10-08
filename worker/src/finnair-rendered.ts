import type { Env } from "./types";
import { type PublishedFare } from "./sources/published-fares";
import { FINNAIR_PAGE, parseFinnairFares } from "./finnair-fares";
/** Fixed official origin page. Background caller only; never accepts user URLs. */
export async function loadRenderedFinnair(browser: NonNullable<Env["BROWSER"]>, now: Date): Promise<PublishedFare[]> {
  const response = await browser.quickAction("content", {
    url: FINNAIR_PAGE,
    gotoOptions: { waitUntil: "domcontentloaded", timeout: 10000 },
    waitForTimeout: 2000,
    rejectResourceTypes: ["image", "font", "media"],
  });
  if (!response.ok) throw new Error("Official rendering failed");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing rendering payload");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4_000_000) throw new Error("Rendering payload too large");
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  const joined = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  const envelope = JSON.parse(new TextDecoder().decode(joined)) as { success?: unknown; result?: unknown };
  if (envelope.success !== true || typeof envelope.result !== "string") throw new Error("Invalid rendering response");
  return parseFinnairFares(envelope.result, now);
}

import type { Repo } from "./types";
import type { PublicFareCache } from "./public-fare-cache";
import { matchPublishedTrip } from "./sources/published-source";
import { finnairCacheKey } from "./sources/finnair-cached";
export async function collectRenderedFinnair(deps:{env:Env;repo:Pick<Repo,"savePrices">;now:Date;cache?:PublicFareCache}){
 const empty={source:"finnair",ok:true,fares:0,saved:0};
 if(deps.env.FINNAIR_RENDERED_ENABLED!=="true"||!deps.env.BROWSER)return {...empty,skipped:true};
 let saved=0;
 try {
 const fares=await loadRenderedFinnair(deps.env.BROWSER,deps.now);
 const destinations=new Set(fares.map(f=>f.destination));
 for(const destination of destinations){const route=fares.filter(f=>f.destination===destination);for(let i=0;i<route.length;i+=500)await deps.cache?.put(finnairCacheKey(destination,i/500),route.slice(i,i+500));}
 const offers=fares.flatMap(f=>f.returnDate?matchPublishedTrip([f],{origin:f.origin,destination:f.destination,departDate:f.departDate,returnDate:f.returnDate,party:{adults:1,children:0,infants:0}},{airline:"AY",source:"finnair"}):[]);
 for(let i=0;i<offers.length;i+=100){const chunk=offers.slice(i,i+100);await deps.repo.savePrices(chunk,{skipUnchangedSince:new Date(deps.now.getTime()-86400000).toISOString()});saved+=chunk.length;}
 return {...empty,ok:offers.length>0,fares:fares.length,saved};
 }catch{return {...empty,ok:false,saved};}
}
