import type { Env, Repo } from "./types";
import type { PublicFareCache } from "./public-fare-cache";
import { parsePublishedFares } from "./sources/published-fares";
import { matchPublishedTrip } from "./sources/published-source";
export const KLM_PAGE = "https://www.klm.co.il/en-il/flights-from-tel-aviv";
/** Fixed official page, background only, one bounded render per hourly job. */
export async function collectRenderedKlm(deps: { env: Env; repo: Pick<Repo,"savePrices">; now: Date; cache?: PublicFareCache }) {
  const empty = { source: "klm", ok: true, fares: 0, saved: 0 };
  if (deps.env.KLM_RENDERED_ENABLED !== "true" || !deps.env.BROWSER) return { ...empty, skipped: true };
  try {
    const response = await deps.env.BROWSER.quickAction("content", { url: KLM_PAGE, gotoOptions: { waitUntil: "networkidle2", timeout: 10000 }, rejectResourceTypes: ["image","font","media"] });
    if (!response.ok) throw new Error("Rendering failed");
    const envelopeText = await response.text();
    if (envelopeText.length > 4_000_000) throw new Error("Rendering payload too large");
    const envelope = JSON.parse(envelopeText) as { success?: unknown; result?: unknown };
    if (envelope.success !== true || typeof envelope.result !== "string") throw new Error("Invalid rendering response");
    const fares = parsePublishedFares(envelope.result, { airline:"KL",origin:"TLV",destination:"AMS",allDestinations:true,sourceUrl:KLM_PAGE,now:deps.now });
    await deps.cache?.put(KLM_PAGE, fares);
    const offers = fares.filter(f => f.structure === "roundtrip" && f.returnDate).flatMap(f => matchPublishedTrip([f], { origin:f.origin,destination:f.destination,departDate:f.departDate,returnDate:f.returnDate!,party:{adults:1,children:0,infants:0} }, {airline:"KL",source:"klm"}));
    if (offers.length) await deps.repo.savePrices(offers, {skipUnchangedSince:new Date(deps.now.getTime()-3_600_000).toISOString()});
    return { ...empty, fares:fares.length, saved:offers.length };
  } catch { return { ...empty, ok:false }; }
}

