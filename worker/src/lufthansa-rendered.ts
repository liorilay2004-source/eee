import {saveLhgSnapshots} from "./lhg-snapshots";
import type {Env} from "./types";
import type {PublicFareCache} from "./public-fare-cache";
import {loadRenderedLhgAnchors} from "./brussels-rendered";
import {parseLufthansaAdvertisements} from "./lufthansa-advertisements";
export const LUFTHANSA_ATHENS_TEL_AVIV_PAGE="https://www.lufthansa.com/lhg/gr/en/o-d/cy-cy/athens-tel-aviv";
export async function collectRenderedLufthansa(deps:{env:Env;now:Date;cache?:PublicFareCache}) {
  if(deps.env.LUFTHANSA_RENDERED_ENABLED!=="true"||!deps.env.BROWSER)return {source:"lufthansa",ok:true,skipped:true,fares:0};
  try {
    const fares=await loadRenderedLufthansa(deps.env.BROWSER,deps.now);
    if(!fares.length)return {source:"lufthansa",ok:false,fares:0};
    if(!deps.cache)return {source:"lufthansa",ok:false,fares:fares.length,cacheUnavailable:true};
    await deps.cache.put(LUFTHANSA_ATHENS_TEL_AVIV_PAGE,fares);
    try {const snapshots=await saveLhgSnapshots(deps.env.DB,"lufthansa",fares,deps.now);return {source:"lufthansa",ok:true,fares:fares.length,snapshots};}
    catch {return {source:"lufthansa",ok:true,fares:fares.length,storageUnavailable:true};}
  } catch {return {source:"lufthansa",ok:false,fares:0};}
}
export async function loadRenderedLufthansa(browser:NonNullable<Env["BROWSER"]>,now:Date) {
  return parseLufthansaAdvertisements(await loadRenderedLhgAnchors(browser,LUFTHANSA_ATHENS_TEL_AVIV_PAGE),now);
}
