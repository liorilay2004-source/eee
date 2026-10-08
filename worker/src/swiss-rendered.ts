import { loadRenderedLhgAnchors } from "./brussels-rendered";
import { parseSwissAdvertisements } from "./swiss-advertisements";
import type { Env } from "./types";
import type { PublicFareCache } from "./public-fare-cache";
import { saveLhgSnapshots } from "./lhg-snapshots";

export const SWISS_TEL_AVIV_PAGE = "https://www.swiss.com/lhg/ch/en/o-d/cy-cy/zurich-tel-aviv";

/** Public dated advertisements, preserving their direction and original CHF. */
export async function loadRenderedSwiss(browser: NonNullable<Env["BROWSER"]>, now: Date) {
  return parseSwissAdvertisements(await loadRenderedLhgAnchors(browser, SWISS_TEL_AVIV_PAGE), now);
}

export async function collectRenderedSwiss(deps: { env: Env; now: Date; cache?: PublicFareCache }) {
  if (!deps.env.BROWSER) return {source:"swiss",ok:true,skipped:true,fares:0};
  try {
    const fares = await loadRenderedSwiss(deps.env.BROWSER,deps.now);
    if (!fares.length) return {source:"swiss",ok:false,fares:0};
    if (!deps.cache) return {source:"swiss",ok:false,fares:fares.length,cacheUnavailable:true};
    await deps.cache.put(SWISS_TEL_AVIV_PAGE,fares);
    try {
      const snapshots=await saveLhgSnapshots(deps.env.DB,"swiss",fares,deps.now);
      return {source:"swiss",ok:true,fares:fares.length,snapshots};
    } catch { return {source:"swiss",ok:true,fares:fares.length,storageUnavailable:true}; }
  } catch { return {source:"swiss",ok:false,fares:0}; }
}
