import { loadRenderedLhgAnchors } from "./brussels-rendered";
import { parseAustrianAdvertisements } from "./austrian-advertisements";
import type { Env } from "./types";
import type { PublicFareCache } from "./public-fare-cache";
import { saveLhgSnapshots } from "./lhg-snapshots";

export const AUSTRIAN_TEL_AVIV_PAGE = "https://www.austrian.com/lhg/at/en/o-d/cy-cy/vienna-tel-aviv";

/** Public dated advertisements, preserving their direction and original EUR. */
export async function loadRenderedAustrian(browser: NonNullable<Env["BROWSER"]>, now: Date) {
  return parseAustrianAdvertisements(await loadRenderedLhgAnchors(browser, AUSTRIAN_TEL_AVIV_PAGE), now);
}

export async function collectRenderedAustrian(deps: { env: Env; now: Date; cache?: PublicFareCache }) {
  if (!deps.env.BROWSER) return {source:"austrian",ok:true,skipped:true,fares:0};
  try {
    const fares = await loadRenderedAustrian(deps.env.BROWSER,deps.now);
    if (!fares.length) return {source:"austrian",ok:false,fares:0};
    if (!deps.cache) return {source:"austrian",ok:false,fares:fares.length,cacheUnavailable:true};
    await deps.cache.put(AUSTRIAN_TEL_AVIV_PAGE,fares);
    try {
      const snapshots=await saveLhgSnapshots(deps.env.DB,"austrian",fares,deps.now);
      return {source:"austrian",ok:true,fares:fares.length,snapshots};
    } catch { return {source:"austrian",ok:true,fares:fares.length,storageUnavailable:true}; }
  } catch { return {source:"austrian",ok:false,fares:0}; }
}
