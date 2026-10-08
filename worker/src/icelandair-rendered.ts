import type { Env, Repo } from "./types";
import type { PublicFareCache } from "./public-fare-cache";
import { parsePublishedFares, type PublishedFare } from "./sources/published-fares";
import { matchPublishedTrip } from "./sources/published-source";
export const ICELANDAIR_PAGE = "https://www.icelandair.com/en-gb/flights/flights-from-london-to-iceland";

/** Observed airport-specific cash economy advertisements; city-only LON/REK records are excluded. */
export function parseIcelandairFares(html: string, now: Date): PublishedFare[] {
  return parsePublishedFares(html, {airline:"FI",origin:"LHR",origins:["LHR","LGW"],destination:"KEF",sourceUrl:ICELANDAIR_PAGE,now});
}

export async function loadRenderedIcelandair(browser: NonNullable<Env["BROWSER"]>, now: Date): Promise<PublishedFare[]> {
  const response = await browser.quickAction("content", {url:ICELANDAIR_PAGE,gotoOptions:{waitUntil:"domcontentloaded",timeout:15000},waitForTimeout:2000,rejectResourceTypes:["image","font","media"]});
  if (!response.ok || !response.body) throw new Error("Official rendering failed");
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
  try {for (;;) {const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>4_000_000)throw new Error("Rendering payload too large");chunks.push(part.value);}}
  finally {await reader.cancel();}
  const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}
  const envelope=JSON.parse(new TextDecoder().decode(joined)) as {success?:unknown;result?:unknown};
  if(envelope.success!==true||typeof envelope.result!=="string")throw new Error("Invalid rendering response");
  return parseIcelandairFares(envelope.result,now);
}

export async function collectRenderedIcelandair(deps:{env:Env;repo:Pick<Repo,"savePrices">;now:Date;cache?:PublicFareCache}) {
  const empty={source:"icelandair",ok:true,fares:0,saved:0};
  if(deps.env.ICELANDAIR_RENDERED_ENABLED!=="true"||!deps.env.BROWSER)return {...empty,skipped:true};
  try {
    const fares=await loadRenderedIcelandair(deps.env.BROWSER,deps.now);
    if(!fares.length)return {...empty,ok:false};
    await deps.cache?.put(ICELANDAIR_PAGE,fares);
    const offers=fares.flatMap(f=>f.returnDate?matchPublishedTrip([f],{origin:f.origin,destination:f.destination,departDate:f.departDate,returnDate:f.returnDate,party:{adults:1,children:0,infants:0}},{airline:"FI",source:"icelandair"}):[]);
    try {
      await deps.repo.savePrices(offers,{skipUnchangedPublishedSince:new Date(deps.now.getTime()-86_400_000).toISOString()});
      return {...empty,fares:fares.length,saved:offers.length};
    } catch { return {...empty,fares:fares.length,historyUnavailable:true}; }
  } catch {return {...empty,ok:false};}
}
